#!/usr/bin/env node
/**
 * forge — v175: /retry survives a restart.
 *
 * v166's /retry continues a stopped agent run from where it stopped, but the
 * stopped run lived only in the chat process's memory. Quit when credits ran
 * out, top up, `forge chat --continue`, /retry — and the run started over,
 * paying again for every step already done. The stopped run is now saved with
 * its session. Pinned here:
 *   - saveSession keeps / replaces / clears the pending run as asked, and caps it;
 *   - after a restart, /retry continues the run and its step is not run again;
 *   - once the person chats after the stop, /retry is about that chat instead
 *     (the same rule as in one process);
 *   - a run that completes clears what was saved.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORGE = path.join(HERE, "..", "forge.js")
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retry-restart-"))
process.env.FORGE_HOME = path.join(ROOT, "unit-home")

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }

console.log("== 1. saveSession and the pending run ==")
{
  const { saveSession, loadSession, boundPendingRun, PENDING_RUN_MAX_BYTES, setSessionStoreOverride } = await import("../sessions.js")
  const store = path.join(ROOT, "store"); fs.mkdirSync(store)
  setSessionStoreOverride(store)
  const run = { task: "count once", label: "count once", at: 0, continuation: { messages: [{ role: "user", content: "x" }], steps: 1 } }
  const f = saveSession({ provider: "p", model: "m", messages: [], pendingRun: run })
  const id = path.basename(f, ".json")
  ok("a pending run is saved with the session", loadSession(f)?.pendingRun?.task === "count once")
  saveSession({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], id })
  ok("a save that does not mention it keeps it", loadSession(f)?.pendingRun?.task === "count once")
  saveSession({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], id, pendingRun: null })
  ok("null clears it", loadSession(f)?.pendingRun === null)
  const huge = { ...run, continuation: { messages: [{ role: "tool", content: "x".repeat(PENDING_RUN_MAX_BYTES + 10) }], steps: 1 } }
  const b = boundPendingRun(huge)
  ok("an oversized run keeps its task but drops its conversation", b.task === "count once" && b.continuation === null && b.trimmed === true)
  ok("a run with no task is not saved", boundPendingRun({ label: "x" }) === null)
}

// A stub provider: the first agent step runs `echo RAN >> count.txt`; after that
// step, while `spent`, it answers 402 (out of credits).
let spent = true, continued = false
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    let j = {}
    try { j = JSON.parse(body) } catch {}
    const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
    const agent = /autonomous terminal coding agent/.test(system)
    const hasResult = (j.messages ?? []).some((m) => m.role === "tool")
    if (agent && hasResult && spent) {
      res.writeHead(402, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { code: 402, message: "This request would exceed your available credits." } }))
    }
    if (agent && hasResult && JSON.stringify(j.messages).includes("CONTINUES an earlier attempt")) continued = true
    const msg = agent && !hasResult
      ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo RAN >> count.txt" }) } }] }
      : { role: "assistant", content: agent ? "DONE" : "ok" }
    if (j.stream && !msg.tool_calls) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: "stop" }] })}\n\n`)
      return res.end("data: [DONE]\n\n")
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))

const setup = (tag) => {
  const home = path.join(ROOT, `${tag}-home`), work = path.join(ROOT, `${tag}-work`)
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } },
    tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 4 }, skills: { enabled: false },
  }))
  const session = (args, input) => new Promise((resolve) => {
    let text = ""
    const child = spawn(process.execPath, [FORGE, ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (d) => { text += d })
    child.stderr.on("data", (d) => { text += d })
    child.stdin.write(input); child.stdin.end()
    const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; resolve({ code: "timeout", text }) }, 60000)
    child.once("exit", (code) => { clearTimeout(t); resolve({ code, text }) })
  })
  const count = () => { try { return fs.readFileSync(path.join(work, "count.txt"), "utf8").trim().split("\n").length } catch { return 0 } }
  const saved = () => {
    const dir = path.join(home, "sessions")
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "last.json") : []
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
  }
  return { session, count, saved }
}

console.log("== 2. stop, restart, /retry ==")
{
  spent = true; continued = false
  const t = setup("a")
  await t.session(["chat"], "/agent count once\n/exit\n")
  ok("session 1 ran its step once before stopping", t.count() === 1, String(t.count()))
  ok("…and the stopped run was saved even though nothing was said", t.saved().some((s) => s.pendingRun?.task), JSON.stringify(t.saved().map((s) => Object.keys(s))))
  spent = false
  const r = await t.session(["chat", "--continue"], "/retry\n/exit\n")
  ok("the restarted chat says a stopped run can be continued", /stopped before finishing — \/retry continues it/.test(r.text), r.text.slice(-600))
  ok("/retry continued the stopped run", continued)
  ok("…and its step was not run again", t.count() === 1, String(t.count()))
  ok("a run that completed clears what was saved", t.saved().every((s) => !s.pendingRun), JSON.stringify(t.saved().map((s) => s.pendingRun)))
}

console.log("== 3. chatting after the stop moves /retry on ==")
{
  spent = true; continued = false
  const t = setup("b")
  await t.session(["chat"], "/agent count once\n/exit\n")
  spent = false
  await t.session(["chat", "--continue"], "hello\n/exit\n")
  const r = await t.session(["chat", "--continue"], "/retry\n/exit\n")
  ok("/retry did not continue the old run", !continued)
  ok("…and did not re-run its step", t.count() === 1, String(t.count()))
  ok("…and no stale notice was shown", !/stopped before finishing/.test(r.text), r.text.slice(-400))
}

console.log("== 3b. /new and /resume ==")
{
  const { restoredRun } = await import("../chat.js")
  const run = { task: "t", label: "t", at: 2, continuation: null }
  ok("a run saved with nothing said after it is restored", restoredRun({ messages: [{}, {}], pendingRun: run }, [{}, {}])?.task === "t")
  ok("…and re-pinned to the restored conversation", restoredRun({ messages: [{ role: "system" }, {}, {}], pendingRun: { ...run, at: 3 } }, [{}, {}])?.at === 2)
  ok("a run with chat after it is not", restoredRun({ messages: [{}, {}, {}], pendingRun: run }, [{}, {}, {}]) === null)
  ok("a session with no run restores none", restoredRun({ messages: [] }, []) === null)

  spent = true; continued = false
  const t = setup("n")
  await t.session(["chat"], "/agent count once\n/new\n/exit\n")
  const carrying = t.saved().filter((s) => s.pendingRun?.task)
  ok("/new does not carry the stopped run into the fresh conversation", carrying.length === 1, `${carrying.length} session file(s) carry it`)
}

console.log("== 4. the terminal is closed right after the stop (no /exit) ==")
{
  spent = true; continued = false
  const t = setup("c")
  // `!sleep 30` keeps chat busy after the stop, so it never reaches its own
  // exit path; the stopped run must already be on disk when it is killed
  const child = spawn(process.execPath, [FORGE, "chat"], { cwd: path.join(ROOT, "c-work"), env: { PATH: process.env.PATH, HOME: path.join(ROOT, "c-home"), FORGE_HOME: path.join(ROOT, "c-home"), NO_COLOR: "1" }, stdio: ["pipe", "ignore", "ignore"] })
  child.stdin.write("/agent count once\n!sleep 30\n/exit\n"); child.stdin.end()
  let onDisk = false
  for (let i = 0; i < 200 && !onDisk; i++) {
    await new Promise((r) => setTimeout(r, 100))
    onDisk = t.saved().some((s) => s.pendingRun?.task)
  }
  const alive = child.exitCode === null && child.signalCode === null
  ok("the stopped run is on disk while chat is still open", onDisk && alive, `onDisk=${onDisk} alive=${alive}`)
  const gone = new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)))
  child.kill("SIGKILL")
  await gone
  spent = false
  await t.session(["chat", "--continue"], "/retry\n/exit\n")
  ok("…so /retry after the crash still continues it", continued)
  ok("…without re-running its step", t.count() === 1, String(t.count()))
}

srv.closeAllConnections?.()
await new Promise((r) => srv.close(r))
fs.rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
