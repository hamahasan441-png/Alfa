#!/usr/bin/env node
// v192 — the last check failed; the card says so.
//
// The model answered "Done — feature.js added and all tests pass." after
// `npm test` failed with exit 1, and the run ended COMPLETED. The card under
// that answer said the change was "unverified" — never that the last check
// failed, or which. The result file carried `lastCheck`; the card, where the
// person reads it, did not. Both cards (the plain one of `forge agent` and
// the terminal/chat one) now name it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.NO_COLOR = "1"
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const C = await import("../checkcmd.js")

console.log("== 1. did the run's last check fail? ==")
{
  const chk = (command, exitCode, extra = {}) => ({ command, exitCode, passed: exitCode === 0 && !extra.timedOut, timedOut: false, ...extra })
  ok("no checks: nothing to say", C.lastCheckFailure({}) === null && C.lastCheckFailure({ commandChecks: [] }) === null && C.lastCheckFailure(null) === null)
  ok("the last passed: nothing to say", C.lastCheckFailure({ commandChecks: [chk("npm test", 1), chk("npm test", 0)] }) === null)
  const f = C.lastCheckFailure({ commandChecks: [chk("npm test", 0), chk("npm test", 1)] })
  ok("a pass then a failure: the failure", f?.command === "npm test" && f?.exitCode === 1 && f?.timedOut === false, JSON.stringify(f))
  ok("…in the card's words", C.describeCheckFailure(f) === "`npm test` failed (exit 1)")
  const t = C.lastCheckFailure({ commandChecks: [chk("npm run e2e", 124, { timedOut: true })] })
  ok("a timeout says timed out", C.describeCheckFailure(t) === "`npm run e2e` timed out")
  ok("a long multi-line command is cut to its first line", C.lastCheckFailure({ commandChecks: [chk(`npm test\n${"x".repeat(300)}`, 2)] }).command === "npm test")
}

console.log("== 2. the terminal / chat card ==")
{
  const { createTerminal } = await import("../terminal.js")
  const { createUIStore } = await import("../uistate.js")
  const { createAgentView } = await import("../agentview.js")
  const card = (res) => {
    let buf = ""
    const output = new Writable({ write(c, _e, cb) { buf += c; cb() } })
    output.columns = 100
    const term = createTerminal({ input: { isTTY: false }, output, forceTTY: false, ascii: true, env: { NO_COLOR: "1" } })
    const store = createUIStore({ mode: "chat", provider: "p", model: "m", cwd: process.cwd(), terminal: { columns: 100, rows: 24, tty: false } })
    const view = createAgentView({ term, store, cwd: process.cwd(), plain: true, silent: true })
    view.printResult(res, { elapsedMs: 10 })
    view.stop()
    return buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  }
  const failed = card({ text: "Done — all tests pass.", steps: 3, toolLog: [], commandChecks: [{ command: "npm test", exitCode: 1, passed: false }] })
  ok("the headline is FINISHED WITH FAILING CHECKS, naming the check", /FINISHED WITH FAILING CHECKS\s+last check: `npm test` failed \(exit 1\)/.test(failed), failed)
  ok("…not COMPLETED", !/COMPLETED/.test(failed.replace(/FINISHED/g, "")), failed)
  const passed = card({ text: "Done.", steps: 3, toolLog: [], commandChecks: [{ command: "npm test", exitCode: 1, passed: false }, { command: "npm test", exitCode: 0, passed: true }] })
  ok("the last check passed: COMPLETED, as before", /COMPLETED/.test(passed) && !/FAILING/.test(passed), passed)
  const none = card({ text: "Here is the answer.", steps: 1, toolLog: [] })
  ok("no checks at all: COMPLETED, as before", /COMPLETED/.test(none) && !/FAILING|last check/.test(none), none)
}

console.log("== 3. the plain card of a real `forge agent` run ==")
async function run(steps, answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-failcard-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), `console.log("1 test failed"); process.exit(1)\n`)
  fs.writeFileSync(path.join(work, "fix.js"), `require("fs").writeFileSync("check.js", "console.log('all passed')\\n")\n`)
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const call = steps[n++] ?? null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: answer }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const rf = path.join(dir, "result.json")
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "8", "--result-json", rf, "--", "add feature.js and make the tests pass"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" } })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 60000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  srv.closeAllConnections?.(); srv.close()
  let result = null
  try { result = JSON.parse(fs.readFileSync(rf, "utf8")) } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, card: out.split("── result")[1] ?? "", result }
}
{
  const write = ["write_file", { path: "feature.js", content: "export const x = 1\n" }]
  const bad = await run([write, ["bash", { command: "npm test" }]], "Done — feature.js added and all tests pass.")
  ok("the answer is shown as the model wrote it", /all tests pass/.test(bad.card), bad.card)
  ok("…and under it: last check: `npm test` failed (exit 1)", /last check: `npm test` failed \(exit 1\) — no check passed after it/.test(bad.card), bad.card)
  ok("the result file still says COMPLETED, with lastCheck (the harness contract is unchanged)", bad.result?.status === "COMPLETED" && bad.result?.checks?.lastCheck?.passed === false && bad.code === 0, JSON.stringify(bad.result?.status))
  const fixed = await run([write, ["bash", { command: "npm test" }], ["bash", { command: "node fix.js" }], ["bash", { command: "npm test" }]], "Fixed: the tests pass now.")
  ok("a failure then a fix and a passing check: no such line", !/last check/.test(fixed.card) && /tests pass now/.test(fixed.card), fixed.card)
  const hidden = await run([write, ["bash", { command: 'npm test; echo "exit=$?"' }]], "Done — all tests pass.")
  ok("a failure hidden by `; echo` (v191) is named too", /last check: `npm test; echo "exit=\$\?"` failed \(exit 1\)/.test(hidden.card), hidden.card)
}

console.log(`== failed-check-card suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
