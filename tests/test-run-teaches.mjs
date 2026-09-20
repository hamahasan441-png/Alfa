#!/usr/bin/env node
/**
 * forge — a run that ends blocked leaves knowledge behind (v132).
 *
 * The learning loop had a READ side and no WRITE side.
 *
 *   read   context.js:265  lessonsForPrompt(task, …)   → every run's prompt
 *          compose.js:177  relevantLessons(task, …)    → hard-avoid list
 *   write  meta.js         recordLesson(…)             → multi-segment runs only
 *          tools.js:2241   recordLearning(…)           → only if the MODEL
 *                                                        remembers to call it
 *
 * So a plain `runAgent` run — the commonest path there is — that ran out of
 * completion attempts, or had every mutation refused, left nothing behind. The
 * next run read an empty file and walked into the same wall. `forge` was
 * reading its own notes and never writing any.
 *
 * Two things had to be true for the loop to actually close, and only one of
 * them was about the writer:
 *
 *   1. runAgent must record on the two outcomes worth warning about.
 *   2. The reader must be able to RENDER what gets recorded. It could not:
 *      `lessonPool({needRepair:true})` admits a lesson on `successful_repair`
 *      OR `solution`, and `formatLessons` printed only the former — so a
 *      lesson carrying just a `solution` rendered as
 *      "fix that worked: " with nothing after the colon.
 *
 * A blocked run has no proven repair, so it is exactly the case that hit (2).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-teach-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const L = await import("../lessons.js")
const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-teach-proj-"))

console.log("== the defect: a lesson with only a `solution` rendered as an empty fix ==")
{
  const cwd = proj()
  L.recordLesson({ failure: "build broke", cause: "a missing export", solution: "add the export", task: "fix the build" }, cwd)
  const out = String(L.lessonsForPrompt("fix the build", { cwd }) ?? "")
  ok("the lesson is retrieved at all", out.includes("build broke"), out)
  ok("…and its one piece of knowledge survives the render", out.includes("add the export"), out)
  ok("…which it did NOT before: 'fix that worked:' with nothing after it",
    !/fix that worked:\s*$/m.test(out) && !/fix that worked:\s*•/.test(out), out)
}

console.log("== a proven repair and an unproven next step are not the same claim ==")
{
  const cwd = proj()
  L.recordLesson({ failure: "tests red", cause: "off-by-one", successfulRepair: "fixed the loop bound", task: "make tests pass" }, cwd)
  L.recordLesson({ failure: "run ended BLOCKED", cause: "the gate never cleared", solution: "run the covering check first", task: "make tests pass" }, cwd)
  const out = String(L.lessonsForPrompt("make tests pass", { cwd, limit: 5 }) ?? "")
  ok("a proven repair still reads as one", /fix that worked: fixed the loop bound/.test(out), out)
  ok("…and an unproven one says so, instead of borrowing the same words",
    /not repaired — the next step recorded was: run the covering check first/.test(out), out)
  ok("the model is never told a hypothesis is a fix",
    !/fix that worked: run the covering check first/.test(out), out)
}

console.log("== a lesson with neither is honest rather than blank ==")
{
  const cwd = proj()
  // it cannot reach lessonsForPrompt (needRepair filters it out), but the
  // renderer must not produce a dangling colon if it ever does
  const line = L.lessonsForPrompt("anything", { cwd })
  eq("no lessons → no block at all, never an empty header", line, "")
}

console.log("== runAgent records on the two outcomes worth warning about ==")
{
  const src = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("the writer is wired into the run's end", /const \{ recordLesson \} = await import\("\.\/lessons\.js"\)/.test(src))
  ok("…and only for a run that did NOT complete",
    /resStatus !== "COMPLETED" && \(lastCompletionBlocker \|\| refusedOnly\)/.test(src))
  ok("…never from a read-only, plan-only or verifier run",
    /!readonly && !planOnly && !verifier &&/.test(src))
  // `resStatus` becomes "WAITING_FOR_USER", which satisfies `!== "COMPLETED"`.
  // A run PAUSED on a human decision has not failed at anything, and recording
  // "run ended WAITING_FOR_USER on <blocker>" would persist a non-failure and
  // then surface it in later prompts as something to avoid.
  ok("…and never from a run that is merely WAITING for a user decision",
    /!verifier && !waitingForUser && resStatus !== "COMPLETED"/.test(src))
  ok("it records the gate's own next step, not an invented repair",
    /solution: refusedOnly/.test(src) && /completionVerdict\?\.next/.test(src))
  ok("…and never claims a successful repair", !/successfulRepair:[\s\S]{0,80}completionVerdict/.test(src))
  ok("it is low-confidence, because it is an observation", /confidence: 0\.35/.test(src))
  ok("a failure to record never changes the verdict",
    /catch \{ \/\* a lesson is a by-product; it never changes the verdict \*\/ \}/.test(src))

  // the READ side it feeds — unchanged, and the reason the write side matters
  const ctx = fs.readFileSync(path.join(ROOT, "context.js"), "utf8")
  ok("every run's prompt already reads lessons back", /lessonsForPrompt\(task, \{ cwd/.test(ctx))
}

console.log("== the recorded shape is the one the reader accepts ==")
{
  // the end-to-end contract, driven through the exact two functions the two
  // sides use: whatever agent.js writes must come back out of the prompt reader
  const cwd = proj()
  const task = "add a retry to the uploader"
  L.recordLesson({
    failure: "run ended BLOCKED on NO_ANSWER",
    cause: "the completion gate refused 3 time(s) and the blocker never cleared",
    failedStrategy: "tools used: read_file, edit_file",
    applicableContext: task, task,
    rootCause: "NO_ANSWER",
    solution: "state the outcome in the final message",
    confidence: 0.35,
  }, cwd)
  const back = String(L.lessonsForPrompt(task, { cwd }) ?? "")
  ok("it comes back out of the reader", back.includes("NO_ANSWER"), back)
  ok("…with the next step intact", back.includes("state the outcome in the final message"), back)
  ok("…and is ranked against the task, not returned blindly",
    !String(L.lessonsForPrompt("unrelated question about tax law", { cwd }) ?? "").includes("NO_ANSWER"))

  // 0.35 must clear the retire floor, or the write side would be a no-op
  ok(`the recorded confidence clears the retire floor (${L.LESSON_RETIRE_BELOW})`, 0.35 >= L.LESSON_RETIRE_BELOW)
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== run-teaches suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
