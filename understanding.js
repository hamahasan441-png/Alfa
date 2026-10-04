/**
 * forge — the canonical understanding of a task (Alpha Final, zero dependencies)
 *
 * WHY THIS FILE EXISTS (the audit, ALPHA-FINAL-AUDIT.md): forge already had
 * every idea in it, in five places that never met —
 *   usermodel.js      explicit vs inferred intent, intent hypotheses, ambiguity
 *   goal-contract.js  constraints, prohibitions, acceptance, deliverables
 *                     (twice: an in-memory reviser and a durable record field)
 *   contract.js       intent versions, requirement status, unknowns, gaps
 *   taskmodel.js      origin tags (requirement / assumption / inference / fact)
 *   cognitive-state   facts about the run
 * Each was built, tested and fed to the prompt as its own block; none was
 * persisted with the task, none reached the workers, the reviewer, the final
 * report or `continue`, and the controller rebuilt them from the objective
 * text on every resume — so a resumed task forgot everything it had learned.
 *
 * This module does NOT add a sixth extractor. It is the one record those
 * extractors feed:
 *   derive()   one pass over the task: usermodel.understand + the goal
 *              contract's derivation, plus what neither did — temporal
 *              statements ("we already did X" is context, not a request),
 *              non-goals, priorities, dependencies, risks, implicit
 *              engineering requirements (marked INFERRED, never EXPLICIT),
 *              and contradictions inside the request itself.
 *   observe()  the record evolves with execution: plan, node progress,
 *              checks passed and failed, acceptance results, re-plans and
 *              strategy changes (decisions, rejected approaches), goal
 *              reinterpretations, drift. A failed check that touches an
 *              assumption's subject CONTRADICTS it and lowers its confidence
 *              (self-correction: the understanding admits it was wrong).
 *   completion()  implemented ≠ tested ≠ verified ≠ accepted ≠ complete.
 *   formatForPrompt() / resumeBrief() / view()  how it is used.
 *
 * Every item has a TYPE: EXPLICIT (the user said it) · INFERRED (derived,
 * with a confidence) · ASSUMED (a guess forge acts on) · VERIFIED (evidence
 * confirmed it) · UNKNOWN · CONTRADICTED. An inference is never promoted to
 * EXPLICIT; only evidence makes something VERIFIED.
 *
 * KNOWLEDGE and STATE are separate fields: knowledge is what stays true
 * ("the project's tests run with `npm test`"), state is where the task is
 * ("2 of 4 steps done"). Pure functions; bounded sizes; JSON-serialisable,
 * so it lives on the task record and in cognition.json.
 */
import crypto from "node:crypto"
import { commandsIn, criterionKind } from "./combine.js"

export const UNDERSTANDING_VERSION = 1
export const UTYPE = Object.freeze({ EXPLICIT: "EXPLICIT", INFERRED: "INFERRED", ASSUMED: "ASSUMED", VERIFIED: "VERIFIED", UNKNOWN: "UNKNOWN", CONTRADICTED: "CONTRADICTED" })
export const UKIND = Object.freeze({
  REQUIREMENT: "requirement", IMPLICIT: "implicit_requirement", CONSTRAINT: "constraint", PROHIBITION: "prohibition",
  DELIVERABLE: "deliverable", NON_GOAL: "non_goal", PRIORITY: "priority", ASSUMPTION: "assumption", UNKNOWN: "unknown",
  AMBIGUITY: "ambiguity", RISK: "risk", DEPENDENCY: "dependency", SUCCESS: "success_criterion", ACCEPTANCE: "acceptance",
  CONTEXT: "context", QUESTION: "question",
})
export const TEMPORAL = Object.freeze({ PAST: "past", CURRENT: "current", CONTINUE: "continue", PLANNED: "planned" })
export const LEVEL = Object.freeze(["NOT_STARTED", "IMPLEMENTED", "TESTED", "VERIFIED", "ACCEPTED", "COMPLETE"])

const MAX_ITEMS = 80, MAX_EVIDENCE = 40, MAX_DECISIONS = 40, MAX_STATE = 40
const TEST_CMD_RE = /\b(?:test|tests|pytest|jest|vitest|mocha|ava|tap|spec|rspec|phpunit)\b/i
const clean = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n)
const STOP = new Set("the a an and or to of in on for with from that this is are be as it all do not must should can will it's its into by at we you i me my our please".split(" "))
export const tokensOf = (s) => [...new Set(String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}_./-]+/gu, " ").split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x)))]
const sentencesOf = (t) => String(t ?? "").split(/(?<=[.!?])\s+|\n+|;\s+/).map((x) => x.trim()).filter(Boolean)
const PATH_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|md|json|ya?ml|sh|toml|css|html))\b/g
const pathsIn = (s) => [...new Set([...String(s ?? "").matchAll(PATH_RE)].map((m) => m[1]))]

let seq = 0
const nid = (k) => `${k.slice(0, 3)}${(++seq).toString(36)}`

function item(kind, text, type, { confidence = null, source = "task", temporal = TEMPORAL.CURRENT, priority = null, subject = null } = {}) {
  const t = clean(text, 400)
  if (!t) return null
  return {
    id: nid(kind), kind, text: t, type,
    confidence: confidence ?? (type === UTYPE.EXPLICIT ? 1 : type === UTYPE.VERIFIED ? 0.95 : type === UTYPE.INFERRED ? 0.75 : type === UTYPE.ASSUMED ? 0.5 : type === UTYPE.UNKNOWN ? 0.2 : 0.1),
    source, temporal, priority, subject: subject ?? (pathsIn(t)[0] || null), evidence: [], at: Date.now(),
  }
}

// ---- derivation --------------------------------------------------------------

const PAST_RE = /\b(?:we|i|you)\s+(?:already\s+)?(?:did|implemented|added|built|fixed|merged|shipped|wrote|finished|completed)\b|\b(?:already|previously)\s+(?:been\s+)?(?:implemented|done|added|built|fixed|merged|shipped|exists?|in place)\b|\bis already\b|\bwas already\b/i
const CONTINUE_RE = /^\s*(?:continue|resume|keep going|carry on|go on)\b|\bcontinue (?:with|from|where)\b|\bpick up where\b/i
const NON_GOAL_RE = /\b(?:no need to|don'?t need to|not (?:needed|required|necessary)|out of scope|ignore|skip|leave .{1,40} (?:as is|alone)|without changing|not part of)\b/i
const PRIORITY_RE = /\b(?:first|most important|priority|focus on|above all|especially|critical(?:ly)?|main goal)\b/i
const DEPENDENCY_RE = /\b(?:after|once|depends on|requires?|needs? .{1,30} first|before you|blocked by)\b/i
const RISK_RE = /\b(?:production|prod\b|migrat|delete|drop|irreversible|data loss|security|auth|payment|secret|credential|breaking change|public api)\w*/i
const VAGUE_RE = /^\s*(?:make|improve|fix|clean ?up|optimi[sz]e|refactor|update|better|enhance|upgrade)\b[^.]{0,40}$|\b(?:make it (?:better|faster|nicer|work)|improve (?:it|things|performance|intelligence)|fix (?:it|memory|this|everything))\b/i
const PROHIBIT_RE = /\b(?:do not|don'?t|never|must not|mustn'?t|without)\b[^.]{0,60}\b(?:change|modify|edit|touch|delete|remove|rewrite|alter|break|rename)\b/i
const ACCEPT_RE = /\b(?:make sure|ensure|so that|until|verify that|must pass|should pass|has to pass)\b/i
const CONSTRAINT_RE = /\b(?:must|need(?:s)? to|has to|should|preserve|keep|only|without)\b/i
const CHANGE_RE = /\b(?:fix|change|update|add|implement|refactor|rewrite|remove|delete|replace|migrate|build|create)\b/i
const KEEP_RE = /\b(?:keep|preserve|do not (?:remove|change|touch|modify)|don'?t (?:remove|change|touch|modify)|must not (?:remove|change)|never (?:remove|change))\b\s+([^.;,]{2,60})/gi
const DROP_RE = /\b(?:remove|delete|drop|replace|rewrite)\b\s+([^.;,]{2,60})/gi

/**
 * One pass over the task text, seeded by what the existing extractors found.
 * @param {string} task
 * @param {object} [o]
 * @param {object} [o.user]  usermodel.understand(task) result
 * @param {object} [o.goal]  goal-contract.deriveGoalContract(task) result
 * @param {object} [o.context] { conversation?: string, repoFacts?: string[] }
 */
export function deriveUnderstanding(task, { user = null, goal = null, context = null } = {}) {
  const text = clean(task, 4000)
  const items = []
  const add = (...a) => { const it = item(...a); if (it && !items.some((x) => x.kind === it.kind && x.text.toLowerCase() === it.text.toLowerCase())) items.push(it) }
  const sentences = sentencesOf(text)

  // what was said vs what is meant
  const hyps = Array.isArray(user?.intentHypotheses) ? user.intentHypotheses : []
  const inferredGoal = clean(user?.inferredIntent?.value || user?.underlyingGoal || "", 400)
  const intent = {
    said: text,
    means: inferredGoal && inferredGoal.toLowerCase() !== text.toLowerCase() ? inferredGoal : text,
    goal: inferredGoal || text,
    outcome: clean(user?.desiredOutcome || text, 400),
    hypotheses: hyps.slice(0, 5).map((h) => ({ meaning: clean(h.meaning || h.goal, 200), confidence: Number(h.confidence) || 0.5 })),
    confidence: Number(user?.confidence) || (VAGUE_RE.test(text) ? 0.4 : 0.85),
    authority: user?.decisionAuthority ?? null,
  }

  // temporal: what is already done is context, not a request
  for (const s of sentences) {
    if (PAST_RE.test(s)) add(UKIND.CONTEXT, s, UTYPE.EXPLICIT, { temporal: TEMPORAL.PAST, source: "task (past tense — already done, not a request)" })
    else if (CONTINUE_RE.test(s)) add(UKIND.CONTEXT, s, UTYPE.EXPLICIT, { temporal: TEMPORAL.CONTINUE, source: "task (continue — preserve earlier work)" })
  }
  const isPast = (s) => PAST_RE.test(s)

  // explicit, per sentence. The goal contract's own lists seed what a
  // sentence scan misses, but its clause splitter cuts "do not change a.js"
  // at the dot — whole sentences are kept here, fragments are not.
  const covered = (t) => items.some((x) => x.text.toLowerCase().includes(clean(t).toLowerCase()))
  for (const s of sentences) {
    if (isPast(s) || CONTINUE_RE.test(s)) continue
    if (PROHIBIT_RE.test(s)) { add(UKIND.PROHIBITION, s, UTYPE.EXPLICIT, { priority: "HIGH", subject: pathsIn(s)[0] ?? null }); continue }
    if (NON_GOAL_RE.test(s)) { add(UKIND.NON_GOAL, s, UTYPE.EXPLICIT); continue }
    if (PRIORITY_RE.test(s)) add(UKIND.PRIORITY, s, UTYPE.EXPLICIT)
    if (DEPENDENCY_RE.test(s) && CHANGE_RE.test(s)) add(UKIND.DEPENDENCY, s, UTYPE.EXPLICIT)
    const acc = ACCEPT_RE.exec(s)
    // "make sure X passes" starts at its keyword; "all tests must pass" has its
    // subject BEFORE the keyword — keep the whole clause, not "must pass."
    let at = acc ? acc.index : -1
    if (acc && /pass/i.test(acc[0])) {
      const before = s.slice(0, acc.index)
      const cuts = [...before.matchAll(/(?:[,;]|\band\b)\s+/gi)]
      at = cuts.length ? cuts[cuts.length - 1].index + cuts[cuts.length - 1][0].length : 0
    }
    if (acc) add(UKIND.ACCEPTANCE, s.slice(at), UTYPE.EXPLICIT)
    const head = acc ? s.slice(0, at).replace(/\b(?:and|,)\s*$/i, "").trim() : s
    if (CHANGE_RE.test(head) && head.split(/\s+/).length >= 2) add(UKIND.REQUIREMENT, head, UTYPE.EXPLICIT)
    else if (!acc && CONSTRAINT_RE.test(s)) add(UKIND.CONSTRAINT, s, UTYPE.EXPLICIT, { priority: /security|preserv/i.test(s) ? "HIGH" : null })
  }
  for (const c of goal?.prohibited ?? []) if (!covered(c) && c.split(/\s+/).length >= 3) add(UKIND.PROHIBITION, c, UTYPE.EXPLICIT, { priority: "HIGH" })
  for (const c of goal?.constraints ?? []) if (!isPast(c) && !covered(c) && c.split(/\s+/).length >= 3) add(UKIND.CONSTRAINT, c, UTYPE.EXPLICIT, { priority: /security|preserv/i.test(c) ? "HIGH" : null })
  const overlaps = (t) => covered(t) || items.some((x) => clean(t).toLowerCase().includes(x.text.toLowerCase()))
  for (const a of goal?.acceptance ?? []) if (!isPast(a) && !overlaps(a)) add(UKIND.ACCEPTANCE, a, UTYPE.EXPLICIT)
  // a path is a deliverable only if a sentence asks to change it — a path
  // named in "do not change x.js" or "we already did y.js" is not
  const asked = (p) => sentences.some((s) => s.includes(p) && !isPast(s) && !PROHIBIT_RE.test(s) && !NON_GOAL_RE.test(s))
  for (const d of goal?.deliverables ?? []) if (asked(d)) add(UKIND.DELIVERABLE, d, UTYPE.EXPLICIT, { subject: d })
  for (const s of sentences) { const m = RISK_RE.exec(s); if (m && !isPast(s)) add(UKIND.RISK, `${m[0]}: ${s}`, UTYPE.INFERRED, { confidence: 0.7, source: "risk words in the task" }) }

  // ambiguity: say the interpretations, record the smallest assumption
  const ambiguous = (user?.ambiguities?.length ?? 0) > 0 || VAGUE_RE.test(text)
  if (ambiguous) {
    add(UKIND.AMBIGUITY, `"${clean(text, 120)}" can mean more than one thing${hyps.length > 1 ? `: ${hyps.slice(0, 3).map((h) => clean(h.meaning || h.goal, 60)).join(" | ")}` : ""}`, UTYPE.UNKNOWN, { source: "ambiguity detection" })
    const smallest = hyps.length ? [...hyps].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] : null
    add(UKIND.ASSUMPTION, smallest ? `taking the most likely reading: ${clean(smallest.meaning || smallest.goal, 200)} (resolve from the repository before acting on it)` : "taking the narrowest reading of the request until the repository shows more", UTYPE.ASSUMED, { confidence: smallest ? Math.min(0.7, Number(smallest.confidence) || 0.5) : 0.4, source: "smallest reasonable assumption" })
  }
  for (const u of user?.unknowns ?? []) add(UKIND.UNKNOWN, u, UTYPE.UNKNOWN)
  for (const a of user?.assumptions ?? []) add(UKIND.ASSUMPTION, `alternative reading: ${a}`, UTYPE.ASSUMED, { confidence: 0.3, source: "intent hypotheses" })

  // implicit engineering requirements — INFERRED, never EXPLICIT
  if (CHANGE_RE.test(text) && !/\b(?:explain|describe|summari[sz]e|what is|how does)\b/i.test(text)) {
    add(UKIND.IMPLICIT, "behaviour the task does not mention stays as it is (existing tests keep passing)", UTYPE.INFERRED, { confidence: 0.85, source: "engineering default" })
    if (/\bfix|bug|broken|fail|crash|error\b/i.test(text)) add(UKIND.IMPLICIT, "a check that failed before the fix passes after it", UTYPE.INFERRED, { confidence: 0.8, source: "engineering default (fix tasks)" })
  }

  // success criteria: the explicit acceptance, else the outcome itself (inferred)
  const explicitAcceptance = items.filter((x) => x.kind === UKIND.ACCEPTANCE)
  const firstReq = items.find((x) => x.kind === UKIND.REQUIREMENT)
  if (!explicitAcceptance.length && CHANGE_RE.test(text)) add(UKIND.SUCCESS, `the requested outcome is observable: ${clean(firstReq?.text ?? intent.outcome, 200)}`, UTYPE.INFERRED, { confidence: 0.7, source: "no acceptance criteria were stated" })

  // contradictions inside the request: keep X ↔ remove/replace X
  const keeps = [...text.matchAll(KEEP_RE)].map((m) => tokensOf(m[1]))
  const drops = [...text.matchAll(DROP_RE)].map((m) => ({ raw: clean(m[1], 80), t: tokensOf(m[1]) }))
  for (const k of keeps) for (const d of drops) {
    const shared = d.t.filter((x) => k.includes(x) && !/^(new|old|one|the|all|any|some|current|existing)$/.test(x))
    if (shared.length) {
      add(UKIND.QUESTION, `the task says both to keep and to remove/replace "${shared.join(" ")}" — which wins?`, UTYPE.CONTRADICTED, { confidence: 0.9, source: "contradiction in the request", priority: "HIGH" })
    }
  }
  const prohibitedPaths = (goal?.prohibited ?? []).flatMap(pathsIn)
  for (const p of prohibitedPaths) if ((goal?.deliverables ?? []).includes(p) && sentences.some((s) => s.includes(p) && CHANGE_RE.test(s) && !/\b(?:not|never|don'?t)\b/i.test(s))) {
    add(UKIND.QUESTION, `${p} is both to be changed and not to be changed`, UTYPE.CONTRADICTED, { confidence: 0.9, source: "contradiction in the request", priority: "HIGH", subject: p })
  }

  for (const f of context?.repoFacts ?? []) add(UKIND.CONTEXT, f, UTYPE.VERIFIED, { source: "repository" })

  return {
    v: UNDERSTANDING_VERSION,
    fingerprint: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16),
    intent,
    items: items.slice(0, MAX_ITEMS),
    knowledge: [],
    state: { phase: "understood", plan: [], current: null, completed: [], failed: [], pending: [], changedFiles: [], checks: { passed: 0, failed: 0, last: null } },
    decisions: [], rejected: [], evidence: [], drift: [], corrections: [],
    completion: { level: "NOT_STARTED", why: "nothing has run yet" },
    createdAt: Date.now(), updatedAt: Date.now(),
  }
}

// ---- evolution -----------------------------------------------------------------

const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max) }
const touches = (it, text) => {
  const t = String(text ?? "")
  if (it.subject && t.includes(it.subject)) return true
  const a = tokensOf(it.text).filter((x) => x.length > 3 && !/^(taking|reading|likely|resolve|repository|before|acting|alternative|behaviour|existing|tests?|passing|check)$/.test(x))
  const b = new Set(tokensOf(t))
  return a.length > 0 && a.filter((x) => b.has(x)).length >= Math.min(2, a.length)
}

/**
 * Evolve the understanding with one runtime event. Pure: returns the same
 * (mutated) object for convenience; never throws on unknown events.
 */
export function observe(u, ev) {
  if (!u || !ev || typeof ev !== "object") return u
  const now = Date.now()
  const st = u.state
  switch (ev.type) {
    case "DAG_BUILT": {
      const nodes = ev.graph?.nodes ?? []
      st.plan = nodes.slice(0, MAX_STATE).map((n) => ({ id: String(n.id), title: clean(n.title || n.objective || n.id, 160), role: n.role ?? null, status: "pending" }))
      st.pending = st.plan.map((n) => n.id)
      st.phase = "planned"
      // goal preservation: a planned step that shares nothing with the goal,
      // its deliverables or its requirements is flagged as possible drift
      const anchor = new Set([...tokensOf(u.intent.said), ...tokensOf(u.intent.goal), ...u.items.filter((x) => x.kind !== UKIND.CONTEXT).flatMap((x) => tokensOf(x.text))])
      for (const n of st.plan) {
        if (/^(inspect|investigate|read|explore|plan|verify|test|review|integrat|check|run|research|analy[sz]e)/i.test(n.title)) continue
        const t = tokensOf(n.title)
        if (t.length >= 3 && !t.some((x) => anchor.has(x))) push(u.drift, { at: now, step: n.id, why: `step "${n.title}" shares nothing with the goal`, level: "MEDIUM" }, 20)
      }
      break
    }
    case "DAG_NODE_STARTED": { st.current = String(ev.nodeId ?? ""); const n = st.plan.find((x) => x.id === st.current); if (n) n.status = "running"; st.phase = "executing"; break }
    case "DAG_NODE_COMPLETED": {
      const id = String(ev.nodeId ?? "")
      const n = st.plan.find((x) => x.id === id); if (n) n.status = "completed"
      if (!st.completed.includes(id)) push(st.completed, id, MAX_STATE)
      st.pending = st.pending.filter((x) => x !== id); if (st.current === id) st.current = null
      break
    }
    case "WORKER_COMPLETED": {
      if (ev.ok === false && ev.nodeId) { const id = String(ev.nodeId); const n = st.plan.find((x) => x.id === id); if (n && n.status !== "completed") n.status = "failed"; if (!st.failed.includes(id)) push(st.failed, id, MAX_STATE) }
      break
    }
    case "command_check":
    case "VERIFICATION_PASSED": {
      const passed = ev.type === "VERIFICATION_PASSED" ? true : ev.passed === true
      const cmd = clean(ev.command, 200)
      if (!cmd) break
      st.checks = { passed: st.checks.passed + (passed ? 1 : 0), failed: st.checks.failed + (passed ? 0 : 1), last: { command: cmd, passed, exitCode: ev.exitCode ?? null, at: now } }
      push(u.evidence, { kind: "check", text: cmd, ok: passed, exitCode: ev.exitCode ?? null, at: now }, MAX_EVIDENCE)
      if (passed) {
        // knowledge (stays true): how this project is checked
        if (!u.knowledge.some((k) => k.text === `\`${cmd}\` is a working check here`)) push(u.knowledge, { text: `\`${cmd}\` is a working check here`, type: UTYPE.VERIFIED, at: now }, 20)
        // an acceptance item that names this check is now VERIFIED
        const ncmd = cmd.toLowerCase()
        for (const it of u.items) if ((it.kind === UKIND.ACCEPTANCE || it.kind === UKIND.SUCCESS) && it.type !== UTYPE.CONTRADICTED && commandsIn(it.text).some((c) => ncmd.includes(c.toLowerCase()))) verify(it, `\`${cmd}\` passed`)
        // "all tests pass" names no command: a passing test run is its evidence
        if (TEST_CMD_RE.test(cmd)) for (const it of u.items) if (it.kind === UKIND.ACCEPTANCE && it.type !== UTYPE.CONTRADICTED && it.type !== UTYPE.VERIFIED && criterionKind(it.text) === "tests") verify(it, `\`${cmd}\` passed`)
      } else {
        // self-correction: a failed check that touches an assumption contradicts it
        const out = `${cmd} ${clean(ev.tail ?? ev.evidence ?? "", 600)}`
        for (const it of u.items) {
          if ((it.type === UTYPE.ASSUMED || it.type === UTYPE.INFERRED) && touches(it, out)) {
            const before = it.type
            it.type = UTYPE.CONTRADICTED; it.confidence = Math.min(it.confidence, 0.2)
            it.evidence.push({ text: `\`${cmd}\` failed`, at: now })
            push(u.corrections, { at: now, item: it.id, from: before, why: `\`${cmd}\` failed and it touches "${clean(it.text, 80)}"` }, 20)
          }
        }
      }
      break
    }
    case "VERIFICATION_STATUS": if (ev.ok === false && ev.reason) push(u.evidence, { kind: "gate", text: clean(ev.reason, 200), ok: false, at: now }, MAX_EVIDENCE); break
    case "ACCEPTANCE_CHECKED": {
      for (const a of ev.items ?? []) {
        const it = u.items.find((x) => x.kind === UKIND.ACCEPTANCE && clean(a.criterion, 200).startsWith(x.text.slice(0, 60)))
        if (!it) continue
        if (a.status === "MET") verify(it, a.evidence)
        else if (a.status === "FAILED") { it.type = UTYPE.CONTRADICTED; it.confidence = 0.1; it.evidence.push({ text: clean(a.evidence, 200), at: now }) }
      }
      break
    }
    case "PLAN_REPLAN_STARTED": {
      // §19: the steps the replaced plan tried and lost become rejected
      // approaches, with the error that sank them — the next replan reads them
      for (const f of ev.failedSteps ?? []) {
        const text = clean(f?.objective, 160)
        if (text && !u.rejected.some((r) => r.text === text)) push(u.rejected, { text, why: clean(f?.error, 160) || "failed in an earlier plan", at: now }, 20)
      }
      break
    }
    case "STEP_REPLANNED": {
      // recovery level 3: the step's replaced objective is a rejected approach
      if (ev.ok === true && ev.from) {
        const text = clean(ev.from, 160)
        if (text && !u.rejected.some((r) => r.text === text)) push(u.rejected, { text, why: clean(ev.reason, 160) || "failed step, revised", at: now }, 20)
        decide(u, { decision: `revised step ${ev.nodeId ?? "?"}`, reason: ev.reason, evidence: null, confidence: 0.6, affected: ev.nodeId ?? null })
      }
      break
    }
    case "PLAN_REPLANNED": decide(u, { decision: "re-planned", reason: ev.reason || ev.code || "new evidence", evidence: ev.error || null, confidence: ev.ok === false ? 0.4 : 0.7 }); st.phase = "replanned"; break
    case "STRATEGY_CHANGED": {
      decide(u, { decision: "changed strategy", reason: ev.reason, evidence: null, confidence: 0.6, affected: ev.nodeId ?? null })
      for (const a of ev.avoided ?? []) if (a && !u.rejected.some((r) => r.text === clean(a, 160))) push(u.rejected, { text: clean(a, 160), why: "did not work before", at: now }, 20)
      break
    }
    case "REPAIR_STARTED": push(u.evidence, { kind: "failure", text: clean(ev.error, 200), ok: false, at: now }, MAX_EVIDENCE); break
    case "MODEL_SELECTED": if (ev.model) decide(u, { decision: `model ${ev.provider}/${ev.model}`, reason: ev.reason, confidence: Number(ev.confidence) || null }); break
    case "GOAL_REINTERPRETATION": decide(u, { decision: `goal reinterpreted (v${ev.version ?? "?"})`, reason: ev.reason, evidence: ev.evidence ?? null, confidence: 0.8 }); u.intent.goal = clean(ev.to, 400) || u.intent.goal; break
    case "TASK_COMPLETED": st.phase = "completed"; break
    case "TASK_FINISHED": st.phase = String(ev.status ?? st.phase).toLowerCase(); break
  }
  u.updatedAt = now
  return u
}

function pushItem(u, it) { if (it) push(u.items, it, MAX_ITEMS) }

function verify(it, why) {
  it.type = UTYPE.VERIFIED
  it.confidence = Math.max(it.confidence, 0.95)
  it.evidence.push({ text: clean(why, 200), at: Date.now() })
}

/** Record one important decision with its reason, evidence and confidence. */
export function decide(u, { decision, reason = null, evidence = null, confidence = null, affected = null, expected = null } = {}) {
  if (!u || !decision) return u
  push(u.decisions, { decision: clean(decision, 160), reason: clean(reason, 240) || null, evidence: evidence ? clean(evidence, 200) : null, confidence: confidence == null ? null : Math.round(Number(confidence) * 100) / 100, affected: affected ? String(affected) : null, expected: expected ? clean(expected, 160) : null, at: Date.now() }, MAX_DECISIONS)
  u.updatedAt = Date.now()
  return u
}

/** A new instruction mid-task: the original is never replaced (goal preservation). */
export function reviseIntent(u, text, { drift = null, dropped = [] } = {}) {
  if (!u) return u
  decide(u, { decision: "instruction changed", reason: clean(text, 200), evidence: drift ? `semantic drift ${drift}` : null, confidence: 0.9 })
  for (const c of dropped) pushItem(u, item(UKIND.QUESTION, `the new instruction no longer mentions "${clean(c.text ?? c, 80)}" — still required?`, UTYPE.UNKNOWN, { priority: "HIGH", source: "changed instruction" }), MAX_ITEMS)
  return u
}

// ---- completion ------------------------------------------------------------------

/**
 * implemented → tested → verified → accepted → complete. These are not
 * synonyms; each level needs the one before it plus its own evidence.
 */
export function completion(u, { changedFiles = [], verification = null, gateOk = null, acceptance = null } = {}) {
  if (!u) return { level: "NOT_STARTED", why: "no understanding" }
  const wrote = changedFiles.length > 0 || u.state.changedFiles.length > 0
  const ran = u.state.checks.passed + u.state.checks.failed > 0
  const lastOk = u.state.checks.last ? u.state.checks.last.passed : null
  const vOk = verification == null ? lastOk === true : /^(VERIFIED|PASSED|SATISFIED|OK|NOT_REQUIRED)$/i.test(String(verification?.status ?? verification))
  const acc = acceptance ?? u.items.filter((x) => x.kind === UKIND.ACCEPTANCE).map((x) => ({ status: x.type === UTYPE.VERIFIED ? "MET" : x.type === UTYPE.CONTRADICTED ? "FAILED" : "UNCHECKED" }))
  const accFailed = acc.filter((a) => a.status === "FAILED").length
  const accOpen = acc.filter((a) => a.status !== "MET").length
  const contradictions = u.items.filter((x) => x.type === UTYPE.CONTRADICTED && x.kind === UKIND.QUESTION).length
  let level = "NOT_STARTED", why = "nothing was changed or checked"
  if (wrote || ran) { level = "IMPLEMENTED"; why = wrote ? "files changed" : "work done without file changes" }
  if (ran) { level = "TESTED"; why = `${u.state.checks.passed + u.state.checks.failed} check(s) ran` }
  if (vOk && ran && lastOk !== false) { level = "VERIFIED"; why = "the latest check passed and the evidence covers the change" }
  if (level === "VERIFIED" && !accFailed && !accOpen) { level = "ACCEPTED"; why = acc.length ? "every acceptance criterion is MET" : "no acceptance criteria were stated; verified outcome stands" }
  if (level === "VERIFIED" && accOpen && !accFailed) why += ` — ${accOpen} acceptance criterion(s) not checked`
  if (accFailed) why = `${accFailed} acceptance criterion(s) FAILED`
  if (level === "ACCEPTED" && gateOk !== false && !contradictions) { level = "COMPLETE"; why = "accepted, gate passed, no open contradictions" }
  u.completion = { level, why, at: Date.now() }
  return u.completion
}

/**
 * What stands between the current completion level and the one required
 * (agent.requireCompletion). null when nothing does — or when nothing is
 * required: "off", unknown values and anything below VERIFIED are never
 * enforced (IMPLEMENTED/TESTED are not "done" by any reading).
 *
 * Every reason is something the agent can act on. Acceptance criteria are
 * enforced only when a machine can check them (a named command, or "tests
 * pass"); prose criteria are reported elsewhere but never block, because
 * nothing could ever mark them MET.
 *
 * @param {object} [o] { level: {level}, acceptance: [{criterion,status,evidence}] (combine.checkAcceptance) }
 * @returns {null | { required, level, reasons: string[] }}
 */
export function shortfall(u, required, { level = null, acceptance = null } = {}) {
  const req = String(required ?? "").trim().toUpperCase()
  const ri = LEVEL.indexOf(req)
  const VI = LEVEL.indexOf("VERIFIED"), TI = LEVEL.indexOf("TESTED"), AI = LEVEL.indexOf("ACCEPTED")
  if (!u || ri < VI) return null
  const lv = String((level ?? u.completion)?.level ?? "NOT_STARTED")
  const li = LEVEL.indexOf(lv)
  const reasons = []
  if (li < VI) {
    const last = u.state.checks.last
    reasons.push(li < TI
      ? "no check has run on this change — run the project's own check and show it passes"
      : last && last.passed === false
        ? `the latest check did not pass (\`${clean(last.command, 80)}\`) — fix the cause and re-run it`
        : "the checks that ran do not cover the changed files — run a check that exercises them")
  }
  if (ri >= AI) {
    const acc = (Array.isArray(acceptance) ? acceptance : u.items.filter((x) => x.kind === UKIND.ACCEPTANCE).map((x) => ({
      criterion: x.text,
      status: x.type === UTYPE.VERIFIED ? "MET" : x.type === UTYPE.CONTRADICTED ? "FAILED" : "UNCHECKED",
      evidence: x.evidence[x.evidence.length - 1]?.text ?? "not checked yet",
    }))).filter((a) => a.status !== "MET" && criterionKind(a.criterion))
    for (const a of acc.slice(0, 4)) reasons.push(`acceptance ${a.status === "FAILED" ? "FAILED" : "not met"}: ${clean(a.criterion, 140)} — ${clean(a.evidence, 100)}`)
  }
  if (ri >= LEVEL.indexOf("COMPLETE")) {
    for (const q of u.items.filter((x) => x.type === UTYPE.CONTRADICTED && x.kind === UKIND.QUESTION).slice(0, 2)) reasons.push(`open contradiction: ${clean(q.text, 140)}`)
  }
  return reasons.length ? { required: req, level: lv, reasons } : null
}

// ---- use -------------------------------------------------------------------------

const byType = (u, ...types) => u.items.filter((x) => types.includes(x.type))
const byKind = (u, ...kinds) => u.items.filter((x) => kinds.includes(x.kind))
const pct = (c) => (c == null ? "" : ` ${Math.round(c * 100)}%`)

/**
 * The structured block every prompt gets (the single loop's system prompt,
 * every controller segment, every worker). Structured, not a summary — it
 * survives any transcript compaction because it is rebuilt from the record.
 * @param {object} [o] { intents: [{version,text,reason}], extra: string[], compact }
 */
export function formatForPrompt(u, { intents = null, extra = [], compact = false } = {}) {
  if (!u) return ""
  const L = []
  L.push("UNDERSTANDING (one canonical record; original wording is frozen — never silent substitution):")
  const iv = Array.isArray(intents) && intents.length ? intents : [{ version: 1, text: u.intent.said, reason: "original" }]
  L.push(`- Intent v1 (original): ${clean(iv[0].text, 400)}`)
  const cur = iv[iv.length - 1]
  if (cur && cur.version !== iv[0].version) L.push(`- Intent v${cur.version} (${cur.reason ?? "revised"}): ${clean(cur.text, 300)}`)
  if (u.intent.means && u.intent.means !== u.intent.said) L.push(`- what it means (INFERRED${pct(u.intent.confidence)}): ${clean(u.intent.means, 300)}`)
  const sec = (title, list, fmt) => { if (list.length) { L.push(`- ${title}:`); for (const x of list.slice(0, compact ? 4 : 8)) L.push(`  ${fmt(x)}`) } }
  const tag = (x) => `[${x.type}${x.type === UTYPE.EXPLICIT ? "" : pct(x.confidence)}]`
  sec("must not", byKind(u, UKIND.PROHIBITION), (x) => `${tag(x)} ${x.text}`)
  sec("requirements", byKind(u, UKIND.REQUIREMENT, UKIND.CONSTRAINT, UKIND.DELIVERABLE), (x) => `${tag(x)} ${x.text}`)
  if (!compact) sec("implicit (inferred — not the user's words)", byKind(u, UKIND.IMPLICIT), (x) => `${tag(x)} ${x.text}`)
  sec("success / acceptance", byKind(u, UKIND.ACCEPTANCE, UKIND.SUCCESS), (x) => `${tag(x)} ${x.text}`)
  sec("non-goals", byKind(u, UKIND.NON_GOAL), (x) => x.text)
  if (!compact) sec("priorities", byKind(u, UKIND.PRIORITY), (x) => x.text)
  sec("already done (context, not a request)", byKind(u, UKIND.CONTEXT).filter((x) => x.temporal === TEMPORAL.PAST), (x) => x.text)
  const low = byType(u, UTYPE.ASSUMED, UTYPE.INFERRED).filter((x) => x.confidence < 0.6 && x.kind !== UKIND.IMPLICIT)
  sec("assumptions to check in the repository before relying on them", low, (x) => `${tag(x)} ${x.text}`)
  sec("contradicted — do not rely on these", byType(u, UTYPE.CONTRADICTED), (x) => `${x.text}${x.evidence.length ? ` (${x.evidence[x.evidence.length - 1].text})` : ""}`)
  sec("unknowns / ambiguities", byKind(u, UKIND.UNKNOWN, UKIND.AMBIGUITY).filter((x) => x.type !== UTYPE.VERIFIED), (x) => x.text)
  if (u.rejected.length) L.push(`- rejected approaches: ${u.rejected.slice(-4).map((r) => r.text).join("; ")}`)
  if (u.decisions.length && !compact) sec("recent decisions", u.decisions.slice(-4), (d) => `${d.decision}${d.reason ? ` — ${d.reason}` : ""}${d.confidence != null ? pct(d.confidence) : ""}`)
  const st = u.state
  if (st.plan.length) L.push(`- state: ${st.completed.length}/${st.plan.length} step(s) done${st.current ? `, now ${st.current}` : ""}${st.failed.length ? `, failed ${st.failed.join(",")}` : ""}${st.checks.last ? `; last check \`${st.checks.last.command}\` ${st.checks.last.passed ? "passed" : "FAILED"}` : ""}`)
  else if (st.checks.last) L.push(`- state: last check \`${st.checks.last.command}\` ${st.checks.last.passed ? "passed" : "FAILED"}`)
  if (u.knowledge.length && !compact) L.push(`- known about this project (verified): ${u.knowledge.slice(-3).map((k) => k.text).join("; ")}`)
  if (u.drift.length) L.push(`- possible drift: ${u.drift.slice(-2).map((d) => d.why).join("; ")} — re-align with the goal or say why`)
  for (const e of extra) if (e) L.push(e)
  L.push("- types: EXPLICIT = the user said it · INFERRED/ASSUMED = forge's reading (check it) · VERIFIED = evidence · CONTRADICTED = evidence says no. IMPLEMENTED ≠ TESTED ≠ VERIFIED ≠ ACCEPTED ≠ COMPLETE.")
  return L.join("\n")
}

/**
 * `continue`: what we were doing, why, what is done and verified, what
 * remains, what changed — reconstructed from the record, never by replaying.
 */
export function resumeBrief(u, { status = null, drift = null } = {}) {
  if (!u) return ""
  const st = u.state
  const done = st.plan.filter((n) => n.status === "completed").map((n) => n.title)
  const remaining = st.plan.filter((n) => n.status !== "completed").map((n) => `${n.title}${n.status === "failed" ? " (failed last time)" : ""}`)
  const verified = u.items.filter((x) => x.type === UTYPE.VERIFIED && x.kind !== UKIND.CONTEXT).map((x) => x.text)
  const L = ["CONTINUING A TASK — reconstructed from its record (do not redo finished steps, do not restart discovery):"]
  L.push(`- what we are doing: ${clean(u.intent.said, 300)}`)
  if (u.intent.goal && u.intent.goal !== u.intent.said) L.push(`- why: ${clean(u.intent.goal, 240)}`)
  L.push(`- where it stopped: ${status ?? st.phase}${st.current ? ` (in step ${st.current})` : ""}`)
  if (done.length) L.push(`- already done: ${done.slice(0, 8).join("; ")}`)
  if (verified.length) L.push(`- verified: ${verified.slice(0, 5).join("; ")}`)
  if (st.checks.last) L.push(`- last check: \`${st.checks.last.command}\` ${st.checks.last.passed ? "passed" : "FAILED"}`)
  if (remaining.length) L.push(`- remaining: ${remaining.slice(0, 8).join("; ")}`)
  if (u.rejected.length) L.push(`- do not retry: ${u.rejected.slice(-4).map((r) => r.text).join("; ")}`)
  const contra = u.items.filter((x) => x.type === UTYPE.CONTRADICTED)
  if (contra.length) L.push(`- found wrong earlier: ${contra.slice(-3).map((x) => x.text).join("; ")}`)
  if (drift) L.push(`- changed since it stopped: ${drift}`)
  L.push(`- next: ${remaining.length ? `continue with "${remaining[0]}"` : "verify the result and finish"}`)
  return L.join("\n")
}

/**
 * What changed in the understanding since `since` (ms), as a few prompt
 * lines — "" when nothing that matters changed. The single loop builds its
 * system prompt once per run; this is how a later VERIFIED acceptance, a
 * CONTRADICTED assumption, a correction, a drift flag or a rejected approach
 * reaches the model mid-run without rebuilding (and re-billing) the prompt.
 */
export function delta(u, since = 0) {
  if (!u) return ""
  const L = []
  const fresh = (x) => (x?.at ?? 0) > since
  for (const it of u.items) {
    const last = it.evidence[it.evidence.length - 1]
    if (!last || !fresh(last)) continue
    if (it.type === UTYPE.VERIFIED) L.push(`✓ now VERIFIED: ${clean(it.text, 120)} (${clean(last.text, 80)})`)
    else if (it.type === UTYPE.CONTRADICTED) L.push(`✗ now CONTRADICTED — stop relying on it: ${clean(it.text, 120)} (${clean(last.text, 80)})`)
  }
  for (const c of u.corrections.filter(fresh)) if (!L.some((l) => l.includes("CONTRADICTED"))) L.push(`correction: ${clean(c.why, 160)}`)
  for (const d of u.drift.filter(fresh)) L.push(`drift: ${clean(d.why, 140)} — re-align with the goal`)
  for (const r of u.rejected.filter(fresh)) L.push(`rejected approach (do not retry): ${clean(r.text, 120)}`)
  if (!L.length) return ""
  return ["UNDERSTANDING UPDATE (since your last step):", ...L.slice(0, 6).map((l) => `- ${l}`)].join("\n")
}

/** The spec's field names, for `forge tasks --show` and JSON output. */
export function view(u) {
  if (!u) return null
  const texts = (...kinds) => byKind(u, ...kinds).map((x) => ({ text: x.text, type: x.type, confidence: x.confidence }))
  return {
    user_intent: u.intent.said, actual_goal: u.intent.goal, requested_outcome: u.intent.outcome,
    deliverables: texts(UKIND.DELIVERABLE), constraints: texts(UKIND.CONSTRAINT, UKIND.PROHIBITION),
    explicit_requirements: texts(UKIND.REQUIREMENT), implicit_requirements: texts(UKIND.IMPLICIT),
    non_goals: texts(UKIND.NON_GOAL), priorities: texts(UKIND.PRIORITY), assumptions: texts(UKIND.ASSUMPTION),
    unknowns: texts(UKIND.UNKNOWN), ambiguities: texts(UKIND.AMBIGUITY), risks: texts(UKIND.RISK), dependencies: texts(UKIND.DEPENDENCY),
    success_criteria: texts(UKIND.SUCCESS), acceptance_criteria: texts(UKIND.ACCEPTANCE),
    relevant_context: texts(UKIND.CONTEXT), current_state: u.state, expected_state: u.items.filter((x) => x.kind === UKIND.ACCEPTANCE || x.kind === UKIND.SUCCESS).map((x) => x.text),
    decisions: u.decisions, rejected_approaches: u.rejected, evidence: u.evidence, knowledge: u.knowledge,
    confidence: { goal: u.intent.confidence, items: Math.round((u.items.reduce((a, x) => a + x.confidence, 0) / Math.max(1, u.items.length)) * 100) / 100 },
    unresolved_questions: u.items.filter((x) => (x.kind === UKIND.QUESTION || x.kind === UKIND.AMBIGUITY || x.kind === UKIND.UNKNOWN) && x.type !== UTYPE.VERIFIED).map((x) => x.text),
    corrections: u.corrections, drift: u.drift, completion: u.completion,
  }
}

/** Accept a stored record only if it is ours and well-formed. */
export function restoreUnderstanding(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== UNDERSTANDING_VERSION || !raw.intent || !Array.isArray(raw.items) || !raw.state) return null
  for (const k of ["knowledge", "decisions", "rejected", "evidence", "drift", "corrections"]) if (!Array.isArray(raw[k])) raw[k] = []
  raw.state.plan ??= []; raw.state.completed ??= []; raw.state.failed ??= []; raw.state.pending ??= []; raw.state.changedFiles ??= []; raw.state.checks ??= { passed: 0, failed: 0, last: null }
  return raw
}
