/**
 * forge — bounded outcome model (v140 alpha core)
 *
 * Evidence-backed policy feedback for strategy selection.
 * This is additive: existing governor/model/skill routing remain authoritative.
 * A learned strategy is eligible only with enough same-project evidence and a
 * meaningful success-rate advantage. It can never manufacture completion.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile, withStateFileLock } from "./securefs.js"

export const OUTCOME_MODEL_VERSION = "2.0.0"
export const OUTCOME_MODEL_FILE = "outcome-model.json"
export const MIN_STRATEGY_SAMPLES = 5
export const MIN_RATE_GAP = 0.12
export const MAX_ROWS = 128
export const MAX_RECENT = 16

export function outcomeModelPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), OUTCOME_MODEL_FILE)
}

export function loadOutcomeModel(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(outcomeModelPath(cwd), "utf8"))
    if (j && typeof j === "object" && j.byKlass && typeof j.byKlass === "object") return j
  } catch { /* first run */ }
  return { v: OUTCOME_MODEL_VERSION, byKlass: {}, updated: 0 }
}

function save(cwd, store) {
  writeStateFile(outcomeModelPath(cwd), JSON.stringify(store, null, 1), { mode: 0o600 })
}

function keyOf(key) {
  return String(key ?? "").trim().slice(0, 80)
}

export function recordStrategyOutcome({
  cwd = process.cwd(), klass = "SMALL", key = "", ok = false,
  repairs = 0, replans = 0, drift = null,
} = {}) {
  const k = String(klass || "SMALL").slice(0, 24)
  const id = keyOf(key)
  if (!id) return null
  let result = null
  withStateFileLock(outcomeModelPath(cwd), () => {
  const store = loadOutcomeModel(cwd)
  const row = store.byKlass[k] && typeof store.byKlass[k] === "object" ? store.byKlass[k] : {}
  const rec = row[id] && typeof row[id] === "object"
    ? row[id]
    : { samples: 0, ok: 0, failed: 0, repairs: 0, replans: 0, driftSamples: 0, driftSum: 0, recent: [] }
  rec.samples += 1
  if (ok) rec.ok += 1
  else rec.failed += 1
  rec.repairs += Math.max(0, Number(repairs) || 0)
  rec.replans += Math.max(0, Number(replans) || 0)
  if (Number.isFinite(Number(drift))) {
    rec.driftSamples += 1
    rec.driftSum += Math.max(0, Math.min(1, Number(drift)))
  }
  rec.rate = rec.ok / rec.samples
  rec.avgRepairs = rec.repairs / rec.samples
  rec.avgReplans = rec.replans / rec.samples
  rec.avgDrift = rec.driftSamples ? rec.driftSum / rec.driftSamples : null
  rec.recent = Array.isArray(rec.recent) ? rec.recent : []
  rec.recent.push(ok ? 1 : 0)
  if (rec.recent.length > MAX_RECENT) rec.recent = rec.recent.slice(-MAX_RECENT)
  rec.lastAt = Date.now()
  row[id] = rec
  const keys = Object.keys(row)
  if (keys.length > MAX_ROWS) {
    keys.sort((a, b) => (row[a]?.samples || 0) - (row[b]?.samples || 0))
    for (const drop of keys.slice(0, keys.length - MAX_ROWS)) delete row[drop]
  }
  store.byKlass[k] = row
  store.v = OUTCOME_MODEL_VERSION
  store.updated = Date.now()
  save(cwd, store)
  result = rec
  }, { timeoutMs: 60000, pollMs: 10 })
  return result
}

function wilsonLowerBound(successes, samples, z = 1.96) {
  const n = Number(samples) || 0
  if (n <= 0) return 0
  const p = Math.max(0, Math.min(1, (Number(successes) || 0) / n))
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return Math.max(0, Math.min(1, (centre - spread) / denom))
}

function score(rec) {
  if (!rec || rec.samples < MIN_STRATEGY_SAMPLES) return null
  // Outcome v2 uses a conservative confidence bound instead of the raw rate.
  // This prevents a 5/5 strategy from being treated as certain while preserving
  // the old safety invariant: evidence can only refine strategy order, never
  // grant completion or bypass the governor.
  const lower = wilsonLowerBound(rec.ok, rec.samples)
  const churn = Math.min(0.12, (rec.avgRepairs || 0) * 0.025 + (rec.avgReplans || 0) * 0.035)
  const recent = Array.isArray(rec.recent) && rec.recent.length >= 4
    ? rec.recent.reduce((a, b) => a + b, 0) / rec.recent.length
    : null
  const recency = recent == null ? lower : (lower * 0.75 + recent * 0.25)
  return Math.max(0, Math.min(1, recency - churn))
}

export function recommendStrategyOutcome({ cwd = process.cwd(), klass = "SMALL", candidates = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length < 2) return null
  const row = loadOutcomeModel(cwd).byKlass?.[String(klass)] || {}
  const measured = list.map((c) => {
    const key = keyOf(c?.key || c?.id)
    const rec = row[key]
    return rec ? { key, rec, score: score(rec) } : { key, rec: null, score: null }
  }).filter((x) => x.key && x.score != null)
  if (!measured.length) return null
  measured.sort((a, b) => (b.score - a.score) || (b.rec.rate - a.rec.rate) || a.key.localeCompare(b.key))
  const best = measured[0]
  const runner = measured[1]
  const runnerScore = runner?.score
  if (!best || best.rec.samples < MIN_STRATEGY_SAMPLES) return null
  if (runnerScore != null && best.score - runnerScore < MIN_RATE_GAP) return null
  return {
    key: best.key,
    rate: Number(best.rec.rate.toFixed(3)),
    score: Number(best.score.toFixed(3)),
    samples: best.rec.samples,
    confidenceBound: Number(wilsonLowerBound(best.rec.ok, best.rec.samples).toFixed(3)),
    why: `measured ${Math.round(best.rec.rate * 100)}% success over ${best.rec.samples} run(s), conservative bound ${Math.round(wilsonLowerBound(best.rec.ok, best.rec.samples) * 100)}%`,
  }
}
