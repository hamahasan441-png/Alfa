#!/usr/bin/env node
// v199 — streams that carry the tools, finish or say why not, and never hang.
//
// 1. streamOpenAI sends the tool definitions. It never did — streamAnthropic
//    did — so a streamed chat turn on an OpenAI-protocol provider offered its
//    model no tools at all (closes `chat-stream-sends-tools`).
// 2. A stream that goes silent mid-answer is stopped by an idle guard that
//    every chunk re-arms. Before, the first chunk cleared the only timer.
// 3. The agent's calls stream on the OpenAI protocol (chatOnce stream:true):
//    an answer may take as long as it takes while bytes keep coming, instead
//    of arriving whole inside the 180s request guard (closes
//    `agent-long-answer-streams`). A provider that answers with plain JSON, or
//    refuses to stream, still works.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentstream-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const P = await import("../providers.js")
const A = await import("../agent.js")

/** A stub whose handler gets (request body, res, n). Records every body. */
async function stub(handler) {
  const bodies = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* as-is */ }
      bodies.push(j)
      handler(j, res, bodies.length)
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { bodies, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}
const sse = (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders() }
const chunk = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
const TOOLS = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } }]
const opts = (url, over = {}) => ({ protocol: "openai", baseUrl: url, apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], connectMs: 3000, firstByteMs: 3000, ...over })

console.log("== 1. the chat stream carries the tools ==")
{
  const s = await stub((j, res) => { sse(res); chunk(res, { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n") })
  for await (const _ of P.streamChat(opts(s.url, { tools: TOOLS, system: "SYS" }))) { /* drain */ }
  const b = s.bodies[0]
  ok("the streamed request offers the tools", b.stream === true && b.tools?.length === 1 && b.tools[0].function.name === "bash", JSON.stringify(b).slice(0, 200))
  ok("…and a separate `system` goes first, as chatOnce sends it", b.messages[0]?.role === "system" && b.messages[0].content === "SYS")
  for await (const _ of P.streamChat(opts(s.url))) { /* drain */ }
  ok("no tools: no `tools` field (never an empty list)", !("tools" in s.bodies[1]))
  await s.stop()
}

console.log("== 2. a stream that goes silent is stopped ==")
{
  const s = await stub((j, res) => { sse(res); chunk(res, { choices: [{ index: 0, delta: { content: "partial " }, finish_reason: null }] }) /* then nothing */ })
  const t0 = Date.now()
  let err = null, text = ""
  try { for await (const ev of P.streamChat(opts(s.url, { streamIdleMs: 400 }))) if (ev.type === "text") text += ev.text } catch (e) { err = e }
  const took = Date.now() - t0
  ok("chat stream: stopped after the idle window, not hung", err && took < 3000 && took >= 350, `${took}ms ${err?.message}`)
  ok("…as a retryable provider error that says so", err instanceof P.ProviderError && err.retryable === true && err.kind === "idle" && /went silent for 0s mid-answer|went silent for \d+s mid-answer/.test(err.message), err?.message)
  ok("…after what did arrive was passed on", text === "partial ")
  const t1 = Date.now()
  let err2 = null
  try { await P.chatOnce(opts(s.url, { stream: true, streamIdleMs: 400 })) } catch (e) { err2 = e }
  ok("agent call: the same idle stop", err2 instanceof P.ProviderError && err2.kind === "idle" && err2.retryable && Date.now() - t1 < 3000, err2?.message)
  await s.stop()
  const slow = await stub((j, res) => {
    sse(res); let i = 0
    // the first chunk comes after 450ms — past the 300ms request guard, inside
    // the first-byte guard — then one every 200ms
    let t = null
    setTimeout(() => { t = setInterval(tick, 200); tick() }, 450)
    const tick = () => { if (i < 5) { chunk(res, { choices: [{ index: 0, delta: { content: `p${i++} ` }, finish_reason: null }] }); return } clearInterval(t); chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n") }
  })
  const r = await P.chatOnce(opts(slow.url, { stream: true, streamIdleMs: 500, requestTimeoutMs: 300 }))
  ok("a slow stream that keeps sending is never cut — the idle timer re-arms on each chunk", r.content === "p0 p1 p2 p3 p4 ", JSON.stringify(r))
  ok("…and the 300ms request guard does not apply to a streamed answer (its first byte came at 450ms)", r.finishReason === "stop")
  await slow.stop()
  ok("the shipped idle window is two minutes", P.STREAM_IDLE_MS === 120000)
}

console.log("== 3. the agent's call, streamed ==")
{
  const s = await stub((j, res) => {
    sse(res)
    chunk(res, { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think " }, finish_reason: null }] })
    chunk(res, { choices: [{ index: 0, delta: { content: "Running it." }, finish_reason: null }] })
    chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "bash", arguments: "{\"comm" } }] }, finish_reason: null }] })
    chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "and\":\"ls\"}" } }] }, finish_reason: null }] })
    chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "t2", type: "function", function: { name: "bash", arguments: "{\"command\":\"pwd\"}" } }] }, finish_reason: null }] })
    chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    chunk(res, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })
    res.end("data: [DONE]\n\n")
  })
  const r = await P.chatOnce(opts(s.url, { stream: true, tools: TOOLS }))
  const b = s.bodies[0]
  ok("the request asks for a stream, with usage", b.stream === true && b.stream_options?.include_usage === true && b.tools?.length === 1)
  ok("text and reasoning are collected", r.content === "Running it." && r.reasoning === "think ")
  ok("tool calls are assembled from their pieces, in order", JSON.stringify(r.toolCalls) === JSON.stringify([{ id: "t1", name: "bash", args: "{\"command\":\"ls\"}" }, { id: "t2", name: "bash", args: "{\"command\":\"pwd\"}" }]), JSON.stringify(r.toolCalls))
  ok("finish reason and usage come through", r.finishReason === "tool_calls" && r.usage?.prompt_tokens === 11 && r.usage?.completion_tokens === 7, JSON.stringify(r.usage))
  await s.stop()

  const cut = await stub((j, res) => { sse(res); chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "bash", arguments: "{\"command\":\"rm -" } }] }, finish_reason: null }] }); res.end() })
  let e3 = null, got = null
  try { got = await P.chatOnce(opts(cut.url, { stream: true })) } catch (e) { e3 = e }
  ok("a stream that closes before it is done is an error, never a half tool call", got === null && e3 instanceof P.ProviderError && e3.kind === "incomplete" && e3.retryable === true && /1 tool call still arriving/.test(e3.message), e3?.message)
  await cut.stop()

  const errBody = await stub((j, res) => { sse(res); chunk(res, { error: { message: "upstream overloaded", code: 503 } }); res.end() })
  let e4 = null
  try { await P.chatOnce(opts(errBody.url, { stream: true })) } catch (e) { e4 = e }
  ok("an error sent inside the stream is that error", e4 instanceof P.ProviderError && /upstream overloaded/.test(e4.message), e4?.message)
  await errBody.stop()
}

console.log("== 4. providers that do not stream ==")
{
  const json = await stub((j, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) })
  const r = await P.chatOnce(opts(json.url, { stream: true }))
  ok("asked to stream, answered with JSON: the JSON answer is used", r.content === "plain" && r.finishReason === "stop" && json.bodies[0].stream === true)
  await json.stop()
  P.resetStreamRefusals()
  const refuse = await stub((j, res) => {
    if (j.stream) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "stream_options is not supported" } })) }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fine" }, finish_reason: "stop" }] }))
  })
  const r1 = await P.chatOnce(opts(refuse.url, { stream: true }))
  ok("a 400 about streaming: asked again without it, and answered", r1.content === "fine" && refuse.bodies.length === 2 && refuse.bodies[1].stream === undefined, JSON.stringify(refuse.bodies.map((b) => b.stream)))
  await P.chatOnce(opts(refuse.url, { stream: true }))
  ok("…and that provider is not asked to stream again", refuse.bodies.length === 3 && refuse.bodies[2].stream === undefined)
  P.resetStreamRefusals()
  await refuse.stop()
  const other400 = await stub((j, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid model id" } })) })
  let e5 = null
  try { await P.chatOnce(opts(other400.url, { stream: true })) } catch (e) { e5 = e }
  ok("any other 400 is thrown as before (one request)", e5 && /invalid model id/.test(e5.message) && other400.bodies.length === 1)
  await other400.stop()
  const anth = await stub((j, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "claude" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })) })
  const ra = await P.chatOnce({ ...opts(anth.url, { stream: true }), protocol: "anthropic" })
  ok("the Anthropic protocol is not streamed by chatOnce (unchanged)", ra.content === "claude" && anth.bodies[0].stream === undefined)
  await anth.stop()
  const plain = await stub((j, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] })) })
  await P.chatOnce(opts(plain.url))
  ok("without stream:true, chatOnce does not stream (chat's own non-stream path)", plain.bodies[0].stream === undefined)
  await plain.stop()
}

console.log("== 5. the agent streams, and its tools work over the stream ==")
{
  ok("agentStreams: on by default", A.agentStreams({}) === true && A.agentStreams({ agent: {} }, {}) === true)
  ok("…agent.stream: false turns it off", A.agentStreams({ agent: { stream: false } }, {}) === false)
  ok("…FORGE_AGENT_STREAM=0 too", A.agentStreams({}, { FORGE_AGENT_STREAM: "0" }) === false)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentstream-run-"))
  const s = await stub((j, res) => {
    const hasResult = (j.messages ?? []).some((m) => m.role === "tool")
    sse(res)
    if (!hasResult) {
      chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo STREAMED" } }] }, finish_reason: null }] })
      chunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: " > out.txt\"}" } }] }, finish_reason: "tool_calls" }] })
    } else chunk(res, { choices: [{ index: 0, delta: { content: "Wrote out.txt." }, finish_reason: "stop" }] })
    res.end("data: [DONE]\n\n")
  })
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: s.url, apiKey: "k", model: "m" } }, agent: { maxSteps: 4 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const prev = process.cwd()
  process.chdir(work)
  let res = null, err = null
  try { res = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "write out.txt", onEvent: () => {} }) } catch (e) { err = e }
  process.chdir(prev)
  const wrote = fs.existsSync(path.join(work, "out.txt")) ? fs.readFileSync(path.join(work, "out.txt"), "utf8").trim() : null
  ok("every agent request was streamed", s.bodies.length >= 2 && s.bodies.every((b) => b.stream === true), JSON.stringify(s.bodies.map((b) => b.stream)))
  ok("the tool call assembled from two chunks ran", wrote === "STREAMED", `${wrote} ${err?.message ?? ""}`)
  ok("…and the run finished with the model's answer", /Wrote out\.txt\./.test(String(res?.text ?? "")), String(res?.text ?? err?.message))
  await s.stop()
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== 6. the MCP catalog loads only when a prompt recommends from it ==")
{
  const CR = await import("../caproute.js")
  ok("a run whose task has no capability gap never loaded it (section 5)", CR.mcpCatalogLoaded() === false)
  // a real gap: web search disabled, and no skill that covers it (with the
  // bundled skills one does, so a run like section 5's has none)
  const C = await import("../capabilities.js")
  const reg = C.defaultRegistry({ tools: { disabled: ["web_search", "fetch_url", "browser"] } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-agentstream-gap-"))
  const prompt = () => A.agentSystemPrompt({ cwd: dir, task: "search the web for the documentation of this API", config: {}, skillsDir: dir, skillsEnabled: true, registry: reg, repoMap: false, skillPicks: [], skillIndex: [] })
  ok("before the catalog is loaded: the gap is named, no MCP server is offered", /Capability gaps[^\n]*web_search/.test(prompt()) && !/forge mcp add /.test(prompt()))
  await CR.primeMcpCatalog()
  const sys = prompt()
  ok("loaded: an MCP server for the gap is recommended — found by searching the gap on its own", CR.mcpCatalogLoaded() === true && /forge mcp add (search-mcp|exa|nimrod)/.test(sys), (sys.match(/CAPABILITY RECOMMENDATIONS[\s\S]{0,300}/) ?? ["no recommendations"])[0])
  const recs = CR.recommendForGaps({ task: "search the web for the documentation of this API", gaps: ["web_search", "browser"], limit: 3 })
  const again = CR.recommendForGaps({ task: "web search", gaps: ["web_search"], limit: 6 }).filter((r) => r.kind === "mcp").map((r) => r.name)
  ok("a server found by two searches is offered once", again.length >= 3 && new Set(again).size === again.length, JSON.stringify(again))
  ok("several gaps: servers for each, at most `limit`, no duplicates", recs.filter((r) => r.kind === "mcp").length === 3 && new Set(recs.map((r) => r.name)).size === recs.length, JSON.stringify(recs.map((r) => r.name)))
  fs.rmSync(dir, { recursive: true, force: true })
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== agent-stream suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
