/**
 * Forge 122.5 — Intelligence Expansion.
 *
 * Deterministic, evidence-first intelligence services composed around the
 * existing repo map, planner, failure classifier, self-review and outcome
 * systems. No model call is hidden here and no function claims certainty.
 * All outputs are bounded and suitable for persistence in a cognitive snapshot.
 */
import fs from "node:fs"
import path from "node:path"
import { buildSemanticGraph } from "./repomap.js"
import { classifyFailure, recoveryPlan, FAILURE } from "./diagnose.js"
import { critiquePlan } from "./plancritique.js"
import { reviewWorkerResult } from "./selfreview.js"
import { recommendStrategyOutcome } from "./outcome-model.js"

export const INTELLIGENCE_EXPANSION_VERSION = "1.0.0"

const WORDS = /[A-Za-z][A-Za-z0-9_+#.-]{2,}/g
const STOP = new Set("the and for with from into that this task code file files make made implement implementation change changes fix update add create use using via run test tests verify check please need want should must project repo repository intelligence plan failure review memory model skill skills".split(" "))

function terms(text, limit = 24) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || "").toLowerCase().match(WORDS) || []) {
    if (STOP.has(raw) || raw.length < 3 || seen.has(raw)) continue
    seen.add(raw); out.push(raw)
    if (out.length >= limit) break
  }
  return out
}

function scoreText(query, node) {
  const q = new Set(terms(query, 40))
  if (!q.size) return 0
  const text = `${node.path} ${(node.symbols || []).join(" ")} ${(node.imports || []).join(" ")} ${(node.exports || []).join(" ")} ${(node.calls || []).join(" ")} ${(node.types || []).join(" ")}`.toLowerCase()
  let score = 0
  for (const t of q) if (text.includes(t)) score += t.length >= 7 ? 2 : 1
  return score
}

/** Build a bounded semantic view and impact cone from the existing cross graph. */
export function analyzeRepository(root, objective = "", { maxFiles = 400, maxNodes = 40, maxDepth = 2 } = {}) {
  const graph = buildSemanticGraph(root, { maxFiles })
  const nodes = Array.isArray(graph.files) ? graph.files : []
  const ranked = nodes.map(n => ({ n, score: scoreText(objective, n) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || String(a.n.path).localeCompare(String(b.n.path)))
  const seed = ranked.slice(0, Math.min(8, ranked.length)).map(x => x.n.path)
  const byFrom = new Map()
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!e?.from || !e?.to) continue
    const a = byFrom.get(e.from) || []
    a.push(e.to); byFrom.set(e.from, a)
  }
  const impact = []
  const seen = new Set(seed)
  let frontier = seed.slice()
  for (let depth = 0; depth <= maxDepth && frontier.length && impact.length < maxNodes; depth++) {
    const next = []
    for (const p of frontier) {
      if (depth > 0) impact.push({ path: p, depth })
      for (const to of byFrom.get(p) || []) {
        if (!seen.has(to)) { seen.add(to); next.push(to) }
      }
      if (impact.length >= maxNodes) break
    }
    frontier = next
  }
  return {
    version: INTELLIGENCE_EXPANSION_VERSION,
    objective: String(objective || "").slice(0, 1000),
    indexedFiles: Number(graph.stats?.totalFiles ?? nodes.length),
    seedFiles: seed,
    matches: ranked.slice(0, 12).map(x => ({ path: x.n.path, score: x.score, symbols: (x.n.symbols || []).slice(0, 8) })),
    impact: impact.slice(0, maxNodes),
    truncated: nodes.length >= maxFiles,
  }
}

/** Turn repository evidence into an adaptive, inspect→change→verify plan skeleton. */

/** Build a bounded impact view from observed changed files using the existing semantic graph.
 * Read-only: it never mutates repository state and returns only graph-derived paths.
 */
export function impactFromChangedFiles(root, changedFiles = [], { maxFiles = 400, maxNodes = 24, maxDepth = 2 } = {}) {
  const base = (() => { try { return path.resolve(root || process.cwd()) } catch { return path.resolve(process.cwd()) } })()
  const rels = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map(x => {
    const raw = String(x || '').replaceAll('\\','/').replace(/^\.\//,'')
    if (!raw || raw === '(shell write)') return raw
    try {
      const abs = path.resolve(base, raw)
      return path.relative(base, abs).replaceAll('\\','/').replace(/^\.\//,'')
    } catch { return raw }
  }).filter(Boolean))].slice(0, 32)
  if (!rels.length) return { version: INTELLIGENCE_EXPANSION_VERSION, changed: [], impact: [], graph: { totalFiles: 0, totalEdges: 0 }, truncated: false }
  const graph = buildSemanticGraph(root, { maxFiles })
  const byFrom = new Map(), byTo = new Map()
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!e?.from || !e?.to) continue
    const from = String(e.from).replaceAll('\\','/').replace(/^\.\//,'')
    const to = String(e.to).replaceAll('\\','/').replace(/^\.\//,'')
    const a = byFrom.get(from) || []
    a.push(to); byFrom.set(from, a)
    const b = byTo.get(to) || []
    b.push(from); byTo.set(to, b)
  }
  const seen = new Set(rels), impact = [], queue = rels.map(path => ({ path, depth: 0 }))
  while (queue.length && impact.length < maxNodes) {
    const cur = queue.shift()
    if (cur.depth >= maxDepth) continue
    const neighbors = [...new Set([...(byTo.get(cur.path) || []), ...(byFrom.get(cur.path) || [])])]
    for (const to of neighbors) {
      if (seen.has(to)) continue
      seen.add(to)
      impact.push({ path: to, depth: cur.depth + 1, source: cur.path })
      queue.push({ path: to, depth: cur.depth + 1 })
      if (impact.length >= maxNodes) break
    }
  }
  return { version: INTELLIGENCE_EXPANSION_VERSION, changed: rels, impact, graph: graph.stats || { totalFiles: graph.files?.length || 0, totalEdges: graph.edges?.length || 0 }, truncated: impact.length >= maxNodes }
}

export function adaptivePlan({ objective = "", repo = null, previousPlan = [], failures = [] } = {}) {
  const plan = []
  const targets = (repo?.matches || []).slice(0, 4).map(x => x.path)
  const targetText = targets.length ? ` Focus targets: ${targets.join(", ")}.` : ""
  plan.push({ id: "inspect", role: "investigator", readOnly: true, text: `Inspect the relevant repository structure and existing behavior.${targetText}` })
  if ((repo?.impact || []).length) plan.push({ id: "impact", role: "analyst", readOnly: true, text: `Trace dependency/call impact around the matched files before editing (${repo.impact.slice(0, 6).map(x => x.path).join(", ")}).` })
  plan.push({ id: "implement", role: "implementer", readOnly: false, text: `Implement the requested change while preserving existing contracts and unrelated behavior.` })
  if (failures.length) plan.push({ id: "repair", role: "repairer", readOnly: false, text: `Apply a diagnosis-led repair strategy instead of repeating a failed approach.` })
  plan.push({ id: "verify", role: "tester", readOnly: true, text: `Run focused tests, then the relevant regression/build checks; record evidence.` })
  const critique = critiquePlan({ objective, planDefs: plan.map(x => ({ title: x.id, objective: x.text, read_only: x.readOnly, role: x.role })), planText: plan.map((x,i)=>`${i+1}. ${x.text}`).join("\n") })
  return { objective, plan, critique, changedFromPrevious: JSON.stringify(previousPlan) !== JSON.stringify(plan) }
}

/** Convert one observed failure into a diagnosis, safe recovery ladder and memory key. */
export function failureIntelligence(result, meta = {}, history = []) {
  const diagnosis = classifyFailure(result, meta)
  if (!diagnosis.failed) return { diagnosis, repeated: false, strategy: null, lessonKey: null }
  const attempts = history.filter(h => h?.code === diagnosis.code).length
  const repeated = attempts > 0
  const strategy = recoveryPlan(diagnosis.code, { ...meta, attempts, idempotent: meta.idempotent === true })
  const lessonKey = `${diagnosis.code}:${meta.tool || "unknown"}`
  return { diagnosis, repeated, attempts, strategy, lessonKey }
}

/** Run the existing self-review plus an explicit adversarial pass over evidence. */
export function adversarialReview({ objective = "", report = "", toolCalls = 0, evidenceCount = 0, verification = "unverified", ok = false } = {}) {
  const base = reviewWorkerResult({ objective, result: report, toolCalls, evidenceCount, verification, ok })
  const findings = [...(base.flags || [])]
  if (verification === "passed" && evidenceCount === 0) findings.push("verification claims success but no evidence count was supplied")
  if (ok && !/\b(test|verify|check|validated|passed)\b/i.test(report)) findings.push("success report has no explicit verification language")
  return { ...base, adversarial: true, findings: [...new Set(findings)].slice(0, 8), ok: base.ok && findings.length === 0 }
}

/** Compose measured outcome preference with repository/task signals without inventing a score. */
export function composeStrategy({ cwd, klass = "SMALL", objective = "", repo = null, candidates = [] } = {}) {
  let learned = null
  try { learned = recommendStrategyOutcome({ cwd, klass, candidates }) } catch { learned = null }
  const target = repo?.matches?.[0]?.path || ""
  const out = candidates.map((c, i) => ({ ...c, evidenceFit: scoreText(`${objective} ${target}`, c), priorRank: i }))
  out.sort((a, b) => (b.evidenceFit - a.evidenceFit) || (a.priorRank - b.priorRank))
  return { learned, candidates: out.slice(0, 8), rationale: target ? `repository evidence favors strategies touching ${target}` : "no repository match was strong enough to bias strategy" }
}

export function saveExpansionSnapshot(cwd, data) {
  try {
    const dir = path.join(cwd || process.cwd(), ".forge")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "intelligence-expansion.json")
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: INTELLIGENCE_EXPANSION_VERSION, savedAt: Date.now(), ...data }, null, 2))
    fs.renameSync(tmp, file)
    return file
  } catch { return null }
}

export { FAILURE }
