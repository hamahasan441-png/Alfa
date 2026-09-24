#!/usr/bin/env node
/**
 * forge v150 — an MCP back-channel that survives its server.
 *
 * v143 opened the Streamable HTTP GET stream and declared roots and sampling
 * on the strength of it. When the stream ended — a server restart, a proxy
 * idle timeout — forge noticed and did nothing: the session kept a
 * declaration it could no longer honour. And after a restart the server has
 * forgotten the session, so every later request came back 404 and forge
 * failed them all until it was itself restarted.
 *
 * Every rule tested here is quoted from the MCP spec (2025-11-25, Streamable
 * HTTP), read while building this:
 *   - "The server MAY close the SSE stream at any time."
 *   - resume with GET + "Last-Event-ID" carrying the last event id received;
 *   - "The client MUST respect the `retry` field, waiting the given number of
 *     milliseconds before attempting to reconnect."
 *   - 405 = "the server does not offer an SSE stream at this endpoint";
 *   - a 404 to a request carrying a session id: the client "MUST start a new
 *     session by sending a new InitializeRequest without a session ID".
 */
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
const M = await import("../mcp.js")
const { REOPEN_BASE_MS, REOPEN_MAX_MS, REOPEN_MAX_ATTEMPTS, REOPEN_RETRY_CAP_MS } = M

/** A legacy Streamable HTTP MCP server whose behaviour each test scripts. */
async function stubServer() {
  const s = {
    gets: [], posts: [], streams: [],
    getMode: "stream",        // "stream" | 405 | 404 | 500
    forget: false,            // answer an unknown/old session id with 404
    sessions: new Set(), nextSession: 1,
  }
  s.server = http.createServer((req, res) => {
    const sid = req.headers["mcp-session-id"] ?? null
    if (req.method === "GET") {
      s.gets.push({ at: Date.now(), lastEventId: req.headers["last-event-id"] ?? null, session: sid })
      if (s.getMode !== "stream") { res.writeHead(Number(s.getMode)); return res.end() }
      if (s.forget && sid && !s.sessions.has(sid)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.flushHeaders()
      s.streams.push(res)
      return
    }
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let msg = null
      try { msg = JSON.parse(body) } catch { /* recorded as null */ }
      s.posts.push({ msg, session: sid })
      if (msg?.method === "server/discover") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }))
      }
      if (msg?.method === "initialize") {
        const id = `sess-${s.nextSession++}`
        s.sessions.add(id)
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": id })
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }))
      }
      if (s.forget && sid && !s.sessions.has(sid)) { res.writeHead(404); return res.end() }
      if (msg?.id === undefined) { res.writeHead(202); return res.end() }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `ok ${msg.method}` }] } }))
    })
  })
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r))
  s.url = `http://127.0.0.1:${s.server.address().port}/mcp`
  s.last = () => s.streams[s.streams.length - 1]
  s.send = (text) => s.last()?.write(text)
  s.drop = () => { const r = s.streams.pop(); try { r?.end() } catch {} }
  s.restart = () => { s.sessions.clear(); s.forget = true; for (const r of s.streams.splice(0)) try { r.end() } catch {} }
  s.stop = async () => {
    for (const r of s.streams.splice(0)) try { r.end() } catch {}
    try { s.server.closeAllConnections?.() } catch {}
    await new Promise((r) => s.server.close(r))
  }
  return s
}

let run = 0
async function connect(s, { fast = true } = {}) {
  const events = []
  M.clearEraCache?.()
  const client = await M.connectServer(`reconnect-${run++}`, { url: s.url, allowPrivate: true }, { timeoutMs: 4000, onEvent: (e) => events.push(e) })
  if (fast) { client.reopenBaseMs = 40; client.reopenMaxMs = 200 }
  return { client, events, states: () => events.filter((e) => e.type === "mcp_back_channel").map((e) => e.state) }
}

console.log("== the bounds are stated ==")
{
  ok("base, cap and attempts are exported constants", REOPEN_BASE_MS > 0 && REOPEN_MAX_MS >= REOPEN_BASE_MS && REOPEN_MAX_ATTEMPTS >= 3)
  // Worst case before LOST: the sum of the backoff schedule. About a minute —
  // long enough for a server restart, short enough not to retry forever.
  let total = 0
  for (let i = 0; i < REOPEN_MAX_ATTEMPTS; i++) total += Math.min(REOPEN_MAX_MS, REOPEN_BASE_MS * 2 ** i)
  ok(`a server gone for good is given up on in about a minute (${Math.round(total / 1000)}s)`, total >= 20000 && total <= 120000, String(total))
  ok("a server's retry: is clamped", REOPEN_RETRY_CAP_MS > 0 && REOPEN_RETRY_CAP_MS <= 120000)
}

console.log("== the server drops the stream: forge comes back ==")
{
  const s = await stubServer()
  const { client, states } = await connect(s)
  try {
    eq("one GET at connect", s.gets.length, 1)
    eq("the channel is open", client.backChannel, "open")
    s.drop()
    ok("a second GET arrives", await until(() => s.gets.length === 2), String(s.gets.length))
    ok("…and the channel is open again", await until(() => client.backChannel === "open"))
    eq("dropped, then reopened — said, not silent", states(), ["dropped", "reopened"])
    // And it keeps working: a request sent over the re-opened stream is answered.
    s.send(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "roots/list", params: {} })}\n\n`)
    ok("a server request on the re-opened stream is answered", await until(() => s.posts.some((p) => p.msg?.id === 77 && p.msg?.result)), JSON.stringify(s.posts.slice(-2)))
    // Twice, not once.
    s.drop()
    ok("a second drop is survived too", await until(() => s.gets.length === 3 && client.backChannel === "open"))
  } finally { client.close(); await s.stop() }
}

console.log("== resumed, not restarted: Last-Event-ID ==")
{
  const s = await stubServer()
  const { client } = await connect(s)
  try {
    eq("the first GET carries no cursor", s.gets[0].lastEventId, null)
    // The spec's priming event: an id and an EMPTY data field. It counts.
    s.send("id: prime-1\ndata:\n\n")
    s.send(`id: ev-7\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } })}\n\n`)
    await until(() => client._lastEventId === "ev-7")
    s.drop()
    await until(() => s.gets.length === 2)
    eq("the re-open sends the last id received", s.gets[1]?.lastEventId, "ev-7")
    s.send("id: only-id\n\n")
    await until(() => client._lastEventId === "only-id")
    eq("an id-only event moves the cursor", client._lastEventId, "only-id")
    s.send("id: bad\u0000id\ndata: {}\n\n")
    await sleep(50)
    eq("an id containing NUL is ignored (SSE standard)", client._lastEventId, "only-id")
  } finally { client.close(); await s.stop() }
}

console.log("== the server's retry: is respected ==")
{
  const s = await stubServer()
  const { client } = await connect(s)
  try {
    s.send("retry: 600\n\n")
    await until(() => client._retryMs === 600)
    eq("retry: read", client._retryMs, 600)
    const dropped = Date.now()
    s.drop()
    await until(() => s.gets.length === 2, 4000)
    const waited = s.gets[1]?.at - dropped
    ok(`the re-open waited at least retry: (${waited}ms ≥ 600)`, waited >= 580, String(waited))
    s.send("retry: 99999999\n\n")
    await until(() => client._retryMs !== 600)
    eq("a hostile retry: is clamped", client._retryMs, REOPEN_RETRY_CAP_MS)
    s.send("retry: soon\n\n")
    await sleep(50)
    eq("a non-numeric retry: is ignored", client._retryMs, REOPEN_RETRY_CAP_MS)
  } finally { client.close(); await s.stop() }
}

console.log("== 405: the server no longer offers a stream ==")
{
  const s = await stubServer()
  const { client, states, events } = await connect(s)
  try {
    s.getMode = 405
    s.drop()
    ok("LOST", await until(() => client.backChannel === "lost"), client.backChannel)
    await sleep(400)
    // Exactly ONE re-open attempt: a 405 is the server's answer, not a fault.
    // (Checking only that the count stopped growing passed even with the 405
    // rule removed — the fast test backoff ran out all attempts first.)
    eq("one re-open attempt, then stop", s.gets.length, 2)
    eq("dropped, then lost", states(), ["dropped", "lost"])
    ok("…and the reason names the 405", /405/.test(events.find((e) => e.state === "lost")?.why ?? ""))
  } finally { client.close(); await s.stop() }
}

console.log("== a server that never comes back is given up on ==")
{
  const s = await stubServer()
  const { client, events } = await connect(s)
  client.reopenAttempts = 4
  client.reopenMaxMs = 5000 // no cap inside 4 attempts: the waits are 40, 80, 160, 320
  try {
    s.getMode = 500
    s.drop()
    ok("LOST after the attempts run out", await until(() => client.backChannel === "lost", 5000), client.backChannel)
    eq("exactly the bounded number of attempts", s.gets.length - 1, 4)
    const lost = events.find((e) => e.state === "lost")
    ok("the event says why", /4 attempts to re-open failed/.test(lost?.why ?? ""), lost?.why)
    const gaps = s.gets.slice(1).map((g, i, a) => (i ? g.at - a[i - 1].at : null)).filter((x) => x != null)
    // Gaps between attempts are 80, 160, 320ms plus request time: the last is
    // about 4× the first. A constant wait gives ~1×. (`last > first` alone let
    // a no-backoff mutant through on timing noise.)
    ok(`the waits double (backoff: ${gaps.join(", ")}ms)`, gaps.length === 3 && gaps[2] >= 2.5 * gaps[0], gaps.join(","))
  } finally { client.close(); await s.stop() }
}

console.log("== the server restarted: a new session, as the spec requires ==")
{
  const s = await stubServer()
  const { client, states } = await connect(s)
  try {
    const firstSession = client._sessionId
    eq("a session was assigned", firstSession, "sess-1")
    s.restart() // forgets every session and hangs up every stream
    ok("a new session is established", await until(() => client._sessionId === "sess-2" && client.backChannel === "open", 4000), `${client._sessionId} ${client.backChannel}`)
    const inits = s.posts.filter((p) => p.msg?.method === "initialize")
    eq("two initializes in all", inits.length, 2)
    eq("the second carries NO session id", inits[1]?.session, null)
    ok("…and declares again what the channel allows", Boolean(inits[1]?.msg?.params?.capabilities?.roots))
    ok("expired → renewed, said", states().includes("session_expired") && states().includes("session_renewed"), states().join(","))
    let r = null, err = null
    try { r = await client.callTool("anything", {}) } catch (e) { err = e.message }
    ok("and calls work on the new session", JSON.stringify(r).includes("ok tools/call"), err ?? JSON.stringify(r))
  } finally { client.close(); await s.stop() }
}

console.log("== a 404 on an ordinary call renews and retries ONCE ==")
{
  const s = await stubServer()
  const { client } = await connect(s)
  try {
    // The restart is noticed by a call, not by the stream: forget sessions
    // without hanging up the stream.
    s.sessions.clear(); s.forget = true
    // Caught, not thrown: an unguarded call that failed here crashed the
    // suite with no FAIL line, which a mutation run first counted as a miss.
    let r = null, err = null
    try { r = await client.callTool("anything", {}) } catch (e) { err = e.message }
    ok("the call succeeds after one renewal", JSON.stringify(r).includes("ok tools/call"), err ?? JSON.stringify(r))
    const inits = s.posts.filter((p) => p.msg?.method === "initialize")
    eq("exactly one renewal", inits.length, 2)
    const calls = s.posts.filter((p) => p.msg?.method === "tools/call")
    eq("the call was sent twice: once refused, once answered", calls.map((c) => c.session), ["sess-1", "sess-2"])

    // A server that 404s EVERY session is answering, not glitching: once.
    const s2 = await stubServer()
    const c2 = await connect(s2)
    try {
      s2.server.removeAllListeners("request")
      s2.server.on("request", (req, res) => {
        let b = ""; req.on("data", (x) => { b += x })
        req.on("end", () => {
          let m = null; try { m = JSON.parse(b) } catch {}
          s2.posts.push({ msg: m, session: req.headers["mcp-session-id"] ?? null })
          if (req.method === "POST" && m?.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-x" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } } })) }
          if (req.method === "POST" && m?.id === undefined) { res.writeHead(202); return res.end() }
          res.writeHead(404); res.end()
        })
      })
      let err = null
      try { await c2.client.callTool("anything", {}) } catch (e) { err = e.message }
      ok("a second 404 is an error, not a loop", /404/.test(err ?? ""), err)
      eq("…after exactly one renewal", s2.posts.filter((p) => p.msg?.method === "initialize").length, 2)
    } finally { c2.client.close(); await s2.stop() }
  } finally { client.close(); await s.stop() }
}

console.log("== concurrent 404s share one renewal ==")
{
  const s = await stubServer()
  const { client } = await connect(s)
  try {
    s.sessions.clear(); s.forget = true
    const rs = await Promise.all(["a", "b", "c"].map((n) => client.callTool(n, {}).catch((e) => ({ err: e.message }))))
    ok("all three calls succeed", rs.every((r) => JSON.stringify(r).includes("ok tools/call")), JSON.stringify(rs))
    eq("one renewal, not three", s.posts.filter((p) => p.msg?.method === "initialize").length, 2)
  } finally { client.close(); await s.stop() }
}

console.log("== what must NOT re-open ==")
{
  const s = await stubServer()
  const { client, states } = await connect(s)
  try {
    client.closeStream()
    await sleep(300)
    eq("a deliberate closeStream() is not a drop", s.gets.length, 1)
    eq("…and says nothing", states(), [])
  } finally { client.close(); await s.stop() }

  const s2 = await stubServer()
  const c2 = await connect(s2)
  try {
    s2.getMode = 500 // keep it in "reconnecting"
    s2.drop()
    await until(() => c2.client.backChannel === "reconnecting")
    c2.client.close()
    const n = s2.gets.length
    await sleep(500)
    eq("close() during a re-open stops it", s2.gets.length, n)
  } finally { await s2.stop() }

  const s2b = await stubServer()
  const c2b = await connect(s2b)
  try {
    // closeStream() WITHOUT close(): the client stays usable, so `_closed`
    // does not stop the loop — only the abort does.
    s2b.getMode = 500
    s2b.drop()
    await until(() => c2b.client.backChannel === "reconnecting")
    c2b.client.closeStream()
    const n = s2b.gets.length
    await sleep(600)
    eq("a deliberate closeStream() during a re-open stops it too", s2b.gets.length, n)
    eq("…and the channel reads none, not reconnecting", c2b.client.backChannel, "none")
  } finally { c2b.client.close(); await s2b.stop() }

  const s3 = await stubServer()
  const c3 = await connect(s3)
  try {
    // A frame past the cap: closed deliberately, reported, never re-opened —
    // a server that sends it once would send it again.
    s3.send("data: " + "x".repeat(1024 * 1024 + 10))
    ok("an oversized frame is LOST", await until(() => c3.client.backChannel === "lost"), c3.client.backChannel)
    await sleep(300)
    eq("…and not re-opened", s3.gets.length, 1)
  } finally { c3.client.close(); await s3.stop() }

  const s4 = await stubServer()
  const c4 = await connect(s4)
  try {
    const oldGen = c4.client._streamGen
    s4.drop()
    await until(() => s4.gets.length === 2 && c4.client.backChannel === "open")
    c4.client._onStreamChunk(null, oldGen) // an end-of-stream from the stream that was replaced
    await sleep(200)
    eq("a stale end from a replaced stream is ignored", [c4.client.backChannel, s4.gets.length], ["open", 2])
  } finally { c4.client.close(); await s4.stop() }
}

console.log("== a background re-open never holds the process open ==")
{
  // A child connects, the server drops the stream and refuses every re-open,
  // and the child's script simply ends without closing. With the re-open
  // wait unref'd it exits; with a ref'd timer it would sit through the whole
  // backoff schedule (about a minute).
  const s = await stubServer()
  try {
    const code = `
      const M = await import(${JSON.stringify(path.join(HERE, "..", "mcp.js"))})
      const c = await M.connectServer("child", { url: ${JSON.stringify(s.url)}, allowPrivate: true }, { timeoutMs: 2000 })
      process.stdout.write("connected\\n")
    `
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (c) => { out += c })
    await until(() => out.includes("connected"), 8000)
    s.getMode = 500
    const t0 = Date.now()
    s.drop()
    const exited = await new Promise((r) => { const t = setTimeout(() => r(false), 10000); child.once("exit", () => { clearTimeout(t); r(true) }) })
    if (!exited) child.kill("SIGKILL")
    ok(`the process exits on its own (${Date.now() - t0}ms), not after the backoff schedule`, exited && Date.now() - t0 < 8000)
  } finally { await s.stop() }
}

console.log(`\n== mcp-reconnect suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
