#!/usr/bin/env node
/**
 * forge v152 — closing an HTTP MCP client ends its session on the server.
 *
 * The spec (2025-11-25, Streamable HTTP, Session Management): "Clients that
 * no longer need a particular session (e.g., because the user is leaving the
 * client application) SHOULD send an HTTP DELETE to the MCP endpoint with the
 * MCP-Session-Id header, to explicitly terminate the session. The server MAY
 * respond to this request with HTTP 405 Method Not Allowed, indicating that
 * the server does not allow clients to terminate sessions."
 *
 * Until v152 close() only marked the client closed: every server forge talked
 * to kept the session, and whatever it held for it, until its own timeout.
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20) } return pred() }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const M = await import("../mcp.js")

/** A legacy Streamable HTTP server. deleteMode: 200 | 405 | "hang" | "slow"; session: whether it assigns one. */
async function server({ deleteMode = 200, session = true, stream = true } = {}) {
  const s = { deletes: [], gets: 0, posts: [], sessions: 0, held: [] }
  s.srv = http.createServer((req, res) => {
    if (req.method === "DELETE") {
      s.deletes.push(req.headers["mcp-session-id"] ?? null)
      if (deleteMode === "hang") { s.held.push(res); return }
      if (deleteMode === "slow") { setTimeout(() => { res.writeHead(200); res.end() }, 400); return }
      res.writeHead(deleteMode); return res.end()
    }
    if (req.method === "GET") {
      s.gets++
      if (!stream) { res.writeHead(405); return res.end() }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); s.held.push(res); return
    }
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let msg = null
      try { msg = JSON.parse(body) } catch { /* null */ }
      s.posts.push({ method: msg?.method, session: req.headers["mcp-session-id"] ?? null })
      if (msg?.method === "server/discover") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }))
      }
      if (msg?.method === "initialize") {
        const h = { "content-type": "application/json" }
        if (session) h["mcp-session-id"] = `sess-${++s.sessions}`
        res.writeHead(200, h)
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } }))
      }
      if (msg?.id === undefined) { res.writeHead(202); return res.end() }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }))
    })
  })
  await new Promise((r) => s.srv.listen(0, "127.0.0.1", r))
  s.url = `http://127.0.0.1:${s.srv.address().port}/mcp`
  s.stop = async () => {
    for (const r of s.held.splice(0)) try { r.end() } catch {}
    try { s.srv.closeAllConnections?.() } catch {}
    await new Promise((r) => s.srv.close(r))
  }
  return s
}
let n = 0
const connect = (s) => { M.clearEraCache?.(); return M.connectServer(`end-${n++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 4000 }) }

console.log("== close() ends the session ==")
{
  const s = await server()
  const c = await connect(s)
  eq("a session was assigned", c._sessionId, "sess-1")
  const p = c.close()
  ok("close() returns something a caller can wait on", p && typeof p.then === "function")
  await p
  eq("exactly one DELETE, carrying the session id", s.deletes, ["sess-1"])
  let err = null
  try { await c.listTools() } catch (e) { err = e.message }
  ok("the client is closed afterwards", /closed/.test(err ?? ""), err)
  await c.close()
  eq("a second close() sends nothing more", s.deletes, ["sess-1"])
  await sleep(200)
  eq("and the stream is not re-opened after the server ends it", s.gets, 1)
  await s.stop()
}

console.log("== a second close() waits for the same DELETE ==")
{
  // Two owners can close one client (a run ending, then its caller). The
  // second must wait for the DELETE still in flight — not return at once and
  // let the process exit before it lands. (A mutation run showed the id being
  // cleared on the first call hides this from a count of DELETEs.)
  const s = await server({ deleteMode: "slow" })
  const c = await connect(s)
  const first = c.close()
  const t0 = Date.now()
  const second = c.close()
  await second
  const took = Date.now() - t0
  ok(`the second close() resolved only when the DELETE did (${took}ms ≥ 300)`, took >= 300, String(took))
  ok("…being the same promise", first === second)
  eq("…and one DELETE in all", s.deletes, ["sess-1"])
  await s.stop()
}

console.log("== nothing to end, nothing sent ==")
{
  const s = await server({ session: false })
  const c = await connect(s)
  eq("no session id was assigned", c._sessionId ?? null, null)
  await c.close()
  eq("no DELETE", s.deletes, [])
  await s.stop()
}

console.log("== the server may refuse (405), or never answer ==")
{
  const s = await server({ deleteMode: 405 })
  const c = await connect(s)
  let threw = false
  try { await c.close() } catch { threw = true }
  ok("a 405 — 'this server does not let clients end sessions' — is not an error", !threw && s.deletes.length === 1)
  await s.stop()

  const h = await server({ deleteMode: "hang" })
  const c2 = await connect(h)
  const t0 = Date.now()
  threw = false
  try { await c2.close() } catch { threw = true }
  const took = Date.now() - t0
  ok("a DELETE that times out is not an error", !threw)
  ok(`a server that never answers cannot hold close() open (${took}ms ≤ ${M.SESSION_DELETE_TIMEOUT_MS + 1000})`, took <= M.SESSION_DELETE_TIMEOUT_MS + 1000 && h.deletes.length === 1, String(took))
  await h.stop()

  const gone = await server()
  const c3 = await connect(gone)
  await gone.stop()
  threw = false
  try { await c3.close() } catch { threw = true }
  ok("a server that is already gone is not an error either", !threw)
}

console.log("== after a renewal, the NEW session is the one ended ==")
{
  // v150 renews a session the server forgot (404). The old one no longer
  // exists; ending it would be a request about nothing.
  const s = await server()
  const c = await connect(s)
  await c._renewSession("test")
  eq("renewed", c._sessionId, "sess-2")
  await c.close()
  eq("the DELETE names the current session only", s.deletes, ["sess-2"])
  await s.stop()
}

console.log("== a process that closes and exits still sends it ==")
{
  // No await on close(): the pending request keeps the event loop alive, so a
  // CLI command that closes its clients and returns still delivers the DELETE.
  const s = await server()
  const code = `
    const M = await import(${JSON.stringify(path.join(ROOT, "mcp.js"))})
    const c = await M.connectServer("child", { url: ${JSON.stringify(s.url)}, allowPrivate: true }, { timeoutMs: 3000 })
    c.close()
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" })
  const exited = await new Promise((r) => { const t = setTimeout(() => r(false), 8000); child.once("exit", () => { clearTimeout(t); r(true) }) })
  ok("the child exits on its own", exited)
  ok("…and the server heard the DELETE first", await until(() => s.deletes.length === 1, 1000), JSON.stringify(s.deletes))
  await s.stop()
}

console.log("== the callers wait for it ==")
{
  const agent = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("an agent run awaits its MCP clients' close()", /await Promise\.allSettled\(mcpClients\.map\(/.test(agent))
  const forge = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
  ok("`forge mcp tools` awaits them too", /finally \{ await Promise\.allSettled\(res\.clients\.map\(/.test(forge))
  const mcp = fs.readFileSync(path.join(ROOT, "mcp.js"), "utf8")
  ok("a lazily-connected server's close() passes the promise on", /return Promise\.resolve\(p\)\.then\(\(c\) => c\.close\(\)\)/.test(mcp))
  // stdio has no sessions: its close() is unchanged.
  ok("stdio close() sends nothing over the network", !/class McpClient[\s\S]*?close\(\) \{[\s\S]{0,400}?DELETE/.test(mcp.slice(0, mcp.indexOf("class McpHttpClient"))))
}

console.log(`\n== mcp-session-end suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
