/**
 * forge — the controller's mid-task replan (Phase 2 split of meta.js)
 *
 * tryMidTaskReplan (v28: rewrite the remaining DAG from verification
 * evidence, keeping completed nodes) moved VERBATIM out of runMeta as
 * makeReplan(deps), with replanMemory — this task's rejected approaches and
 * contradicted assumptions for the replan prompt (Strategic Core §11/§19).
 *
 * The values it changes or must see fresh — dag, prov, repairCount,
 * consecutiveFailures, replanCount — live on runMeta's `runState`. Its other
 * captures are constants, shared containers and taskId (assigned only before
 * this point), passed once; scope analysis confirmed nothing captured is
 * declared later and that it is not called before runMeta creates it.
 * `passThrough` arrives in `deps`: no import of meta.js.
 */
import * as dagLib from "./dag.js"
import { TASK_STATUS } from "./taskstate.js"
import { RECOVERY_LEVEL } from "./recovery.js"
import { engineFor } from "./langengine.js"
import { formatCompose } from "./compose.js"
import { languagesIn, formatLangReason } from "./langreason.js"
import { lessonsForPlan } from "./lessons.js"
import { shouldReplan, replanPrompt, stepReplanPrompt, parseStepRevision, MAX_STEP_REVISIONS } from "./replan.js"

/**
 * What this task has already learned the hard way, for the replan prompt:
 * approaches the understanding marked rejected and assumptions a check
 * contradicted. Empty when there is no understanding yet. Never throws.
 */
export function replanMemory(cognition) {
  try {
    const u = cognition?.understanding?.()
    if (!u) return { rejected: [], contradicted: [] }
    const rejected = (u.rejected ?? []).map((r) => ({ text: r.text, why: r.why ?? null }))
    const contradicted = (u.items ?? []).filter((it) => it.type === "CONTRADICTED")
      .map((it) => ({ text: it.text, evidence: (it.evidence ?? []).at(-1)?.text ?? null }))
    return { rejected, contradicted }
  } catch { return { rejected: [], contradicted: [] } }
}

export function makeReplan(deps) {
  const { agent, classified, cognition, config, emit, omega, persistDAG, resources, runState, signal, state, takeCompose, taskId, taskRunId, ts, passThrough } = deps
  /** v28: rewrite remaining DAG from verification evidence. MICRO never. At most maxReplans. */
  const tryMidTaskReplan = async ({ reason, evidence, stuck = false }) => {
    let escalate = false
    let causalHint = ""
    try {
      const next = omega?.nextRepair?.()
      escalate = next?.action === "escalate"
      if (next?.causal?.node) causalHint = `${next.causal.layer}: ${next.causal.node.description}`
    } catch {}
    if (!shouldReplan({
      klass: classified.class,
      repairCount: runState.repairCount,
      consecutiveFailures: runState.consecutiveFailures,
      replanCount: runState.replanCount,
      profile: resources.state,
      escalate,
      stuck,
    })) return { ok: false }
    if (!runState.dag) return { ok: false }
    // v91 §3/§74: evidence changed the situation — REPLANNING is the honest
    // state before the planner rebuilds the remaining graph.
    ts.transition(TASK_STATUS.REPLANNING, { reason: String(reason ?? "").slice(0, 200) || "evidence invalidated the plan" })
    const completed = [...runState.dag.nodes.values()].filter((n) => n.status === dagLib.NODE_STATUS.COMPLETED)
    const failed = [...runState.dag.nodes.values()].filter((n) => n.status !== dagLib.NODE_STATUS.COMPLETED)
    const planL = lessonsForPlan(state.objective, { cwd: process.cwd() })
    const langBlock = formatLangReason(languagesIn(state.objective, { cwd: process.cwd(), klass: classified.class }))
    const engineBlock = engineFor(state.objective, { cwd: process.cwd(), config, klass: classified.class })
    let composeBlock = ""
    try {
      composeBlock = formatCompose(takeCompose({ refresh: true }))
    } catch { composeBlock = "" }
    const prompt = replanPrompt({
      objective: state.objective,
      reason,
      evidence,
      completed,
      failed,
      lessons: [planL.text, langBlock, engineBlock, composeBlock].filter(Boolean).join("\n\n"),
      avoided: planL.avoided,
      causal: causalHint,
      ...replanMemory(cognition),
    })
    try { ts.noteRecovery({ level: RECOVERY_LEVEL.REPLAN_TASK, kind: stuck ? "replan-stuck" : "replan", reason: String(reason ?? "").slice(0, 200), evidence: String(evidence ?? "").slice(0, 200), outcome: `kept ${completed.length} completed node(s), dropped ${failed.length}` }) } catch {}
    emit({
      type: "PLAN_REPLAN_STARTED",
      taskId, runId: taskRunId,
      reason: String(reason ?? "").slice(0, 240),
      kept: completed.length,
      dropped: failed.length,
      attempt: runState.replanCount + 1,
      // what this plan tried and lost — the understanding records them as
      // rejected approaches, so the NEXT replan still knows (§19)
      failedSteps: failed.filter((n) => n.status === dagLib.NODE_STATUS.FAILED || n.status === dagLib.NODE_STATUS.BLOCKED || n.error || n.repair_reason)
        .slice(0, 8).map((n) => ({ id: n.id, objective: String(n.objective ?? "").slice(0, 160), error: String(n.error || n.repair_reason || "").slice(0, 160) })),
    })
    ts.transition(TASK_STATUS.REPAIRING, { reason: "mid-task replan from verification evidence" })
    let replanRes
    try {
      replanRes = await agent({
        config, provider: runState.prov, signal,
        task: prompt,
        taskId, runId: taskRunId, segmentId: `seg-replan-${runState.replanCount + 1}`, nodeId: null,
        planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4,
        deep: classified.strategy.deep,
        onEvent: passThrough(emit, "replan"), suppressRunEvents: true,
      })
    } catch (e) {
      emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: false, reason: "verification", error: String(e?.message ?? e).slice(0, 200) })
      return { ok: false }
    }
    const defs = dagLib.parsePlanToDAG(replanRes?.text ?? "")
    const result = dagLib.replanRemaining(runState.dag, defs, {
      prefix: `rp${runState.replanCount + 1}_`,
      reason: String(reason ?? "verification"),
      evidence: String(evidence ?? "").slice(0, 600),
      objective: state.objective,
      creator: "mid-task-replan",
    })
    if (!result.ok) {
      emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: false, reason: "verification", error: result.error, nodes: defs.length })
      return { ok: false }
    }
    runState.dag = result.graph
    runState.replanCount++
    persistDAG()
    ts.setPlan([...runState.dag.nodes.values()].map((n) => n.objective ?? n.id), "model+replanned")
    emit({
      type: "PLAN_REPLANNED",
      taskId, runId: taskRunId,
      ok: true,
      reason: "verification",
      kept: result.kept,
      added: result.added,
      dropped: result.dropped,
      nodes: runState.dag.nodes.size,
    })
    return { ok: true, clearNode: true }
  }

  /**
   * Recovery level 3 (REPLAN_STEP): one step failed and its repair did not
   * recover it — revise THAT step's objective (dag.reviseNode) and run it
   * again, before escalating to a task-level replan. Completed nodes, the
   * rest of the graph and its dependencies are untouched. At most
   * MAX_STEP_REVISIONS per node; MICRO never (it has one node: a task replan
   * is the same thing). The replaced objective is recorded as a rejected
   * approach in the understanding, so neither this step nor a later replan
   * proposes it again.
   */
  const tryStepReplan = async ({ nodeId, error = "" } = {}) => {
    const node = nodeId ? runState.dag?.nodes?.get(nodeId) : null
    if (!node || classified?.class === "MICRO" || signal?.aborted) return { ok: false, why: "not eligible" }
    if ((node.revisions?.length ?? 0) >= MAX_STEP_REVISIONS) return { ok: false, why: "step already revised" }
    const memory = replanMemory(cognition)
    let res
    try {
      res = await agent({
        config, provider: runState.prov, signal,
        task: stepReplanPrompt({ objective: state.objective, step: node.objective, error, rejected: memory.rejected, contradicted: memory.contradicted, revisions: node.revisions }),
        taskId, runId: taskRunId, segmentId: `seg-step-replan-${nodeId}-${(node.revisions?.length ?? 0) + 1}`, nodeId,
        planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 2,
        deep: classified?.strategy?.deep,
        onEvent: passThrough(emit, "step-replan"), suppressRunEvents: true,
      })
    } catch (e) {
      emit({ type: "STEP_REPLANNED", taskId, runId: taskRunId, nodeId, ok: false, error: String(e?.message ?? e).slice(0, 200) })
      return { ok: false, why: "planner error" }
    }
    const from = node.objective
    const revised = parseStepRevision(res?.text ?? "", from)
    const rv = revised ? dagLib.reviseNode(runState.dag, nodeId, { objective: revised, reason: String(error).slice(0, 400) }) : { ok: false, error: "no usable revision" }
    if (!rv.ok) {
      emit({ type: "STEP_REPLANNED", taskId, runId: taskRunId, nodeId, ok: false, error: rv.error })
      return { ok: false, why: rv.error }
    }
    persistDAG()
    ts.setPlan([...runState.dag.nodes.values()].map((n) => n.objective ?? n.id), "model+step-revised")
    try { ts.noteRecovery({ level: RECOVERY_LEVEL.REPLAN_STEP, kind: "step-replan", reason: String(error).slice(0, 200), evidence: `${nodeId}: ${String(from).slice(0, 120)}`, outcome: `revised: ${revised.slice(0, 120)}` }) } catch {}
    emit({ type: "STEP_REPLANNED", taskId, runId: taskRunId, nodeId, ok: true, from: String(from).slice(0, 240), to: revised.slice(0, 240), reason: String(error).slice(0, 240), revision: rv.revision })
    return { ok: true }
  }

  return { tryMidTaskReplan, tryStepReplan }
}
