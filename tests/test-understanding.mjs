/**
 * Alpha Final — the canonical understanding (understanding.js) and its
 * runtime wiring: cognition (both engines), the controller (events, task
 * record, workers, reviewer, completion, continue), the single loop, and
 * `forge tasks --show`. Zero network, isolated HOME.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { controllerSource } from "./controller-source.mjs"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-und-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-und-work-"))
process.chdir(WORK)
const here = path.dirname(fileURLToPath(import.meta.url))
const U = await import("../understanding.js")
const { createUserModel } = await import("../usermodel.js")
const { deriveGoalContract } = await import("../goal-contract.js")
const { createCognition } = await import("../cognition.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const derive = (text) => U.deriveUnderstanding(text, { user: createUserModel().understand(text), goal: deriveGoalContract(text) })
const kinds = (u, kind) => u.items.filter((x) => x.kind === kind)

// ---- 1-3, 5, 7, 13: derivation ----------------------------------------------
await t("explicit requirements, prohibitions and acceptance are EXPLICIT; whole sentences, not fragments", () => {
  const u = derive("Now add a --parallel flag to forge queue run and make sure `npm test` passes. Do not change worktree.js.")
  assert.deepEqual(kinds(u, U.UKIND.PROHIBITION).map((x) => [x.text, x.type, x.priority]), [["Do not change worktree.js.", "EXPLICIT", "HIGH"]])
  assert.deepEqual(kinds(u, U.UKIND.REQUIREMENT).map((x) => x.text), ["Now add a --parallel flag to forge queue run"])
  assert.deepEqual(kinds(u, U.UKIND.ACCEPTANCE).map((x) => x.text), ["make sure `npm test` passes."])
  assert.equal(kinds(u, U.UKIND.DELIVERABLE).some((x) => x.text === "worktree.js"), false, "a forbidden file is not a deliverable")
})
await t("temporal: 'we already implemented X' is context, never a request", () => {
  const u = derive("We already implemented the queue. Now add retries to it.")
  const past = kinds(u, U.UKIND.CONTEXT).filter((x) => x.temporal === U.TEMPORAL.PAST)
  assert.deepEqual(past.map((x) => x.text), ["We already implemented the queue."])
  assert.ok(!kinds(u, U.UKIND.REQUIREMENT).some((x) => /implemented the queue/.test(x.text)))
  assert.ok(kinds(u, U.UKIND.REQUIREMENT).some((x) => /add retries/.test(x.text)))
  const c = derive("continue with the parser work")
  assert.ok(kinds(c, U.UKIND.CONTEXT).some((x) => x.temporal === U.TEMPORAL.CONTINUE))
})
await t("ambiguity: interpretations named, the smallest assumption recorded as ASSUMED with a confidence", () => {
  const u = derive("Make continue better.")
  assert.ok(kinds(u, U.UKIND.AMBIGUITY).length >= 1)
  const a = kinds(u, U.UKIND.ASSUMPTION)
  assert.ok(a.length >= 1 && a.every((x) => x.type === "ASSUMED" && x.confidence < 0.8))
  assert.ok(u.intent.confidence < 0.6)
})
await t("implicit requirements are INFERRED, never EXPLICIT", () => {
  const u = derive("Fix the crash in src/parse.js when the input is empty.")
  const imp = kinds(u, U.UKIND.IMPLICIT)
  assert.ok(imp.length >= 2 && imp.every((x) => x.type === "INFERRED" && x.source.startsWith("engineering default")))
  assert.equal(derive("explain how the parser works").items.filter((x) => x.kind === U.UKIND.IMPLICIT).length, 0, "an explanation implies no code requirements")
})
await t("non-goals, priorities, dependencies, risks", () => {
  const u = derive("Fix the login redirect in src/auth.js. Focus on mobile first. No need to touch the admin pages. Migrate the session table after the fix lands.")
  assert.ok(kinds(u, U.UKIND.NON_GOAL).some((x) => /admin pages/.test(x.text)))
  assert.ok(kinds(u, U.UKIND.PRIORITY).some((x) => /mobile first/.test(x.text)))
  assert.ok(kinds(u, U.UKIND.DEPENDENCY).some((x) => /after the fix/.test(x.text)))
  assert.ok(kinds(u, U.UKIND.RISK).length >= 1)
})
await t("contradictions inside the request are CONTRADICTED questions", () => {
  const u = derive("keep the old parser but replace the parser with the new one")
  const q = u.items.filter((x) => x.type === "CONTRADICTED")
  assert.equal(q.length, 1); assert.match(q[0].text, /"parser" — which wins/)
})
await t("no acceptance stated → an INFERRED success criterion from the first requirement", () => {
  const u = derive("Add a health endpoint to the API.")
  const s = kinds(u, U.UKIND.SUCCESS)
  assert.equal(s.length, 1); assert.equal(s[0].type, "INFERRED"); assert.match(s[0].text, /health endpoint/)
})

// ---- 8-12, 16, 19, 20: evolution --------------------------------------------
await t("plan, progress and drift: a step that shares nothing with the goal is flagged", () => {
  const u = derive("Add pagination to the users endpoint.")
  U.observe(u, { type: "DAG_BUILT", graph: { nodes: [{ id: "a", title: "Inspect the users endpoint" }, { id: "b", title: "Add pagination to users endpoint" }, { id: "c", title: "Redesign marketing homepage typography carousel" }] } })
  U.observe(u, { type: "DAG_NODE_STARTED", nodeId: "a" }); U.observe(u, { type: "DAG_NODE_COMPLETED", nodeId: "a" })
  assert.deepEqual(u.state.completed, ["a"]); assert.deepEqual(u.state.pending, ["b", "c"])
  assert.equal(u.drift.length, 1); assert.equal(u.drift[0].step, "c")
})
await t("a passing named check VERIFIES the acceptance item and becomes project knowledge", () => {
  const u = derive("Add retries and make sure `npm test` passes.")
  U.observe(u, { type: "command_check", command: "npm test -- --runInBand", passed: true, exitCode: 0 })
  const acc = kinds(u, U.UKIND.ACCEPTANCE)[0]
  assert.equal(acc.type, "VERIFIED"); assert.ok(acc.confidence >= 0.95)
  assert.ok(u.knowledge.some((k) => /npm test -- --runInBand/.test(k.text)), "knowledge, separate from state")
  assert.equal(u.state.checks.passed, 1)
})
await t("self-correction: a failed check touching an assumption CONTRADICTS it", () => {
  const u = derive("Make the cache faster.")
  u.items.push({ id: "x1", kind: U.UKIND.ASSUMPTION, text: "the cache lives in src/cache.js", type: "ASSUMED", confidence: 0.6, subject: "src/cache.js", evidence: [], source: "test", temporal: "current" })
  U.observe(u, { type: "command_check", command: "node --test test/cache.test.js", passed: false, exitCode: 1, tail: "Error: Cannot find module 'src/cache.js'" })
  const it = u.items.find((x) => x.id === "x1")
  assert.equal(it.type, "CONTRADICTED"); assert.ok(it.confidence <= 0.2)
  assert.equal(u.corrections.length, 1); assert.match(u.corrections[0].why, /failed/)
})
await t("decisions carry reason/evidence/confidence; failed strategies become rejected approaches", () => {
  const u = derive("Fix the flaky upload test.")
  U.observe(u, { type: "STRATEGY_CHANGED", reason: "avoiding 1 previously-ineffective approach", avoided: ["raise the timeout"], nodeId: "n2" })
  U.observe(u, { type: "PLAN_REPLANNED", ok: true, reason: "verification" })
  U.observe(u, { type: "GOAL_REINTERPRETATION", to: "fix the upload race", reason: "requirement change on resume", version: 2, evidence: "user said so" })
  assert.deepEqual(u.rejected.map((r) => r.text), ["raise the timeout"])
  assert.deepEqual(u.decisions.map((d) => d.decision), ["changed strategy", "re-planned", "goal reinterpreted (v2)"])
  assert.equal(u.decisions[0].affected, "n2"); assert.equal(u.intent.goal, "fix the upload race")
  assert.equal(u.intent.said, "Fix the flaky upload test.", "the original is never replaced")
})

// ---- 24: completion levels ---------------------------------------------------
await t("implemented ≠ tested ≠ verified ≠ accepted ≠ complete", () => {
  const u = derive("Add retries and make sure `npm test` passes.")
  assert.equal(U.completion(u, {}).level, "NOT_STARTED")
  assert.equal(U.completion(u, { changedFiles: ["a.js"] }).level, "IMPLEMENTED")
  U.observe(u, { type: "command_check", command: "npm run lint", passed: false, exitCode: 1 })
  assert.equal(U.completion(u, { changedFiles: ["a.js"] }).level, "TESTED")
  U.observe(u, { type: "command_check", command: "npm run build", passed: true, exitCode: 0 })
  const v = U.completion(u, { changedFiles: ["a.js"] })
  assert.equal(v.level, "VERIFIED"); assert.match(v.why, /1 acceptance criterion\(s\) not checked/)
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.equal(U.completion(u, { changedFiles: ["a.js"], gateOk: true }).level, "COMPLETE")
  assert.equal(U.completion(u, { changedFiles: ["a.js"], acceptance: [{ status: "FAILED" }] }).level, "VERIFIED")
})
await t("an open contradiction keeps a task short of COMPLETE", () => {
  const u = derive("keep the old parser but replace the parser with the new one")
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.equal(U.completion(u, { changedFiles: ["p.js"], acceptance: [], gateOk: true }).level, "ACCEPTED")
})

// ---- 21, 25: prompt block and continue ---------------------------------------
await t("the prompt block is structured and keeps the frozen original", () => {
  const u = derive("We already implemented the queue. Add retries to it. Do not change worktree.js.")
  const b = U.formatForPrompt(u, { intents: [{ version: 1, text: "We already implemented the queue. Add retries to it. Do not change worktree.js." }, { version: 2, text: "add retries with backoff", reason: "user correction" }] })
  for (const re of [/^UNDERSTANDING/, /Intent v1 \(original\)/, /Intent v2 \(user correction\)/, /never silent substitution/, /- must not:\n  \[EXPLICIT\] Do not change worktree\.js\./, /already done \(context, not a request\)/, /IMPLEMENTED ≠ TESTED ≠ VERIFIED ≠ ACCEPTED ≠ COMPLETE/]) assert.match(b, re)
  assert.ok(U.formatForPrompt(u, { compact: true }).length < b.length)
})
await t("continue: what we were doing, done, verified, remaining, do-not-retry, next", () => {
  const u = derive("Add pagination to the users endpoint and make sure `npm test` passes.")
  U.observe(u, { type: "DAG_BUILT", graph: { nodes: [{ id: "a", title: "Inspect users endpoint" }, { id: "b", title: "Add pagination to users endpoint" }, { id: "c", title: "Run npm test" }] } })
  U.observe(u, { type: "DAG_NODE_COMPLETED", nodeId: "a" })
  U.observe(u, { type: "STRATEGY_CHANGED", reason: "x", avoided: ["offset paging"] })
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  const b = U.resumeBrief(u, { status: "INTERRUPTED" })
  for (const re of [/^CONTINUING A TASK/, /do not redo finished steps/, /where it stopped: INTERRUPTED/, /already done: Inspect users endpoint/, /verified: make sure `npm test` passes/, /remaining: Add pagination to users endpoint; Run npm test/, /do not retry: offset paging/, /next: continue with "Add pagination to users endpoint"/]) assert.match(b, re)
})
await t("view() uses the spec's field names; restore accepts only our own records", () => {
  const u = derive("Add a health endpoint. Do not change server.js.")
  const v = U.view(u)
  for (const k of ["user_intent", "actual_goal", "requested_outcome", "deliverables", "constraints", "explicit_requirements", "implicit_requirements", "non_goals", "priorities", "assumptions", "unknowns", "ambiguities", "risks", "dependencies", "success_criteria", "acceptance_criteria", "relevant_context", "current_state", "expected_state", "decisions", "rejected_approaches", "evidence", "confidence", "unresolved_questions"]) assert.ok(k in v, k)
  const round = U.restoreUnderstanding(JSON.parse(JSON.stringify(u)))
  assert.equal(round.intent.said, u.intent.said)
  assert.equal(U.restoreUnderstanding({ v: 99 }), null); assert.equal(U.restoreUnderstanding("x"), null)
})

// ---- wiring: cognition (both engines) ----------------------------------------
await t("cognition holds ONE understanding and its prompt block replaces the user-model + contract pair", () => {
  const cog = createCognition({ cwd: WORK, objective: "Add retries to the uploader and make sure `npm test` passes." })
  cog.boot("Add retries to the uploader and make sure `npm test` passes.")
  assert.ok(cog.understanding()?.items.length > 0)
  const block = cog.promptBlock()
  assert.match(block, /^UNDERSTANDING/m); assert.match(block, /Intent v1 \(original\)/)
  assert.doesNotMatch(block, /^USER MODEL/m); assert.doesNotMatch(block, /^TASK CONTRACT/m)
  cog.observeEvent({ type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.equal(cog.understandingView().acceptance_criteria[0].type, "VERIFIED")
  cog.observeTools([{ name: "edit_file", args: { path: "upload.js" }, result: "ok" }])
  assert.deepEqual(cog.understanding().state.changedFiles, ["upload.js"])
  assert.equal(cog.snapshot().understanding, cog.understanding(), "persisted with cognition.json")
})
await t("cognition resume keeps the learned understanding instead of re-deriving it", () => {
  const cog = createCognition({ cwd: WORK, objective: "Fix the parser." }); cog.boot("Fix the parser.")
  cog.decide({ decision: "use a hand-written lexer", reason: "regex blew up on nesting", confidence: 0.8 })
  const saved = JSON.parse(JSON.stringify(cog.snapshot()))
  const again = createCognition({ cwd: WORK, objective: "Fix the parser.", resume: saved }); again.boot("Fix the parser.")
  assert.equal(again.understanding().decisions[0].decision, "use a hand-written lexer")
  assert.ok(again.events.some((e) => e.type === "UNDERSTANDING_RESTORED"))
})
await t("a changed instruction is recorded as a decision; dropped constraints become open questions", () => {
  const cog = createCognition({ cwd: WORK, objective: "Fix the login bug without changing the public API." }); cog.boot("Fix the login bug without changing the public API.")
  cog.absorbInstruction("Fix the login bug quickly.")
  const u = cog.understanding()
  assert.ok(u.decisions.some((d) => d.decision === "instruction changed"))
  assert.ok(u.items.some((x) => x.kind === "question" && /no longer mentions/.test(x.text)), "the dropped 'without changing the public API' is an open question")
  assert.equal(u.intent.said, "Fix the login bug without changing the public API.", "the original is frozen")
})

// ---- wiring: the controller ---------------------------------------------------
const meta = await import("../meta.js")
const { readTask } = await import("../taskstate.js")
const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
let firstTaskId = null
await t("controller: understanding built at boot, evolved by events, written to the task record", async () => {
  const events = []
  const runAgent = async (o) => (o.planOnly ? { text: "1. inspect\n2. done", toolRecords: [], commandChecks: [], toolLog: [] } : { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] })
  const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "Explain the readme. Do not change README.md.", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  firstTaskId = r.taskId
  const rec = readTask(r.taskId)
  assert.ok(rec.understanding?.items?.length > 0, "on the task record")
  assert.ok(rec.understanding.items.some((x) => x.kind === "prohibition" && /README\.md/.test(x.text)))
  assert.ok(events.some((e) => e.type === "COGNITION_BOOTED"))
  assert.equal(rec.understanding.state.phase, String(r.status).toLowerCase(), "TASK_FINISHED reached the record")
})
await t("controller resume: restores the record's understanding and briefs the first segment", async () => {
  const rec = readTask(firstTaskId)
  // pretend the task stopped half-way, with learned state
  rec.understanding.state.plan = [{ id: "a", title: "inspect README", status: "completed" }, { id: "b", title: "summarise the README sections", status: "pending" }]
  rec.understanding.state.completed = ["a"]; rec.understanding.rejected = [{ text: "paste the whole file", why: "too long", at: 1 }]
  rec.status = "INTERRUPTED"
  fs.writeFileSync(path.join(HOME, "tasks", `${firstTaskId}.json`), JSON.stringify(rec))
  const events = [], prompts = []
  const runAgent = async (o) => { prompts.push(String(o.extraContext ?? "")); return { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] } }
  await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "Explain the readme. Do not change README.md.", resumeTaskId: firstTaskId, runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  const brief = events.find((e) => e.type === "RESUME_BRIEF")
  assert.ok(brief, "RESUME_BRIEF emitted"); assert.match(brief.text, /already done: inspect README/); assert.match(brief.text, /do not retry: paste the whole file/)
  assert.ok(prompts.some((p) => /CONTINUING A TASK/.test(p)), "the first segment was told")
})
await t("controller source: workers and the reviewer get the shared understanding; completion level reported", () => {
  const src = controllerSource()
  assert.match(src, /SHARED UNDERSTANDING \(the whole task, not just your part\)/)
  assert.equal((src.match(/sharedUnderstanding\(\), context \?/g) ?? []).length, 2, "both worker paths (in-process and worktree)")
  assert.match(src, /understanding: \(\(\) => \{ try \{ return cognition\.understandingBlock\(\{ compact: true \}\) \}/)
  assert.match(src, /type: "COMPLETION_LEVEL"/)
  assert.match(src, /Plan BACKWARD from the outcome/, "the planner plans from the acceptance criteria")
  assert.match(src, /resume: resumeRec \? \{ objective: state\.objective, understanding: resumeRec\.understanding \?\? null \}/)
})
await t("reviewer prompt asks about intent, acceptance, must-nots, drift and contradicted assumptions", async () => {
  const { reviewerPrompt } = await import("../codereview.js")
  const p = reviewerPrompt({ objective: "x", facts: { files: [], ledgerFailures: [] }, findings: [], understanding: "UNDERSTANDING …" })
  assert.match(p, /UNDERSTANDING …/); assert.match(p, /actual intent and the acceptance criteria/); assert.match(p, /intent_\*/)
  assert.doesNotMatch(reviewerPrompt({ objective: "x", facts: { files: [], ledgerFailures: [] }, findings: [] }), /actual intent/)
})
await t("single loop and CLI: checks feed the understanding; the completion level is returned and shown", () => {
  const agent = fs.readFileSync(path.join(here, "..", "agent.js"), "utf8")
  assert.match(agent, /cognition\?\.observeEvent\?\.\(\{ type: "command_check"/)
  assert.match(agent, /understanding: understandingOut, error: null/)
  const forge = fs.readFileSync(path.join(here, "..", "forge.js"), "utf8")
  assert.match(forge, /line\("understood"/); assert.match(forge, /completion: \$\{res\.understanding\.completion\.level\}/)
})

// ---- follow-up: live updates in the single loop; one record across sub-runs ----
await t("delta(): only what changed since the last step, as prompt lines", async () => {
  const u = derive("Add retries and make sure `npm test` passes.")
  const t0 = Date.now() - 1
  assert.equal(U.delta(u, Date.now() + 1000), "", "nothing new → nothing said")
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  U.observe(u, { type: "STRATEGY_CHANGED", reason: "x", avoided: ["sleep-based retry"] })
  const d = U.delta(u, t0)
  assert.match(d, /^UNDERSTANDING UPDATE/); assert.match(d, /now VERIFIED: make sure `npm test` passes/); assert.match(d, /rejected approach \(do not retry\): sleep-based retry/)
  const later = Date.now() + 5
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(U.delta(u, later), "")
})
await t("single loop: the per-step directive carries the update once, then stops repeating it", async () => {
  const cog = createCognition({ cwd: WORK, objective: "Add retries and make sure `npm test` passes." }); cog.boot("Add retries and make sure `npm test` passes.")
  cog.next({ steps: 0, writes: 0, unverified: [], inspected: false })
  assert.doesNotMatch(cog.stepDirective(), /UNDERSTANDING UPDATE/)
  await new Promise((r) => setTimeout(r, 5))
  cog.observeEvent({ type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.match(cog.stepDirective(), /UNDERSTANDING UPDATE[\s\S]*now VERIFIED/)
  assert.doesNotMatch(cog.stepDirective(), /UNDERSTANDING UPDATE/, "said once")
})
await t("a sub-run adopts the controller's understanding by reference — never re-derives from its step text", () => {
  const parent = createCognition({ cwd: WORK, objective: "Add pagination to the users endpoint." }); parent.boot("Add pagination to the users endpoint.")
  const shared = parent.understanding()
  const sub = createCognition({ cwd: WORK, objective: "Implement: step b — wire the page parameter", understanding: shared })
  sub.boot("Implement: step b — wire the page parameter")
  assert.equal(sub.understanding(), shared, "the same object")
  assert.equal(sub.understandingAdopted, true); assert.equal(parent.understandingAdopted, false)
  assert.equal(shared.intent.said, "Add pagination to the users endpoint.", "the step text did not replace the task")
  assert.ok(sub.events.some((e) => e.type === "UNDERSTANDING_ADOPTED"))
  sub.observeTools([{ name: "edit_file", args: { path: "users.js" }, result: "ok" }])
  assert.deepEqual(parent.understanding().state.changedFiles, ["users.js"], "a sub-run's work lands in the one record")
})
await t("controller: every sub-run is handed the one understanding; sub-run checks are counted once", async () => {
  const seen = []
  const runAgent = async (o) => { seen.push(o.understanding); return o.planOnly ? { text: "1. inspect\n2. done", toolRecords: [], commandChecks: [], toolLog: [] } : { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] } }
  await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "Explain the readme in detail.", runAgent, signal: new AbortController().signal })
  assert.ok(seen.length >= 1 && seen.every((u) => u && u === seen[0] && u.intent?.said === "Explain the readme in detail."), "the same object for every sub-run")
  const agentSrc = fs.readFileSync(path.join(here, "..", "agent.js"), "utf8")
  assert.match(agentSrc, /if \(!cognition\?\.understandingAdopted\) cognition\?\.observeEvent\?\.\(\{ type: "command_check"/)
  assert.match(agentSrc, /createCognition\(\{ cwd: process\.cwd\(\), objective: task, governorEnforce: yolo\.governorEnforce, understanding \}\)/)
})

// ---- agent.requireCompletion: completion levels as an OPT-IN gate input ----
const { criterionKind } = await import("../combine.js")
const { canCompleteFastPath, FAST_PATH_CHECK } = await import("../completion.js")
await t("criterionKind: only machine-checkable criteria can be enforced", () => {
  assert.equal(criterionKind("make sure `npm test` passes."), "command")
  assert.equal(criterionKind("All tests must pass."), "tests")
  assert.equal(criterionKind("The README explains the flag."), null)
  assert.equal(criterionKind("README.md mentions it."), null, "a file existing is not proof")
})
await t("shortfall(): off / unknown / below VERIFIED is never enforced", () => {
  const u = derive("Fix it.")
  for (const r of [null, "off", "OFF", "nonsense", "IMPLEMENTED", "TESTED"]) assert.equal(U.shortfall(u, r, { level: { level: "NOT_STARTED" } }), null, String(r))
})
await t("shortfall(): VERIFIED — no check, a failing check, and an uncovering check each say what to do", () => {
  const u = derive("Fix the parser.")
  assert.match(U.shortfall(u, "verified", { level: { level: "IMPLEMENTED" } }).reasons[0], /no check has run/)
  U.observe(u, { type: "command_check", command: "npm test", passed: false, exitCode: 1 })
  assert.match(U.shortfall(u, "VERIFIED", { level: { level: "TESTED" } }).reasons[0], /latest check did not pass \(`npm test`\)/)
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.match(U.shortfall(u, "VERIFIED", { level: { level: "TESTED" } }).reasons[0], /do not cover the changed files/)
  assert.equal(U.shortfall(u, "VERIFIED", { level: { level: "VERIFIED" } }), null)
})
await t("shortfall(): ACCEPTED — checkable criteria block until met; prose never blocks", () => {
  const u = derive("Add retries. Make sure `npm test` passes. The README explains the retry flag.")
  const sf = U.shortfall(u, "ACCEPTED", { level: { level: "VERIFIED" } })
  assert.equal(sf.reasons.length, 1, JSON.stringify(sf))
  assert.match(sf.reasons[0], /acceptance not met: Make sure `npm test` passes/)
  U.observe(u, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  assert.equal(U.shortfall(u, "ACCEPTED", { level: { level: "VERIFIED" } }), null, "the prose README criterion does not hold the task")
  // controller form: combine.checkAcceptance rows
  const rows = [{ criterion: "Make sure `npm test` passes.", status: "FAILED", evidence: "`npm test` failed (exit 1)" }, { criterion: "The README explains it.", status: "UNCHECKED", evidence: "prose — no command" }]
  assert.deepEqual(U.shortfall(u, "ACCEPTED", { level: { level: "VERIFIED" }, acceptance: rows }).reasons, ["acceptance FAILED: Make sure `npm test` passes. — `npm test` failed (exit 1)"])
})
await t("'all tests pass' (no command named) is met by a passing test run", () => {
  const u = derive("Fix the bug. All tests must pass.")
  U.observe(u, { type: "command_check", command: "node --check x.js", passed: true, exitCode: 0 })
  assert.ok(U.shortfall(u, "ACCEPTED", { level: { level: "VERIFIED" } }), "a syntax check is not a test run")
  U.observe(u, { type: "command_check", command: "node --test tests/", passed: true, exitCode: 0 })
  assert.equal(U.shortfall(u, "ACCEPTED", { level: { level: "VERIFIED" } }), null)
})
await t("shortfall(): COMPLETE also needs open contradictions resolved", () => {
  const u = derive("Fix it.")
  u.items.push({ id: "q1", kind: U.UKIND.QUESTION, text: "keep the old flag?", type: U.UTYPE.CONTRADICTED, confidence: 0.2, evidence: [] })
  assert.equal(U.shortfall(u, "ACCEPTED", { level: { level: "ACCEPTED" } }), null)
  assert.match(U.shortfall(u, "COMPLETE", { level: { level: "ACCEPTED" } }).reasons[0], /open contradiction: keep the old flag\?/)
})
await t("fast-path gate: a shortfall blocks as COMPLETION_LEVEL_MET; none adds no check", () => {
  const base = { finalText: "done", toolLog: [], commandChecks: [], writeCount: 0 }
  const off = canCompleteFastPath(base)
  assert.equal(off.ok, true); assert.equal(FAST_PATH_CHECK.COMPLETION_LEVEL_MET in off.checks, false, "default shape unchanged")
  const held = canCompleteFastPath({ ...base, completionShortfall: { required: "ACCEPTED", level: "VERIFIED", reasons: ["acceptance not met: x"] } })
  assert.equal(held.ok, false); assert.equal(held.status, "INCOMPLETE")
  assert.match(held.reasons[0], /ACCEPTED required, reached VERIFIED: acceptance not met: x/)
})

{
  const http = await import("node:http")
  const { runAgent } = await import("../agent.js")
  const FIXED = "export function sum(a) { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t }\n"
  const call = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
  const say = (content) => ({ role: "assistant", content })
  async function single(script, agentCfg, extra = {}) {
    let calls = 0
    const seen = []
    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        calls++; seen.push(body)
        const message = script(calls)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reqc-"))
    fs.writeFileSync(path.join(dir, "sum.js"), "export function sum(a) { let t = 0; for (let i = 0; i < a.length - 1; i++) t += a[i]; return t }\n")
    fs.writeFileSync(path.join(dir, "check.mjs"), "import { sum } from './sum.js'\nif (sum([1,2,3]) !== 6) { console.error('FAIL'); process.exit(1) }\nconsole.log('ok')\n")
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", type: "module", scripts: { test: "node check.mjs" } }))
    const events = []
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const r = await runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 10, verifyNudge: false, ...agentCfg } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
        task: "Fix the off-by-one in sum.js. Make sure `npm test` passes.", journal: false, onEvent: (e) => events.push(e), ...extra,
      })
      return { r, calls, seen, events }
    } finally { process.chdir(prev); server.close() }
  }
  // checks its own work, but never runs the check the task named
  const sidestep = (more) => (k) => k === 1 ? call("r", "read_file", { path: "sum.js" })
    : k === 2 ? call("w", "write_file", { path: "sum.js", content: FIXED })
      : k === 3 ? call("c", "bash", { command: "node check.mjs" })
        : k === 4 ? say("Fixed sum.js; the check passes. Complete.")
          : more(k)
  const blocked = (rs) => rs.events.filter((e) => e.type === "COMPLETION_BLOCKED" && e.blocker === "COMPLETION_LEVEL")

  await t("single loop, requireCompletion off (default): unchanged — no push, finishes", async () => {
    const rs = await single(sidestep(() => say("unexpected extra call")), {})
    assert.equal(rs.calls, 4, "no extra model call")
    assert.equal(blocked(rs).length, 0)
    assert.equal(rs.r.status, "COMPLETED")
  })
  await t("single loop, ACCEPTED: one push naming the unmet criterion, the model runs it, the run completes", async () => {
    const rs = await single(sidestep((k) => k === 5 ? call("t", "bash", { command: "npm test" }) : say("`npm test` passes now. Complete.")), { requireCompletion: "accepted" })
    assert.equal(blocked(rs).length, 1)
    assert.match(rs.seen[4], /must reach ACCEPTED before it is done \(it is VERIFIED\)/)
    assert.match(rs.seen[4], /acceptance not met: Make sure `npm test` passes/)
    assert.equal(rs.r.status, "COMPLETED", JSON.stringify(rs.r.completionGate?.reasons))
    assert.equal(rs.r.understanding?.completion?.level, "COMPLETE")
  })
  await t("single loop, ACCEPTED: a model that ignores the push ends INCOMPLETE, and the gate says why", async () => {
    const rs = await single(sidestep(() => say("Still complete.")), { requireCompletion: "ACCEPTED" })
    assert.equal(blocked(rs).length, 1, "bounded: pushed once")
    assert.equal(rs.r.status, "INCOMPLETE")
    assert.ok(rs.r.completionGate.reasons.some((x) => /ACCEPTED required, reached VERIFIED: acceptance not met/.test(x)), JSON.stringify(rs.r.completionGate.reasons))
  })
  await t("a controller sub-run never enforces it (the controller's gate judges the whole task)", async () => {
    const shared = derive("Fix the off-by-one in sum.js. Make sure `npm test` passes.")
    const rs = await single(sidestep(() => say("unexpected extra call")), { requireCompletion: "ACCEPTED" }, { understanding: shared })
    assert.equal(rs.calls, 4, "no push inside a step")
    assert.equal(blocked(rs).length, 0)
    assert.equal(rs.r.status, "COMPLETED")
  })
}
{
  // the real controller, with segments that edit a.js and run a syntax check
  // and a side test — but not the `npm test` the task named
  async function controller(requireCompletion, behave) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reqc-meta-"))
    fs.writeFileSync(path.join(dir, "a.js"), "export const x = 1\n")
    const prev = process.cwd()
    process.chdir(dir)
    const rec = (cmd) => ({ command: cmd, passed: true, exitCode: 0, tail: "ok" })
    const asked = (o) => /not done to the required level/.test(`${o.task ?? ""}\n${o.extraContext ?? ""}`)
    let runs = 0, pushed = 0
    const runAgent = async (o) => {
      if (o.planOnly) return { text: "1. edit a.js\n2. done", toolRecords: [], commandChecks: [], toolLog: [] }
      if (asked(o)) {
        pushed++
        if (behave === "fix") return { text: "Ran npm test; it passes. Complete.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [rec("node --check a.js"), rec("npm test")], toolLog: [] }
      } else if (!o.readOnly && ++runs === 1) {
        fs.writeFileSync("a.js", "export const x = 2\n")
        return { text: "Changed a.js. Complete and verified.", budgetHit: false, steps: 2, toolRecords: [{ tool: "edit_file", files_changed: ["a.js"] }], commandChecks: [rec("node --check a.js"), rec("npx vitest run a.test.js")], toolLog: [] }
      }
      return { text: "Complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [rec("node --check a.js"), rec("npx vitest run a.test.js")], toolLog: [] }
    }
    const events = []
    try {
      const r = await meta.runMeta({ config: { ...cfg, agent: { ...cfg.agent, ...(requireCompletion ? { requireCompletion } : {}) } }, provider: { name: "x", model: "m" }, task: "Fix a.js. Make sure `npm test` passes.", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
      return { r, events, pushed, of: (type) => events.filter((e) => e.type === type) }
    } finally { process.chdir(prev) }
  }
  await t("controller, requireCompletion off (default): completes at VERIFIED even though `npm test` never ran — reported, not enforced", async () => {
    const c = await controller(null, "fix")
    assert.equal(c.r.status, "COMPLETED")
    assert.deepEqual(c.of("COMPLETION_SHORTFALL"), [])
    assert.equal(c.of("COMPLETION_LEVEL").at(-1)?.level, "VERIFIED")
    assert.equal(c.pushed, 0)
  })
  await t("controller, ACCEPTED: the shortfall gets a repair turn naming the missing check; once it runs, COMPLETE", async () => {
    const c = await controller("ACCEPTED", "fix")
    assert.match(c.of("COMPLETION_SHORTFALL")[0].reasons[0], /acceptance not met: Make sure `npm test` passes\. — `npm test` was never run/)
    assert.ok(c.of("REPAIR_STARTED").some((e) => /requireCompletion/.test(e.reason ?? "")))
    assert.equal(c.r.status, "COMPLETED")
    assert.equal(c.of("COMPLETION_LEVEL").at(-1)?.level, "COMPLETE")
  })
  await t("controller, ACCEPTED: a model that never closes the gap gets two bounded turns, then WAITING — never COMPLETED", async () => {
    const c = await controller("ACCEPTED", "ignore")
    assert.equal(c.of("REPAIR_STARTED").filter((e) => /requireCompletion/.test(e.reason ?? "")).length, 2)
    assert.notEqual(c.r.status, "COMPLETED")
    assert.equal(c.of("TASK_COMPLETED").length, 0)
  })
}
await t("controller source: shortfall → recurring required actions → existing gate; bounded repair turns", () => {
  const src = controllerSource()
  assert.match(src, /RECURRING_ACTION_PREFIXES = \[[^\]]*"completion "\]/)
  assert.match(src, /addRequiredAction\(`completion \$\{sf\.required\} required \(now \$\{sf\.level\}\): \$\{r\}`\)/)
  assert.match(src, /if \(!\/\^off\$\/i\.test\(requireCompletion\) && !\(changedFiles\.size === 0 \|\| fr\.risk === "trivial"\)\)/)
  assert.match(src, /completionOnly && runState\.completionRepairs < 2/) // Phase 2: run state object
})

console.log(`\n== understanding suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
