/**
 * The loop learns to stop thrashing. completion.thrashingFailure detects the
 * same check failing across DIFFERENT edits (distinct actions, no progress),
 * which the exact-repeat guard misses; the governor answers a `looping` signal
 * with REPLAN ("change hypothesis"). Zero network.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const { thrashingFailure } = await import("../completion.js")
const { chooseNextAction, ACTION } = await import("../governor.js")

let n = 0
const t = (name, fn) => { try { fn(); n++; console.log(`  ok   ${name}`) } catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 } }
const chk = (command, passed, writeIndex, extra = {}) => ({ command, passed, exitCode: passed ? 0 : 1, writeIndex, ...extra })

t("the same check failing across edits is thrashing", () => {
  const r = thrashingFailure({ commandChecks: [chk("npm test", false, 1), chk("npm test", false, 3), chk("npm test", false, 5)] })
  assert.ok(r); assert.equal(r.fails, 3); assert.ok(r.editsBetween >= 1); assert.match(r.command, /npm test/)
})
t("a pass in between clears the thrash", () => {
  assert.equal(thrashingFailure({ commandChecks: [chk("npm test", false, 1), chk("npm test", true, 3), chk("npm test", false, 5)] }), null)
})
t("reruns with no edits between are flaky, not thrashing", () => {
  assert.equal(thrashingFailure({ commandChecks: [chk("npm test", false, 2), chk("npm test", false, 2), chk("npm test", false, 2)] }), null)
})
t("below the failure threshold → null", () => {
  assert.equal(thrashingFailure({ commandChecks: [chk("npm test", false, 1), chk("npm test", false, 3)] }), null)
})
t("a timed-out / unknown-status run does not count as a failure", () => {
  assert.equal(thrashingFailure({ commandChecks: [chk("npm test", false, 1, { timedOut: true }), chk("npm test", false, 3, { statusUnknown: true }), chk("npm test", false, 5, { timedOut: true })] }), null)
})
t("normalized command identity groups equivalent invocations", () => {
  // trailing flags / whitespace that normalizeCommand folds still group as one
  const r = thrashingFailure({ commandChecks: [chk("npm test ", false, 1), chk("npm test", false, 3), chk("npm  test", false, 5)] })
  assert.ok(r, "normalization should treat these as the same check")
})
t("two unrelated checks each failing once are not a thrash", () => {
  assert.equal(thrashingFailure({ commandChecks: [chk("npm test", false, 1), chk("npm run lint", false, 2), chk("npm run build", false, 3)] }), null)
})

// --- governor: a looping signal forces REPLAN (change hypothesis) -----------
t("governor: looping → REPLAN before another mutation", () => {
  const g = chooseNextAction({ klass: "SMALL", looping: true, writes: 2, steps: 3 })
  assert.equal(g.action, ACTION.REPLAN)
  assert.match(g.why, /looping/i)
})
t("governor: NOT looping with unverified writes → VERIFY, not REPLAN", () => {
  const g = chooseNextAction({ klass: "SMALL", looping: false, writes: 2, unverified: ["a.js"], verified: false, steps: 3, inspected: true })
  assert.equal(g.action, ACTION.VERIFY)
})

// --- wiring: agent.js feeds thrashing into the governor's looping input -----
t("agent.js OR-s thrashingFailure into the governor looping signal", () => {
  const src = fs.readFileSync(path.join(here, "..", "agent.js"), "utf8")
  assert.match(src, /thrashingFailure } from "\.\/completion\.js"|checkStanding, thrashingFailure/)
  assert.match(src, /looping:.*thrashingFailure\(\{ commandChecks \}\)/)
})

console.log(`\n== thrash suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
