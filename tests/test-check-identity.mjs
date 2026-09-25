#!/usr/bin/env node
// v168 — one check, however it is typed; and a failing check stays failing.
//
// 1. `npm test 2>&1 | tail -20` exits with TAIL's status, so a failing test
//    run came back as success: the model saw no exit code, and forge
//    recorded a PASSING check — which completion.unverifiedWrites() takes as
//    covering every write before it. The shell here is dash: no PIPESTATUS,
//    no pipefail. So for a check ending in a plain `| tail -N` / `| head -N`,
//    forge runs the check and applies the filter itself.
// 2. Lessons compared commands by their exact text: `node ./setup.js` did not
//    re-apply a lesson that says `node setup.js`, and `npm test` failing then
//    `npm test 2>&1 | tail -20` passing was not a repair. The open programme
//    case `lesson-repair-respelled` (since v162) measured the first.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const C = await import("../checkcmd.js")
const A = await import("../agent.js")
const T = await import("../tools.js")
const L = await import("../lessons.js")
const P = await import("../providers.js")

console.log("== 1. the same command typed differently ==")
{
  const cwd = "/work/proj"
  const n = (c) => C.normalizeCommand(c, { cwd })
  const same = [
    ["node ./setup.js", "node setup.js"],
    ["cd /work/proj && npm test", "npm test"],
    ["cd . && npm t", "npm test"],
    ["npm run test", "npm test"],
    ["npm run-script build", "npm run build"],
    ["npm test 2>&1 | tail -20", "npm test"],
    ["npm test | head -n 5", "npm test"],
    ["npm test; echo \"exit=$?\"", "npm test"],
    ["npm i lodash", "npm install lodash"],
    ["pnpm run test", "pnpm test"],
    ["python3 -m pip install -r req.txt", "pip install -r req.txt"],
    ["  npm   test  ", "npm test"],
  ]
  for (const [a, b] of same) ok(`"${a}" is "${b}"`, n(a) === n(b), `${n(a)} vs ${n(b)}`)
  ok("a cd to ANOTHER directory is a different command", n("cd /elsewhere && npm test") !== n("npm test"))
  ok("a bare `./script` command is left as typed", n("./setup.sh") === "./setup.sh")
  ok("`npm ci` is not `npm install`", n("npm ci") !== n("npm install"))
  ok("different scripts stay different", n("npm run build") !== n("npm test"))
}

console.log("== 2. which pipes forge may take over ==")
{
  ok("`| tail -N`", JSON.stringify(C.splitOutputFilter("npm test 2>&1 | tail -20")) === JSON.stringify({ base: "npm test 2>&1", filter: { kind: "tail", n: 20 }, merged: true }))
  ok("`| head -n N` and `| tail --lines=N`", C.splitOutputFilter("npm test | head -n 5")?.filter.n === 5 && C.splitOutputFilter("npm test | tail --lines=7")?.filter.n === 7)
  for (const c of ["npm test | grep FAIL | tail -5", "npm test || tail -5", "npm test | tail -f", "npm test | tail -n +2", "$(npm bin)/jest | tail -5", "npm test | tail -5; echo x"]) {
    ok(`left alone: ${c}`, C.splitOutputFilter(c) === null)
  }
  const sh = (input, f) => execFileSync("sh", ["-c", `printf '%s' "$1" | ${f}`, "sh", input], { encoding: "utf8" })
  for (const [input, kind, k] of [["a\nb\nc\n", "tail", 2], ["a\nb\nc", "tail", 2], ["a\nb\nc\n", "head", 2], ["a\nb\nc", "head", 5], ["a\nb\nc", "head", 2], ["", "tail", 3]]) {
    ok(`${kind} -${k} of ${JSON.stringify(input)} is what the shell gives`, C.applyOutputFilter(input, { kind, n: k }) === sh(input, `${kind} -${k}`), `${JSON.stringify(C.applyOutputFilter(input, { kind, n: k }))} vs ${JSON.stringify(sh(input, `${kind} -${k}`))}`)
  }
}

console.log("== 3. the bash tool: a failing check piped through tail stays failing ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-piped-"))
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js", good: "node good.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), "for (let i = 0; i < 30; i++) console.log(`line ${i}`)\nconsole.error('2 failed')\nprocess.exit(1)\n")
  fs.writeFileSync(path.join(work, "good.js"), "console.log('all good')\n")
  fs.writeFileSync(path.join(work, "test-big.js"), "const l = 'x'.repeat(99) + '\\n'; for (let i = 0; i < 60000; i++) process.stdout.write(l); console.log('THE-LAST-LINE'); process.exitCode = 2\n")
  const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 60 }
  const run = async (command) => String(await T.execTool(ctx, "bash", { command }))
  const shell = (command) => { try { return execFileSync("sh", ["-c", command], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { return e.stdout } }

  const r = await run("npm test 2>&1 | tail -3")
  ok("`npm test 2>&1 | tail -3` reports the tests' exit code", /\[exit code: 1\]/.test(r), r)
  ok("…with exactly the lines the shell's tail shows", r.startsWith(shell("npm test 2>&1 | tail -3").trimEnd()), JSON.stringify(r.slice(0, 80)))
  ok("…and says why the code differs from the pipe's", /exit code is the check's own/.test(r))
  const good = await run("npm run good 2>&1 | tail -2")
  ok("a passing piped check is unchanged: no exit code, no note", !/exit code/.test(good) && /all good/.test(good), good)
  const plain = await run("cat t.js | tail -1")
  ok("a command that is not a check runs exactly as typed", !/exit code/.test(plain) && /process\.exit\(1\)/.test(plain), plain)
  const grepMiss = await run("grep NOPE t.js | tail -1")
  ok("…even when its first stage fails (a grep with no match): the pipe's status, as the shell says", !/exit code/.test(grepMiss), grepMiss)
  const multi = await run("npm test 2>&1 | grep line | tail -2")
  ok("a pipe forge cannot reproduce is left as the shell reports it", !/exit code: 1/.test(multi), multi)
  const big = await run("node test-big.js | tail -1")
  ok("a 6MB check log through tail is not killed as an overflow", /THE-LAST-LINE/.test(big) && /\[exit code: 2\]/.test(big) && !/exceeded/.test(big), big.slice(-200))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== 3b. v172: a check piped through tee ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tee-"))
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), "console.log('line one'); console.error('2 failed'); process.exit(1)\n")
  const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 60 }
  const run = async (command) => String(await T.execTool(ctx, "bash", { command }))
  const r = await run("npm test 2>&1 | tee test.log")
  ok("`npm test 2>&1 | tee test.log` reports the tests' exit code", /\[exit code: 1\]/.test(r) && /forge wrote the same output to that file/.test(r), r)
  try { execFileSync("sh", ["-c", "npm test 2>&1 | tee shell.log >/dev/null"], { cwd: work, stdio: "ignore" }) } catch { /* the shell's tee exits 0 anyway */ }
  ok("…and the file holds exactly what the shell's tee writes", fs.readFileSync(path.join(work, "test.log"), "utf8") === fs.readFileSync(path.join(work, "shell.log"), "utf8"), JSON.stringify(fs.readFileSync(path.join(work, "test.log"), "utf8")))
  await run("npm test 2>&1 | tee -a test.log")
  ok("`tee -a` appends", fs.readFileSync(path.join(work, "test.log"), "utf8") === fs.readFileSync(path.join(work, "shell.log"), "utf8").repeat(2))
  const outside = path.join(os.tmpdir(), `forge-tee-outside-${process.pid}.log`)
  const o = await run(`npm test 2>&1 | tee ${outside}`)
  ok("a tee target outside the project is left to the shell, as typed", !/exit code: 1/.test(o) && !/forge wrote/.test(o), o)
  try { fs.rmSync(outside, { force: true }) } catch { /* the shell may not have written it */ }
  const plain = await run("cat t.js | tee copy.txt")
  ok("a command that is not a check is not taken over", !/forge wrote/.test(plain) && fs.existsSync(path.join(work, "copy.txt")))
  ok("normalizing: `npm test 2>&1 | tee x.log` is `npm test`", C.normalizeCommand("npm test 2>&1 | tee x.log") === "npm test")
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== 4. the check forge records: failing, and the writes before it unverified ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-piped-agent-"))
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), "console.log('1 failed'); process.exit(1)\n")
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const x = 1\n" }) }
        : n === 2 ? { name: "bash", arguments: JSON.stringify({ command: "npm test 2>&1 | tail -5" }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Done — tests pass." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "add feature.js and run the tests", onEvent: () => {} }) } catch (e) { r = { error: e } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(work, { recursive: true, force: true })
  const chk = (r?.commandChecks ?? []).find((c) => /npm test/.test(c.command))
  ok("the piped check is recorded as FAILING", chk && chk.passed === false && chk.exitCode === 1, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode }))
  ok("…so the write before it is reported UNVERIFIED (a passing check used to cover it)", r?.verification?.checksPassing === 0 && r?.verification?.unverified?.some((f) => /feature\.js$/.test(f)), JSON.stringify(r?.verification))
}

console.log("== 5. lessons: the same repair, the same check ==")
{
  const cwd = process.cwd()
  const reps = L.provenRepairs({ cwd, commands: ["node setup.js"], commandChecks: [
    { command: "npm test", passed: false, commandIndex: 0, writeIndex: 0, step: 1 },
    { command: "npm test 2>&1 | tail -20", passed: true, commandIndex: 1, writeIndex: 0, step: 3 },
  ] })
  ok("`npm test` red, `npm test 2>&1 | tail -20` green: one check, repaired", reps.length === 1 && reps[0].command === "npm test" && reps[0].ran.join() === "node setup.js", JSON.stringify(reps))
  const lesson = { id: "L1", check: "npm test", successful_repair: "ran `node setup.js` — after which `npm test` passed" }
  const judged = L.lessonOutcomes({ cwd, lessons: [lesson], commands: ["node ./setup.js"], commandChecks: [{ command: "npm test 2>&1 | tail -5", passed: false, commandIndex: 1, writeIndex: 0 }] })
  ok("`node ./setup.js` re-applies a lesson that says `node setup.js`, judged by a piped check", judged.length === 1 && judged[0].worked === false, JSON.stringify(judged))
  const other = L.lessonOutcomes({ cwd, lessons: [lesson], commands: ["node teardown.js"], commandChecks: [{ command: "npm test", passed: false, commandIndex: 1, writeIndex: 0 }] })
  ok("…and a different command still is not a re-application", other.length === 0, JSON.stringify(other))
}

console.log("== 6. a real run: `npm test` red, a repair, `npm test 2>&1 | tail -5` green — one lesson ==")
{
  const { spawn } = await import("node:child_process")
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-respelled-check-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), "if (!require('fs').existsSync('config.json')) { console.error('config.json is missing'); process.exit(1) }\n")
  fs.writeFileSync(path.join(work, "setup.js"), "require('fs').writeFileSync('config.json', '{}')\n")
  const script = ["npm test", "node setup.js", "npm test 2>&1 | tail -5"]
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const done = (j.messages ?? []).filter((m) => m.role === "tool").length
      const cmd = script[done]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: cmd ? { role: "assistant", content: "", tool_calls: [{ id: `t${done}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] } : { role: "assistant", content: "done" }, finish_reason: cmd ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub",
    "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "8", "--", "make npm test pass"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 60000); child.once("exit", (c) => { clearTimeout(t); r(c) }) })
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  let lessons = []
  try {
    const pd = path.join(home, ".forge", "projects")
    lessons = JSON.parse(fs.readFileSync(path.join(pd, fs.readdirSync(pd)[0], "lessons.json"), "utf8"))
  } catch { /* none recorded */ }
  const l = lessons.find((x) => /node setup\.js/.test(String(x.successful_repair ?? "")))
  ok("the run recorded the repair as one lesson, for the check `npm test`", code === 0 && l && l.check === "npm test", JSON.stringify({ code, lessons: lessons.map((x) => [x.check, x.successful_repair]) }))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n== check-identity suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
