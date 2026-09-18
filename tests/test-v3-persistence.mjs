import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createCognition, loadCognition } from "../cognition.js"

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v3-persist-"))
const c = createCognition({ cwd, objective: "add function foo to a.js" })
c.noteInspect()
c.notePlan("inspect then patch")
const p = c.predict({ expectedFiles: ["src/a.js"] })
assert.equal(c.cognitiveState.phase, "PREDICT")
c.observeTools([{ name: "write_file", args: { path: "src/a.js" }, result: "ok" }])
assert.equal(c.cognitiveState.phase, "OBSERVE")

// An unsettled prediction is part of the resumable V3 state and must survive.
const preCloseFile = c.persist()
assert.ok(preCloseFile && fs.existsSync(preCloseFile))
const resumedOpen = loadCognition(cwd)
assert.ok(resumedOpen)
assert.equal(resumedOpen.openPrediction?.id, p.id)
const resumedSettlement = resumedOpen.settle({ actualFiles: ["src/a.js"], status: "ok" })
assert.equal(resumedSettlement?.settled?.id, p.id)

// Governor decisions must be reflected in the V3 phase state, not merely emitted as text.
const failed = createCognition({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-v3-fail-")), objective: "add function foo to a.js" })
failed.noteInspect(); failed.notePlan("patch"); failed.predict({ expectedFiles: ["a.js"] })
failed.observeTools([{ name: "bash", args: { command: "node test.js" }, result: "ERROR: test failed" }])
const nextAction = failed.next({ failed: true, inspected: true, hasPlan: true })
assert.equal(nextAction.action, "INSPECT")
assert.equal(failed.cognitiveState.phase, "INSPECT")

// close must be safe on the live path and must never throw due to V3 state wiring.
const closed = c.close({ wrote: 1, unverified: [] })
assert.equal(closed.ok, true)
assert.equal(c.cognitiveState.phase, "COMPLETE")
assert.ok(c.cognitiveState.snapshot().transitions.some((t) => t.to === "PREDICT"))
assert.ok(c.cognitiveState.snapshot().transitions.some((t) => t.to === "COMPLETE"))
const file = c.persist()
assert.ok(file && fs.existsSync(file))

const restored = loadCognition(cwd)
assert.ok(restored)
assert.equal(restored.cognitiveState.phase, "COMPLETE")
assert.equal(restored.cognitiveState.phase, c.cognitiveState.phase)
assert.deepEqual(restored.cognitiveState.snapshot().facts, c.cognitiveState.snapshot().facts)
assert.deepEqual(restored.evidenceGraph.snapshot().nodes, c.evidenceGraph.snapshot().nodes)
assert.deepEqual(restored.evidenceGraph.snapshot().edges, c.evidenceGraph.snapshot().edges)
assert.deepEqual(restored.learningLoop.snapshot().records, c.learningLoop.snapshot().records)
assert.equal(restored.contract.snapshot().originalIntent, c.contract.snapshot().originalIntent)

// A later write must stale the old graph evidence after restore, rather than
// allowing persisted verification history to masquerade as current truth.
restored.observeTools([{ name: "write_file", args: { path: "src/a.js" }, result: "ok" }])
assert.ok(restored.evidenceGraph.snapshot().nodes.every((n) => n.status === "STALE" || !n.files.includes("src/a.js")))

console.log("v3-persistence: PASS")
