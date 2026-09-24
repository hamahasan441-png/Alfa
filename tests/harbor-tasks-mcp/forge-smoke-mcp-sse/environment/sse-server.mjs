// A task's MCP server on the HTTP+SSE transport of MCP 2024-11-05: GET /sse
// opens the stream, whose first event names the endpoint to POST to; every
// answer comes back on the stream. POST /sse is refused (405), as a server
// that predates Streamable HTTP would. Its one tool returns a secret the agent
// cannot know any other way — the verifier checks for it.
import http from "node:http"
const SECRET = "sidecar-says-5829"
const sessions = new Map()
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x")
  if (u.pathname === "/sse" && req.method === "GET") {
    const id = Math.random().toString(36).slice(2)
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
    sessions.set(id, res)
    req.on("close", () => sessions.delete(id))
    return
  }
  const stream = sessions.get(u.searchParams.get("sessionId"))
  if (u.pathname !== "/messages" || req.method !== "POST" || !stream) { res.writeHead(u.pathname === "/sse" ? 405 : 404); return res.end() }
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    res.writeHead(202); res.end()
    let m
    try { m = JSON.parse(body) } catch { return }
    if (m.id === undefined) return
    const send = (o) => stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o })}\n\n`)
    if (m.method === "initialize") send({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sidecar", version: "1" } } })
    else if (m.method === "tools/list") send({ result: { tools: [{ name: "secret", description: "the task's secret", inputSchema: { type: "object", properties: {} } }] } })
    else if (m.method === "tools/call") send({ result: { content: [{ type: "text", text: SECRET }] } })
    else send({ error: { code: -32601, message: "method not found" } })
  })
}).listen(8000, "0.0.0.0")
