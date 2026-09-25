#!/usr/bin/env node
// v180 — what a provider said reaches the person, whole; and a one-shot run
// out of credits is told what it can run next.
//
// Reported: a seekai 400 ended a run with the card row
//   Reason   provider HTTP 400: Resource error. Error message: {"error":{"message…
// The gateway had wrapped the upstream's JSON inside its own message; forge
// kept the envelope, and the card cut the row at the terminal width — exactly
// where the reason began. And a one-shot `forge agent` run out of credits
// said "top up, then /retry": a chat command that does not exist there.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-errshown-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const P = await import("../providers.js")
const R = await import("../render.js")

const INNER = "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 30512 `inputs` tokens and 8192 `max_new_tokens`"
const WRAPPED = JSON.stringify({ error: { message: `Resource error. Error message: ${JSON.stringify({ error: { message: INNER, type: "validation" } })}` } })

console.log("== 1. the provider's own sentence, not the envelope ==")
{
  ok("a gateway's wrapped upstream error is unwrapped, prefix kept", P.providerMessage(WRAPPED) === `Resource error. ${INNER}`, P.providerMessage(WRAPPED))
  ok("a plain error message is unchanged", P.providerMessage(JSON.stringify({ error: { message: "model not found" } })) === "model not found")
  ok("text that is not JSON is unchanged", P.providerMessage("Bad Gateway") === "Bad Gateway")
  ok("FastAPI-style { detail } is read", P.providerMessage(JSON.stringify({ detail: "missing field" })) === "missing field")
  ok("three levels deep", P.providerMessage(JSON.stringify({ error: { message: "Upstream: " + JSON.stringify({ error: { message: JSON.stringify({ message: "deepest" }) } }) } })) === "Upstream: deepest")
  ok("braces that are not JSON stay as written", P.providerMessage(JSON.stringify({ error: { message: "bad {placeholder} in prompt" } })) === "bad {placeholder} in prompt")
  ok("bounded", P.providerMessage("x".repeat(5000)).length === 600)
  const be = P.bodyError(JSON.parse(WRAPPED), "seekai")
  ok("an error sent with HTTP 200 is unwrapped too", be?.message?.includes(INNER) && !be.message.includes('{"error"'), be?.message)
}

console.log("== 2. through the real provider layer ==")
{
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(400, { "content-type": "application/json" }); res.end(WRAPPED) }) })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let err = null
  try { await P.chatOnce({ protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] }) } catch (e) { err = e }
  srv.close()
  ok("a 400 from a gateway reads as the upstream's reason", /^provider HTTP 400: Resource error\. Input validation error/.test(String(err?.message)) && !String(err?.message).includes('{"error"'), String(err?.message).slice(0, 200))
}

console.log("== 3. the failure card shows it whole ==")
{
  const o = { th: new Proxy({}, { get: () => (x) => x }), sym: { dot: "·", ell: "…" }, ascii: false }
  const reason = `provider HTTP 400: Resource error. ${INNER}`
  const card = R.renderFailure({ reason, files: 0, next: "/details for diagnostics, then /retry" }, 80, o)
  const text = card.join("\n")
  const reasonRows = card.slice(card.findIndex((l) => l.includes("Reason")), card.findIndex((l) => l.includes("Changes")))
  ok("the reason wraps onto more rows instead of being cut", reasonRows.length >= 2 && reasonRows.join(" ").replace(/\s+/g, " ").includes("8192 `max_new_tokens`"), text)
  ok("…every row fits the terminal", card.every((l) => l.length <= 80), card.map((l) => l.length).join(","))
  ok("…continuation rows line up under the value", reasonRows.slice(1).every((l) => /^ {15}\S/.test(l)))
  const huge = R.renderFailure({ reason: "word ".repeat(400), files: 0 }, 60, o)
  const hugeRows = huge.slice(huge.findIndex((l) => l.includes("Reason")), huge.findIndex((l) => l.includes("Changes")))
  ok(`a runaway message stops at ${R.FAILURE_WRAP_ROWS} rows, marked`, hugeRows.length === R.FAILURE_WRAP_ROWS && /…$/.test(hugeRows.at(-1)), `${hugeRows.length} rows`)
}

console.log("== 4. out of credits: the next step belongs to the surface ==")
{
  ok("the provider's message no longer names a chat command", !/\/retry/.test(P.outOfCredits("seekai", null)) && /^out of credits on seekai; top up/.test(P.outOfCredits("seekai", null)), P.outOfCredits("seekai", null))
  const cfg = { providers: { openrouter: { apiKey: "x", baseUrl: "https://openrouter.ai/api/v1" }, backup: { apiKey: "b" } } }
  const active = { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash" }
  const one = P.outOfCreditsOptions(cfg, active, {}, { oneShot: true, task: "count the files" })
  ok("one-shot: the command that re-runs the task on a free model", /forge agent --model [\w./-]+:free "count the files"/.test(one), one)
  ok("…or on the provider that is set up", /forge agent --provider backup "count the files"/.test(one))
  ok("…and how to fail over by itself next time — never a chat command", /forge config set failover true/.test(one) && !/\/retry|\/provider|\/model /.test(one))
  const chat = P.outOfCreditsOptions(cfg, active, {})
  ok("chat keeps its own words (/model, /provider, then /retry)", /\/model .*:free/.test(chat) && /\/provider backup/.test(chat) && /\/retry continues/.test(chat))
}

/** A one-shot `forge agent` against a provider that is out of credits. */
async function oneShot(tty) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-oneshot402-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: 402, message: "This request would exceed your available credits." } })) }) })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" }, backup: { protocol: "openai", baseUrl: "https://backup.example/v1", apiKey: "b", model: "b" } }, tools: { assumeYes: true }, skills: { enabled: false } }))
  const args = [path.join(ROOT, "forge.js"), "agent", "count the files"]
  const child = tty
    ? spawn("script", ["-qfec", `${JSON.stringify(process.execPath)} ${args.map((a) => JSON.stringify(a)).join(" ")}`, "/dev/null"], { cwd: work, env: { ...process.env, HOME: home, FORGE_HOME: home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "100", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, args, { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 60000); child.on("exit", (c) => { clearTimeout(t); r(c) }) })
  srv.closeAllConnections?.(); srv.close()
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, out: out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ") }
}

console.log("== 5. a real one-shot run, piped and in a terminal ==")
{
  const piped = await oneShot(false)
  ok("piped: the run names the command that re-runs it on the other provider", /forge agent --provider backup "count the files"/.test(piped.out), piped.out.slice(-400))
  ok("…never a chat command", !/\/retry|\/provider\b/.test(piped.out))
  ok("…and still fails (exit 1)", piped.code === 1)
  const term = await oneShot(true)
  ok("terminal: the card is followed by the same command", /TASK FAILED/.test(term.out) && /forge agent --provider backup "count the files"/.test(term.out), term.out.slice(-500))
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== provider-errors-shown suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
