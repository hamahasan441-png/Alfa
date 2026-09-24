#!/usr/bin/env node
/**
 * forge v162 — the 2024-11-05 HTTP+SSE transport.
 *
 * The spec (2025-11-25, Transports, Backwards Compatibility): a client that
 * supports older servers POSTs an InitializeRequest; if that fails with 400,
 * 404 or 405 it issues a GET to the URL, "expecting that this will open an SSE
 * stream and return an endpoint event as the first event", and then uses
 * that transport: messages are POSTed to the endpoint and every answer comes
 * back on the stream. It is what Harbor gives a task's MCP server when only a
 * url is named (MCPServerConfig.transport defaults to "sse"). forge POSTed,
 * got 405, and stopped.
 */
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
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20) } return pred() }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const M = await import("../mcp.js")

/**
 * A legacy HTTP+SSE MCP server. Options:
 *   postStatus   what a POST to /sse gets (405 by default; 500 = not legacy)
 *   endpoint     what the `endpoint` event names ("rel" | "abs" | "foreign" | "none")
 *   answerOnPost answer in the POST body (200) instead of on the stream
 *   silent       never answer tools/call
 *   askRoots     after initialized, ask the client roots/list on the stream
 *   progress     send a progress notification before answering tools/call
 *   endAfterList end the stream right after answering tools/list (once)
 */
async function legacy(opts = {}) {
  const s = { gets: 0, posts: [], deletes: 0, replies: [], cancels: [], closedStreams: 0, sessions: 0, streams: new Set() }
  let current = null
  let ended = false
  const send = (o) => { try { current?.write(`event: message\ndata: ${JSON.stringify(o)}\n\n`) } catch { /* gone */ } }
  s.srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    if (req.method === "DELETE") { s.deletes++; res.writeHead(405); return res.end() }
    if (u.pathname === "/sse" && req.method === "GET") {
      s.gets++
      const sid = `S${++s.sessions}`
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const ep = opts.endpoint ?? "rel"
      if (ep === "rel") res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`)
      else if (ep === "abs") res.write(`event: endpoint\ndata: http://127.0.0.1:${s.port}/messages?sessionId=${sid}\n\n`)
      else if (ep === "foreign") res.write(`event: endpoint\ndata: http://evil.example/messages?sessionId=${sid}\n\n`)
      current = res
      s.session = sid
      s.streams.add(res)
      req.on("close", () => { s.closedStreams++; s.streams.delete(res) })
      return
    }
    if (u.pathname === "/sse" && req.method === "POST") { req.resume(); res.writeHead(opts.postStatus ?? 405); return res.end() }
    if (u.pathname !== "/messages" || req.method !== "POST") { res.writeHead(404); return res.end() }
    if (u.searchParams.get("sessionId") !== s.session) { res.writeHead(404); return res.end("unknown session") }
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let m = null
      try { m = JSON.parse(body) } catch { /* ignored */ }
      if (m && m.method === undefined && m.id !== undefined) { s.replies.push(m); res.writeHead(202); return res.end() }
      s.posts.push({ method: m?.method, id: m?.id })
      if (m?.method === "notifications/cancelled") s.cancels.push(m.params)
      const answer = (o) => {
        if (opts.answerOnPost) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)) }
        else { res.writeHead(202); res.end(); send(o) }
      }
      if (m?.id === undefined) {
        res.writeHead(202); res.end()
        if (m?.method === "notifications/initialized" && opts.askRoots) send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list", params: {} })
        return
      }
      if (m.method === "initialize") s.initCaps = m.params?.capabilities ?? null
      if (m.method === "initialize") return answer({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } })
      if (m.method === "tools/list") {
        answer({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } })
        if (opts.endAfterList && !ended) { ended = true; setTimeout(() => current?.end(), 20) }
        return
      }
      if (m.method === "tools/call") {
        if (opts.silent) { res.writeHead(202); return res.end() }
        if (opts.progress) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p", progress: 1, total: 2 } })
        return answer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ECHO:${m.params?.arguments?.text}` }] } })
      }
      if (m.method === "ping") return answer({ jsonrpc: "2.0", id: m.id, result: {} })
      answer({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
    })
  })
  await new Promise((r) => s.srv.listen(0, "127.0.0.1", r))
  s.port = s.srv.address().port
  s.url = `http://127.0.0.1:${s.port}/sse`
  s.endStream = () => current?.end()
  s.stop = async () => { for (const r of s.streams) try { r.end() } catch {} ; try { s.srv.closeAllConnections?.() } catch {} ; await new Promise((r) => s.srv.close(r)) }
  return s
}
let n = 0
const connect = (s, extra = {}) => { M.clearEraCache?.(); return M.connectServer(`sse-${n++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 3000, ...extra }) }
const methods = (s) => s.posts.map((p) => p.method)

console.log("== the fallback the spec describes ==")
{
  const s = await legacy()
  const c = await connect(s)
  eq("switched to the SSE transport", c.transport, "sse")
  ok("the endpoint is the server's, on the same origin", c._sseEndpoint === `http://127.0.0.1:${s.port}/messages?sessionId=S1`, c._sseEndpoint)
  eq("one stream opened", s.gets, 1)
  eq("initialize and initialized went to the endpoint", methods(s), ["initialize", "notifications/initialized"])
  eq("the server's info was read", c.serverInfo?.name, "legacy")
  // the stream carries the server's own requests, so forge declares what it
  // can answer on it — not the `{}` of a transport with no channel
  ok("initialize declares forge's capabilities (the stream can carry the server's requests)",
    JSON.stringify(s.initCaps) === JSON.stringify(c.clientCaps) && Object.keys(s.initCaps ?? {}).length > 0, JSON.stringify(s.initCaps))
  const tools = await c.listTools()
  eq("tools/list answered on the stream", tools.map((t) => t.name), ["echo"])
  const r = await c.callTool("echo", { text: "hi" })
  eq("tools/call answered on the stream", r.text, "ECHO:hi")
  ok("ping works", await c.ping())
  await c.close()
  ok("close() ends the stream", await until(() => s.closedStreams === 1))
  eq("…and sends no DELETE (the session is the stream)", s.deletes, 0)
  let err = null
  try { await c.listTools() } catch (e) { err = e.message }
  ok("a closed client fails honestly", /closed/.test(err ?? ""), err)
  await s.stop()
}
for (const status of [400, 404]) {
  const s = await legacy({ postStatus: status })
  const c = await connect(s)
  eq(`HTTP ${status} on initialize also falls back`, c.transport, "sse")
  await c.close(); await s.stop()
}
{
  const s = await legacy({ postStatus: 500 })
  let err = null
  try { await connect(s) } catch (e) { err = e.message }
  ok("a 500 is a real failure, not a legacy server: no fallback", /MCP HTTP 500/.test(err ?? ""), err)
  await s.stop()
}
{
  const s = await legacy({ endpoint: "abs" })
  const c = await connect(s)
  eq("an absolute endpoint on the same origin is used", c.transport, "sse")
  await c.close(); await s.stop()
}

console.log("== what is refused, and said ==")
{
  const s = await legacy({ endpoint: "foreign" })
  let err = null
  const t0 = Date.now()
  try { await connect(s, { timeoutMs: 1500 }) } catch (e) { err = e.message }
  ok("an endpoint on another origin is not followed — the session's traffic stays with the server", /named no endpoint/.test(err ?? ""), err)
  ok(`…and the wait is bounded (${Date.now() - t0}ms)`, Date.now() - t0 < 4000)
  await s.stop()
}
{
  const s = await legacy({ endpoint: "none" })
  let err = null
  try { await connect(s, { timeoutMs: 1500 }) } catch (e) { err = e.message }
  ok("a stream with no endpoint: neither transport, and the error says both", /neither Streamable HTTP nor the 2024-11-05 HTTP\+SSE transport/.test(err ?? ""), err)
  await s.stop()
}

console.log("== answers on the POST, server requests, notifications ==")
{
  const s = await legacy({ answerOnPost: true })
  const c = await connect(s)
  eq("a server that answers on the POST body is accepted", (await c.callTool("echo", { text: "direct" })).text, "ECHO:direct")
  await c.close(); await s.stop()
}
{
  const s = await legacy({ askRoots: true })
  const c = await connect(s)
  ok("a server-initiated request on the stream is answered at the endpoint", await until(() => s.replies.length === 1), JSON.stringify(s.replies))
  eq("…with forge's roots", s.replies[0]?.id === "srv-1" && Array.isArray(s.replies[0]?.result?.roots), true)
  await c.close(); await s.stop()
}
{
  const s = await legacy({ progress: true })
  const events = []
  const c = await connect(s, { onEvent: (e) => events.push(e.type) })
  await c.callTool("echo", { text: "x" })
  ok("progress notifications reach the run", events.includes("mcp_progress"), JSON.stringify(events))
  await c.close(); await s.stop()
}

console.log("== bounded: timeouts, cancellation, a lost stream ==")
{
  const s = await legacy({ silent: true })
  const c = await connect(s, { timeoutMs: 800 })
  const t0 = Date.now()
  let err = null
  try { await c.callTool("echo", { text: "x" }) } catch (e) { err = e.message }
  ok(`an answer that never comes times out (${Date.now() - t0}ms)`, /did not answer "tools\/call" within 800ms/.test(err ?? "") && Date.now() - t0 < 2500, err)
  await c.close(); await s.stop()
}
{
  // The stream is the session: a quiet stretch longer than one request's
  // timeout must not end it (netguard's socket idle timeout is the request's).
  const s = await legacy()
  const c = await connect(s, { timeoutMs: 600 })
  await sleep(1200)
  eq("a session quiet for twice the request timeout is still the same session", [(await c.callTool("echo", { text: "later" })).text, s.gets], ["ECHO:later", 1])
  await c.close(); await s.stop()
}
{
  const s = await legacy({ silent: true })
  const c = await connect(s)
  const ctl = new AbortController()
  const call = c.callTool("echo", { text: "x" }, { signal: ctl.signal }).then(() => null, (e) => e.message)
  await sleep(100)
  ctl.abort()
  const err = await call
  ok("an aborted call rejects at once", /cancelled/.test(err ?? ""), err)
  ok("…and the server is told (notifications/cancelled)", await until(() => s.cancels.length === 1), JSON.stringify(s.cancels))
  await c.close(); await s.stop()
}
{
  const s = await legacy({ silent: true })
  const c = await connect(s)
  const call = c.callTool("echo", { text: "x" }).then(() => null, (e) => e.message)
  await sleep(100)
  await c.close()
  ok("close() rejects a call still waiting on the stream", /closed/.test((await call) ?? ""))
  await s.stop()
}
{
  const s = await legacy({ endAfterList: true })
  const c = await connect(s)
  await c.listTools()
  ok("the server ends the stream, and the client sees the session is gone", await until(() => s.closedStreams >= 1 && c._sseEndpoint === null))
  const r = await c.callTool("echo", { text: "again" })
  eq("the next call reconnects: a new stream, a new endpoint, a new session — and works", [r.text, s.gets, c._sseEndpoint?.endsWith("sessionId=S2")], ["ECHO:again", 2, true])
  ok("…re-initialized on the new session", methods(s).filter((x) => x === "initialize").length === 2, JSON.stringify(methods(s)))
  await c.close(); await s.stop()
}

{
  // A call in flight when the stream dies: its answer can never arrive. It
  // fails at once, saying why — and is NOT silently re-sent, because the old
  // session may already have run it (a tool call twice is worse than once).
  const s = await legacy({ silent: true })
  const c = await connect(s)
  const call = c.callTool("echo", { text: "x" }).then(() => null, (e) => e.message)
  await until(() => s.posts.some((p) => p.method === "tools/call"))
  const t0 = Date.now()
  s.endStream()
  const err = await call
  ok(`a call in flight when the stream ends fails at once, saying why (${Date.now() - t0}ms)`, /the server ended the SSE stream/.test(err ?? "") && Date.now() - t0 < 1500, err)
  eq("…and is not re-sent", s.posts.filter((p) => p.method === "tools/call").length, 1)
  await c.close(); await s.stop()
}

console.log("== --mcp-config: a task's `sse` server, end to end ==")
{
  const s = await legacy()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sse-e2e-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { tasksse: { type: "sse", url: s.url } } }))
  const seen = []
  const model = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      seen.push({ tools: (j.tools ?? []).map((t) => t.name), results: (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "tool_result") : []) })
      const first = seen.length === 1 && seen[0].tools.includes("mcp__tasksse__echo")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 1, output_tokens: 1 },
        ...(first ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "mcp__tasksse__echo", input: { text: "from-the-task" } }] } : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => model.listen(0, "127.0.0.1", r))
  const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
    "--base-url", `http://127.0.0.1:${model.address().port}`, "--mcp-config", path.join(dir, "mcp.json"), "--max-steps", "3", "--", "use the task's echo tool"],
    { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
  await new Promise((r) => { const t = setTimeout(() => { c.kill("SIGKILL"); r() }, 30000); c.once("exit", () => { clearTimeout(t); r() }) })
  await new Promise((r) => { model.closeAllConnections?.(); model.close(r) })
  ok("the sse server's tool is offered to the model", seen[0]?.tools.includes("mcp__tasksse__echo"), JSON.stringify(seen[0]?.tools))
  const tr = seen[1]?.results?.[0]
  const text = typeof tr?.content === "string" ? tr.content : (tr?.content ?? []).map((x) => x.text).join("")
  ok("…and the call reaches it and comes back", /ECHO:from-the-task/.test(text), JSON.stringify(tr))
  await s.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}

// The same idle-timeout fix, on the Streamable HTTP back-channel: a quiet
// server's GET stream used to be dropped and re-opened every request timeout.
{
  let gets = 0
  const srv = http.createServer((req, res) => {
    if (req.method === "GET") { gets++; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return }
    let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
      let msg = {}
      try { msg = JSON.parse(b) } catch { /* DELETE and friends carry no body */ }
      if (msg.method === "server/discover") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } })) }
      if (msg.id === undefined) { res.writeHead(202); return res.end() }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "quiet" } } : { tools: [] } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  M.clearEraCache?.()
  const drops = []
  const c = await M.connectServer("quiet-streamable", { url: `http://127.0.0.1:${srv.address().port}/mcp`, allowPrivate: true },
    { timeoutMs: 400, onEvent: (e) => e.type === "mcp_back_channel" && e.state === "dropped" && drops.push(e) })
  await new Promise((r) => setTimeout(r, 1500))
  ok("a quiet Streamable HTTP channel outlives the request timeout (no drop/re-open churn)", gets === 1 && drops.length === 0 && c.backChannel === "open", `gets=${gets} drops=${drops.length} channel=${c.backChannel}`)
  await c.close(); srv.closeAllConnections?.(); srv.close()
}

console.log(`\n== mcp-legacy-sse suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
