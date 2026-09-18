/**
 * Forge Alpha Intelligence — additive decision layer.
 *
 * This module does not replace governor/planner/verification. It sits above
 * existing authorities and supplies measured ranking, uncertainty, causal
 * attribution, drift/stuck detection, counterfactual notes and persistent
 * learning. Every adaptive decision is bounded by evidence thresholds.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { projectDir } from './memory.js'
import { writeStateFile, withStateFileLock } from './securefs.js'

export const ALPHA_INTELLIGENCE_VERSION = '1.0.0'
const FILE = 'alpha-intelligence.json'
const MAX_HISTORY = 256
const MIN_LEARN = 5
const MIN_MARGIN = 0.08
const MAX_PLANS = 8
const MAX_CAUSES = 32
const clamp = (n, a = 0, b = 1) => Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : a
const safe = (v, n = 400) => String(v ?? '').slice(0, n)

export function alphaIntelligencePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), FILE)
}

function empty() {
  return { v: ALPHA_INTELLIGENCE_VERSION, updated: 0, history: [], strategies: {}, causes: [], decisions: [] }
}

export function loadAlphaIntelligence(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(alphaIntelligencePath(cwd), 'utf8'))
    if (j && typeof j === 'object') return { ...empty(), ...j }
  } catch {}
  return empty()
}

function save(cwd, state) {
  state.v = ALPHA_INTELLIGENCE_VERSION
  state.updated = Date.now()
  writeStateFile(alphaIntelligencePath(cwd), JSON.stringify(state, null, 1), { mode: 0o600 })
}

export const ALPHA_FAILURE_CLASS = Object.freeze({
  CODE: 'CODE', TEST: 'TEST', ENVIRONMENT: 'ENVIRONMENT', DEPENDENCY: 'DEPENDENCY',
  TOOL: 'TOOL', MODEL: 'MODEL', CONTEXT: 'CONTEXT', PLAN: 'PLAN', STATE: 'STATE',
  INTEGRATION: 'INTEGRATION', UNKNOWN: 'UNKNOWN',
})

export function classifyFailureClass(d = {}) {
  const code = String(d.code ?? '').toUpperCase()
  const text = `${code} ${d.evidence ?? ''} ${d.message ?? ''}`.toLowerCase()
  if (/module_not_found|dependency|package|lockfile|peer dep/.test(text)) return ALPHA_FAILURE_CLASS.DEPENDENCY
  if (/test_fail|tests? failed|assert|pytest|jest|vitest|mocha/.test(text)) return ALPHA_FAILURE_CLASS.TEST
  if (/timeout|timed.?out|enoent|eacces|port|connection refused|dns|network/.test(text)) return ALPHA_FAILURE_CLASS.ENVIRONMENT
  if (/tool|schema|invalid argument|unsupported command/.test(text)) return ALPHA_FAILURE_CLASS.TOOL
  if (/model|provider|context window|rate limit/.test(text)) return ALPHA_FAILURE_CLASS.MODEL
  if (/plan|dag|dependency cycle|missing node/.test(text)) return ALPHA_FAILURE_CLASS.PLAN
  if (/state|checkpoint|resume|transition/.test(text)) return ALPHA_FAILURE_CLASS.STATE
  if (/api|contract|integration|http 4|http 5/.test(text)) return ALPHA_FAILURE_CLASS.INTEGRATION
  if (/syntax|referenceerror|typeerror|undefined|exception/.test(text)) return ALPHA_FAILURE_CLASS.CODE
  return ALPHA_FAILURE_CLASS.UNKNOWN
}

function riskPenalty(p) {
  const r = String(p?.risk ?? p?.riskLevel ?? '').toUpperCase()
  return r === 'CRITICAL' ? .35 : r === 'HIGH' ? .22 : r === 'MEDIUM' ? .10 : r === 'LOW' ? .03 : 0
}

function churnPenalty(p) {
  return Math.min(.18, (Number(p?.repairs) || 0) * .025 + (Number(p?.replans) || 0) * .035)
}

export function createAlphaIntelligence({ cwd = process.cwd(), klass = 'SMALL', objective = '' } = {}) {
  let state = loadAlphaIntelligence(cwd)
  let lastPrediction = null
  let lastObservation = null
  let lastDecision = null
  let sameActionStreak = 0
  let lastActionKey = ''
  let objectiveFingerprint = ''
  let goalDriftCount = 0

  function fingerprintGoal(value) {
    return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)
  }

  function setContext({ nextKlass = null, nextObjective = null } = {}) {
    if (nextKlass) klass = safe(nextKlass, 24)
    if (nextObjective != null) {
      const next = safe(nextObjective, 240)
      const nextFp = fingerprintGoal(next)
      if (objectiveFingerprint && nextFp !== objectiveFingerprint) goalDriftCount += 1
      objective = next
      objectiveFingerprint = nextFp
    }
    return { klass, objective, goalDrift: goalDriftCount > 0 }
  }

  function goalDrift() {
    return { detected: goalDriftCount > 0, count: goalDriftCount, fingerprint: objectiveFingerprint || fingerprintGoal(objective) }
  }

  function strategyStats(key) {
    return state.strategies?.[`${klass}:${key}`] || null
  }

  function selectPlans(candidates = []) {
    const list = Array.isArray(candidates) ? candidates.slice(0, MAX_PLANS) : []
    const scored = list.map((p, i) => {
      const key = safe(p?.key || p?.id, 100)
      const rec = strategyStats(key)
      const measured = rec && rec.samples >= MIN_LEARN ? rec.rate : null
      const learned = measured == null ? 0.5 : measured
      const expected = clamp(Number(p?.expectedValue))
      const reversibility = p?.reversible === true ? .06 : 0
      const score = clamp(expected * .52 + learned * .32 + reversibility - riskPenalty(p) - churnPenalty(p))
      return { ...p, alphaScore: Number(score.toFixed(4)), alphaEvidence: { samples: rec?.samples || 0, measuredRate: measured } }
    })
    scored.sort((a, b) => b.alphaScore - a.alphaScore || String(a.id).localeCompare(String(b.id)))
    lastDecision = scored[0] ? { kind: 'plan', selected: scored[0].key || scored[0].id, margin: scored.length > 1 ? scored[0].alphaScore - scored[1].alphaScore : null } : null
    state.decisions.push({ at: Date.now(), ...lastDecision, klass })
    state.decisions = state.decisions.slice(-64)
    return scored
  }

  function predictDecision({ action = '', strategy = null, expected = [] } = {}) {
    const key = safe(strategy?.key || strategy?.id || action, 100)
    const rec = strategyStats(key)
    const samples = rec?.samples || 0
    const learned = samples >= MIN_LEARN ? rec.rate : null
    const base = learned == null ? .5 : learned
    const confidence = clamp(base * .65 + (samples >= MIN_LEARN ? .25 : samples / MIN_LEARN * .15))
    lastPrediction = { id: `alpha-pred-${Date.now().toString(36)}`, action: safe(action, 60), strategy: key, expected: Array.isArray(expected) ? expected.slice(0, 24) : [], confidence, samples }
    return lastPrediction
  }

  function observe({ ok = null, files = [], failure = null, action = '' } = {}) {
    const fc = failure ? classifyFailureClass(failure) : null
    lastObservation = { at: Date.now(), ok: ok == null ? null : Boolean(ok), files: Array.isArray(files) ? files.slice(0, 24) : [], failureClass: fc, action: safe(action, 60) }
    if (lastObservation.action) {
      if (lastObservation.action === lastActionKey) sameActionStreak += 1
      else { lastActionKey = lastObservation.action; sameActionStreak = 1 }
    } else {
      sameActionStreak = 0
      lastActionKey = ''
    }
    return lastObservation
  }

  function attributeCause({ layer = 'SYMPTOM', description = '', confidence = .5, evidence = [] } = {}) {
    const c = { id: `cause-${Date.now().toString(36)}-${state.causes.length}`, layer: safe(layer, 24), description: safe(description), confidence: clamp(confidence), evidence: Array.isArray(evidence) ? evidence.slice(0, 6).map(x => safe(x, 240)) : [], at: Date.now() }
    state.causes.push(c)
    state.causes = state.causes.slice(-MAX_CAUSES)
    return c
  }

  function counterfactual({ changed = [], affected = [], tests = [] } = {}) {
    const a = new Set((Array.isArray(affected) ? affected : []).map(String))
    const c = (Array.isArray(changed) ? changed : []).map(String)
    return { changed: c.slice(0, 24), residualFiles: [...a].filter(x => !c.includes(x)).slice(0, 24), residualTests: (Array.isArray(tests) ? tests : []).slice(0, 24), note: 'residual impact remains unknown unless observed or verified' }
  }

  function drift({ expectedFiles = [], actualFiles = [] } = {}) {
    const e = new Set((Array.isArray(expectedFiles) ? expectedFiles : []).map(String))
    const a = new Set((Array.isArray(actualFiles) ? actualFiles : []).map(String))
    const extra = [...a].filter(x => !e.has(x))
    const missed = [...e].filter(x => !a.has(x))
    const denom = Math.max(1, e.size, a.size)
    return { score: clamp((extra.length + missed.length) / denom), extra, missed, level: extra.length || missed.length ? (missed.length ? 'MISS' : 'SCOPE') : 'MATCH' }
  }

  function stuck() {
    return sameActionStreak >= 3
  }

  function learn({ strategy = '', ok = false, repairs = 0, replans = 0, predictionError = null, klass: k = klass } = {}) {
    const key = safe(strategy, 100)
    if (!key) return null
    const id = `${k}:${key}`
    let result = null
    withStateFileLock(alphaIntelligencePath(cwd), () => {
    // Reload inside the lock: the in-memory snapshot may be stale when another
    // Forge process records an outcome concurrently. Preserve local, not-yet-
    // persisted causal/decision evidence while merging the latest disk state.
    const localCauses = Array.isArray(state.causes) ? state.causes.slice() : []
    const localDecisions = Array.isArray(state.decisions) ? state.decisions.slice() : []
    const latest = loadAlphaIntelligence(cwd)
    const byId = new Map([...(latest.causes || []), ...localCauses].map((x) => [x.id, x]))
    const decisions = [...(latest.decisions || []), ...localDecisions]
    state = { ...latest, causes: [...byId.values()].slice(-MAX_CAUSES), decisions: decisions.slice(-64) }
    const rec = state.strategies[id] || { samples: 0, ok: 0, failed: 0, repairs: 0, replans: 0, errorSum: 0, errorSamples: 0 }
    rec.samples += 1
    ok ? rec.ok++ : rec.failed++
    rec.repairs += Math.max(0, Number(repairs) || 0)
    rec.replans += Math.max(0, Number(replans) || 0)
    if (Number.isFinite(predictionError)) { rec.errorSum += Math.abs(predictionError); rec.errorSamples++ }
    rec.rate = rec.ok / rec.samples
    rec.avgRepairs = rec.repairs / rec.samples
    rec.avgReplans = rec.replans / rec.samples
    rec.predictionMAE = rec.errorSamples ? rec.errorSum / rec.errorSamples : null
    rec.lastAt = Date.now()
    state.strategies[id] = rec
    const event = { at: Date.now(), klass: k, strategy: key, ok: Boolean(ok), samples: rec.samples, learned: rec.samples >= MIN_LEARN }
    state.history.push(event)
    state.history = state.history.slice(-MAX_HISTORY)
    save(cwd, state)
    result = rec
    })
    return result
  }

  function prompt() {
    const recs = Object.entries(state.strategies).filter(([id, r]) => id.startsWith(`${klass}:`) && r.samples >= MIN_LEARN).sort((a,b) => b[1].rate-a[1].rate).slice(0, 3)
    const lines = [`ALPHA INTELLIGENCE v${ALPHA_INTELLIGENCE_VERSION}: evidence is advisory; existing authorities remain final.`]
    if (recs.length) for (const [id, r] of recs) lines.push(`- learned ${id.slice(klass.length + 1)}: ${Math.round(r.rate*100)}% success/${r.samples}, repairs=${r.avgRepairs.toFixed(1)}, replans=${r.avgReplans.toFixed(1)}`)
    if (lastDecision?.selected) lines.push(`- selected strategy: ${lastDecision.selected}${lastDecision.margin != null ? ` margin=${lastDecision.margin.toFixed(2)}` : ''}`)
    if (stuck()) lines.push('- STUCK SIGNAL: same action repeated 3+ times; change hypothesis/strategy before repeating')
    if (goalDrift().detected) lines.push(`- GOAL DRIFT SIGNAL: objective changed ${goalDriftCount} time(s); revalidate contract and plan before continuing`)
    if (lastObservation?.failureClass) lines.push(`- failure class: ${lastObservation.failureClass}`)
    return lines.join('\n')
  }

  function snapshot() {
    return { schema: '1.0.0', version: ALPHA_INTELLIGENCE_VERSION, klass, objective: safe(objective, 240), goalDrift: goalDrift(), lastPrediction, lastObservation, lastDecision, stuck: stuck(), strategies: Object.fromEntries(Object.entries(state.strategies).filter(([id]) => id.startsWith(`${klass}:`))), causes: state.causes.slice(-8), history: state.history.slice(-16) }
  }

  return { setContext, goalDrift, selectPlans, predictDecision, observe, attributeCause, counterfactual, drift, stuck, learn, prompt, snapshot }
}
