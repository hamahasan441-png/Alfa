import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRetryController,
  fingerprintStrategy,
  backoffDelay,
  RETRY_STATE,
} from '../retry-policy.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }

test('strategy fingerprint is stable and distinguishes strategies', () => {
  const a = fingerprintStrategy({ nodeId: 'n1', reason: 'test failed', strategy: 'run focused test' })
  const b = fingerprintStrategy({ nodeId: 'n1', reason: 'test failed', strategy: 'run focused test' })
  const c = fingerprintStrategy({ nodeId: 'n1', reason: 'test failed', strategy: 'change dependency' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('backoff is exponential, capped, and jitter-free by default', () => {
  assert.equal(backoffDelay(0, { baseMs: 100, maxMs: 1000 }), 100)
  assert.equal(backoffDelay(1, { baseMs: 100, maxMs: 1000 }), 200)
  assert.equal(backoffDelay(5, { baseMs: 100, maxMs: 1000 }), 1000)
})

test('controller accepts first strategy and retries it only within budget', () => {
  const c = createRetryController({ maxRetries: 2 })
  let d = c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  assert.equal(d.allowed, true)
  c.record({ nodeId: 'n1', strategy: 'A', ok: false })
  d = c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  assert.equal(d.allowed, false)
  assert.equal(d.state, RETRY_STATE.OPEN)
})

test('controller requires a changed strategy after a failed attempt', () => {
  const c = createRetryController({ maxRetries: 3 })
  c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  c.record({ nodeId: 'n1', strategy: 'A', ok: false })
  const same = c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  assert.equal(same.allowed, false)
  const changed = c.admit({ nodeId: 'n1', strategy: 'B', reason: 'x' })
  assert.equal(changed.allowed, true)
})

test('successful strategy closes its circuit and clears failure streak', () => {
  const c = createRetryController({ maxRetries: 2 })
  c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  c.record({ strategy: 'A', ok: true })
  const next = c.admit({ nodeId: 'n1', strategy: 'A', reason: 'x' })
  assert.equal(next.allowed, true)
  assert.equal(next.state, RETRY_STATE.CLOSED)
})

test('snapshot is bounded and serializable', () => {
  const c = createRetryController({ maxRetries: 2, maxHistory: 3 })
  for (const s of ['A', 'B', 'C', 'D']) {
    c.admit({ nodeId: 'n1', strategy: s, reason: s })
    c.record({ strategy: s, ok: false })
  }
  const snap = c.snapshot()
  assert.ok(snap.history.length <= 3)
  assert.doesNotThrow(() => JSON.stringify(snap))
})

test('live meta wiring uses the controller and config keeps transport retry separate', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const meta = fs.readFileSync(path.join(root, 'meta.js'), 'utf8')
  const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8')
  assert.match(meta, /from ["']\.\/retry-policy\.js["']/)
  assert.match(meta, /const repairRetry = createRetryController/)
  assert.match(meta, /const boundedRepair = async/)
  assert.match(meta, /REPAIR_RETRY_ADMISSION/)
  assert.match(meta, /REPAIR_RETRY_BACKOFF/)
  assert.match(meta, /REPAIR_RETRY_RECORDED/)
  assert.match(config, /repairRetry: \{ maxRetries: 3, backoffMs: 1000, maxBackoffMs: 10000, maxHistory: 32 \}/)
})

console.log(`v134: ${passed}/7 PASS`)
