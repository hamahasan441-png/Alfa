#!/usr/bin/env node
// v167 — a rate limit is waited out, not retried into.
//
// Reported from a real run on SeekAI:
//   ⚠ transient provider error (provider HTTP 429: 您已达到总请求数限制：1分钟内最多…
//   (… successful steps …)
//   ⚠ transient provider error (provider HTTP 429: …
//   ⚠ transient provider error (provider did not respond within 30s …)
//   ✗ TASK FAILED
// The message says "at most N requests per minute". The agent loop had 3
// retries for the WHOLE run, never refilled after a success, and waited 2s,
// 4s, 6s — inside the same minute. Three such hits anywhere in a long run
// ended it on the fourth.
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
const RETRY_LEFT = A.RETRY_BUDGET - 1 // what a first retry after a success leaves
const ZH = (n) => `您已达到总请求数限制：1分钟内最多请求${n}次，请稍后再试`

console.log("== 1. what the 429 says ==")
{
  ok("the Chinese per-minute message: window and count", JSON.stringify(P.rateLimitFrom(ZH(10))) === JSON.stringify({ windowMs: 60000, perMinute: 10 }))
  ok("…cut before the count still says 'per minute'", JSON.stringify(P.rateLimitFrom("您已达到总请求数限制：1分钟内最多…")) === JSON.stringify({ windowMs: 60000, perMinute: null }))
  ok("'20 requests per minute'", P.rateLimitFrom("Rate limit reached: 20 requests per minute").perMinute === 20)
  ok("'RPM limit 60'", P.rateLimitFrom("RPM limit 60 exceeded").perMinute === 60)
  ok("a plain 'too many requests' names no window", JSON.stringify(P.rateLimitFrom("Too many requests")) === JSON.stringify({ windowMs: null, perMinute: null }))
}

console.log("== 2. how long to wait ==")
{
  const minute = new P.ProviderError("429", { status: 429, rateLimit: { windowMs: 60000, perMinute: 10 } })
  ok("a per-minute 429 waits 20s, 40s, 60s — out of the window", [1, 2, 3].map((n) => P.retryWaitMs(minute, n)).join(",") === "20000,40000,60000")
  ok("a positive Retry-After is used as given", P.retryWaitMs(new P.ProviderError("429", { status: 429, retryAfterMs: 5000, rateLimit: { windowMs: 60000 } }), 1) === 5000)
  ok("anything else keeps the old 2s steps (Retry-After 0 included)", P.retryWaitMs(new P.ProviderError("503", { status: 503 }), 2) === 4000 && P.retryWaitMs(new P.ProviderError("429", { status: 429, retryAfterMs: 0 }), 1) === 2000)
  ok("the notice says it is the rate limit, how long, and what is left",
    P.retryText({ rateLimited: true, perMinute: 10, waitMs: 20000, left: 2 }) === "the provider's rate limit (10 requests/min) was reached — waiting 20s, then continuing (2 more tries if it fails again)",
    P.retryText({ rateLimited: true, perMinute: 10, waitMs: 20000, left: 2 }))
}

/**
 * A model that works in steps (a bash call per request until `steps` are
 * done, then an answer), answering every `limitEvery`-th request with the
 * per-minute 429 — a limit hit again and again across one long run.
 */
function model({ steps = 5, limitEvery = 2, limitTimes = 5, retryAfter = "1", perMinute = 10 } = {}) {
  const st = { n: 0, limited: 0, times: [] }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      st.n++
      st.times.push(Date.now())
      if (st.limited < limitTimes && (st.n - 1) % limitEvery === 0) {
        st.limited++
        res.writeHead(429, { "content-type": "application/json", ...(retryAfter != null ? { "retry-after": retryAfter } : {}) })
        return res.end(JSON.stringify({ error: { message: ZH(perMinute), code: 429 } }))
      }
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const done = (j.messages ?? []).filter((m) => m.role === "tool").length
      const msg = done < steps
        ? { role: "assistant", content: "", tool_calls: [{ id: `t${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `echo STEP-${done}` }) } }] }
        : { role: "assistant", content: "ALL-STEPS-DONE" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}

async function inTemp(fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rate-"))
  const prev = process.cwd()
  process.chdir(work)
  try { return await fn(work) } finally { process.chdir(prev); fs.rmSync(work, { recursive: true, force: true }) }
}
const cfgFor = (url) => ({ providers: { stub: { protocol: "openai", baseUrl: url, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 12 }, skills: { enabled: false }, tools: { assumeYes: true } })

console.log("== 3. a long run that keeps hitting the limit finishes ==")
{
  P.resetPaces()
  // 600/min: pacing (which a 10/min limit would rightly set to one request
  // every 6s) stays out of the test's running time
  const m = await model({ steps: 5, limitEvery: 2, limitTimes: 5, retryAfter: "1", perMinute: 600 })
  const events = []
  let r = null, err = null
  await inTemp(async () => {
    try { r = await A.runAgent({ config: cfgFor(m.url), provider: P.buildProvider(cfgFor(m.url), "stub"), task: "five steps", onEvent: (e) => events.push(e) }) } catch (e) { err = e }
  })
  await m.stop()
  const retries = events.filter((e) => e.type === "retry")
  ok("five rate limits across one run, and it completes (it died on the fourth)", !err && r?.status === "COMPLETED" && /ALL-STEPS-DONE/.test(r.text) && m.st.limited === 5, err ? String(err.message).slice(0, 160) : `${r?.status}, ${m.st.limited} limits`)
  ok("the budget refills after each success: every retry still has 2 left", retries.length === 5 && retries.every((e) => e.left === RETRY_LEFT), JSON.stringify(retries.map((e) => e.left)))
  ok("…and each says it is the rate limit, with the limit", retries.every((e) => e.rateLimited === true && e.perMinute === 600))
}

console.log("== 3b. a provider that stalls now and then (the connect guard) ==")
{
  // requests 2, 4, 6 and 8 get no answer at all; the rest are served
  let n = 0
  const held = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      n++
      if (n % 2 === 0 && n <= 8) { held.push(res); return } // accepted, never answered
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const done = (j.messages ?? []).filter((m) => m.role === "tool").length
      const msg = done < 4
        ? { role: "assistant", content: "", tool_calls: [{ id: `t${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `echo S${done}` }) } }] }
        : { role: "assistant", content: "ALL-STEPS-DONE" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const cfg = { ...cfgFor(url), retry: { connectMs: 400, requestTimeoutMs: 30000 } }
  const events = []
  let r = null, err = null
  await inTemp(async () => {
    try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "four steps", onEvent: (e) => events.push(e) }) } catch (e) { err = e }
  })
  for (const res of held) { try { res.destroy() } catch { /* already gone */ } }
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  const retries = events.filter((e) => e.type === "retry")
  ok("four stalls across one run, and it completes (the reported run died on the connect guard)", !err && r?.status === "COMPLETED" && retries.length === 4, err ? String(err.message).slice(0, 160) : `${r?.status}, ${retries.length} retries`)
  ok("…each retry with the budget refilled", retries.every((e) => e.left === RETRY_LEFT), JSON.stringify(retries.map((e) => e.left)))
  const { nextStepFor } = await import("../agentview.js")
  const why = "provider did not respond within 30s (connect guard)"
  ok("the card's Next for a stall: /retry continues, or allow longer", /\/retry continues from where it stopped/.test(nextStepFor(why)) && /retry\.connectMs 60000/.test(nextStepFor(why)), nextStepFor(why))
  ok("…not '/details for diagnostics'", !/\/details/.test(nextStepFor(why)))
  ok("…and for `forge agent`, re-run", /re-run it/.test(nextStepFor(why, true)))
}

console.log("== 4. a per-minute 429 without Retry-After waits out the window ==")
{
  P.resetPaces()
  const m = await model({ steps: 1, limitEvery: 1, limitTimes: 1, retryAfter: null })
  const ctl = new AbortController()
  const events = []
  const t0 = Date.now()
  await inTemp(async () => {
    try { await A.runAgent({ config: cfgFor(m.url), provider: P.buildProvider(cfgFor(m.url), "stub"), task: "one step", signal: ctl.signal, onEvent: (e) => { events.push(e); if (e.type === "retry") setTimeout(() => ctl.abort(), 300) } }) } catch { /* aborted during the wait, on purpose */ }
  })
  await m.stop()
  const retry = events.find((e) => e.type === "retry")
  ok("it announces a 20s wait, not 2s", retry?.waitMs === 20000, JSON.stringify(retry && { waitMs: retry.waitMs }))
  ok("…and the wait is abortable (Ctrl+C does not sit it out)", Date.now() - t0 < 5000, `${Date.now() - t0}ms`)
}

console.log("== 5. once the limit is known, the run keeps to it ==")
{
  P.resetPaces()
  // 600/min → one request every 150ms; the limit is hit once, then paced
  const m = await model({ steps: 4, limitEvery: 1000, limitTimes: 1, retryAfter: "1", perMinute: 600 })
  m.st.n = 0
  await inTemp(async () => {
    await A.runAgent({ config: cfgFor(m.url), provider: P.buildProvider(cfgFor(m.url), "stub"), task: "four steps", onEvent: () => {} })
  })
  await m.stop()
  const after = m.st.times.slice(1)
  const gaps = after.slice(1).map((t, i) => t - after[i])
  ok("the pace was learned from the 429", P.paceFor({ baseUrl: m.url })?.intervalMs === 150, JSON.stringify(P.paceFor({ baseUrl: m.url })))
  ok("…and later requests keep to it (≥ ~150ms apart)", gaps.length >= 3 && gaps.every((g) => g >= 140), JSON.stringify(gaps))
  P.resetPaces()
  const free = await model({ steps: 3, limitEvery: 1000, limitTimes: 0 })
  await inTemp(async () => { await A.runAgent({ config: cfgFor(free.url), provider: P.buildProvider(cfgFor(free.url), "stub"), task: "three steps", onEvent: () => {} }) })
  await free.stop()
  ok("a provider that never said a limit is not paced", P.paceFor({ baseUrl: free.url }) === null)
}

console.log("== 6. end to end: a real headless run through repeated limits ==")
{
  P.resetPaces()
  const m = await model({ steps: 4, limitEvery: 2, limitTimes: 4, retryAfter: "1", perMinute: 600 })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rate-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rate-work-"))
  const run = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub",
    "--base-url", m.url, "--max-steps", "10", "--", "four steps"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  run.stdout.on("data", (d) => { out += d })
  run.stderr.on("data", (d) => { out += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { run.kill("SIGKILL"); r("timeout") }, 90000); run.once("exit", (c) => { clearTimeout(t); r(c) }) })
  await m.stop()
  ok("`forge agent` through four rate limits completes", code === 0 && /ALL-STEPS-DONE/.test(out) && m.st.limited === 4, `exit ${code}; ${out.slice(-300)}`)
  ok("…and says what happened each time", (out.match(/rate limit \(600 requests\/min\) was reached/g) ?? []).length === 4, out.slice(-600))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== rate-limits suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
