/**
 * Forge Alpha Intelligence integration benchmark.
 *
 * Provider-free and deterministic. It exercises the real cognitive state,
 * evidence graph, learning loop, and alpha intelligence together. It does NOT
 * claim live-model coding success; live-model evaluation remains evalbench.js.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createAlphaIntelligence, alphaIntelligencePath } from './alpha-intelligence.js'
import { createCognitiveState, COGNITIVE_PHASE } from './cognitive-state.js'
import { createEvidenceGraph } from './evidence-graph.js'
import { createLearningLoop } from './learning-loop.js'

const CASES = [
  ['simple-bug', 'fix', 'smallest-reversible-change'],
  ['multi-file', 'feature', 'dependency-aware-change'],
  ['hidden-dependency', 'inspect', 'dependency-aware-change'],
  ['failed-first-attempt', 'repair', 'smallest-reversible-change'],
  ['wrong-hypothesis', 'repair', 'inspect-first'],
  ['crash-recovery', 'resume', 'checkpoint-resume'],
  ['ambiguous-request', 'clarify', 'inspect-first'],
  ['missing-tests', 'verify', 'test-first'],
  ['unexpected-side-effect', 'verify', 'impact-first'],
  ['complex-autonomous', 'execute', 'dependency-aware-change'],
]

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-intel-bench-')) }

export function runIntelligenceBenchmark({ keep = false } = {}) {
  const cwd = temp()
  const alpha = createAlphaIntelligence({ cwd, klass: 'MEDIUM', objective: 'benchmark' })
  const state = createCognitiveState({ taskId: 'benchmark', objective: 'benchmark' })
  const graph = createEvidenceGraph({ maxNodes: 128 })
  const learning = createLearningLoop({ maxRecords: 128 })
  const rows = []
  const t0 = process.hrtime.bigint()

  // Establish measured evidence before allowing the alpha layer to influence ranking.
  for (let i = 0; i < 5; i++) alpha.learn({ strategy: 'smallest-reversible-change', ok: true, klass: 'MEDIUM' })
  for (let i = 0; i < 5; i++) alpha.learn({ strategy: 'broad-change', ok: false, klass: 'MEDIUM' })

  for (const [id, action, strategy] of CASES) {
    const start = process.hrtime.bigint()
    alpha.setContext({ nextKlass: 'MEDIUM', nextObjective: id })
    state.transition(COGNITIVE_PHASE.INSPECT, { reason: id })
    state.transition(COGNITIVE_PHASE.PLAN, { reason: 'plan selected' })
    const ranked = alpha.selectPlans([
      { id: 'A', key: strategy, expectedValue: .75, reversible: true, risk: 'LOW' },
      { id: 'B', key: 'broad-change', expectedValue: .65, reversible: false, risk: 'MEDIUM' },
    ])
    const prediction = alpha.predictDecision({ action, strategy: ranked[0], expected: ['src/a.js'] })
    state.transition(COGNITIVE_PHASE.PREDICT)
    state.transition(COGNITIVE_PHASE.EXECUTE)
    const observation = alpha.observe({ ok: true, files: ['src/a.js'], action })
    state.transition(COGNITIVE_PHASE.OBSERVE)
    const actionNode = graph.addNode('ACTION', id, { files: ['src/a.js'] })
    const verifyNode = graph.addNode('VERIFICATION', 'verified', { files: ['src/a.js'] })
    graph.link(actionNode, verifyNode, 'verified-by')
    state.transition(COGNITIVE_PHASE.VERIFY)
    learning.record({ prediction, action, observation, verification: 'pass', outcome: 'complete', error: 0 })
    alpha.learn({ strategy, ok: true, klass: 'MEDIUM', predictionError: 0 })
    state.transition(COGNITIVE_PHASE.COMPLETE, { reason: 'verified', evidence: [verifyNode] })
    rows.push({ id, selected: ranked[0]?.key, confidence: prediction.confidence, stuck: observation.action ? alpha.stuck() : false, ms: Number(process.hrtime.bigint() - start) / 1e6 })
    // Each case is a fresh state in the real system; reset the local benchmark state.
    state.restore(createCognitiveState({ taskId: id, objective: id }).snapshot())
  }

  // Explicit goal-drift and stuck signals are independently proven.
  const driftBefore = alpha.goalDrift()
  alpha.setContext({ nextObjective: 'changed-objective' })
  const driftAfter = alpha.goalDrift()
  assert.equal(driftBefore.detected, true, 'the benchmark objective changes per case')
  assert.equal(driftAfter.detected, true)
  const stuck = createAlphaIntelligence({ cwd, klass: 'MEDIUM', objective: 'stuck' })
  stuck.observe({ action: 'retry', ok: false })
  stuck.observe({ action: 'retry', ok: false })
  stuck.observe({ action: 'retry', ok: false })
  assert.equal(stuck.stuck(), true)

  const persisted = alphaIntelligencePath(cwd)
  const disk = JSON.parse(fs.readFileSync(persisted, 'utf8'))
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6
  const result = {
    schema: '1.0.0',
    benchmark: 'forge-intelligence-integration',
    deterministic: true,
    provider: false,
    claims: { liveCodingSuccess: false, note: 'provider-free integration only; use forge eval for live-model capability' },
    cases: CASES.length,
    stateTransitions: rows.length * 6,
    evidenceNodes: graph.snapshot().nodes.length,
    learningSamples: learning.snapshot().calibration.samples,
    learnedStrategySamples: Object.values(disk.strategies).reduce((n, r) => n + (r.samples || 0), 0),
    goalDriftDetected: driftAfter.detected,
    stuckDetected: stuck.stuck(),
    elapsedMs,
    rows,
    cwd: keep ? cwd : undefined,
  }
  if (!keep) fs.rmSync(cwd, { recursive: true, force: true })
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(runIntelligenceBenchmark({ keep: process.env.FORGE_BENCH_KEEP === '1' }), null, 2))
