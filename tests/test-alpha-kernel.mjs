import assert from "node:assert/strict"
import { createCognitiveState, COGNITIVE_PHASE } from "../cognitive-state.js"
import { createEvidenceGraph } from "../evidence-graph.js"
import { createLearningLoop } from "../learning-loop.js"

const s = createCognitiveState({ taskId: "t1", objective: "fix tests" })
assert.equal(s.phase, COGNITIVE_PHASE.UNDERSTAND)
assert.equal(s.transition(COGNITIVE_PHASE.PREDICT).ok, false)
assert.equal(s.transition(COGNITIVE_PHASE.INSPECT).ok, true)
assert.equal(s.transition(COGNITIVE_PHASE.PLAN).ok, true)
assert.equal(s.transition(COGNITIVE_PHASE.PREDICT).ok, true)
assert.equal(s.transition(COGNITIVE_PHASE.EXECUTE).ok, true)
s.setFact("expectedFiles", ["a.js"])
const snap = s.snapshot()
const s2 = createCognitiveState(); assert.equal(s2.restore(snap), true); assert.equal(s2.phase, COGNITIVE_PHASE.EXECUTE)

const g = createEvidenceGraph({ maxNodes: 10 })
const a = g.addNode("ACTION", "edit", { files: ["a.js"] })
const v = g.addNode("VERIFICATION", "test pass", { files: ["a.js"] })
assert.equal(g.link(a, v, "verified-by"), true)
assert.equal(g.related(a).length, 1)
assert.equal(g.staleFiles(["a.js"]), 2)
assert.equal(g.snapshot().nodes.every((n) => n.status === "STALE"), true)

const l = createLearningLoop()
l.record({ prediction: { files: ["a.js"] }, action: "edit", observation: { files: ["a.js"] }, verification: "pass", outcome: "ok", error: 0 })
l.record({ prediction: { files: ["b.js"] }, action: "edit", observation: { files: ["c.js"] }, verification: "fail", outcome: "repair", error: 1 })
assert.equal(l.calibration().samples, 2)
assert.equal(l.calibration().meanAbsError, 0.5)
console.log("alpha-kernel: 14/14 assertions passed")

// Live cognition wiring: the new state/graph/learning surfaces are additive.
const { createCognition } = await import("../cognition.js")
const c = createCognition({ cwd: "/tmp/forge-alpha-kernel", objective: "fix a.js" })
c.noteInspect(); c.notePlan("small patch"); const p = c.predict({ expectedFiles: ["a.js"] })
c.observeTools([{ name: "write_file", args: { path: "a.js" }, result: "ok" }])
const live = c.snapshot()
assert.equal(live.cognitiveState.schema, "1.0.0")
assert.ok(live.evidenceGraph.nodes.some((n) => n.type === "PREDICTION"))
assert.ok(live.evidenceGraph.nodes.some((n) => n.type === "ACTION"))
assert.equal(p.id, live.cognitiveState.facts.predictionId ?? p.id)
assert.equal(live.cognitiveState.phase, COGNITIVE_PHASE.OBSERVE)

// Failure path must expose DIAGNOSE explicitly; successful checks then move
// OBSERVE -> VERIFY. This guards the core lifecycle wiring without changing
// governor authority.
const f = createCognition({ cwd: "/tmp/forge-alpha-kernel-failure", objective: "fix a.js" })
f.noteInspect(); f.notePlan("small patch"); f.predict({ expectedFiles: ["a.js"] })
f.observeTools([{ name: "bash", args: { command: "npm test" }, result: "[exit code: 1] 1 test failed" }])
assert.equal(f.snapshot().cognitiveState.phase, COGNITIVE_PHASE.DIAGNOSE)

const verifyC = createCognition({ cwd: "/tmp/forge-alpha-kernel-verify", objective: "fix a.js" })
verifyC.noteInspect(); verifyC.notePlan("small patch"); verifyC.predict({ expectedFiles: ["a.js"] })
verifyC.observeTools([{ name: "write_file", args: { path: "a.js" }, result: "ok" }])
verifyC.observeTools([{ name: "bash", args: { command: "npm test" }, result: "1 passed\n[exit code: 0]" }])
assert.equal(verifyC.snapshot().cognitiveState.phase, COGNITIVE_PHASE.VERIFY)
console.log("alpha-kernel live wiring: PASS")
