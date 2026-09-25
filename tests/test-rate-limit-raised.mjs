#!/usr/bin/env node
// v182 — a provider limit that went up stops pacing the run.
//
// v169 paces every run to a limit the provider stated, for a day, and never
// sends faster — so it could not see the limit go up: an upgraded plan was
// still paced to the old limit, every request waiting for nothing. Now a
// streak of successes at the kept pace doubles it; once that is effectively
// unlimited, pacing stops and the stored limit is forgotten. A 429 while
// probing sets the pace back from the provider's words and ends probing.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-raised-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const P = await import("../providers.js")
const L = await import("../ratelimits.js")

/** A gateway. `strictMs` > 0: a request sooner than that after the last is a 429 stating 600/min. */
function gateway({ strictMs = 0, stream = false } = {}) {
  const st = { times: [], limited: 0 }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const now = Date.now()
      const last = st.times.at(-1)
      st.times.push(now)
      if (strictMs && last && now - last < strictMs) {
        st.limited++
        res.writeHead(429, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 429, message: "您已达到总请求数限制：1分钟内最多请求600次，请稍后再试" } }))
      }
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
const opts = (url, notes) => ({ protocol: "openai", baseUrl: url, apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], onPace: (p) => notes.push(p) })
const gaps = (t) => t.slice(1).map((v, i) => v - t[i])
/** Up to n successful calls; a 429 is retried after the provider's pace (as the agent loop does). */
async function calls(g, n, notes) {
  let done = 0
  for (let i = 0; i < n * 3 && done < n; i++) {
    try { await P.chatOnce(opts(g.url, notes)); done++ } catch (e) { if (e?.status !== 429) throw e }
  }
  return done
}

console.log("== 1. the limit went up: the pace follows, then stops ==")
{
  P.resetPaces()
  const g = await gateway()
  const key = L.rateLimitKey(g.url, "k")
  L.storeRateLimit(key, 600) // an earlier run learned 600/min
  const notes = []
  await calls(g, 5, notes)
  ok("the stored limit is kept at first (~150ms apart)", gaps(g.st.times).every((x) => x >= 100), JSON.stringify(gaps(g.st.times)))
  ok(`after ${P.PACE_PROBE_EVERY} successes the pace is doubled`, P.paceFor({ baseUrl: g.url, apiKey: "k" })?.intervalMs === 100, JSON.stringify(P.paceFor({ baseUrl: g.url, apiKey: "k" })))
  ok("…said so", notes.some((p) => p.raised && p.perMinute === 1200) && /now spacing them to 1200 requests\/min/.test(P.paceText(notes.find((p) => p.raised))))
  ok("…and stored, so the next run starts there", L.storedRateLimit(key)?.perMinute === 1200)
  const before = g.st.times.length
  await calls(g, 5, notes)
  ok("a second streak: effectively unlimited, pacing stops", P.paceFor({ baseUrl: g.url, apiKey: "k" }) === null)
  ok("…the stored limit is forgotten", L.storedRateLimit(key) === null)
  ok("…said so", notes.some((p) => p.unpaced) && /no longer limits requests/.test(P.paceText(notes.find((p) => p.unpaced))))
  const t0 = Date.now()
  await calls(g, 5, notes)
  ok("…and requests are no longer spaced", Date.now() - t0 < 400, `${Date.now() - t0}ms for 5 requests`)
  ok("no request was refused along the way", g.st.limited === 0 && g.st.times.length === before + 10)
  await g.stop()
}

console.log("== 2. the limit did not change: one 429, then no more probing ==")
{
  P.resetPaces()
  const g = await gateway({ strictMs: 140 }) // really 600/min
  const key = L.rateLimitKey(g.url, "k")
  L.storeRateLimit(key, 600)
  const notes = []
  const done = await calls(g, 20, notes)
  ok("the calls all got through", done === 20)
  ok("the raised pace drew exactly one 429", g.st.limited === 1, `${g.st.limited} refused`)
  ok("…the provider's own limit is kept again", P.paceFor({ baseUrl: g.url, apiKey: "k" })?.intervalMs === 150 && L.storedRateLimit(key)?.perMinute === 600)
  ok("…and it was not raised again", notes.filter((p) => p.raised).length === 1)
  await g.stop()
}

console.log("== 3. a streamed answer counts as a success too ==")
{
  P.resetPaces()
  const g = await gateway({ stream: true })
  L.storeRateLimit(L.rateLimitKey(g.url, "k"), 600)
  const notes = []
  for (let i = 0; i < P.PACE_PROBE_EVERY; i++) for await (const _ of P.streamChat(opts(g.url, notes))) { /* drain */ }
  ok("a streak of streamed answers raises the pace", notes.some((p) => p.raised), JSON.stringify(notes))
  await g.stop()
}

console.log("== 4. no limit known: nothing changes ==")
{
  P.resetPaces()
  const g = await gateway()
  const notes = []
  await calls(g, 8, notes)
  ok("a provider with no stated limit is never paced or probed", notes.length === 0 && P.paceFor({ baseUrl: g.url, apiKey: "k" }) === null)
  await g.stop()
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== rate-limit-raised suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
