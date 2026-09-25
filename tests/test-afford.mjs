#!/usr/bin/env node
// v163 — a gateway that bills by the output ceiling.
//
// Reported from a real session: `forge agent` on SeekAI (an OpenAI-compatible
// New API gateway) failed at once with "provider HTTP 402: This request
// requires more credits, or fewer max_tokens. You requested up to N tokens,
// but can only afford M" — and /details cut the message before the numbers.
// On the OpenAI wire forge sent no max_tokens, so the gateway reserved the
// model's whole output ceiling against the balance. The 402 names what the
// account can pay for; forge now asks for that and retries.
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
const R = await import("../render.js")

const MSG = (afford, asked = 65536) => `This request requires more credits, or fewer max_tokens. You requested up to ${asked} tokens, but can only afford ${afford}. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account`

/**
 * A gateway: a request whose max_tokens is absent or above `afford` gets the
 * 402; anything else is answered. `afford` may be a function of the request
 * count (a balance that shrinks), and `noNumber` drops the amount.
 */
function gateway({ afford = 5241, ceiling = 65536, noNumber = false, stream = false, anthropic = false } = {}) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      seen.push({ url: req.url, max_tokens: j.max_tokens })
      const can = typeof afford === "function" ? afford(seen.length) : afford
      const asked = j.max_tokens ?? ceiling
      if (asked > can) {
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: noNumber ? "Insufficient credits. Add more using https://openrouter.ai/settings/credits" : MSG(can, asked), code: 402 } }))
      }
      if (anthropic) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "paid-for answer" }] }))
      }
      if (stream || j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "paid-for " } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "paid-for answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, seen, url: `http://127.0.0.1:${srv.address().port}`,
    stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }),
  })))
}

const ask = (g, extra = {}) => P.chatOnce({ protocol: "openai", baseUrl: g.url, apiKey: "k", model: "deepseek-ai/DeepSeek-V4-Flash-0731", providerName: "seekai", messages: [{ role: "user", content: "hi" }], ...extra })

// ── the message ────────────────────────────────────────────────────────────
ok("the affordable amount is read from the gateway's message", P.affordableFrom(MSG(5241)) === 5241)
ok("…and a 402 without one gives null", P.affordableFrom("Insufficient credits") === null && P.affordableFrom("") === null && P.affordableFrom(undefined) === null)

// ── chatOnce: the agent loop's path ────────────────────────────────────────
{
  P.resetOutputCaps()
  const g = await gateway()
  const notices = []
  const r = await ask(g, { onBudget: (b) => notices.push(b) })
  ok("a 402 naming what the account can afford is retried and answered", r?.content === "paid-for answer", JSON.stringify(r))
  ok("…the first request carried no max_tokens (the gateway reserved the ceiling)", g.seen[0]?.max_tokens === undefined, JSON.stringify(g.seen))
  ok("…the retry asks for 90% of the affordable amount", g.seen[1]?.max_tokens === Math.floor(5241 * 0.9), JSON.stringify(g.seen))
  ok("…and the person is told, once", notices.length === 1 && notices[0].affordable === 5241 && notices[0].maxTokens === 4716, JSON.stringify(notices))
  ok("…in words that say what happened", /covers 5241 output tokens/.test(P.budgetText(notices[0])) && /up to 4716/.test(P.budgetText(notices[0])))
  const again = await ask(g, { onBudget: (b) => notices.push(b) })
  ok("the next request goes straight out at the cap (no second 402)", again?.content === "paid-for answer" && g.seen.length === 3 && g.seen[2].max_tokens === 4716 && notices.length === 1, JSON.stringify(g.seen))
  await ask(g, { maxTokens: 500 })
  ok("a caller asking for less keeps its own max_tokens", g.seen[3]?.max_tokens === 500, JSON.stringify(g.seen[3]))
  ok("the cap is kept per provider and model", P.outputCapFor({ baseUrl: g.url, model: "deepseek-ai/DeepSeek-V4-Flash-0731" }) === 4716 && P.outputCapFor({ baseUrl: g.url, model: "other" }) === null)
  await g.stop()
}

{
  // the balance shrinks between requests: each new amount lowers the cap again
  P.resetOutputCaps()
  const g = await gateway({ afford: (n) => (n <= 2 ? 5000 : 2000) })
  await ask(g)
  const r = await ask(g)
  ok("a balance that shrinks lowers the cap again", r?.content === "paid-for answer" && g.seen.map((x) => x.max_tokens).join(",") === ",4500,4500,1800", JSON.stringify(g.seen))
  await g.stop()
}

{
  P.resetOutputCaps()
  const g = await gateway({ afford: 300 })
  let err = null
  try { await ask(g) } catch (e) { err = e }
  ok("too little to work with is not retried", err && g.seen.length === 1, `${g.seen.length} requests`)
  ok("…and the error says so and says to top up", /300 output tokens left, too few to work with\); top up/.test(String(err?.message)) && /seekai\.cc\/console\/token/.test(String(err?.message)), String(err?.message))
  ok("…FIRST, before the provider's own sentence (v165: the card cut it off)", /^provider HTTP 402 — out of credits on seekai .*top up \([^)]*\): This request requires more credits/.test(String(err?.message)), String(err?.message))
  ok("…with the amount on the error", err?.affordableTokens === 300 && err?.status === 402)
  await g.stop()
}

{
  P.resetOutputCaps()
  const g = await gateway({ noNumber: true })
  let err = null
  try { await ask(g) } catch (e) { err = e }
  ok("a 402 that names no amount is not retried", err && g.seen.length === 1 && err.affordableTokens === null, `${g.seen.length} requests`)
  ok("…and still says what to do, first", /^provider HTTP 402 — out of credits on seekai; top up \(https:\/\/seekai\.cc\/console\/token\): Insufficient credits/.test(String(err?.message)), String(err?.message))
  await g.stop()
}

{
  // a gateway that keeps refusing the same amount must not loop
  P.resetOutputCaps()
  const g = await gateway({ afford: 5241 })
  const srv2 = http.createServer((req, res) => { req.resume(); req.on("end", () => { g.seen.push({}); res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: MSG(5241) } })) }) })
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv2.address().port}`
  let err = null
  try { await ask({ url }) } catch (e) { err = e }
  const n1 = g.seen.length
  try { await ask({ url }) } catch (e) { err = e }
  ok("a gateway refusing even the affordable amount fails, without looping", err?.status === 402 && n1 === 2 && g.seen.length === 3, `requests ${n1} then ${g.seen.length}`)
  await new Promise((q) => { srv2.closeAllConnections?.(); srv2.close(q) })
  await g.stop()
}

// ── the other protocol and the streaming path ──────────────────────────────
{
  P.resetOutputCaps()
  const g = await gateway({ anthropic: true, afford: 5000 })
  const r = await P.chatOnce({ protocol: "anthropic", baseUrl: g.url, apiKey: "k", model: "claude-x", messages: [{ role: "user", content: "hi" }] })
  ok("the Anthropic wire (8192 by default) is lowered the same way", r?.content === "paid-for answer" && g.seen[0].max_tokens === 8192 && g.seen[1].max_tokens === 4500, JSON.stringify(g.seen))
  await g.stop()
}

{
  P.resetOutputCaps()
  const g = await gateway({ stream: true })
  const notices = []
  let text = ""
  for await (const ev of P.streamChatResilient({ protocol: "openai", baseUrl: g.url, apiKey: "k", model: "m", providerName: "seekai", messages: [{ role: "user", content: "hi" }], maxTokens: 8192, onBudget: (b) => notices.push(b) }, { attempts: 1 })) {
    if (ev.type === "text") text += ev.text
  }
  ok("chat's streaming path is lowered and retried too", text === "paid-for answer" && g.seen[0].max_tokens === 8192 && g.seen[1].max_tokens === 4716 && notices.length === 1, `${JSON.stringify(text)} ${JSON.stringify(g.seen)}`)
  await g.stop()
}

// ── /details shows the whole message ───────────────────────────────────────
{
  const o = R.renderOptions({ color: false })
  const summary = `provider HTTP 402: ${MSG(212)} — credits nearly exhausted on seekai (212 output tokens left, too few to work with); top up.`
  const rows = R.renderErrorBlock({ title: "TASK FAILED", summary }, 80, o)
  const flat = rows.join(" ").replace(/\s+/g, " ")
  ok("/details wraps the error instead of cutting it", /can only afford 212/.test(flat) && /top up/.test(flat) && rows.length > 4, rows.join("\n"))
  ok("…and no row is wider than the terminal", rows.every((r) => R.displayWidth ? R.displayWidth(r) <= 79 : r.length <= 79), rows.map((r) => r.length).join(","))
}

// ── end to end: the reported session ───────────────────────────────────────
{
  P.resetOutputCaps()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-afford-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  const g = await gateway({ afford: 3000 })
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai",
    "--model", "deepseek-ai/DeepSeek-V4-Flash-0731", "--base-url", g.url, "--max-steps", "3", "--", "do you know yourself and your abilities?"],
  { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
  let so = "", se = ""
  child.stdout.on("data", (d) => { so += d })
  child.stderr.on("data", (d) => { se += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 60000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  const all = so + se
  ok("a real `forge agent --provider seekai` run on a low balance completes", code === 0 && /paid-for answer/.test(all), `exit ${code}; ${all.slice(-400)}`)
  ok("…its first request hit the 402 and the retry asked for what the account covers", g.seen[0]?.max_tokens === undefined && g.seen[1]?.max_tokens === 2700, JSON.stringify(g.seen.slice(0, 3)))
  ok("…and the run said so", /balance covers 3000 output tokens/.test(all), all.slice(-600))
  await g.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n== afford suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
