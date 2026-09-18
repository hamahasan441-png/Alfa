/**
 * forge — measured learning loop (v130 alpha)
 * Prediction → Action → Observation → Verification → Outcome.
 * Records are bounded and neutral; policy changes remain owned by existing
 * empirical/routing modules.
 */
export function createLearningLoop({ maxRecords = 256 } = {}) {
  const records = []
  let seq = 0
  function record(input = {}) {
    const r = {
      id: `learn-${Date.now().toString(36)}-${(++seq).toString(36)}`,
      at: Date.now(),
      prediction: input.prediction ?? null,
      action: input.action ?? null,
      observation: input.observation ?? null,
      verification: input.verification ?? null,
      outcome: input.outcome ?? null,
      attribution: input.attribution ?? null,
      error: Number.isFinite(Number(input.error)) ? Number(input.error) : null,
    }
    records.push(r)
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords)
    return r
  }
  function calibration() {
    const usable = records.filter((r) => Number.isFinite(r.error))
    if (!usable.length) return { samples: 0, meanAbsError: null }
    const meanAbsError = usable.reduce((s, r) => s + Math.abs(r.error), 0) / usable.length
    return { samples: usable.length, meanAbsError: Number(meanAbsError.toFixed(4)) }
  }
  function snapshot() { return { schema: "1.0.0", records: records.map((r) => ({ ...r })), calibration: calibration() } }
  function restore(input) {
    if (!input || typeof input !== "object") return false
    records.length = 0
    if (Array.isArray(input.records)) records.push(...input.records.slice(-maxRecords).map((r) => ({ ...r })))
    return true
  }
  return { record, calibration, snapshot, restore, get records() { return records.map((r) => ({ ...r })) } }
}
