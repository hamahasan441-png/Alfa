#!/usr/bin/env node
// v175 — "retry" without the slash, and what to do when credits run out.
//
// Reported from a real session: an agent run ended "provider HTTP 402 — out
// of credits on openrouter"; the person typed `retry`. In Agent Mode every
// line is a task, so that became a NEW task named "retry" — built from the
// conversation's goal and started over, instead of continuing the run that
// stopped. And the failure card's way forward read, in the UI, just "top up".
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
const C = await import("../chat.js")
const P = await import("../providers.js")

console.log("== 1. which lines mean retry ==")
{
  for (const w of ["retry", "Retry.", "try again", "continue", "please retry", "retry it", "go on!", "resume", "keep going"]) ok(`"${w}" asks to retry`, C.isRetryWord(w))
  for (const w of ["retry the build with node 20", "continue with the tests", "why did it fail?", "", "retrying is pointless"]) ok(`"${w}" is its own request`, !C.isRetryWord(w))
}

console.log("== 2. out of credits: the concrete ways forward ==")
{
  const cfg = { providers: { openrouter: { apiKey: "x", baseUrl: "https://openrouter.ai/api/v1" }, groq: { apiKey: "g" }, ollama: { baseUrl: "http://localhost:11434/v1" }, nokey: { baseUrl: "https://example.com/v1" } } }
  const t = P.outOfCreditsOptions(cfg, { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash" }, {})
  ok("on OpenRouter it names a free model to switch to", /\/model [\w./-]+:free/.test(t), t)
  ok("…and the other providers set up (a key, or a local server)", /\/provider groq \(or ollama\)/.test(t), t)
  ok("…never one without a key", !/nokey/.test(t))
  ok("…and says /retry continues after switching", /\/retry continues from where it stopped/.test(t))
  const onFree = P.outOfCreditsOptions({ providers: {} }, { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "x/y:free" }, {})
  ok("already on a free model: nothing to suggest", onFree === "")
  const envKeyed = P.outOfCreditsOptions({ providers: {} }, { name: "a", baseUrl: "https://a", model: "m" }, { GROQ_API_KEY: "k" })
  ok("a provider keyed only in the environment counts", /\/provider groq/.test(envKeyed), envKeyed)
  ok("nothing else set up: nothing to suggest", P.outOfCreditsOptions({ providers: { a: { apiKey: "k" } } }, { name: "a", baseUrl: "https://a", model: "m" }, {}) === "")
  ok("the chat recognises an out-of-credits failure", C.OUT_OF_CREDITS.test("provider HTTP 402: This request would exceed your available credits") && !C.OUT_OF_CREDITS.test("provider HTTP 429: slow down"))
}

/** A model: a bash call per agent run (counted on disk), a 402 until topped up. */
function model() {
  const st = { credits: 0, calls: [] }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const agent = /autonomous terminal coding agent/.test(system)
      const hasResult = (j.messages ?? []).some((m) => m.role === "tool")
      const text = JSON.stringify(j.messages ?? [])
      st.calls.push({ agent, hasResult, text })
      if (agent && hasResult && st.credits <= 0) {
        st.credits = 10 // "topped up" once the first 402 has been seen
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 402, message: "This request would exceed your available credits." } }))
      }
      const msg = agent && !hasResult
        ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo RAN >> count.txt; echo STEP-ONE-OUTPUT" }) } }] }
        : { role: "assistant", content: agent ? "DONE-CONTINUED" : "CHAT-REPLY" }
      if (j.stream && !msg.tool_calls) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
function setup(m, extraProviders = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retryword-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retryword-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "m" }, ...extraProviders }, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 4 }, skills: { enabled: false } }))
  return { home, work }
}
const session = ({ home, work }, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  child.stdin.write(input); child.stdin.end()
  const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "timeout", out }) }, 60000)
  child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
})
const lines = (work) => { try { return fs.readFileSync(path.join(work, "count.txt"), "utf8").trim().split("\n").length } catch { return 0 } }
const cleanup = (env) => { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true }) }

console.log("== 3. Agent Mode: the run stops on a 402, the person types `retry` ==")
{
  const m = await model()
  const env = setup(m, { backup: { protocol: "openai", baseUrl: "https://backup.example/v1", apiKey: "b", model: "b" } })
  const r = await session(env, "/agent\ncount once\nretry\n/exit\n")
  const agentCalls = m.st.calls.filter((c) => c.agent)
  const last = agentCalls.at(-1)?.text ?? ""
  ok("`retry` continues the stopped run (same as /retry)", /"retry" continues the stopped run \(same as \/retry\)/.test(r.out), r.out.slice(-600))
  ok("…from where it stopped: the request carries the earlier result", /CONTINUES an earlier attempt/.test(last) && /STEP-ONE-OUTPUT/.test(last))
  ok("…not a new task named \"retry\"", !agentCalls.some((c) => /"content":"retry"/.test(c.text)))
  ok("…the step was not run again, and the run finished", lines(env.work) === 1 && /DONE-CONTINUED/.test(r.out), `count.txt ${lines(env.work)}; ${r.out.slice(-200)}`)
  ok("after the 402, the chat names the other provider set up", /out of credits on stub — to keep going without topping up: \/provider backup/.test(r.out), r.out.split("\n").filter((l) => /credits/.test(l)).join(" | "))
  await m.stop(); cleanup(env)
}

console.log("== 4. `retry` is only /retry while a stopped run is waiting ==")
{
  const m = await model()
  const env = setup(m)
  // after the stop, a chat turn is said: `retry` is about that turn now
  const r = await session(env, "/agent count once\nhello there\nretry\n/exit\n")
  ok("once the person has chatted since, `retry` is not taken as /retry of the run", !/continues the stopped run/.test(r.out), r.out.slice(-400))
  ok("…and the stopped run did not continue", lines(env.work) === 1 && !/DONE-CONTINUED/.test(r.out))
  await m.stop(); cleanup(env)
  // a longer line that starts with "retry" is its own request
  const m2 = await model()
  const env2 = setup(m2)
  const r2 = await session(env2, "/agent count once\nretry the build with node 20\n/exit\n")
  ok("\"retry the build with node 20\" is its own request, not /retry", !/continues the stopped run/.test(r2.out))
  await m2.stop(); cleanup(env2)
}

console.log("== 5. the full-screen UI, as reported: Agent Mode, a 402, then `retry` ==")
{
  const m = await model()
  const env = setup(m, { backup: { protocol: "openai", baseUrl: "https://backup.example/v1", apiKey: "b", model: "b" } })
  fs.writeFileSync(path.join(env.home, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(env.home, "config.json"), "utf8")), agent: { maxSteps: 4 } }))
  const out = await new Promise((resolve) => {
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: env.work, env: { ...process.env, FORGE_HOME: env.home, HOME: env.home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
    let o = ""
    const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    child.stdout.on("data", (d) => { o += clean(d) })
    const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(o) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(o) }
    const settle = async () => { for (let last = -1; last !== o.length;) { last = o.length; await new Promise((r) => setTimeout(r, 500)) } }
    ;(async () => {
      await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
      for (const [line, waitFor] of [["/agent", /Agent Mode active/], ["count once", /TASK FAILED/], ["retry", /DONE-CONTINUED|TASK FAILED[\s\S]*TASK FAILED/]]) { child.stdin.write(`${line}\r`); if (waitFor) await until(waitFor); await settle() }
      child.stdin.write("/exit\r")
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(o) }, 8000)
      child.on("exit", () => { clearTimeout(t); resolve(o) })
    })()
  })
  const flat = out.replace(/\s+/g, " ")
  ok("the full-screen UI names the other provider after the 402", /to keep going without topping up: \/provider backup/.test(flat), flat.slice(-700))
  ok("…`retry` continues the run instead of starting a task named \"retry\"", /continues the stopped run/.test(flat) && /continuing from step \d+/.test(flat), flat.slice(-500))
  ok("…and the step ran once", lines(env.work) === 1, `count.txt: ${lines(env.work)} line(s)`)
  await m.stop(); cleanup(env)
}

console.log(`== retry-word suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
