#!/usr/bin/env node
// v201 — every model call streams.
//
// A non-streamed request is guarded by `connectMs` until its response headers
// arrive. A server that sends its headers with the finished answer (OpenAI's
// non-streamed responses carry `openai-processing-ms`, so theirs leave after
// the work) gave the whole generation 8s: "provider did not respond within 8s
// (connect guard)", retried, refused again. v199 streamed the agent's OpenAI
// calls; this streams the rest — the agent on the Anthropic protocol, history
// compaction, MCP sampling — so headers come first and v199's idle guard
// watches the answer.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-anthstream-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const P = await import("../providers.js")
const A = await import("../agent.js")

async function stub(handler) {
  const bodies = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => { let j = {}; try { j = JSON.parse(b) } catch { /* as-is */ } bodies.push(j); handler(j, res, bodies.length) })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { bodies, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}
const sse = (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders() }
const ev = (res, obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`)
const opts = (url, over = {}) => ({ protocol: "anthropic", baseUrl: url, apiKey: "k", model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], connectMs: 3000, firstByteMs: 3000, stream: true, ...over })

/** A full streamed answer: thinking, text, two tool calls in pieces, usage split across start and delta. */
function fullAnswer(res) {
  ev(res, { type: "message_start", message: { id: "m", usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } } })
  ev(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
  ev(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } })
  ev(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "see" } })
  ev(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
  ev(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Running " } })
  ev(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "it." } })
  ev(res, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "bash", input: {} } })
  ev(res, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"comm" } })
  ev(res, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "and\":\"ls\"}" } })
  ev(res, { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu2", name: "git_status", input: {} } })
  ev(res, { type: "content_block_stop", index: 3 })
  ev(res, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } })
  ev(res, { type: "message_stop" })
  res.end()
}

console.log("== 1. the streamed Anthropic call ==")
{
  const s = await stub((j, res) => { sse(res); fullAnswer(res) })
  const r = await P.chatOnce(opts(s.url, { system: "SYS", tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }], deep: true, maxTokens: 16384 }))
  const b = s.bodies[0]
  ok("the request asks to stream", b.stream === true)
  ok("…and keeps what the non-streamed body had: system, tools, caching, thinking", JSON.stringify(b).includes("SYS") && b.tools?.[0]?.name === "bash" && /cache_control/.test(JSON.stringify(b)) && !!b.thinking, JSON.stringify(b).slice(0, 300))
  ok("text and thinking are collected", r.content === "Running it." && r.reasoning === "let me see", JSON.stringify(r))
  ok("tool calls are assembled from their pieces, in order", JSON.stringify(r.toolCalls) === JSON.stringify([{ id: "tu1", name: "bash", args: "{\"command\":\"ls\"}" }, { id: "tu2", name: "git_status", args: "{}" }]), JSON.stringify(r.toolCalls))
  ok("…a tool call with no input has args {} (as the non-streamed path gives)", r.toolCalls[1]?.args === "{}")
  ok("usage joins message_start's input side and message_delta's output side", r.usage?.prompt_tokens === 117 && r.usage?.completion_tokens === 42, JSON.stringify(r.usage))
  ok("…with the cache fields cache health reads", r.usage?.cache_read_tokens === 100 && r.usage?.cache_write_tokens === 5 && r.usage?.uncached_tokens === 12)
  ok("the stop reason comes through", r.finishReason === "tool_use")
  await s.stop()
  const plain = await stub((j, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn" })) })
  await P.chatOnce(opts(plain.url, { stream: undefined }))
  ok("without stream:true the Anthropic call is not streamed (chat's stream:false path)", plain.bodies[0].stream === undefined)
  await plain.stop()
}

console.log("== 2. the same events, the same answer, in chat and the agent ==")
{
  const s = await stub((j, res) => { sse(res); fullAnswer(res) })
  let text = "", calls = null, done = null
  for await (const e of P.streamChat(opts(s.url))) {
    if (e.type === "text") text += e.text
    else if (e.type === "tool_calls") calls = e.calls
    else if (e.type === "done") done = e.finishReason
  }
  const r = await P.chatOnce(opts(s.url))
  ok("chat's stream and the agent's call read one parser: same text, tool calls, stop reason", text === r.content && JSON.stringify(calls.map((c) => [c.id, c.name, c.args || "{}"])) === JSON.stringify(r.toolCalls.map((c) => [c.id, c.name, c.args])) && done === r.finishReason, JSON.stringify({ text, calls, done }))
  await s.stop()
}

console.log("== 3. ends and errors ==")
{
  const cut = await stub((j, res) => {
    sse(res)
    ev(res, { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } })
    ev(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "bash", input: {} } })
    ev(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"rm -" } })
    res.end()
  })
  let e1 = null, got = null
  try { got = await P.chatOnce(opts(cut.url)) } catch (e) { e1 = e }
  ok("no stop_reason and no message_stop: a retryable error, never a half tool call", got === null && e1 instanceof P.ProviderError && e1.kind === "incomplete" && e1.retryable && /1 tool call still arriving/.test(e1.message), e1?.message)
  await cut.stop()
  const bad = await stub((j, res) => { sse(res); ev(res, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }); res.end() })
  let e2 = null
  try { await P.chatOnce(opts(bad.url)) } catch (e) { e2 = e }
  ok("an error event is that error", e2 instanceof P.ProviderError && /Overloaded/.test(e2.message), e2?.message)
  await bad.stop()
  const stall = await stub((j, res) => { sse(res); ev(res, { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }) })
  const t0 = Date.now()
  let e3 = null
  try { await P.chatOnce(opts(stall.url, { streamIdleMs: 400 })) } catch (e) { e3 = e }
  ok("a stream that goes silent is stopped by the idle guard", e3 instanceof P.ProviderError && e3.kind === "idle" && Date.now() - t0 < 3000, e3?.message)
  await stall.stop()
  const slow = await stub((j, res) => {
    sse(res); let i = 0
    ev(res, { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } })
    const t = setInterval(() => {
      if (i < 5) { ev(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `p${i++} ` } }); return }
      clearInterval(t); ev(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }); ev(res, { type: "message_stop" }); res.end()
    }, 200)
  })
  const r = await P.chatOnce(opts(slow.url, { streamIdleMs: 500, requestTimeoutMs: 300 }))
  ok("a slow stream that keeps sending is never cut", r.content === "p0 p1 p2 p3 p4 " && r.finishReason === "end_turn", JSON.stringify(r))
  await slow.stop()
}

console.log("== 4. fallbacks ==")
{
  const json = await stub((j, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "whole" }, { type: "tool_use", id: "x", name: "bash", input: { command: "pwd" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 2 } })) })
  const r = await P.chatOnce(opts(json.url))
  ok("asked to stream, answered with JSON: read as JSON", r.content === "whole" && r.toolCalls[0]?.args === "{\"command\":\"pwd\"}" && json.bodies[0].stream === true)
  await json.stop()
  P.resetStreamRefusals()
  const refuse = await stub((j, res) => {
    if (j.stream) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stream: Extra inputs are not permitted" } })) }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }))
  })
  const r1 = await P.chatOnce(opts(refuse.url))
  await P.chatOnce(opts(refuse.url))
  ok("a 400 about streaming: asked again without it, and not asked to stream again", r1.content === "ok" && refuse.bodies.map((b) => b.stream === true).join() === "true,false,false", JSON.stringify(refuse.bodies.map((b) => b.stream)))
  P.resetStreamRefusals()
  await refuse.stop()
}

console.log("== 5. the point: a server that sends its headers with the finished answer ==")
{
  // Non-streamed: nothing (not even headers) until the answer is done, after
  // 2s. Streamed: headers at once, then the answer. connectMs is 1s.
  const holding = (answer) => stub((j, res) => {
    if (j.stream) {
      sse(res)
      ev(res, { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } })
      setTimeout(() => { answer.stream(res); ev(res, { type: "message_stop" }); res.end() }, 2000)
      return
    }
    setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer.json(j))) }, 2000)
  })
  const text = { stream: (res) => { ev(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUMMARY-OK" } }); ev(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) }, json: () => ({ content: [{ type: "text", text: "SUMMARY-OK" }], stop_reason: "end_turn" }) }
  const s = await holding(text)
  let before = null
  try { await P.chatOnce(opts(s.url, { stream: false, connectMs: 1000 })) } catch (e) { before = e }
  ok("not streamed: refused by the connect guard, though the server was answering", before instanceof P.ProviderError && /within 1s \(connect guard\)/.test(before.message), before?.message)
  const after = await P.chatOnce(opts(s.url, { connectMs: 1000 }))
  ok("streamed: the headers come first, and the answer arrives", after.content === "SUMMARY-OK")
  await s.stop()

  // compaction asks for a stream (agent.js compactAgentHistory → chatOnce stream:true)
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  const compaction = src.slice(src.indexOf("async function compactAgentHistory"), src.indexOf("async function compactAgentHistory") + 1500)
  ok("history compaction streams (agent)", /stream: true/.test(compaction))
  const chatSrc = fs.readFileSync(new URL("../chat.js", import.meta.url), "utf8")
  ok("history compaction streams (chat)", /Summarize this conversation[\s\S]{0,700}stream: true/.test(chatSrc))
  const mcpSrc = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("MCP sampling streams", /flattenContent\(m\?\.content\)[\s\S]{0,900}stream: true/.test(mcpSrc))

  // a real agent run on the Anthropic protocol, against the holding server
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-anthstream-run-"))
  const run = await holding({
    stream: (res) => {
      // first turn: a bash tool call; after the result: the final answer
      if (!run.bodies.at(-1)?.messages?.some((msg) => Array.isArray(msg.content) && msg.content.some((c) => c.type === "tool_result"))) {
        ev(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "bash", input: {} } })
        ev(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo HELD > held.txt\"}" } })
        ev(res, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } })
      } else {
        ev(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Wrote held.txt." } })
        ev(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })
      }
    },
    json: () => ({ content: [{ type: "text", text: "not streamed" }], stop_reason: "end_turn" }),
  })
  const cfg = { providers: { a: { protocol: "anthropic", baseUrl: run.url, apiKey: "k", model: "claude-sonnet-5" } }, agent: { maxSteps: 4 }, skills: { enabled: false }, tools: { assumeYes: true }, retry: { connectMs: 1000, firstByteMs: 5000, attempts: 1 } }
  const prev = process.cwd()
  process.chdir(work)
  let res = null, err = null
  try { res = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "a"), task: "write held.txt", onEvent: () => {} }) } catch (e) { err = e }
  process.chdir(prev)
  const wrote = fs.existsSync(path.join(work, "held.txt")) ? fs.readFileSync(path.join(work, "held.txt"), "utf8").trim() : null
  ok("an Anthropic agent run against it: every request streamed", run.bodies.length >= 2 && run.bodies.every((b) => b.stream === true), JSON.stringify(run.bodies.map((b) => b.stream)))
  ok("…the tool call it streamed ran, and the run ended with the answer", wrote === "HELD" && /Wrote held\.txt\./.test(String(res?.text ?? "")), `${wrote} ${err?.message ?? res?.text}`)
  await run.stop()
  fs.rmSync(work, { recursive: true, force: true })
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== anthropic-stream suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
