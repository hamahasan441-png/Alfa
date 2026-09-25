#!/usr/bin/env node
// v176 — a chat stream dropped mid-answer is completed, not taken as whole.
//
// A gateway or proxy can close a stream CLEANLY in the middle of an answer:
// no finish_reason, no [DONE]. forge took whatever had arrived as the whole
// answer — shown, saved to the session, not a word that anything was missing
// — and a tool call whose arguments were still arriving was handed on as if
// complete. Now the providers say the stream ended early, and chat asks for
// the rest (or asks the round again when nothing was shown yet).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dropped-home-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const P = await import("../providers.js")
const C = await import("../chat.js")

/** An SSE server; `script(n, body)` returns the raw SSE text for request n. */
function sse(script) {
  const st = { n: 0, bodies: [] }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      st.bodies.push(j)
      const n = st.n++
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(script(n, j))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
const oa = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const an = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
async function collect(url, protocol = "openai") {
  const evs = []
  for await (const ev of P.streamChat({ protocol, baseUrl: url, apiKey: "k", model: "m", messages: [{ role: "user", content: "q" }] })) evs.push(ev)
  return evs
}
const dones = (evs) => evs.filter((e) => e.type === "done").map((e) => e.finishReason)

console.log("== 1. the providers say when a stream ended before it was done ==")
{
  let m = await sse(() => oa({ content: "The answer is: " }) + oa({ content: "PART-ONE" }))
  let evs = await collect(m.url)
  ok("OpenAI: a stream closed with no finish_reason and no [DONE] ends incomplete", dones(evs).at(-1) === P.STREAM_INCOMPLETE, JSON.stringify(dones(evs)))
  await m.stop()
  m = await sse(() => oa({ content: "whole" }, "stop"))
  evs = await collect(m.url)
  ok("OpenAI: a finish_reason without [DONE] is complete (gateways that never send it)", !dones(evs).includes(P.STREAM_INCOMPLETE) && dones(evs).includes("stop"))
  await m.stop()
  m = await sse(() => oa({ content: "whole" }) + "data: [DONE]\n\n")
  evs = await collect(m.url)
  ok("OpenAI: [DONE] without a finish_reason is complete", !dones(evs).includes(P.STREAM_INCOMPLETE))
  await m.stop()
  m = await sse(() => oa({ tool_calls: [{ index: 0, id: "t1", function: { name: "write_file", arguments: "{\"path\":\"out.txt\",\"content\":\"hal" } }] }))
  evs = await collect(m.url)
  ok("OpenAI: a tool call cut off mid-arguments is not handed on", !evs.some((e) => e.type === "tool_calls"), JSON.stringify(evs))
  ok("…and the end says a tool call was dropped", evs.at(-1)?.finishReason === P.STREAM_INCOMPLETE && evs.at(-1)?.droppedToolCalls === 1)
  await m.stop()
  m = await sse(() => oa({ tool_calls: [{ index: 0, id: "t1", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] }, "tool_calls") + "data: [DONE]\n\n")
  evs = await collect(m.url)
  ok("OpenAI: a finished tool call still is", evs.some((e) => e.type === "tool_calls" && e.calls[0]?.name === "bash"))
  await m.stop()
  m = await sse(() => an({ type: "message_start", message: { usage: { input_tokens: 1 } } }) + an({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } }))
  evs = await collect(m.url, "anthropic")
  ok("Anthropic: a stream closed with no stop_reason or message_stop ends incomplete", dones(evs).at(-1) === P.STREAM_INCOMPLETE, JSON.stringify(dones(evs)))
  await m.stop()
  m = await sse(() => an({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "whole" } }) + an({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + an({ type: "message_stop" }))
  evs = await collect(m.url, "anthropic")
  ok("Anthropic: a finished stream is complete", !dones(evs).includes(P.STREAM_INCOMPLETE) && dones(evs).includes("end_turn"))
  await m.stop()
}

function setup(url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dropped-chat-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dropped-work-"))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: url, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, skills: { enabled: false } }))
  return { home, work }
}
const chat = ({ home, work }, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  child.stdin.write(input); child.stdin.end()
  const t = setTimeout(() => { child.kill("SIGKILL"); resolve(out) }, 60000)
  child.on("exit", () => { clearTimeout(t); resolve(out) })
})
/** The last assistant message saved in the chat's session. */
const lastAssistant = (home) => {
  let best = ""
  try {
    const sd = path.join(home, "sessions")
    for (const f of fs.readdirSync(sd, { recursive: true }).filter((x) => String(x).endsWith(".json"))) {
      try { const j = JSON.parse(fs.readFileSync(path.join(sd, String(f)), "utf8")); for (const m of j.messages ?? []) if (m.role === "assistant" && typeof m.content === "string" && m.content) best = m.content } catch { /* not a session */ }
    }
  } catch { /* no sessions */ }
  return best
}
const cleanup = (env) => { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true }) }

console.log("== 2. chat: the rest of a dropped answer is asked for and joined ==")
{
  const m = await sse((n) => n === 0 ? oa({ content: "The answer is: " }) + oa({ content: "PART-ONE" }) : oa({ content: " PART-TWO." }, "stop") + "data: [DONE]\n\n")
  const env = setup(m.url)
  const out = await chat(env, "what is the answer?\n/exit\n")
  ok("the person sees the whole answer", /PART-ONE[\s\S]*PART-TWO/.test(out), out.slice(-400))
  ok("…is told it was joined", /the connection dropped mid-answer; the rest was asked for and joined \(2 parts\)/.test(out))
  ok("…and the session saves the whole answer, as one message", lastAssistant(env.home) === "The answer is: PART-ONE PART-TWO.", JSON.stringify(lastAssistant(env.home)))
  const ask = JSON.stringify(m.st.bodies[1]?.messages ?? [])
  ok("the second request carries the partial answer and asks to continue it", /The answer is: PART-ONE/.test(ask) && /Continue exactly where it stopped/.test(ask))
  await m.stop(); cleanup(env)
}

console.log("== 3. dropped twice, then whole ==")
{
  const m = await sse((n) => n === 0 ? oa({ content: "A" }) : n === 1 ? oa({ content: "B" }) : oa({ content: "C" }, "stop") + "data: [DONE]\n\n")
  const env = setup(m.url)
  const out = await chat(env, "letters\n/exit\n")
  ok("two drops are continued (3 parts)", lastAssistant(env.home) === "ABC" && /\(3 parts\)/.test(out), JSON.stringify(lastAssistant(env.home)))
  await m.stop(); cleanup(env)
}

console.log("== 4. a provider that keeps dropping: bounded, and said plainly ==")
{
  const m = await sse((n) => oa({ content: `P${n}` }))
  const env = setup(m.url)
  const out = await chat(env, "go\n/exit\n")
  ok(`it stops after ${C.STREAM_CONTINUES} continuations (${C.STREAM_CONTINUES + 1} requests)`, m.st.n === C.STREAM_CONTINUES + 1, `${m.st.n} requests`)
  ok("…and says the answer is incomplete", /the connection dropped before the answer finished — this answer is incomplete/.test(out), out.slice(-300))
  await m.stop(); cleanup(env)
}

console.log("== 5. a tool call dropped mid-arguments is never run; the round is asked again ==")
{
  const m = await sse((n) => n === 0
    ? oa({ tool_calls: [{ index: 0, id: "t1", function: { name: "write_file", arguments: "{\"path\":\"out.txt\",\"content\":\"hal" } }] })
    : oa({ content: "ASKED-AGAIN-OK" }, "stop") + "data: [DONE]\n\n")
  const env = setup(m.url)
  const out = await chat(env, "write the file\n/exit\n")
  ok("the half-received write_file did not run", !fs.existsSync(path.join(env.work, "out.txt")))
  ok("…the round was asked again, from the same conversation", m.st.n === 2 && JSON.stringify(m.st.bodies[1].messages) === JSON.stringify(m.st.bodies[0].messages))
  ok("…and the answer came through", /ASKED-AGAIN-OK/.test(out) && lastAssistant(env.home) === "ASKED-AGAIN-OK")
  await m.stop(); cleanup(env)
}

console.log("== 6. a normal stream is untouched ==")
{
  const m = await sse(() => oa({ content: "just fine" }, "stop") + "data: [DONE]\n\n")
  const env = setup(m.url)
  const out = await chat(env, "hi\n/exit\n")
  ok("one request, no notice, the answer saved", m.st.n === 1 && !/connection dropped/.test(out) && lastAssistant(env.home) === "just fine", `${m.st.n} requests`)
  await m.stop(); cleanup(env)
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== dropped-stream suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
