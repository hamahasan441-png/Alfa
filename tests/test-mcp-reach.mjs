#!/usr/bin/env node
// v200 — MCP reach.
//
// 1. `--mcp-config` takes several files (repeated, or several after one
//    flag), merged in order. It used to keep the last one and say nothing.
// 2. The result file lists the run's MCP servers — what each offered, or why
//    it offered nothing — and the --mcp-config entries skipped before it.
// 3. A tool call in flight when an SSE stream ends is asked again once when
//    its server declares it read-only or idempotent; anything else is not
//    repeated, and the error says it may or may not have run.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcpreach-"))
const M = await import("../mcp.js")
const A = await import("../agent.js")
const T = await import("../tbench.js")

// A legacy stdio MCP server; its one tool is named by argv[2].
const STDIO_STUB = `
const TOOL = process.argv[2] || "echo"
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
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: TOOL, version: "1" } } })
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: TOOL, description: "a tool", inputSchema: { type: "object", properties: {} } }] } })
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: TOOL.toUpperCase() + "-RAN" }] } })
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
  }
})
`

/** A headless run given `files` (array of [name, json]) and `args`; the model stub records the tools it is offered. */
async function run({ files = [], args = null, extra = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcpreach-run-"))
  const offered = []
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      offered.push((j.tools ?? []).map((t) => t.name))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const home = path.join(dir, "home")
  fs.mkdirSync(path.join(home, ".forge"), { recursive: true }); fs.mkdirSync(path.join(dir, "work"))
  fs.writeFileSync(path.join(dir, "stub.mjs"), STDIO_STUB)
  const paths = files.map(([name, json]) => { const p = path.join(dir, name); fs.writeFileSync(p, typeof json === "function" ? json(dir) : json); return p })
  const resultPath = path.join(dir, "r.json")
  const mcpArgs = args ? args(paths) : paths.flatMap((p) => ["--mcp-config", p])
  let out = ""
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
    "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "2", "--result-json", resultPath, ...mcpArgs, ...extra, "--", "use alpha_tool, beta_tool, old_tool and new_tool"], {
    cwd: path.join(dir, "work"), env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 45000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  let result = null
  try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")) } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, out, offered, result }
}
const server = (dir, tool) => ({ command: process.execPath, args: [path.join(dir, "stub.mjs"), tool] })
const cfg = (servers) => (dir) => JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, typeof v === "function" ? v(dir) : v])) })

console.log("== 1. several --mcp-config files ==")
{
  const files = [["a.json", cfg({ alpha: (d) => server(d, "alpha_tool") })], ["b.json", cfg({ beta: (d) => server(d, "beta_tool") })]]
  const r = await run({ files })
  const tools = r.offered[0] ?? []
  ok("--mcp-config twice: both files' servers reach the model", r.code === 0 && tools.includes("mcp__alpha__alpha_tool") && tools.includes("mcp__beta__beta_tool"), `${r.code} ${JSON.stringify(tools)} ${r.out.slice(-300)}`)
  const r2 = await run({ files, args: (p) => ["--mcp-config", ...p] })
  const tools2 = r2.offered[0] ?? []
  ok("--mcp-config a.json b.json: both too", r2.code === 0 && tools2.includes("mcp__alpha__alpha_tool") && tools2.includes("mcp__beta__beta_tool"), JSON.stringify(tools2))
  const r3 = await run({ files, args: (p) => [`--mcp-config=${p[0]}`, `--mcp-config=${p[1]}`] })
  ok("--mcp-config=… twice: both", (r3.offered[0] ?? []).filter((t) => /^mcp__(alpha|beta)__/.test(t)).length === 2, JSON.stringify(r3.offered[0]))
  const clash = await run({ files: [["a.json", cfg({ same: (d) => server(d, "old_tool") })], ["b.json", cfg({ same: (d) => server(d, "new_tool") })]] })
  const ct = clash.offered[0] ?? []
  ok("a name in both files: the later file wins…", ct.includes("mcp__same__new_tool") && !ct.includes("mcp__same__old_tool"), JSON.stringify(ct))
  ok("…and it is said", /--mcp-config: server "same" from b\.json replaces the one from a\.json/.test(clash.out), clash.out.slice(-400))
  const bad = await run({ files: [["a.json", cfg({ alpha: (d) => server(d, "alpha_tool") })], ["b.json", "{nope"]] })
  ok("a bad second file stops the run, naming it", bad.code === 2 && /--mcp-config .*b\.json: not valid JSON/.test(bad.out) && bad.result?.status === "ERROR" && /b\.json/.test(bad.result?.error ?? ""), `${bad.code} ${bad.out.slice(-300)}`)
  ok("the task after -- is still the task (not a config file)", r2.code === 0 && r2.offered.length >= 1)
}

console.log("== 2. the run's MCP servers in the result file ==")
{
  const r = await run({ files: [
    ["a.json", cfg({ alpha: (d) => server(d, "alpha_tool"), broken: { command: "/nonexistent/forge-mcp-server" } })],
    ["b.json", cfg({ beta: (d) => server(d, "beta_tool"), ws: { type: "websocket", url: "ws://x" } })],
  ] })
  const m = r.result?.mcp
  const by = Object.fromEntries((m?.servers ?? []).map((s) => [s.name, s]))
  ok("every server the run was given is listed", m && ["alpha", "beta", "broken"].every((n) => by[n]), JSON.stringify(m))
  ok("…with the tools each offered", by.alpha?.tools === 1 && by.beta?.tools === 1)
  ok("…and why a server offered nothing", by.broken?.tools === 0 && typeof by.broken?.error === "string" && by.broken.error.length > 0, JSON.stringify(by.broken))
  ok("the entry skipped before the run started, with its file", m?.skipped?.length === 1 && m.skipped[0].name === "ws" && m.skipped[0].file === "b.json" && /websocket/.test(m.skipped[0].reason), JSON.stringify(m?.skipped))
  const none = await run({})
  ok("a run with no MCP servers has no mcp key", none.result && !("mcp" in none.result), JSON.stringify(none.result)?.slice(0, 200))
  // the summary itself
  const sum = A.mcpServerSummary(["a", "b", "c"], { tools: [{ source: "mcp:a" }, { source: "mcp:a" }, { source: "mcp:b" }], errors: ["c: spawn ENOENT", "ab: other"] })
  ok("mcpServerSummary: tools per server, the error by its name prefix", JSON.stringify(sum) === JSON.stringify([{ name: "a", tools: 2 }, { name: "b", tools: 1 }, { name: "c", tools: 0, error: "spawn ENOENT" }]), JSON.stringify(sum))
}

console.log("== 3. forge tbench report shows them ==")
{
  const m = { servers: [{ name: "github", tools: 0, error: "no token" }, { name: "files", tools: 3 }], skipped: [{ name: "ws", reason: "unknown transport", file: "b.json" }] }
  const text = T.mcpTrialText(m)
  ok("a trial's MCP line: servers, the one that offered nothing and why, the skipped", text === "mcp: 2 servers (1 offered nothing: github — no token), 1 skipped (ws: unknown transport)", text)
  ok("…nothing to say: nothing", T.mcpTrialText(null) === "" && T.mcpTrialText({ servers: [], skipped: [] }) === "")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcpreach-trial-"))
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ task_name: "t1", trial_name: "t1__a", verifier_result: { rewards: { reward: 1 } }, agent_result: { metadata: { forge_status: "COMPLETED", forge_steps: 3, forge_mcp: m } } }))
  const tr = T.readTrial(dir)
  ok("readTrial keeps forge_mcp", JSON.stringify(tr?.forgeMcp) === JSON.stringify(m))
  const job = T.formatHarborJob({ job: "j", model: "m", dataset: "d", finished: true, isForge: true, summary: { tasks: 1, tasksSolved: 1, trials: 1, meanReward: 1, errors: 0, falseCompletions: 0, inputTokens: 0, cacheTokens: 0, outputTokens: 0, costUsd: null }, tasks: [{ attempts: 1 }], trials: [tr] })
  ok("…and the report prints it on the trial's line", /PASS {2}t1 .*• mcp: 2 servers/.test(job), job)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== 4. a call in flight when the SSE stream ends ==")
{
  // A legacy SSE server whose tools/call ends the stream instead of answering
  // (`drop` times), then answers on the next session.
  async function legacy({ drop = 1 } = {}) {
    const s = { calls: 0, sessions: 0, streams: new Set() }
    let current = null, session = null
    const send = (o) => { try { current?.write(`event: message\ndata: ${JSON.stringify(o)}\n\n`) } catch { /* gone */ } }
    s.srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x")
      if (req.method === "DELETE") { res.writeHead(405); return res.end() }
      if (u.pathname === "/sse" && req.method === "GET") {
        session = `S${++s.sessions}`
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.write(`event: endpoint\ndata: /messages?sessionId=${session}\n\n`)
        current = res; s.streams.add(res)
        req.on("close", () => s.streams.delete(res))
        return
      }
      if (u.pathname === "/sse" && req.method === "POST") { req.resume(); res.writeHead(405); return res.end() }
      if (u.pathname !== "/messages" || u.searchParams.get("sessionId") !== session) { res.writeHead(404); return res.end() }
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        const m = JSON.parse(body || "{}")
        res.writeHead(202); res.end()
        if (m.id === undefined) return
        if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } })
        if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
          { name: "look", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "setkey", inputSchema: { type: "object" }, annotations: { idempotentHint: true } },
          { name: "send", inputSchema: { type: "object" } },
        ] } })
        if (m.method === "tools/call") {
          s.calls++
          if (s.calls <= drop) { setTimeout(() => current?.end(), 30); return }
          return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${m.params.name.toUpperCase()}-DONE` }] } })
        }
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
      })
    })
    await new Promise((r) => s.srv.listen(0, "127.0.0.1", r))
    s.url = `http://127.0.0.1:${s.srv.address().port}/sse`
    s.stop = async () => { for (const r of s.streams) try { r.end() } catch {} ; s.srv.closeAllConnections?.(); await new Promise((r) => s.srv.close(r)) }
    return s
  }
  let n = 0
  const plugins = async (s) => {
    M.clearEraCache?.()
    const c = await M.connectServer(`sse-reach-${n++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 3000 })
    return { c, byName: Object.fromEntries(M.mcpToolsToPlugins(c, await c.listTools()).map((p) => [p.name.split("__").pop(), p])) }
  }
  for (const [tool, why] of [["look", "read-only"], ["setkey", "idempotent"]]) {
    const s = await legacy({ drop: 1 })
    const { c, byName } = await plugins(s)
    const out = await byName[tool].run({})
    ok(`a ${why} tool: asked again on a new session, and answered`, new RegExp(`${tool.toUpperCase()}-DONE$`).test(out) && s.calls === 2 && s.sessions === 2, `${out} calls=${s.calls} sessions=${s.sessions}`)
    ok(`…and the answer says it was asked again, and on whose word`, new RegExp(`ended mid-call; asked again — the server marks "${tool}" ${why}`).test(out), out)
    await c.close(); await s.stop()
  }
  {
    const s = await legacy({ drop: 1 })
    const { c, byName } = await plugins(s)
    const out = await byName.send.run({})
    ok("a tool with no such declaration is NOT asked again", s.calls === 1, `calls=${s.calls}`)
    ok("…and the error says it may or may not have run, and to check first", /^ERROR: the SSE stream to ".*" ended while "send" was running — it may or may not have completed\. Not repeated/.test(out) && /check its effect before calling it again/.test(out), out)
    const next = await byName.send.run({})
    ok("the next call reconnects and works (unchanged)", next === "SEND-DONE" && s.sessions === 2, next)
    await c.close(); await s.stop()
  }
  {
    const s = await legacy({ drop: 5 })
    const { c, byName } = await plugins(s)
    const out = await byName.look.run({})
    ok("the stream ends again during the second ask: an error, and no third try", /^ERROR: .*ended the SSE stream/.test(out) && s.calls === 2, `${out} calls=${s.calls}`)
    await c.close(); await s.stop()
  }
  {
    const s = await legacy({ drop: 1 })
    M.clearEraCache?.()
    const c = await M.connectServer(`sse-reach-${n++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 3000 })
    await c.listTools()
    let err = null
    try { await c.callTool("look", {}) } catch (e) { err = e }
    ok("the client itself still never re-sends (v162), and marks the loss", err?.streamLost === true && s.calls === 1, `${err?.message} calls=${s.calls}`)
    await c.close(); await s.stop()
  }
  ok("idempotentHinted: only an explicit true", M.idempotentHinted({ annotations: { idempotentHint: true } }) === true && M.idempotentHinted({ annotations: { idempotentHint: "yes" } }) === false && M.idempotentHinted({}) === false)
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== mcp-reach suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
