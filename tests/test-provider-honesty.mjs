#!/usr/bin/env node
// v170 — what a provider sends is read as what it is (audit findings 1, 2, 3, 7).
//
//   1. chat dropped an error INSIDE a stream: `data: {"error": …}` mid-answer
//      left the partial text as the answer; as the first event ("余额不足
//      insufficient quota") it left an empty reply and no message.
//   2. the agent read `200 {"error": …}` (gateway style) as an empty model
//      response: it nudged the model and never showed the error.
//   3. output cut off at the max_tokens limit: tool arguments cut mid-JSON
//      reached the tool as {} ("ERROR: empty path"), and a cut-off answer was
//      accepted as final (agent) or shown as whole (chat).
//   7. a gateway's own "502 Bad Gateway" page, sent with 200, ended the run
//      on the first try.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const P = await import("../providers.js")
const A = await import("../agent.js")

console.log("== 1. an error body is classified into the flows that exist ==")
{
  const q = P.bodyError({ error: { message: "余额不足，请充值 insufficient quota", code: "insufficient_user_quota" } }, "seekai")
  ok("out of credits → 402, the v165 wording", q.status === 402 && /^provider HTTP 402 — out of credits on seekai/.test(q.message), q.message)
  const r = P.bodyError({ error: { message: "您已达到总请求数限制：1分钟内最多请求10次" } }, "seekai")
  ok("a rate limit → 429 with its limit read", r.status === 429 && r.retryable && r.rateLimit?.perMinute === 10, JSON.stringify({ s: r.status, rl: r.rateLimit }))
  const b = P.bodyError({ error: { message: "上游负载已饱和，请稍后再试", type: "upstream_error" } }, "seekai")
  ok("a busy upstream → retryable", b.status === 503 && b.retryable === true && /上游负载已饱和/.test(b.message), b.message)
  const o = P.bodyError({ error: { message: "model not supported" } }, "seekai")
  ok("anything else is shown and not retried", o.retryable === false && /model not supported/.test(o.message))
  ok("no error, no error", P.bodyError({ choices: [] }) === null)
}

/** A scripted OpenAI-wire server: each request gets the next scripted reply. */
function server(script) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      seen.push(j)
      const step = script[Math.min(seen.length - 1, script.length - 1)]
      const reply = typeof step === "function" ? step(j) : step
      res.writeHead(reply.status ?? 200, { "content-type": reply.ctype ?? (reply.sse ? "text/event-stream" : "application/json") })
      res.end(reply.raw ?? (reply.sse ? reply.sse.join("") : JSON.stringify(reply.json)))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
const answer = (text, finish = "stop") => ({ json: { id: "c", choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } } })
const call = (name, args, finish = "tool_calls") => ({ json: { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name, arguments: args } }] }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } } })

async function agentRun(script, { maxSteps = 5 } = {}) {
  const s = await server(script)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-honesty-"))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { seekai: { protocol: "openai", baseUrl: s.url, apiKey: "k", model: "m" } }, agent: { maxSteps }, skills: { enabled: false }, tools: { assumeYes: true } }
  const events = []
  let r = null, err = null
  try { r = await A.runAgent({ config: cfg, provider: { ...P.buildProvider(cfg, "seekai"), name: "seekai" }, task: "do it", onEvent: (e) => events.push(e) }) } catch (e) { err = e }
  const files = fs.readdirSync(work)
  process.chdir(prev)
  await s.stop()
  fs.rmSync(work, { recursive: true, force: true })
  return { r, err, events, seen: s.seen, files }
}

console.log("== 2. the agent: an error sent with 200 is an error ==")
{
  const busy = await agentRun([{ json: { error: { message: "上游负载已饱和，请稍后再试", type: "upstream_error" } } }, answer("FINAL")])
  ok("a busy upstream (200 + error) is retried and the run completes", busy.r?.status === "COMPLETED" && /FINAL/.test(busy.r.text), busy.err?.message ?? busy.r?.status)
  const retry = busy.events.find((e) => e.type === "retry")
  ok("…and the retry shows the provider's words, not 'empty model response'", retry && /上游负载已饱和/.test(retry.error) && !/empty model response/.test(retry.error), JSON.stringify(retry))
  ok("…and the model was never told its answer was empty", !busy.seen.some((j) => JSON.stringify(j.messages ?? []).includes("your last response was empty")))
  const spent = await agentRun([{ json: { error: { message: "余额不足 insufficient quota", code: "insufficient_user_quota" } } }])
  ok("out of credits (200 + error) stops with the out-of-credits message", spent.err?.status === 402 && /out of credits on seekai; top up/.test(spent.err.message), spent.err?.message ?? spent.r?.status)
}

console.log("== 3. the agent: output cut off at the token limit ==")
{
  const cut = await agentRun([call("bash", '{"command": "echo hi > made.txt; echo mo', "length"), answer("done")])
  const toolMsg = JSON.stringify(cut.seen[1]?.messages ?? [])
  ok("a tool call cut off mid-arguments is NOT run", !cut.files.includes("made.txt"), JSON.stringify(cut.files))
  ok("…and the model is told why, and what to do instead", /cut off at the output-token limit before this bash call was complete/.test(toolMsg) && /smaller pieces/.test(toolMsg), toolMsg.slice(0, 300))
  const bad = await agentRun([call("bash", "{not json at all"), answer("done")])
  ok("invalid JSON without a cut-off says so plainly", /arguments are not valid JSON, so nothing was run/.test(JSON.stringify(bad.seen[1]?.messages ?? [])))
  const text = await agentRun([answer("Here is the plan: 1. first do", "length"), answer(" the parsing, 2. then the tests.")])
  ok("a cut-off answer is continued and joined", text.r?.status === "COMPLETED" && text.r.text === "Here is the plan: 1. first do the parsing, 2. then the tests.", JSON.stringify(text.r?.text))
  ok("…the model was asked to continue where it stopped", /Continue exactly where it stopped/.test(JSON.stringify(text.seen[1]?.messages ?? [])))
  ok("…and the run said so", text.events.some((e) => e.type === "info" && /reached the output-token limit — asking the model to continue \(1 of 2\)/.test(e.text)))
  const forever = await agentRun([answer("a", "length"), answer("b", "length"), answer("c", "length")])
  ok("continuing is bounded, and a still-cut answer is flagged", forever.seen.length === 3 && /^abc\n\n\(forge: this answer reached the output-token limit 3 times and may be incomplete\)$/.test(forever.r?.text ?? ""), JSON.stringify(forever.r?.text))
}

console.log("== 4. a gateway's own error page is retried; a wrong URL is not ==")
{
  const gw = await agentRun([{ raw: "<html><body><h1>502 Bad Gateway</h1></body></html>", ctype: "text/html" }, answer("FINAL")])
  ok("a 502 page sent with 200 is retried and the run completes", gw.r?.status === "COMPLETED", gw.err?.message)
  const portal = await agentRun([{ raw: "<html><body>Please log in to the Wi-Fi</body></html>", ctype: "text/html" }, answer("FINAL")])
  ok("any other HTML page still stops, with the URL advice", portal.err && /non-JSON response/.test(portal.err.message) && /check providers\.seekai\.baseUrl/.test(portal.err.message), portal.err?.message ?? portal.r?.status)
}

console.log("== 5. streams: an error inside one is an error ==")
{
  const collect = async (s, protocol = "openai") => {
    const evs = []
    let err = null
    try { for await (const ev of P.streamChatResilient({ protocol, baseUrl: s.url, apiKey: "k", model: "m", providerName: "seekai", messages: [{ role: "user", content: "hi" }] }, { attempts: 1 })) evs.push(ev) } catch (e) { err = e }
    await s.stop()
    return { text: evs.filter((e) => e.type === "text").map((e) => e.text).join(""), err }
  }
  const mid = await collect(await server([{ sse: ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"error":{"message":"upstream timeout","type":"upstream_error"}}\n\n'] }]))
  ok("an error mid-stream throws, after the partial text", mid.text === "Hel" && /upstream timeout/.test(String(mid.err?.message)), String(mid.err?.message))
  const first = await collect(await server([{ sse: ['data: {"error":{"message":"余额不足 insufficient quota","code":"insufficient_user_quota"}}\n\n', "data: [DONE]\n\n"] }]))
  ok("an error as the first event is not an empty answer: out of credits", first.err?.status === 402 && /out of credits on seekai/.test(first.err.message), String(first.err?.message))
  const anth = await collect(await server([{ sse: ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'] }]), "anthropic")
  ok("the Anthropic wire's error event throws (and an overload is retryable)", anth.err?.retryable === true && /Overloaded/.test(anth.err.message), String(anth.err?.message))
}

console.log("== 6. chat, end to end: a cut-off answer and an in-stream error are said ==")
{
  const s = await server([
    { sse: ['data: {"choices":[{"delta":{"content":"part one of the answer"},"finish_reason":"length"}]}\n\n', "data: [DONE]\n\n"] },
    { sse: ['data: {"error":{"message":"余额不足 insufficient quota","code":"insufficient_user_quota"}}\n\n'] },
  ])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-honesty-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-honesty-work-"))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "seekai", providers: { seekai: { protocol: "openai", baseUrl: s.url, apiKey: "k", model: "m" } }, tools: { enabled: false } }))
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { ...process.env, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d })
  child.stderr.on("data", (d) => { out += d })
  child.stdin.write("tell me a long story\nand another\n/exit\n"); child.stdin.end()
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 60000); child.on("exit", (c) => { clearTimeout(t); r(c) }) })
  await s.stop()
  ok("chat says an answer was cut off at the output-token limit", /cut off at the output-token limit — say "continue"/.test(out), out.slice(-500))
  ok("chat shows an in-stream 'insufficient quota' instead of an empty reply", /out of credits on seekai/.test(out), out.slice(-500))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
  void code
}

console.log(`\n== provider-honesty suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
