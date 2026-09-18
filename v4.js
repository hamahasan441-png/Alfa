/**
 * Forge V4 cognitive orchestration primitives.
 *
 * Additive by design: V3 remains the behavioral baseline. This module makes
 * adaptive depth, bounded budgets, dependency-aware planning, relevance
 * ranking and evidence invalidation explicit without replacing existing
 * engines. Callers may adopt each primitive independently.
 */

export const V4_VERSION = '4.0.0'
export const V4_DEPTH = Object.freeze({ FAST: 'FAST', NORMAL: 'NORMAL', DEEP: 'DEEP', ORCHESTRATED: 'ORCHESTRATED' })
export const PLAN_STATUS = Object.freeze({ READY: 'READY', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', BLOCKED: 'BLOCKED' })

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(Number(n)) ? Number(n) : 0))
const klassWeight = { MICRO: 0, SMALL: .15, MEDIUM: .35, LARGE: .65, ARCHITECTURAL: .85 }

/** Choose the least expensive cognitive depth justified by the evidence. */
export function selectV4Depth({ klass = 'MEDIUM', uncertainty = 0, impact = 0, failed = false, conflict = false } = {}) {
  const k = klassWeight[String(klass).toUpperCase()] ?? .35
  const u = clamp01(uncertainty)
  const i = clamp01(impact)
  if (conflict || (failed && u >= .65) || (k >= .85 && u >= .65 && i >= .65)) return V4_DEPTH.ORCHESTRATED
  if (failed || u >= .62 || i >= .7 || k >= .65) return V4_DEPTH.DEEP
  if (u >= .3 || i >= .35 || k >= .35) return V4_DEPTH.NORMAL
  return V4_DEPTH.FAST
}

/** Bounded adaptive budget. It can grow with complexity but never without a hard cap. */
export function adaptiveBudget({ base = 20, complexity = .5, uncertainty = 0, impact = 0, failed = false, cap = 200 } = {}) {
  const b = Math.max(1, Math.floor(Number(base) || 1))
  const c = clamp01(complexity)
  const u = clamp01(uncertainty)
  const i = clamp01(impact)
  const multiplier = 1 + (c * .9) + (u * .6) + (i * .6) + (failed ? .4 : 0)
  return Math.min(Math.max(b, Math.ceil(b * multiplier)), Math.max(b, Math.floor(cap)))
}

function normalizeStep(step, index) {
  const id = String(step?.id ?? `step-${index + 1}`).trim() || `step-${index + 1}`
  const dependsOn = Array.isArray(step?.dependsOn) ? [...new Set(step.dependsOn.map(String).filter(Boolean))] : []
  return {
    id,
    title: String(step?.title ?? id),
    dependsOn,
    status: step?.status && Object.values(PLAN_STATUS).includes(step.status) ? step.status : PLAN_STATUS.READY,
    verification: step?.verification ?? null,
    evidenceRequired: Array.isArray(step?.evidenceRequired) ? [...step.evidenceRequired] : [],
  }
}

/** Build a deterministic plan graph and reject duplicate/self dependencies. */
export function buildV4Plan({ objective = '', steps = [] } = {}) {
  const nodes = steps.map(normalizeStep)
  const ids = new Set()
  for (const n of nodes) {
    if (ids.has(n.id)) throw new Error(`duplicate plan node: ${n.id}`)
    ids.add(n.id)
    if (n.dependsOn.includes(n.id)) throw new Error(`self dependency: ${n.id}`)
  }
  for (const n of nodes) for (const d of n.dependsOn) if (!ids.has(d)) throw new Error(`unknown dependency: ${n.id} -> ${d}`)
  // Kahn cycle check. Existing DAG engines remain authoritative for runtime;
  // this check prevents V4 plans from introducing an impossible graph.
  const indeg = new Map(nodes.map(n => [n.id, n.dependsOn.length]))
  const q = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
  let seen = 0
  while (q.length) {
    const id = q.shift(); seen++
    for (const n of nodes) if (n.dependsOn.includes(id)) {
      indeg.set(n.id, indeg.get(n.id) - 1)
      if (indeg.get(n.id) === 0) q.push(n.id)
    }
  }
  if (seen !== nodes.length) throw new Error('plan contains a dependency cycle')
  return { schema: 'forge-v4-plan/1', objective: String(objective ?? ''), nodes }
}

/** Return the next node whose dependencies are all completed. */
export function nextPlanAction(plan) {
  if (!plan?.nodes?.length) return null
  const done = new Set(plan.nodes.filter(n => n.status === PLAN_STATUS.COMPLETED).map(n => n.id))
  return plan.nodes.find(n => n.status === PLAN_STATUS.READY && n.dependsOn.every(d => done.has(d))) ?? null
}

/** Lightweight lexical relevance ranking; deterministic and dependency-free. */
export function rankContextItems(query, items = []) {
  const tokens = String(query ?? '').toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []
  const freq = new Map(); for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  return items.map((item, index) => {
    const text = `${item?.id ?? ''} ${item?.title ?? ''} ${item?.text ?? ''}`.toLowerCase()
    let score = 0
    for (const [token, count] of freq) if (text.includes(token)) score += 1 + Math.min(count, 3) * .1
    return { ...item, _v4Score: score, _v4Order: index }
  }).sort((a, b) => b._v4Score - a._v4Score || a._v4Order - b._v4Order)
    .map(({ _v4Score, _v4Order, ...item }) => item)
}

/** Any evidence tied to a changed path is stale until re-verified. */
export function invalidateEvidence(evidence = [], changedFiles = []) {
  const changed = new Set(changedFiles.map(String))
  return evidence.map(ev => {
    const files = Array.isArray(ev?.files) ? ev.files.map(String) : []
    const touched = files.some(f => changed.has(f))
    return touched && ev?.status === 'VERIFIED' ? { ...ev, status: 'STALE', staleReason: 'workspace changed after verification' } : { ...ev }
  })
}
