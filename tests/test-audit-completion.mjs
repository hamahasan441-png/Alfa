#!/usr/bin/env node
/**
 * forge — completion honesty and verification (audit 2026-10, findings C1–C10).
 *
 * Every case below reproduced a run that reported more than it proved:
 *
 *  C1  the controller reported COMPLETED while the objective's check was red:
 *      a PASS of an UNRELATED check of the same ledger type superseded the
 *      failure, and the segment's own INCOMPLETE gate was ignored
 *  C2  a file the objective said not to change was changed and the controller
 *      never noticed (".)" defeated the path regex; each segment re-baselined)
 *  C3  a direct run COMPLETED on a pure claim ("Created src/new.js") with no
 *      tool call and no file
 *  C4  a fix task ended COMPLETED_UNVERIFIED with its own target check red
 *      ("preexisting": red before the edit, red after)
 *  C5  understanding: any passing test verified "all tests pass", and the
 *      level read only the LAST check → ACCEPTED while the target was red
 *  C6  requirement traceability matched on ONE shared word
 *  C7  a repair whose check stayed red was recorded as a successful repair
 *  C8  the read-only verifier could not run any check (bash refused before the
 *      tool layer's verification allowlist was consulted)
 *  C9  a green `node --test` run ("# fail 0") was recorded FAILED
 *  C10 a failing check whose output printed "[exit code: 0]" was recorded as
 *      passing (the FIRST marker was read, not the one runBash appends)
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-completion-"))
process.chdir(WORK)
process.env.FORGE_HOME = path.join(WORK, ".forgehome")
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })
// a minimal `jest` stand-in: runs the file, prints a jest-like summary, real exit code
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-bin-"))
fs.writeFileSync(path.join(BIN, "jest"), '#!/bin/sh\nif node "$1" >/dev/null 2>&1; then echo "Tests:       1 passed, 1 total"; else echo "Tests:       1 failed, 1 total"; exit 1; fi\n')
fs.chmodSync(path.join(BIN, "jest"), 0o755)
process.env.PATH = `${BIN}:${process.env.PATH}`

const { createLedger, evaluateVerification } = await import(`${ROOT}/verifyledger.js`)
const { canCompleteFastPath, requirementCoverage } = await import(`${ROOT}/completion.js`)
const { parseCommandResult } = await import(`${ROOT}/cmdout.js`)
const { prohibitedTargets } = await import(`${ROOT}/goal-contract.js`)
const U = await import(`${ROOT}/understanding.js`)
const { deriveGoalContract } = await import(`${ROOT}/goal-contract.js`)
const { runAgent } = await import(`${ROOT}/agent.js`)
const meta = await import(`${ROOT}/meta.js`)

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) } }

/** A fresh project dir per case (process-wide cwd). */
function freshDir(tag) {
  const d = fs.mkdtempSync(path.join(WORK, `${tag}-`))
  process.chdir(d)
  return d
}

/** The REAL runAgent against a scripted OpenAI-compatible model. */
async function scripted({ task, steps = [], answer = "Done.", extra = {} }) {
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => (b += c))
    req.on("end", () => {
      const n = (JSON.parse(b).messages ?? []).filter((m) => m.role === "tool").length
      const msg = n < steps.length
        ? { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: steps[n].name, arguments: JSON.stringify(steps[n].args) } }] }
        : { role: "assistant", content: answer }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const provider = { name: "stub", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" }
  const config = { providers: {}, tools: { assumeYes: true }, skills: { enabled: false }, review: { code: false }, agent: { autonomous: true, modelStrategy: false, maxSteps: 20, verifyNudge: false } }
  try { return await runAgent({ config, provider, task, journal: false, ...extra }) }
  finally { srv.closeAllConnections?.(); srv.close() }
}

const metaCfg = { providers: {}, agent: { autonomous: true, modelStrategy: false, repairRetry: { backoffMs: 0 } }, tools: {}, review: { code: false } }

// ---------------------------------------------------------------------------
console.log("== C10: the LAST exit marker is the command's own ==")
{
  const out = "sub-run log: [exit code: 0]\nsomething went wrong\n[exit code: 2]"
  const rec = evaluateVerification("npm test", out, {})
  ok("C10 ledger: a status printed by the output does not override the appended marker", rec.exitCode === 2 && rec.passed === false, JSON.stringify({ exitCode: rec.exitCode, passed: rec.passed }))
  const parsed = parseCommandResult("log [exit code: 0]\n[exit code: 1]")
  ok("C10 parseCommandResult reads the last marker", parsed.exitCode === 1 && parsed.ok === false, JSON.stringify({ exitCode: parsed.exitCode }))

  freshDir("c10")
  const r = await scripted({
    task: "add a test script t.js and package.json, then run npm test",
    steps: [
      { name: "write_file", args: { path: "package.json", content: JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node t.js" } }) } },
      { name: "write_file", args: { path: "t.js", content: "console.log('sub-run log: [exit code: 0]')\nprocess.exit(1)\n" } },
      { name: "bash", args: { command: "npm test" } },
    ],
    answer: "Added the test script; npm test passes.",
  })
  const chk = (r.commandChecks ?? []).find((c) => c.command === "npm test")
  ok("C10 agent: a failing check that PRINTS [exit code: 0] is recorded failing", chk && chk.exitCode === 1 && chk.passed === false, JSON.stringify(chk && { exitCode: chk.exitCode, passed: chk.passed }))
  ok("C10 agent: and the run is not COMPLETED", r.status !== "COMPLETED", r.status)
}

// ---------------------------------------------------------------------------
console.log("== C9: a zero-count failure summary is not a failure ==")
{
  const nodeTest = "TAP version 13\n# Subtest: ok\nok 1 - ok\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
  const r1 = evaluateVerification("node --test ok.test.js", nodeTest, { exitCode: 0 })
  ok("C9 green `node --test` (# fail 0) is PASSED", r1.passed === true, JSON.stringify({ shape: r1.failureShape }))
  const r2 = evaluateVerification("cargo test", "test result: ok. 3 passed; 0 failed; 0 ignored", { exitCode: 0 })
  ok("C9 cargo `0 failed` is PASSED", r2.passed === true, JSON.stringify({ shape: r2.failureShape }))
  const L = createLedger()
  L.recordCommand("node --check a.js", "", { exitCode: 0, affectedFiles: ["a.js"] })
  L.recordCommand("node --test a.test.js", nodeTest, { exitCode: 0, affectedFiles: ["a.js"] })
  ok("C9 ledger stays green with a green node --test run", L.status("low", ["a.js"]).anyFailure === false)
  // the guard stays: real failures are still failures
  ok("C9 `# fail 2` is still a failure", evaluateVerification("node --test x", "# pass 1\n# fail 2", { exitCode: 0 }).passed === false)
  ok("C9 `10 failed` is still a failure", evaluateVerification("pytest", "10 failed, 3 passed", { exitCode: 0 }).passed === false)
}

// ---------------------------------------------------------------------------
console.log("== C1: a red objective check is never cleared by an unrelated green one ==")
{
  const L = createLedger()
  L.recordCommand("npx vitest run src/p.test.js", "1 test failed\n[exit code: 1]", { exitCode: 1, affectedFiles: ["src/p.js"] })
  L.recordCommand("node --check src/p.js", "ok", { exitCode: 0, affectedFiles: ["src/p.js"] })
  L.recordCommand("npx vitest run src/unrelated.test.js", "3 tests passed", { exitCode: 0, affectedFiles: ["src/p.js"] })
  const st = L.status("medium", ["src/p.js"])
  ok("C1 ledger: PASS(unrelated.test) does not supersede FAIL(p.test)", st.anyFailure === true && st.ok === false && !L.all()[0].superseded, JSON.stringify({ ok: st.ok, anyFailure: st.anyFailure }))
  L.recordCommand("npx vitest run ./src/p.test.js", "1 test passed", { exitCode: 0, affectedFiles: ["src/p.js"] })
  ok("C1 ledger: a PASS of the SAME check (normalized) supersedes it", L.status("medium", ["src/p.js"]).anyFailure === false && L.all()[0].superseded === true)

  freshDir("c1")
  fs.mkdirSync("src"); fs.writeFileSync("src/p.js", "export const p = 1\n")
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. fix p", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      status: "INCOMPLETE",
      completionGate: { ok: false, status: "INCOMPLETE", blockers: [{ check: "latestCheckPassing", reason: "latest run of `npx vitest run src/p.test.js` failed" }] },
      text: "Fixed p. Done.", answered: true, budgetHit: false, steps: 3, error: null,
      toolRecords: [{ tool: "edit_file", files_changed: ["src/p.js"] }],
      commandChecks: [
        { command: "node --check src/p.js", exitCode: 0, passed: true, tail: "ok", writeIndex: 1 },
        { command: "npx vitest run src/p.test.js", exitCode: 1, passed: false, tail: "1 test failed", writeIndex: 1 },
        { command: "npx vitest run src/unrelated.test.js", exitCode: 0, passed: true, tail: "3 tests passed", writeIndex: 1 },
      ],
      toolLog: [{ name: "edit_file", result: "ok" }],
    }
  }
  const r = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "fix p() in src/p.js so that `npx vitest run src/p.test.js` passes", runAgent: fake, workers: false, maxSegments: 3, signal: new AbortController().signal })
  ok("C1 controller: red objective check + unrelated green check is NOT COMPLETED", r.status !== "COMPLETED", r.status)

  // (a) the segment's own gate: no failing check anywhere, but the segment
  // says its approved plan has open steps — the controller must not complete
  freshDir("c1a")
  fs.writeFileSync("m.js", "export const m = 1\n")
  const events = []
  const fakeOpen = async (args) => {
    if (args.planOnly) return { text: "1. change m", toolRecords: [], commandChecks: [], toolLog: [] }
    return {
      status: "INCOMPLETE",
      completionGate: { ok: false, status: "INCOMPLETE", blockers: [{ check: "planStepsResolved", reason: "2 step(s) of the approved plan are not resolved" }] },
      text: "Changed m. Done.", answered: true, budgetHit: false, steps: 2, error: null,
      toolRecords: [{ tool: "edit_file", files_changed: ["m.js"] }],
      commandChecks: [{ command: "node --check m.js", exitCode: 0, passed: true, tail: "", writeIndex: 1 }, { command: "jest m.test.js", exitCode: 0, passed: true, tail: "Tests: 1 passed, 1 total", writeIndex: 1 }],
      toolLog: [{ name: "edit_file", result: "ok" }],
    }
  }
  const ra = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "change the constant in m.js", runAgent: fakeOpen, workers: false, maxSegments: 2, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  ok("C1a controller: a segment whose own gate is not ok is not COMPLETED", ra.status !== "COMPLETED", ra.status)
  ok("C1a …no TASK_COMPLETED was emitted", !events.some((e) => e.type === "TASK_COMPLETED"), JSON.stringify(events.filter((e) => /COMPLETION_GATE|TASK_/.test(e.type)).map((e) => e.type)))
}

// ---------------------------------------------------------------------------
console.log("== C2: the objective's prohibitions are enforced by the controller ==")
{
  ok("C2 prohibitedTargets reads `src/api.js.)` (a segment's parent-objective suffix)",
    JSON.stringify(prohibitedTargets("1. fix p\n\n(parent objective: Fix p() in src/p.js so that it returns 2. Do not change src/api.js.)")) === JSON.stringify(["src/api.js"]))

  freshDir("c2")
  fs.mkdirSync("src"); fs.writeFileSync("src/p.js", "module.exports = () => 1\n"); fs.writeFileSync("src/api.js", "module.exports = 'v1'\n")
  const events = []
  let n = 0
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. fix p", toolRecords: [], commandChecks: [], toolLog: [] }
    n++
    if (n === 1) { fs.writeFileSync("src/p.js", "module.exports = () => 2\n"); fs.writeFileSync("src/api.js", "module.exports = 'v2'\n") }
    // the segment itself reports a clean finish (its own watch re-baselined)
    return {
      status: "COMPLETED", completionGate: { ok: true, status: "COMPLETED", blockers: [] },
      text: "Fixed p(). Done.", answered: true, budgetHit: false, steps: 2, error: null,
      toolRecords: n === 1 ? [{ tool: "write_file", files_changed: ["src/p.js", "src/api.js"] }] : [],
      commandChecks: [{ command: "node --check src/p.js", exitCode: 0, passed: true, tail: "", writeIndex: n === 1 ? 2 : 0 }, { command: "jest src/p.test.js", exitCode: 0, passed: true, tail: "Tests: 1 passed, 1 total", writeIndex: n === 1 ? 2 : 0 }],
      toolLog: [{ name: "write_file", result: "ok" }],
    }
  }
  const r = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "Fix p() in src/p.js so that it returns 2. Do not change src/api.js.", runAgent: fake, workers: false, maxSegments: 2, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  ok("C2 controller: a changed prohibited file blocks COMPLETED", r.status !== "COMPLETED", r.status)
  ok("C2 …as a required action naming the file",
    events.some((e) => e.type === "COMPLETION_GATE" && (e.blockers ?? []).some((b) => /src\/api\.js/.test(String(b.reason ?? "")))),
    JSON.stringify(events.filter((e) => e.type === "COMPLETION_GATE").map((e) => e.blockers)))

  // review: on RESUME the baseline is the task's start, not what the run left
  ok("C2 resume: the task record keeps the task-start fingerprints", Boolean(r.taskId), JSON.stringify(Object.keys(r)))
  const quiet = async (args) => {
    if (args.planOnly) return { text: "1. fix p", toolRecords: [], commandChecks: [], toolLog: [] }
    return { status: "COMPLETED", completionGate: { ok: true, status: "COMPLETED", blockers: [] }, text: "All done.", answered: true, budgetHit: false, steps: 1, error: null, toolRecords: [],
      commandChecks: [{ command: "node --check src/p.js", exitCode: 0, passed: true, tail: "", writeIndex: 0 }, { command: "jest src/p.test.js", exitCode: 0, passed: true, tail: "Tests: 1 passed, 1 total", writeIndex: 0 }], toolLog: [] }
  }
  const events2 = []
  const r2 = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "Fix p() in src/p.js so that it returns 2. Do not change src/api.js.", resumeTaskId: r.taskId, runAgent: quiet, workers: false, maxSegments: 2, signal: new AbortController().signal, onEvent: (e) => events2.push(e) })
  ok("C2 resume: src/api.js changed before the crash still blocks COMPLETED", r2.status !== "COMPLETED", r2.status)
  const { watchProhibited } = await import("../goal-contract.js")
  const w = watchProhibited("Do not change src/api.js.", process.cwd(), { baseline: { "src/api.js": "0".repeat(64) } })
  ok("C2 watchProhibited honours a stored baseline", JSON.stringify(w.changed()) === JSON.stringify(["src/api.js"]) && w.baseline()["src/api.js"] === "0".repeat(64))
}

// ---------------------------------------------------------------------------
console.log("== C3: a claim is not an artifact ==")
{
  {
    const { artifactCandidates } = await import("../completion.js")
    ok("C3 review: a task that REPLACES/MIGRATES a file does not require the old name to exist",
      artifactCandidates("Replace legacy.js with modern.ts", ["legacy.js", "modern.ts"]).length === 0 && artifactCandidates("Migrate config.json to config.yaml", ["config.json"]).length === 0)
    ok("C3 review: a task that creates a file still requires it", JSON.stringify(artifactCandidates("Create src/new.js with a hello function", ["src/new.js"])) === JSON.stringify(["src/new.js"]))
  }
  const g = canCompleteFastPath({ finalText: "Created a.js", toolLog: [], commandChecks: [], missingArtifacts: ["a.js"], nothingChanged: true })
  ok("C3 gate: a missing named file and no change block completion", g.ok === false && g.blockers.some((b) => b.check === "namedArtifactsPresent") && g.blockers.some((b) => b.check === "changeMade"), JSON.stringify(g.blockers))

  freshDir("c3")
  const r = await scripted({ task: "Create src/new.js that exports the number 42.", steps: [], answer: "Created src/new.js exporting 42. Done." })
  ok("C3 direct run: claim-only creation is NOT COMPLETED", r.status !== "COMPLETED" && r.status !== "COMPLETED_UNVERIFIED", r.status)
  ok("C3 …the gate names the missing file", (r.completionGate?.blockers ?? []).some((b) => /src\/new\.js/.test(b.reason)), JSON.stringify(r.completionGate?.blockers))

  // read-only / question tasks are unaffected
  const q = await scripted({ task: "What does src/missing.js do?", steps: [], answer: "There is no src/missing.js in this project." })
  ok("C3 a question about a missing file still COMPLETES", q.status === "COMPLETED", `${q.status} ${JSON.stringify(q.completionGate?.blockers)}`)
  fs.mkdirSync("src", { recursive: true }); fs.writeFileSync("src/new.js", "module.exports = 41\n")
  const w = await scripted({ task: "Create src/new.js that exports the number 42.", steps: [{ name: "write_file", args: { path: "src/new.js", content: "module.exports = 42\n" } }], answer: "Created src/new.js exporting 42." })
  ok("C3 a run that really wrote the named file is not blocked by the new checks", !(w.completionGate?.blockers ?? []).some((b) => b.check === "namedArtifactsPresent" || b.check === "changeMade"), JSON.stringify(w.completionGate?.blockers))
}

// ---------------------------------------------------------------------------
console.log("== C4: the objective's own red check is never 'preexisting' ==")
{
  const checks = [
    { command: "jest src/p.test.js", exitCode: 1, passed: false, writeIndex: 0 },
    { command: "jest src/p.test.js", exitCode: 1, passed: false, writeIndex: 1 },
  ]
  const base = { finalText: "Fixed.", toolLog: [], commandChecks: checks, writeCount: 1, mutated: true }
  const named = canCompleteFastPath({ ...base, targetChecks: ["jest src/p.test.js"] })
  ok("C4 gate: a check the objective names stays failing (blocks)", named.ok === false && named.blockers.some((b) => b.check === "latestCheckPassing"), JSON.stringify({ ok: named.ok, status: named.status }))
  const fix = canCompleteFastPath({ ...base, fixTask: true })
  ok("C4 gate: in a fix task a red-before-and-after check blocks", fix.ok === false, JSON.stringify({ ok: fix.ok, status: fix.status }))
  const other = canCompleteFastPath({ ...base })
  ok("C4 gate: an unrelated preexisting red check still reads COMPLETED_UNVERIFIED (unchanged)", other.ok === true && other.status === "COMPLETED_UNVERIFIED")

  freshDir("c4")
  fs.mkdirSync("src"); fs.writeFileSync("src/p.js", "module.exports = () => 1\n")
  fs.writeFileSync("src/p.test.js", "require('node:assert').strictEqual(require('./p.js')(),2)\n")
  const r = await scripted({
    task: "Fix p() in src/p.js so that `jest src/p.test.js` passes (it must return 2).",
    steps: [
      { name: "read_file", args: { path: "src/p.js" } },
      { name: "bash", args: { command: "jest src/p.test.js" } },
      { name: "write_file", args: { path: "src/p.js", content: "module.exports = () => 3\n" } },
      { name: "bash", args: { command: "jest src/p.test.js" } },
    ],
    answer: "Fixed p(). Done.",
  })
  ok("C4 direct run: wrong fix with the target check red is not a finish", r.status !== "COMPLETED" && r.status !== "COMPLETED_UNVERIFIED" && r.completionGate.ok === false, `${r.status} ${JSON.stringify(r.completionGate?.blockers)}`)
}

// ---------------------------------------------------------------------------
console.log("== C5: understanding judges the latest result of each check ==")
{
  const task = "Fix the date parser in src/date.js. All tests must pass."
  const u = U.deriveUnderstanding(task, { goal: deriveGoalContract(task) })
  U.observe(u, { type: "command_check", command: "jest src/date.test.js", passed: false, exitCode: 1 })
  U.observe(u, { type: "command_check", command: "jest src/unrelated.test.js", passed: true, exitCode: 0 })
  const acc = u.items.filter((x) => x.kind === "acceptance")
  ok("C5 'all tests pass' is NOT verified while a test check is red", acc.length > 0 && acc.every((x) => x.type !== "VERIFIED"), JSON.stringify(acc.map((x) => x.type)))
  const lv = U.completion(u, { changedFiles: ["src/date.js"], gateOk: false })
  ok("C5 level is no higher than TESTED (target red, gate not ok)", lv.level === "TESTED", lv.level)
  U.observe(u, { type: "command_check", command: "jest src/date.test.js", passed: true, exitCode: 0 })
  ok("C5 once every test check's latest run is green it is VERIFIED", u.items.filter((x) => x.kind === "acceptance").every((x) => x.type === "VERIFIED"))
  ok("C5 a gate that is not ok still caps the level at TESTED", U.completion(u, { changedFiles: ["src/date.js"], gateOk: false }).level === "TESTED")

  const u2 = U.deriveUnderstanding("Make sure `npm test` passes.", {})
  U.observe(u2, { type: "command_check", command: "npm test", passed: true, exitCode: 0 })
  U.observe(u2, { type: "command_check", command: "npm test", passed: false, exitCode: 1 })
  ok("C5 a later red run of the named check takes the verification back", u2.items.filter((x) => x.kind === "acceptance").every((x) => x.type !== "VERIFIED"), JSON.stringify(u2.items.map((x) => `${x.kind}:${x.type}`)))
}

// ---------------------------------------------------------------------------
console.log("== C6: requirement traceability needs more than one shared word ==")
{
  const c = requirementCoverage([
    { id: "R1", text: "The export job MUST retry failed S3 uploads three times" },
    { id: "R2", text: "Login MUST lock the account after five failed attempts" },
  ], { nodeObjectives: ["Rename the export button label"], verificationEvidence: ["Tests: 4 passed — login page renders"] })
  ok("C6 one shared word is not coverage", c.requirements.every((r) => r.status === "UNADDRESSED") && c.ok === false, c.requirements.map((r) => `${r.id} ${r.status}`).join(" | "))
  const c2 = requirementCoverage([{ id: "R1", text: "Login MUST lock the account after five failed attempts" }], {
    verificationEvidence: [{ passed: false, evidence: "login lock account after five failed attempts" }],
  })
  ok("C6 a FAILED record is not evidence", c2.requirements[0].status === "UNADDRESSED", c2.requirements[0].status)
  const c3 = requirementCoverage([{ id: "R1", text: "Login MUST lock the account after five failed attempts" }], {
    verificationEvidence: [{ passed: true, evidence: "login: account lock after five failed attempts ok" }],
  })
  ok("C6 a passing record that covers the requirement is TESTED", c3.requirements[0].status === "TESTED", c3.requirements[0].status)
}

// ---------------------------------------------------------------------------
console.log("== C7: a repair whose check stays red is not a success ==")
{
  freshDir("c7")
  fs.mkdirSync("src"); fs.writeFileSync("src/p.js", "module.exports = 1\n")
  const red = { command: "jest src/p.test.js", exitCode: 1, passed: false, tail: "Tests: 1 failed, 1 total", writeIndex: 1 }
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. fix p", toolRecords: [], commandChecks: [], toolLog: [] }
    return { status: "INCOMPLETE", completionGate: { ok: false, status: "INCOMPLETE", blockers: [{ check: "latestCheckPassing" }] },
      text: "I fixed it.", answered: true, budgetHit: false, steps: 3, error: null,
      toolRecords: [{ tool: "edit_file", files_changed: ["src/p.js"] }], commandChecks: [{ ...red }], toolLog: [{ name: "edit_file", result: "ok" }] }
  }
  const recorded = []
  const repaired = []
  const r = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "fix p() in src/p.js", runAgent: fake, workers: false, maxSegments: 6,
    onEvent: (e) => { if (e.type === "REPAIR_RETRY_RECORDED") recorded.push(e); if (e.type === "REPAIR_COMPLETED") repaired.push(e) },
    signal: new AbortController().signal })
  ok("C7 every red repair is recorded as a FAILURE by the retry controller", recorded.length > 0 && recorded.every((e) => e.ok === false), JSON.stringify(recorded.map((e) => e.ok)))
  ok("C7 the failure count grows (the circuit can open)", recorded.length > 1 && recorded.at(-1).failures > recorded[0].failures, JSON.stringify(recorded.map((e) => e.failures)))
  ok("C7 REPAIR_COMPLETED says not fixed", repaired.length > 0 && repaired.every((e) => e.ok === false))
  ok("C7 the task is not COMPLETED", r.status !== "COMPLETED", r.status)
}

// ---------------------------------------------------------------------------
console.log("== C8: the read-only verifier can run an approved check ==")
{
  freshDir("c8")
  fs.writeFileSync("x.js", "module.exports = 1\n")
  const r = await scripted({
    task: "VERIFY: run node --check x.js",
    steps: [
      { name: "bash", args: { command: "node --check x.js" } },
      { name: "bash", args: { command: "rm -f x.js" } },
      { name: "bash", args: { command: "echo hi > y.txt" } },
    ],
    answer: "report",
    extra: { readOnly: true, verifier: true, maxStepsOverride: 6 },
  })
  ok("C8 `node --check` ran and was recorded as a check", (r.commandChecks ?? []).some((c) => c.command === "node --check x.js" && c.passed === true), JSON.stringify(r.toolLog?.map((t) => String(t.result).slice(0, 60))))
  ok("C8 a mutating command is still refused in read-only", fs.existsSync("x.js") && String(r.toolLog?.[1]?.result ?? "").startsWith("BLOCKED"))
  ok("C8 a write redirection is still refused in read-only", !fs.existsSync("y.txt") && String(r.toolLog?.[2]?.result ?? "").startsWith("BLOCKED"))
}

// ---------------------------------------------------------------------------
// Integration review: the C8 change exposed an older hole — the read-only
// allowlist matched "echo"/"ls"/"cat" ANYWHERE in a line, so a chained
// destructive command passed it. Each stage is now judged on its own.
console.log("== C8 review: a chained command cannot smuggle a write past read-only ==")
{
  const { isReadOnlyViolation, verificationAllows } = await import("../tools.js")
  const blocked = (c) => Boolean(isReadOnlyViolation("bash", { command: c }, true))
  for (const c of ["rm -f x.js && echo done", "git push --force origin x; git status", "curl -X POST http://x | cat", "echo $(rm -rf x)", "env rm -rf x", "sleep 5 & echo", "git diff --output=x.txt"]) ok(`refused in read-only: ${c}`, blocked(c) && verificationAllows("bash", { command: c }).ok === false)
  for (const c of ["npm test", "npm test 2>&1 | tail -40", "cd sub && npm test", "node --check a.js && node --check b.js", "git status && git diff --stat", "CI=1 npx vitest run"]) ok(`still allowed as a check: ${c}`, !blocked(c) && verificationAllows("bash", { command: c }).ok === true)
  for (const [label, extra] of [["verifier", { readOnly: true, verifier: true }], ["read-only sub-agent", { readOnly: true }], ["plan-only", { planOnly: true }]]) {
    freshDir(`c8r-${label.replace(/\W+/g, "")}`)
    fs.writeFileSync("x.js", "1\n")
    const r = await scripted({ task: "inspect x.js", steps: [{ name: "bash", args: { command: "rm -f x.js && echo done" } }], answer: "report", extra: { ...extra, maxStepsOverride: 4 } })
    ok(`${label}: \`rm -f x.js && echo done\` is BLOCKED and x.js survives`, fs.existsSync("x.js") && String(r.toolLog?.[0]?.result ?? "").startsWith("BLOCKED"), String(r.toolLog?.[0]?.result).slice(0, 80))
  }
  // only the verifier gets the check allowance; other read-only roles keep the old gate (no bash)
  freshDir("c8r-plan")
  const rp = await scripted({ task: "inspect", steps: [{ name: "bash", args: { command: "npm test" } }], answer: "report", extra: { planOnly: true, maxStepsOverride: 4 } })
  ok("plan-only: bash stays refused at the gate, as before", String(rp.toolLog?.[0]?.result ?? "").startsWith("BLOCKED"), String(rp.toolLog?.[0]?.result).slice(0, 80))
}

process.chdir(WORK)
console.log(`\n== audit-completion suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
