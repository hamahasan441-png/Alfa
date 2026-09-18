import assert from 'node:assert/strict'
import { runIntelligenceBenchmark } from '../intelligence-benchmark.js'
const r = runIntelligenceBenchmark()
assert.equal(r.deterministic, true)
assert.equal(r.provider, false)
assert.equal(r.cases, 10)
assert.equal(r.stateTransitions, 60)
assert.ok(r.evidenceNodes >= 20)
assert.equal(r.learningSamples, 10)
assert.ok(r.learnedStrategySamples >= 20)
assert.equal(r.goalDriftDetected, true)
assert.equal(r.stuckDetected, true)
assert.ok(r.rows.every(x => Number.isFinite(x.ms) && x.ms >= 0))
console.log('intelligence-benchmark 10/10 PASS')
