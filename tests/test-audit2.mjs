#!/usr/bin/env node
// v172 — audit round 2: MCP servers under failure (sub-agents and state growth
// were probed too; see the CHANGELOG for what held up).
//
//   1. A server's tool with a name providers reject ("bad name with spaces",
//      or a server + tool name past 64 characters) was offered as is, and the
//      provider refused the WHOLE request: one badly named tool on one MCP
//      server ended every run with a 400.
//   2. A server that died at start said why on stderr ("missing API key");
//      forge reported only "exited (code 1)".
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit2-"))
process.env.FORGE_HOME = HOME
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const M = await import("../mcp.js")
const A = await import("../agent.js")
const P = await import("../providers.js")

const SERVER = path.join(HOME, "server.mjs")
fs.writeFileSync(SERVER, `import readline from "node:readline"
const mode = process.argv[2]
if (mode === "crash") { console.error("starting up"); console.error("fatal: GITHUB_TOKEN is missing (token was ghp_abcdefghijklmnopqrstuvwxyz0123456789)"); process.exit(1) }
const calls = []
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "p" } } })
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "ok_tool", description: "fine", inputSchema: { type: "object", properties: {} } },
    { name: "bad name with spaces", description: "spaces", inputSchema: { type: "object", properties: {} } },
    { name: "search_repositories_with_every_filter_github_supports_today", description: "long", inputSchema: { type: "object", properties: {} } },
    { name: "bad:name", description: "colon", inputSchema: { type: "object", properties: {} } },
    { name: "bad/name", description: "slash", inputSchema: { type: "object", properties: {} } },
  ] } })
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "CALLED:" + m.params.name }] } })
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })
})
`)

console.log("== 1. every MCP tool name is one providers accept ==")
{
  ok("a valid name is unchanged", M.mcpToolName("github", "create_issue") === "mcp__github__create_issue")
  const bad = M.mcpToolName("p", "bad name with spaces")
  ok("an invalid name is made valid", M.PROVIDER_TOOL_NAME.test(bad) && bad.startsWith("mcp__p__bad_name_with_spaces_"), bad)
  const long = M.mcpToolName("github-enterprise-server", "search_repositories_with_every_filter_github_supports_today")
  ok("a name past 64 characters is shortened", M.PROVIDER_TOOL_NAME.test(long) && long.length <= 64, `${long} (${long.length})`)
  ok("two names that clean the same stay distinct", M.mcpToolName("p", "bad:name") !== M.mcpToolName("p", "bad/name"))
  ok("…and parse back to their server", M.parseMcpToolName(bad)?.server === "p")

  const r = await M.loadMcpTools({ mcp: { servers: { p: { command: process.execPath, args: [SERVER, "ok"] } } } }, { timeoutMs: 5000 })
  ok("every tool a server lists is offered under a valid name", r.tools.length === 5 && r.tools.every((t) => M.PROVIDER_TOOL_NAME.test(t.def.function.name)), JSON.stringify(r.tools.map((t) => t.name)))
  const spaced = r.tools.find((t) => t.name.startsWith("mcp__p__bad_name_with_spaces"))
  ok("…and a renamed tool still calls the server by its own name", /CALLED:bad name with spaces/.test(String(await spaced.run({}, {}))))
  for (const c of r.clients ?? []) { try { await c.close() } catch { /* test teardown */ } }

  // the reported failure: a real run with a provider that validates names like OpenAI does
  let bad400 = 0
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c }); req.on("end", () => {
    const names = (JSON.parse(b).tools ?? []).map((t) => t.function?.name)
    if (names.some((n) => !/^[a-zA-Z0-9_-]{1,64}$/.test(n))) { bad400++; res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid 'tools[].function.name'" } })) }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }))
  }) })
  await new Promise((q) => srv.listen(0, "127.0.0.1", q))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit2-run-"))
  const prev = process.cwd(); process.chdir(work)
  const cfg = { providers: { s: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } }, agent: { maxSteps: 3 }, skills: { enabled: false }, mcp: { servers: { p: { command: process.execPath, args: [SERVER, "ok"] } } } }
  let run = null, err = null
  try { run = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "s"), task: "use the bad name tool and the search repositories tool on the p server", onEvent: () => {} }) } catch (e) { err = e }
  process.chdir(prev); srv.closeAllConnections?.(); srv.close()
  fs.rmSync(work, { recursive: true, force: true })
  ok("a run with such a server completes (it ended with a provider 400)", !err && run?.status === "COMPLETED" && bad400 === 0, err?.message ?? `${run?.status}, ${bad400} rejected requests`)
}

console.log("== 2. a server that dies at start says why ==")
{
  const r = await M.loadMcpTools({ mcp: { servers: { gh: { command: process.execPath, args: [SERVER, "crash"] } } } }, { timeoutMs: 5000 })
  const e = r.errors.join(" ")
  ok("its last stderr line is in the error", /the server said: "fatal: GITHUB_TOKEN is missing/.test(e), e)
  // FORGE_SECURITY_MODE=off turns secret redaction off everywhere, by design
  const { securityEnabled } = await import("../security-mode.js")
  if (securityEnabled()) ok("…with secrets redacted", !/ghp_abcdefghijklmnopqrstuvwxyz0123456789/.test(e), e)
  else ok("…passed through redact() (security mode is off here, so it is shown as is)", /GITHUB_TOKEN is missing/.test(e))
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== audit2 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
