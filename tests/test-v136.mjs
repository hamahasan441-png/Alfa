import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRetryController } from '../retry-policy.js'

const meta = fs.readFileSync(new URL('../meta.js', import.meta.url), 'utf8')
const taskstate = fs.readFileSync(new URL('../taskstate.js', import.meta.url), 'utf8')

let passed = 0
function test(name, fn) { try { fn(); console.log(`PASS ${name}`); passed++ } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 } }

test('retry controller restores failed strategies from a snapshot', () => {
  const a = createRetryController({ maxRetries: 3 })
  const admission = a.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  a.record({ nodeId: 'n1', fingerprint: admission.fingerprint, ok: false })
  const snap = a.snapshot()
  const b = createRetryController({ maxRetries: 3, snapshot: snap })
  assert.equal(b.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' }).allowed, false)
  assert.equal(b.admit({ nodeId: 'n1', strategy: 'B', reason: 'x' }).allowed, true)
})

test('task state exposes durable retry-controller state', () => {
  assert.match(taskstate, /retry_state/)
  assert.match(taskstate, /setRetryState/) 
})

test('meta persists retry admission and restores it on resume', () => {
  assert.match(meta, /createRetryController\(\{[\s\S]*snapshot:/)
  assert.match(meta, /setRetryState\(/)
  assert.match(meta, /noteRetry\(/)
})

console.log(`v136 retry durability: ${passed}/3 PASS`)
if (passed !== 3) process.exitCode = 1
