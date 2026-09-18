/** Deterministic probability calibration metrics for Forge predictions. */
export function calibrationMetrics(rows = [], { bins = 10 } = {}) {
  const valid = (Array.isArray(rows) ? rows : []).filter(r => Number.isFinite(r?.confidence) && typeof r?.correct === 'boolean').map(r => ({ p: Math.max(0, Math.min(1, r.confidence)), y: r.correct ? 1 : 0 }))
  if (!valid.length) return { samples: 0, brier: null, ece: null, bins: [] }
  const brier = valid.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / valid.length
  const n = Math.max(1, Math.min(20, Number(bins) || 10))
  const groups = Array.from({ length: n }, () => [])
  for (const r of valid) groups[Math.min(n - 1, Math.floor(r.p * n))].push(r)
  const summary = groups.map((g, i) => ({ bin: i, count: g.length, confidence: g.length ? g.reduce((s,r)=>s+r.p,0)/g.length : null, accuracy: g.length ? g.reduce((s,r)=>s+r.y,0)/g.length : null }))
  const ece = summary.reduce((s, b) => s + (b.count / valid.length) * (b.count ? Math.abs(b.confidence - b.accuracy) : 0), 0)
  return { samples: valid.length, brier: Number(brier.toFixed(6)), ece: Number(ece.toFixed(6)), bins: summary }
}

export function appendCalibration(store, prediction, actual) {
  const correct = prediction?.expectedOutcome != null && actual != null ? String(prediction.expectedOutcome) === String(actual) : null
  if (correct == null) return store
  const confidence = Number(prediction.confidence)
  if (!Number.isFinite(confidence)) return store
  const rows = Array.isArray(store) ? store.slice() : []
  rows.push({ id: prediction.id || null, confidence, correct, at: Date.now() })
  return rows.slice(-256)
}
