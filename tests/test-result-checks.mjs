#!/usr/bin/env node
// v181 — the result file a harness reads carries the checks the run ran.
//
// A run whose only check failed (`npm test` exit 1, then the model: "Done.
// All tests pass.") printed "checks ran but none passed (1)" in the terminal
// while --result-json said COMPLETED and nothing about checks. The status
// stays (the run reached an end; solved is the verifier's call) — the
// evidence is now in the file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rchecks-home-"))
process.env.FORGE_SECURITY_MODE = process.env.FORGE_SECURITY_MODE_TEST ?? "on"
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const { resultChecks } = await import("../forge.js")

console.log("== 1. what the result file says about checks ==")
{
  const failing = { passed: false, command: "npm test", exitCode: 1, timedOut: false, tail: "1 test failed" }
  const r = resultChecks({ commandChecks: [{ passed: true, command: "npm run lint", exitCode: 0, tail: "" }, failing], verification: { unverified: [path.join(ROOT, "src/a.js")], checksRun: 2, checksPassing: 1 } }, ROOT)
  ok("how many ran and passed", r.checksRun === 2 && r.checksPassing === 1)
  ok("the last one: command, exit code, passed, its output", r.lastCheck.command === "npm test" && r.lastCheck.exitCode === 1 && r.lastCheck.passed === false && r.lastCheck.tail === "1 test failed")
  ok("changed files no passing check covers, relative to the project", r.unverified.length === 1 && r.unverified[0] === path.join("src", "a.js"))
  const secret = resultChecks({ commandChecks: [{ passed: false, command: "curl -H 'Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789' https://x", exitCode: 7, tail: "token sk-live-abcdefghijklmnopqrstuvwxyz0123456789 rejected" }] })
  ok("secrets in the command and its output are redacted", !/sk-live-abcdefghijklmnopqrstuvwxyz/.test(JSON.stringify(secret)), JSON.stringify(secret))
  ok("a run with no checks and no verification: null, not zeros", resultChecks({ commandChecks: [] }) === null && resultChecks({}) === null && resultChecks(null) === null)
  const auto = resultChecks({ verification: { ok: false, reason: "tests still failing" } })
  ok("the autonomous controller's verdict is carried", auto.verified === false && auto.reason === "tests still failing" && auto.checksRun === 0)
  ok("…in either of its shapes", resultChecks({ verification: { status: "passed" } }).verified === true && resultChecks({ verification: { status: "FAILED" } }).verified === false)
  ok("bounded: a long command and output are cut", resultChecks({ commandChecks: [{ command: "x".repeat(1000), tail: "y".repeat(1000) }] }).lastCheck.command.length === 300)
}

/** A headless run whose model runs `command`, then says it is done. */
async function run({ command = null, write = null, checkExit = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rchecks-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), `console.log("${checkExit ? "1 test failed" : "all 3 tests passed"}"); process.exit(${checkExit})\n`)
  const calls = []
  if (write) calls.push({ name: "write_file", arguments: JSON.stringify({ path: write, content: "export const x = 1\n" }) })
  if (command) calls.push({ name: "bash", arguments: JSON.stringify({ command }) })
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const c = calls[n++]
      const msg = c ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: c }] } : { role: "assistant", content: "Done. All tests pass." }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: c ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const file = path.join(dir, "result.json")
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "6", "--result-json", file, "--", "fix the failing test"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 60000); child.once("exit", () => { clearTimeout(t); r() }) })
  srv.closeAllConnections?.(); await new Promise((r) => srv.close(r))
  let result = null
  try { result = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

console.log("== 2. real headless runs ==")
{
  const failed = await run({ command: "npm test", checkExit: 1 })
  ok("a failing check: the file still says COMPLETED…", failed?.status === "COMPLETED")
  ok("…and says 1 check ran, none passed, and which one", failed?.checks?.checksRun === 1 && failed.checks.checksPassing === 0 && failed.checks.lastCheck?.command === "npm test" && failed.checks.lastCheck.exitCode === 1, JSON.stringify(failed?.checks))
  ok("…with the check's own output", /1 test failed/.test(failed?.checks?.lastCheck?.tail ?? ""))
  const passed = await run({ command: "npm test", checkExit: 0 })
  ok("a passing check says so", passed?.checks?.checksPassing === 1 && passed.checks.lastCheck?.passed === true, JSON.stringify(passed?.checks))
  const wroteOnly = await run({ write: "out.js" })
  ok("a file written and never checked is listed as unverified", wroteOnly?.checks?.checksRun === 0 && (wroteOnly.checks.unverified ?? []).includes("out.js"), JSON.stringify(wroteOnly?.checks))
  const nothing = await run({})
  ok("a run that ran no check and wrote nothing: checks is null", nothing && "checks" in nothing && nothing.checks === null, JSON.stringify(nothing?.checks))
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== result-checks suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
