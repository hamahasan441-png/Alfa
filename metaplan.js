/**
 * forge — the controller's planning phase (Phase 2 split of meta.js)
 *
 * Moved VERBATIM out of runMeta, which was one 3,425-line function: plan
 * restore on resume (and the v106 instruction-delta invalidation), the
 * synthesized fast-path plans, the model planner with lessons / language /
 * prediction / world-model / compose context, plan validation with the
 * cycle re-plan, the WAITING_FOR_USER decision for an invalid plan, and the
 * v99 plan-quality critique with its one revision pass.
 *
 * Every value it reads from runMeta arrives in `ctx` (listed below, found by
 * scope analysis, not by reading); the only values runMeta reads back are
 * `planDefs`, `planText`, `planValidation` and `restoredDAG`. The two places
 * that used to `return` from runMeta return `{ earlyReturn }` instead, and
 * runMeta returns that object unchanged. `FINAL` and `passThrough` come in
 * through `ctx` so this module never imports meta.js (no import cycle).
 */
import fs from "node:fs"
import path from "node:path"
import * as dagLib from "./dag.js"
import { TASK_STATUS } from "./taskstate.js"
import { DECISION_TYPE } from "./decisionengine.js"
import { synthesizePlan, TASK_CLASS } from "./classify.js"
import { buildV4Plan } from "./v4.js"
import { createWorldModel } from "./worldmodel.js"
import { critiquePlan, planRevisionPrompt } from "./plancritique.js"
import { engineFor } from "./langengine.js"
import { ensureKnowledgeGraph } from "./knowgraph.js"
import { formatCompose } from "./compose.js"
import { languagesIn, formatLangReason } from "./langreason.js"
import { hardAvoid } from "./evolve.js"
import { lessonsForPlan } from "./lessons.js"
import { persistGaps } from "./knowgap.js"
import { planLessonsPrefix } from "./replan.js"
import { predictionsForPrompt, predictionCalibration } from "./prediction.js"
import { warmCaches } from "./fastwise.js"

export async function planPhase(ctx) {
  const { agent, approvedPlan, classified, cognition, config, conversationId, decisions91, deep, emit, engMem, persistCritical, prov, resumeRec, signal, state, takeCompose, taskId, taskRunId, ts, FINAL, passThrough } = ctx
  let { planDefs, planText } = ctx
  let plannerAlreadyRevised = false
  let planValidation = null
  let planRepaired = false
  // RESUME: the task already has a validated DAG on disk. Re-planning would
  // throw away the graph the interrupted run was executing (and pay for a
  // model call that can contradict it), so we restore instead.
  /**
   * v106 — carry a resumed run's NEW instruction into the plan.
   *
   * Two things were broken and they are the same bug. The instruction was
   * discarded (meta.js:124), and dag.invalidateNodes() — "COMPLETED nodes that
   * do not depend on invalidated ground truth are PRESERVED" — had no
   * production caller anywhere, which forge's own `selfaudit` reported.
   *
   * So: measure what the new instruction actually changes, invalidate only the
   * nodes that rest on the part that died, and leave everything else COMPLETED.
   * Not a restart, and not a silent continuation of work the user just
   * countermanded.
   */
  const restoredDAG = Boolean(resumeRec && state.dag)
  try {
    if (restoredDAG) {
      planDefs = []
      planValidation = { ok: true, errors: [], stage: "RESTORED", code: "RESTORED", recoverable: true }
      emit({ type: "PLAN_RESTORED", taskId, runId: taskRunId, nodes: state.dag?.nodes?.length ?? 0, reason: "resuming an interrupted task — the recorded DAG is authoritative" })
      // v94 masterwise (§17 continuity fix): setPlan persists an object
      // ({ steps, source, at }) — the resume path used to call .map() on it
      // directly, which threw "state.plan.map is not a function" and turned
      // EVERY fuse-parked (WAITING) resume into a fake "planning failed".
      // Accept both the historical array shape and the record shape.
      const restoredPlan = Array.isArray(state.plan)
        ? state.plan
        : (Array.isArray(state.plan?.steps) ? state.plan.steps : [])
      ts.setPlan(restoredPlan.map((p) => (typeof p === "string" ? p : p?.objective ?? p?.title ?? p?.id)), "resumed")
      ts.transition(TASK_STATUS.PLANNING, { reason: "plan restored from the task record" })
    }
    const fastPath = !restoredDAG && classified.strategy.plan === "synthesize" && classified.class === TASK_CLASS.MICRO
    const recoveryPath = !restoredDAG && classified.class === TASK_CLASS.RECOVERY
    const planLessons = (!restoredDAG && !fastPath && !recoveryPath)
      ? lessonsForPlan(state.objective, { cwd: process.cwd() })
      : { text: "", avoided: [], count: 0 }
    if (planLessons && !fastPath && !recoveryPath) {
      const extra = hardAvoid(state.objective, { cwd: process.cwd() })
      if (extra.length) planLessons.avoided = [...new Set([...(planLessons.avoided || []), ...extra])]
    }
    const lessonPrefix = planLessonsPrefix(planLessons)
    if (planLessons.count || planLessons.avoided.length) {
      emit({ type: "PLAN_LESSONS", taskId, runId: taskRunId, count: planLessons.count, avoided: planLessons.avoided.slice(0, 4) })
    }
    const planLangs = (!restoredDAG && !fastPath && !recoveryPath)
      ? languagesIn(state.objective, { cwd: process.cwd(), klass: classified.class })
      : []
    const langPrefix = formatLangReason(planLangs)
    if (planLangs.length) emit({ type: "PLAN_LANG", taskId, runId: taskRunId, langs: planLangs })
    // v92 §9 (wirewise): prediction-calibration feedback — real prediction
    // errors from earlier runs steer this plan. The master loop demands
    // "learn from incorrect predictions"; the ledger is the honest record.
    const predictionPrefix = (!restoredDAG && !fastPath && !recoveryPath)
      ? predictionsForPrompt(process.cwd())
      : ""
    if (predictionPrefix) {
      const cal = predictionCalibration(process.cwd())
      emit({ type: "PLAN_PREDICTION_CALIBRATION", taskId, runId: taskRunId, calibration: cal })
    }
    // v94 masterwise (§18 LONG PROMPT INTELLIGENCE): a very long objective is
    // ingested into requirement RECORDS (deterministic, ids R1..Rn) so that
    // compaction can never silently drop a requirement — they are retrieved
    // verbatim whenever needed. The planner prompt carries them explicitly.
    let requirementsPrefix = ""
    if (!restoredDAG && !fastPath && !recoveryPath && String(state.objective ?? "").length > 1500) {
      try {
        const reqs = engMem.ingestRequirements(state.objective)
        if (reqs.length) {
          requirementsPrefix = engMem.requirementsBlock(state.objective)
          emit({ type: "REQUIREMENTS_INGESTED", taskId, runId: taskRunId, count: reqs.length })
        }
      } catch { /* requirement extraction is best-effort */ }
    }
    // v94 knowwise: bounded KG bootstrap — the first task in a project without
    // a .ua/knowledge-graph.json writes a deterministic FLOOR graph (world-model
    // extractors; no LLM, no network) so the engmemory bridge and kg_query have
    // project knowledge from run one. A real understand-anything graph is
    // detected and NEVER touched. Deferred + unref'd so planning is never
    // delayed; every failure is swallowed (best-effort, off-path).
    if (!restoredDAG) {
      try {
        const kgTimer = setTimeout(() => {
          try {
            const kg = ensureKnowledgeGraph({ cwd: process.cwd() })
            if (kg?.ok && kg?.built) emit({ type: "KG_BOOTSTRAPPED", taskId, runId: taskRunId, files: kg.files, edges: kg.edges, truncated: !!kg.truncated })
          } catch { /* KG bootstrap is best-effort */ }
        }, 0)
        if (typeof kgTimer.unref === "function") kgTimer.unref()
      } catch { /* KG bootstrap is best-effort */ }
    }
    // v94 fastwise: idle warmup — persist the world-model snapshot and warm
    // the semantic chunk cache ONCE per freshness window, guided by the
    // likely-next prediction (objective + knowwise hubs). Deferred + unref'd
    // exactly like the KG bootstrap; FORGE_FASTWISE=0 turns it off; every
    // failure swallowed (best-effort, off-path, planning never delayed). The
    // KG floor graph itself is NOT re-warmed here — knowwise owns it.
    try {
      const fwTimer = setTimeout(() => {
        warmCaches({ cwd: process.cwd(), objectives: [String(state.objective ?? "")] })
          .then((fw) => {
            if (fw?.ok && !fw.cached && fw.warmed.length) emit({ type: "FASTWISE_WARMED", taskId, runId: taskRunId, warmed: fw.warmed, predicted: fw.predicted })
          })
          .catch(() => { /* fastwise warm is best-effort */ })
      }, 0)
      if (typeof fwTimer.unref === "function") fwTimer.unref()
    } catch { /* fastwise warm is best-effort */ }
    // v92 §5/§10 (wirewise): consult the semantic world model BEFORE planning.
    // Project shape + blast radius of files the objective names — bounded,
    // honest (degraded world says so), never fabricated.
    const worldPrefix = await (async () => {
      if (restoredDAG || fastPath || recoveryPath) return ""
      try {
        const world = createWorldModel({ cwd: process.cwd() })
        // v98 shipwise: the plan-time consult walks CHUNKED (never freezes the
        // TTY/bus on a six-figure repo) and opens the async-fresh window so
        // the summarize/impact/testsFor queries below don't re-walk per call
        await world.buildAsync()
        const lines = []
        const summary = world.summarize({ maxLines: 5 })
        if (summary) lines.push(String(summary))
        const mentions = [...String(state.objective ?? "").matchAll(/[\w./-]+\.[A-Za-z0-9]{1,6}/g)].map((m) => m[0]).slice(0, 6)
        const known = [...new Set(mentions)].filter((f) => { try { return fs.existsSync(path.resolve(process.cwd(), f)) } catch { return false } })
        if (known.length) {
          const abs = known.map((f) => path.resolve(process.cwd(), f))
          const imp = world.impact(abs)
          if (imp && !imp.unknown) {
            const importers = (imp.importers ?? []).slice(0, 6).map((i) => i.file ?? i.path ?? i)
            const tests = (imp.tests ?? []).slice(0, 4).map((t) => t.file ?? t.path ?? t)
            lines.push(`Blast radius of ${known.slice(0, 4).join(", ")}: radius ${imp.radius ?? "?"}${importers.length ? ` — importers: ${importers.join(", ")}` : ""}${tests.length ? ` — tests: ${tests.join(", ")}` : ""}`)
          }
          const tFor = world.testsFor(abs)
          if (tFor?.length && !imp?.tests?.length) lines.push(`Tests touching these files: ${tFor.slice(0, 4).join(", ")}`)
        }
        if (!lines.length) return ""
        return `--- world model (semantic project state) ---\n${lines.join("\n")}`.slice(0, 900)
      } catch { return "" }
    })()
    if (worldPrefix) emit({ type: "PLAN_WORLD_CONSULTED", taskId, runId: taskRunId, blastRadius: Boolean(worldPrefix.includes("Blast radius")) })
    const enginePrefix = (!restoredDAG && !fastPath && !recoveryPath)
      ? engineFor(state.objective, { cwd: process.cwd(), config, klass: classified.class })
      : ""
    if (enginePrefix) emit({ type: "PLAN_ENGINE", taskId, runId: taskRunId })
    // v108 rootwise: the planner sees lessons, predictions, the world model and
    // compose — but never the task store, the run journals or a question the
    // user was still being waited on. A plan built without knowing what is
    // already underway plans it again.
    // A new task plans from its own objective and what forge learned that
    // matches it; other runs' work state reaches the planner only when
    // agent.continuity is true; false turns it off (see agent.js).
    let continuityPrefix = ""
    if (!restoredDAG && !fastPath && !recoveryPath && config?.agent?.continuity !== false) {
      try {
        const { continuityBlock } = await import("./continuity.js")
        continuityPrefix = await continuityBlock({ cwd: process.cwd(), query: state.objective, conversationId, maxChars: 1400, workState: config?.agent?.continuity === true })
      } catch { continuityPrefix = "" }
    }
    let composePrefix = ""
    if (!restoredDAG && !fastPath && !recoveryPath) {
      try {
        const composed = takeCompose()
        composePrefix = formatCompose(composed)
        if (composePrefix) {
          emit({
            type: "PLAN_COMPOSE",
            taskId, runId: taskRunId,
            files: (composed.world?.files || []).slice(0, 8),
            avoid: (composed.avoid || []).slice(0, 4),
            verify: composed.verify?.command || "",
            skills: (composed.skills || []).map((s) => s.name).slice(0, 3),
            plugins: (composed.plugins || []).filter((p) => p && p.isolated && p.name).map((p) => p.name).slice(0, 4),
            playbook: String((composed.plugins || []).find((p) => p && p.isolated && p.repair)?.repair || "").slice(0, 160),
            playbooks: (composed.playbooks || []).map((p) => p.name).slice(0, 3),
            mcp: (composed.mcp || []).map((m) => m.name).slice(0, 4),
            gaps: (composed.gaps?.gaps || []).map((g) => g.id).slice(0, 4),
            claims: (composed.claims || []).slice(0, 3),
            decisions: (composed.decisions || []).slice(0, 3),
          })
        }
        try { persistGaps(process.cwd(), composed.gaps, { task: state.objective }) } catch { /* persist is best-effort */ }
      } catch { composePrefix = "" }
    }
    // V5 — AN APPROVED PLAN IS ADOPTED, NOT PLANNED AGAIN. The person said
    // yes to a specific plan; its steps become this task's DAG through the
    // same parser and the same validation as a planner's plan, so the plan
    // they approved is the checklist the controller executes and verifies.
    // A restored DAG or a recovery keeps precedence (it IS that plan, resumed).
    const adoptApproved = Boolean(approvedPlan?.text) && !restoredDAG && !recoveryPath
    const approvedPlanText = adoptApproved ? (await import("./plans.js")).planBody(approvedPlan.text) : ""
    if (adoptApproved) emit({ type: "PLAN_APPROVED_ADOPTED", taskId, runId: taskRunId, slug: approvedPlan.slug ?? null })
    const planRes = restoredDAG || recoveryPath ? null : adoptApproved ? { text: approvedPlanText } : fastPath ? null : await agent({
      config, provider: prov, signal,
      task: `${state.objective}\n\n${lessonPrefix ? `${lessonPrefix}\n\n` : ""}${langPrefix ? `${langPrefix}\n\n` : ""}${predictionPrefix ? `${predictionPrefix}\n\n` : ""}${worldPrefix ? `${worldPrefix}\n\n` : ""}${enginePrefix ? `${enginePrefix}\n\n` : ""}${composePrefix ? `${composePrefix}\n\n` : ""}${requirementsPrefix ? `${requirementsPrefix}\n\n` : ""}${continuityPrefix ? `${continuityPrefix}\n\n` : ""}${(() => { try { return `${cognition.understandingBlock()}\n\nPlan BACKWARD from the outcome: what must be true when this is done (the success / acceptance lines above, every "must not" still holding) → what has to exist for that → in what order → how each step is verified. Do not plan work for anything listed as already done or as a non-goal; check low-confidence assumptions with a read-only step before building on them.\n\n` } catch { return "" } })()}Produce a concise dependency-aware plan as a numbered list (one action per line). Mark read-only investigation steps and implementation steps. 4-8 steps. Do NOT execute.`,
      taskId, runId: taskRunId, segmentId: "seg-plan", nodeId: null,
      planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep: deep ?? classified.strategy.deep,
      onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
    })
    planText = planRes?.text ?? ""
    if (fastPath && !adoptApproved) {
      planDefs = synthesizePlan(state.objective, classified.class)
      planValidation = dagLib.validatePlan(planDefs)
      if (!planValidation.ok) {
        const repaired = dagLib.repairPlan(planDefs, state.objective, planValidation)
        if (repaired.ok) { planDefs = repaired.nodes; planValidation = dagLib.validatePlan(planDefs); planRepaired = true }
      }
      emit({
        type: "PLAN_SYNTHESIZED",
        taskId, runId: taskRunId,
        class: classified.class,
        nodes: planDefs.length,
        reason: `${classified.class} task — skip model planner`,
        items: planDefs.map((n, i) => ({ n: i + 1, text: n.title || n.objective || n.id, status: "todo" })),
      })
    } else if (recoveryPath) {
      // resume without a DAG: a 3-node inspect→patch→verify, no extra model call
      planDefs = synthesizePlan(state.objective, TASK_CLASS.SMALL)
      planValidation = dagLib.validatePlan(planDefs)
      if (!planValidation.ok) {
        const repaired = dagLib.repairPlan(planDefs, state.objective, planValidation)
        if (repaired.ok) { planDefs = repaired.nodes; planValidation = dagLib.validatePlan(planDefs); planRepaired = true }
      }
      emit({
        type: "PLAN_SYNTHESIZED",
        taskId, runId: taskRunId,
        class: classified.class,
        nodes: planDefs.length,
        reason: "RECOVERY without a recorded DAG — synthesised inspect→patch→verify",
        items: planDefs.map((n, i) => ({ n: i + 1, text: n.title || n.objective || n.id, status: "todo" })),
      })
    } else if (!restoredDAG) {
      planDefs = dagLib.parsePlanToDAG(planText)
      planValidation = dagLib.validatePlan(planDefs)
    }

    // P0 — an invalid plan must NEVER fall through into execution.
    // TASK → PLAN → SCHEMA → DEPENDENCIES → TARGETS → CONFLICTS →
    // VERIFICATION PLAN → DAG → EXECUTION.  Failure ⇒ REPAIR, or WAITING.
    // The old code transitioned to REPAIRING and then executed the *unrepaired*
    // plan anyway; and an EMPTY_PLAN silently became a generic single-node
    // mutation, which is exactly how a complex task got collapsed into "edit
    // one file". Now we actually repair, re-validate, and only continue on a
    // plan that passes.
    if (!planValidation.ok) {
      emit({ type: "PLAN_VALIDATION_FAILED", taskId, runId: taskRunId, errors: planValidation.errors, recoverable: planValidation.recoverable })
      let repair = dagLib.repairPlan(planDefs, state.objective, planValidation)
      // v21.1 P1 — a dependency CYCLE is a planning error, not something the
      // repair pass may "fix" by deleting an edge (that silently reorders
      // work the planner said must be ordered). Re-plan ONCE with the cycle
      // spelled out to the planner; if the second plan is still cyclic, stop
      // and wait for the user instead of executing a guessed order.
      if (!repair.ok && repair.needsReplan && !restoredDAG) {
        const cyc = repair.cycle
        emit({ type: "PLAN_CYCLE_DETECTED", taskId, runId: taskRunId, members: cyc.members, edges: cyc.edges, action: "re-plan" })
        ts.transition(TASK_STATUS.REPAIRING, { reason: `plan has a dependency cycle (${cyc.edges.join(", ").slice(0, 200)}) — re-planning` })
        plannerAlreadyRevised = true
        const replanRes = await agent({
          config, provider: prov, signal,
          task: `${state.objective}\n\nYour previous plan contained a DEPENDENCY CYCLE: ${cyc.edges.join(", ")} (steps ${cyc.members.join(", ")} depend on each other). A step may only depend on steps that come strictly before it. Produce a corrected, concise dependency-aware plan as a numbered list (one action per line, 4-8 steps, mark read-only investigation steps and implementation steps). Do NOT execute.`,
          taskId, runId: taskRunId, segmentId: "seg-replan", nodeId: null,
          planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
          onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
        })
        const replanText = replanRes?.text ?? ""
        const replanDefs = dagLib.parsePlanToDAG(replanText)
        const replanValidation = dagLib.validatePlan(replanDefs)
        emit({ type: "PLAN_REPLANNED", taskId, runId: taskRunId, ok: replanValidation.ok, code: replanValidation.code ?? null, nodes: replanDefs.length })
        if (replanValidation.ok || replanValidation.code !== "CYCLE_DETECTED") {
          planText = replanText
          planDefs = replanDefs
          planValidation = replanValidation
          repair = planValidation.ok ? { ok: false } : dagLib.repairPlan(planDefs, state.objective, planValidation)
          if (repair.needsReplan) repair = { ok: false } // still cyclic after non-cycle repair: stop below
        } else {
          repair = { ok: false }
          planValidation = replanValidation
        }
      }
      if (repair.ok) {
        planDefs = repair.nodes
        planValidation = dagLib.validatePlan(planDefs)
        planRepaired = true
        ts.transition(TASK_STATUS.REPAIRING, { reason: `plan repaired: ${repair.changes.join("; ").slice(0, 300)}` })
        emit({ type: "PLAN_REPAIRED", taskId, runId: taskRunId, changes: repair.changes, nodes: planDefs.length })
        ts.setNextAction(null)
      }
    }
    // V4: add a second, dependency-focused structural gate without replacing
    // the existing DAG validator. The existing planner remains authoritative;
    // this adapter catches impossible dependency graphs before execution.
    if (planValidation.ok && planDefs.length) {
      try {
        const v4Plan = buildV4Plan({
          objective: state.objective,
          steps: planDefs.map((n, i) => ({
            id: n.id ?? `n${i + 1}`,
            title: n.title ?? n.objective ?? n.id ?? `step-${i + 1}`,
            dependsOn: n.dependencies ?? n.deps ?? [],
            verification: n.verification ?? null,
          })),
        })
        emit({ type: "V4_PLAN_VALIDATED", taskId, runId: taskRunId, nodes: v4Plan.nodes.length })
      } catch (e) {
        planValidation = { ...planValidation, ok: false, errors: [...(planValidation.errors || []), `V4 plan gate: ${e?.message ?? String(e)}`], stage: "V4" }
        emit({ type: "V4_PLAN_REJECTED", taskId, runId: taskRunId, reason: String(e?.message ?? e).slice(0, 300) })
      }
    }
    // still invalid after repair (or unrecoverable by construction) → WAITING
    if (!planValidation.ok) {
      ts.transition(TASK_STATUS.WAITING, { reason: `plan invalid: ${planValidation.errors.join("; ").slice(0, 300)}` })
      // v91 §40 — an unrepairable plan is a GENUINE decision point: record a
      // CLARIFICATION and put the task in WAITING_FOR_USER (resumable, never
      // a fake failure). The engine's anti-nag gate prevents repeats.
      try {
        const d = decisions91.ask({
          type: DECISION_TYPE.CLARIFICATION,
          title: "Plan needs your input",
          question: `The plan could not be validated: ${planValidation.errors.slice(0, 2).join("; ").slice(0, 300)}`,
          options: [
            { id: "restate", label: "Restate the objective with more detail", consequences: "I will re-plan from your clarified goal" },
            { id: "proceed-minimal", label: "Proceed with a minimal safe plan", consequences: "I will execute only the unambiguous parts" },
            { id: "cancel", label: "Cancel this task", consequences: "Task ends as CANCELLED" },
          ],
          recommendation: "restate",
          reason: "the planner could not produce a verifiable plan from the current objective",
          key: `plan-invalid-${classified.class}`,
        })
        if (d && !d.skipped) ts.transition(TASK_STATUS.WAITING_FOR_USER, { reason: `decision ${d.decision_id} pending: plan invalid` })
      } catch { }
      ts.setNextAction(`wait: plan invalid — ${planValidation.errors.slice(0, 3).join(", ")}`)
      ts.setPlan(planDefs, "invalid")
      persistCritical()
      return { earlyReturn: {
        taskId,
        runId: taskRunId,
        status: FINAL.WAITING,
        text: `plan validation failed: ${planValidation.errors.join("; ")}`,
        segments: 0,
        repairs: 0,
        toolCalls: 0,
        filesChanged: [],
        verification: { ok: false, missing: [], reason: "plan invalid" },
        planValidation,
        state: state.status,
        task: state,
      } }
    }
    // v99 loopwise — the PLANNER quality gate: structure was validated
    // above; QUALITY was not. One deterministic critique (coverage vs the
    // objective's own terms, granularity, verification presence, read-only
    // balance); when majors exist, ONE bounded planOnly revision pass that
    // must beat the original score AND re-validate, else the original plan
    // stands. Fast-path synthesized plans (MICRO/SMALL/RECOVERY) are exempt —
    // deterministic by design, a revision model call would defeat the point.
    if (!restoredDAG && !fastPath && !recoveryPath && planDefs.length && planValidation.ok && config?.planner?.critique !== false) {
      try {
        const critique = critiquePlan({ objective: state.objective, planDefs, planText })
        if (critique.findings.length) {
          emit({ type: "PLAN_CRITIQUE", taskId, runId: taskRunId, findings: critique.findings.map((f) => `${f.severity}: ${f.id}`), score: Number(critique.score.toFixed(2)), advisory: plannerAlreadyRevised })
        }
        const revisionAsk = plannerAlreadyRevised ? null : planRevisionPrompt({ objective: state.objective, planText, findings: critique.findings })
        if (revisionAsk) {
          const revRes = await agent({
            config, provider: prov, signal, task: revisionAsk,
            taskId, runId: taskRunId, segmentId: "seg-plancritique", nodeId: null,
            planOnly: true, readOnly: true, noTools: true, maxStepsOverride: 4, deep,
            onEvent: passThrough(emit, "plan"), suppressRunEvents: true,
          })
          const revText = revRes?.text ?? ""
          let revDefs = dagLib.parsePlanToDAG(revText)
          let revValidation = dagLib.validatePlan(revDefs)
          // the revision gets the SAME structural repair the original plan
          // gets (e.g. "mutates but declares no verification requirement"
          // is repairable) — a revision must not be rejected for a defect
          // the pipeline already knows how to fix deterministically
          if (!revValidation.ok && revValidation.recoverable) {
            const revRepair = dagLib.repairPlan(revDefs, state.objective, revValidation)
            if (revRepair.ok) {
              revDefs = revRepair.nodes
              revValidation = dagLib.validatePlan(revDefs)
            }
          }
          if (revValidation.ok) {
            const revCritique = critiquePlan({ objective: state.objective, planDefs: revDefs, planText: revText })
            if (revCritique.score > critique.score) {
              planText = revText
              planDefs = revDefs
              planValidation = revValidation
              planRepaired = true
              emit({ type: "PLAN_REVISED", taskId, runId: taskRunId, reason: `quality critique: score ${critique.score.toFixed(2)} → ${revCritique.score.toFixed(2)}`, findingsBefore: critique.findings.length, findingsAfter: revCritique.findings.length, nodes: planDefs.length })
            } else {
              emit({ type: "PLAN_REVISION_REJECTED", taskId, runId: taskRunId, reason: `revision did not improve (score ${revCritique.score.toFixed(2)} ≤ ${critique.score.toFixed(2)}) — original stands` })
            }
          } else {
            emit({ type: "PLAN_REVISION_REJECTED", taskId, runId: taskRunId, reason: `revision failed validation (${revValidation.code ?? "invalid"}) — original stands` })
          }
        }
      } catch (e) {
        emit({ type: "PLAN_CRITIQUE", taskId, runId: taskRunId, error: String(e?.message ?? e).slice(0, 160) })
      }
    }
    if (!restoredDAG) ts.setPlan(planDefs.map((n) => n.objective ?? n.title ?? n.id), planRepaired ? "model+repaired" : "model")
  } catch (e) {
    ts.noteError("PLAN_FAILED", e?.message ?? String(e))
    planValidation = { ok: false, errors: [String(e?.message ?? e)], recoverable: true, code: "PLAN_EXCEPTION" }
    ts.transition(TASK_STATUS.WAITING, { reason: `planning failed: ${String(e?.message ?? e).slice(0, 200)}` })
    persistCritical()
    return { earlyReturn: {
      taskId,
      runId: taskRunId,
      status: FINAL.WAITING,
      text: `planning failed: ${String(e?.message ?? e)}`,
      segments: 0,
      repairs: 0,
      toolCalls: 0,
      filesChanged: [],
      verification: { ok: false, missing: [], reason: "planning failed" },
      state: state.status,
      task: state,
    } }
  }
  return { planDefs, planText, planValidation, restoredDAG }
}
