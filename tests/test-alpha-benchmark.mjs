import assert from 'node:assert/strict'
import { runAlphaBenchmark } from '../alpha-benchmark.js'

const r = runAlphaBenchmark()
assert.equal(r.deterministic, true)
assert.equal(r.provider, false)
assert.equal(r.cases, 10)
assert.equal(r.failureCases, 6)
assert.equal(r.knownFailureClassificationRate, 1)
assert.equal(r.persistedSamples, 10)
assert.equal(r.rows.length, 10)
assert.ok(r.rows.every(x => x.persisted === true))
assert.ok(r.rows.every(x => Number.isFinite(x.ms) && x.ms >= 0))
console.log('alpha-benchmark 8/8 PASS')
