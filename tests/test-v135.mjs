import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createBus, MESSAGE_TYPE } from '../bus.js'
import { createEvidenceGraph } from '../evidence-graph.js'
import { publishVerificationEvent, verificationEvent } from '../verify.js'
import { createRetryController } from '../retry-policy.js'
import { buildV4Plan, nextPlanAction, PLAN_STATUS } from '../v4.js'

const meta = fs.readFileSync(new URL('../meta.js', import.meta.url), 'utf8')
const agent = fs.readFileSync(new URL('../agent.js', import.meta.url), 'utf8')
const tools = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')

let passed = 0
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++ }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 }
}

test('V4 plan is executable through the existing DAG boundary, not a parallel planner', () => {
  const plan = buildV4Plan({ objective: 'integration', steps: [
    { id: 'inspect', title: 'inspect' },
    { id: 'change', title: 'change', dependsOn: ['inspect'] },
    { id: 'verify', title: 'verify', dependsOn: ['change'] },
  ] })
  assert.equal(nextPlanAction(plan).id, 'inspect')
  plan.nodes[0].status = PLAN_STATUS.COMPLETED
  assert.equal(nextPlanAction(plan).id, 'change')
  assert.match(meta, /buildV4Plan\(/)
  assert.match(meta, /V4_PLAN_VALIDATED/)
})

test('live agent consumes V4 depth and adaptive budget', () => {
  assert.match(agent, /selectV4Depth\(/)
  assert.match(agent, /adaptiveBudget\(/)
  assert.match(agent, /v4Depth/)
  assert.match(agent, /v4Budget/)
})

test('Python runtime is on the real tool execution path', () => {
  assert.match(tools, /rewritePythonSkillCommand/)
  assert.match(tools, /pythonEnvironment/)
})

test('verification event reaches BOTH bus and evidence graph through one publisher', () => {
  const bus = createBus({ taskId: 't-integration', persist: false })
  const graph = createEvidenceGraph()
  const ev = verificationEvent({ passed: false, taskId: 't-integration', nodeId: 'n1', verificationId: 'v1', command: 'npm test', evidence: 'failed', files: ['a.js'] })
  const out = publishVerificationEvent(ev, { bus, evidenceGraph: graph })
  assert.equal(out.type, 'VERIFICATION_FAILED')
  assert.equal(bus.inbox('core').some(m => m.message_type === MESSAGE_TYPE.VERIFICATION_FAILED), true)
  assert.equal(graph.snapshot().nodes.some(n => n.id === 'v1' && n.type === 'VERIFICATION' && n.status === 'FAILED'), true)
})

test('retry controller is bounded and forces strategy change after failure', () => {
  const r = createRetryController({ maxRetries: 2 })
  const a = r.admit({ nodeId: 'n1', strategy: 'A', reason: 'fail' })
  assert.equal(a.allowed, true)
  r.record({ nodeId: 'n1', fingerprint: a.fingerprint, ok: false })
  assert.equal(r.admit({ nodeId: 'n1', strategy: 'A', reason: 'fail' }).allowed, false)
  assert.equal(r.admit({ nodeId: 'n1', strategy: 'B', reason: 'fail' }).allowed, true)
})

test('meta owns one lifecycle event and mirrors verification without creating a second planner', () => {
  assert.match(meta, /const emit = \(ev\) =>/)
  assert.match(meta, /publishVerificationEvent/)
  assert.doesNotMatch(meta, /createV4Planner|newV4Planner/)
})

console.log(`v135 integration: ${passed}/6 PASS`)
if (passed !== 6) process.exitCode = 1
