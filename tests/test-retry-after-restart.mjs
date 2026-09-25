#!/usr/bin/env node
// v173 — /retry continues a stopped run after chat is restarted.
//
// v166's /retry continues a stopped run from where it stopped, but kept its
// conversation in chat's memory. The usual reason a run stops is also the
// usual reason to quit: credits ran out. Quit, top up, `forge chat
// --continue`, /retry — and the run started over, paying again for its
// steps. Worse, a run that stopped before anything was said saved no
// session at all.
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

const A = await import("../agent.js")
const C = await import("../chat.js")

console.log("== 1. what is kept, and how it comes back ==")
{
  const big = "x".repeat(200000)
  const cont = { steps: 3, messages: [
    { role: "user", content: "the task" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: "", tool_calls: [{ id: "b", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "b", content: big },
    { role: "assistant", content: "", tool_calls: [{ id: "c", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "LAST-RESULT" },
  ] }
  const t = A.trimContinuation(cont, 300000)
  ok("a large conversation is cut to fit, oldest turns first", Buffer.byteLength(JSON.stringify(t.messages)) <= 300000 && t.messages[0].content === "the task" && t.messages.at(-1).content === "LAST-RESULT" && t.droppedTurns > 0, JSON.stringify({ n: t.messages.length, dropped: t.droppedTurns }))
  ok("…and what is left is still sendable (no result without its call)", A.continuationMessages(t.messages).every((m, i, arr) => m.role !== "tool" || arr.slice(0, i).some((x) => x.tool_calls?.some((tc) => tc.id === m.tool_call_id))))
  ok("a task too large to keep is not kept", A.trimContinuation({ messages: [{ role: "user", content: big }] }, 1000) === null)
  const r = C.restoreStoppedRun({ stoppedRun: { task: "count once", label: "count once", continuation: { steps: 2, messages: [] } } }, [{ role: "user", content: "hi" }])
  ok("a saved stopped run comes back pinned to the restored conversation", r.task === "count once" && r.at === 1)
  ok("…and says so", /stopped here at step 2: "count once" — \/retry continues it/.test(C.stoppedRunNotice(r)), C.stoppedRunNotice(r))
  ok("a session without one restores none", C.restoreStoppedRun({}, []) === null)
}

/** A model: a bash call per agent run (counted on disk), a 402 while spent. */
function model() {
  const st = { spent: true, calls: [] }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const agent = /autonomous terminal coding agent/.test(system)
      const hasResult = (j.messages ?? []).some((m) => m.role === "tool")
      st.calls.push({ agent, hasResult, text: JSON.stringify(j.messages ?? []), spent: st.spent })
      if (agent && hasResult && st.spent) {
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 402, message: "This request would exceed your available credits." } }))
      }
      const msg = agent && !hasResult
        ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: st.command ?? "echo RAN >> count.txt; echo STEP-ONE-OUTPUT" }) } }] }
        : { role: "assistant", content: agent ? "DONE-AFTER-RESTART" : "CHAT-REPLY" }
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

function setup(m) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-restart-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-restart-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 4 }, skills: { enabled: false } }))
  return { home, work }
}
const session = ({ home, work }, args, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  child.stdin.write(input); child.stdin.end()
  const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "timeout", out }) }, 60000)
  child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
})
const lines = (work) => { try { return fs.readFileSync(path.join(work, "count.txt"), "utf8").trim().split("\n").length } catch { return 0 } }
const sessionFile = (home) => { const dir = path.join(home, "sessions"); const f = fs.readdirSync(dir).filter((x) => /^[\w-]+\.json$/.test(x) && x !== "last.json")[0]; return f ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : null }

console.log("== 2. stop, quit, top up, come back, /retry ==")
{
  const m = await model()
  const env = setup(m)
  await session(env, ["chat"], "/agent count once\n/exit\n")
  const saved = sessionFile(env.home)
  ok("a run that stopped before anything was said still saves a session", saved?.stoppedRun?.task === "count once", JSON.stringify(saved && Object.keys(saved)))
  ok("…carrying what it had done", /STEP-ONE-OUTPUT/.test(JSON.stringify(saved?.stoppedRun?.continuation ?? {})))
  m.st.spent = false
  const before = m.st.calls.length
  const r2 = await session(env, ["chat", "--continue"], "/retry\n/exit\n")
  const after = m.st.calls.slice(before).filter((c) => c.agent)
  ok("the restarted chat says a run can continue", /an agent run stopped here at step \d+: "count once" — \/retry continues it/.test(r2.out), r2.out.slice(-500))
  ok("/retry continues it: the first request carries the earlier result", /STEP-ONE-OUTPUT/.test(after[0]?.text ?? "") && /CONTINUES an earlier attempt/.test(after[0]?.text ?? ""), `${after.length} agent calls`)
  ok("…the step was not run again", lines(env.work) === 1, `count.txt: ${lines(env.work)} line(s)`)
  ok("…and it finished", /DONE-AFTER-RESTART/.test(r2.out), r2.out.slice(-300))
  ok("once it completed, the session no longer carries it", sessionFile(env.home)?.stoppedRun === null, JSON.stringify(sessionFile(env.home)?.stoppedRun))
  await m.stop()
  fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true })
}

console.log("== 2b. the terminal is closed right after the run stops ==")
{
  // a real terminal, so chat stays open after the run; then the forge process
  // is killed outright — no /exit, no exit handler — like a closed terminal
  const m = await model()
  const env = setup(m)
  fs.writeFileSync(path.join(env.home, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(env.home, "config.json"), "utf8")), agent: { maxSteps: 4 } }))
  const pidFile = path.join(env.home, "forge.pid")
  const cmd = `echo $$ > ${JSON.stringify(pidFile)}; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: env.work, env: { ...process.env, FORGE_HOME: env.home, HOME: env.home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += String(d) })
  const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(out) }
  await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
  child.stdin.write("/agent count once\r")
  const failed = await until(/TASK FAILED/)
  await new Promise((r) => setTimeout(r, 800))
  let pid = null
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()) } catch { /* no pid */ }
  if (pid) { try { process.kill(pid, "SIGKILL") } catch { /* already gone */ } }
  if (child.exitCode === null) await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 8000); child.once("exit", () => { clearTimeout(t); r() }) })
  ok("a chat killed after the run stopped still kept it (saved when it stopped, not at exit)", failed && sessionFile(env.home)?.stoppedRun?.task === "count once", `failed=${failed}; ${JSON.stringify(sessionFile(env.home)?.stoppedRun ?? null).slice(0, 120)}`)
  await m.stop()
  fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true })
}

console.log("== 3. a chat turn typed first means /retry is about that turn ==")
{
  const m = await model()
  const env = setup(m)
  await session(env, ["chat"], "/agent count once\n/exit\n")
  m.st.spent = false
  const before = m.st.calls.length
  await session(env, ["chat", "--continue"], "hello again\n/retry\n/exit\n")
  const after = m.st.calls.slice(before)
  ok("/retry re-asked the chat turn, and did not start the old run", !after.some((c) => c.agent) && after.filter((c) => /hello again/.test(c.text)).length === 2, JSON.stringify(after.map((c) => c.agent)))
  await m.stop()
  fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true })
}

console.log("== 4. a huge tool output does not make the session huge ==")
{
  const m = await model()
  m.st.command = "node -e \"process.stdout.write('y'.repeat(3000000))\"; echo RAN >> count.txt"
  const env = setup(m)
  fs.writeFileSync(path.join(env.home, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(env.home, "config.json"), "utf8")), agent: { autonomous: false, maxSteps: 4, maxToolOutput: 2000000 } }))
  await session(env, ["chat"], "/agent count once\n/exit\n")
  const dir = path.join(env.home, "sessions")
  const f = fs.readdirSync(dir).filter((x) => /^[\w-]+\.json$/.test(x) && x !== "last.json")[0]
  const bytes = f ? fs.statSync(path.join(dir, f)).size : -1
  ok("the saved session stays bounded (~400KB for the run)", bytes > 0 && bytes < 600 * 1024, `${bytes} bytes`)
  await m.stop()
  fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true })
}

console.log("== 5. the full-screen UI: stop, quit, restart, /retry ==")
{
  const m = await model()
  const env = setup(m)
  fs.writeFileSync(path.join(env.home, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(env.home, "config.json"), "utf8")), agent: { maxSteps: 4 } }))
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
  await tty("chat", [["/agent count once", /TASK FAILED/]])
  m.st.spent = false
  const out = await tty("chat --continue", [["/retry", /continuing from step \d+, not from the start/]])
  ok("the full-screen UI says the run can continue, and /retry continues it", /\/retry continues it/.test(out) && /continuing from step \d+, not from the start/.test(out), out.slice(-600))
  ok("…and the step ran once", lines(env.work) === 1, `count.txt: ${lines(env.work)} line(s)`)
  await m.stop()
  fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true })
}

console.log(`\n== retry-after-restart suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
