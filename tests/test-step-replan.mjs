#!/usr/bin/env node
/**
 * Recovery level 3 — step-level replan (REPLAN_STEP), on the real controller.
 *
 * Before: a step whose repair did not recover it escalated straight to a
 * task-level replan (level 4); recovery.js listed level 3 as "reserved".
 * Now the controller first revises THAT step's objective (dag.reviseNode,
 * metareplan tryStepReplan), keeps the rest of the graph and every completed
 * node, records level 3 in the task's recovery log, and records the replaced
 * objective as a rejected approach. A step that fails again after its
 * revision escalates to the task-level replan, as before.
 *
 * The runMeta tests inject a scripted agent (runMeta's runAgent option), the
 * same way test-execution-controller drives the controller. Zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-step-replan-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-step-replan-work-"))
process.chdir(WORK)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const dag = await import("../dag.js")
const R = await import("../replan.js")
const meta = await import("../meta.js")

console.log("== dag.reviseNode ==")
{
  const g = dag.buildDAG([
    { id: "n1", objective: "inspect the parser" },
    { id: "n2", objective: "implement the parser with a regex split", dependencies: ["n1"] },
    { id: "n3", objective: "wire the cli to the parser", dependencies: ["n2"] },
  ])
  dag.markRunning(g, "n1"); dag.markCompleted(g, "n1", null, { requireVerification: false })
  dag.markRunning(g, "n2"); dag.markFailed(g, "n2", "tests still red")
  const r = dag.reviseNode(g, "n2", { objective: "implement the parser as a character state machine", reason: "tests still red" })
  eq("a failed step is revised", r, { ok: true, revision: 1 })
  const n2 = g.nodes.get("n2")
  eq("…its objective is the new one", n2.objective, "implement the parser as a character state machine")
  eq("…it is ready to run again (its dependency is complete)", n2.status, dag.NODE_STATUS.READY)
  eq("…its error is cleared", n2.error, null)
  eq("…the replaced objective and why are kept", n2.revisions.map((x) => [x.from, x.reason]), [["implement the parser with a regex split", "tests still red"]])
  eq("…its dependencies and dependents are untouched", [n2.dependencies, g.nodes.get("n3").dependencies], [["n1"], ["n2"]])
  eq("…completed work stays completed", g.nodes.get("n1").status, dag.NODE_STATUS.COMPLETED)
  const back = dag.deserializeDAG(dag.serializeDAG(g)).nodes.get("n2")
  eq("revisions survive a save and resume", back.revisions.map((x) => x.from), ["implement the parser with a regex split"])
  eq("a completed step cannot be revised", dag.reviseNode(g, "n1", { objective: "something else" }).ok, false)
  eq("an unchanged objective is not a revision", dag.reviseNode(g, "n3", { objective: "  wire the cli to the parser " }).error, "objective unchanged")
  eq("an empty objective is refused", dag.reviseNode(g, "n3", { objective: "  " }).error, "empty objective")
  eq("an unknown node is refused", dag.reviseNode(g, "nope", { objective: "x" }).ok, false)
}

console.log("== the step-replan prompt and its answer ==")
{
  const p = R.stepReplanPrompt({ objective: "make quoted commas parse", step: "implement the parser with a regex split", error: "TEST_FAILURE: quoted comma split", rejected: [{ text: "patch the tokenizer with indexOf" }], contradicted: [{ text: "the parser lives in parse.js" }] })
  ok("names the failed step and why", /The step: implement the parser with a regex split/.test(p) && /Why it failed: TEST_FAILURE: quoted comma split/.test(p))
  ok("carries this task's rejected approaches and contradicted assumptions", /patch the tokenizer with indexOf/.test(p) && /the parser lives in parse\.js/.test(p))
  ok("asks for one revised step, not execution", /Rewrite ONLY this step as ONE line/.test(p) && /Do NOT execute/.test(p))
  eq("the answer's first line, numbering removed", R.parseStepRevision("1. Implement the parser as a state machine\n2. extra"), "Implement the parser as a state machine")
  eq("a 'Step:' label is removed", R.parseStepRevision("Step: use the csv module"), "use the csv module")
  eq("an answer that repeats the failed step is not a revision", R.parseStepRevision("- implement the parser with a regex split", "Implement the parser with a regex split"), null)
  eq("an empty answer is no revision", R.parseStepRevision("\n  \n"), null)
}

const CFG = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
const OBJECTIVE = "make the csv parser handle quoted commas and wire the csv parser into the cli"
// the plan echoes the objective's own terms so the plan-quality critique has
// nothing to revise — this suite measures recovery, not the critique
const PLAN = "1. inspect the csv parser and the cli\n2. implement the csv parser quoted commas with a regex split\n3. wire the csv parser into the cli\n4. verify the csv parser handles quoted commas in the cli"

function scripted({ revisionWorks }) {
  const seen = { stepPrompts: [], taskReplans: 0, revisedRuns: 0 }
  const fake = async (args) => {
    const t = String(args.task ?? "")
    if (args.planOnly) {
      if (/ONE STEP of the plan failed/.test(t)) { seen.stepPrompts.push(t); return { text: "implement the csv parser quoted commas as a character state machine", toolRecords: [], commandChecks: [], toolLog: [] } }
      if (/The current plan is NOT working/.test(t)) { seen.taskReplans++; return { text: "1. implement the csv parser quoted commas with the csv module\n2. wire the csv parser into the cli", toolRecords: [], commandChecks: [], toolLog: [] } }
      return { text: PLAN, toolRecords: [], commandChecks: [], toolLog: [] }
    }
    const err = (e) => ({ status: "FAILED", error: e, text: "", steps: 2, toolRecords: [], commandChecks: [], toolLog: [], budgetHit: false })
    if (/regex split/.test(t) || /quoted comma split/.test(t)) return err("TEST_FAILURE: quoted comma split across fields")
    if (/state machine/.test(t)) { seen.revisedRuns++; return revisionWorks ? { text: "done: verified — quoted commas parse", budgetHit: false, steps: 3, toolRecords: [], commandChecks: [], toolLog: [] } : err("TEST_FAILURE: state machine drops the last field") }
    return { text: "done: verified", budgetHit: false, steps: 2, toolRecords: [], commandChecks: [], toolLog: [] }
  }
  return { fake, seen }
}

console.log("== the controller revises the failed step, not the whole plan ==")
{
  const { fake, seen } = scripted({ revisionWorks: true })
  const events = []
  const r = await meta.runMeta({ config: CFG, provider: { name: "x", model: "m" }, task: OBJECTIVE, runAgent: fake, workers: false, maxSegments: 14, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  const step = events.find((e) => e.type === "STEP_REPLANNED" && e.ok)
  ok("a STEP_REPLANNED event revised the failing step", step && /regex split/.test(step.from) && /state machine/.test(step.to), JSON.stringify(step ?? events.filter((e) => /REPLAN/.test(e.type)).map((e) => e.type)))
  ok("the step prompt carried the failure", seen.stepPrompts.some((p) => /quoted comma split across fields/.test(p)))
  ok("the revised step actually ran", seen.revisedRuns >= 1, `revisedRuns=${seen.revisedRuns}`)
  eq("no task-level replan was needed", seen.taskReplans, 0)
  const log = r.task?.recovery_log ?? []
  ok("recovery level 3 is in the task's recovery log", log.some((x) => x.level === 3 && x.kind === "step-replan"), JSON.stringify(log.map((x) => [x.level, x.kind])))
  eq("the task completed", r.status, "COMPLETED")
  const und = r.task?.understanding
  ok("the replaced objective is a rejected approach in the understanding", (und?.rejected_approaches ?? und?.rejected ?? []).some((x) => /regex split/.test(x.text)), JSON.stringify(und?.rejected_approaches ?? und?.rejected ?? null).slice(0, 200))
}

console.log("== a revised step that fails again escalates to the task replan ==")
{
  const { fake, seen } = scripted({ revisionWorks: false })
  const events = []
  const r = await meta.runMeta({ config: CFG, provider: { name: "x", model: "m" }, task: OBJECTIVE, runAgent: fake, workers: false, maxSegments: 14, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  eq("the step was revised once (MAX_STEP_REVISIONS)", events.filter((e) => e.type === "STEP_REPLANNED" && e.ok).length, R.MAX_STEP_REVISIONS)
  ok("then the whole plan was replanned (level 4)", seen.taskReplans >= 1 && events.some((e) => e.type === "PLAN_REPLAN_STARTED"), `taskReplans=${seen.taskReplans}`)
  const replanPrompt = events.find((e) => e.type === "PLAN_REPLAN_STARTED")
  ok("…and the task replan was told the revised step's failure too", replanPrompt && (replanPrompt.failedSteps ?? []).some((f) => /state machine/.test(f.objective)), JSON.stringify(replanPrompt?.failedSteps ?? null).slice(0, 200))
  // the task replan's approach (the csv module) succeeds in this script, so
  // the task completes — through the replanned graph, after both failures
  eq("the task completed through the task-level replan", r.status, "COMPLETED")
  ok("…which came after the revised step failed", events.findIndex((e) => e.type === "STEP_REPLANNED" && e.ok) < events.findIndex((e) => e.type === "PLAN_REPLAN_STARTED"))
}

console.log(`\n== step-replan suite: ${PASS} passed, ${FAIL} failed ==`)
fs.rmSync(HOME, { recursive: true, force: true })
process.exit(FAIL ? 1 : 0)
