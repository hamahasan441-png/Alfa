/**
 * forge — mid-task replan policy (v28, zero dependencies)
 *
 * Cycle replan already lives in meta.js (PLAN_CYCLE_DETECTED). This module
 * is the OTHER replan: verification evidence says the remaining DAG is
 * wrong, so rewrite the unfinished part and keep completed nodes.
 *
 * MICRO/SMALL never replan (fast path). At most once (twice on 8-core
 * burst). Does not talk to a model or the filesystem — meta owns the call.
 */
import { TASK_CLASS } from "./classify.js"

export function maxReplans(profile = null) {
  if (profile?.burst) return 2
  return 1
}

/**
 * Should the controller rewrite the remaining DAG?
 *
 * Triggers:
 *   - two failed repairs or two consecutive failed segments (the plan is
 *     the common cause)
 *   - omega escalate after at least one repair (rejected cause / FORGE origin)
 *
 * Never: MICRO/SMALL, or after the replan cap.
 */
export function shouldReplan({
  klass,
  repairCount = 0,
  consecutiveFailures = 0,
  replanCount = 0,
  profile = null,
  escalate = false,
  stuck = false,
} = {}) {
  const k = String(klass || "")
  if (k === TASK_CLASS.MICRO || k === TASK_CLASS.SMALL) return false
  if (replanCount >= maxReplans(profile)) return false
  // v94 masterwise (§10): a DETECTED STUCK state mandates a strategy change —
  // repeated tool loops / repeated failures / no meaningful progress mean the
  // current plan shape is the problem. Stuck never becomes completion; it
  // becomes a bounded replan of the remaining graph.
  if (stuck) return true
  if (escalate && (repairCount >= 1 || consecutiveFailures >= 1)) return true
  if (repairCount >= 2 || consecutiveFailures >= 2) return true
  return false
}

/** Planner prompt: keep completed work, do not repeat failed steps. */
export function replanPrompt({
  objective,
  reason = "",
  evidence = "",
  completed = [],
  failed = [],
  lessons = "",
  avoided = [],
  causal = "",
  rejected = [],
  contradicted = [],
} = {}) {
  const lines = [
    String(objective ?? "").trim() || "task",
    "",
    "The current plan is NOT working. Rewrite ONLY the remaining work as a numbered list (one action per line, 3-8 steps). Mark read-only investigation vs implementation. Do NOT execute.",
  ]
  if (reason) lines.push("", `Why we are re-planning: ${String(reason).slice(0, 400)}`)
  if (evidence) lines.push(`Evidence: ${String(evidence).slice(0, 400)}`)
  if (causal) lines.push(`Causal target: ${String(causal).slice(0, 240)}`)
  if (completed.length) {
    lines.push("", "ALREADY DONE (you may depend on these ids, do not redo them):")
    for (const n of completed.slice(0, 12)) {
      lines.push(`- ${n.id}: ${String(n.objective ?? n.title ?? "").slice(0, 160)}`)
    }
  } else {
    lines.push("", "Nothing is verified complete yet — produce a fresh plan.")
  }
  // A step that was never attempted did not fail: calling it failed told the
  // planner to avoid work nobody had tried. Attempted = it ended FAILED or
  // BLOCKED, or it carries an error or a repair reason.
  const attempted = (n) => n.status === "failed" || n.status === "blocked" || Boolean(n.error || n.repair_reason)
  const tried = failed.filter(attempted)
  const notStarted = failed.filter((n) => !attempted(n))
  if (tried.length) {
    lines.push("", "THESE STEPS FAILED (do not repeat them as-is):")
    for (const n of tried.slice(0, 8)) {
      const err = n.error || n.repair_reason || ""
      lines.push(`- ${n.id}: ${String(n.objective ?? "").slice(0, 140)}${err ? ` — ${String(err).slice(0, 120)}` : ""}`)
    }
  }
  if (notStarted.length) {
    lines.push("", "NOT STARTED (keep, rework or drop them as the new plan needs):")
    for (const n of notStarted.slice(0, 8)) lines.push(`- ${n.id}: ${String(n.objective ?? "").slice(0, 140)}`)
  }
  // Strategic Core §19: this task's own memory. A second replan used to see
  // only the plan it was replacing — what the FIRST replan had already tried
  // and dropped was gone, and could be proposed again.
  const rej = (Array.isArray(rejected) ? rejected : []).filter((r) => r && r.text)
  if (rej.length) {
    lines.push("", "ALREADY TRIED IN THIS TASK AND REJECTED (do not propose these again):")
    for (const r of rej.slice(-8)) lines.push(`- ${String(r.text).slice(0, 160)}${r.why ? ` — ${String(r.why).slice(0, 120)}` : ""}`)
  }
  // Strategic Core §11: "my previous assumption was wrong" — a plan built on
  // an assumption that a check has contradicted has to be rebuilt around it.
  const con = (Array.isArray(contradicted) ? contradicted : []).filter((c) => c && c.text)
  if (con.length) {
    lines.push("", "ASSUMPTIONS THE EVIDENCE CONTRADICTED (the new plan must not rely on them):")
    for (const c of con.slice(0, 6)) lines.push(`- ${String(c.text).slice(0, 160)}${c.evidence ? ` — ${String(c.evidence).slice(0, 120)}` : ""}`)
  }
  if (lessons) lines.push("", String(lessons).slice(0, 1200))
  if (avoided.length) {
    lines.push("", `Do NOT repeat these previously-ineffective approaches: ${avoided.slice(0, 6).join("; ")}`)
  }
  lines.push("", "Use new step numbers. A step may only depend on steps that come strictly before it, or on an ALREADY DONE id.")
  return lines.join("\n")
}

/** Compact planner prefix from lessonsForPlan() — also used on the FIRST plan. */
export function planLessonsPrefix(planLessons) {
  if (!planLessons) return ""
  const parts = []
  if (planLessons.text) parts.push(String(planLessons.text).slice(0, 1200))
  if (planLessons.avoided?.length) {
    parts.push(`Do NOT repeat these previously-ineffective approaches: ${planLessons.avoided.slice(0, 6).join("; ")}`)
  }
  return parts.join("\n")
}


export function ingestVerificationFailure(event = {}) {
  const reason = String(event.reason ?? event.evidence ?? "verification failed").slice(0, 500)
  const nodeId = event.nodeId == null ? null : String(event.nodeId)
  return {
    type: "VERIFICATION_FAILED",
    shouldReplan: true,
    targeted: Boolean(nodeId),
    nodeId,
    reason,
    command: event.command ? String(event.command).slice(0, 300) : null,
    exitCode: Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null,
  }
}

export function replanFromVerificationFailure(failure = {}) {
  return { type: "targeted-replan", reason: String(failure.reason ?? "verification failed").slice(0, 500), nodeId: failure.nodeId ?? null, avoid: failure.command ? [failure.command] : [] }
}
