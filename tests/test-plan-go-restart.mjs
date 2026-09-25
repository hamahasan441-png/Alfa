#!/usr/bin/env node
// v178 — `/plan go` starts the plan made before a chat restart.
//
// v164's /plan makes a plan from the conversation and `/plan go` starts it —
// but the waiting plan lived only in the chat process. Quit and come back
// with `forge chat --continue`: the plan was in the session history and on
// disk, and `/plan go` said "no plan to start". Now the waiting plan is saved
// with the session, restored with it, and said so.
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

console.log("== 1. what is restored ==")
{
  const pp = C.restorePendingPlan({ pendingPlan: { objective: "build a CSV converter", plan: "1. do it", facts: ["streams"] } })
  ok("a saved plan comes back", pp?.objective === "build a CSV converter" && pp.plan === "1. do it" && pp.facts[0] === "streams")
  ok("…and says how to start it", /a plan is waiting here: "build a CSV converter" — \/plan go starts it/.test(C.pendingPlanNotice(pp)), C.pendingPlanNotice(pp))
  ok("no plan, an empty plan or a malformed one restores nothing", C.restorePendingPlan({}) === null && C.restorePendingPlan({ pendingPlan: { objective: "x", plan: "  " } }) === null && C.restorePendingPlan({ pendingPlan: { plan: "1." } }) === null)
}

/** A model: a plan for plan-mode requests, "Done." for runs, "Noted." for chat. */
function model() {
  const st = { plans: 0, runs: [], chats: 0 }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const text = (j.messages ?? []).map((m) => String(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n")
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const isPlan = /PLAN MODE/.test(system)
      const isRun = !isPlan && /autonomous terminal coding agent/.test(system)
      if (isPlan) st.plans++
      else if (isRun) st.runs.push(text)
      else st.chats++
      if (isRun && st.holdRuns) return // never answered: the run is still going when the terminal closes
      const reply = isPlan ? "1. Create convert.js streaming rows (PLAN-MARK-8080)\n2. Verify with a sample file\nEND OF PLAN" : isRun ? "Done." : "Noted."
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
function setup(m) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plango-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plango-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 2 }, skills: { enabled: false } }))
  return { home, work }
}
const session = ({ home, work }, args, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  child.stdin.write(input); child.stdin.end()
  const t = setTimeout(() => { child.kill("SIGKILL"); resolve(out) }, 60000)
  child.on("exit", () => { clearTimeout(t); resolve(out) })
})
const sessions = (home) => { const dir = path.join(home, "sessions"); try { return fs.readdirSync(dir).filter((x) => /^[\w-]+\.json$/.test(x) && x !== "last.json").map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).sort((a, b) => a.createdAt - b.createdAt) } catch { return [] } }
const cleanup = (env) => { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true }) }
const MAKE = "I need a CSV to JSON converter that streams rows\n/plan\n/exit\n"

console.log("== 2. plan, quit, come back, /plan go ==")
{
  const m = await model()
  const env = setup(m)
  const first = await session(env, ["chat"], MAKE)
  ok("the first chat made a plan and kept it for /plan go", m.st.plans === 1 && /start it with \/plan go/.test(first), first.slice(-300))
  ok("the session saves the waiting plan", /PLAN-MARK-8080/.test(sessions(env.home)[0]?.pendingPlan?.plan ?? ""), JSON.stringify(sessions(env.home)[0]?.pendingPlan ?? null).slice(0, 120))
  const second = await session(env, ["chat", "--continue"], "/plan go\n/exit\n")
  ok("the restarted chat says a plan is waiting", /a plan is waiting here: "[^"]*CSV to JSON[^"]*" — \/plan go starts it/.test(second), second.slice(-500))
  ok("/plan go starts it: the run is given the plan", m.st.runs.some((t) => /PLAN-MARK-8080/.test(t)), `${m.st.runs.length} run request(s)`)
  ok("…and once started, the session no longer carries it", sessions(env.home)[0]?.pendingPlan === null)
  const third = await session(env, ["chat", "--continue"], "/plan go\n/exit\n")
  ok("a plan that was started does not come back", !/a plan is waiting here/.test(third) && /no plan to start/.test(third))
  await m.stop(); cleanup(env)
}

console.log("== 3. /plan show and /plan drop after a restart ==")
{
  const m = await model()
  const env = setup(m)
  await session(env, ["chat"], MAKE)
  const shown = await session(env, ["chat", "--continue"], "/plan show\n/plan drop\n/exit\n")
  ok("/plan show prints the restored plan", /PLAN-MARK-8080/.test(shown.split("a plan is waiting here")[1] ?? ""))
  ok("/plan drop discards it — in the session too", /plan dropped/.test(shown) && sessions(env.home)[0]?.pendingPlan === null)
  const after = await session(env, ["chat", "--continue"], "/plan go\n/exit\n")
  ok("…so it does not come back", !/a plan is waiting here/.test(after) && m.st.runs.length === 0)
  await m.stop(); cleanup(env)
}

console.log("== 4. /new starts clean ==")
{
  const m = await model()
  const env = setup(m)
  await session(env, ["chat"], "I need a CSV to JSON converter that streams rows\n/plan\n/new\nhello\n/exit\n")
  const all = sessions(env.home)
  ok("the fresh conversation does not inherit the waiting plan", all.length === 2 && all[1].pendingPlan === null, JSON.stringify(all.map((s) => !!s.pendingPlan)))
  ok("…the one it was made in still has it", /PLAN-MARK-8080/.test(all[0]?.pendingPlan?.plan ?? ""))
  await m.stop(); cleanup(env)
}

console.log("== 5. the full-screen UI: plan, not now, quit, restart, /plan go ==")
{
  const m = await model()
  const env = setup(m)
  const tty = (args, steps) => new Promise((resolve) => {
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} ${args}`
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: env.work, env: { ...process.env, FORGE_HOME: env.home, HOME: env.home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    child.stdout.on("data", (d) => { out += clean(d) })
    const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(out) }
    const settle = async () => { for (let last = -1; last !== out.length;) { last = out.length; await new Promise((r) => setTimeout(r, 500)) } }
    ;(async () => {
      await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
      for (const [line, waitFor] of steps) { child.stdin.write(`${line}\r`); if (waitFor) await until(waitFor); await settle() }
      child.stdin.write("/exit\r")
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(out) }, 8000)
      child.on("exit", () => { clearTimeout(t); resolve(out) })
    })()
  })
  const one = await tty("chat", [["I need a CSV to JSON converter that streams rows", /Noted/], ["/plan", /start this plan now/], ["n", /plan kept/]])
  ok("the full-screen UI kept the plan on \"n\"", /plan kept/.test(one), one.replace(/\s+/g, " ").slice(-300))
  const two = await tty("chat --continue", [["/plan go", /starting the approved plan/]])
  const flat = two.replace(/\s+/g, " ")
  ok("…after a restart it says the plan is waiting, and /plan go starts it", /a plan is waiting here/.test(flat) && /starting the approved plan/.test(flat) && m.st.runs.some((t) => /PLAN-MARK-8080/.test(t)), flat.slice(-500))
  await m.stop(); cleanup(env)
}

console.log("== 6. the terminal is closed right after /plan drop, or while the started plan runs ==")
{
  // a real terminal; then the forge process is killed outright — no /exit,
  // no exit handler — like a closed terminal
  const killedAfter = async (env, line, waitFor) => {
    const pidFile = path.join(env.home, "forge.pid")
    const cmd = `echo $$ > ${JSON.stringify(pidFile)}; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat --continue`
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: env.work, env: { ...process.env, FORGE_HOME: env.home, HOME: env.home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => { out += String(d) })
    const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(out) }
    await until(/a plan is waiting here/); await new Promise((r) => setTimeout(r, 800))
    child.stdin.write(`${line}\r`)
    const seen = await until(waitFor)
    await new Promise((r) => setTimeout(r, 600))
    let pid = null
    try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()) } catch { /* no pid */ }
    if (pid) { try { process.kill(pid, "SIGKILL") } catch { /* already gone */ } }
    if (child.exitCode === null) await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 8000); child.once("exit", () => { clearTimeout(t); r() }) })
    return seen
  }
  const m = await model()
  const env = setup(m)
  await session(env, ["chat"], MAKE)
  const dropped = await killedAfter(env, "/plan drop", /plan dropped/)
  ok("a plan dropped just before the terminal closed stays dropped", dropped && sessions(env.home)[0]?.pendingPlan === null, JSON.stringify(sessions(env.home)[0]?.pendingPlan ?? null).slice(0, 80))
  await m.stop(); cleanup(env)
  const m2 = await model()
  const env2 = setup(m2)
  await session(env2, ["chat"], MAKE)
  m2.st.holdRuns = true
  const started = await killedAfter(env2, "/plan go", /starting the approved plan/)
  ok("a plan started just before the terminal closed is not offered again (it would run twice)", started && m2.st.runs.length === 1 && sessions(env2.home)[0]?.pendingPlan === null, `runs=${m2.st.runs.length}; ${JSON.stringify(sessions(env2.home)[0]?.pendingPlan ?? null).slice(0, 80)}`)
  await m2.stop(); cleanup(env2)
}

console.log(`== plan-go-restart suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
