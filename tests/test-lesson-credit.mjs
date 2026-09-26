#!/usr/bin/env node
// v198 — memory and lessons that stay accurate.
//
// 1. A lesson re-applied twice in one run is judged twice: blamed for the try
//    that failed, credited for the one that passed. Before, only the check
//    after the latest re-application counted, so a repair that failed first
//    was trusted exactly as much as one that worked straight away.
// 2. `forge memory move <n>` moves a note saved in the wrong tier (a project
//    note in global memory, from before v187) with its provenance.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lessoncredit-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
const L = await import("../lessons.js")

console.log("== 1. every re-application is judged ==")
{
  const cwd = "/p"
  const cmdLesson = { id: "C", check: "npm test", repair: { files: [], commands: ["node setup.js"] } }
  const chk = (passed, commandIndex, writeIndex = 0) => ({ command: "npm test", passed, commandIndex, writeIndex })
  const judge = (lesson, over) => L.lessonOutcomes({ lessons: [lesson], cwd, commandChecks: [], writes: [], commands: [], ...over }).map((o) => o.worked)
  eq("re-applied, failed; re-applied again, passed: blamed once, credited once",
    judge(cmdLesson, { commands: ["node setup.js", "vi x", "node setup.js"], commandChecks: [chk(false, 1), chk(true, 3)] }), [false, true])
  eq("…the other way round too", judge(cmdLesson, { commands: ["node setup.js", "node setup.js"], commandChecks: [chk(true, 1), chk(false, 2)] }), [true, false])
  eq("within one re-application the last check decides (a fix to something else, then a pass)",
    judge(cmdLesson, { commands: ["node setup.js", "vi other.js"], commandChecks: [chk(false, 1), chk(true, 2)] }), [true])
  eq("three re-applications, three verdicts",
    judge(cmdLesson, { commands: ["node setup.js", "node setup.js", "node setup.js"], commandChecks: [chk(false, 1), chk(false, 2), chk(true, 3)] }), [false, false, true])
  eq("a re-spelled repair is the same re-application (npm i / npm install)",
    judge({ id: "N", check: "npm test", repair: { files: [], commands: ["npm i"] } }, { commands: ["npm install", "npm i"], commandChecks: [chk(false, 1), chk(true, 2)] }), [false, true])
  eq("a check before any re-application says nothing", judge(cmdLesson, { commands: ["ls", "node setup.js"], commandChecks: [chk(false, 1), chk(true, 2)] }), [true])

  const both = { id: "B", check: "npm test", repair: { files: ["lib.js"], commands: ["node setup.js"] } }
  const at = (passed, writeIndex, commandIndex) => ({ command: "npm test", passed, writeIndex, commandIndex })
  eq("two parts: a check halfway through re-applying is not a verdict",
    judge(both, { writes: ["/p/lib.js"], commands: ["node setup.js"], commandChecks: [at(false, 1, 0), at(true, 1, 1)] }), [true])
  eq("…in either order (the command first, then the file)",
    judge(both, { writes: ["/p/lib.js"], commands: ["node setup.js"], commandChecks: [at(false, 0, 1), at(true, 1, 1)] }), [true])
  eq("two parts, re-applied whole twice: two verdicts",
    judge(both, { writes: ["/p/lib.js", "/p/lib.js"], commands: ["node setup.js", "node setup.js"], commandChecks: [at(false, 1, 1), at(true, 2, 2)] }), [false, true])
  eq("two parts, the second time only one of them: the last check still judges the whole",
    judge(both, { writes: ["/p/lib.js", "/p/lib.js"], commands: ["node setup.js"], commandChecks: [at(false, 1, 1), at(true, 2, 1)] }), [false, true])
}

console.log("== 2. what two verdicts do to a lesson ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lessoncredit-proj-"))
  const r = L.recordLesson({ failure: "npm test failed", check: "npm test", repairCommands: ["node setup.js"], successful_repair: "ran `node setup.js` — after which `npm test` passed" }, cwd)
  const id = r?.id ?? r?.lesson?.id ?? L.loadLessons(cwd)[0]?.id
  const before = L.loadLessons(cwd).find((x) => x.id === id)
  for (const o of L.lessonOutcomes({ lessons: L.loadLessons(cwd), cwd, commands: ["node setup.js", "node setup.js"], commandChecks: [{ command: "npm test", passed: false, commandIndex: 1, writeIndex: 0 }, { command: "npm test", passed: true, commandIndex: 2, writeIndex: 0 }] })) L.recordLessonOutcome(o.id, o.worked, cwd)
  const after = L.loadLessons(cwd).find((x) => x.id === id)
  ok("the failure and the success are both counted", after?.failureCount === 1 && after?.successCount === 1, JSON.stringify(after))
  ok("…so it ends less trusted than it started (blame outweighs credit)", after.confidence < Number(before.confidence), `${before.confidence} → ${after.confidence}`)
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== 3. forge memory move ==")
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-memmove-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-memmove-agentv19-"))
  const forge = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "memory", ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, encoding: "utf8" })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  forge("add", "the user prefers tabs")
  forge("add", "the project files in this repo live under src/app")
  const globalFile = () => fs.readFileSync(path.join(home, "memory.md"), "utf8")
  const projectList = () => forge("list", "--project").out
  const moved = forge("move", "2")
  ok("global → this project: it says so", moved.code === 0 && /moved from global to this project's .* memory: the project files in this repo live under src\/app/.test(moved.out), moved.out)
  ok("…the note is in project memory now", /the project files in this repo live under src\/app/.test(projectList()), projectList())
  ok("…and gone from global memory, the other note kept", !/src\/app/.test(globalFile()) && /the user prefers tabs/.test(globalFile()), globalFile())
  const projects = path.join(home, "projects")
  const proj = fs.readdirSync(projects, { recursive: true }).map(String).filter((f) => /memory\.md$/.test(f)).map((f) => fs.readFileSync(path.join(projects, f), "utf8")).join("\n")
  ok("…with its provenance", /<!-- forge: source=cli/.test(proj) && /src\/app/.test(proj), proj)
  forge("add", "the user prefers tabs", "--project")
  const back = forge("move", "2", "--project")
  ok("with --project: project → global; a note already there is not written twice", back.code === 0 && /moved from project to global memory \(it was already there\)/.test(back.out) && globalFile().split("the user prefers tabs").length === 2, back.out + globalFile())
  fs.writeFileSync(path.join(home, "memory.md"), fs.readFileSync(path.join(home, "memory.md"), "utf8") + "- a hand-written note about this repo\n")
  forge("move", "2")
  const handMoved = fs.readdirSync(projects, { recursive: true }).map(String).filter((f) => /memory\.md$/.test(f)).map((f) => fs.readFileSync(path.join(projects, f), "utf8")).join("\n")
  ok("a note with no provenance (written by hand) gets one when it moves", /<!-- forge: source=cli[^\n]*-->\n- a hand-written note about this repo/.test(handMoved), handMoved)
  const bad = forge("move", "9")
  ok("no such entry: an error naming how many there are, nothing changed", bad.code === 1 && /no entry 9 \(1 in global memory\)/.test(bad.out) && /the user prefers tabs/.test(globalFile()), bad.out)
  ok("`move` is in the usage", /move <n>/.test(forge("bogus").out))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== lesson-credit suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
