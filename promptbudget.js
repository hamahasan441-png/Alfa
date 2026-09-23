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
 * @param {{klass?: string|null, budget?: number}} [opts]
 * @returns {ReturnType<typeof assemblePrompt>}
 */
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
  if (volatileText) {
    for (const chunk of volatileText.split("\n\n")) {
      if (!chunk || !chunk.trim()) continue
      const cls = classifyVolatileChunk(chunk)
      blocks.push({ id: cls.id, lane: LANE.VOLATILE, keep: cls.keep, rank: cls.rank, text: chunk })
    }
  }
  return assemblePrompt(blocks, { budget, klass })
}
