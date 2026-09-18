/**
 * forge — ONE cognitive core (v104 bindwise, zero dependencies)
 *
 * Composes engines that already exist (omega kernel = hypothesis/evidence/causal
 * /infogain/taskmodel) with the user model, task contract, governor, and self-model.
 *
 * Individual modules specialize. They are NOT independent brains.
 *
 * STATE → PREDICT → DECISION → ACTION → OBSERVATION → DELTA → LEARNING
 *
 * v101: the governor's action is AUTHORITY, not narration.
 * v102: every mutating action carries a deterministic prediction; settlement
 * against reality feeds the governor (high drift → REPLAN).
 * v103: the system models ITSELF from measured evidence (calibration + empirics),
 * invalidates a stale plan when the instruction changes (v1 stays frozen),
 * and runs the cheapest information-gain experiment before another patch.
 * v104: bind the engines that existed but were skipped on the live path —
 * world-model tests, honest covering checks (not "ok" in stdout), recorded
 * VOI experiments, ranked strategies on PLAN.
 *
 * v106: capability + knowledge gaps feed the governor; measured capability
 * health changes the next route (learning is a behavior change, not a file).
 *
 * Persistable. Restored cognitive state is reconciled against current reality,
 * never treated as still true.
 */
import fs from "node:fs"
import path from "node:path"
import { createKernel } from "./omega.js"
import { createUserModel, AUTHORITY } from "./usermodel.js"
import { createTaskContract, REQ, GAP } from "./contract.js"
import { chooseNextAction, formatAction, authorityFor, formatGovernorMessage, rankStrategies, strategyKey, CHEAPEST_FIRST, ACTION, DEPTH, depthFor } from "./governor.js"
import { predictForAction, settlePrediction as settleLedger, recordPrediction, driftVerdict, predictionsForPrompt, formatPrediction, formatSettlement } from "./prediction.js"
import { rankExperiments, formatExperiment } from "./infogain.js"
import { createSelfModel } from "./selfmodel.js"
import { createWorldModel } from "./worldmodel.js"
import { summarizeCommand } from "./cmdout.js"
import { detectGaps } from "./knowgap.js"
import { formatCapLearn, loadCapLearn } from "./caplearn.js"
import { recommendDepth, recordReasoning, formatMetaPolicy, recordStrategy, strategyRates, formatCompletionPolicy } from "./metalearn.js"
import { scoreRoute, formatJointRoute, recordRoute } from "./jointroute.js"
import { projectDir } from "./memory.js"
import { createCognitiveState, COGNITIVE_PHASE } from "./cognitive-state.js"
import { createEvidenceGraph } from "./evidence-graph.js"
import { createLearningLoop } from "./learning-loop.js"
import { recordStrategyOutcome, recommendStrategyOutcome } from "./outcome-model.js"
import { createAlphaIntelligence } from "./alpha-intelligence.js"
import { createVerificationEvidence } from "./verification-evidence.js"
import { createGoalContract } from "./goal-contract.js"
import { appendCalibration, calibrationMetrics } from "./prediction-calibration.js"
import { analyzeRepository, adaptivePlan, impactFromChangedFiles, failureIntelligence, adversarialReview, saveExpansionSnapshot, INTELLIGENCE_EXPANSION_VERSION } from "./intelligence-expansion.js"
import { metaReason, longHorizonPlan, regressionRisk, generateTests, edgeCases, selectStrategy, memoryConsolidate, multiAgentSchedule, benchmarkMatrix, INTELLIGENCE_NEXT_VERSION } from "./intelligence-next.js"
import { repositoryIntelligence, hypothesisExperiment, regressionSuite, synthesizeTestCases, consolidateMemory, multiAgentWaves, ADVANCED_INTELLIGENCE_VERSION } from "./intelligence-advanced.js"
import { validateHorizonGraph, adaptiveFrontier, horizonDecision, checkpointHorizon, advanceHorizon, HORIZON_INTELLIGENCE_VERSION } from "./horizon-intelligence.js"
import { scoreHorizonRisk, HORIZON_RISK_VERSION } from "./horizon-risk.js"
import { planHorizonRecovery, HORIZON_RECOVERY_VERSION } from "./horizon-recovery.js"
import { coordinateHorizon, HORIZON_COORDINATOR_VERSION } from "./horizon-coordinator.js"

export const COGNITION_VERSION = "1.5.0"
export const STATE_SCHEMA = "1.5.0"
export const EVENT_SCHEMA = "1.5.0"
export const INTELLIGENCE_EXPANSION = INTELLIGENCE_EXPANSION_VERSION

export const ALPHA_KERNEL_VERSION = "1.0.0"
export { ACTION, DEPTH, AUTHORITY, REQ, GAP, authorityFor, rankStrategies, CHEAPEST_FIRST }

const CHECK_CMD = /\b(test|spec|pytest|jest|vitest|mocha|lint|typecheck|tsc\b|coverage|verify)\b/i

/** A bash/test result covers writes only if it is an actual check that passed.
 *  `echo ok` / `ls` / a body containing the word "ok" is not verification. */
export function isCoveringCheck({ command = "", result = "" } = {}) {
  const text = String(result ?? "")
  const cmd = String(command ?? "")
  const sum = summarizeCommand(text)
  const exitKnown = /\[exit code: (-?\d+)\]/m.test(text)
  const testCmd = CHECK_CMD.test(cmd)
  const testOutput = !!(sum.counts && Number.isFinite(sum.counts.passed))
  if (!testCmd && !testOutput) return false
  if (sum.counts && sum.counts.failed > 0) return false
  if (exitKnown && sum.exit !== 0) return false
  if (exitKnown && sum.exit === 0) return true
  if (testOutput && sum.counts.failed === 0 && sum.counts.passed > 0) return true
  return false
}

function sameIntent(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
}

export function cognitionPath(cwd) {
  return path.join(projectDir(cwd), "cognition.json")
}

export function createCognition({ cwd = process.cwd(), objective = "", resume = null, governorEnforce = true } = {}) {
  const kernel = createKernel({ cwd })
  const cognitiveState = createCognitiveState({
    taskId: resume?.cognitiveState?.taskId || resume?.taskId || "",
    objective,
  })
  const evidenceGraph = createEvidenceGraph()
  const learningLoop = createLearningLoop()
  // Alpha layer is additive: governor/planner/verification remain authoritative.
  const alpha = createAlphaIntelligence({ cwd, klass: "SMALL", objective })
  const verificationEvidence = createVerificationEvidence({ taskId: resume?.taskId || resume?.cognitiveState?.taskId || null })
  const goalContract = createGoalContract(resume?.contract?.originalIntent || objective)
  let calibration = []
  try { verificationEvidence.restore(resume?.verificationEvidence) } catch {}
  try { if (resume?.goalContract?.history?.length) for (const h of resume.goalContract.history.slice(1)) goalContract.revise(h.text, { source: h.source, reason: h.reason }) } catch {}
  if (Array.isArray(resume?.predictionCalibration)) calibration = resume.predictionCalibration.slice(-256)
  // Restore only the additive V3 surfaces from our own persisted snapshot.
  // The existing kernel/contract remain authoritative for task semantics.
  try { if (resume?.cognitiveState) cognitiveState.restore(resume.cognitiveState) } catch { /* stale/foreign state is ignored */ }
  try { if (resume?.evidenceGraph) evidenceGraph.restore(resume.evidenceGraph) } catch { /* descriptive graph is disposable */ }
  try { if (resume?.learning) learningLoop.restore(resume.learning) } catch { /* learning history is best-effort */ }
  const user = createUserModel()
  const resumedOriginal = String(resume?.contract?.originalIntent || resume?.objective || "").trim()
  const contract = createTaskContract({ originalIntent: resumedOriginal || objective })
  const self = createSelfModel({ cwd })
  const events = []
  let inspected = false
  let hasPlan = false
  let lastAction = null
  let lastAuth = null
  let writes = 0
  let unverified = []
  let failed = false
  let looping = false
  let pendingDecision = false
  let klass = "SMALL"
  let openPred = null
  let lastSettled = null
  let lastDrift = null
  // An unsettled prediction is actionable state, not just display history.
  // Restore the full record so a resumed run can still settle it against
  // reality instead of silently losing the prediction after a checkpoint.
  if (resume?.openPrediction && typeof resume.openPrediction === "object" && resume.openPrediction.id) {
    openPred = {
      ...resume.openPrediction,
      expectedFiles: Array.isArray(resume.openPrediction.expectedFiles)
        ? resume.openPrediction.expectedFiles.slice(0, 24)
        : (Array.isArray(resume.openPrediction.files) ? resume.openPrediction.files.slice(0, 24) : []),
    }
  }
  let driftReplans = 0
  let ranked = []
  let lastExperiment = null
  let world = null
  let worldFailed = false
  let know = null
  let capGap = false
  let lastAcquire = null
  let lastMeta = null
  let lastJoint = null
  let repoIntel = null
  let adaptive = null
  let failureIntel = null
  let finalReview = null
  let nextIntel = null
  let horizonIntel = null

  function refreshGaps() {
    try {
      know = detectGaps(objective, {
        cwd,
        klass,
        persist: klass === "LARGE" || klass === "ARCHITECTURAL",
      })
      if (know?.learn?.length) emit("KNOWLEDGE_GAP", { n: know.learn.length, ids: know.learn.map((g) => g.id).slice(0, 4) })
    } catch { know = null }
  }

  function acquirePlan() {
    const g = know?.learn?.[0]
    return g?.acquire || (g ? { id: g.id, method: g.method, tool: g.tool, query: g.query, why: g.why } : null)
  }

  function observeAcquire(acq) {
    lastAcquire = acq && typeof acq === "object" ? acq : null
    inspected = true
    if (know?.learn?.length && lastAcquire) {
      know = { ...know, learn: [] }
    }
    if (Array.isArray(lastAcquire?.facts)) {
      for (const f of lastAcquire.facts.slice(0, 4)) {
        try { contract.noteEvidence({ kind: f.kind || "github", value: String(f.value || "").slice(0, 200), source: "gh" }) } catch { /* evidence is best-effort */ }
      }
    }
    emit("ACQUIRE_RAN", { tool: lastAcquire?.tool, ok: lastAcquire?.ok === true, skipped: lastAcquire?.skipped || null, hits: lastAcquire?.hits ?? 0 })
    return lastAcquire
  }

  function worldOf() {
    if (worldFailed) return null
    if (world) return world
    try { world = createWorldModel({ cwd }); return world }
    catch { worldFailed = true; return null }
  }

  function emit(type, payload = {}) {
    const ev = { type, at: Date.now(), ...payload }
    events.push(ev)
    if (events.length > 120) events.splice(0, events.length - 120)
    return ev
  }

  function counterCandidates() {
    return [
      { id: "minimal-change", strategy: "minimal change", confidence: 0.5 },
      { id: "test-first", strategy: "test first", confidence: 0.5 },
      { id: "investigate-first", strategy: "investigate first", confidence: 0.5 },
    ]
  }

  function boot(text = objective) {
    const t = String(text ?? "").trim()
    if (!t) return snapshot()
    const u = user.understand(t)
    contract.freezeIntent(t, { source: "user", reason: "original" })
    const cls = kernel.classify(t)
    klass = cls?.class || klass
    if (u.ambiguities?.length) {
      for (const a of u.ambiguities) contract.addUnknown({ text: a, impact: u.decisionAuthority === AUTHORITY.IRREVERSIBLE_CONFIRM ? "CRITICAL UNKNOWN" : "HIGH-VALUE UNKNOWN" })
    }
    emit("USER_INTENT_CREATED", { text: t, confidence: u.confidence, hypotheses: u.intentHypotheses?.length ?? 0 })
    emit("TASK_CREATED", { klass, objective: t })
    try {
      repoIntel = analyzeRepository(cwd, t, { maxFiles: 400, maxNodes: 40, maxDepth: 2 })
      emit("REPO_INTELLIGENCE_READY", { matches: repoIntel.matches.length, impact: repoIntel.impact.length })
      adaptive = adaptivePlan({ objective: t, repo: repoIntel })
    } catch { repoIntel = null; adaptive = null }
    cognitiveState.setFact("taskClass", klass)
    try {
      const nodes = (adaptive?.plan || []).map((x, i) => ({ id: x.id || `plan-${i+1}`, objective: x.text || x.id || `step-${i+1}`, dependencies: i ? [(adaptive.plan[i-1].id || `plan-${i}`)] : [] }))
      nextIntel = { version: INTELLIGENCE_NEXT_VERSION, meta: metaReason({ objective: t }), horizon: longHorizonPlan({ nodes }), regression: regressionRisk({ changedFiles: [], historicalFailures: [] }), testProposals: generateTests({ requirements: [t] }), edgeCases: edgeCases({ objective: t }), strategy: selectStrategy({ candidates: counterCandidates(), evidence: [t] }), memory: memoryConsolidate({ episodes: [] }), agents: multiAgentSchedule({ agents: ["researcher", "tester", "reviewer", "coder"] }), benchmark: benchmarkMatrix() }
      nextIntel.advanced = { version: ADVANCED_INTELLIGENCE_VERSION, repo: repositoryIntelligence({ files: [], imports: [], objective: t }), experiment: hypothesisExperiment({ hypothesis: t, expected: t }), regression: regressionSuite({ changedFiles: [], tests: [] }), testCases: synthesizeTestCases({ requirements: [t], edgeCases: edgeCases({ objective: t }).cases }), memory: consolidateMemory({ episodes: [] }), waves: multiAgentWaves({ agents: ["researcher", "tester", "reviewer", "coder"], dependencies: [{ from: "researcher", to: "tester" }, { from: "tester", to: "reviewer" }, { from: "reviewer", to: "coder" }] }) }
      const horizonNodes = (adaptive?.plan || []).map((x, i) => ({ id: x.id || `plan-${i+1}`, objective: x.text || x.id || `step-${i+1}`, dependencies: i ? [(adaptive.plan[i-1].id || `plan-${i}`)] : [], priority: Number(x.priority) || 0, files: [...new Set([...(x.targetFiles || []), ...(x.files || []), ...(i < 2 ? (repoIntel?.matches || []).slice(0, 4).map(m => m.path) : [])].map(String).filter(Boolean))] }))
      horizonIntel = { version: HORIZON_INTELLIGENCE_VERSION, graph: validateHorizonGraph({ nodes: horizonNodes }), frontier: adaptiveFrontier({ nodes: horizonNodes }), decision: horizonDecision({ objective: t, frontier: adaptiveFrontier({ nodes: horizonNodes }).frontier, evidence: [] }), checkpoint: checkpointHorizon({ nodes: horizonNodes }), risk: scoreHorizonRisk({ nodes: horizonNodes }), recovery: planHorizonRecovery({ nodes: horizonNodes, reason: "BOOT", attempt: 0 }), coordinator: coordinateHorizon({ nodes: horizonNodes, agents: ["researcher", "tester", "reviewer", "coder"], maxParallel: 3 }) }
      emit("HORIZON_INTELLIGENCE_READY", { version: HORIZON_INTELLIGENCE_VERSION, frontier: horizonIntel.frontier.frontier.length, graphValid: horizonIntel.graph.valid })
      emit("NEXT_INTELLIGENCE_READY", { version: INTELLIGENCE_NEXT_VERSION, mode: nextIntel.meta.mode, frontier: nextIntel.horizon.frontier.length })
    } catch { nextIntel = null }
    if (u.intentHypotheses?.length > 1) {
      emit("HYPOTHESIS_CREATED", { kind: "intent", count: u.intentHypotheses.length })
    }
    return snapshot()
  }

  function absorbInstruction(text) {
    const t = String(text ?? "").trim()
    if (!t) return { changed: false }
    const orig = contract.original()?.text
    if (!orig) {
      boot(t)
      return { changed: false, booted: true }
    }
    if (sameIntent(orig, t) || sameIntent(contract.currentIntent()?.text, t)) {
      return { changed: false, original: orig }
    }
    const semantic = goalContract.revise(t, { source: "user", reason: "changed-instruction" })
    contract.reviseIntent(t, { source: "user", reason: "changed-instruction" })
    if (semantic.droppedConstraints?.length) {
      contract.addGap({ text: `semantic goal drift dropped constraints: ${semantic.droppedConstraints.map(x => x.text).join(" | ")}` , kind: GAP.CONFLICT, impact: "high" })
      emit("GOAL_CONSTRAINT_DROPPED", { constraints: semantic.droppedConstraints.slice(0, 8), semanticDrift: semantic.semanticDrift })
    }
    if (semantic.level === "HIGH") emit("GOAL_SEMANTIC_DRIFT", { level: semantic.level, score: semantic.semanticDrift, tokenOverlap: semantic.tokenOverlap })
    const u = user.understand(t)
    hasPlan = false
    ranked = []
    openPred = null
    lastDrift = null
    driftReplans = 0
    contract.addGap({ text: "instruction changed — prior plan and predictions may be stale", kind: GAP.CONFLICT, impact: "high" })
    const cls = kernel.classify(t)
    klass = cls?.class || klass
    emit("USER_INTENT_CONFLICT", { previous: orig, next: t, reason: "changed-instruction" })
    emit("USER_INTENT_CREATED", { text: t, confidence: u.confidence, reason: "changed-instruction" })
    return { changed: true, previous: orig, next: t, original: orig }
  }

  if (resume?.user || resume?.contract) {
    try {
      if (resumedOriginal) {
        user.understand(resumedOriginal)
        klass = kernel.classify(resumedOriginal)?.class || klass
      }
      if (resume.rejected) for (const r of resume.rejected) user.rejectStrategy(r)
    } catch { /* restore is best-effort; reality is reconstructed below */ }
    emit("TASK_RESUMED", { from: "cognition.json" })
    if (objective) absorbInstruction(objective)
  } else if (objective) {
    boot(objective)
  }
  refreshGaps()

  function next(opts = {}) {
    if (opts.inspected != null) inspected = Boolean(opts.inspected)
    if (opts.hasPlan != null) hasPlan = Boolean(opts.hasPlan)
    if (opts.writes != null) writes = Number(opts.writes) || 0
    if (opts.unverified) unverified = Array.isArray(opts.unverified) ? opts.unverified : []
    if (opts.failed != null) failed = Boolean(opts.failed)
    if (opts.looping != null) looping = Boolean(opts.looping)
    if (opts.pendingDecision != null) pendingDecision = Boolean(opts.pendingDecision)
    const repair = failed ? (kernel.nextRepair?.() || null) : null
    lastExperiment = repair?.experiment || lastExperiment
    if (!failed && writes === 0 && klass !== "MICRO" && klass !== "SMALL") {
      try {
        lastExperiment = kernel.infogain?.select?.({ klass }) || lastExperiment || rankExperiments({ klass })[0] || null
      } catch { /* catalog is optional */ }
    }
    const u = user.understanding
    const ambiguous = (u?.intentHypotheses?.length ?? 0) > 1 && (u?.confidence ?? 1) < 0.55
    try {
      lastMeta = recommendDepth({
        cwd,
        klass,
        fallback: depthFor({ klass, failed, conflict: ambiguous }),
        failed,
        conflict: ambiguous,
      })
    } catch { lastMeta = null }
    try {
      lastJoint = scoreRoute({
        cwd,
        klass,
        task: objective,
        depth: lastMeta?.depth || depthFor({ klass, failed, conflict: ambiguous }),
        model: opts.model || "",
        skills: opts.skills || [],
        failed,
        lockModel: opts.lockModel === true,
      })
    } catch { lastJoint = null }
    const learned = lastJoint?.depth || ((lastMeta?.source === "learned" || lastMeta?.source === "shift" || lastMeta?.source === "floor") ? lastMeta.depth : null)
    const action = chooseNextAction({
      klass,
      contract,
      user,
      repair,
      writes,
      unverified,
      steps: opts.steps ?? 0,
      failed,
      looping,
      pendingDecision,
      hasPlan,
      inspected,
      verified: opts.verified ?? (unverified.length === 0 && writes > 0),
      reviewRequired: opts.reviewRequired ?? (klass === "ARCHITECTURAL" || klass === "LARGE"),
      aborted: opts.aborted === true,
      driftScore: lastDrift?.driftScore ?? opts.driftScore ?? 0,
      driftLevel: lastDrift?.level ?? opts.driftLevel ?? null,
      driftReplans,
      experiment: lastExperiment,
      knowledgeGap: (Boolean(know?.learn?.length) && !lastAcquire) || opts.knowledgeGap === true,
      capabilityGap: capGap || opts.capabilityGap === true,
      learnedDepth: learned,
    })
    if (action.action === ACTION.REPLAN && (lastDrift?.level === "MISS" || (lastDrift?.driftScore ?? 0) >= 0.75)) {
      driftReplans += 1
    }
    lastAction = action
    lastAuth = authorityFor(action.action, { klass, enforce: governorEnforce })
    // Keep the additive V3 lifecycle synchronized with the governor's real
    // next action. Non-phase governor actions (THINK/SEARCH/TEST/REVIEW/STOP)
    // remain owned by their existing layers and do not get invented states.
    const actionPhase = {
      INSPECT: COGNITIVE_PHASE.INSPECT,
      PLAN: COGNITIVE_PHASE.PLAN,
      PREDICT: COGNITIVE_PHASE.PREDICT,
      EXECUTE: COGNITIVE_PHASE.EXECUTE,
      VERIFY: COGNITIVE_PHASE.VERIFY,
      REPAIR: COGNITIVE_PHASE.REPAIR,
      REPLAN: COGNITIVE_PHASE.REPLAN,
      WAIT: COGNITIVE_PHASE.WAITING,
      ASK: COGNITIVE_PHASE.WAITING,
    }[action.action]
    if (actionPhase && cognitiveState.phase !== actionPhase) {
      cognitiveState.transition(actionPhase, { reason: `governor action: ${action.action}` })
    }
    if (action.action === ACTION.PLAN && ranked.length === 0) {
      const hypos = user.understanding?.intentHypotheses || []
      // v121 deadwire: `id` here is POSITIONAL. usermodel.js assigns IH1..IHn
      // by position inside whichever cue branch matched, so IH1 is "repair the
      // currently failing test" for a *fix it* task and "quality of the
      // existing behavior" for an *improve* task — and both used to land in
      // the same metalearn row byKlass[MEDIUM].strategies.IH1. rankStrategies
      // weights that rate at +rate*0.45 − (1−rate)*0.4, an EV swing of ±0.85
      // against a base spread of ~0.75, so a conflated row can flip the pick.
      // `key` is the stable identity: the hypothesis GOAL, which comes from a
      // fixed table and therefore repeats across runs. (`text` cannot serve —
      // it embeds the objective, so it would never repeat at all.)
      const list = hypos.length
        ? hypos.map((h) => ({
          id: h.id,
          key: strategyKey(h.goal || h.meaning || h.id),
          text: String(h.meaning || h.goal || h.id).slice(0, 200),
          reversible: true,
          cost: 0.35,
          confidence: h.confidence,
        }))
        : [
          { id: "S1", key: "smallest-reversible-change", text: `smallest reversible change: ${String(objective).slice(0, 120)}`, reversible: true, cost: 0.2, blast: 0.2 },
          { id: "S2", key: "broader-change", text: `broader change: ${String(objective).slice(0, 120)}`, reversible: false, cost: 0.75, blast: 0.7 },
        ]
      noteStrategies(list)
    }
    emit("GOVERNOR_ACTION", { action: action.action, why: action.why, depth: action.depth, voi: action.voi, enforce: lastAuth.enforce, halt: lastAuth.halt, drift: lastDrift?.level ?? null, meta: lastMeta?.source || null, joint: lastJoint?.source || null })
    return action
  }

  function enforce(gov = lastAction) {
    lastAuth = authorityFor(gov?.action || ACTION.EXECUTE, { klass, enforce: governorEnforce })
    return lastAuth
  }

  function stepDirective(gov = lastAction, auth = lastAuth) {
    return formatGovernorMessage(gov || lastAction, auth || lastAuth)
  }

  function updateHorizon({ completed = [], failed = [], evidence = [], budget = {}, attempt = 0, changedFiles = [], historicalFailures = [], tests = [] } = {}) {
    if (!horizonIntel) return null
    const nodes = Array.isArray(horizonIntel.checkpoint?.nodes) ? horizonIntel.checkpoint.nodes : []
    const currentCompleted = Array.isArray(horizonIntel.checkpoint?.completed) ? horizonIntel.checkpoint.completed : []
    const currentFailed = Array.isArray(horizonIntel.checkpoint?.failed) ? horizonIntel.checkpoint.failed : []
    // Agent write ledgers use absolute paths; the semantic graph uses repository-relative paths.
    // Normalize at this boundary so live impact/risk actually match graph nodes.
    const observedFiles = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => {
      const raw = String(f ?? "")
      if (!raw || raw === "(shell write)") return raw
      try { return path.relative(cwd, path.resolve(cwd, raw)).replaceAll("\\", "/") } catch { return raw.replaceAll("\\", "/") }
    }).filter(Boolean))]
    const next = advanceHorizon({
      nodes,
      completed: [...currentCompleted, ...completed],
      failed: [...currentFailed, ...failed],
      evidence,
      attempt,
      budget: { ...budget, objective },
    })
    let liveImpact = null
    try {
      liveImpact = impactFromChangedFiles(cwd, observedFiles, { maxFiles: 400, maxNodes: 24, maxDepth: 2 })
    } catch { liveImpact = null }
    let replanned = null
    if (next.decision.action === "REPLAN" && (failed.length || currentFailed.length)) {
      try {
        replanned = adaptivePlan({ objective, repo: { ...(repoIntel || {}), impact: liveImpact?.impact || repoIntel?.impact || [], matches: repoIntel?.matches || [] }, previousPlan: adaptive?.plan || [], failures: [...currentFailed, ...failed] })
      } catch { replanned = null }
    }
    // A replan is only useful if the live horizon consumes it. Rebuild the DAG from the
    // returned plan, retain observed impact as file metadata, and recompute frontier/checkpoint.
    let activeNodes = nodes
    let activeNext = next
    if (replanned?.plan?.length) {
      const impactFiles = (liveImpact?.impact || []).map((x) => x.path).filter(Boolean)
      activeNodes = replanned.plan.map((x, i) => ({
        id: String(x.id || `plan-${i + 1}`),
        objective: String(x.text || x.id || `step-${i + 1}`),
        dependencies: i ? [String(replanned.plan[i - 1].id || `plan-${i}`)] : [],
        priority: Number(x.priority) || 0,
        files: [...new Set([...(x.targetFiles || []), ...(x.files || []), ...(i < 2 ? impactFiles.slice(0, 4) : [])].map(String).filter(Boolean))],
        tests: Array.isArray(x.tests) ? x.tests.map(String).slice(0, 32) : [],
      }))
      activeNext = advanceHorizon({
        nodes: activeNodes,
        completed: [...currentCompleted, ...completed],
        failed: [...currentFailed, ...failed],
        evidence,
        attempt,
        budget: { ...budget, objective },
      })
    }
    const risk = scoreHorizonRisk({ nodes: activeNodes, changedFiles: observedFiles, historicalFailures, tests })
    const coordinator = coordinateHorizon({ nodes: activeNodes, completed: activeNext.checkpoint.completed, failed: activeNext.checkpoint.failed, agents: ["researcher", "tester", "reviewer", "coder"], maxParallel: 3 })
    const recovery = planHorizonRecovery({
      nodes: activeNodes, completed: activeNext.checkpoint.completed, failed: activeNext.checkpoint.failed, evidence,
      reason: activeNext.decision.action === "CHECKPOINT" ? "BUDGET" : activeNext.decision.action === "REPLAN" ? "FAILURE" : "PROGRESS", attempt
    })
    horizonIntel = { ...horizonIntel, ...activeNext, risk, liveImpact, replanned, recovery, coordinator }
    emit("HORIZON_INTELLIGENCE_UPDATED", { action: activeNext.decision.action, frontier: activeNext.frontier.frontier.length, completed: activeNext.checkpoint.completed.length, failed: activeNext.checkpoint.failed.length, impact: liveImpact?.impact?.length || 0, replanned: !!replanned, recovery: recovery.action, wave: coordinator.waves[0]?.length || 0 })
    return horizonIntel
  }

  function noteInspect() {
    inspected = true
    cognitiveState.transition(COGNITIVE_PHASE.INSPECT, { reason: "inspection observed" })
    emit("OBSERVATION_CREATED", { kind: "inspect" })
  }

  function notePlan(plan) {
    hasPlan = true
    cognitiveState.transition(COGNITIVE_PHASE.PLAN, { reason: "plan recorded" })
    try { evidenceGraph.addNode("PLAN", plan || "plan", { id: `plan-${Date.now()}` }) } catch { /* graph is descriptive */ }
    contract.setStrategy(plan || "plan")
    emit("PLAN_CREATED")
  }

  function noteStrategies(list = []) {
    try { alpha.setContext({ nextKlass: klass, nextObjective: objective }) } catch {}
    let rates = null
    try { rates = strategyRates(cwd, klass) } catch { rates = null }
    ranked = rankStrategies(list, { rates })
    try {
      const alphaRanked = alpha.selectPlans(ranked)
      const margin = alphaRanked.length > 1 ? alphaRanked[0].alphaScore - alphaRanked[1].alphaScore : 1
      // Only adopt a measured/advisory ordering when the signal is material;
      // otherwise preserve the established governor ranking exactly.
      if (alphaRanked[0] && margin >= 0.08) ranked = alphaRanked
    } catch { /* alpha intelligence is advisory */ }
    // v140 alpha core: historical outcomes may refine the ranking, but only
    // with enough same-project evidence and a meaningful measured advantage.
    // The governor remains authoritative; this is a bounded tie-breaker, not
    // a completion/safety bypass.
    try {
      const learned = recommendStrategyOutcome({ cwd, klass, candidates: ranked })
      if (learned?.key) {
        const i = ranked.findIndex((x) => String(x?.key || x?.id) === learned.key)
        if (i > 0) {
          const [picked] = ranked.splice(i, 1)
          ranked.unshift(picked)
          emit("LEARNED_STRATEGY_SELECTED", { key: learned.key, samples: learned.samples, rate: learned.rate, why: learned.why })
        }
      }
    } catch { /* outcome learning is advisory; preserve existing ranking */ }
    if (ranked[0]) contract.setStrategy(ranked[0].text || ranked[0].id)
    for (const s of ranked) contract.addAlternative(s)
    emit("PLAN_CREATED", { strategies: ranked.length, best: ranked[0]?.id ?? null })
    return ranked
  }

  function predict(opts = {}) {
    try { alpha.setContext({ nextKlass: klass, nextObjective: objective }) } catch {}
    const pred = predictForAction({
      action: opts.action || lastAction?.action || ACTION.EXECUTE,
      objective: opts.objective || objective,
      expectedFiles: opts.expectedFiles,
      reads: opts.reads,
      writes: opts.writes,
      scope: opts.scope || contract.snapshot()?.scope?.files,
      expectedRisk: opts.expectedRisk,
      expectedSteps: opts.expectedSteps ?? 1,
      taskId: opts.taskId,
    })
    openPred = pred
    try { alpha.predictDecision({ action: pred.action, strategy: ranked[0] || null, expected: pred.expectedFiles || [] }) } catch { /* advisory */ }
    cognitiveState.setFact("predictionId", pred.id)
    cognitiveState.transition(COGNITIVE_PHASE.PREDICT, { reason: "prediction recorded", evidence: [pred.id] })
    try { evidenceGraph.addNode("PREDICTION", { id: pred.id, files: pred.expectedFiles || [] }, { id: pred.id, files: pred.expectedFiles || [] }) } catch { /* graph is descriptive */ }
    if (pred.expectedTests == null && pred.expectedFiles?.length && klass !== "MICRO") {
      try {
        const n = worldOf()?.testsFor?.(pred.expectedFiles)?.length
        if (Number.isFinite(n)) pred.expectedTests = n
      } catch { /* world is a view */ }
    }
    contract.notePrediction({ id: pred.id, expected: pred.expectedFiles, derived: pred.derived, action: pred.action })
    contract.setExpected(pred.expectedOutcome)
    emit("PREDICTION_MADE", { id: pred.id, files: pred.expectedFiles, derived: pred.derived, action: pred.action, text: formatPrediction(pred) })
    return pred
  }

  function settle(opts = {}) {
    if (!openPred) return null
    cognitiveState.transition(COGNITIVE_PHASE.OBSERVE, { reason: "prediction settled", evidence: [openPred.id] })
    const settled = settleLedger(openPred, {
      actualFiles: opts.actualFiles || [],
      finalRisk: opts.finalRisk ?? null,
      status: opts.status ?? "ok",
      actualTests: opts.actualTests,
      actualSteps: opts.actualSteps,
    })
    lastSettled = settled
    calibration = appendCalibration(calibration, openPred, settled.status)
    lastDrift = driftVerdict(settled)
    try { recordPrediction(settled, cwd) } catch { /* ledger is best-effort */ }
    contract.settlePrediction(settled.id, settled.actualFiles)
    contract.setActual(settled.status)
    if (lastDrift.level === "MISS" || lastDrift.level === "SCOPE") {
      contract.addGap({ text: lastDrift.why, kind: "UNVERIFIED", impact: lastDrift.level === "MISS" ? "high" : "medium" })
    }
    emit("PREDICTION_SETTLED", {
      id: settled.id, drift: lastDrift.level, driftScore: lastDrift.driftScore,
      extra: settled.filesExtra, missed: settled.filesMissed, text: formatSettlement(settled),
    })
    openPred = null
    return { settled, drift: lastDrift }
  }

  function observeCommand(result, meta = {}) {
    cognitiveState.transition(COGNITIVE_PHASE.OBSERVE, { reason: "command result observed" })
    try { alpha.setContext({ nextKlass: klass, nextObjective: objective }) } catch {}
    const obs = kernel.observeCommand(result, meta)
    try {
      alpha.observe({ ok: !Boolean(obs?.diagnosis?.failed), files: meta.files || [], action: lastAction?.action || "", failure: obs?.diagnosis?.failed ? obs.diagnosis : null })
    } catch { /* advisory */ }
    failed = Boolean(obs?.diagnosis?.failed)
    try {
      failureIntel = failureIntelligence(result, { ...meta, tool: meta.tool || "bash" }, [])
      if (failureIntel?.diagnosis?.failed) emit("FAILURE_INTELLIGENCE", { code: failureIntel.diagnosis.code, repeated: failureIntel.repeated, strategyCount: failureIntel.strategy?.strategies?.length || 0 })
    } catch { failureIntel = null }
    if (failed) {
      // A failed observation enters DIAGNOSE explicitly so REPAIR/REPLAN can
      // consume a truthful lifecycle state instead of jumping from OBSERVE
      // straight to an action with no diagnostic phase.
      cognitiveState.transition(COGNITIVE_PHASE.DIAGNOSE, { reason: "observed command failure" })
    }
    contract.noteEvidence({
      kind: obs?.diagnosis?.failed ? "command-fail" : "command-ok",
      value: obs?.summary || String(result ?? "").slice(0, 200),
      source: "command",
      files: meta.files || [],
    })
    emit(obs?.diagnosis?.failed ? "PREDICTION_MISMATCH" : "ACTION_COMPLETED", { failed: obs?.diagnosis?.failed || false })
    if (obs?.hypothesis) emit("HYPOTHESIS_CREATED", { id: obs.hypothesis.id, description: obs.hypothesis.description })
    return obs
  }

  function observeTools(records = []) {
    // Tool results arrive after execution. Record the EXECUTE phase first so
    // the V3 state machine represents the real lifecycle instead of jumping
    // directly from PREDICT to OBSERVE. Invalid transitions remain descriptive
    // failures and never alter the existing execution policy.
    if (records.length) cognitiveState.transition(COGNITIVE_PHASE.EXECUTE, { reason: "tool execution observed" })
    for (const r of records) {
      const name = r.name || r.tool || ""
      const raw = r.result != null ? String(r.result) : (r.ok === false ? "ERROR" : "")
      const failedTool = /^ERROR|^BLOCKED/.test(raw)
      if (["write_file", "edit_file", "multi_edit", "apply_patch"].includes(name) && !failedTool) {
        writes += 1
        const file = r.args?.path || r.file || r.args?.file
        if (file) {
          unverified.push(file)
          try {
            const actionId = evidenceGraph.addNode("ACTION", { tool: name, file }, { files: [file] })
            if (openPred?.id) evidenceGraph.link(openPred.id, actionId, "predicts")
          } catch { /* graph is descriptive */ }
          kernel.noteWrite?.(file)
          try { worldOf()?.invalidate?.([file]) } catch { /* stale world is worse than a missed invalidate */ }
          try { evidenceGraph.staleFiles([file]) } catch { /* graph is descriptive */ }
          contract.noteEvidence({ kind: "write", value: file, source: name, files: [file] })
        }
      }
      if (name === "bash" || name === "test") {
        const text = String(r.result ?? "")
        const command = String(r.args?.command || r.args?.cmd || "")
        if (lastExperiment?.id) {
          try {
            const sum = summarizeCommand(text)
            kernel.noteExperiment?.(lastExperiment.id, sum.ok ? "pass" : "fail")
          } catch { /* experiment ledger is best-effort */ }
        }
        // Observe reality BEFORE moving into VERIFY. The old order attempted
        // VERIFY -> OBSERVE, which is intentionally not an allowed lifecycle
        // transition and therefore left the state machine stuck in VERIFY.
        // Verification is a consequence of an observed covering check, not a
        // replacement for observation.
        observeCommand(text, { tool: name })
        const covering = isCoveringCheck({ command, result: text })
        if (covering) {
          cognitiveState.transition(COGNITIVE_PHASE.VERIFY, { reason: "covering check observed" })
          const coveredFiles = [...new Set(unverified.filter(Boolean))].slice(0, 32)
          unverified = []
          contract.setVerification({ status: "PASSED" })
          try {
            const kind = /security|audit|snyk|trivy|semgrep|bandit|gosec/i.test(command) ? "security" : /build|tsc|compile|webpack|vite build/i.test(command) ? "build" : /node --check|syntax/i.test(command) ? "syntax" : "test"
            const reqs = contract.snapshot().requirements
            for (const req of reqs) verificationEvidence.bindRequirement({ requirementId: req.id, text: req.text, kind, affectedFiles: reqs.length ? (contract.snapshot()?.scope?.files || coveredFiles) : coveredFiles })
            verificationEvidence.record({ kind, passed: true, exitCode: 0, exitCodeKnown: true, output: text, command, affectedFiles: coveredFiles, requirementIds: reqs.map(r => r.id) })
          } catch {}
          try {
            const verificationId = evidenceGraph.addNode("VERIFICATION", { command, result: text.slice(0, 400) }, { files: coveredFiles })
            if (openPred?.id) evidenceGraph.link(openPred.id, verificationId, "verified-by")
          } catch { /* graph is descriptive */ }
          const reqs = contract.snapshot().requirements
          for (const req of reqs) if (req.status === REQ.IMPLEMENTED || req.status === REQ.OPEN) contract.setRequirement(req.id, REQ.VERIFIED)
        }
      }
      if (name === "github" && !failedTool) {
        contract.noteEvidence({
          kind: /CI reported failure|unavailable/i.test(raw) ? "github-ci" : "github",
          value: raw.slice(0, 240),
          source: "github",
        })
        inspected = true
      }
    }
    if (records.length) cognitiveState.transition(COGNITIVE_PHASE.OBSERVE, { reason: "tool results observed" })
  }

  function learnFeedback(text) {
    const rec = user.recordFeedback(text)
    contract.addFeedback(rec)
    emit("USER_FEEDBACK_RECEIVED", { kind: rec.kind })
    return rec
  }

  function close(opts = {}) {
    try { alpha.setContext({ nextKlass: klass, nextObjective: objective }) } catch {}
    const contractSnap = contract.snapshot()
    for (const req of contractSnap.requirements || []) verificationEvidence.bindRequirement({ requirementId: req.id, text: req.text, kind: "acceptance", affectedFiles: contractSnap.scope?.files || unverified })
    const evidenceVerdict = verificationEvidence.verdict({ changedFiles: unverified.length ? unverified : (contractSnap.scope?.files || []) })
    try { finalReview = adversarialReview({ objective, report: opts.report || "", toolCalls: opts.toolCalls || events.filter(e => /TOOL|ACTION|OBSERVE/.test(e.type)).length, evidenceCount: evidenceVerdict.evidenceCount || 0, verification: evidenceVerdict.ok ? "verified" : "unverified", ok: evidenceVerdict.ok && !unverified.length }) } catch { finalReview = null }
    const gate = contract.canComplete({
      wrote: (opts.wrote ?? writes) > 0,
      unverified: opts.unverified ?? unverified,
      klass,
    })
    const finalGate = (contractSnap.requirements?.length && !evidenceVerdict.ok) ? { ...gate, ok: false, status: "VERIFICATION_EVIDENCE_INCOMPLETE", why: evidenceVerdict.reason, evidence: evidenceVerdict } : gate
    try {
      recordReasoning({
        cwd,
        klass,
        depth: lastAction?.depth || lastMeta?.depth || DEPTH.L2,
        ok: finalGate.ok === true,
        repairs: driftReplans,
        replans: driftReplans,
      })
      // v121: record under the STABLE key, not the positional id.
      if (ranked[0]?.key || ranked[0]?.id) {
        const strategyId = ranked[0].key || ranked[0].id
        recordStrategy({ cwd, klass, id: strategyId, ok: finalGate.ok === true })
        recordStrategyOutcome({
          cwd, klass, key: strategyId, ok: finalGate.ok === true,
          repairs: driftReplans, replans: driftReplans,
          drift: lastDrift?.driftScore ?? null,
        })
      }
      recordRoute({
        cwd,
        klass,
        depth: lastAction?.depth || lastJoint?.depth || lastMeta?.depth || DEPTH.L2,
        model: lastJoint?.model || "*",
        skills: lastJoint?.skills || [],
        ok: finalGate.ok === true,
      })
    } catch { /* meta ledger is best-effort */ }
    cognitiveState.transition(finalGate.ok ? COGNITIVE_PHASE.COMPLETE : COGNITIVE_PHASE.INCOMPLETE, { reason: finalGate.why })
    const causalChain = kernel.snapshot?.().causal || null
    try {
      const target = causalChain?.root || causalChain?.proximate || causalChain?.symptom
      if (target) alpha.attributeCause({ layer: target.layer, description: target.description, confidence: target.confidence, evidence: target.evidence?.map(e => e.text) })
      const strategyId = ranked[0]?.key || ranked[0]?.id || lastAction?.action || "unknown"
      alpha.learn({ strategy: strategyId, klass, ok: finalGate.ok === true, repairs: driftReplans, replans: driftReplans, predictionError: lastDrift?.driftScore ?? null })
    } catch { /* advisory learning never blocks completion */ }
    const causalNode = causalChain?.root || causalChain?.proximate || causalChain?.symptom || null
    learningLoop.record({
      action: lastAction?.action,
      observation: lastSettled,
      verification: gate.status,
      outcome: finalGate.ok ? "complete" : "incomplete",
      attribution: causalNode ? { causeId: causalNode.id, layer: causalNode.layer, confidence: causalNode.confidence } : null,
      error: lastDrift?.driftScore ?? null,
    })
    emit(finalGate.ok ? "TASK_COMPLETED" : "TASK_INCOMPLETE", { why: finalGate.why, status: finalGate.status, depth: lastAction?.depth || null, verificationEvidence: evidenceVerdict })
    return finalGate
  }

  function snapshot() {
    return {
      cognitionVersion: COGNITION_VERSION,
      cognitiveState: cognitiveState.snapshot(),
      evidenceGraph: evidenceGraph.snapshot(),
      learning: learningLoop.snapshot(),
      stateSchema: STATE_SCHEMA,
      klass,
      inspected,
      hasPlan,
      writes,
      unverified: unverified.slice(),
      failed,
      pendingDecision,
      lastAction,
      lastAuth,
      lastDrift,
      lastSettled: lastSettled ? { id: lastSettled.id, driftScore: lastSettled.driftScore, derived: lastSettled.derived } : null,
      openPrediction: openPred ? {
        ...openPred,
        expectedFiles: Array.isArray(openPred.expectedFiles) ? [...openPred.expectedFiles] : [],
      } : null,
      ranked,
      self: self.snapshot(),
      experiment: lastExperiment ? { id: lastExperiment.id, kind: lastExperiment.kind, gain: lastExperiment.gain } : null,
      user: user.snapshot(),
      contract: contract.snapshot(),
      kernel: kernel.snapshot(),
      alpha: alpha.snapshot(),
      verificationEvidence: verificationEvidence.serialize(),
      goalContract: goalContract.snapshot(),
      predictionCalibration: calibration.slice(-256),
      predictionCalibrationMetrics: calibrationMetrics(calibration),
      intelligenceExpansion: { version: INTELLIGENCE_EXPANSION_VERSION, repo: repoIntel, adaptivePlan: adaptive, failure: failureIntel, finalReview },
      intelligenceNext: nextIntel,
      horizonIntelligence: horizonIntel,
      events: events.slice(-40),
    }
  }

  function brief() {
    const u = user.understanding
    return {
      klass,
      intent: contract.original()?.text ?? objective,
      intentHypotheses: u?.intentHypotheses?.length ?? 0,
      confidence: u?.confidence ?? null,
      authority: u?.decisionAuthority ?? null,
      lastAction: lastAction?.action ?? null,
      enforce: lastAuth?.enforce ?? false,
      halt: lastAuth?.halt ?? false,
      drift: lastDrift?.level ?? null,
      predicted: openPred?.id ?? lastSettled?.id ?? null,
      experiment: lastExperiment?.id ?? null,
      nextIntelligence: nextIntel ? { version: nextIntel.version, mode: nextIntel.meta.mode, frontier: nextIntel.horizon.frontier.length } : null,
      horizonIntelligence: horizonIntel ? { version: horizonIntel.version, action: horizonIntel.decision.action, frontier: horizonIntel.frontier.frontier.length, risk: horizonIntel.risk ? { version: HORIZON_RISK_VERSION, requiresEscalation: horizonIntel.risk.requiresEscalation, verification: horizonIntel.risk.verification } : null, recovery: horizonIntel.recovery ? { version: HORIZON_RECOVERY_VERSION, action: horizonIntel.recovery.action, resume: horizonIntel.recovery.resume } : null, coordinator: horizonIntel.coordinator ? { version: HORIZON_COORDINATOR_VERSION, wave: horizonIntel.coordinator.waves?.[0]?.length || 0, assignments: horizonIntel.coordinator.waves?.[0] || [] } : null } : null,
    }
  }

  function promptBlock() {
    const parts = [user.formatForPrompt(), contract.formatForPrompt()]
    try { parts.push(self.formatForPrompt({ klass, driftLevel: lastDrift?.level })) } catch { /* self-model is context */ }
    if (lastAction) parts.push(formatAction(lastAction))
    if (lastAuth?.directive) parts.push(`AUTHORITY: ${lastAuth.action} enforce=${lastAuth.enforce} halt=${lastAuth.halt} — ${lastAuth.directive}`)
    parts.push(`CAPABILITY ROUTER: ${CHEAPEST_FIRST}. Do not spend tokens on what a grep can answer.`)
    if (horizonIntel) {
      const hr = horizonIntel.risk || {}
      parts.push(`HORIZON: action=${horizonIntel.decision?.action || "INVESTIGATE"} frontier=${(horizonIntel.frontier?.frontier || []).join(",") || "none"} risk=${hr.requiresEscalation ? "ESCALATE-VERIFICATION" : "normal"} verify=${(hr.verification || []).join(",") || "none"} impact=${(horizonIntel.liveImpact?.impact || []).slice(0,4).map(x=>x.path).join(",") || "none"} replan=${horizonIntel.replanned ? "available" : "none"} recovery=${horizonIntel.recovery?.action || "none"}:${(horizonIntel.recovery?.resume || []).slice(0,4).join(",") || "none"} wave=${horizonIntel.coordinator?.waves?.[0]?.length || 0}. Advisory only; authority and completion gates remain authoritative.`)
    }
    if (lastExperiment) {
      const line = formatExperiment(lastExperiment)
      if (line) parts.push(`VOI EXPERIMENT (cheapest discriminating check, before another patch):\n${line}`)
    }
    if (know?.learn?.length && !lastAcquire) {
      parts.push("KNOWLEDGE GAPS (cheapest acquire first — skill/repo before the web; do not research for its own sake):")
      for (const g of know.learn.slice(0, 3)) {
        parts.push(`- ${g.id} via ${g.method}/${g.tool}: ${g.query || g.why || ""}`)
      }
    }
    if (lastMeta) {
      const line = formatMetaPolicy(lastMeta)
      if (line) parts.push(line)
    }
    if (adaptive?.plan?.length) {
      parts.push("ADAPTIVE PLAN (evidence-driven, bounded):")
      for (const step of adaptive.plan.slice(0, 6)) parts.push(`- ${step.id}: ${step.text}`)
    }
    if (repoIntel?.matches?.length) parts.push(`SEMANTIC REPO INTELLIGENCE: ${repoIntel.matches.slice(0, 4).map(x => x.path).join(", ")}`)
    if (failureIntel?.diagnosis?.failed) parts.push(`FAILURE INTELLIGENCE: ${failureIntel.diagnosis.code} — ${failureIntel.strategy?.summary || failureIntel.diagnosis.evidence}`)
    if (lastJoint) {
      const line = formatJointRoute(lastJoint)
      if (line) parts.push(line)
    }
    if (lastAcquire) {
      const bit = lastAcquire.skipped
        ? `skipped ${lastAcquire.skipped}`
        : `${lastAcquire.ok ? "ok" : "miss"} ${lastAcquire.hits ?? 0} hits via ${lastAcquire.tool}`
      parts.push(`ACQUIRE (ran, not a prompt): ${lastAcquire.tool} ${lastAcquire.query || ""} — ${bit}`)
    }
    try {
      const health = formatCapLearn(loadCapLearn(cwd), { klass, limit: 4 })
      if (health) parts.push(health)
    } catch { /* health is context */ }
    // v119: what this project measured about its own completion blockers —
    // beside the other learned policies, not in a surface of its own.
    try {
      const completion = formatCompletionPolicy(cwd, klass)
      if (completion) parts.push(completion)
    } catch { /* policy is context */ }
    if (ranked.length) {
      parts.push("STRATEGIES (ranked by expected value — reversible and cheap first):")
      for (const s of ranked.slice(0, 4)) parts.push(`- ${s.id} ev=${s.expectedValue} rev=${s.reversible} ${s.text}`)
    }
    if (openPred) parts.push(`PREDICTION (unsettled): ${formatPrediction(openPred)}`)
    if (lastDrift) parts.push(`LAST DRIFT: ${lastDrift.level}${lastDrift.driftScore != null ? ` ${lastDrift.driftScore.toFixed(2)}` : ""} — ${lastDrift.why}`)
    try { parts.push(alpha.prompt()) } catch { /* advisory context */ }
    try {
      const cal = predictionsForPrompt(cwd)
      if (cal) parts.push(cal)
    } catch { /* calibration is context, never a gate */ }
    const snap = kernel.snapshot?.()
    const hypos = snap?.hypotheses?.filter((h) => h.status === "OPEN" || h.status === "SUPPORTED") || []
    if (hypos.length) {
      parts.push("FAILURE HYPOTHESES (what would change my mind is a discriminating test, not another identical retry):")
      for (const h of hypos.slice(0, 5)) parts.push(`- ${h.id} [${h.status} ${h.confidence}] ${h.description}`)
    }
    parts.push("INVARIANTS: reality > belief; evidence > confidence; verification > claim; current explicit intent > stale preference; no silent goal substitution; no unsupported completion.")
    return parts.filter(Boolean).join("\n\n")
  }

  function persist() {
    try {
      if (repoIntel || adaptive || failureIntel) saveExpansionSnapshot(cwd, { objective, repo: repoIntel, adaptivePlan: adaptive, failure: failureIntel })
      const file = cognitionPath(cwd)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify({ ...snapshot(), objective, savedAt: Date.now() }, null, 1), "utf8")
      fs.renameSync(tmp, file)
      emit("CHECKPOINT_CREATED", { file })
      return file
    } catch {
      return null
    }
  }

  return {
    kernel, user, contract, self, cognitiveState, evidenceGraph, learningLoop, verificationEvidence, goalContract,
    boot, absorbInstruction, next, enforce, stepDirective, noteInspect, notePlan, noteStrategies, updateHorizon,
    predict, settle, observeCommand, observeTools, acquirePlan, observeAcquire,
    learnFeedback, close, snapshot, brief, promptBlock, persist, emit,
    get events() { return events.slice() },
    get klass() { return klass },
    get lastAction() { return lastAction },
    get lastAuth() { return lastAuth },
    get lastDrift() { return lastDrift },
    get lastSettled() { return lastSettled },
    get openPrediction() { return openPred },
    get lastExperiment() { return lastExperiment },
    get lastAcquire() { return lastAcquire },
    get lastMeta() { return lastMeta },
    get lastJoint() { return lastJoint },
    get repoIntel() { return repoIntel },
    get adaptivePlan() { return adaptive },
    get failureIntelligence() { return failureIntel },
    get horizonIntelligence() { return horizonIntel },
    /** v122: was the governor's veto armed for this run? (advisory = false) */
    get governorEnforce() { return governorEnforce !== false },
  }
}

export function loadCognition(cwd, { governorEnforce = true } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(cognitionPath(cwd), "utf8"))
    return createCognition({ cwd, objective: j.objective || j.contract?.originalIntent || "", resume: j, governorEnforce })
  } catch {
    return null
  }
}
