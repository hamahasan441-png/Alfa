import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAlphaIntelligence, classifyFailureClass, alphaIntelligencePath } from '../alpha-intelligence.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-alpha-'))
const ai = createAlphaIntelligence({ cwd: root, klass: 'LARGE', objective: 'fix api timeout and add regression test' })

assert.equal(classifyFailureClass({ code: 'TIMEOUT' }), 'ENVIRONMENT')
assert.equal(classifyFailureClass({ code: 'TEST_FAIL' }), 'TEST')
assert.equal(classifyFailureClass({ code: 'MODULE_NOT_FOUND' }), 'DEPENDENCY')

const plans = ai.selectPlans([
  { id: 'safe', key: 'safe', expectedValue: 0.72, reversible: true, risk: 'LOW', text: 'inspect then patch and verify' },
  { id: 'fast', key: 'fast', expectedValue: 0.75, reversible: false, risk: 'HIGH', text: 'rewrite the timeout layer' },
  { id: 'deep', key: 'deep', expectedValue: 0.70, reversible: true, risk: 'MEDIUM', text: 'trace dependency and add regression' },
])
assert.equal(plans.length, 3)
assert.ok(plans[0].alphaScore <= 1 && plans[0].alphaScore >= 0)

const pred = ai.predictDecision({ action: 'EXECUTE', strategy: plans[0], expected: ['src/a.js', 'tests/a.test.js'] })
assert.ok(pred.id)
assert.equal(pred.confidence > 0, true)
ai.observe({ ok: false, files: ['src/a.js', 'src/b.js'], failure: { code: 'TEST_FAIL', evidence: 'assertion failed' } })
ai.attributeCause({ layer: 'PROXIMATE', description: 'timeout contract mismatch', confidence: 0.7 })
ai.learn({ strategy: plans[0].key, ok: false, repairs: 1, replans: 1, predictionError: 0.4 })
const s = ai.snapshot()
assert.equal(s.schema, '1.0.0')
assert.ok(s.history.length >= 1)
assert.ok(s.causes.length >= 1)
assert.ok(fs.existsSync(alphaIntelligencePath(root)))

console.log('alpha-core 12/12 PASS')
