#!/usr/bin/env node
/**
 * forge v157 — a lesson that was tried again is credited or blamed.
 *
 * A lesson's confidence moved only when the same failure was recorded again.
 * Measured with real headless runs at v156: run 2 re-ran a lesson's repair
 * (`node setup.js`), the check it names (`npm test`) still failed, and the
 * lesson stayed at confidence 0.7, failureCount 0 — still offered to every
 * later run as "fix that worked".
 *
 * What must hold:
 *   - only a lesson whose repair was RE-APPLIED, followed by its own check,
 *     is judged; the last such check decides;
 *   - a lesson recorded or deduped by the same run is not counted twice;
 *   - lessons written before v157 (text only) take part too.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lout-home-"))
process.env.HOME = HOME
delete process.env.FORGE_HOME
delete process.env.FORGE_DATA_DIR

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const L = await import("../lessons.js")

console.log("== what a lesson claims ==")
{
  eq("structured (v157)", L.lessonRepair({ check: "npm test", repair: { files: ["a.js"], commands: ["node s.js"] } }), { check: "npm test", files: ["a.js"], commands: ["node s.js"] })
  eq("v135 text: files", L.lessonRepair({ successful_repair: "changed lib.js, util.js — after which `npm test` passed" }), { check: "npm test", files: ["lib.js", "util.js"], commands: [] })
  eq("v156 text: commands", L.lessonRepair({ successful_repair: "ran `npm ci`, `node setup.js` — after which `make test` passed" }), { check: "make test", files: [], commands: ["npm ci", "node setup.js"] })
  eq("v156 text: both", L.lessonRepair({ successful_repair: "changed lib.js; ran `node setup.js` — after which `npm test` passed" }), { check: "npm test", files: ["lib.js"], commands: ["node setup.js"] })
  eq("an unproven next step claims nothing", L.lessonRepair({ solution: "re-run with a policy that allows the writes" }), null)
  eq("free text claims nothing", L.lessonRepair({ successful_repair: "add the route" }), null)
  eq("a structured lesson with an empty repair claims nothing", L.lessonRepair({ check: "npm test", repair: { files: [], commands: [] } }), null)
}

console.log("== which lessons a run judged ==")
{
  const cwd = "/p"
  const lesson = { id: "L1", check: "npm test", repair: { files: [], commands: ["node setup.js"] } }
  const chk = (passed, commandIndex, writeIndex = 0, command = "npm test") => ({ command, passed, commandIndex, writeIndex })
  const run = (over) => L.lessonOutcomes({ lessons: [lesson], cwd, commandChecks: [], writes: [], commands: [], ...over })
  eq("not re-applied: no signal", run({ commandChecks: [chk(false, 0)], commands: ["npm install"] }), [])
  eq("re-applied, then its check failed: blamed", run({ commands: ["node setup.js"], commandChecks: [chk(false, 1)] }), [{ id: "L1", worked: false, check: "npm test" }])
  eq("re-applied, then its check passed: credited", run({ commands: ["node setup.js"], commandChecks: [chk(true, 1)] }), [{ id: "L1", worked: true, check: "npm test" }])
  eq("re-applied but never checked afterwards: no signal", run({ commands: ["node setup.js"], commandChecks: [chk(false, 0)] }), [])
  eq("the LAST check after it decides", run({ commands: ["node setup.js"], commandChecks: [chk(false, 1), chk(true, 1)] }).map((o) => o.worked), [true])
  eq("…both ways", run({ commands: ["node setup.js"], commandChecks: [chk(true, 1), chk(false, 1)] }).map((o) => o.worked), [false])
  eq("the latest re-application counts: a check between two runs of it does not", run({ commands: ["node setup.js", "x", "node setup.js"], commandChecks: [chk(true, 1), chk(false, 3)] }).map((o) => o.worked), [false])
  eq("…so a check only between them, none after, is no signal", run({ commands: ["node setup.js", "x", "node setup.js"], commandChecks: [chk(true, 1)] }), [])
  eq("a different check says nothing about this lesson", run({ commands: ["node setup.js"], commandChecks: [chk(false, 1, 0, "npm run lint")] }), [])
  eq("a check with no index cannot be placed", run({ commands: ["node setup.js"], commandChecks: [{ command: "npm test", passed: false }] }), [])
  eq("a lesson this run recorded is skipped", run({ commands: ["node setup.js"], commandChecks: [chk(false, 1)], skip: ["L1"] }), [])
  const fileLesson = { id: "F", successful_repair: "changed lib.js — after which `npm test` passed" }
  eq("a file re-written (relative lesson, absolute write) is re-applied", L.lessonOutcomes({ lessons: [fileLesson], cwd, writes: ["/p/lib.js"], commandChecks: [{ command: "npm test", passed: false, writeIndex: 1, commandIndex: 0 }] }).map((o) => o.id), ["F"])
  eq("a write path that is not normalised still matches", L.lessonOutcomes({ lessons: [fileLesson], cwd, writes: ["/p/src/../lib.js"], commandChecks: [{ command: "npm test", passed: true, writeIndex: 1, commandIndex: 0 }] }).map((o) => o.worked), [true])
  eq("…and a check BEFORE that write says nothing", L.lessonOutcomes({ lessons: [fileLesson], cwd, writes: ["/p/lib.js"], commandChecks: [{ command: "npm test", passed: false, writeIndex: 0, commandIndex: 0 }] }), [])
  const both = { id: "B", check: "npm test", repair: { files: ["lib.js"], commands: ["node setup.js"] } }
  eq("both parts re-applied: only a check after BOTH counts", L.lessonOutcomes({ lessons: [both], cwd, writes: ["/p/lib.js"], commands: ["node setup.js"],
    commandChecks: [{ command: "npm test", passed: false, writeIndex: 1, commandIndex: 0 }] }), [])
  eq("unproven lessons are never judged", L.lessonOutcomes({ lessons: [{ id: "U", solution: "node setup.js" }], cwd, commands: ["node setup.js"], commandChecks: [chk(false, 1)] }), [])
}

console.log("== what a judgement does ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lout-"))
  const { id } = L.recordLesson({ failure: "npm test failed 1 time(s) before passing", cause: "x", successfulRepair: "ran `node s.js` — after which `npm test` passed", check: "npm test", repairCommands: ["node s.js"], confidence: 0.7 }, cwd)
  const stored = L.loadLessons(cwd)[0]
  eq("recordLesson stores the structured repair", [stored.check, stored.repair], ["npm test", { files: [], commands: ["node s.js"] }])
  let r = L.recordLessonOutcome(id, false, cwd)
  eq(`blamed: −${L.LESSON_OUTCOME_BLAME}`, [r.from, r.to], [0.7, 0.55])
  r = L.recordLessonOutcome(id, true, cwd)
  eq(`credited: +${L.LESSON_OUTCOME_CREDIT}`, r.to, 0.65)
  const l = L.loadLessons(cwd)[0]
  eq("counts kept", [l.successCount, l.failureCount], [1, 1])
  ok("the prompt line says what re-applying it did", /since: worked 1×, failed 1×/.test(L.lessonLine(l)), L.lessonLine(l))
  for (let i = 0; i < 4; i++) r = L.recordLessonOutcome(id, false, cwd)
  ok(`repeated failure retires it (below ${L.LESSON_RETIRE_BELOW})`, r.retired === true && r.to < L.LESSON_RETIRE_BELOW, JSON.stringify(r))
  eq("…and a retired lesson is no longer offered", L.lessonsForPrompt("npm test failed", { cwd }), "")
  for (let i = 0; i < 12; i++) r = L.recordLessonOutcome(id, true, cwd)
  eq("credit stops at 1", r.to, 1)
  eq("an unknown id changes nothing", L.recordLessonOutcome("nope", true, cwd).ok, false)
  ok("a lesson with no record says nothing extra", !/since:/.test(L.lessonLine({ failure: "f", successful_repair: "r" })))
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== end to end: real headless runs ==")
async function runs(scripts, between = [], files = {}, maxSteps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lout-e2e-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), `const fs = require("fs")\nif (!fs.existsSync("config.json")) { console.error("config.json is missing"); process.exit(1) }\n`)
  fs.writeFileSync(path.join(work, "setup.js"), `require("fs").writeFileSync("config.json", "{}")\n`)
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(work, f), t)
  let run = 0
  const prompts = []
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      prompts[run] = (prompts[run] ?? "") + `${typeof j.system === "string" ? j.system : JSON.stringify(j.system)}\n`
      const n = (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "tool_result") : []).length
      const cmd = scripts[run - 1]?.[n]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
        ...(cmd ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: "bash", input: { command: cmd } }] } : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const snapshots = [], statuses = []
  const read = () => { try { const pd = path.join(home, ".forge", "projects"); return JSON.parse(fs.readFileSync(path.join(pd, fs.readdirSync(pd)[0], "lessons.json"), "utf8")) } catch { return [] } }
  for (let i = 0; i < scripts.length; i++) {
    run = i + 1
    const rj = path.join(dir, `r${run}.json`)
    const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
      "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", String(maxSteps[i] ?? 8), "--result-json", rj, "--", "make npm test pass"],
      { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
    await new Promise((r) => { const t = setTimeout(() => { c.kill("SIGKILL"); r() }, 30000); c.once("exit", () => { clearTimeout(t); r() }) })
    snapshots.push(read())
    try { statuses.push(JSON.parse(fs.readFileSync(rj, "utf8")).status) } catch { statuses.push(null) }
    between[i]?.(work)
  }
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  fs.rmSync(dir, { recursive: true, force: true })
  return { snapshots, prompts, statuses }
}
const learnIt = ["npm test", "node setup.js", "npm test"]
const breakIt = (w) => {
  fs.rmSync(path.join(w, "config.json"), { force: true })
  fs.writeFileSync(path.join(w, "check.js"), `const fs = require("fs")\nif (!fs.existsSync("config.json") || !fs.existsSync("data.json")) { console.error("config.json is missing"); process.exit(1) }\n`)
}
const setupLesson = (snap) => snap.find((l) => /ran `node setup\.js`/.test(String(l.successful_repair ?? "")))
{
  const r = await runs([learnIt, learnIt, ["npm test"]], [breakIt])
  const [a, b] = [setupLesson(r.snapshots[0]), setupLesson(r.snapshots[1])]
  eq("learned at 0.7", a?.confidence, 0.7)
  eq("re-applied and still failing: blamed once", [b?.confidence, b?.failureCount], [0.55, 1])
  ok("the next run is told it failed since", /since: worked 0×, failed 1×/.test(r.prompts[3] ?? ""), (r.prompts[3] ?? "").slice(0, 200))
  const c = setupLesson(r.snapshots[2])
  eq("a run that did NOT re-apply it leaves it alone", [c?.confidence, c?.failureCount], [0.55, 1])
}
{
  // Run 2 re-applies it and it works again — the run also re-learns the same
  // lesson (recordLesson dedup credits it). It must be credited ONCE.
  const r = await runs([learnIt, learnIt], [(w) => fs.rmSync(path.join(w, "config.json"), { force: true })])
  const b = setupLesson(r.snapshots[1])
  eq("worked again: credited once, not twice", [b?.confidence, b?.successCount], [0.8, 1])
  eq("…and still one lesson", r.snapshots[1].length, 1)
}

{
  // The run that re-applies a lesson and still fails usually does NOT
  // complete. It runs out of steps here — and the lesson is blamed anyway.
  const r = await runs([learnIt, [...learnIt, "npm test", "npm test"]], [breakIt], {}, [8, 3])
  ok("run 2 did not complete", r.statuses[1] && r.statuses[1] !== "COMPLETED", String(r.statuses[1]))
  const b = setupLesson(r.snapshots[1])
  eq("…and the lesson is blamed all the same", [b?.confidence, b?.failureCount], [0.55, 1])
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== lesson-outcome suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
