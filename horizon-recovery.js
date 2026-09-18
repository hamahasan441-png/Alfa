/** Forge Horizon Recovery — deterministic resume guidance for long runs.
 * Additive/advisory: checkpoint/restore and governor remain authoritative.
 */
export const HORIZON_RECOVERY_VERSION = "1.0.0"

const clean = (v, n = 240) => String(v ?? "").slice(0, n)

export function planHorizonRecovery({ nodes = [], completed = [], failed = [], evidence = [], reason = "INTERRUPTED", attempt = 0 } = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const done = new Set((Array.isArray(completed) ? completed : []).map(String))
  const bad = new Set((Array.isArray(failed) ? failed : []).map(String))
  const frontier = list.filter(n => n?.id && !done.has(String(n.id)) && (!Array.isArray(n.dependencies) || n.dependencies.every(d => done.has(String(d)))))
  const stale = Array.isArray(evidence) ? evidence.filter(e => e?.stale === true || e?.status === "STALE").length : 0
  const blocked = list.filter(n => n?.id && !done.has(String(n.id)) && Array.isArray(n.dependencies) && n.dependencies.some(d => bad.has(String(d)))).map(n => String(n.id)).slice(0, 32)
  const action = bad.size || stale ? "REPLAN" : frontier.length ? "RESUME" : "INVESTIGATE"
  return {
    version: HORIZON_RECOVERY_VERSION,
    action,
    reason: clean(reason, 80),
    attempt: Math.max(0, Number(attempt) || 0),
    resume: frontier.slice(0, 8).map(n => String(n.id)),
    blocked,
    staleEvidence: stale,
    checkpointRequired: action !== "INVESTIGATE",
    bounded: true,
  }
}
