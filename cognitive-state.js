/**
 * forge — explicit execution state machine (v130 alpha kernel)
 *
 * Additive coordination state. It does not replace the existing governor,
 * contract, verification ledger, or task state; it gives them one small,
 * serializable vocabulary for long-horizon runs.
 *
 * The state is descriptive, never an authorization bypass. Safety/correctness
 * decisions remain owned by the existing layers.
 */
export const COGNITIVE_PHASE = Object.freeze({
  UNDERSTAND: "UNDERSTAND",
  INSPECT: "INSPECT",
  PLAN: "PLAN",
  PREDICT: "PREDICT",
  EXECUTE: "EXECUTE",
  OBSERVE: "OBSERVE",
  VERIFY: "VERIFY",
  DIAGNOSE: "DIAGNOSE",
  REPAIR: "REPAIR",
  REPLAN: "REPLAN",
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
  WAITING: "WAITING",
})

const ALLOWED = new Map([
  [COGNITIVE_PHASE.UNDERSTAND, new Set([COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.PLAN, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.INSPECT, new Set([COGNITIVE_PHASE.PLAN, COGNITIVE_PHASE.PREDICT, COGNITIVE_PHASE.DIAGNOSE, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.PLAN, new Set([COGNITIVE_PHASE.PREDICT, COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.PREDICT, new Set([COGNITIVE_PHASE.EXECUTE, COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.EXECUTE, new Set([COGNITIVE_PHASE.OBSERVE, COGNITIVE_PHASE.VERIFY, COGNITIVE_PHASE.DIAGNOSE, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.OBSERVE, new Set([COGNITIVE_PHASE.VERIFY, COGNITIVE_PHASE.DIAGNOSE, COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.EXECUTE, COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.VERIFY, new Set([COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.REPAIR, COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.DIAGNOSE, COGNITIVE_PHASE.EXECUTE, COGNITIVE_PHASE.INCOMPLETE])],
  // DIAGNOSE may return to INSPECT: after diagnosing a failure the governor can
  // legitimately gather more evidence (re-inspect) before committing to a repair,
  // so this decision is reflected in the phase rather than emitted only as text.
  [COGNITIVE_PHASE.DIAGNOSE, new Set([COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.REPAIR, COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.VERIFY, COGNITIVE_PHASE.INCOMPLETE, COGNITIVE_PHASE.COMPLETE])],
  [COGNITIVE_PHASE.REPAIR, new Set([COGNITIVE_PHASE.PREDICT, COGNITIVE_PHASE.EXECUTE, COGNITIVE_PHASE.VERIFY, COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.INCOMPLETE, COGNITIVE_PHASE.COMPLETE])],
  [COGNITIVE_PHASE.REPLAN, new Set([COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.PLAN, COGNITIVE_PHASE.PREDICT, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.INCOMPLETE, COGNITIVE_PHASE.COMPLETE])],
  [COGNITIVE_PHASE.COMPLETE, new Set([COGNITIVE_PHASE.COMPLETE])],
  [COGNITIVE_PHASE.INCOMPLETE, new Set([COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.PLAN, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.INCOMPLETE])],
  [COGNITIVE_PHASE.WAITING, new Set([COGNITIVE_PHASE.UNDERSTAND, COGNITIVE_PHASE.INSPECT, COGNITIVE_PHASE.PLAN, COGNITIVE_PHASE.EXECUTE, COGNITIVE_PHASE.REPLAN, COGNITIVE_PHASE.WAITING, COGNITIVE_PHASE.COMPLETE, COGNITIVE_PHASE.INCOMPLETE])],
])

function clean(value, max = 300) {
  return String(value ?? "").slice(0, max)
}

export function createCognitiveState({ taskId = "", objective = "" } = {}) {
  let phase = COGNITIVE_PHASE.UNDERSTAND
  let sequence = 0
  const transitions = []
  const facts = new Map()

  function setFact(key, value) {
    const k = clean(key, 120)
    if (!k) return false
    facts.set(k, value)
    return true
  }

  function transition(next, { reason = "", evidence = [] } = {}) {
    const target = clean(next, 40)
    if (!Object.values(COGNITIVE_PHASE).includes(target)) return { ok: false, reason: "unknown phase", phase }
    const allowed = ALLOWED.get(phase)
    if (!allowed?.has(target)) {
      return { ok: false, reason: `invalid transition ${phase} -> ${target}`, phase }
    }
    const from = phase
    phase = target
    sequence += 1
    transitions.push({ seq: sequence, from, to: target, at: Date.now(), reason: clean(reason), evidence: Array.isArray(evidence) ? evidence.slice(0, 8).map((x) => clean(x, 160)) : [] })
    if (transitions.length > 80) transitions.splice(0, transitions.length - 80)
    return { ok: true, from, to: target, seq: sequence }
  }

  function snapshot() {
    return {
      schema: "1.0.0",
      taskId: clean(taskId, 160),
      objective: clean(objective, 1000),
      phase,
      sequence,
      facts: Object.fromEntries(facts),
      transitions: transitions.map((x) => ({ ...x, evidence: [...x.evidence] })),
    }
  }

  function restore(input) {
    if (!input || typeof input !== "object") return false
    const requested = clean(input.phase, 40)
    if (Object.values(COGNITIVE_PHASE).includes(requested)) phase = requested
    sequence = Number.isFinite(Number(input.sequence)) ? Math.max(0, Number(input.sequence)) : sequence
    facts.clear()
    if (input.facts && typeof input.facts === "object" && !Array.isArray(input.facts)) {
      for (const [k, v] of Object.entries(input.facts).slice(0, 80)) facts.set(clean(k, 120), v)
    }
    transitions.length = 0
    if (Array.isArray(input.transitions)) transitions.push(...input.transitions.slice(-80).map((x) => ({
      seq: Number(x?.seq) || 0,
      from: clean(x?.from, 40), to: clean(x?.to, 40), at: Number(x?.at) || 0,
      reason: clean(x?.reason), evidence: Array.isArray(x?.evidence) ? x.evidence.slice(0, 8).map((e) => clean(e, 160)) : [],
    })))
    return true
  }

  return { transition, setFact, snapshot, restore, get phase() { return phase } }
}
