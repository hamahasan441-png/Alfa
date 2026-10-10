/**
 * forge — the controller's finalization (Phase 2 split of meta.js)
 *
 * Moved VERBATIM out of the tail of runMeta, after the segment loop: the
 * segment safety fuse (CHECKPOINT → PERSIST → WAITING / CONTINUE_REQUIRED),
 * cancel reaching the DAG nodes (v115), the explicit terminal transition
 * that never turns WAITING into FAILED, the critical-durability refusal, the
 * cognitive mirror, outcome recording for model routing, TASK_FINISHED, the
 * approved plan's verified step states, and the result object runMeta
 * returns.
 *
 * Scope analysis (a parser, not reading) found what it reads from runMeta
 * (passed in `ctx`) and the four values it changes: continuationCount,
 * finalState, finalStatus, finalText. Three earlier closures in runMeta also
 * use those (attemptCompletion, refuseCompletion, productiveContinuation);
 * none of them is called during finalization, directly or through the
 * functions it does call, so the changes can stay local here. Nothing in
 * runMeta runs after this. `FINAL` and `explicitFinalization` arrive through
 * `ctx`, so this module never imports meta.js.
 */
import fs from "node:fs"
import path from "node:path"
import * as dagLib from "./dag.js"
import { TASK_STATUS, DURABILITY } from "./taskstate.js"
import { snapshotBefore, boundaryCheckpoint } from "./checkpoint.js"
import { recordOutcome } from "./modelstrategy.js"

export async function finalizePhase(ctx) {
  const { approvedPlan, changedFiles, classified, cognition, dag, deletedFiles, emit, engMem, lastGate, lastRefusal, ledger, maxContinuations, maxSeg, persistCritical, persistDAG, planShape, prov, recomputeFinalRisk, repairCount, requiredCaps, segment, sel, settleWorkers, signal, state, taskId, taskRunId, totalToolCalls, ts, FINAL, explicitFinalization } = ctx
  let { continuationCount, finalState, finalStatus, finalText } = ctx
  const { lastError = null } = ctx
  // P0 segment safety fuse: maxSegments is a SAFETY LIMIT, not a task failure.
  //   CHECKPOINT → PERSIST → WAITING / CONTINUE_REQUIRED → RESUME
  // It is persisted with everything resume needs: taskId, runId, nodeId,
  // segmentId, checkpointId, DAG state, verification epoch and next action.
  // The continuation budget keeps "resume later" from looping forever: past it
  // the task genuinely is FAILED (it had N chances and did not converge).
  if (finalStatus !== FINAL.COMPLETED && finalStatus !== FINAL.CANCELLED && segment >= maxSeg) {
    await settleWorkers()
    let cpId = null
    try {
      const cwd = process.cwd()
      const touched = [...changedFiles].filter((f) => { try { return fs.existsSync(f) } catch { return false } })
      cpId = touched.length
        ? snapshotBefore(touched, cwd, [], taskRunId)
        : boundaryCheckpoint(cwd, { runId: taskRunId, label: `safety-fuse-${segment}`, objective: state.objective })
      if (cpId) { ts.noteCheckpoint(cpId); try { engMem.rememberCheckpoint(cpId) } catch { } }
      emit({ type: "CHECKPOINT_CREATED", taskId, runId: taskRunId, boundary: "safety-fuse", segment, checkpointId: cpId })
    } catch {}
    continuationCount++
    ts.noteContinuation?.()
    persistDAG()
    emit({
      type: "SEGMENT_SAFETY_FUSE",
      taskId, runId: taskRunId, segment, nodeId: state.node_id ?? null,
      maxSegments: maxSeg,
      continuation: continuationCount,
      maxContinuations,
      checkpointId: cpId,
      continuationRequired: true,
      reason: `segment safety budget (${maxSeg}) reached — checkpointed and waiting for resume (CONTINUE_REQUIRED), not FAILED`,
      autoContinueRefused: lastRefusal,
    })
    if (continuationCount > maxContinuations) {
      finalStatus = explicitFinalization(FINAL.FAILED)
      finalState = TASK_STATUS.FAILED
      finalText = `continuation budget exhausted after ${continuationCount} resume(s) — not converging`
      ts.transition(TASK_STATUS.FAILED, { reason: finalText })
      ts.setNextAction(null)
      persistCritical()
      ts.noteError("CONTINUATION_BUDGET_EXHAUSTED", finalText)
    } else {
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalState = TASK_STATUS.WAITING
      finalText = `segment safety budget (${maxSeg}) reached — checkpointed and waiting for resume (CONTINUE_REQUIRED), not FAILED (continuation ${continuationCount}/${maxContinuations})`
      ts.transition(TASK_STATUS.WAITING, { reason: `safety fuse: ${maxSeg} segments reached — CONTINUE_REQUIRED` })
      ts.setNextAction(`continue_required: safety budget ${maxSeg} reached — resume later`)
      persistCritical()
      ts.noteError("SEGMENT_BUDGET_CONTINUE", finalText)
    }
  }

  // A cancelled run must never be reported as anything else.
  if (signal?.aborted && finalStatus !== FINAL.CANCELLED) {
    finalStatus = explicitFinalization(FINAL.CANCELLED)
    finalState = TASK_STATUS.CANCELLED
    finalText = finalText || "cancelled by user"
  }

  // v115 — THE CANCEL HAS TO REACH THE NODES, NOT ONLY THE TASK.
  //
  // The task level was always handled correctly: three separate abort points
  // transition to CANCELLED. The DAG was not. dag.markCancelled() — written
  // for exactly this, cascade included — had NO caller anywhere, tests
  // included, which forge's own selfaudit reported. So a user pressing Ctrl+C
  // left the in-flight node RUNNING on disk forever:
  //
  //   TASK status : CANCELLED      node n1: running      node n2: pending
  //
  // That is not cosmetic. empirics, lessons, metalearn and selfmodel all learn
  // from node outcomes, and a resumed run's recovery reads a RUNNING node with
  // a dead pid as interrupted work. A person changing their mind was being
  // recorded as the agent failing, and then learned from.
  if (finalStatus === FINAL.CANCELLED && dag) {
    try {
      const inFlight = [...dag.nodes.values()]
        .filter((n) => n.status === dagLib.NODE_STATUS.RUNNING || n.status === dagLib.NODE_STATUS.PENDING)
        .map((n) => n.id)
      const cancelled = new Set()
      for (const id of inFlight) {
        if (cancelled.has(id)) continue
        for (const c of dagLib.markCancelled(dag, id, { cascade: true })) cancelled.add(c)
      }
      if (cancelled.size) {
        persistDAG()
        emit({ type: "PLAN_CANCELLED", taskId, runId: taskRunId, cancelledNodes: [...cancelled],
          reason: "cancelled by user — unfinished work is CANCELLED, never FAILED" })
      }
    } catch { /* the cancel verdict stands even if the graph cannot be written */ }
  }

  // P0 explicit finalization: preserve actual terminal state
  // COMPLETED → COMPLETED, FAILED → FAILED, WAITING → WAITING, CANCELLED → CANCELLED
  // Never silently convert WAITING into FAILED
  if (finalStatus === FINAL.COMPLETED) ts.transition(TASK_STATUS.COMPLETED, { reason: "done", durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.FAILED) ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.WAITING) ts.transition(TASK_STATUS.WAITING, { reason: finalText, durability: DURABILITY.CRITICAL })
  else if (finalStatus === FINAL.CANCELLED) ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel", durability: DURABILITY.CRITICAL })
  else ts.transition(TASK_STATUS.FAILED, { reason: finalText, durability: DURABILITY.CRITICAL })

  // P1 critical durability: the terminal state MUST reach disk. If it does not,
  // say so and refuse to report COMPLETED — never pretend it was persisted.
  if (!persistCritical()) {
    emit({ type: "CRITICAL_PERSISTENCE_FAILED", taskId, runId: taskRunId, error: "terminal state could not be written — completion is not durable" })
    if (finalStatus === FINAL.COMPLETED) {
      finalStatus = explicitFinalization(FINAL.WAITING)
      finalState = TASK_STATUS.WAITING
      finalText = `completed but NOT durably persisted — waiting instead of claiming success`
      ts.transition(TASK_STATUS.WAITING, { reason: finalText })
      try { ts.flush(DURABILITY.CRITICAL) } catch {}
    }
  }

  // V4 user-task finalization: the meta controller owns the lifecycle, but the
  // cognitive core must also reach a terminal phase and persist its final
  // contract/evidence view. Before this boundary the meta path created and
  // used cognition but only the one-shot agent called cognition.close(), so a
  // successful autonomous task could leave cognition.json describing an
  // unfinished phase. The meta result remains authoritative; this is the
  // cognitive mirror and never overrides FINAL.COMPLETED/FAILED/WAITING.
  try {
    const cognitiveFinalRisk = recomputeFinalRisk()
    const finalVerification = ledger.status(cognitiveFinalRisk.risk, [...changedFiles].map((f) => path.relative(process.cwd(), f)))
    const cognitiveClose = cognition.close({
      wrote: changedFiles.size > 0,
      unverified: finalVerification.ok ? [] : (finalVerification.missing ?? []),
    })
    cognition.persist()
    emit({ type: "COGNITION_FINALIZED", taskId, runId: taskRunId, ok: cognitiveClose.ok, status: cognitiveClose.status })
  } catch (e) {
    // Cognitive persistence is important, but the canonical task-state result
    // must remain the source of truth if this descriptive mirror fails.
    emit({ type: "COGNITION_FINALIZE_FAILED", taskId, runId: taskRunId, reason: String(e?.message ?? e).slice(0, 180) })
  }

  // P1 model routing on REAL history: record what this run actually achieved
  // so the next routing decision is evidence-based, not name-based.
  try {
    const vAll = ledger.all()
    recordOutcome({
      provider: prov?.name ?? null,
      model: prov?.model ?? null,
      taskClass: (requiredCaps?.[0]?.class) ?? (sel?.decision?.capabilities?.[0]) ?? "general",
      ok: finalStatus === FINAL.COMPLETED,
      crashed: state.errors?.some((e) => /PROVIDER|CRASH|PROCESS/i.test(String(e.code ?? ""))) === true,
      repairs: repairCount,
      verificationPassed: vAll.filter((r) => r.passed).length,
      verificationTotal: vAll.length,
      latencyMs: state.resource_usage?.ms ?? null,
      tokensIn: state.resource_usage?.tokens_in ?? 0,
      tokensOut: state.resource_usage?.tokens_out ?? 0,
      toolCalls: totalToolCalls,
    })
    // v96 unifywise: the empirics ledger (model-outcomes.json — what compose's
    // MODELS line reads) had NO production writer: it stayed empty in every
    // real run and pickModelEmpiric surfaced nothing. The run's outcome now
    // reaches BOTH stores — modelstrategy's performance ledger (capability
    // scoring, Bayesian-shrunk) and empirics (the compose/CLI display view).
    try {
      const { recordModelOutcome } = await import("./empirics.js")
      recordModelOutcome({
        provider: prov?.name ?? null,
        model: prov?.model ?? null,
        ok: finalStatus === FINAL.COMPLETED,
        ms: state.resource_usage?.ms ?? null,
        klass: classified?.class ?? null,
      })
    } catch { /* the empirics view is best-effort */ }
    // v126: the plan SHAPE this run executed. Recorded beside the model
    // outcome because it is the same question one layer up — the planner chose
    // a shape from an estimate about itself, and this is the only place that
    // knows whether it worked. Only when alternatives() actually ran: with no
    // choice there is nothing to learn.
    if (planShape) {
      try {
        const { recordPlanShape } = await import("./metalearn.js")
        recordPlanShape({
          cwd: process.cwd(),
          klass: classified?.class ?? null,
          shape: planShape,
          ok: finalStatus === FINAL.COMPLETED,
        })
      } catch { /* shape memory is best-effort */ }
    }
  } catch { }

  emit({ type: "TASK_FINISHED", taskId, runId: taskRunId, status: finalStatus, state: finalState, segments: segment, repairs: repairCount, text: String(finalText).slice(0, 300) })

  // V5: the approved plan's steps take the state the controller VERIFIED for
  // their DAG nodes — the plan's checklist is the controller's truth, not a
  // second opinion about it.
  let planSummary = null
  if (approvedPlan?.slug) {
    try {
      const P = await import("./plans.js")
      const planCwd = approvedPlan.cwd ?? process.cwd()
      const st = P.loadPlanState(approvedPlan.slug, planCwd)
      if (st) {
        if (dag) P.syncFromDag(st, dagLib.serializeDAG(dag), { taskId })
        P.finishPlanRun(st, { runId: taskRunId, taskId, status: finalStatus })
        P.savePlanState(st, planCwd)
        const prog = P.planProgress(st)
        planSummary = { planId: st.planId, slug: st.slug, status: st.status, completed: prog.completed, skipped: prog.skipped, open: prog.open.length }
        emit({ type: "PLAN_FINISHED", taskId, runId: taskRunId, ...planSummary })
      }
    } catch { /* the task result stands; plan bookkeeping never changes it */ }
  }

  const finalRisk = recomputeFinalRisk()
  return {
    taskId,
    runId: taskRunId,
    plan: planSummary,
    status: finalStatus,
    state: finalState,
    text: finalText,
    segments: segment,
    repairs: repairCount,
    toolCalls: totalToolCalls,
    filesChanged: [...changedFiles],
    filesDeleted: [...deletedFiles],
    // FINAL risk (recalculated from what actually changed), not the planning risk
    risk: finalRisk.risk,
    initialRisk: finalRisk.initialRisk,
    riskEscalated: finalRisk.escalated,
    riskSignals: finalRisk.signals,
    completionGate: lastGate ? { ok: lastGate.ok, status: lastGate.status, checks: lastGate.checks, blockers: lastGate.blockers } : null,
    verification: ledger.status(finalRisk.risk, [...changedFiles].map((f) => path.relative(process.cwd(), f))),
    task: state,
    // Audit 2026-10 (E2): why a run that did not complete ended — the last
    // segment error (a FAILED run without one: its final text). Additive.
    error: finalStatus === FINAL.COMPLETED ? null : (lastError ?? (finalStatus === FINAL.FAILED ? (finalText || null) : null)),
  }
}
