#!/usr/bin/env node
/**
 * forge v149 — a scripted model for testing the Terminal-Bench path.
 *
 * Speaks the Anthropic Messages wire (streaming and not). It does not think:
 * it reads a `STUB_RUN: <shell command>` line out of the task, asks forge to
 * run it with the bash tool, and ends the turn once the tool result comes
 * back (or, v154, a `STUB_TOOL: <name> <json>` line naming any tool). That is enough to exercise everything between a harness and a model —
 * headless startup, provider resolution from the environment, the tool loop,
 * the exit code, the result file — without a real model or a real key.
 *
 *   node tests/tbench-stub-model.mjs [port] [host]
 *
 * Environment:
 *   STUB_KEY      the only x-api-key accepted (default "stub-key"); others 401
 *   STUB_FAIL     an HTTP status to return for every request (e.g. 500)
 *   STUB_LOOP=1   never stop asking for tools (drives a run into its step cap)
 *   STUB_LOG      append one JSON line per request (for assertions)
 *
 * Prints "listening <port>" once ready, so a caller can wait on stdout.
 */
import http from "node:http"
import fs from "node:fs"

const port = Number(process.argv[2] ?? 0)
const host = process.argv[3] ?? "127.0.0.1"
const KEY = process.env.STUB_KEY ?? "stub-key"
const FAIL = Number(process.env.STUB_FAIL ?? 0)
const LOOP = process.env.STUB_LOOP === "1"
const LOG = process.env.STUB_LOG ?? null

const USAGE = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 }

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((b) => (b?.type === "text" ? b.text : "")).join("\n") : ""

/** The next assistant turn, decided from the conversation so far. */
function decide(messages) {
  // ANY tool result ends it, not only one in the last message: forge appends
  // its own notes after a tool result, and a stub that only looked at the
  // last message asked for the same command until forge's loop detector
  // stopped it (measured, first run).
  const sawResult = messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((b) => b?.type === "tool_result"))
  if (sawResult && !LOOP) return { text: "Done: ran the requested command." }
  const firstUser = messages.find((m) => m.role === "user")
  // v154: `STUB_TOOL: <tool name> <json input>` calls a named tool, e.g. one
  // a task's MCP server provides.
  const t = /STUB_TOOL:\s*(\S+)\s+(\{.*\})/.exec(textOf(firstUser?.content))
  if (t) return { tool: { id: `toolu_${messages.length}`, name: t[1], input: JSON.parse(t[2]) } }
  const m = /STUB_RUN:\s*(.+)/.exec(textOf(firstUser?.content))
  if (!m) return { text: "No STUB_RUN directive in the task; nothing to do." }
  return { tool: { id: `toolu_${messages.length}`, name: "bash", input: { command: m[1].trim() } } }
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}

function reply(res, turn, stream) {
  const content = turn.tool
    ? [{ type: "tool_use", id: turn.tool.id, name: turn.tool.name, input: turn.tool.input }]
    : [{ type: "text", text: turn.text }]
  const stop = turn.tool ? "tool_use" : "end_turn"
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model: "stub", content, stop_reason: stop, usage: USAGE }))
  }
  const block = turn.tool
    ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: turn.tool.id, name: turn.tool.name, input: {} } },
       { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.tool.input) } }]
    : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
       { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } }]
  sse(res, [
    { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "stub", content: [], usage: { ...USAGE, output_tokens: 1 } } },
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: USAGE.output_tokens } },
    { type: "message_stop" },
  ])
}

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    let j = null
    try { j = JSON.parse(body || "null") } catch { /* judged below */ }
    if (LOG) try { fs.appendFileSync(LOG, JSON.stringify({ method: req.method, url: req.url, key: req.headers["x-api-key"] ?? null, stream: j?.stream ?? false, n: j?.messages?.length ?? 0 }) + "\n") } catch { /* logging is best-effort */ }
    if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) { res.writeHead(404); return res.end("not found") }
    if (FAIL) { res.writeHead(FAIL, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `stub forced ${FAIL}` } })) }
    if (req.headers["x-api-key"] !== KEY) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })) }
    if (!Array.isArray(j?.messages)) { res.writeHead(400); return res.end("bad request") }
    reply(res, decide(j.messages), j.stream === true)
  })
})
server.listen(port, host, () => { process.stdout.write(`listening ${server.address().port}\n`) })
