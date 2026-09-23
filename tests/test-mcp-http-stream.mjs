#!/usr/bin/env node
/**
 * forge v143 — a HOSTED legacy MCP server can ask forge for things.
 *
 * v131 shipped the dual-era split and left one honest hole, recorded in
 * TODO.md ever since:
 *
 *   "HTTP legacy still declares `capabilities: {}`, deliberately: a legacy
 *    server may answer a declaration with a server-initiated JSON-RPC
 *    request, and plain Streamable HTTP POSTs give forge no channel to reply
 *    on. Opening the SSE GET stream would close this."
 *
 * The reason it stayed open was one layer down. `pinnedFetch` buffers the
 * whole response and resolves on `end`, which is exactly right for a JSON-RPC
 * POST and useless for a channel that is supposed to stay open. So v143 is
 * two things: a streaming mode for the PINNED request path, and the MCP
 * back-channel built on it.
 *
 * What this suite has to establish, in order:
 *
 *   1. streaming did not cost a pin — same resolution, same private-address
 *      rule, same post-connect peer assertion, same redirect handling;
 *   2. the channel carries real server-initiated requests, and forge ANSWERS
 *      them over a POST;
 *   3. the declaration FOLLOWS the channel — a server whose GET is refused
 *      still gets `capabilities: {}`, because declaring what forge cannot
 *      honour is the mistake v131 avoided;
 *   4. the buffer is bounded, because netguard's no longer is.
 *
 * Every case runs against a real HTTP server on 127.0.0.1 over a real socket.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-http-"))
process.env.FORGE_HOME = DIR
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const A = await import("../ask.js")
const net = await import("../netguard.js")
const mcp = await import("../mcp.js")
const { connectServer, clearEraCache, MCP_ERA, serveServerRequest } = mcp

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15) }
  return false
}

/**
 * A legacy Streamable-HTTP MCP server.
 *
 * `opts.backChannel` decides what the GET does: "sse" opens one, "refuse"
 * answers 405 (the spec's own "no back-channel here"), "wrong-type" answers
 * 200 with the wrong content-type. `opts.serverRequests` are pushed down the
 * channel once it is open. Everything received is recorded.
 */
async function server(opts = {}) {
  const { backChannel = "sse", serverRequests = [], frame = null } = opts
  const received = []
  let sse = null
  const srv = http.createServer((req, res) => {
    if (req.method === "GET") {
      received.push({ method: "GET", accept: req.headers.accept ?? "" })
      if (backChannel === "refuse") { res.writeHead(405).end(); return }
      if (backChannel === "wrong-type") { res.writeHead(200, { "content-type": "text/plain" }).end("not a stream"); return }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "mcp-session-id": "sess-1" })
      // A real SSE server flushes its head immediately — the client is waiting
      // on exactly that to know whether it has a channel. Without this the
      // stub looks like a server that accepted the GET and then went quiet.
      res.flushHeaders()
      sse = res
      // A frame the client must refuse to buffer: opened and never terminated.
      if (frame === "unterminated") { res.write("data: " + "x".repeat(2 * 1024 * 1024)) ; return }
      for (const m of serverRequests) res.write(`data: ${JSON.stringify(m)}\n\n`)
      return
    }
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let msg = null
      try { msg = JSON.parse(body) } catch { /* recorded as unparseable below */ }
      received.push({ method: "POST", msg })
      res.writeHead(200, { "content-type": "application/json" })
      if (msg?.method === "initialize") {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hosted", version: "1" } } }))
      }
      if (msg?.method === "server/discover") {
        // legacy: an unknown pre-initialize method is an error, and the era
        // probe MUST fall back on it rather than on a specific code.
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }))
      }
      if (msg?.method === "tools/list") {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } }))
      }
      if (msg?.id !== undefined && msg?.method === undefined) return res.end("") // a RESPONSE from forge
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg?.id ?? null, result: { content: [{ type: "text", text: "ok" }] } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    push: (m) => { try { sse?.write(`data: ${JSON.stringify(m)}\n\n`) } catch {} },
    posts: () => received.filter((r) => r.method === "POST").map((r) => r.msg),
    gets: () => received.filter((r) => r.method === "GET"),
    close: () => { try { sse?.end() } catch {} ; srv.close(); try { srv.closeAllConnections?.() } catch {} },
  }
}

let n = 0
const connect = (s, extra = {}) => {
  clearEraCache()
  // allowPrivate is a SPEC field (it describes the server), not a connect
  // option — 127.0.0.1 is exactly the case it exists for.
  return connectServer(`hosted${n++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 3000, ...extra })
}

console.log("== the pinned request path can stream, and is still pinned ==")
{
  const seen = []
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    res.write("data: {\"n\":1}\n\n")
    setTimeout(() => res.write("data: {\"n\":2}\n\n"), 20)
    setTimeout(() => res.end(), 60)
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv.address().port}/s`
  const sockets = []
  const r = await net.pinnedFetch(url, { allowPrivate: true, onChunk: (c) => seen.push(c === null ? null : c.toString()), onSocket: (x) => sockets.push(x) })
  eq("it resolves as soon as the headers are in", r.status, 200)
  eq("…with no body, because nothing was accumulated", r.body, null)
  ok("the post-connect peer assertion still ran and passed", sockets.length > 0 && sockets.every((x) => x.ok), JSON.stringify(sockets))
  await until(() => seen.includes(null))
  eq("both frames arrived, then the end marker", seen, ["data: {\"n\":1}\n\n", "data: {\"n\":2}\n\n", null])
  ok("it hands back a close()", typeof r.close === "function")

  // The pin itself: a private address is still refused without allowPrivate.
  //
  // Two things this probe has to get right or it proves nothing. The server
  // stays UP — against a closed port the request fails with ECONNREFUSED and
  // the assertion passes for the wrong reason. And the rule is only armed
  // when security is on, which the suite runner turns OFF by default, so this
  // one probe restores it rather than asserting into a disabled guard.
  const savedMode = process.env.FORGE_SECURITY_MODE
  delete process.env.FORGE_SECURITY_MODE
  let blocked = null
  try { await net.pinnedFetch(url, { onChunk: () => {} }) } catch (e) { blocked = e }
  if (savedMode !== undefined) process.env.FORGE_SECURITY_MODE = savedMode
  ok("streaming does NOT bypass the private-address rule", !!blocked, String(blocked?.message ?? "it was allowed through"))
  ok("…and it is refused as BLOCKED, not as a transport error",
    blocked?.blocked === true, `${blocked?.code ?? "?"}: ${blocked?.message ?? "no error"}`)
  srv.close()
}

console.log("== a hosted legacy server gets a back-channel ==")
{
  const s = await server()
  const c = await connect(s)
  eq("it is the legacy era", c.era, MCP_ERA.LEGACY)
  const gets = s.gets()
  eq("forge opened exactly one GET", gets.length, 1)
  ok("…asking for an event stream", /text\/event-stream/.test(gets[0].accept), gets[0].accept)
  const init = s.posts().find((m) => m?.method === "initialize")
  ok("initialize was sent after the channel was open", !!init)
  ok("…and now declares roots, instead of {}", !!init?.params?.capabilities?.roots, JSON.stringify(init?.params?.capabilities))
  c.close()
  s.close()
}

console.log("== a server that refuses the GET still gets an honest {} ==")
{
  const s = await server({ backChannel: "refuse" })
  const c = await connect(s)
  const init = s.posts().find((m) => m?.method === "initialize")
  eq("405 means no channel, so nothing is declared", init?.params?.capabilities, {})
  ok("…and the connection still works", !!c)
  c.close()
  s.close()
}

console.log("== …as does one that answers the GET with the wrong thing ==")
{
  const s = await server({ backChannel: "wrong-type" })
  const c = await connect(s)
  const init = s.posts().find((m) => m?.method === "initialize")
  eq("a 200 that is not an event stream is not a channel", init?.params?.capabilities, {})
  c.close()
  s.close()
}

console.log("== the server asks, and forge answers over a POST ==")
{
  const s = await server()
  const c = await connect(s)
  s.push({ jsonrpc: "2.0", id: 77, method: "roots/list", params: {} })
  const answered = await until(() => s.posts().some((m) => m?.id === 77 && m?.method === undefined))
  ok("forge replied", answered, JSON.stringify(s.posts()))
  const reply = s.posts().find((m) => m?.id === 77 && m?.method === undefined)
  eq("…on the same JSON-RPC id", reply?.id, 77)
  ok("…with a real ListRootsResult", Array.isArray(reply?.result?.roots) && reply.result.roots.length > 0, JSON.stringify(reply))
  ok("…every root a file:// uri", reply.result.roots.every((r) => String(r.uri).startsWith("file://")))
  c.close()
  s.close()
}

console.log("== ping, and a capability forge never declared ==")
{
  const s = await server()
  const c = await connect(s)
  s.push({ jsonrpc: "2.0", id: 1, method: "ping" })
  s.push({ jsonrpc: "2.0", id: 2, method: "sampling/createMessage", params: { messages: [] } })
  s.push({ jsonrpc: "2.0", id: 3, method: "no/such/method" })
  await until(() => s.posts().filter((m) => m?.method === undefined && m?.id !== undefined).length >= 3)
  const reply = (id) => s.posts().find((m) => m?.id === id && m?.method === undefined)
  eq("ping is answered", reply(1)?.result, {})
  ok("sampling is REFUSED while it is off, not quietly paid for", !!reply(2)?.error, JSON.stringify(reply(2)))
  ok("…and the refusal says how to turn it on", /sampling is off/.test(String(reply(2)?.error?.message)), reply(2)?.error?.message)
  eq("an unknown method is -32601, not silence", reply(3)?.error?.code, -32601)
  c.close()
  s.close()
}

console.log("== a notification reaches the run ==")
{
  const s = await server()
  const events = []
  const c = await connect(s, { onEvent: (e) => events.push(e) })
  s.push({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } })
  s.push({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1, total: 2 } })
  await until(() => events.length >= 2)
  ok("a log notification surfaces", events.some((e) => e.type === "mcp_log"), JSON.stringify(events))
  ok("a progress notification surfaces", events.some((e) => e.type === "mcp_progress"), JSON.stringify(events))
  ok("…each naming the server it came from", events.every((e) => e.server?.startsWith("hosted")))
  c.close()
  s.close()
}

console.log("== the buffer is bounded, because netguard's is not ==")
{
  // netguard streams without accumulating, deliberately. That makes an SSE
  // event that is opened and never terminated the one unbounded shape left,
  // and it has to be the CLIENT that refuses it.
  const s = await server({ frame: "unterminated" })
  const c = await connect(s)
  await sleep(300)
  ok("a 2MB frame with no terminator closes the channel", c._stream === null, `stream=${c._stream ? "open" : "closed"}`)
  ok("…and the client is still usable", typeof c.callTool === "function")
  c.close()
  s.close()
}

console.log("== close() does not leak the held-open socket ==")
{
  const s = await server()
  const c = await connect(s)
  ok("the channel is open while connected", c._stream !== null)
  c.close()
  eq("close() tears it down", c._stream, null)
  c.close()
  ok("…and is idempotent", c._stream === null)
  s.close()
}

console.log("== one dispatcher, both transports ==")
{
  // v142 taught MRTR about elicitation and left the legacy dispatcher behind;
  // that is the drift a shared function exists to prevent. Both transports now
  // call serveServerRequest, so this is the whole legacy answer set.
  eq("ping", (await serveServerRequest({ method: "ping", id: 1 }, {})).result, {})
  ok("roots", Array.isArray((await serveServerRequest({ method: "roots/list", id: 1 }, { cwd: DIR })).result?.roots))
  ok("sampling refuses while off", !!(await serveServerRequest({ method: "sampling/createMessage", id: 1 }, { name: "s" })).error)
  const noHuman = await serveServerRequest({ method: "elicitation/create", id: 1, params: { message: "hi" } }, { name: "s" })
  eq("elicitation is -32601 with nobody to ask", noHuman.error?.code, -32601)
  A.setAsker(async () => "n")
  const withHuman = await serveServerRequest({ method: "elicitation/create", id: 1, params: { message: "hi" } }, { name: "s" })
  eq("…and a real ElicitResult with a human present", withHuman.result?.action, "decline")
  A.clearAsker()
  eq("an unknown method", (await serveServerRequest({ method: "nope", id: 1 }, {})).error?.code, -32601)
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  eq("there is ONE dispatcher, not one per transport", (src.match(/export async function serveServerRequest/g) || []).length, 1)
  ok("the stdio client calls it", /_reply\(msg\.id, await serveServerRequest\(msg, this\)\)/.test(src))
  ok("the http client calls it", /serveServerRequest\(msg, this\)\s*\n\s*\.then\(\(body\) => this\._replyOverHttp/.test(src))
}

console.log("== the constraints this change had to respect ==")
{
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("HTTP still goes through netguard, never a raw fetch", /pinnedFetch\(this\.url/.test(src))
  ok("…and there is still no raw global fetch in the module", !/[^.\w]fetch\(/.test(src.replace(/pinnedFetch\(/g, "PF(")))
  ok("the back-channel is a GET on the same pinned url", /method: "GET"/.test(src))
  const ngsrc = fs.readFileSync(new URL("../netguard.js", import.meta.url), "utf8")
  ok("streaming reuses requestPinned rather than opening a second path",
    (ngsrc.match(/mod\.request\(reqOpts\)/g) || []).length === 1, "more than one request path in netguard")
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== mcp-http-stream suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
