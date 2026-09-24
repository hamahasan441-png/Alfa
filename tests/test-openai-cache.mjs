#!/usr/bin/env node
/**
 * forge v153 — OpenAI-protocol runs report their cache reads.
 *
 * A TODO note said the OpenAI-protocol path "returns none of these fields …
 * and always will". Checked against primary sources, that was wrong:
 *   - OpenAI's OpenAPI spec (CompletionUsage) gives Chat Completions usage
 *     `prompt_tokens_details.cached_tokens`;
 *   - DeepSeek documents `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
 * forge dropped both, so every OpenAI, DeepSeek or OpenRouter run said its
 * cache was "unknown" — in cacheHealth and in a Terminal-Bench report.
 *
 * The part that must not be papered over: these providers report cache READS
 * but not WRITES. A write count of 0 would be a claim, not a measurement, and
 * the Anthropic diagnoses built on writes (and on Anthropic's per-model
 * minimums) would misread every OpenAI run.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const { normalizeOpenAIUsage: n, cacheHealth } = await import("../providers.js")

console.log("== the two shapes ==")
{
  const oai = n({ prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220, prompt_tokens_details: { cached_tokens: 1024 } })
  eq("OpenAI: cached_tokens are the cache reads", oai.cache_read_tokens, 1024)
  eq("…the rest of the prompt is uncached", oai.uncached_tokens, 176)
  eq("…prompt_tokens stays the TOTAL (it already includes the cached part)", oai.prompt_tokens, 1200)
  eq("…completion untouched", oai.completion_tokens, 20)
  eq("…other fields kept (total_tokens)", oai.total_tokens, 1220)
  eq("…and writes are marked as not reported", oai.cache_writes_reported, false)
  ok("…never a write count — 0 would be a claim", !("cache_write_tokens" in oai))

  const ds = n({ prompt_tokens: 900, completion_tokens: 5, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 300 })
  eq("DeepSeek: prompt_cache_hit_tokens are the cache reads", [ds.cache_read_tokens, ds.uncached_tokens, ds.cache_writes_reported], [600, 300, false])

  const both = n({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 40 }, prompt_cache_hit_tokens: 70 })
  eq("both present: the OpenAI field is used", both.cache_read_tokens, 40)

  const zero = n({ prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } })
  eq("a reported 0 is a real 0 — the provider said nothing was read", [zero.cache_read_tokens, zero.uncached_tokens], [0, 50])
}

console.log("== what is not trusted ==")
{
  const none = n({ prompt_tokens: 100, completion_tokens: 3 })
  ok("no cache field: nothing is invented", !("cache_read_tokens" in none) && !("cache_writes_reported" in none))
  eq("…and the rest is as it was", [none.prompt_tokens, none.completion_tokens], [100, 3])
  for (const [bad, why] of [["40", "a string"], [-1, "negative"], [4.5, "not an integer"], [200, "more than the prompt"]]) {
    const r = n({ prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: bad } })
    ok(`cached = ${JSON.stringify(bad)} (${why}) is dropped, not trusted`, !("cache_read_tokens" in r) && r.prompt_tokens === 100 && r.completion_tokens === 3)
  }
  const noPrompt = n({ completion_tokens: 3, prompt_tokens_details: { cached_tokens: 10 } })
  ok("a cached count with no prompt total to break down is dropped", !("cache_read_tokens" in noPrompt))
  // This path never validated prompt/completion, and some compatible
  // providers are loose: the fix must not start rejecting them.
  const loose = n({ prompt_tokens: "120", completion_tokens: "7" })
  eq("loose prompt/completion values pass through exactly as before", [loose.prompt_tokens, loose.completion_tokens], ["120", "7"])
  eq("no usage stays no usage", n(undefined), undefined)
}

console.log("== cacheHealth does not diagnose what it cannot see ==")
{
  const base = { steps: 5, read: 0, written: 0, uncached: 900, sawCacheFields: true, model: "gpt-5" }
  const unread = cacheHealth({ ...base, writesReported: false })
  eq("no reads after 5 steps, writes unreported: 'unread'", unread.state, "unread")
  ok("…and it says why it cannot say more", /reads but not writes/.test(unread.why), unread.why)
  // What the Anthropic reasoning says about the same counters — wrong for
  // OpenAI, whose threshold is not in that table.
  eq("(the Anthropic reasoning on the same counters says 'too-small')", cacheHealth(base).state, "too-small")
  eq("reads reported: ok, as for anyone", cacheHealth({ ...base, read: 512, writesReported: false }).state, "ok")
  eq("early steps: cold, as for anyone", cacheHealth({ ...base, steps: 1, writesReported: false }).state, "cold")
  // Anthropic is unchanged.
  eq("Anthropic writes-but-no-reads is still 'never-read'", cacheHealth({ steps: 5, read: 0, written: 3000, uncached: 100, sawCacheFields: true }).state, "never-read")
}

console.log("== both OpenAI sites use it ==")
{
  const src = fs.readFileSync(path.join(ROOT, "providers.js"), "utf8")
  ok("streamed usage", /evs\.push\(\{ type: "usage", usage: normalizeOpenAIUsage\(j\.usage\) \}\)/.test(src))
  ok("non-streamed usage", /usage: normalizeOpenAIUsage\(j\?\.usage\),/.test(src))
  const agent = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("the agent carries 'writes unreported' into the health window", /u\.cache_writes_reported === false\) \{ cacheWindow\.writesReported = false/.test(agent))
}

console.log("== end to end: a real headless run ==")
{
  // The agent's model call on this protocol is not streamed, so this covers
  // the non-streamed site; the streamed one is exercised directly below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-oai-cache-t-"))
  const usage = { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220, prompt_tokens_details: { cached_tokens: 1024 } }
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Nothing to change; done." }, finish_reason: "stop" }], usage }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  fs.mkdirSync(path.join(dir, "home")); fs.mkdirSync(path.join(dir, "work"))
  const res = path.join(dir, "r.json")
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "openai", "--model", "stub",
    "--base-url", `http://127.0.0.1:${srv.address().port}/v1`, "--max-steps", "4", "--result-json", res, "--", "say done"], {
    cwd: path.join(dir, "work"), env: { PATH: process.env.PATH, HOME: path.join(dir, "home"), OPENAI_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore",
  })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 30000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  await new Promise((r) => srv.close(r))
  const j = JSON.parse(fs.readFileSync(res, "utf8"))
  eq("the run completes", code, 0)
  eq("cache reads reported in the result", j.usage?.cacheReadTokens, 1024)
  eq("cache writes: null — unreported, not zero", j.usage?.cacheWriteTokens, null)
  eq("input is the prompt total", j.usage?.inputTokens, 1200)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log("== the streamed site (chat), exercised directly ==")
{
  const { streamChat } = await import("../providers.js")
  const usage = { prompt_tokens: 800, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 768 } }
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let got = null
  try {
    for await (const ev of streamChat({ protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "stub", messages: [{ role: "user", content: "hi" }], allowPrivate: true })) {
      if (ev.type === "usage") got = ev.usage
    }
  } catch (e) { got = { error: e.message } }
  await new Promise((r) => srv.close(r))
  eq("a streamed usage event carries the cache reads", got?.cache_read_tokens, 768)
  eq("…and says writes are unreported", got?.cache_writes_reported, false)
}

console.log(`\n== openai-cache suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
