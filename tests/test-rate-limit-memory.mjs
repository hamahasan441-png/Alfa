#!/usr/bin/env node
// v169 — a provider's stated rate limit, kept for the next run.
//
// v167 paced requests once a 429 named its limit, but only in the process
// that saw it: every new run met the limit again and waited out a window
// first. The bench case `rate-limit-remembered` measured it: run 1 learned
// 600/min, run 2's requests went out 10-40ms apart.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ratemem-"))
process.env.FORGE_HOME = HOME // before any forge module fixes its data dir

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const R = await import("../ratelimits.js")
const P = await import("../providers.js")
const A = await import("../agent.js")

console.log("== 1. the store ==")
{
  const file = path.join(HOME, "t1.json")
  const k = R.rateLimitKey("https://seekai.cc/v1/", "sk-secret-123")
  ok("the account key names the URL and a hash, never the API key", k.startsWith("https://seekai.cc/v1#") && !k.includes("sk-secret"), k)
  ok("two keys on one gateway are two accounts", R.rateLimitKey("https://x/v1", "a") !== R.rateLimitKey("https://x/v1", "b"))
  R.storeRateLimit(k, 10, { file, now: 1000000 })
  ok("a stored limit comes back", R.storedRateLimit(k, { file, now: 1000000 + 60000 })?.perMinute === 10)
  ok("…and the file never holds the key", !fs.readFileSync(file, "utf8").includes("sk-secret"))
  ok("after a day it is re-learned, not kept forever", R.storedRateLimit(k, { file, now: 1000000 + R.RATE_LIMIT_TTL_MS + 1 }) === null)
  ok("a timestamp from the future is not trusted", R.storedRateLimit(k, { file, now: 1000000 - 3600000 }) === null)
  R.storeRateLimit(k, -5, { file }); R.storeRateLimit(k, NaN, { file })
  ok("nonsense limits are not stored", R.storedRateLimit(k, { file, now: 1000000 + 1000 })?.perMinute === 10)
  for (let i = 0; i < 80; i++) R.storeRateLimit(`u${i}#x`, 5, { file, now: 2000000 + i })
  ok("the store is bounded (64 entries, oldest dropped)", Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length === 64 && R.storedRateLimit("u79#x", { file, now: 2000100 }) && !R.storedRateLimit("u0#x", { file, now: 2000100 }))
  fs.writeFileSync(file, "{ not json")
  ok("a broken file is an empty store, not a crash", R.storedRateLimit(k, { file }) === null)
}

/** A gateway: the first request gets the 429 naming 600/min, the rest answer. */
function gateway({ limitFirst = true } = {}) {
  const st = { times: [], limited: false }
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      st.times.push(Date.now())
      if (limitFirst && !st.limited) {
        st.limited = true
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" })
        return res.end(JSON.stringify({ error: { message: "您已达到总请求数限制：1分钟内最多请求600次", code: 429 } }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
const ask = (url, apiKey, extra = {}) => P.chatOnce({ protocol: "openai", baseUrl: url, apiKey, model: "m", messages: [{ role: "user", content: "hi" }], ...extra })
const gaps = (t) => t.slice(1).map((v, i) => v - t[i])

console.log("== 2. learned in one process, kept in the next ==")
{
  const g = await gateway()
  P.resetPaces()
  const learned = []
  try { await ask(g.url, "key-A", { onPace: (p) => learned.push(p) }) } catch { /* the 429 is thrown to the caller, who retries */ }
  ok("the 429's limit is learned, and said", learned.length === 1 && learned[0].perMinute === 600 && learned[0].remembered === false, JSON.stringify(learned))
  ok("…and written to the store", R.storedRateLimit(R.rateLimitKey(g.url, "key-A"))?.perMinute === 600)
  P.resetPaces() // a new process: nothing in memory
  g.st.times.length = 0
  const told = []
  for (let i = 0; i < 4; i++) await ask(g.url, "key-A", { onPace: (p) => told.push(p) })
  ok("the next process keeps the pace from its first requests (≥ ~150ms apart)", gaps(g.st.times).every((x) => x >= 140), JSON.stringify(gaps(g.st.times)))
  ok("…and says why, once, as a remembered limit", told.length === 1 && told[0].remembered === true && told[0].perMinute === 600, JSON.stringify(told))
  ok("…in words", /keeping this provider's stated limit of 600 requests\/min \(it said so \d+ min ago\)/.test(P.paceText(told[0])), P.paceText(told[0]))
  P.resetPaces()
  g.st.times.length = 0
  for (let i = 0; i < 3; i++) await ask(g.url, "key-B")
  ok("another account on the same gateway is not slowed by it", gaps(g.st.times).every((x) => x < 100), JSON.stringify(gaps(g.st.times)))
  await g.stop()
}

console.log("== 3. an expired limit is not kept ==")
{
  const g = await gateway({ limitFirst: false })
  const key = R.rateLimitKey(g.url, "key-C")
  const all = JSON.parse(fs.readFileSync(R.RATE_LIMITS_PATH, "utf8"))
  all[key] = { perMinute: 600, at: Date.now() - R.RATE_LIMIT_TTL_MS - 60000 }
  fs.writeFileSync(R.RATE_LIMITS_PATH, JSON.stringify(all))
  P.resetPaces()
  for (let i = 0; i < 3; i++) await ask(g.url, "key-C")
  ok("a day-old limit does not slow the run", gaps(g.st.times).every((x) => x < 100), JSON.stringify(gaps(g.st.times)))
  await g.stop()
}

console.log("== 4. a run says why it is slower ==")
{
  const g = await gateway({ limitFirst: false })
  R.storeRateLimit(R.rateLimitKey(g.url, "k"), 600)
  P.resetPaces()
  const events = []
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ratemem-run-"))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: g.url, apiKey: "k", model: "m" } }, agent: { maxSteps: 3 }, skills: { enabled: false } }
  try { await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "hi", onEvent: (e) => events.push(e) }) } catch { /* the notice is what is tested */ }
  process.chdir(prev)
  fs.rmSync(work, { recursive: true, force: true })
  await g.stop()
  ok("the agent run shows the remembered limit as a notice", events.some((e) => e.type === "info" && /keeping this provider's stated limit of 600 requests\/min/.test(e.text)), JSON.stringify(events.filter((e) => e.type === "info").map((e) => e.text)))
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== rate-limit-memory suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
