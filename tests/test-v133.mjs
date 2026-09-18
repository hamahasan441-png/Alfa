import assert from "node:assert/strict"
import { createBus, MESSAGE_TYPE } from "../bus.js"
import { verificationEvent, publishVerificationEvent, runVerification, verificationPlan } from "../verify.js"
import { createEvidenceGraph, recordVerificationEvent } from "../evidence-graph.js"
import { ingestVerificationFailure, replanFromVerificationFailure } from "../replan.js"
import { createHypothesisEngine, ingestHypothesisVerificationFailure as ingestHypothesisFailure } from "../hypothesis.js"

const bus = createBus({ persist: false })
bus.register("core", { kind: "core" })
bus.register("replanner", { kind: "core" })
const ev = verificationEvent({ passed: false, command: "npm test", exitCode: 1, evidence: "1 failed", taskId: "t1", nodeId: "n1" })
assert.equal(ev.type, "VERIFICATION_FAILED")
const sent = bus.send({ sender: "verify", receiver: "core", message_type: MESSAGE_TYPE.REJECTED, content: ev.reason, task_id: "t1", node_id: "n1", requires_action: true })
assert.equal(sent.message_type, MESSAGE_TYPE.REJECTED)

const published = publishVerificationEvent(ev, { bus })
assert.equal(published.type, "VERIFICATION_FAILED")
assert.ok(bus.inbox("core").some(m => m.message_type === MESSAGE_TYPE.VERIFICATION_FAILED))

const g = createEvidenceGraph({ maxNodes: 10 })
const gid = recordVerificationEvent(g, ev)
assert.ok(gid)
assert.equal(g.related(gid).length, 0)

const r = ingestVerificationFailure({ nodeId: "n1", reason: "syntax error", command: "npm test", exitCode: 1 })
assert.equal(r.shouldReplan, true)
assert.equal(replanFromVerificationFailure(r).type, "targeted-replan")

const h = createHypothesisEngine()
const hs = ingestHypothesisFailure(h, { nodeId: "n1", reason: "syntax error", command: "npm test", exitCode: 1 })
assert.ok(hs.hypothesis)
assert.equal(h.size(), 1)

const dir = await import("node:fs/promises").then(m => m.mkdtemp("/tmp/forge-v133-"))
await import("node:fs/promises").then(m => m.writeFile(`${dir}/ok.js`, "export const x = 1\n"))
const vr = await runVerification(verificationPlan("write_file", { path: "ok.js" }, { cwd: dir, meta: { read_only: false, verification_required: true } }), { cwd: dir })
assert.equal(vr.ok, true)
assert.ok(vr.event)
assert.equal(vr.event.type, "VERIFICATION_PASSED")

console.log("PASS v133 verification→bus→evidence→replan→hypothesis closed loop")
