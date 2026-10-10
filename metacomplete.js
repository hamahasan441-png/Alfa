/**
 * forge — the controller's completion decision (Phase 2 split of meta.js)
 *
 * attemptCompletion (the ONE whole-task completion gate as runMeta drives it:
 * recurring required actions, the gate, the completion-level shortfall,
 * evolve, verified delivery) and refuseCompletion (moving to the safe state
 * the gate recommended), moved VERBATIM out of runMeta.
 *
 * They were closures over runMeta. Everything they CHANGE now lives on
 * runMeta's `runState` object (finalStatus, finalState, finalText, lastGate,
 * repairCount, completionRepairs, maxSeg, prov, …), so they see and set the
 * current values from here. Everything else they capture is passed once to
 * makeCompletion(): constants, shared containers, and three `let`s (taskId,
 * planRisk, liveRisk) that runMeta never reassigns after this point —
 * confirmed by scope analysis, as is that nothing captured is declared later
 * and that neither function is called before runMeta creates them.
 * `FINAL` and `explicitFinalization` arrive in `deps`: no import of meta.js.
 */
import path from "node:path"
import * as dagLib from "./dag.js"
import { TASK_STATUS, DURABILITY } from "./taskstate.js"
import { canCompleteTask, requirementCoverage, CHECK as GATE_CHECK } from "./completion.js"
import { VTYPE } from "./verifyledger.js"
import { artifactRuntimeEvidence } from "./runtimesession.js"
import { evolveRun, formatEvolve } from "./evolve.js"
import { focusedVerify } from "./verify.js"
import { maybeShip } from "./gitship.js"
import { verificationPlanForRisk } from "./plannerisk.js"
import { yoloState } from "./yolo.js"

export function makeCompletion(deps) {
  const { addRequiredAction, agent, boundedRepair, changedFiles, classified, clearRequiredActions, cognition, completionSummary, config, ctxEngine, decisions91, emit, engMem, episodeSink, ledger, liveRisk, manager, maxRepairs, nodeModels, omega, persistCritical, planRisk, planValidation, pluginStartedAtMs, provRef, recomputeFinalRisk, recoveryDrift, recoveryGateState, refreshRecurringActions, requiredActions, runState, seenConflicts, settleWorkers, signal, state, taskId, taskRunId, ts, FINAL, explicitFinalization } = deps
  const attemptCompletion = async ({ text, segment = 0, segmentId = null, nodeId = null } = {}) => {
    // v99 loopwise: recurring required actions are re-derived below — clear
    // the stale copies from earlier attempts first (see refreshRecurringActions)
    refreshRecurringActions()
    // 1. never complete while a worker is alive
    await settleWorkers()
    const fr = recomputeFinalRisk()
    const changedRel = [...changedFiles].map((f) => path.relative(process.cwd(), f))
    const vv = ledger.status(fr.risk, changedRel, { cwd: process.cwd() })
    // v94 masterwise (§28): RISK-BASED VERIFICATION — the intensity follows
    // the FINAL risk: LOW targeted; MEDIUM +regression; HIGH +integration;
    // CRITICAL full relevant verification + ADVERSARIAL REVIEW + runtime
    // validation. The class strategy may require review earlier; critical
    // risk always does.
    const vPlan = verificationPlanForRisk(fr.risk)
    const needReview = classified.strategy.requireReview || vPlan.adversarialReview
    if (needReview) {
      // v91 §3: REVIEWING is a real, persisted state before completion.
      ts.transition(TASK_STATUS.REVIEWING, { reason: "adversarial final review" })
      emit({ type: "REVIEW_STARTED", taskId, runId: taskRunId, segmentId, nodeId, class: classified.class })
      let rev = { required: true, ok: true, findings: [], blockers: [], checks: [] }
      try {
        const filesAbs = changedRel.map((f) => path.resolve(process.cwd(), f))
        const impactForReview = filesAbs.length ? omega.impact(filesAbs) : {}
        rev = omega.review({
          klass: classified.class,
          objective: state.objective,
          files: changedRel,
          impact: impactForReview,
          verificationOk: vv.ok,
          checkpoint: state.last_checkpoint_id ?? null,
        })
      } catch { /* review is a checklist; never throw out of completion */ }
      emit({
        type: "REVIEW_COMPLETED", taskId, runId: taskRunId, segmentId, nodeId,
        ok: rev.ok, required: rev.required, findings: (rev.findings || []).map((f) => f.id),
        blockers: (rev.blockers || []).map((b) => b.id), checks: rev.checks || [],
      })
      for (const b of rev.blockers || []) addRequiredAction(`review: ${b.id}${b.detail ? ` (${b.detail})` : ""}`)
    }
    // v96 unifywise (§9 requirement traceability → §45 "requirements
    // satisfied"): every ingested REQUIREMENT must be ADDRESSED by real work —
    // a completed node's objective, a changed file, or verification evidence.
    // An uncovered requirement becomes a REQUIRED ACTION, which blocks the
    // gate through the existing noPendingRequiredActions check (the same path
    // review blockers take — no second gate, no new state store). Tasks that
    // never ingested requirements (short objectives) see zero requirements and
    // the check is a no-op — fast paths are untouched.
    let reqCoverage = null
    try {
      const reqs = engMem.requirementRecords?.() ?? []
      if (reqs.length) {
        const nodeObjectives = runState.dag
          ? [...runState.dag.nodes.values()].filter((n) => n.status === dagLib.NODE_STATUS.COMPLETED).map((n) => String(n.objective ?? ""))
          : []
        // only PASSING, current records are evidence that a requirement was tested
        const evidenceTexts = (ledger.all?.() ?? []).filter((r) => r && r.passed === true && !r.invalidated && !r.superseded).map((r) => String(r.evidence ?? r.command ?? ""))
        reqCoverage = requirementCoverage(reqs, {
          nodeObjectives,
          changedFiles: changedRel,
          verificationEvidence: evidenceTexts,
        })
        for (const u of reqCoverage.uncovered.slice(0, 4)) {
          addRequiredAction(`requirement ${u.id ?? "?"} not addressed by any completed work: ${u.text.slice(0, 90)}`)
        }
      }
    } catch { /* coverage is a gate input; its failure must not bypass the gate */ }
    // v98 shipwise — RUNTIME/ARTIFACT EVIDENCE (the declared-then-ignored
    // fix): plannerisk.verificationPlanForRisk promises runtimeValidation at
    // CRITICAL risk, but nothing ever enforced it. Now: when the plan tier
    // demands runtime validation AND the run mutated files AND the project
    // has a PROVEN build command (adapter-gated, never invented), observed
    // artifacts become ledger evidence — and their ABSENCE becomes a required
    // action the gate refuses to complete over. A plain repo with no adapter
    // or no build command is never asked for an artifact.
    try {
      if (vPlan.runtimeValidation && changedRel.length) {
        // A4: the run window starts at task start — only artifacts THIS run
        // produced/updated count as runtime evidence (a dist/ left over from
        // a previous build is not evidence this run built anything)
        const ae = artifactRuntimeEvidence(process.cwd(), { since: pluginStartedAtMs ?? null })
        if (ae?.applicable) {
          if (ae.passed) {
            const rec = ledger.recordCommand(`artifact-observe ${ae.buildCommand}`, ae.evidence, {
              type: VTYPE.ARTIFACT,
              exitCode: 0,
              affectedFiles: changedRel.slice(0, 40),
              taskId,
              nodeId,
              segmentId,
              verificationEpoch: state.verification_epoch ?? 0,
            })
            ts.noteVerification(rec)
            emit({ type: "VERIFICATION_PASSED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: 0, evidence: rec.evidence, verificationId: rec.verification_id, ...(rec.docker ? { docker: rec.docker } : {}) })
          } else {
            addRequiredAction(`critical-risk runtime validation: no build artifact observed for the proven build command "${ae.buildCommand}" — run the build (or provide runtime evidence) before completion`)
          }
        }
      }
    } catch { /* artifact evidence is best-effort; its failure must not bypass the gate */ }
    // Alpha Final — completion levels as a gate input, OPT-IN
    // (agent.requireCompletion: VERIFIED | ACCEPTED | COMPLETE; default off,
    // which leaves this block a no-op). Not a second gate: a shortfall becomes
    // REQUIRED ACTIONS (recurring prefix "completion ", re-derived on every
    // attempt), which the existing gate already refuses to complete over and
    // the next segment is told to resolve. Only runs that changed files are
    // held — the same condition the gate uses for verificationRequired — so a
    // question answered without edits is never blocked by it.
    const requireCompletion = String(config?.agent?.requireCompletion ?? "off")
    if (!/^off$/i.test(requireCompletion) && !(changedFiles.size === 0 || fr.risk === "trivial")) {
      try {
        const { checkAcceptance } = await import("./combine.js")
        const accNow = checkAcceptance({ acceptance: state.goal?.acceptance ?? [], records: ledger.all(), changedFiles: changedRel, cwd: process.cwd() })
        const lvNow = cognition.completion({ changedFiles: changedRel, verification: vv, gateOk: null, acceptance: accNow.filter((x) => x.status !== "UNCHECKED" || !/^prose/.test(x.evidence)) })
        const sf = cognition.shortfall(requireCompletion, { level: lvNow, acceptance: accNow })
        if (sf) {
          for (const r of sf.reasons) addRequiredAction(`completion ${sf.required} required (now ${sf.level}): ${r}`)
          emit({ type: "COMPLETION_SHORTFALL", taskId, runId: taskRunId, segmentId, nodeId, required: sf.required, level: sf.level, reasons: sf.reasons })
        }
      } catch { /* a failure to measure must not bypass the gate's own checks */ }
    }
    // V7: a file the objective said not to change differs from how the TASK
    // found it (baseline taken once at task start — meta.js). Recurring:
    // restoring the file clears it on the next attempt.
    try {
      for (const f of (runState.prohibitedWatch?.changed?.() ?? []).slice(0, 8)) {
        addRequiredAction(`prohibited change: the task said not to change ${f}, and it was changed — restore it`)
      }
    } catch { /* a failure to read the files must not bypass the gate */ }
    // An acceptance criterion the evidence shows FAILED (its named check's
    // latest run is red) is work the task still owes — a required action
    // (recurring prefix "acceptance ", re-derived on every attempt), never a
    // line in a COMPLETED report.
    try {
      const { checkAcceptance, ACCEPTANCE } = await import("./combine.js")
      const accGate = checkAcceptance({ acceptance: state.goal?.acceptance ?? [], records: ledger.all(), changedFiles: changedRel, cwd: process.cwd() })
      for (const a of accGate.filter((x) => x.status === ACCEPTANCE.FAILED).slice(0, 4)) {
        addRequiredAction(`acceptance FAILED: ${String(a.criterion ?? "").slice(0, 160)} — ${String(a.evidence ?? "").slice(0, 160)}`)
      }
    } catch { /* acceptance is a gate input; its failure must not bypass the gate */ }
    const gate = canCompleteTask({
      planValid: planValidation ? planValidation.ok !== false : true,
      planErrors: planValidation?.errors ?? [],
      dag: runState.dag,
      dagValid: Boolean(runState.dag),
      workersSettled: manager.stats().active === 0,
      activeWorkers: manager.stats().active,
      verification: vv,
      verificationRequired: !(changedFiles.size === 0 || fr.risk === "trivial"),
      recovery: recoveryGateState(),
      pendingRequiredActions: [...requiredActions],
      finalStateReconciled: !recoveryDrift(),
      criticalPersistenceSucceeded: runState.criticalPersistenceSucceeded,
      cancelled: Boolean(signal?.aborted),
      repairBudgetRemaining: runState.repairCount < maxRepairs,
      optionalPolicy: config?.agent?.optionalNodePolicy ?? "ignore",
    })
    runState.lastGate = gate
    emit({
      type: "COMPLETION_GATE", taskId, runId: taskRunId, segmentId, nodeId,
      ok: gate.ok, status: gate.status, checks: gate.checks, blockers: gate.blockers,
      finalRisk: fr.risk, initialRisk: fr.initialRisk,
      ...(reqCoverage ? { requirements: { total: reqCoverage.total, covered: reqCoverage.covered, uncovered: reqCoverage.uncovered.slice(0, 4).map((u) => u.id ?? u.text.slice(0, 60)) } } : {}),
      verificationPlan: { level: vPlan.level, targeted: vPlan.targeted, regression: vPlan.regression, integration: vPlan.integration, adversarialReview: vPlan.adversarialReview, runtimeValidation: vPlan.runtimeValidation },
      planRisk: planRisk ? { riskLadder: planRisk.riskLadder, successProbability: planRisk.successProbability, confidence: planRisk.confidence } : null,
      liveSuccessProbability: liveRisk ? liveRisk.get() : null,
    })
    if (!gate.ok) return { done: false, gate }
    runState.finalStatus = explicitFinalization(FINAL.COMPLETED)
    runState.finalState = TASK_STATUS.COMPLETED
    // v125 — THE GOVERNOR'S NOTE IS NOT THE TASK'S ANSWER, HERE EITHER.
    //
    // v118 closed this in agent.js: a governor note is attached only AFTER
    // the fast-path gate, so a STOP can never launder itself into a COMPLETED
    // run's answer. The `--auto` path had the same hole and v118 did not cover
    // it. This kernel reads `res.text` and nothing else — not `res.status`,
    // not `res.governor` — so a segment that ended in a governor STOP handed
    // its note straight in, and if the WHOLE-TASK gate was satisfied on its
    // own terms (DAG complete, workers settled, evidence sufficient) the note
    // became a COMPLETED task's finalText and was emitted as TASK_COMPLETED.
    //
    // The gate is not the thing at fault and is not changed: it asks a
    // different, global question, and it has no business refusing a finished
    // DAG because the last segment happened to end on a note. What is fixed
    // is the laundering — `answered` (agent.js) states whether the MODEL
    // produced this text, so nothing here has to sniff the string, and an
    // unanswered segment falls back to the task's own record instead of
    // dressing a note up as a report.
    runState.finalText = String(text ?? "").trim() || completionSummary()
    // Phase 3 — combine step: one final report from every node, the changed
    // files and each acceptance criterion checked one by one. Deterministic;
    // agent.synthesis: "model" adds one read-only model pass over it, and any
    // failure there keeps the deterministic report.
    try {
      const { checkAcceptance, combineReport, synthesize, ACCEPTANCE } = await import("./combine.js")
      const acc = checkAcceptance({ acceptance: state.goal?.acceptance ?? [], records: ledger.all(), changedFiles: changedRel, cwd: process.cwd() })
      const nodes = runState.dag?.nodes ? [...runState.dag.nodes.values()].map((n) => ({ id: n.id, title: n.title || n.objective, status: n.status, role: n.role, model: nodeModels.get(String(n.id)) ?? null })) : []
      const multi = nodes.length >= 2
      const accShown = multi || acc.some((x) => x.status !== ACCEPTANCE.UNCHECKED || !/^prose/.test(x.evidence))
      if (acc.length) {
        ts.decide("acceptance", acc.map((x) => `${x.status}: ${String(x.criterion).slice(0, 60)}`).join(" | ").slice(0, 300))
        emit({ type: "ACCEPTANCE_CHECKED", taskId, runId: taskRunId, items: acc.map((x) => ({ criterion: String(x.criterion).slice(0, 200), status: x.status, evidence: String(x.evidence).slice(0, 200) })) })
      }
      // Alpha Final: implemented ≠ tested ≠ verified ≠ accepted ≠ complete
      let level = null
      try {
        level = cognition.completion({ changedFiles: changedRel, verification: vv, gateOk: true, acceptance: acc.filter((x) => x.status !== ACCEPTANCE.UNCHECKED || !/^prose/.test(x.evidence)) })
        emit({ type: "COMPLETION_LEVEL", taskId, runId: taskRunId, level: level.level, why: level.why })
        ts.setUnderstanding(cognition.understanding())
      } catch { level = null }
      if (multi || accShown || seenConflicts.length || (level && level.level !== "COMPLETE" && changedRel.length) || (vv?.notApplicable?.length && changedRel.length)) {
        const report = combineReport({ answer: runState.finalText, nodes, changedFiles: changedRel, acceptance: accShown ? acc : [], conflicts: seenConflicts, completion: level, verification: vv })
        let synthesized = null
        if (config?.agent?.synthesis === "model" && multi) {
          synthesized = await synthesize({
            objective: state.objective, report,
            run: (prompt) => agent({ config, provider: provRef.prov, task: prompt, readOnly: true, maxStepsOverride: 2, journal: false, suppressRunEvents: true, taskId, runId: taskRunId, segmentId: "synthesis", signal }),
          })
          emit({ type: "SYNTHESIS", taskId, runId: taskRunId, ok: Boolean(synthesized) })
        }
        runState.finalText = synthesized ? `${synthesized}\n\n${combineReport({ nodes, changedFiles: changedRel, acceptance: accShown ? acc : [], conflicts: seenConflicts, completion: level, verification: vv })}` : report
      }
    } catch { /* the combine step is additive — the answer stands without it */ }
    clearRequiredActions()
    ts.setNextAction(null)
    ts.transition(TASK_STATUS.COMPLETED, { reason: "completion gate satisfied", durability: DURABILITY.CRITICAL })
    emit({ type: "TASK_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, text: String(runState.finalText).slice(0, 400), verification: vv.status, finalRisk: fr.risk, gate: gate.checks })
    // v98 shipwise — VERIFIED GIT DELIVERY. The ONLY commit path in the
    // kernel, structurally after the 9-check gate said ok. Best-effort by
    // law: a skipped/failed delivery NEVER flips the task status — the
    // pre-v98 behavior (verified files in the working tree, undo-able via
    // checkpoints) is exactly the fallback. Default policy is OFF.
    try {
      const ship = await maybeShip({
        root: process.cwd(),
        config,
        taskId,
        runId: taskRunId,
        objective: state.objective,
        changedFiles: changedRel,
        verificationStatus: vv.status,
        finalRisk: fr.risk,
        gate,
        ask: (spec) => decisions91.ask(spec),
        // v124: under full control the delivery tier the owner already enabled
        // runs without parking the task in WAITING_FOR_USER. It never turns
        // delivery on by itself — `gitship.*` still ships "off" by default.
        unattended: yoloState(config).deliverUnattended === true,
      })
      if (ship?.shipped) {
        emit({ type: "GITSHIP_COMMITTED", taskId, runId: taskRunId, segmentId, nodeId, sha: ship.sha ?? null, files: (ship.files ?? []).slice(0, 20), branch: ship.branch ?? null, pushed: Boolean(ship.pushed), idempotent: Boolean(ship.idempotent), foreignDirtyFiles: ship.foreignDirtyFiles ?? [], prPath: ship.prPath ?? null, text: String(ship.reason ?? "").slice(0, 300) })
        runState.lastGate = { ...gate, gitship: { shipped: true, sha: ship.sha ?? null } }
      } else {
        emit({ type: "GITSHIP_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId, reason: String(ship?.reason ?? "unknown").slice(0, 200) })
      }
    } catch (e) {
      try { emit({ type: "GITSHIP_SKIPPED", taskId, runId: taskRunId, segmentId, nodeId, reason: `delivery error (task stays COMPLETED): ${String(e?.message ?? e).slice(0, 160)}` }) } catch { }
    }
    // v94 masterwise (§16/§17): consolidation — raw events → observations →
    // verified facts → reusable knowledge; provenance and evidence preserved.
    try {
      const cons = engMem.onTaskCompleted({ verification: vv, files: changedRel, summary: String(runState.finalText ?? "").slice(0, 300) })
      emit({ type: "MEMORY_CONSOLIDATED", taskId, runId: taskRunId, segmentId, nodeId, merged: cons.merged, contradictions: cons.contradictions, total: cons.total })
    } catch { /* memory consolidation is best-effort */ }
    try {
      const evo = evolveRun({
        cwd: process.cwd(),
        task: state.objective,
        klass: classified.class,
        gate,
        files: changedRel,
        command: (focusedVerify(process.cwd(), changedRel || []).command
          || runState.composedSnap?.verify?.command
          || ""),
      })
      const line = formatEvolve(evo)
      if (line) emit({ type: "STRATEGY_EVOLVED", taskId, runId: taskRunId, segmentId, nodeId, score: evo.score, skill: evo.skill?.name || null, skipped: evo.skill?.skipped || null, avoid: (evo.avoid || []).slice(0, 4), text: line })
    } catch { /* evolution is best-effort — never block COMPLETED */ }
    return { done: true, gate }
  }

  /** The gate refused completion: move to the safe state it recommended. */
  const refuseCompletion = async ({ v, segment = 0, segmentId = null, nodeId = null, finalRiskLevel = "medium", text = "" } = {}) => {
    const gate = runState.lastGate ?? { status: "WAITING", blockers: [], reasons: [] }
    const status = gate.status
    emit({
      type: "TASK_BLOCKED", taskId, runId: taskRunId, segment, segmentId, nodeId,
      status, missing: v?.missing ?? [], risk: finalRiskLevel, blockers: gate.blockers,
    })

    // The gate exists to prevent a FALSE COMPLETED, not to stop useful work.
    // When the only thing missing is "more nodes to finish / more evidence"
    // and the DAG can still make progress, keep executing the next node.
    // Anything structural (live workers, invalid plan/DAG, uncleared recovery,
    // failed persistence, a failed node) never continues — it settles safely.
    const progressBlockers = new Set([
      GATE_CHECK.ALL_REQUIRED_NODES_COMPLETE,
      GATE_CHECK.VERIFICATION_SATISFIED,
      GATE_CHECK.NO_PENDING_REQUIRED_ACTIONS,
    ])
    const onlyProgressBlockers = gate.blockers.every((b) => progressBlockers.has(b.check))
    let canProgress = false
    if (runState.dag) {
      try { canProgress = dagLib.readyNodes(runState.dag).length > 0 && !dagLib.isStalled(runState.dag) } catch { canProgress = false }
    }
    if (onlyProgressBlockers && canProgress && segment < runState.maxSeg) {
      ts.transition(TASK_STATUS.EXECUTING, { reason: `continuing: ${gate.reasons.slice(0, 2).join("; ").slice(0, 200)}` })
      return { done: false, gate }
    }

    // Alpha Final (agent.requireCompletion): when the ONLY thing holding the
    // task is a completion shortfall, it is work the agent can do itself (run
    // the check, meet the criterion) — so it gets a bounded repair turn with
    // the reasons, through the same repair path, instead of parking in
    // WAITING. At most twice per task; after that the gate's WAITING stands.
    const completionOnly = gate.blockers.length > 0
      && gate.blockers.every((b) => b.check === GATE_CHECK.NO_PENDING_REQUIRED_ACTIONS)
      && requiredActions.size > 0 && [...requiredActions].every((a) => a.startsWith("completion "))
    if (completionOnly && runState.completionRepairs < 2 && segment < runState.maxSeg && !signal?.aborted) {
      runState.completionRepairs++
      const why = [...requiredActions].join("; ")
      ts.transition(TASK_STATUS.REPAIRING, { reason: why.slice(0, 300) })
      emit({ type: "REPAIR_STARTED", taskId, runId: taskRunId, segmentId, nodeId, error: why.slice(0, 300), reason: "completion level below agent.requireCompletion" })
      await boundedRepair({
        agent, config, provider: runState.prov, signal, emit, state,
        error: `the task is not done to the required level — ${why}`,
        segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId,
        finalRisk: finalRiskLevel, liveRisk, episodeSink, verifierReport: runState.lastVerifierReport,
      })
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after completion-level repair" })
      return { done: false, gate }
    }

    // REPAIRING: there is still repair budget — try once, then keep looping.
    if (status === "REPAIRING" && runState.repairCount < maxRepairs) {
      ts.transition(TASK_STATUS.REPAIRING, { reason: gate.reasons.join("; ").slice(0, 300) })
      const repair = await boundedRepair({
        agent, config, provider: runState.prov, signal, emit, state,
        error: gate.reasons.join("; ") || v?.reason || "completion gate refused",
        segment, ts, ledger, ctxEngine, verification: v, taskRunId, taskId, segmentId, nodeId,
        finalRisk: finalRiskLevel, liveRisk, episodeSink, verifierReport: runState.lastVerifierReport,
      })
      const recovered = repair.recovered
      runState.repairCount += recovered ? 1 : 0
      ts.noteRepair(recovered ? 1 : 0)
      ts.transition(TASK_STATUS.EXECUTING, { reason: "after completion-gate repair" })
      return { done: false, gate }
    }

    // RECOVERING: drift or unresolved recovery — go through RECOVERING state.
    if (status === "RECOVERING") {
      ts.transition(TASK_STATUS.RECOVERING, { reason: gate.reasons.join("; ").slice(0, 300) })
      addRequiredAction(`recover: ${gate.reasons.slice(0, 2).join("; ")}`)
    }

    const mapped = status === "FAILED" ? FINAL.FAILED
      : status === "CANCELLED" ? FINAL.CANCELLED
        : FINAL.WAITING
    runState.finalStatus = explicitFinalization(mapped)
    runState.finalState = (status === "RECOVERING" || status === "REPAIRING") ? TASK_STATUS.WAITING : (TASK_STATUS[status] ?? TASK_STATUS.WAITING)
    runState.finalText = text
      ? `${text}`
      : `not completed — ${gate.reasons.slice(0, 3).join("; ")}`
    if (mapped === FINAL.WAITING) {
      ts.setNextAction(`wait: ${gate.reasons.slice(0, 2).join("; ").slice(0, 300)}`)
      ts.transition(TASK_STATUS.WAITING, { reason: gate.reasons.join("; ").slice(0, 300) })
    } else if (mapped === FINAL.FAILED) {
      ts.transition(TASK_STATUS.FAILED, { reason: gate.reasons.join("; ").slice(0, 300) })
    } else {
      ts.transition(TASK_STATUS.CANCELLED, { reason: "user cancel" })
    }
    persistCritical()
    return { done: true, gate }
  }
  return { attemptCompletion, refuseCompletion }
}
