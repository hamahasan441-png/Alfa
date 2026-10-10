/**
 * forge — the controller's repair and verification-request steps (Phase 2
 * split of meta.js)
 *
 * Moved VERBATIM out of meta.js, where they were already standalone
 * top-level functions (no closure over runMeta — confirmed by scope
 * analysis): repairSegment (the v99 FIXER: defect report, deterministic
 * autofix fast path, one bounded repair segment, lessons), requestVerification
 * (asking a segment for the missing evidence), and buildContextBlock, which
 * both use and runMeta uses too. Only `export` was added.
 */
import path from "node:path"
import { TASK_STATUS } from "./taskstate.js"
import { collectDiagnosticsForFiles } from "./lsp.js"
import { composeOnce } from "./compose.js"
import { rootCause, formatRootCause } from "./diagnose.js"
import { formatSteer } from "./evaluate.js"
import { recordLesson } from "./lessons.js"
import { tryNativeAutoFix } from "./autofix.js"

/** Build the context block and SAY SO when it did not fit (v124).
 *
 *  The context engine fits sections to a token budget in priority order and
 *  drops whatever does not fit. It computed that, then threw it away: the
 *  `dropped` marker was set on objects the fit loop discarded, `sections`
 *  carried only survivors, and all three callers read `.text` and nothing
 *  else. So a segment that ran without its repo map — measured at 89% of the
 *  available context on a tight budget — was indistinguishable from a repo
 *  that never had one, in the run log and in every postmortem built from it.
 *
 *  The house rule is that a bounded thing says when it hit its bound. This is
 *  that sentence for the context budget: a signal, never a failure. A context
 *  that does not fit is still the best context available, so the build result
 *  is returned unchanged and the run continues either way.
 */
export async function buildContextBlock(ctxEngine, objective, opts, { emit = null, phase = "segment", ...ids } = {}) {
  const built = await ctxEngine.buildAsync(objective, opts)
  if (built && typeof built === "object" && built.fitsBudget === false) {
    try {
      emit?.({
        type: "CONTEXT_TRUNCATED", ...ids, phase,
        budget: built.budget, used: built.tokens,
        dropped: (built.dropped ?? []).map((d) => d.name),
        droppedTokens: built.droppedTokens ?? 0,
        ...(built.budgetOverflow ? { budgetOverflow: true } : {}),
        reason: built.budgetOverflow
          ? `context section "${built.sections?.[0]?.name ?? "?"}" alone exceeds the ${built.budget}-token budget (kept anyway: an empty context helps nobody)`
          : `${(built.dropped ?? []).map((d) => `${d.name} (${d.tokens}t)`).join(", ")} did not fit the ${built.budget}-token budget`,
      })
    } catch { /* telemetry must never break a task */ }
  }
  return built
}

export async function repairSegment({ agent, config, provider, signal, emit, state, error, segment, ts, ledger, ctxEngine, verification = null, taskRunId = null, taskId = null, segmentId = null, nodeId = null, omega = null, changedFiles = [], liveRisk = null, episodeSink = null, verifierReport = null }) {
  ts.transition(TASK_STATUS.REPAIRING, { reason: "diagnosing failure" })
  const ctxBlock = await buildContextBlock(ctxEngine, state.objective, { budgetTokens: 1600 },
    { emit, phase: "repair", taskId, runId: taskRunId, segmentId, nodeId })
  const failText = String(error ?? verification?.reason ?? "")
  let hypoHint = ""
  let observed = null
  let next = null
  if (omega) {
    observed = omega.observeCommand(failText, { tool: "segment", files: changedFiles })
    next = omega.nextRepair()
    // v96 unifywise: the episode's HYPOTHESES stage is now fed from the Ω
    // kernel's live ledger (the durable "full story" the episodic memory was
    // designed for and never received).
    if (episodeSink && observed?.hypothesis) {
      episodeSink.addHypothesis(String(observed.hypothesis.description ?? "").slice(0, 400), { status: "supported", confidence: observed.hypothesis.confidence ?? 0.55 })
    }
    if (observed.diagnosis?.failed) {
      hypoHint += `\n\nFailure class: ${observed.diagnosis.code}. Evidence: ${String(observed.diagnosis.evidence ?? "").slice(0, 240)}.`
    }
    if (observed.originHint) hypoHint += `\n${observed.originHint}`
    if (observed.origin) {
      emit({ type: "ORIGIN_CLASSIFIED", taskId, runId: taskRunId, segmentId, nodeId, origin: observed.origin.origin, why: observed.origin.why, code: observed.origin.code })
    }
    if (next.causal?.node) {
      hypoHint += `\nCausal target (${next.causal.layer}, ${next.causal.node.id}): ${next.causal.node.description} — ${next.causal.reason}`
      emit({
        type: "CAUSAL_UPDATED", taskId, runId: taskRunId, segmentId, nodeId,
        layer: next.causal.layer, id: next.causal.node.id,
        description: next.causal.node.description, reason: next.causal.reason,
      })
    }
    if (next.hypothesis) {
      hypoHint += `\nCurrent hypothesis (${next.hypothesis.id}, ${next.hypothesis.status}, conf=${Number(next.hypothesis.confidence).toFixed(2)}): ${next.hypothesis.description}`
      if (next.action === "escalate") {
        hypoHint += `\nThis hypothesis has already been tested twice — do NOT retry it. Pick a different cause.`
      }
    }
    if (next.experiment) {
      const g = Number.isFinite(next.experiment.gain) ? Number(next.experiment.gain).toFixed(3) : "?"
      hypoHint += `\nNext experiment (${next.experiment.id}, gain=${g}, kind=${next.experiment.kind}): ${next.experiment.instruction}`
      if (next.experiment.avoided?.length) {
        hypoHint += `\nAvoided (already uninformative): ${next.experiment.avoided.slice(0, 6).join(", ")}`
      }
      emit({
        type: "EXPERIMENT_SELECTED", taskId, runId: taskRunId, segmentId, nodeId,
        id: next.experiment.id, kind: next.experiment.kind, gain: next.experiment.gain,
        reason: next.experiment.reason,
      })
    }
    const rejected = omega.hypotheses.snapshot().filter((h) => h.status === "REJECTED")
    if (rejected.length) {
      hypoHint += `\nRejected causes (do not retry): ${rejected.map((h) => h.description).slice(0, 4).join("; ")}`
      if (episodeSink) for (const h of rejected.slice(0, 4)) episodeSink.addFailedApproach(`rejected cause: ${String(h.description ?? "").slice(0, 200)}`)
    }
  }
  let steerHint = ""
  try {
    const composed = composeOnce(state.objective, {
      cwd: process.cwd(), config, includeMemory: false, includeSkills: true,
    })
    const block = formatSteer({
      skills: composed.skills,
      plugins: composed.plugins,
      avoid: composed.avoid,
      know: composed.know,
      tools: composed.tools,
      playbooks: composed.playbooks,
      mcp: composed.mcp,
      gaps: composed.gaps,
      blast: composed.blast,
      claims: composed.claims,
      decisions: composed.decisions,
      strategy: composed.strategy,
      models: composed.models,
      variants: composed.variants,
      knowtype: composed.knowtype,
    })
    if (block) {
      steerHint = `\n\n${block}`
      emit({
        type: "REPAIR_STEER",
        taskId, runId: taskRunId, segmentId, nodeId,
        skills: (composed.skills || []).map((s) => s.name).slice(0, 3),
        plugins: (composed.plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name).slice(0, 4),
        playbook: String((composed.plugins || []).find((p) => p && p.isolated && p.repair)?.repair || "").slice(0, 160),
        avoid: (composed.avoid || []).slice(0, 4),
      })
    }
  } catch { steerHint = "" }
  // v99 loopwise FIXER — the defect report: the repair prompt used to get a
  // bare error string and had to RE-DISCOVER what the kernel already knew
  // (LSP diagnostics, failing ledger evidence, the verifier's own defect
  // text). Assemble the structured DEFECT REPORT the fixer actually needs.
  let defectBlock = ""
  {
    const lines = []
    if (changedFiles.length) {
      try {
        const diags = await collectDiagnosticsForFiles(config, changedFiles.slice(0, 20), { cwd: process.cwd(), allowAutostart: true, budgetMs: 8000 })
        const bad = diags.filter((d) => d.passed === false).slice(0, 12)
        if (bad.length) {
          lines.push("LIVE LSP DIAGNOSTICS on the changed files (file:line — message):")
          for (const d of bad) lines.push(`  ${path.relative(process.cwd(), d.file)} — ${String(d.text ?? "").split("\n")[0].slice(0, 160)}`)
        }
      } catch { /* diagnostics are best-effort context */ }
    }
    try {
      const fails = (ledger.records() ?? []).filter((r) => Number(r.exit_code ?? r.exitCode ?? 0) !== 0 && r.command).slice(-5)
      if (fails.length) {
        lines.push("FAILING VERIFICATION RECORDS (most recent last):")
        for (const f of fails) {
          lines.push(`  ${String(f.command).slice(0, 140)} → exit ${f.exit_code ?? f.exitCode}${f.evidence ? ` — ${String(f.evidence).split("\n")[0].slice(0, 100)}` : ""}`)
          // ROOT CAUSE: mine the full captured output (stdoutTail) for the
          // specific failing test, assertion and file:line — the exit line and
          // the one-line evidence rarely say WHERE. Deterministic; only what
          // the output states. This is what makes repair aim at the real cause.
          try {
            const rc = rootCause(f.stdoutTail ?? f.evidence ?? "", { code: null })
            const one = formatRootCause(rc)
            if (one) lines.push(`      root cause: ${one}`)
          } catch { /* root-cause mining is additive; its failure drops the line */ }
        }
      }
    } catch { /* ledger read is best-effort */ }
    if (verifierReport?.text) {
      lines.push(`READ-ONLY VERIFIER REPORT (defects observed, not fixed):\n  ${String(verifierReport.text).replace(/\n/g, "\n  ").slice(0, 1200)}`)
    }
    if (lines.length) defectBlock = `\n\n--- DEFECT REPORT (observed evidence — trust this over assumptions) ---\n${lines.join("\n")}`
  }
  // v99 loopwise FIXER — deterministic fast path: a lint/format-shaped
  // failure gets the project's OWN formatter once, before any LLM tokens are
  // spent. Evidence is recorded exactly like an agent-run check; on success
  // the repair is done and the LLM pass is skipped entirely.
  {
    const changedRel = changedFiles.map((f) => path.relative(process.cwd(), f)).filter(Boolean)
    const fix = tryNativeAutoFix({ cwd: process.cwd(), config, failureText: `${failText}\n${defectBlock}`, changedFiles: changedRel })
    if (fix.tried && fix.applied) {
      try {
        const rec = ledger.recordCommand(`autofix: ${fix.command}`, fix.tail || "formatter completed cleanly", {
          exitCode: fix.exitCode, affectedFiles: changedRel, taskId, nodeId, segmentId,
          verificationEpoch: state.verification_epoch ?? 0, scope: "repair",
        })
        ts.noteVerification(rec)
        ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
        emit({ type: "VERIFICATION_PASSED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: 0, evidence: rec.evidence, verificationId: rec.verification_id, autofix: true })
      } catch { /* evidence is best-effort */ }
      emit({ type: "REPAIR_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, ok: true, attemptHint: "native autofix", autofix: fix.command })
      emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: `deterministic autofix applied: ${fix.command}`, ok: true })
      try {
        recordLesson({
          failure: String(error ?? verification?.reason ?? "").slice(0, 200),
          cause: `lint/format-class failure — project formatter fixed it deterministically`,
          failedStrategy: "LLM repair for a mechanical failure",
          successfulRepair: fix.command,
          applicableContext: state.objective, task: state.objective, confidence: 0.8,
          symptoms: failText.slice(0, 400), rootCause: "formatting/lint violation", solution: fix.command,
          files: changedRel.slice(0, 12), symbols: [], model: provider?.model ?? null,
          strategy: "autofix: deterministic formatter before LLM repair",
        }, process.cwd())
      } catch { /* lessons are best-effort */ }
      return true
    }
    if (fix.tried) emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: `native autofix tried but exited ${fix.exitCode} — falling through to LLM repair`, ok: false })
  }
  const experimentBlock = next?.experiment
    ? `\n\n--- SELECTED EXPERIMENT (execute before mutating repair when it is read-only) ---\n` +
      `ID: ${String(next.experiment.id ?? "unknown")}\n` +
      `KIND: ${String(next.experiment.kind ?? "unknown")}\n` +
      `INFORMATION_GAIN: ${Number.isFinite(next.experiment.gain) ? next.experiment.gain : "unknown"}\n` +
      `INSTRUCTION: ${String(next.experiment.instruction ?? "").slice(0, 500)}\n` +
      `RULE: do not mutate merely to run this experiment; record the actual command/result as evidence before choosing the repair.`
    : ""
  const diag = `A previous step FAILED and needs repair. Diagnose the root cause, then fix it, then VERIFY (run the relevant focused test/build). Do NOT repeat the identical failing call — change strategy.\n\nFailure: ${failText.slice(0, 600)}${verification?.missing?.length ? `\nRequired evidence still missing: ${verification.missing.join(", ")}` : ""}${hypoHint}${experimentBlock}${steerHint}${defectBlock}\n\nIf a SELECTED EXPERIMENT is present and is read-only, execute it first and use its observed result to update the hypothesis. Then make a minimal surgical fix only when justified by evidence, and run verification. If no experiment is available, inspect the relevant files first, then make a minimal surgical fix, then run verification.`
  const repairContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBlock === "string" ? ctxBlock : ctxBlock?.text ?? ""}`
  try {
    const r = await agent({ config, provider, signal, task: diag, taskId, runId: taskRunId, segmentId, nodeId, extraContext: repairContext, maxStepsOverride: 8, deep: true, onEvent: emit, journal: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    // the repair's own checks reach the ledger FIRST, so "fixed" can be read
    // from the evidence (a PASS of the same check supersedes its failure)
    const changedForScope = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(chk.command, chk.tail, {
        exitCode: chk.exitCode, affectedFiles: changedForScope, taskId, nodeId, segmentId, verificationEpoch: state.verification_epoch ?? 0,
        cwd: chk.cwd, env: chk.env, repoState: chk.repoState, stdoutTail: chk.stdoutTail, timestamp: chk.at,
        filesWrittenAfter: (chk.filesWrittenAfter ?? []).map((f) => f === "(shell write)" ? f : path.relative(process.cwd(), f)),
        ...(chk.docker ? { docker: chk.docker } : {}), // V5: probed once, where the check ran
      })
      if (episodeSink) episodeSink.addVerification({ command: String(chk.command ?? "").slice(0, 200), ok: chk.passed === true }) // v96: the episode's VERIFICATION stage
      if (rec.invalidated) emit({ type: "VERIFICATION_INVALIDATED", taskId, runId: taskRunId, segmentId, nodeId, count: 1, reason: rec.staleReason, command: rec.command, verificationId: rec.verification_id })
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exitCode ?? rec.exit_code, evidence: rec.evidence, verificationId: rec.verification_id, ...(rec.docker ? { docker: rec.docker } : {}) })
    }
    // A repair is a success only when its run finished cleanly AND its own
    // completion gate passed AND the failures it was sent to repair no longer
    // stand in the ledger. "No error, budget left" with the check still red
    // used to count as success: the retry controller reset its failure count,
    // the same strategy was re-admitted forever, and a successful_repair
    // lesson was written for a repair that fixed nothing.
    const stillRed = (verification?.failures ?? []).some((f) => f && !f.passed && !f.superseded && !f.invalidated)
    const fixed = !r.error && !r.budgetHit && r.completionGate?.ok !== false && !stillRed
    // v96 unifywise: the EXPERIMENT + FIX stages of the episode — what was
    // tried and what actually worked, recorded durably for "never repeat what
    // failed" retrieval in future similar problems.
    if (episodeSink) {
      if (fixed) episodeSink.addFix(String(r.text ?? "").slice(0, 300))
      if (!fixed) episodeSink.addFailedApproach(`repair did not fix: ${String(error ?? verification?.reason ?? "").slice(0, 160)}`)
    }
    // The selected experiment is executed by the repair agent when the
    // experiment is not directly runnable by the deterministic engine. Treat
    // only an observed command check as experiment evidence — never infer a
    // PASS from the repair agent's prose or from the eventual repair result.
    if (next?.experiment?.id) {
      const checks = Array.isArray(r.commandChecks) ? r.commandChecks : []
      const toolRecords = Array.isArray(r.toolRecords) ? r.toolRecords : []
      const inspectTool = toolRecords.find((rec) => {
        const tool = String(rec?.tool ?? rec?.name ?? "").toLowerCase()
        return /read_file|readfile|glob|grep|search|inspect/.test(tool)
      })
      const expCheck = checks.find((c) => c && c.command &&
        (next.experiment.id === "focused_test" || next.experiment.kind === "discriminate"))
      const expEvidence = expCheck || inspectTool
      if (expEvidence) {
        const expOk = expCheck ? expCheck.passed === true : true
        emit({
          type: "EXPERIMENT_EXECUTED", taskId, runId: taskRunId, segmentId, nodeId,
          id: next.experiment.id,
          command: expCheck ? String(expCheck.command).slice(0, 240) : null,
          tool: inspectTool ? String(inspectTool.tool ?? inspectTool.name ?? "inspect").slice(0, 120) : null,
          ok: expOk,
          exitCode: expCheck ? (expCheck.exitCode ?? expCheck.exit_code ?? null) : null,
          evidence: String(expCheck?.tail ?? expCheck?.evidence ?? inspectTool?.result ?? inspectTool?.summary ?? "observed tool execution").slice(0, 300),
          source: expCheck ? "repair-agent-command-check" : "repair-agent-tool-record",
        })
        if (episodeSink) episodeSink.addExperiment({
          command: expCheck ? String(expCheck.command).slice(0, 200) : `tool:${String(inspectTool.tool ?? inspectTool.name ?? "inspect").slice(0, 160)}`,
          result: expOk ? "pass" : "fail", ok: expOk,
        })
        try { liveRisk?.experiment(expOk) } catch { }
        try { omega.noteExperiment(next.experiment.id, expOk ? "pass" : "fail") } catch { }
      } else {
        emit({ type: "EXPERIMENT_NOT_EXECUTED", taskId, runId: taskRunId, segmentId, nodeId, id: next.experiment.id, reason: "no observed tool or command evidence matched the selected experiment" })
      }
    }
    if (omega && observed?.hypothesis) {
      omega.hypotheses.recordTest(observed.hypothesis.id, { name: "repair-pass", result: fixed ? "pass" : "fail" })
      // v94 deepwise: experiment outcomes move LIVE risk — the reality→risk
      // loop closes for the experiment path too (a failed repair is evidence).
      try { liveRisk?.experiment(fixed) } catch { }
      if (fixed) omega.confirmRootCause(observed.hypothesis.id)
      else if (omega.hypotheses.looping(observed.hypothesis.id, "repair-pass")) {
        omega.rejectCause(observed.hypothesis.id, "same repair already failed twice")
      }
    }
    recordLesson({
      failure: String(error ?? verification?.reason ?? "").slice(0, 200),
      cause: String(r.text ?? "").slice(0, 200),
      failedStrategy: "repeat identical failing call",
      successfulRepair: fixed ? String(r.text ?? "").slice(0, 240) : "",
      applicableContext: state.objective,
      task: state.objective,
      confidence: fixed ? 0.7 : 0.4,
      // P1 structured schema (see above)
      symptoms: String(error ?? verification?.reason ?? "").slice(0, 400),
      rootCause: String(r.text ?? "").slice(0, 400),
      solution: fixed ? String(r.text ?? "").slice(0, 400) : "",
      files: [...(state.files_changed ?? [])].map((f) => path.relative(process.cwd(), f)).slice(0, 12),
      symbols: (verification?.missing ?? []).slice(0, 12),
      model: provider?.model ?? null,
      strategy: "repair: diagnose root cause, minimal fix, verify",
    }, process.cwd())
    // v96 unifywise: REPAIR_COMPLETED is a real event (the Core records the
    // REPAIR lifecycle phase from it; the previously dead vocabulary is gone).
    emit({ type: "REPAIR_COMPLETED", taskId, runId: taskRunId, segment, segmentId, nodeId, ok: fixed, attemptHint: fixed ? "fixed" : "not fixed" })
    emit({ type: "STRATEGY_CHANGED", taskId, runId: taskRunId, segment, segmentId, nodeId, reason: "repair pass completed", ok: fixed })
    return fixed
  } catch (e) {
    ts.noteError("REPAIR_FAILED", e?.message ?? String(e))
    return false
  }
}

/**
 * P0 — VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE.
 *
 * A verifier must never be able to change the artifact it is verifying: a
 * write-capable "verifier" can make a failing test pass by editing it. The
 * verification agent therefore runs with `readOnly: true`, which (via
 * tools.js isReadOnlyViolation) denies write_file / edit_file / multi_edit /
 * apply_patch / mutating bash / memory / todo / plugin / config mutation, and
 * allows ONLY the approved verification commands (test / build / lint /
 * typecheck / read-only git and shell inspection).
 */
export async function requestVerification({ agent, config, provider, signal, emit, state, missing, ts, ledger, ctxEngine, taskRunId, taskId = null, segmentId = null, nodeId = null, risk = "medium", impact = null }) {
  const ctxBuilt = await buildContextBlock(ctxEngine, state.objective, { budgetTokens: 1200 },
    { emit, phase: "verification", taskId, runId: taskRunId, segmentId, nodeId })
  const verifyContext = `--- relevant project context (demand-loaded) ---\n${typeof ctxBuilt === "string" ? ctxBuilt : ctxBuilt?.text ?? ""}`
  let ask = `The task appears complete, but before success is claimed the following evidence is required for this risk level (${risk}): ${missing.join(", ")}.\n\nRun the appropriate command(s) for THIS project (e.g. a focused test for a single-function change; focused + regression + build for a core change). Use the project's real test command (check package.json / Makefile). If the project has NO test suite or build, say so plainly instead of fabricating a result. Report the exact command(s) and their outcomes.\n\nYou are the VERIFIER: you may read, search, inspect and run approved test/build/lint/static-analysis commands, but you may NOT modify the project. If you find a defect, report it — do not fix it.`
  if (impact?.scope?.length) ask += `\n\nImpact-based verification ladder: ${impact.scope.join(" → ")}.`
  if (impact?.tests?.length) ask += `\nTests that import the changed files: ${impact.tests.slice(0, 8).join(", ")}.`
  try {
    emit({ type: "VERIFIER_STARTED", taskId, runId: taskRunId, segmentId, nodeId, mode: "READ_ONLY", missing, risk })
    const r = await agent({ config, provider, signal, task: ask, taskId, runId: taskRunId, segmentId, nodeId, extraContext: verifyContext, maxStepsOverride: 6, deep: false, onEvent: emit, journal: true, readOnly: true, verifier: true, runIdOverride: taskRunId, suppressRunEvents: true, keepJournalRunning: true })
    emit({ type: "VERIFIER_FINISHED", taskId, runId: taskRunId, segmentId, nodeId, mode: "READ_ONLY", checks: (r.commandChecks ?? []).length })
    for (const chk of r.commandChecks ?? []) {
      const rec = ledger.recordCommand(
        chk.command,
        chk.tail + (chk.exitCode === 0 || chk.exitCode == null ? "" : ` [exit code: ${chk.exitCode}]`),
        {
          exitCode: chk.exitCode,
          taskId, nodeId, segmentId,
          affectedFiles: (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f)),
          verificationEpoch: state.verification_epoch ?? 0,
          scope: "verification",
          ...(chk.docker ? { docker: chk.docker } : {}),
        },
      )
      ts.noteVerification(rec)
      ts.noteTest({ command: rec.command, exit_code: rec.exit_code ?? rec.exitCode, passed: rec.passed })
      emit({ type: chk.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", taskId, runId: taskRunId, segmentId, nodeId, vtype: rec.type, command: rec.command, exitCode: rec.exit_code ?? rec.exitCode, evidence: rec.evidence, verificationId: rec.verification_id, verifier: "READ_ONLY", ...(rec.docker ? { docker: rec.docker } : {}) })
    }
    const changedRel = (state.files_changed ?? []).map((f) => path.relative(process.cwd(), f))
    // judged against the FINAL risk, not the planning risk
    // v99 loopwise: the verifier's own defect REPORT travels with the
    // verdict — the fixer no longer has to re-discover what was already
    // observed. Callers treat this as truthy/falsy exactly as before.
    const st = ledger.status(risk, changedRel, { nodeId })
    return { ok: st.ok && !st.anyFailure, report: { at: Date.now(), missing, text: String(r?.text ?? "").slice(0, 2400) } }
  } catch (e) {
    ts.noteError("VERIFY_FAILED", e?.message ?? String(e))
    return { ok: false, report: null }
  }
}
