#!/usr/bin/env node
/**
 * forge — Ctrl+C must not wait out a retry backoff (v124).
 *
 * Both retry loops on the hot path slept with a bare
 * `new Promise((r) => setTimeout(r, wait))`. The REQUEST was abortable; the
 * wait between requests was not — and in both places the abort signal was
 * already in scope, used a line or two above. So a cancel landing during a
 * backoff sat there until the timer expired:
 *
 *   providers.streamChatResilient  wait = max(backoffMs × attempt, Retry-After)
 *                                  Retry-After is honoured up to 60s
 *   agent loop                     wait = min(60000, max(2000 × n, Retry-After))
 *
 * Measured against a local server answering 429 with `Retry-After: 5`: abort
 * fired at 300ms, the loop exited at **8047ms**. The agent loop clamps at 60s,
 * so its worst case is a cancelled run holding the terminal for a minute.
 *
 * This suite is the measurement, kept. It does not read the source and hope —
 * it stands up a provider that always rate-limits, aborts mid-backoff, and
 * asserts on the clock. A regression here shows up as elapsed time, which is
 * the only thing a user would notice.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-abort-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 200) : ""}`) }
}

const { sleepAbortable } = await import("../retry-policy.js")
const { streamChatResilient } = await import("../providers.js")

console.log("== sleepAbortable: resolves on whichever comes first ==")
{
  let t0 = Date.now()
  await sleepAbortable(120)
  const slept = Date.now() - t0
  ok(`without a signal it still waits (${slept}ms)`, slept >= 100, `${slept}ms`)

  const c = new AbortController()
  t0 = Date.now()
  setTimeout(() => c.abort(new Error("cancel")), 50)
  await sleepAbortable(5000, c.signal)
  const cut = Date.now() - t0
  ok(`an abort cuts a 5000ms wait short (${cut}ms)`, cut < 1000, `${cut}ms`)

  const already = new AbortController()
  already.abort()
  t0 = Date.now()
  await sleepAbortable(5000, already.signal)
  ok(`an already-aborted signal returns immediately (${Date.now() - t0}ms)`, Date.now() - t0 < 200)

  // a retry loop calls this repeatedly: it must not leak a listener per attempt
  const leak = new AbortController()
  const before = leak.signal.listenerCount?.("abort") ?? 0
  for (let i = 0; i < 25; i++) await sleepAbortable(1, leak.signal)
  const after = leak.signal.listenerCount?.("abort") ?? 0
  ok(`25 waits leak no abort listeners (${before} → ${after})`, after <= before + 1, `${before} → ${after}`)

  // total: hostile input must not throw inside a retry loop
  for (const [ms, sig] of [[-1, null], [NaN, null], ["x", null], [null, null], [10, {}], [10, "nope"]]) {
    let threw = false
    try { await sleepAbortable(ms, sig) } catch { threw = true }
    ok(`sleepAbortable(${JSON.stringify(ms)}, ${JSON.stringify(sig)}) does not throw`, threw === false)
  }
}

console.log("== the real retry loop exits when the user cancels ==")
{
  // a provider that always rate-limits, with a Retry-After the loop honours
  const server = http.createServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "5" })
    res.end(JSON.stringify({ error: { message: "rate limited" } }))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(new Error("user pressed Ctrl+C")), 300)
  const t0 = Date.now()
  let threw = false
  try {
    for await (const _ of streamChatResilient(
      { protocol: "openai", baseUrl, apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], signal: ctrl.signal },
      { attempts: 3, backoffMs: 1500 })) { /* drain */ }
  } catch { threw = true }
  const ms = Date.now() - t0

  // the bound IS the assertion: before the fix this measured 8047ms
  ok(`the loop exits promptly after the abort (${ms}ms, was 8047ms)`, ms < 2000, `${ms}ms`)
  ok("…and surfaces the failure rather than returning success", threw)
  server.close()
}

console.log("== an UNABORTED retry still backs off and still retries ==")
{
  // the fix must not have turned the backoff into a no-op
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
    res.end(JSON.stringify({ error: { message: "rate limited" } }))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

  const t0 = Date.now()
  let threw = false
  try {
    for await (const _ of streamChatResilient(
      { protocol: "openai", baseUrl, apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] },
      { attempts: 3, backoffMs: 150 })) { /* drain */ }
  } catch { threw = true }
  const ms = Date.now() - t0

  ok(`all 3 attempts were made (${hits} requests)`, hits === 3, String(hits))
  ok("…and the exhausted loop throws", threw)
  ok(`…having actually waited between them (${ms}ms >= 150+300)`, ms >= 400, `${ms}ms`)
  server.close()
}

console.log("== neither hot-path retry sleeps unabortably any more ==")
{
  const prov = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")

  const resilient = prov.slice(prov.indexOf("export async function* streamChatResilient"))
    .slice(0, 1800)
  ok("providers: the backoff is abortable", /await sleepAbortable\(wait, opts\?\.signal\)/.test(resilient))
  ok("providers: and it stops retrying once aborted", /if \(opts\?\.signal\?\.aborted\) throw e/.test(resilient))
  ok("providers: no bare setTimeout sleep remains in the loop",
    !/await new Promise\(\(r\) => setTimeout\(r, wait\)\)/.test(resilient))

  ok("agent: the 60s-clamped backoff is abortable",
    /await sleepAbortable\(Math\.min\(60000, wait\), signal\)/.test(agent))
  ok("agent: and it stops retrying once aborted",
    // v166: the same error, now carrying the run's conversation for /retry
    /await sleepAbortable\(Math\.min\(60000, wait\), signal\)\s*\n\s*if \(signal\?\.aborted\) throw (?:e\b|withContinuation\(e\))/.test(agent))
  ok("agent: no bare setTimeout sleep remains in the retry branch",
    !/await new Promise\(\(r\) => setTimeout\(r, Math\.min\(60000, wait\)\)\)/.test(agent))

  // the crawl poll loop: the abort check between polls only catches a cancel
  // that lands BETWEEN them, so the 2s wait itself had to become abortable too
  const search = fs.readFileSync(new URL("../searchproviders.js", import.meta.url), "utf8")
  ok("searchproviders: the crawl poll wait is abortable",
    /await sleepAbortable\(pollMs, signal\)/.test(search))
  ok("searchproviders: and it rechecks the signal after waiting",
    /await sleepAbortable\(pollMs, signal\)\s*\n\s*if \(signal\?\.aborted\) throw new ProviderFailure/.test(search))

  // one implementation, per §36 — not a third private copy
  const rp = fs.readFileSync(new URL("../retry-policy.js", import.meta.url), "utf8")
  ok("sleepAbortable lives in the module that owns backoff", /export function sleepAbortable/.test(rp))
  for (const [f, src] of [["providers.js", prov], ["agent.js", agent], ["searchproviders.js", search]]) {
    ok(`${f} imports it rather than redefining it`,
      /import \{ sleepAbortable \} from "\.\/retry-policy\.js"/.test(src) && !/function sleepAbortable/.test(src))
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== harness-abort suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
