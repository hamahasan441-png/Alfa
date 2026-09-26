#!/usr/bin/env node
/**
 * forge v154 — `forge agent --mcp-config FILE`: one run's MCP servers.
 *
 * Harbor tasks can name MCP servers (task.toml `mcp_servers`), and Harbor's
 * BaseAgent says to "register the MCP servers in self.mcp_servers with the
 * agent". forge read MCP servers only from its privileged config, so a run
 * could not be given its servers without editing the user's configuration,
 * and the Terminal-Bench adapter dropped them.
 *
 * What must hold:
 *   - the file's servers reach the model, and a tool on them can be CALLED;
 *   - the user's saved config is never written;
 *   - a bad file stops the run (exit 2, recorded); a bad entry is skipped, said;
 *   - what the Python adapter writes is what forge reads.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const { parseRunMcpConfig: parse, withRunMcpServers } = await import("../mcp.js")
const cfg = (servers) => JSON.stringify({ mcpServers: servers })
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }

console.log("== the file ==")
{
  const r = parse(cfg({
    files: { command: "npx", args: ["-y", "srv"], env: { A: "1" } },
    api: { type: "http", url: "http://mcp-server:8000/mcp", headers: { "X-K": "v" } },
    api2: { type: "streamable-http", url: "https://x.example/mcp" },
    bare: { url: "http://127.0.0.1:9/mcp" },
    typed: { type: "stdio", command: "node" },
  }), {})
  eq("stdio: command, args, env", r.servers.files, { command: "npx", args: ["-y", "srv"], env: { A: "1" } })
  eq("http: url, headers, and the operator-named address is allowed (first hop)", r.servers.api, { url: "http://mcp-server:8000/mcp", headers: { "X-K": "v" }, allowPrivate: true })
  eq("streamable-http is http", r.servers.api2.url, "https://x.example/mcp")
  eq("no type + url is http", r.servers.bare.url, "http://127.0.0.1:9/mcp")
  eq("stdio with no args", r.servers.typed, { command: "node", args: [], env: {} })
  eq("nothing skipped", r.skipped, [])
  const h = parse(cfg({ t: { transport: "streamable-http", url: "http://h/mcp" } }), {})
  ok("Harbor's own key name (transport) is read too", h.servers.t?.url === "http://h/mcp")
}

console.log("== what is skipped, and said ==")
{
  const r = parse(cfg({
    old: { type: "sse", url: "http://s/sse" },
    weird: { type: "websocket", url: "ws://x" },
    nocmd: { type: "stdio" },
    badargs: { command: "x", args: "not-a-list" },
    nourl: { type: "http" },
    ftp: { type: "http", url: "ftp://x/y" },
    notobj: "npx srv",
    "a__b": { command: "x" },
    "a.b": { command: "x" },
    ["x".repeat(65)]: { command: "x" },
    good: { command: "x" },
  }), {})
  // v162: "sse" (the 2024-11-05 transport) loads — the HTTP client speaks it
  eq("only the good ones load (sse included since v162)", Object.keys(r.servers).sort(), ["good", "old"])
  eq("…sse is an http url like the rest", r.servers.old, { url: "http://s/sse", headers: {}, allowPrivate: true })
  const why = Object.fromEntries(r.skipped.map((s) => [s.name.slice(0, 8), s.reason]))
  ok("an unknown transport is named", /unknown transport "websocket"/.test(why.weird), why.weird)
  ok("stdio needs a command", /needs a command/.test(why.nocmd), why.nocmd)
  ok("args must be a list", /args must be an array/.test(why.badargs), why.badargs)
  ok("http needs a url", /needs a url/.test(why.nourl), why.nourl)
  ok("only http(s) urls", /must be http/.test(why.ftp), why.ftp)
  ok("an entry must be an object", /not an object/.test(why.notobj), why.notobj)
  ok("a name with __ is refused — it would break mcp__server__tool parsing", /single _/.test(why.a__b), why.a__b)
  ok("…and a dot", "a.b" in why)
  ok("…and a 65-character name", "xxxxxxxx" in why)
  eq("every rejected entry is reported", r.skipped.length, 9)
}

console.log("== ${VAR} from the environment ==")
{
  const env = { TOKEN: "s3cret", DIR: "/data" }
  const r = parse(cfg({
    s: { command: "${DIR}/bin/srv", args: ["--root=${DIR}", "${MISSING:-fallback}"], env: { T: "${TOKEN}", E: "${UNSET:-}" } },
    h: { type: "http", url: "https://api.example/${UNSET:-v1}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    gone: { command: "srv", env: { K: "${NOT_SET}" } },
  }), env)
  eq("command and args expand", [r.servers.s.command, ...r.servers.s.args], ["/data/bin/srv", "--root=/data", "fallback"])
  eq("env expands, :- gives a default (empty allowed)", r.servers.s.env, { T: "s3cret", E: "" })
  eq("url and headers expand", [r.servers.h.url, r.servers.h.headers.Authorization], ["https://api.example/v1/mcp", "Bearer s3cret"])
  ok("a variable with no value and no default skips that server, naming it", r.skipped.length === 1 && r.skipped[0].name === "gone" && /NOT_SET/.test(r.skipped[0].reason), JSON.stringify(r.skipped))
  eq("an empty variable counts as unset", parse(cfg({ e: { command: "${E}" } }), { E: "" }).skipped[0]?.name, "e")
  eq("not a variable: left alone", parse(cfg({ l: { command: "echo", args: ["$HOME", "${lower-case}", "{x}"] } }), {}).servers.l.args, ["$HOME", "${lower-case}", "{x}"])
}

console.log("== a bad file is an error, not a guess ==")
{
  ok("invalid JSON", /not valid JSON/.test(throws(() => parse("{nope")) ?? ""))
  for (const [text, what] of [["[]", "an array"], ["{}", "no mcpServers"], ['{"mcpServers":[]}', "mcpServers an array"], ['{"servers":{}}', "VS Code's key"], ["null", "null"]]) {
    ok(`${what}: refused with the expected shape`, /expected \{ "mcpServers"/.test(throws(() => parse(text)) ?? ""), text)
  }
  eq("an empty mcpServers is fine — no servers", parse('{"mcpServers":{}}'), { servers: {}, skipped: [] })
}

console.log("== merged for the run only ==")
{
  const user = { mcp: { lazy: true, servers: { mine: { command: "a" }, same: { command: "old" } } }, other: { k: 1 } }
  const snapshot = JSON.stringify(user)
  const run = withRunMcpServers(user, { same: { command: "new" }, extra: { command: "b" } })
  eq("the run sees the user's servers and the file's", Object.keys(run.mcp.servers).sort(), ["extra", "mine", "same"])
  eq("the file wins a name clash — it is the more specific instruction", run.mcp.servers.same.command, "new")
  eq("other mcp settings kept", run.mcp.lazy, true)
  ok("the user's config object is untouched", JSON.stringify(user) === snapshot)
  ok("…and shares no changed level with the run's", run !== user && run.mcp !== user.mcp && run.mcp.servers !== user.mcp.servers)
  ok("no servers: the same config back", withRunMcpServers(user, {}) === user)
  eq("a config with no mcp section", Object.keys(withRunMcpServers({}, { x: { command: "c" } }).mcp.servers), ["x"])
}

// A legacy stdio MCP server with one tool, `echo`.
const MCP_STUB = `
let buf = ""
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "task", version: "1" } } })
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ECHO:" + m.params.arguments.text }] } })
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
  }
})
`

/** A headless run against an Anthropic stub that calls mcp__taskmcp__echo once. */
async function run({ mcpFile, userConfig = null, extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-runmcp-t-"))
  const seen = { requests: [], toolResults: [] }
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      seen.requests.push((j.tools ?? []).map((t) => t.name))
      for (const m of j.messages ?? []) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "tool_result") seen.toolResults.push(b)
      const first = seen.requests.length === 1 && seen.requests[0].includes("mcp__taskmcp__echo")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
        ...(first
          ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "mcp__taskmcp__echo", input: { text: "hello" } }] }
          : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const home = path.join(dir, "home")
  fs.mkdirSync(path.join(home, ".forge"), { recursive: true })
  fs.mkdirSync(path.join(dir, "work"))
  fs.writeFileSync(path.join(dir, "stub.mjs"), MCP_STUB)
  const cfgPath = path.join(home, ".forge", "config.json")
  if (userConfig) fs.writeFileSync(cfgPath, JSON.stringify(userConfig, null, 2) + "\n")
  const before = userConfig ? fs.readFileSync(cfgPath, "utf8") : null
  let file = null
  if (typeof mcpFile === "function") { file = path.join(dir, "mcp.json"); fs.writeFileSync(file, mcpFile(dir)) }
  else if (typeof mcpFile === "string") file = mcpFile
  const resultPath = path.join(dir, "r.json")
  const args = [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
    "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "4", "--result-json", resultPath,
    ...(file ? ["--mcp-config", file] : []), ...extraArgs, "--", "use the echo tool"]
  let out = ""
  const child = spawn(process.execPath, args, {
    cwd: path.join(dir, "work"), env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 30000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  let result = null
  try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")) } catch { /* none */ }
  const after = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, out, seen, result, before, after }
}

const stubEntry = (dir) => ({ command: process.execPath, args: [path.join(dir, "stub.mjs")] })

console.log("== end to end: the task's server is offered and CALLED ==")
{
  // The user already has a server of the same name that cannot start: the
  // run's file must win, and the user's file must be byte-identical after.
  const userConfig = { mcp: { servers: { taskmcp: { command: "/nonexistent/user-server" }, keep: { command: "/nonexistent/keep", disabled: true } } } }
  const r = await run({ mcpFile: (dir) => cfg({ taskmcp: stubEntry(dir) }), userConfig })
  eq("the run completes", r.code, 0)
  ok("mcp__taskmcp__echo offered to the model", r.seen.requests[0]?.includes("mcp__taskmcp__echo"), JSON.stringify(r.seen.requests[0]))
  const tr = r.seen.toolResults[0]
  const text = typeof tr?.content === "string" ? tr.content : (tr?.content ?? []).map((c) => c.text).join("")
  ok("…and the call reached the server and came back", /ECHO:hello/.test(text), JSON.stringify(tr))
  eq("the result counts the tool call", r.result?.toolCalls, 1)
  ok("the user's config file is byte-identical afterwards", r.before === r.after, r.after)
}

console.log("== a run without the flag is unchanged ==")
{
  const r = await run({})
  eq("completes", r.code, 0)
  ok("no MCP tools offered", !(r.seen.requests[0] ?? []).some((n) => n.startsWith("mcp__")))
  ok("no config file created", r.after === null)
}

console.log("== a bad file stops the run, recorded ==")
{
  const missing = await run({ mcpFile: "/nonexistent/mcp.json" })
  eq("missing: exit 2", missing.code, 2)
  eq("…before the model is called", missing.seen.requests.length, 0)
  eq("…recorded as an ERROR", missing.result?.status, "ERROR")
  ok("…saying which file and why", /--mcp-config \/nonexistent\/mcp\.json: no such file/.test(missing.result?.error ?? ""), missing.result?.error)
  const bad = await run({ mcpFile: () => "{not json" })
  eq("invalid JSON: exit 2", bad.code, 2)
  ok("…with the parse error", /not valid JSON/.test(bad.result?.error ?? ""), bad.result?.error)
  const noValue = await run({ extraArgs: ["--mcp-config"] })
  eq("--mcp-config with no file: exit 2", noValue.code, 2)
  ok("…said", /--mcp-config: needs a file/.test(noValue.result?.error ?? ""), noValue.result?.error)
}

console.log("== a bad entry is skipped, said, and the rest still works ==")
{
  const r = await run({ mcpFile: (dir) => cfg({ taskmcp: stubEntry(dir), odd: { type: "websocket", url: "ws://127.0.0.1:9/" } }) })
  eq("completes", r.code, 0)
  // v200: the warning names the file the entry came from
  ok("the websocket server is reported as skipped", /server "odd" (\(mcp\.json\) )?skipped — unknown transport "websocket"/.test(r.out), r.out.slice(0, 600))
  ok("the stdio one is still offered", r.seen.requests[0]?.includes("mcp__taskmcp__echo"))
}

console.log("== what the Python adapter writes, forge reads ==")
{
  let py = null
  try {
    py = execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "integrations", "harbor"))})
from forge_harbor.core import mcp_config
print(json.dumps(mcp_config([
  {"name": "files", "transport": "stdio", "command": "npx", "args": ["-y", "srv"]},
  {"name": "api", "transport": "streamable-http", "url": "http://mcp-server:8000/mcp"},
  {"name": "old", "transport": "sse", "url": "http://mcp-server:8000/sse"},
])))`], { encoding: "utf8" })
  } catch (e) { py = null; ok("python3 ran the adapter's mapping", false, e.message) }
  if (py) {
    const r = parse(py, {})
    eq("stdio, streamable-http and (since v162) sse all load", Object.keys(r.servers), ["files", "api", "old"])
    eq("…as forge specs", [r.servers.files.command, r.servers.api.url, r.servers.old.url], ["npx", "http://mcp-server:8000/mcp", "http://mcp-server:8000/sse"])
    eq("nothing skipped", r.skipped, [])
  }
}

console.log(`\n== run-mcp-config suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
