/**
 * forge — adversarial review (∞, zero dependencies)
 *
 * LARGE and ARCHITECTURAL work gets a checklist before COMPLETED. This is
 * not another model call — call-count tests stay stable and a second agent
 * cannot "review" by agreeing with itself. The checklist is deterministic
 * and emits REVIEW_STARTED / REVIEW_COMPLETED for the HUD.
 *
 * Findings are warnings. Blockers refuse completion (via required actions).
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { TASK_CLASS } from "./classify.js"
import { TAG } from "./taskmodel.js"

export const REVIEW_CHECK = {
  OBJECTIVE_COVERED: "objective_covered",
  BLAST_RADIUS: "blast_radius",
  TESTS_MATCH_IMPACT: "tests_match_impact",
  NO_ASSUMPTION_AS_REQUIREMENT: "no_assumption_as_requirement",
  SECRETS_UNTOUCHED: "secrets_untouched",
  VERIFICATION_PRESENT: "verification_present",
  UNKNOWN_IMPACT: "unknown_impact",
  ROLLBACK_POSSIBLE: "rollback_possible",
  // v103 §2 — new project files created inside forge's own source tree while
  // the task never said it was about forge.
  WORKSPACE_MATCHES_TASK: "workspace_matches_task",
  // v104 §4 — files written outside the resolved workspace entirely.
  WRITES_STAY_IN_WORKSPACE: "writes_stay_in_workspace",
}

const SECRET_HINT = /(?:^|[\\/])(\.env(?:\..+)?|credentials|\.pem|\.p12|id_rsa|id_ed25519|\.netrc|\.npmrc)$/i

export function needsReview(klass) {
  return klass === TASK_CLASS.LARGE || klass === TASK_CLASS.ARCHITECTURAL
}

/**
 * @param {{
 *   klass, objective, files, impact, taskModel, hypotheses, causal,
 *   verificationOk, checkpoint
 * }} input
 * @returns {{ required, ok, findings, blockers, checks }}
 */
export function adversarialReview(input = {}) {
  const klass = input.klass
  if (!needsReview(klass)) {
    return { required: false, ok: true, findings: [], blockers: [], checks: [], klass: klass || null }
  }

  const findings = []
  const blockers = []
  const checks = []
  const note = (id, { ok, blocker = false, detail = "" }) => {
    checks.push({ id, ok, blocker, detail: String(detail).slice(0, 240) })
    if (ok) return
    const rec = { id, detail: String(detail).slice(0, 240) }
    if (blocker) blockers.push(rec)
    else findings.push(rec)
  }

  const files = (input.files || []).map(String)
  const impact = input.impact || {}
  const objective = String(input.objective ?? "")
  const snapshot = typeof input.taskModel?.snapshot === "function" ? input.taskModel.snapshot() : []

  note(REVIEW_CHECK.OBJECTIVE_COVERED, {
    ok: objective.trim().length > 0,
    detail: objective.trim() ? "objective present" : "empty objective",
  })

  const secretHits = files.filter((f) => SECRET_HINT.test(f) || /(^|[\\/])\.ssh[\\/]/.test(f))
  note(REVIEW_CHECK.SECRETS_UNTOUCHED, {
    ok: secretHits.length === 0,
    blocker: secretHits.length > 0,
    detail: secretHits.length ? `secret-bearing path touched: ${secretHits.slice(0, 3).join(", ")}` : "no secret paths in the change set",
  })

  const assumptions = snapshot.filter((i) => i.tag === TAG.ASSUMPTION)
  const smuggled = assumptions.filter((i) => /must|required|acceptance|shall/i.test(i.text))
  note(REVIEW_CHECK.NO_ASSUMPTION_AS_REQUIREMENT, {
    ok: smuggled.length === 0,
    blocker: smuggled.length > 0,
    // "nothing to inspect" is not the same as "inspected and clean" — a path
    // with no task model (every direct run) must not read as a passed check.
    detail: smuggled.length
      ? `assumption spoken as a requirement: ${smuggled[0].text}`
      : input.taskModel
        ? "no assumption promoted to a requirement"
        : "not inspected — no task model on this path",
  })

  const radius = Number(impact.radius) || files.length
  const tests = Array.isArray(impact.tests) ? impact.tests : []
  const scope = Array.isArray(impact.scope) ? impact.scope : []
  const wide = radius >= 8 || (impact.importers || []).length >= 8
  note(REVIEW_CHECK.BLAST_RADIUS, {
    ok: true,
    detail: `radius=${radius} importers=${(impact.importers || []).length} tests=${tests.length}`,
  })
  if (wide && !scope.includes("regression_test") && !scope.includes("integration")) {
    note(REVIEW_CHECK.TESTS_MATCH_IMPACT, {
      ok: false,
      detail: "wide blast radius without regression/integration in the testing scope",
    })
  } else {
    note(REVIEW_CHECK.TESTS_MATCH_IMPACT, {
      ok: true,
      detail: scope.length ? scope.join(" → ") : "scope not yet measured",
    })
  }

  if (klass === TASK_CLASS.ARCHITECTURAL && tests.length === 0 && files.length > 0) {
    note(REVIEW_CHECK.VERIFICATION_PRESENT, {
      ok: false,
      detail: "architectural change with no discovered tests in the impact radius",
    })
  } else {
    note(REVIEW_CHECK.VERIFICATION_PRESENT, {
      ok: input.verificationOk !== false,
      detail: input.verificationOk === false ? "verification not satisfied" : "verification flag accepted",
    })
  }

  note(REVIEW_CHECK.UNKNOWN_IMPACT, {
    ok: impact.unknown !== true,
    detail: impact.unknown ? "impact walk was UNKNOWN — do not treat 'no dependents' as proof" : "impact walk completed",
  })

  // The workspace check is only asked when the caller resolved a workspace; a
  // review with no workspace evidence says so rather than passing silently.
  const ws = input.workspace ?? null
  const created = (input.created ?? []).map(String)
  if (ws) {
    const strayed = ws.conflict ? created : []
    note(REVIEW_CHECK.WORKSPACE_MATCHES_TASK, {
      ok: strayed.length === 0,
      blocker: strayed.length > 0,
      detail: strayed.length
        ? `created ${strayed.length} new file(s) inside forge's own source tree for a task that never named forge: ${strayed.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}`
        : ws.conflict
          ? "working directory is forge's own tree, but nothing new was created there"
          : `target workspace ${ws.targetWorkspace} (${ws.resolutionSource})`,
    })
  }

  const outside = (input.outside ?? []).map(String)
  if (ws) {
    note(REVIEW_CHECK.WRITES_STAY_IN_WORKSPACE, {
      ok: outside.length === 0,
      blocker: outside.length > 0,
      detail: outside.length
        ? `${outside.length} file(s) written outside the workspace (${ws.targetWorkspace}): ${outside.slice(0, 3).join(", ")}`
        : "every write landed inside the workspace",
    })
  }

  note(REVIEW_CHECK.ROLLBACK_POSSIBLE, {
    ok: true,
    detail: input.checkpoint ? `checkpoint ${String(input.checkpoint).slice(0, 40)}` : "no checkpoint recorded (advisory)",
  })

  return {
    required: true,
    ok: blockers.length === 0,
    findings,
    blockers,
    checks,
    klass,
  }
}

export function formatReview(rev) {
  if (!rev || !rev.required) return ""
  const bits = [`[forge] review=${rev.ok ? "ok" : "block"} class=${rev.klass}`]
  if (rev.blockers?.length) bits.push(`blockers: ${rev.blockers.map((b) => b.id).join(", ")}`)
  if (rev.findings?.length) bits.push(`findings: ${rev.findings.map((f) => f.id).join(", ")}`)
  return bits.join(" • ")
}

// ---------------------------------------------------------------------------
// v102 — the same review, for a run that has no meta controller
// ---------------------------------------------------------------------------
//
// adversarialReview has only ever been reachable through the Ω kernel, which
// only meta.js builds. `forge agent "..."`, interactive Agent Mode, every
// sub-agent and every DAG node run through agent.js instead, and none of them
// has ever been reviewed — although every input the review needs is already
// computed there and thrown away at run end: toolintel records each mutation's
// files_changed and its predicted blast radius (radius, importers, tests,
// unknown), and the run knows its own class, verification state and checkpoint.
//
// This folds those records into the review's input shape. It computes nothing
// new and calls no model.

/** Widths at which an observed change set earns a review its task text did not. */
export const ESCALATE_FILES = 5
export const ESCALATE_RADIUS = 8

/** Fold this run's tool records into { files, impact }. */
export function changeSetOf(records = []) {
  const files = []
  const importers = new Set()
  const tests = new Set()
  let radius = 0
  let unknown = false
  let scope = null
  for (const r of Array.isArray(records) ? records : []) {
    for (const f of r?.files_changed ?? []) if (f && !files.includes(f)) files.push(f)
    const b = r?.blast
    if (!b) continue
    radius = Math.max(radius, Number(b.radius) || 0)
    if (b.unknown === true) unknown = true
    if (b.scope) scope = b.scope
    for (const i of b.importers ?? []) importers.add(i)
    for (const t of b.tests ?? []) tests.add(t)
  }
  return {
    files,
    impact: { radius, importers: [...importers], tests: [...tests], unknown, scope: scope ? [scope] : [] },
  }
}

/**
 * Review a finished direct run.
 *
 * The task TEXT decides the class, but the CHANGE SET is observed — so a run
 * classified MEDIUM that ended up rewriting nine files is reviewed anyway, and
 * says so. That is strictly more evidence than meta's text-only gate has.
 *
 * @returns the adversarialReview result plus { escalated, escalatedFrom, files, impact }
 */
export function reviewRun({ klass = null, objective = "", records = [], verificationOk = null, checkpoint = null, escalate = true, workspace = null, created = [], outside = [] } = {}) {
  const { files, impact } = changeSetOf(records)
  const wide = files.length >= ESCALATE_FILES || impact.radius >= ESCALATE_RADIUS
  // v103 §2: writing a NEW file into forge's own tree for a task that never
  // named forge is reviewable on its own, whatever the task was called — the
  // reproduction was a single write_file that classified as a small task.
  const strayed = Boolean(workspace?.conflict) && created.length > 0
  const escalated = escalate && !needsReview(klass) && (wide || strayed || outside.length > 0)
  const effective = escalated ? TASK_CLASS.LARGE : klass
  const rev = adversarialReview({ klass: effective, objective, files, impact, verificationOk, checkpoint, workspace, created, outside })
  return { ...rev, escalated, escalatedFrom: escalated ? (klass ?? null) : null, files, impact }
}

// ---------------------------------------------------------------------------
// v204 — ONE REVIEW CONTRACT
// ---------------------------------------------------------------------------
//
// Forge has several reviewers and they spoke in four shapes: this module's
// checklist ({ blockers, findings }), codereview.js ({ severity, file, line,
// lineVerified }), selfreview.js ({ confidence, flags }) and critique.js
// (a per-tool-call verdict — a tool policy, not a review of finished work,
// so it is not part of this contract). Nothing said which findings were SEEN
// and which were a model's claim, and the meta path let a reviewer model's
// unverified "blocker" block exactly like a secret found in the diff.
//
// Every reviewer's output is normalized here into one finding shape with a
// BASIS, and one decision reads it:
//
//   OBSERVED     read from the change itself: a deterministic check over the
//                diff, the LSP diagnostics, the ledger, the paths — or a
//                reviewer model's finding whose line the diff really added
//   INFERRED     a model's claim nothing checked (no line, or a line the
//                diff never added), and a worker's self-review
//   RECOMMENDED  advice with no claim that something is wrong
//
// Only an OBSERVED blocker whose file has not changed since it was reviewed
// can block. A reviewer can add a blocker only by observing it, and can never
// clear failing evidence: the evidence ledger is its own gate.

export const REVIEW_BASIS = Object.freeze({ OBSERVED: "OBSERVED", INFERRED: "INFERRED", RECOMMENDED: "RECOMMENDED" })

const SEVERITIES = new Set(["blocker", "major", "minor"])

/** The one rule: only an OBSERVED blocker can block. */
const canBlock = (f) => f?.basis === REVIEW_BASIS.OBSERVED && f?.severity === "blocker"

/** Content hash of a reviewed file — what "stale" is measured against. null when unreadable. */
export function reviewedFileHash(file, cwd = process.cwd()) {
  if (!file || String(file).startsWith("(")) return null
  try { return createHash("sha1").update(fs.readFileSync(path.resolve(cwd, String(file)))).digest("hex").slice(0, 16) }
  catch { return null }
}

/**
 * Normalize one reviewer's output into canonical findings:
 *   { source, basis, severity, id, file, line, detail, fixHint, blocking, fileHash }
 *
 * source "checklist"   an adversarialReview()/reviewRun() result
 *        "codereview"  runCodeReview()'s merged, line-verified findings
 *        "selfreview"  a reviewWorkerResult() result
 */
export function normalizeFindings(source, raw, { cwd = process.cwd() } = {}) {
  const out = []
  const push = (f) => {
    const severity = SEVERITIES.has(f.severity) ? f.severity : "major"
    const file = f.file ? String(f.file).slice(0, 200) : null
    out.push({
      source, basis: f.basis, severity,
      id: String(f.id ?? "finding").slice(0, 60),
      file, line: Number.isFinite(f.line) && f.line > 0 ? f.line : null,
      detail: String(f.detail ?? "").slice(0, 300),
      fixHint: f.fixHint ? String(f.fixHint).slice(0, 240) : null,
      blocking: canBlock({ basis: f.basis, severity }),
      fileHash: file ? reviewedFileHash(file, cwd) : null,
    })
  }
  if (source === "checklist") {
    for (const b of raw?.blockers ?? []) push({ basis: REVIEW_BASIS.OBSERVED, severity: "blocker", id: b.id, detail: b.detail })
    for (const f of raw?.findings ?? []) push({ basis: REVIEW_BASIS.OBSERVED, severity: "major", id: f.id, detail: f.detail })
  } else if (source === "codereview") {
    for (const f of Array.isArray(raw) ? raw : []) {
      // a reviewer MODEL's finding is a claim; its line, checked against the
      // lines the diff added (verifyFindingLines), is what makes it observed
      const fromModel = f?.source === "reviewer"
      const basis = !fromModel || f.lineVerified === true ? REVIEW_BASIS.OBSERVED : REVIEW_BASIS.INFERRED
      push({ basis, severity: f?.severity, id: f?.id, file: f?.file, line: f?.line, detail: f?.issue ?? f?.detail, fixHint: f?.fix_hint })
    }
  } else if (source === "selfreview") {
    for (const flag of raw?.flags ?? []) push({ basis: REVIEW_BASIS.INFERRED, severity: "minor", id: "self_review", detail: flag })
  }
  return out
}

/**
 * THE review decision. `blocking` is every OBSERVED blocker whose file is
 * unchanged since it was reviewed; a rewritten file makes its findings
 * `stale` (reported, never blocking — the next review looks at the new code).
 */
export function reviewDecision(findings = [], { cwd = process.cwd() } = {}) {
  const all = (Array.isArray(findings) ? findings : []).map((f) => ({
    ...f,
    stale: f.fileHash != null && reviewedFileHash(f.file, cwd) !== f.fileHash,
  }))
  const blocking = all.filter((f) => canBlock(f) && !f.stale)
  const count = (b) => all.filter((f) => f.basis === b).length
  return {
    ok: blocking.length === 0,
    blocking,
    findings: all,
    counts: { observed: count(REVIEW_BASIS.OBSERVED), inferred: count(REVIEW_BASIS.INFERRED), recommended: count(REVIEW_BASIS.RECOMMENDED), stale: all.filter((f) => f.stale).length },
  }
}

/** The decision, trimmed for a result record (the run result, --result-json). */
export function reviewSummary(decision, { required = true, enforced = false } = {}) {
  if (!decision) return null
  return {
    required, enforced, ok: decision.ok,
    blocking: decision.blocking.map((f) => f.id),
    counts: decision.counts,
    findings: decision.findings.slice(0, 20).map((f) => ({ source: f.source, basis: f.basis, severity: f.severity, id: f.id, file: f.file, line: f.line, stale: f.stale === true })),
  }
}
