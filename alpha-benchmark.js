/**
 * Forge Alpha Intelligence benchmark.
 *
 * Deterministic, provider-free benchmark of the additive alpha decision layer.
 * It measures orchestration signals, not model coding ability. Live-provider
 * E2E remains a separate gate and is never inferred from this report.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAlphaIntelligence, classifyFailureClass, alphaIntelligencePath } from './alpha-intelligence.js'

const CASES = [
  { id: 'simple-bug', action: 'fix', strategy: 'smallest-reversible-change', expected: ['src/a.js'], failure: null },
  { id: 'multi-file', action: 'feature', strategy: 'dependency-aware-change', expected: ['src/a.js', 'src/b.js'], failure: null },
  { id: 'hidden-dependency', action: 'fix', strategy: 'dependency-aware-change', expected: ['src/api.js'], failure: { message: 'Cannot find module package', code: 'MODULE_NOT_FOUND' } },
  { id: 'failed-first-attempt', action: 'repair', strategy: 'smallest-reversible-change', expected: ['src/a.js'], failure: { message: 'TypeError: x is not a function' } },
  { id: 'wrong-hypothesis', action: 'repair', strategy: 'broad-change', expected: ['src/a.js'], failure: { message: '3 tests failed' } },
  { id: 'crash-recovery', action: 'resume', strategy: 'checkpoint-resume', expected: ['.forge/checkpoint.json'], failure: { message: 'checkpoint resume state invalid', code: 'STATE' } },
  { id: 'ambiguous-request', action: 'clarify', strategy: 'inspect-first', expected: [], failure: null },
  { id: 'missing-tests', action: 'verify', strategy: 'test-first', expected: ['src/a.js', 'tests/a.test.js'], failure: { message: 'assertion failed in test' } },
  { id: 'unexpected-side-effect', action: 'verify', strategy: 'impact-first', expected: ['src/a.js'], failure: { message: 'API contract integration failure HTTP 500' } },
  { id: 'complex-autonomous', action: 'execute', strategy: 'dependency-aware-change', expected: ['src/a.js', 'src/b.js', 'src/c.js'], failure: null },
]

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-alpha-bench-'))
}

export function runAlphaBenchmark({ keep = false } = {}) {
  const cwd = mkTemp()
  const alpha = createAlphaIntelligence({ cwd, klass: 'MEDIUM', objective: 'benchmark alpha intelligence' })
  const rows = []
  const t0 = process.hrtime.bigint()
  for (const c of CASES) {
    const start = process.hrtime.bigint()
    alpha.setContext({ nextKlass: 'MEDIUM', nextObjective: c.id })
    const ranked = alpha.selectPlans([
      { id: 'A', key: c.strategy, expectedValue: .82, reversible: true, risk: 'LOW' },
      { id: 'B', key: 'broad-change', expectedValue: .62, reversible: false, risk: 'MEDIUM' },
    ])
    const prediction = alpha.predictDecision({ action: c.action, strategy: ranked[0], expected: c.expected })
    const observation = alpha.observe({ ok: !c.failure, files: c.expected, action: c.action, failure: c.failure })
    const drift = alpha.drift({ expectedFiles: c.expected, actualFiles: c.failure ? c.expected.concat(c.id === 'unexpected-side-effect' ? ['unexpected.js'] : []) : c.expected })
    const counterfactual = alpha.counterfactual({ changed: c.expected, affected: c.expected.concat('unrelated.js'), tests: c.expected.map(x => `${x}.test`) })
    alpha.attributeCause({ layer: c.failure ? 'SYMPTOM' : 'CONFIRMED', description: c.failure ? observation.failureClass : 'success', confidence: prediction.confidence, evidence: c.expected })
    alpha.learn({ strategy: c.strategy, ok: !c.failure, repairs: c.failure ? 1 : 0, replans: c.failure && c.id === 'wrong-hypothesis' ? 1 : 0, predictionError: c.failure ? .4 : 0 })
    rows.push({
      id: c.id,
      selected: ranked[0]?.key || null,
      confidence: prediction.confidence,
      failureClass: observation.failureClass,
      drift: drift.level,
      residualFiles: counterfactual.residualFiles.length,
      persisted: Boolean(fs.existsSync(alphaIntelligencePath(cwd))),
      ms: Number(process.hrtime.bigint() - start) / 1e6,
    })
  }
  const statePath = alphaIntelligencePath(cwd)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const classification = Object.fromEntries(CASES.filter(c => c.failure).map(c => [c.id, classifyFailureClass(c.failure)]))
  const failures = CASES.filter(c => c.failure).length
  const classified = Object.values(classification).filter(x => x !== 'UNKNOWN').length
  const result = {
    schema: '1.0.0',
    benchmark: 'alpha-intelligence',
    deterministic: true,
    provider: false,
    note: 'This benchmark validates the orchestration layer only; it does not claim live model coding success.',
    cases: CASES.length,
    failureCases: failures,
    knownFailureClassificationRate: failures ? classified / failures : 1,
    persistedSamples: Object.values(state.strategies).reduce((n, r) => n + (r.samples || 0), 0),
    elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
    rows,
    cwd: keep ? cwd : undefined,
  }
  if (!keep) fs.rmSync(cwd, { recursive: true, force: true })
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(runAlphaBenchmark({ keep: process.env.FORGE_BENCH_KEEP === '1' }), null, 2))
}
