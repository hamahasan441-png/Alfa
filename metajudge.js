/**
 * forge — judging a finished segment (Phase 2 split of meta.js)
 *
 * The tail of runMeta's segment loop, moved VERBATIM: the verification hard
 * gate (final risk recomputed from what actually changed, the ledger's
 * verdict, repair or replan on failure), node completion only on node
 * verification, the v99 reviewer pass over the changed code, and the ONE
 * whole-task completion decision (attemptCompletion / refuseCompletion).
 *
 * judgeSegment(ctx) returns what the loop does next: "break" (the task
 * reached a terminal decision), "continue" (start the next segment now) or
 * null (end of the iteration — the same as continue). Each of the eight
 * `break` / `continue` statements that left this block in the loop is now
 * `return "break"` / `return "continue"` — found from the parsed source,
 * not by text, as were its 39 inputs. The two it changes (currentNode,
 * currentNodeId) are per-iteration loop variables that nothing reads after
 * this block; the closures that capture them run before it. Every other
 * value it changes is on runState. `FINAL` arrives in `ctx`, so this module
 * never imports meta.js.
 */
import fs from "node:fs"
import path from "node:path"
import * as dagLib from "./dag.js"
import { TASK_STATUS } from "./taskstate.js"
import { finalRiskForChange } from "./verifyledger.js"
import { runCodeReview } from "./codereview.js"
import { requestVerification } from "./metarepair.js"

/** Required actions derived from a segment's own completion gate. */
export const SEGMENT_GATE_PREFIX = "segment gate: "

export async function judgeSegment(ctx) {
  const { addRequiredAction, affectedSymbols, agent, answerOf, attemptCompletion, boundedRepair, changedBefore, changedFiles, cognition, completeNodeIfVerified, config, ctxEngine, deletedFiles, emit, episodeSink, ledger, liveRisk, mutatingCommands, omega, persistCritical, persistDAG, recs, refuseCompletion, res, reviewedChangeKeys, riskLevel, runState, segChanged, segDiags, segment, segmentId, signal, state, taskId, taskRunId, tryMidTaskReplan, ts, FINAL } = ctx
  let { currentNode, currentNodeId } = ctx
  // the previous segment's gate blockers are history: this segment's result
  // is judged afresh below (see segGateBlockers)
  try { ctx.dropRequiredActions?.(SEGMENT_GATE_PREFIX) } catch { }
    // --- VERIFICATION HARD GATE (P0) ---------------------------------------
    ts.transition(TASK_STATUS.VERIFYING, { reason: "post-segment verification" })

    // P0: FINAL RISK IS RECALCULATED FROM WHAT ACTUALLY CHANGED.
    // riskLevel is the PLANNING risk (from the objective). riskNow (below the
    // loop) only counted files. Neither inspects paths. A task that said "add a
    // comment" (trivial) but went on to edit package.json, a migration and an
    // authentication module must be verified as CRITICAL, not as trivial.
    for (const c of res.commandChecks ?? []) if (c?.command) mutatingCommands.add(String(c.command))
    for (const r of recs) for (const c of (r.commands ?? [])) if (c) mutatingCommands.add(String(c))
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    let impact = null
    if (changedRel.length) {
      try {
        impact = omega.impact(changedRel.map((f) => path.resolve(process.cwd(), f)))
        let cf = null
        try { cf = omega.counterfactualOf(null) } catch { cf = null }
        emit({
          type: "IMPACT_ANALYZED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
          radius: impact.radius, scope: impact.scope, importers: impact.importers.length,
          tests: impact.tests.slice(0, 8), unknown: impact.unknown,
          stillAtRisk: cf?.stillAtRisk?.slice(0, 8) || [],
        })
        for (const f of changedRel) omega.noteWrite(f)
        try { cognition.observeTools(changedRel.map((f) => ({ name: "edit_file", args: { path: f }, result: "ok" }))) } catch { }
        try { cognition.persist() } catch { }
      } catch { /* impact is advisory; never block verification */ }
    }
    const finalRisk = finalRiskForChange({
      task: state.objective,
      initialRisk: riskLevel,
      changedFiles: changedRel,
      createdFiles: (state.files_created ?? []).map((f) => path.relative(process.cwd(), f)),
      deletedFiles: [...deletedFiles].map((f) => path.relative(process.cwd(), f)),
      affectedSymbols: affectedSymbols,
      commands: [...mutatingCommands],
    })
    const finalRiskLevel = finalRisk.risk
    if (finalRisk.escalated) {
      ts.setNextAction(`verify: risk recalculated ${finalRisk.initialRisk} → ${finalRiskLevel} (${finalRisk.signals.slice(0, 3).join(", ")})`)
      emit({
        type: "FINAL_RISK_RECALCULATED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
        initialRisk: finalRisk.initialRisk, finalRisk: finalRiskLevel,
        signals: finalRisk.signals, reasons: finalRisk.reasons, counts: finalRisk.counts,
      })
    }
    // The node itself is now officially under verification (not completed).
    if (runState.dag && currentNodeId && !res.error) dagLib.markVerifying(runState.dag, currentNodeId)

    const v = ledger.status(finalRiskLevel, changedRel, { nodeId: currentNodeId })
    emit({ type: "VERIFICATION_STATUS", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: v.ok, missing: v.missing, reason: v.reason, risk: finalRiskLevel, initialRisk: riskLevel, status: v.status })
    // v96 unifywise: the episode's VERIFICATION stage — the segment-level
    // verdict (what the gate actually judged), one bounded record per segment.
    if (episodeSink) episodeSink.addVerification({ command: `segment-${segment} verification (${finalRiskLevel}): ${String(v.reason ?? v.status ?? "").slice(0, 160)}`, ok: v.ok === true })

    // VERIFICATION FAILED → REPAIRING (hard gate). The node goes back to
    // REPAIRING too: execution succeeded, the OUTCOME did not.
    if (v.anyFailure) {
      if (runState.dag && currentNodeId) { try { dagLib.markRepairing(runState.dag, currentNodeId, v.reason); persistDAG() } catch { } }
      ts.transition(TASK_STATUS.REPAIRING, { reason: "verification failed" })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segment, segmentId, nodeId: currentNodeId, attempt: runState.repairCount + 1, error: v.reason })
      const repair = await boundedRepair({ agent, config, provider: runState.prov, signal, emit, state, error: v.reason, segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId: currentNodeId, finalRisk: finalRiskLevel, omega, changedFiles: [...changedFiles], liveRisk, episodeSink, verifierReport: runState.lastVerifierReport })
      const recovered = repair.recovered
      runState.repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      runState.evidenceRequests = 0

      // REPAIR → VERIFYING → (PASS) COMPLETED. The repair agent records its
      // own evidence in the ledger, so re-judge the node here: if the evidence
      // now holds, the node is DONE — otherwise it goes back to VERIFYING and
      // the next segment retries it.
      if (repair.retryBlocked) {
        const rp = await tryMidTaskReplan({
          reason: repair.admission.reason || "repair retry circuit opened",
          evidence: v.reason || "verification failure",
          stuck: true,
        })
        if (!rp.ok) {
          runState.finalStatus = FINAL.FAILED
          runState.finalState = TASK_STATUS.FAILED
          runState.finalText = `repair retry budget exhausted or strategy repeated: ${repair.admission.reason}`
          ts.transition(TASK_STATUS.FAILED, { reason: runState.finalText })
          persistCritical()
          return "break"
        }
        currentNodeId = null
        currentNode = null
        ts.transition(TASK_STATUS.EXECUTING, { reason: "retry circuit opened; replanned remaining work" })
        return "continue"
      }

      if (runState.dag && currentNodeId) {
        try {
          const vAfter = ledger.status(finalRiskLevel, changedRel, { nodeId: currentNodeId })
          if (vAfter.ok && !vAfter.anyFailure) {
            completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "after-repair" })
            // if that was the last node, the gate can decide immediately
            if (dagLib.allComplete(runState.dag)) {
              const outcome = await attemptCompletion({ text: answerOf(res), segment, segmentId, nodeId: currentNodeId })
              if (outcome.done) return "break"
            }
          } else {
            dagLib.markVerifying(runState.dag, currentNodeId)
            persistDAG()
            const rp = await tryMidTaskReplan({
              reason: vAfter.reason || v.reason || "verification failed",
              evidence: (vAfter.missing || v.missing || []).join(", "),
            })
            if (rp.ok) { currentNodeId = null; currentNode = null }
          }
        } catch { }
      }
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after verification repair" })
      return "continue"
    }

    // The segment's OWN completion gate (agent.js canCompleteFastPath) is
    // evidence too: a sub-run that ended INCOMPLETE because its latest check
    // is red, it changed a forbidden file, or its plan steps are open did not
    // finish its work, whatever its error/budget flags say. Its substantive
    // blockers become REQUIRED ACTIONS (dropped at the top of the next judged
    // segment, re-added only while still true), so the whole-task gate cannot
    // complete over them. A missing final answer or a spent budget is the
    // controller's own continuation business, not a blocker of the work.
    const SEGMENT_ONLY = new Set(["finalAnswerPresent", "notBudgetExhausted", "evidencePreserved"])
    const segGateBlockers = res.completionGate?.ok === false
      ? (res.completionGate.blockers ?? []).filter((b) => b && !SEGMENT_ONLY.has(b.check))
      : []
    for (const b of segGateBlockers.slice(0, 4)) addRequiredAction(`${SEGMENT_GATE_PREFIX}${b.check}: ${String(b.reason ?? "").slice(0, 300)}`)
    const finished = !res.budgetHit && segGateBlockers.length === 0
    const needsMore = res.budgetHit

    const noMutation = changedFiles.size === 0
    // Verification is required unless nothing was mutated, or the FINAL
    // (recalculated) risk is trivial. Note this uses finalRiskLevel, not the
    // planning-time riskLevel — this is the single most important consumer of
    // the recalculation.
    const verificationRequired = !(noMutation || finalRiskLevel === "trivial")

    // --- NODE COMPLETION REQUIRES NODE VERIFICATION (P0) -------------------
    // Execution already succeeded above; the node may now be marked COMPLETED
    // only if its verification passed (or it has nothing to verify: a read-only
    // node, or a node that did not actually mutate anything at trivial risk).
    if (runState.dag && currentNodeId && !res.error) {
      try {
        const nodeObj = runState.dag.nodes.get(currentNodeId)
        const segMutation = changedFiles.size > changedBefore
        const nodeNeedsVerification = nodeObj
          ? (nodeObj.read_only !== true && (segMutation || finalRiskLevel !== "trivial"))
          : true
        if (!nodeNeedsVerification) {
          dagLib.markCompleted(runState.dag, currentNodeId, `segment ${segment}: read-only node, no artifact to verify`, { verification: dagLib.VERIFICATION_NOT_REQUIRED })
          persistDAG()
        } else if (!completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "post-segment" })) {
          dagLib.markVerifying(runState.dag, currentNodeId)
          emit({ type: "DAG_NODE_AWAITING_VERIFICATION", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, missing: v.missing, risk: finalRiskLevel })
          persistDAG()
        }
      } catch { }
    }

    // If the segment merely spent its budget, continue to the next one.
    // v94 masterwise (§6): a budget end is CHECKPOINT → OBSERVE → CONTINUE.
    // The budgetHit flag means the AGENT WANTED MORE STEPS — it is never a
    // completion trigger, even when the DAG looks finished (a later segment
    // may still invalidate evidence). The completion gate runs only on a
    // segment that ended cleanly, below.
    if (!finished) {
      runState.evidenceRequests = 0
      ts.setNextAction("continue: segment budget spent, work remains")
      ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
      return "continue"
    }

    // --- v99 loopwise: the REVIEWER pass ------------------------------------
    // A clean segment that mutated files gets ONE bounded read-only code
    // review of the actual change (diff + LSP diagnostics + failing ledger
    // evidence), before the completion gate is asked anything. This is the
    // "second pair of eyes" the v98 surfaces lacked: review.js checked
    // METADATA at completion; this checks the CODE per mutation. Blockers
    // become required actions (which block completion and drive repair —
    // and are re-derived on every later completion attempt, never stale).
    // Bounded: maxPerTask reviews (default 4), skipped at trivial risk,
    // honest when the reviewer pass is unavailable (deterministic findings
    // alone still review), never throws.
    {
      const maxReviews = Number.isFinite(Number(config?.review?.maxPerTask)) ? Math.max(0, Number(config.review.maxPerTask)) : 4
      const reviewOn = config?.review?.code !== false && maxReviews > 0 && runState.codeReviewsDone < maxReviews
      let reviewKey = null
      if (reviewOn && segChanged.size && finalRiskLevel !== "trivial" && !res.error) {
        try {
          const { createHash } = await import("node:crypto")
          const h = createHash("sha256")
          for (const f of [...segChanged].sort()) { h.update(String(f)); h.update("\0"); try { h.update(fs.readFileSync(f)) } catch { h.update("<missing>") }; h.update("\0") }
          reviewKey = h.digest("hex")
        } catch { reviewKey = null }
      }
      if (reviewKey && reviewedChangeKeys.has(reviewKey)) {
        emit({ type: "CODE_REVIEW_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: "the changed files are byte-identical to a change set already reviewed in this task", key: reviewKey.slice(0, 12) })
      } else if (reviewOn && segChanged.size && finalRiskLevel !== "trivial" && !res.error) {
        if (reviewKey) reviewedChangeKeys.add(reviewKey)
        runState.codeReviewsDone++
        try {
          emit({ type: "CODE_REVIEW_STARTED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, files: [...segChanged].map((f) => path.relative(process.cwd(), f)).slice(0, 16) })
          const failingRecords = (ledger.records() ?? [])
            .filter((r) => Number(r.exit_code ?? r.exitCode ?? 0) !== 0 && r.command)
            .slice(-8)
            .map((r) => ({ command: r.command, exit_code: Number(r.exit_code ?? r.exitCode ?? 0), evidence: r.evidence ?? null }))
          const review = await runCodeReview({
            agent, config, provider: runState.prov, signal, emit,
            objective: state.objective,
            understanding: (() => { try { return cognition.understandingBlock({ compact: true }) } catch { return "" } })(),
            files: [...segChanged],
            diagnostics: segDiags,
            ledgerFailures: failingRecords,
            taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
          })
          emit({
            type: "CODE_REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
            ok: review.blockers.length === 0,
            findings: review.findings.length, blockers: review.blockers.length,
            detail: review.findings.slice(0, 8).map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.issue}`),
            sources: review.sources, facts: review.facts,
          })
          if (episodeSink && review.findings.length) {
            episodeSink.addEvidence(`code review: ${review.findings.slice(0, 4).map((f) => `${f.severity} ${f.file}: ${String(f.issue ?? "").slice(0, 80)}`).join(" | ")}`)
          }
          // blockers → required actions (recurring prefix; re-derived on every
          // completion attempt — refreshRecurringActions keeps them honest).
          // V5: only BINDING findings (observed facts, or reviewer claims the
          // owner chose to enforce) may hold completion; a reviewer model's
          // blocker is carried as advice and recorded, never as evidence.
          for (const b of (review.blocking ?? review.blockers).slice(0, 4)) {
            addRequiredAction(`codereview: ${b.file}: ${String(b.issue ?? b.id).slice(0, 160)}`)
          }
          const advisory = review.blockers.filter((b) => !b.blocking)
          if (advisory.length) {
            emit({ type: "CODE_REVIEW_ADVISORY", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId,
              findings: advisory.slice(0, 8).map((f) => ({ file: f.file, line: f.line ?? null, claim: f.claim, confidence: f.confidence, recommendedAction: f.recommendedAction, epoch: f.epoch })) })
          }
        } catch (e) {
          emit({ type: "CODE_REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, ok: true, findings: 0, blockers: 0, detail: [], error: String(e?.message ?? e).slice(0, 160) })
        }
      }
    }

    // --- the ONE authoritative whole-task completion decision (P0) ---------
    // Nothing above may declare COMPLETED. The gate asks the global question:
    // is the whole DAG finished, are all workers settled, is the evidence
    // sufficient for the FINAL risk, is recovery clear, and did the terminal
    // state actually reach disk?
    if (!verificationRequired || v.ok) {
      const outcome = await attemptCompletion({ text: answerOf(res), segment, segmentId, nodeId: currentNodeId })
      if (outcome.done) return "break"
    } else if (runState.evidenceRequests < 1) {
      // Evidence is thin for the final risk: ask the READ-ONLY verifier for it.
      runState.evidenceRequests++
      ts.setNextAction(`verify: run ${v.missing.join(" / ")} before declaring success`)
      ts.transition(TASK_STATUS.VERIFYING, { reason: "requesting risk-proportional evidence" })
      emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segmentId, nodeId: currentNodeId, reason: `objective met but evidence is thin for risk=${finalRiskLevel} — run ${v.missing.join(", ")} to verify`, missing: v.missing })
      runState.lastVerifierReport = (await requestVerification({ agent, config, provider: runState.prov, signal, emit, state, missing: v.missing, ts, ledger, ctxEngine, taskRunId, taskId, segmentId, nodeId: currentNodeId, risk: finalRiskLevel, impact }))?.report ?? null
      // the verifier produced new evidence: the node may now be completed
      completeNodeIfVerified(currentNodeId, { risk: finalRiskLevel, segmentId, phase: "after-verification" })
      const outcome = await attemptCompletion({ text: answerOf(res), segment, segmentId, nodeId: currentNodeId })
      if (outcome.done) return "break"
    }

    // The gate refused completion: fall back to the safe state it recommended.
    const outcome = await refuseCompletion({ v, segment, segmentId, nodeId: currentNodeId, finalRiskLevel, text: res.text })
    if (outcome.done) return "break"

    runState.evidenceRequests = 0
    ts.setNextAction("continue: segment budget spent, work remains")
    ts.transition(TASK_STATUS.EXECUTING, { reason: "continuing to next segment" })
  return null
}
