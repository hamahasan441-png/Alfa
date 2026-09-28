/**
 * forge — plan persistence (v20.2, P1-9).
 *
 * `forge agent --plan "task"` produces a read-only implementation plan and then
 * used to print it and throw it away. Plans are now saved under the project's
 * `.forge/plans/<slug>.md`, so the natural autonomous next step —
 * "read the plan back and execute it" — is possible:
 *
 *   forge agent --plan "add retry to the fetch layer"   # writes .forge/plans/…
 *   forge plan list
 *   forge plan show 1
 *   forge plan apply 1                                   # runs the agent on it
 *
 * Zero dependencies; best-effort (a plan write must never break the agent run).
 */
import fs from "node:fs"
import crypto from "node:crypto"
import { writeStateFile } from "./securefs.js"
import path from "node:path"
import { parsePlanToDAG } from "./dag.js"

export function plansDir(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), ".forge", "plans")
}

/** Filesystem-safe, readable slug for a task string. */
export function slugify(task) {
  const s = String(task ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "")
  return s || "plan"
}

/** Save a plan for `task`. Returns { ok, file, slug } (best-effort). */
export function savePlan(task, text, cwd = process.cwd()) {
  try {
    const dir = plansDir(cwd)
    fs.mkdirSync(dir, { recursive: true })
    const slug = slugify(task)
    const file = path.join(dir, slug + ".md")
    const header = `# Plan: ${String(task ?? "").trim()}\n\n_generated ${new Date().toISOString()}_\n\n`
    writeStateFile(file, header + String(text ?? "").trim() + "\n", { mode: 0o644 }) // plans are user-readable documents
    return { ok: true, file, slug }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** List saved plans, newest first: [{ slug, file, mtime, title }]. */
export function listPlans(cwd = process.cwd()) {
  const dir = plansDir(cwd)
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")) } catch { return [] }
  const out = []
  for (const n of names) {
    const file = path.join(dir, n)
    let mtime = 0, title = ""
    try {
      mtime = fs.statSync(file).mtimeMs
      const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] || ""
      title = first.replace(/^#\s*(Plan:\s*)?/i, "").trim()
    } catch {}
    out.push({ slug: n.replace(/\.md$/, ""), file, mtime, title })
  }
  // Newest first. mtime alone is NOT a total order: two plans written within
  // the same filesystem timestamp tick tie, and the resulting order would be
  // whatever readdir happened to yield. Tie-break on slug so `plan list`,
  // `plan show 1` and `plan apply` are deterministic on every filesystem.
  return out.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug))
}

/**
 * Resolve a plan by 1-based index (as shown by listPlans) or by slug.
 * Returns { ok, file, slug, text } or { ok:false, error }.
 */
export function readPlan(ref, cwd = process.cwd()) {
  const plans = listPlans(cwd)
  if (!plans.length) return { ok: false, error: "no saved plans (run: forge agent --plan \"task\")" }
  const r = String(ref ?? "").trim()
  let hit = null
  const n = Number(r)
  if (r && Number.isInteger(n) && n >= 1 && n <= plans.length) hit = plans[n - 1]
  else hit = plans.find((p) => p.slug === r) || (r ? null : plans[0])
  if (!hit) return { ok: false, error: `no plan "${r}" — use forge plan list` }
  try {
    return { ok: true, file: hit.file, slug: hit.slug, text: fs.readFileSync(hit.file, "utf8") }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}


// ---------------------------------------------------------------------------
// V5 — THE PLAN IS A CHECKLIST THE RUNTIME KEEPS, NOT TEXT THE MODEL READS.
//
// A plan used to be only the markdown above: the run was handed it as text
// and told to follow it, and nothing knew which step was done. Now every plan
// also has a state record, `.forge/plan-state/<slug>.json`, with:
//
//   - a stable identity (planId = slug + a hash of the plan body), so a
//     restart finds THE SAME plan and a revised plan is a new one;
//   - a lifecycle: DRAFT (it exists) → APPROVED (the person said yes) →
//     EXECUTING (a run is carrying it out) → COMPLETED | INCOMPLETE;
//   - one entry per step, parsed by the ONE plan parser (dag.parsePlanToDAG —
//     the same one the task controller builds its DAG from), each with a
//     state, dependencies, and the evidence the RUNTIME recorded for it.
//
// A step's state is changed only through applyStepUpdate() (driven by the
// run's `todo` tool calls, with the runtime's own evidence attached) or
// syncFromDag() (driven by the task controller's verified DAG node states).
// The model saying "I completed the plan" changes nothing here.
// ---------------------------------------------------------------------------

export const PLAN_LIFECYCLE = Object.freeze({
  DRAFT: "DRAFT",
  APPROVED: "APPROVED",
  EXECUTING: "EXECUTING",
  COMPLETED: "COMPLETED",
  INCOMPLETE: "INCOMPLETE",
})

export const STEP_STATE = Object.freeze({
  PENDING: "PENDING",
  READY: "READY",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  SKIPPED_WITH_REASON: "SKIPPED_WITH_REASON",
})

const RESOLVED = new Set([STEP_STATE.COMPLETED, STEP_STATE.SKIPPED_WITH_REASON])

/** The `todo` tool's statuses, as plan step states. */
export const TODO_STEP_STATE = Object.freeze({
  todo: STEP_STATE.PENDING,
  doing: STEP_STATE.RUNNING,
  done: STEP_STATE.COMPLETED,
  skipped: STEP_STATE.SKIPPED_WITH_REASON,
  blocked: STEP_STATE.BLOCKED,
  failed: STEP_STATE.FAILED,
})

// Kept NEXT TO the plans directory, not in it: `.forge/plans/` holds the plan
// documents a person reads (and `forge plan apply` resolves), one file each.
export function planStateDir(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), ".forge", "plan-state")
}

export function planStatePath(slug, cwd = process.cwd()) {
  return path.join(planStateDir(cwd), `${slug}.json`)
}

/** The run-local todo file a plan run's `todo` tool reads and writes. */
export function planTodoPath(slug, cwd = process.cwd()) {
  return path.join(planStateDir(cwd), `${slug}.todo.json`)
}

/**
 * The plan itself, out of a saved plan document: after the "THE PLAN THE USER
 * APPROVED" marker when there is one (a chat plan is saved with its objective
 * and settled facts above it), and before a "Questions for you" section or an
 * END OF PLAN line (a question is not a step).
 */
export function planBody(text) {
  let t = String(text ?? "")
  const marker = /THE PLAN THE USER APPROVED[^\n]*\n/i.exec(t)
  if (marker) t = t.slice(marker.index + marker[0].length)
  const lines = t.split("\n")
  const stop = lines.findIndex((l) => /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*questions?\s+for\s+(?:you|the\s+user)\b/i.test(l) || /^\s*END OF PLAN/i.test(l))
  return (stop >= 0 ? lines.slice(0, stop) : lines).join("\n").trim()
}

/** Steps of a plan, from the ONE plan parser. Never throws; [] when nothing parses. */
export function checklistFromPlan(text) {
  let defs = []
  try { defs = parsePlanToDAG(planBody(text)) } catch { defs = [] }
  // the parser may add an integrator node for parallel plans; a checklist
  // keeps only the steps the plan itself wrote down
  const own = defs.filter((d) => d && d.role !== "integrator" && String(d.objective ?? "").trim())
  const ids = new Map(own.map((d, i) => [String(d.id), `s${i + 1}`]))
  return own.slice(0, 40).map((d, i) => ({
    id: `s${i + 1}`,
    node: String(d.id),
    goal: String(d.objective).slice(0, 300),
    deps: (d.dependencies ?? []).map((x) => ids.get(String(x))).filter(Boolean),
    state: STEP_STATE.PENDING,
    evidence: null,
    reason: null,
    completedAt: null,
  }))
}

function planIdOf(slug, text) {
  return `${slug}:${crypto.createHash("sha256").update(planBody(text)).digest("hex").slice(0, 12)}`
}

export function loadPlanState(slug, cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(planStatePath(slug, cwd), "utf8"))
    return j && Array.isArray(j.steps) ? j : null
  } catch { return null }
}

export function savePlanState(state, cwd = process.cwd()) {
  try {
    fs.mkdirSync(planStateDir(cwd), { recursive: true })
    writeStateFile(planStatePath(state.slug, cwd), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1), { mode: 0o644 })
    return true
  } catch { return false }
}

/**
 * Record a plan's durable state. Idempotent: the same plan body keeps its
 * planId and its step progress; a changed body is a REVISION — a new planId,
 * fresh steps, and the old id kept in `revisedFrom`.
 */
export function recordPlan({ slug, objective = "", text = "", status = PLAN_LIFECYCLE.DRAFT, cwd = process.cwd() } = {}) {
  if (!slug) return null
  const planId = planIdOf(slug, text)
  const prev = loadPlanState(slug, cwd)
  if (prev && prev.planId === planId) {
    if (status === PLAN_LIFECYCLE.APPROVED && prev.status === PLAN_LIFECYCLE.DRAFT) {
      prev.status = PLAN_LIFECYCLE.APPROVED
      prev.approvedAt = new Date().toISOString()
      savePlanState(prev, cwd)
    }
    return prev
  }
  const now = new Date().toISOString()
  const state = {
    version: 1, planId, slug,
    objective: String(objective).slice(0, 2000),
    status,
    createdAt: now,
    approvedAt: status === PLAN_LIFECYCLE.APPROVED ? now : null,
    revisedFrom: prev?.planId ?? null,
    steps: readySteps(checklistFromPlan(text)),
    deviations: [],
    runs: [],
  }
  savePlanState(state, cwd)
  return state
}

/** PENDING steps whose dependencies are all resolved become READY. */
export function readySteps(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]))
  for (const s of steps) {
    if (s.state !== STEP_STATE.PENDING) continue
    if ((s.deps ?? []).every((d) => RESOLVED.has(byId.get(d)?.state))) s.state = STEP_STATE.READY
  }
  return steps
}

export function planProgress(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : []
  const count = (st) => steps.filter((s) => s.state === st).length
  const open = steps.filter((s) => !RESOLVED.has(s.state))
  return {
    total: steps.length,
    completed: count(STEP_STATE.COMPLETED),
    skipped: count(STEP_STATE.SKIPPED_WITH_REASON),
    failed: count(STEP_STATE.FAILED),
    blocked: count(STEP_STATE.BLOCKED),
    running: count(STEP_STATE.RUNNING),
    open: open.map((s) => ({ id: s.id, goal: s.goal, state: s.state })),
    // a completed step the runtime saw no tool activity for: resolved, but
    // resting on the model's word alone — reported, never hidden
    unevidenced: steps.filter((s) => s.state === STEP_STATE.COMPLETED && s.evidence && s.evidence.observed === false).map((s) => s.id),
    done: steps.length > 0 && open.length === 0,
  }
}

/**
 * Change one step, the only way a run changes one. SKIPPED needs a reason and
 * is recorded as a deviation from the approved plan; BLOCKED and FAILED keep
 * their reason; COMPLETED carries the evidence the runtime observed.
 */
export function applyStepUpdate(state, stepId, { to, reason = null, evidence = null, at = new Date().toISOString() } = {}) {
  const step = (state?.steps ?? []).find((s) => s.id === stepId)
  if (!step) return { ok: false, error: `no plan step ${stepId}` }
  if (!Object.values(STEP_STATE).includes(to)) return { ok: false, error: `unknown step state ${to}` }
  const why = String(reason ?? "").trim()
  if (to === STEP_STATE.SKIPPED_WITH_REASON && !why) return { ok: false, error: "a step may be skipped only with a reason — the approved plan said to do it" }
  if (step.state === to && to !== STEP_STATE.COMPLETED) return { ok: true, step, changed: false }
  const from = step.state
  step.state = to
  step.reason = why || (to === STEP_STATE.COMPLETED ? null : step.reason)
  if (to === STEP_STATE.COMPLETED) { step.completedAt = at; step.evidence = evidence ?? step.evidence ?? null }
  if (to === STEP_STATE.SKIPPED_WITH_REASON) {
    state.deviations = Array.isArray(state.deviations) ? state.deviations : []
    state.deviations.push({ step: step.id, goal: step.goal, from, reason: why.slice(0, 500), at })
  }
  readySteps(state.steps)
  return { ok: true, step, changed: from !== to }
}

/** DAG node status (the task controller's, verified) → plan step state. */
const DAG_STEP_STATE = {
  pending: STEP_STATE.PENDING, ready: STEP_STATE.READY, running: STEP_STATE.RUNNING,
  execution_succeeded: STEP_STATE.RUNNING, verifying: STEP_STATE.RUNNING, repairing: STEP_STATE.RUNNING,
  completed: STEP_STATE.COMPLETED, failed: STEP_STATE.FAILED, blocked: STEP_STATE.BLOCKED,
  cancelled: STEP_STATE.BLOCKED, invalidated: STEP_STATE.PENDING,
}

/**
 * The task controller carried the plan out as its DAG (node ids = the plan's
 * own step ids): copy each node's VERIFIED state onto its step. A node the
 * controller completed carries its verification as the step's evidence.
 */
export function syncFromDag(state, dag, { taskId = null } = {}) {
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : []
  const byNode = new Map(nodes.filter(Boolean).map((n) => [String(n.id), n]))
  let changed = 0
  for (const step of state?.steps ?? []) {
    const n = byNode.get(step.node)
    if (!n) continue
    const to = DAG_STEP_STATE[String(n.status ?? "").toLowerCase()]
    if (!to || to === step.state) continue
    step.state = to
    if (to === STEP_STATE.COMPLETED) {
      step.completedAt = new Date().toISOString()
      step.evidence = { source: "task-controller", taskId, node: step.node, verified: true, observed: true }
    } else if (to === STEP_STATE.FAILED || to === STEP_STATE.BLOCKED) {
      step.reason = String(n.error ?? n.reason ?? n.lastError ?? "").slice(0, 300) || null
    }
    changed++
  }
  readySteps(state?.steps ?? [])
  return changed
}

/** Close a plan run: COMPLETED only when the run finished AND every step resolved. */
export function finishPlanRun(state, { runId = null, taskId = null, status = "" } = {}) {
  const prog = planProgress(state)
  const finished = /^COMPLETED/.test(String(status))
  state.status = finished && prog.done ? PLAN_LIFECYCLE.COMPLETED : PLAN_LIFECYCLE.INCOMPLETE
  state.runs = Array.isArray(state.runs) ? state.runs : []
  state.runs.push({ runId, taskId, status: String(status || "UNKNOWN"), at: new Date().toISOString(), open: prog.open.length })
  if (state.runs.length > 20) state.runs = state.runs.slice(-20)
  if (state.status === PLAN_LIFECYCLE.COMPLETED) state.finishedAt = new Date().toISOString()
  return state
}

/**
 * The newest plan in this project that is approved but not finished — what
 * `/plan go` starts after a restart, instead of asking for a fresh `/plan`.
 */
export function resumablePlan(cwd = process.cwd()) {
  for (const p of listPlans(cwd)) {
    const st = loadPlanState(p.slug, cwd)
    if (st && [PLAN_LIFECYCLE.APPROVED, PLAN_LIFECYCLE.EXECUTING, PLAN_LIFECYCLE.INCOMPLETE].includes(st.status)) {
      return { slug: p.slug, file: p.file, state: st }
    }
  }
  return null
}

/** What a plan run is told about its checklist, and how the runtime tracks it. */
export function checklistBrief(state) {
  const steps = state?.steps ?? []
  if (!steps.length) return ""
  const mark = { COMPLETED: "[x]", SKIPPED_WITH_REASON: "[-]", RUNNING: "[~]", FAILED: "[!]", BLOCKED: "[!]" }
  return [
    "PLAN CHECKLIST (tracked by forge — the todo tool holds it; item N is step N):",
    ...steps.map((s, i) => `  ${mark[s.state] || "[ ]"} ${i + 1}. ${s.goal}${s.state !== STEP_STATE.PENDING && s.state !== STEP_STATE.READY ? ` — ${s.state}` : ""}`),
    "Mark each step as you work: todo update id=N status=doing when you start it, status=done when it is finished. A step you decide not to do: status=skipped with a reason; one you cannot do: status=blocked with a reason. The run is not complete while any step is open, and a step is recorded with what forge saw happen while it was being worked on.",
  ].join("\n")
}

/** Seed a plan run's todo list from the plan's steps (locked: steps are updated, never replaced). */
export function seedPlanTodo(state, todoPath) {
  const toTodo = { COMPLETED: "done", RUNNING: "doing", SKIPPED_WITH_REASON: "skipped", BLOCKED: "blocked", FAILED: "blocked" }
  const items = (state?.steps ?? []).map((x, i) => ({ id: i + 1, stepId: x.id, content: x.goal, status: toTodo[x.state] ?? "todo", reason: x.reason ?? null }))
  fs.mkdirSync(path.dirname(todoPath), { recursive: true })
  writeStateFile(todoPath, JSON.stringify({ locked: true, plan: state.planId, items }, null, 1), { mode: 0o644 })
  return items.length
}

/** The plan run's todo list as the todo tool left it; null when unreadable. */
export function readPlanTodo(todoPath) {
  try { const j = JSON.parse(fs.readFileSync(todoPath, "utf8")); return j && Array.isArray(j.items) ? j : null } catch { return null }
}
