/**
 * Phase 3 — combine step (combine.js), acceptance checks one by one, and
 * scope-based task sizing (runmode.scopeOf). Zero network, isolated HOME.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-combine-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-combine-work-"))
process.chdir(WORK)
const C = await import("../combine.js")
const { scopeOf, chooseRunMode } = await import("../runmode.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const rec = (command, passed, extra = {}) => ({ command, passed, exitCode: passed ? 0 : 1, type: /test/.test(command) ? "test" : "build", ...extra })

await t("commands and paths are found in a criterion", () => {
  assert.deepEqual(C.commandsIn("make sure `npm run lint` and npm test pass"), ["npm run lint", "npm test"])
  assert.deepEqual(C.commandsIn("the README should mention it"), [])
  assert.deepEqual(C.pathsIn("src/api.js must export parse, and README.md too"), ["src/api.js", "README.md"])
})
await t("a named command: MET when its latest run passed", () => {
  const r = C.checkAcceptance({ acceptance: ["`npm test` must pass"], records: [rec("npm test", false), rec("npm test", true)] })
  assert.equal(r[0].status, "MET")
})
await t("a named command: FAILED when its latest run failed", () => {
  const r = C.checkAcceptance({ acceptance: ["make sure npm test passes"], records: [rec("npm test", true), rec("npm test -- --watch=false", false)] })
  assert.equal(r[0].status, "FAILED"); assert.match(r[0].evidence, /failed/)
})
await t("a named command never run: UNCHECKED, never MET", () => {
  const r = C.checkAcceptance({ acceptance: ["`cargo test` should pass"], records: [rec("npm test", true)] })
  assert.equal(r[0].status, "UNCHECKED"); assert.match(r[0].evidence, /never run/)
})
await t("an invalidated record does not count", () => {
  const r = C.checkAcceptance({ acceptance: ["`npm test` must pass"], records: [rec("npm test", true, { invalidated: true })] })
  assert.equal(r[0].status, "UNCHECKED")
})
await t("'all tests pass' uses the latest test record", () => {
  assert.equal(C.checkAcceptance({ acceptance: ["all tests should pass"], records: [rec("npx vitest run", true)] })[0].status, "MET")
  assert.equal(C.checkAcceptance({ acceptance: ["all tests should pass"], records: [rec("npx vitest run", true), rec("npm test", false)] })[0].status, "FAILED")
  assert.equal(C.checkAcceptance({ acceptance: ["all tests should pass"], records: [] })[0].status, "UNCHECKED")
})
await t("a file is never proof of behaviour", () => {
  fs.writeFileSync(path.join(WORK, "api.js"), "x")
  const r = C.checkAcceptance({ acceptance: ["api.js must export parse"], records: [], changedFiles: ["api.js"], cwd: WORK })
  assert.equal(r[0].status, "UNCHECKED"); assert.match(r[0].evidence, /changed: api\.js/)
})
await t("prose stays UNCHECKED", () => {
  assert.match(C.checkAcceptance({ acceptance: ["it should feel fast"] })[0].evidence, /^prose/)
})
await t("combineReport: plan lines, files, acceptance, conflicts", () => {
  const out = C.combineReport({
    answer: "Fixed the parser.",
    nodes: [{ id: "a", title: "Inspect", status: "completed", role: "researcher", model: "x/fast" }, { id: "b", title: "Patch", status: "failed", role: "coder" }],
    changedFiles: [path.join(WORK, "api.js")], cwd: WORK,
    acceptance: [{ criterion: "`npm test` must pass", status: "MET", evidence: "`npm test` passed" }],
    conflicts: [{ file: "api.js", resolution: "later report wins" }],
  })
  assert.match(out, /^Fixed the parser\./)
  assert.match(out, /Plan \(1\/2 steps completed\)/)
  assert.match(out, /✓ \*\*Inspect\*\* · researcher · x\/fast/)
  assert.match(out, /✗ \*\*Patch\*\* · coder · failed/)
  assert.match(out, /Changed files \(1\)\*\*: api\.js/)
  assert.match(out, /✓ MET: `npm test` must pass/)
  assert.match(out, /Conflicts between workers \(1\)/)
})
await t("combineReport: a one-node run with nothing to add is the answer unchanged", () => {
  assert.equal(C.combineReport({ answer: "Done.", nodes: [{ id: "do", status: "completed" }] }), "Done.")
})
await t("synthesize: model answer, or null on any failure", async () => {
  assert.equal(await C.synthesize({ report: "r", run: async (p) => ({ text: p.includes("--- run report ---\nr") ? "Short answer." : "?" }) }), "Short answer.")
  assert.equal(await C.synthesize({ report: "r", run: async () => { throw new Error("provider HTTP 500") } }), null)
  assert.equal(await C.synthesize({ report: "r", run: async () => ({ text: "x", answered: false }) }), null)
  assert.equal(await C.synthesize({ report: "", run: async () => ({ text: "x" }) }), null)
})
await t("scopeOf raises feature work, several deliverables or files to MEDIUM", () => {
  assert.equal(scopeOf("add a login page with tests", "SMALL").class, "MEDIUM")
  assert.equal(scopeOf("update a.js, b.js and c.js to use the logger", "SMALL").class, "MEDIUM")
  assert.equal(scopeOf("update the docs, then bump the version, then tag the release", "SMALL").class, "MEDIUM")
  assert.equal(scopeOf("fix the null check in parse", "SMALL").class, "SMALL")
  assert.equal(scopeOf("explain this login page", "SMALL").class, "SMALL") // MICRO-ish text never bumped
  assert.equal(scopeOf("add a login page", "MICRO").class, "MICRO") // only SMALL is raised
  assert.equal(scopeOf("add a login page", "LARGE").class, "LARGE") // never lowered
})
await t("chooseRunMode says why a task was raised", () => {
  const r = chooseRunMode({ task: "add a login page with tests" })
  assert.equal(r.mode, "meta"); assert.match(r.why, /builds a feature/)
})
await t("meta: the final answer carries acceptance for a named command", async () => {
  const meta = await import("../meta.js")
  const events = []
  const runAgent = async () => ({ text: "Updated the docs.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] })
  const r = await meta.runMeta({ config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }, provider: { name: "x", model: "m" }, task: "Explain the readme. Make sure `npm test` passes.", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  if (r.status === "COMPLETED") {
    assert.match(r.text, /Acceptance/); assert.match(r.text, /`npm test` was never run/)
    const ev = events.find((e) => e.type === "ACCEPTANCE_CHECKED")
    assert.equal(ev?.items?.[0]?.status, "UNCHECKED")
  } else {
    // the gate may hold a run whose named check never ran — then no answer is claimed at all
    assert.ok(["INCOMPLETE", "WAITING", "BLOCKED", "FAILED"].includes(r.status), r.status)
  }
})
await t("meta: a plain one-node answer is unchanged", async () => {
  const meta = await import("../meta.js")
  const runAgent = async () => ({ text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] })
  const r = await meta.runMeta({ config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }, provider: { name: "x", model: "m" }, task: "explain the readme", runAgent, signal: new AbortController().signal })
  assert.equal(r.status, "COMPLETED"); assert.equal(r.text, "All done, complete and verified.")
})

console.log(`\n== combine suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
