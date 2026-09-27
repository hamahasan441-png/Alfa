/**
 * forge — prompt budget + stable/volatile split (v137.promptbudget)
 *
 * Zero dependencies. The system prompt used to concatenate every block that
 * had something to say (~9.4k chars on this tree, repo map ~4k of it) and
 * then cache the WHOLE thing. Most of that is task-derived, so the Anthropic
 * cache key changed every task and cross-run reuse was zero.
 *
 * This module is the single source of truth for:
 *   1. a char budget per task class
 *   2. a value order (always > prefer > droppable; rank desc within)
 *   3. the stable/volatile split the provider cache breakpoint consumes
 *
 * The split is produced HERE, from the same TOOLS marker `disciplines.js`
 * `stablePrefix` uses. `providers.js` must not search for that marker —
 * it only consumes `opts.systemStable` / `opts.systemVolatile`.
 *
 * If always-blocks alone exceed the budget, they are still included.
 * Always-blocks are never dropped.
 */

export const STABLE_MARKER = "TOOLS — all available"

const LANE = { STABLE: "stable", VOLATILE: "volatile" }
const KEEP = { ALWAYS: "always", PREFER: "prefer", DROPPABLE: "droppable" }

const CHAR_BUDGET = {
  MICRO: 3600,
  SMALL: 5200,
  MEDIUM: 6800,
  LARGE: 8600,
  ARCHITECTURAL: 11000,
  RECOVERY: 6800,
}
const DEFAULT_BUDGET = 6800

/**
 * Character budget for a task class.
 *
 * MICRO 3600, SMALL 5200, MEDIUM 6800, LARGE 8600, ARCHITECTURAL 11000,
 * RECOVERY 6800; anything else (including null/undefined) → 6800.
 *
 * @param {string | null | undefined} klass
 * @returns {number}
 */
export function charBudgetFor(klass) {
  const k = String(klass ?? "").toUpperCase()
  return CHAR_BUDGET[k] ?? DEFAULT_BUDGET
}

function laneOf(b) {
  return b?.lane === LANE.STABLE ? LANE.STABLE : LANE.VOLATILE
}

function keepOf(b) {
  return b?.keep === KEEP.ALWAYS || b?.keep === KEEP.PREFER ? b.keep : KEEP.DROPPABLE
}

function joinFull(list) {
  const stable = list.filter((b) => laneOf(b) === LANE.STABLE).map((b) => b.text).join("\n\n")
  const volatile = list.filter((b) => laneOf(b) === LANE.VOLATILE).map((b) => b.text).join("\n\n")
  return stable + (volatile ? "\n\n" + volatile : "")
}

/**
 * Assemble a system prompt under a character budget.
 *
 * `blocks` is `{id, lane, keep, rank, text}`:
 *   - lane: `"stable"` | `"volatile"`
 *   - keep: `"always"` | `"prefer"` | `"droppable"`
 *   - rank: higher = more valuable
 *
 * Algorithm:
 *   1. Skip empty text.
 *   2. Always include keep==="always" (stable first, then volatile,
 *      original order within lane). If always-blocks alone exceed the
 *      budget they are still included — never drop always.
 *   3. Then include keep==="prefer" by rank desc then original order,
 *      while the assembled length (texts + `"\\n\\n"` separators) <= budget.
 *   4. Then include keep==="droppable" the same way.
 *
 * Output:
 *   - `stable`  — all included stable blocks joined by `"\\n\\n"`
 *   - `volatile` — all included volatile blocks joined by `"\\n\\n"`
 *   - `full` = stable + (volatile ? `"\\n\\n"`+volatile : "")
 *   - `dropped` — not included, with `{id, chars, keep, reason}`
 *
 * @param {Array<{id: string, lane: string, keep: string, rank?: number, text?: string}>} blocks
 * @param {{budget?: number, klass?: string|null}} [opts]
 * @returns {{stable: string, volatile: string, full: string, dropped: Array<{id: string, chars: number, keep: string, reason: string}>, chars: number, budget: number, klass: string|null|undefined, included: string[]}}
 */
export function assemblePrompt(blocks, opts = {}) {
  const klass = opts.klass ?? null
  const budget = Number.isFinite(opts.budget) ? Number(opts.budget) : charBudgetFor(klass)
  const raw = Array.isArray(blocks) ? blocks : []
  const items = []
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]
    const text = String(b?.text ?? "")
    if (!text) continue
    items.push({
      id: b.id,
      lane: laneOf(b),
      keep: keepOf(b),
      rank: Number(b.rank) || 0,
      text,
      chars: text.length,
      _i: i,
    })
  }

  const byLaneThenOrig = (a, b) => {
    if (a.lane !== b.lane) return a.lane === LANE.STABLE ? -1 : 1
    return a._i - b._i
  }
  const byRankThenOrig = (a, b) => (b.rank - a.rank) || (a._i - b._i)

  const included = []
  const dropped = []

  // Always-blocks: include all, stable first then volatile, original order
  // within lane. Never dropped, even when they exceed the budget.
  const always = items.filter((b) => b.keep === KEEP.ALWAYS).sort(byLaneThenOrig)
  included.push(...always)

  const consider = (pool) => {
    const sorted = pool.slice().sort(byRankThenOrig)
    for (const b of sorted) {
      const next = [...included, b].sort(byLaneThenOrig)
      if (joinFull(next).length <= budget) included.push(b)
      else dropped.push({ id: b.id, chars: b.chars, keep: b.keep, reason: "over-budget" })
    }
  }

  consider(items.filter((b) => b.keep === KEEP.PREFER))
  consider(items.filter((b) => b.keep === KEEP.DROPPABLE))

  included.sort(byLaneThenOrig)
  const stable = included.filter((b) => b.lane === LANE.STABLE).map((b) => b.text).join("\n\n")
  const volatile = included.filter((b) => b.lane === LANE.VOLATILE).map((b) => b.text).join("\n\n")
  const full = stable + (volatile ? "\n\n" + volatile : "")
  return {
    stable,
    volatile,
    full,
    dropped,
    chars: full.length,
    budget,
    klass,
    included: included.map((b) => b.id),
  }
}

/**
 * Classify a volatile paragraph by matching its heading.
 *
 * @param {string} text
 * @returns {{id: string, keep: "always"|"prefer"|"droppable", rank: number}}
 */
export function classifyVolatileChunk(text) {
  const t = String(text ?? "")
  if (/SKILLS FOR THIS TASK|\bSKILLS\s*\(/.test(t)) return { id: "skills", keep: KEEP.PREFER, rank: 90 }
  if (/TRY FIRST/.test(t)) return { id: "steer-repair", keep: KEEP.PREFER, rank: 95 }
  if (/\[avoid\]|HARD AVOID/.test(t)) return { id: "avoid", keep: KEEP.PREFER, rank: 88 }
  if (/\[verify next\]/.test(t)) return { id: "verify", keep: KEEP.PREFER, rank: 85 }
  if (/USER MEMORY|PROJECT MEMORY|LEARNED FIXES|Relevant memory|\bLearned\b|learnings/i.test(t)) {
    return { id: "memory", keep: KEEP.PREFER, rank: 70 }
  }
  if (/repo map|Repository map|REPO MAP|^\s*REPO\b/im.test(t)) return { id: "repomap", keep: KEEP.DROPPABLE, rank: 30 }
  if (/LEVEL-2 AUTONOMY/.test(t)) return { id: "level2", keep: KEEP.DROPPABLE, rank: 25 }
  if (/Capability gaps/.test(t)) return { id: "gaps", keep: KEEP.PREFER, rank: 75 }
  if (/Language adapters|\bLANG\b|LANGUAGE CONSTRAINTS/.test(t)) return { id: "lang", keep: KEEP.PREFER, rank: 60 }
  if (/DEEP THINKING|PLAN MODE|READ-ONLY/.test(t)) return { id: "mode", keep: KEEP.ALWAYS, rank: 100 }
  if (/Working-tree|workspace mismatch|\[workspace\]/i.test(t)) return { id: "workspace", keep: KEEP.ALWAYS, rank: 100 }
  return { id: "other", keep: KEEP.DROPPABLE, rank: 40 }
}

/**
 * Split a fully-built system prompt into a cached stable prefix and a
 * budgeted volatile tail.
 *
 * Uses the same TOOLS marker as `disciplines.js` `stablePrefix`:
 *   marker = `"\\nTOOLS — all available"`
 *   stable = text through the first `"\\n\\n"` after that marker
 *            (or the whole text if there is no following blank line)
 *   volatile = the rest
 *
 * If the marker is absent, the entire text is treated as stable (never drop
 * identity/rules). Volatile is split on `"\\n\\n"`, each chunk classified,
 * then `assemblePrompt` is applied with the original stable as
 * `{lane:"stable", keep:"always", rank:100}`.
 *
 * @param {string} fullText
 * @param {{klass?: string|null, budget?: number, task?: string}} [opts]  task: this run's own task (v210: a line restating it verbatim is dropped)
 * @returns {ReturnType<typeof assemblePrompt>}
 */
/**
 * v209 — WHAT CARRIES NO INFORMATION, AND WHAT IS SAID TWICE.
 *
 * Measured on a real run, the ~7.2k-char system prompt carried blocks that
 * told the model nothing this run: a version banner, a self-model with no
 * data yet, a horizon line whose every field was "none", a repo-intel line
 * that only repeated files named elsewhere — and the compact compose block
 * repeated the skills, playbooks and blast radius that their own sections
 * already state (with more detail). Each costs tokens on every request.
 *
 * Only the empty or banner FORM is omitted: a horizon with a real risk,
 * verification or impact, a self-model with measurements, a repo-intel line
 * naming a file said nowhere else — all stay. The richer statement of a fact
 * is the one kept.
 */
const FILLER_LINES = [
  /^ALPHA INTELLIGENCE v[\d.]+: evidence is advisory; existing authorities remain final\.?$/,
  /^HORIZON: action=\S+ frontier=\S+ risk=normal verify=none impact=none replan=none recovery=\S+ wave=\d+\. Advisory only;/,
]
const EMPTY_SELF_MODEL = /^SELF-MODEL \(measured, not claimed\):\n- insufficient evidence for self-assessment(\n- never auto-switch models; never treat confidence as evidence)?$/
// the generic adaptive plan (intelligence-expansion.js adaptivePlan with no
// impact trace and no repair step): the same three steps for every task
const TEMPLATE_STEPS = [
  /^- inspect: Inspect the relevant repository structure and existing behavior\.(?: Focus targets: (.+)\.)?$/,
  /^- implement: Implement the requested change while preserving existing contracts and unrelated behavior\.$/,
  /^- verify: Run focused tests, then the relevant regression\/build checks; record evidence\.$/,
]
const DUPLICATE_OF = [
  { line: /^CAPABILITY ROUTER: /, when: /^TOOL POLICY \(capability-first/m },
  { line: /^\[skills\] /, when: /^SKILLS FOR THIS TASK\b/m },
  { line: /^\[playbooks\] /, when: /^PLAYBOOKS: /m },
  { line: /^\[blast\] /, when: /^BLAST: /m },
]

// v210: the user model and the task contract each restate the task in full.
// Their frozen wording matters when it DIFFERS from what this run was asked
// (a meta segment's planner-written task vs. the original objective); when it
// is this run's own task, the user message already says it word for word.
const RESTATED_TASK = [
  /^- explicit intent \(EXPLICIT, frozen\): (.+)$/,
  /^- Intent v1 \(original\): (.+)$/,
]

/** Every step is template text and every target it names is named elsewhere. */
function genericPlan(steps, rest) {
  return steps.length > 0 && steps.every((st) => {
    const m = TEMPLATE_STEPS.map((re) => re.exec(st)).find(Boolean)
    if (!m) return false
    const targets = (m[1] ?? "").split(",").map((f) => f.trim()).filter(Boolean)
    return targets.every((f) => rest.includes(f))
  })
}

/** Drop no-information lines/chunks and the shorter form of a repeated fact. */
export function pruneFiller(text, { dropped = [], task = "" } = {}) {
  const whole = String(text ?? "")
  const said = String(task ?? "").trim()
  const chunks = whole.split("\n\n")
  const out = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    // v214: the plan as ONE chunk (cognition.js keeps a list's header and
    // items together) — the same rule: every step is the template and its
    // targets are named elsewhere
    const oneChunk = /^ADAPTIVE PLAN \(evidence-driven, bounded\):\n(- \w+: [^\n]*(?:\n|$))+$/.exec(chunk.trim())
    if (oneChunk) {
      const steps = chunk.trim().split("\n").slice(1).map((l) => l.trim())
      const rest = chunks.slice(0, ci).concat(chunks.slice(ci + 1)).join("\n\n")
      if (genericPlan(steps, rest)) {
        dropped.push({ id: "adaptive-plan", chars: chunk.length, keep: "omit", reason: "no-information" })
        continue
      }
    }
    // the ADAPTIVE PLAN header and its step chunks, when every step is the template
    if (/^ADAPTIVE PLAN \(evidence-driven, bounded\):$/.test(chunk.trim())) {
      const steps = []
      let cj = ci + 1
      while (cj < chunks.length && /^- \w+: /.test(chunks[cj].trim())) { steps.push(chunks[cj].trim()); cj++ }
      const rest = chunks.slice(0, ci).concat(chunks.slice(cj)).join("\n\n")
      if (genericPlan(steps, rest)) {
        dropped.push({ id: "adaptive-plan", chars: [chunk, ...steps].join("\n\n").length, keep: "omit", reason: "no-information" })
        ci = cj - 1
        continue
      }
    }
    if (EMPTY_SELF_MODEL.test(chunk.trim())) { dropped.push({ id: "self-model", chars: chunk.length, keep: "omit", reason: "no-information" }); continue }
    const lines = chunk.split("\n").filter((l) => {
      const t = l.trim()
      if (FILLER_LINES.some((re) => re.test(t))) { dropped.push({ id: "filler", chars: l.length, keep: "omit", reason: "no-information" }); return false }
      if (said && RESTATED_TASK.some((re) => re.exec(t)?.[1].trim() === said)) { dropped.push({ id: "task-restated", chars: l.length, keep: "omit", reason: "said-elsewhere" }); return false }
      const dup = DUPLICATE_OF.find((d) => d.line.test(t) && d.when.test(whole))
      if (dup) { dropped.push({ id: "duplicate", chars: l.length, keep: "omit", reason: "said-elsewhere" }); return false }
      const sem = /^SEMANTIC REPO INTELLIGENCE: (.+)$/.exec(t)
      if (sem) {
        const files = sem[1].split(",").map((f) => f.trim()).filter(Boolean)
        const rest = whole.replace(l, "")
        if (files.length && files.every((f) => rest.includes(f))) { dropped.push({ id: "repo-intel", chars: l.length, keep: "omit", reason: "said-elsewhere" }); return false }
      }
      return true
    })
    if (lines.some((l) => l.trim())) out.push(lines.join("\n"))
  }
  return out.join("\n\n")
}

export function budgetPrompt(fullText, opts = {}) {
  const klass = opts.klass ?? null
  const budget = Number.isFinite(opts.budget) ? Number(opts.budget) : charBudgetFor(klass)
  const text = String(fullText ?? "")
  const marker = "\n" + STABLE_MARKER
  const at = text.indexOf(marker)
  if (at === -1) {
    return assemblePrompt(
      [{ id: "stable", lane: LANE.STABLE, keep: KEEP.ALWAYS, rank: 100, text }],
      { budget, klass },
    )
  }
  const end = text.indexOf("\n\n", at + marker.length)
  const stableText = end === -1 ? text : text.slice(0, end)
  const volatileText = end === -1 ? "" : text.slice(end).replace(/^\n+/, "")
  const blocks = [{ id: "stable", lane: LANE.STABLE, keep: KEEP.ALWAYS, rank: 100, text: stableText }]
  // v209: no-information and repeated lines go before the budget is spent
  const omitted = []
  const prunedVolatile = volatileText ? pruneFiller(volatileText, { dropped: omitted, task: opts.task }) : ""
  if (prunedVolatile) {
    for (const chunk of prunedVolatile.split("\n\n")) {
      if (!chunk || !chunk.trim()) continue
      const cls = classifyVolatileChunk(chunk)
      blocks.push({ id: cls.id, lane: LANE.VOLATILE, keep: cls.keep, rank: cls.rank, text: chunk })
    }
  }
  const r = assemblePrompt(blocks, { budget, klass })
  if (omitted.length) r.dropped = [...omitted, ...r.dropped]
  return r
}
