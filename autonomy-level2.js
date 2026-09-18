/**
 * Forge 122.6 — Level-2 autonomy composition.
 *
 * Deterministic orchestration primitives built on existing engines. This module
 * does not execute tools, call models, bypass verification, or alter security.
 * It turns one user objective into a bounded hierarchy, counterfactual strategy
 * set, resource-aware specialist schedule, impact-aware verification ladder,
 * and lossless-when-possible context compression.
 */
import { impactRadius } from "./impact.js"
import { verificationPlanForRisk } from "./plannerisk.js"

export const AUTONOMY_LEVEL2_VERSION = "1.0.0"

const MAX_SUBTASKS = 12
const CLAUSE_RE = /(?:^|\n|\.|;|\bthen\b|\band\b)\s*([^.;\n]{3,180})/gi
const NOISE = /^(?:please|can you|could you|i need you to|make sure to)\s+/i

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").replace(NOISE, "").trim().replace(/[.]+$/, "")
}

export function decomposeTask(objective, { maxSubtasks = MAX_SUBTASKS } = {}) {
  const text = String(objective ?? "").trim()
  if (!text) return { objective: "", nodes: [], dependencies: [], ambiguous: true }
  const parts = []
  let m
  CLAUSE_RE.lastIndex = 0
  while ((m = CLAUSE_RE.exec(text)) && parts.length < maxSubtasks) {
    const c = clean(m[1])
    if (c && !parts.some(x => x.toLowerCase() === c.toLowerCase())) parts.push(c)
  }
  if (!parts.length) parts.push(clean(text).slice(0, 180))
  const nodes = parts.map((text, i) => ({
    id: `l2-${i + 1}`,
    objective: text,
    dependencies: i ? [`l2-${i}`] : [],
    priority: parts.length - i,
  }))
  return {
    version: AUTONOMY_LEVEL2_VERSION,
    objective: text.slice(0, 1000),
    nodes,
    dependencies: nodes.filter(n => n.dependencies.length).map(n => ({ from: n.dependencies[0], to: n.id })),
    ambiguous: text.length < 8,
  }
}

export function compressContext(text, { maxChars = 8000 } = {}) {
  const src = String(text ?? "")
  if (src.length <= maxChars) return { text: src, truncated: false, originalChars: src.length, keptChars: src.length }
  const lines = src.split(/\r?\n/)
  const keep = []
  const evidence = []
  const important = /\b(?:evidence|verify|verification|test|failure|error|constraint|requirement|decision|warning|risk|goal)\b/i
  for (const line of lines) {
    if (important.test(line)) evidence.push(line)
    else if (keep.length < Math.ceil(lines.length * 0.35)) keep.push(line)
  }
  // Evidence is higher-value than filler: place it first so a tight budget
  // cannot evict the very signals needed to continue safely.
  const evidenceRank = (line) => /\b(?:verification|evidence|test|failure|error|requirement|constraint|risk)\b/i.test(line) ? 2 : /\b(?:goal|decision|warning)\b/i.test(line) ? 1 : 0
  evidence.sort((a, b) => evidenceRank(b) - evidenceRank(a))
  const ordered = [...evidence, ...keep.filter(x => !evidence.includes(x))]
  let out = ""
  for (const line of ordered) {
    const add = (out ? "\n" : "") + line
    if (out.length + add.length <= maxChars) { out += add; continue }
    if (!out && important.test(line) && maxChars > 4) { out = line.slice(0, Math.max(1, maxChars - 1)) + "…" }
    break
  }
  return { text: out, truncated: true, originalChars: src.length, keptChars: out.length, preservedEvidenceLines: evidence.length }
}

export function counterfactualStrategies({ objective = "", risk = "medium" } = {}) {
  const o = String(objective).slice(0, 400)
  const base = [
    { id: "minimal-change", strategy: "smallest targeted change", rationale: "minimizes unrelated surface area" },
    { id: "test-first", strategy: "verification-first change", rationale: "establishes expected behavior before mutation" },
    { id: "refactor-safe", strategy: "isolated refactor with compatibility checks", rationale: "separates structural change from behavior change" },
  ]
  const high = [
    { id: "investigate-first", strategy: "deeper investigation before mutation", rationale: "reduces uncertainty before a high-impact change" },
    { id: "rollbackable", strategy: "checkpointed incremental change", rationale: "limits recovery cost if reality contradicts the plan" },
  ]
  const selected = ["high", "critical"].includes(String(risk)) ? [...high, ...base] : base
  return { objective: o, candidates: selected.slice(0, 5), selectedByPolicy: null, selectionRequired: true }
}

export function resourceSchedule({ roles = [], maxParallel = 4 } = {}) {
  const requested = [...new Set((roles || []).map(String).filter(Boolean))]
  const readonly = requested.filter(r => r !== "coder")
  const coder = requested.includes("coder") ? ["coder"] : []
  return {
    maxParallel: Math.max(1, Number(maxParallel) || 1),
    parallel: readonly.slice(0, Math.max(1, Number(maxParallel) || 1)),
    serialized: coder,
    singleWriter: true,
  }
}

export function impactAwareVerification({ cwd = process.cwd(), files = [], risk = "medium" } = {}) {
  const blast = impactRadius({ cwd, files, maxFiles: 400 })
  const base = verificationPlanForRisk(risk)
  let level = base.level
  if (!blast.unknown && blast.radius >= 20 && level === "LOW") level = "MEDIUM"
  if (!blast.unknown && blast.radius >= 40 && ["LOW", "MEDIUM"].includes(level)) level = "HIGH"
  return { blast, base, level, reason: blast.unknown ? "impact is unknown; retain declared risk policy" : `impact radius=${blast.radius}` }
}

export function buildLevel2Brief({ objective = "", cwd = process.cwd(), risk = "medium", files = [], roles = ["researcher", "tester", "reviewer", "coder"], context = "" } = {}) {
  const decomposition = decomposeTask(objective)
  const counterfactual = counterfactualStrategies({ objective, risk })
  const schedule = resourceSchedule({ roles })
  const verification = impactAwareVerification({ cwd, files, risk })
  const compressed = compressContext(context)
  return { version: AUTONOMY_LEVEL2_VERSION, decomposition, counterfactual, schedule, verification, context: compressed }
}
