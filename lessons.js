/**
 * forge — failure learning (v21, zero dependencies)
 *
 * memory.js already keeps free-form `LEARNING:` bullets in project memory and
 * retrieves them by relevance. This module is the STRUCTURED counterpart the
 * meta controller and agent manager consult BEFORE repeating a strategy:
 *
 *   ~/.forge/projects/<hash>/lessons.json   (per project, bounded)
 *
 * A lesson records the failure, its root cause, the strategy that FAILED, the
 * action that ultimately fixed it, the context it applies to, and a confidence.
 * Before an operation, `ineffectiveStrategies()` answers "have we already
 * proven this exact approach does not work for this kind of problem?" — the
 * controller changes strategy instead of repeating a known dead end.
 *
 * Lessons also flow into the model's context as a compact, relevance-ranked
 * block (reusing memory.js retrieval), so learned fixes are not just stored but
 * used. Everything is redacted and best-effort.
 */
import fs from "node:fs"
import { writeStateFile } from "./securefs.js"
import path from "node:path"
import { projectDir } from "./memory.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import { redact } from "./secrets.js"
import { normalizeCommand } from "./checkcmd.js"
import { loadIndex } from "./index.js"
import { entryIsStale, worldFromIndex } from "./memgraph.js"

const MAX_LESSONS = 300
// v129: was RETIRE_BELOW — see evolve.js SKILL_RETIRE_BELOW (0.25). Same name,
// different number, two importable modules.
export const LESSON_RETIRE_BELOW = 0.15

/**
 * The confidence at which a lesson may CONSTRAIN rather than merely INFORM.
 *
 * Two floors, and until v141 only one of them was named after its subject.
 * `LESSON_RETIRE_BELOW` (0.15) is "keep it at all"; this one is "trust it
 * enough to steer a plan or forbid an approach". A lesson at 0.3 therefore
 * reaches the prompt and does NOT reach the hard-avoid list — which is the
 * right behaviour and stays unchanged here. The defect was that nothing said
 * so: `compose.js` reached into `evolve.js` for `HARD_AVOID_MIN` (a constant
 * sitting among SKILL_* thresholds) and then re-derived the rest of the
 * definition inline, so "what makes a lesson strong enough to act on" was
 * spread across two modules and one call site.
 *
 * evolve.js re-exports this as HARD_AVOID_MIN, so the old name still works
 * and there is still exactly one number. Same v129 lesson the comment above
 * records: when two thresholds exist, the subject belongs in the name.
 */
export const LESSON_PROVEN_MIN = 0.5

/** retired → forgotten; advisory → may inform; proven → may constrain. */
export const LESSON_TIER = Object.freeze({
  RETIRED: "retired",
  ADVISORY: "advisory",
  PROVEN: "proven",
})

/** Which tier a lesson sits in, by confidence alone. */
export function lessonTier(l) {
  const c = Number(l?.confidence ?? 0.6)
  if (!(c >= LESSON_RETIRE_BELOW)) return LESSON_TIER.RETIRED
  return c >= LESSON_PROVEN_MIN ? LESSON_TIER.PROVEN : LESSON_TIER.ADVISORY
}

/**
 * May this lesson CONSTRAIN behaviour — steer a plan, or become a hard avoid?
 *
 * Confidence is necessary and not sufficient. A lesson that names no files
 * cannot be checked against the tree it claims to be about, and one with no
 * recorded repair is an observation rather than a fix. Both were required at
 * the compose.js call site and neither was stated anywhere a second reader
 * would find it.
 */
export function lessonMayConstrain(l) {
  if (lessonTier(l) !== LESSON_TIER.PROVEN) return false
  if (!String(l?.successful_repair || l?.solution || "").trim()) return false
  return Array.isArray(l?.files) && l.files.filter(Boolean).length > 0
}

function lessonsPath(cwd) {
  return path.join(projectDir(cwd), "lessons.json")
}

export function loadLessons(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(lessonsPath(cwd), "utf8"))
    return Array.isArray(j) ? j : Array.isArray(j?.lessons) ? j.lessons : []
  } catch { return [] }
}

function save(cwd, lessons) {
  try {
    const file = lessonsPath(cwd)
    writeStateFile(file, JSON.stringify(lessons.slice(-MAX_LESSONS), null, 1))
    return true
  } catch { return false }
}

/**
 * Structured lesson schema (P1).
 *
 *   failureClass     what KIND of failure this was (test_failure, build_failure,
 *                    tool_timeout, security_block, provider_error, …)
 *   symptoms         how it looked (the error text / command output)
 *   rootCause        why it happened
 *   solution         what fixed it
 *   files / symbols  where it happened
 *   framework        ecosystem it belongs to (node, python, go, rust, …)
 *   confidence       0..1, raised by successes and lowered by failures
 *   successCount     how often the recorded SOLUTION worked
 *   failureCount     how often this lesson was seen failing anyway
 *   firstSeen/lastUsed, model, strategy
 *
 * Learning is scoped: `scope` (default "project") plus `framework`/`files`
 * keep a lesson learned in one project from contaminating an unrelated one.
 */
export const LESSON_SCOPE = { PROJECT: "project", GLOBAL: "global" }

export const FAILURE_CLASS = {
  TEST_FAILURE: "test_failure",
  BUILD_FAILURE: "build_failure",
  SYNTAX_FAILURE: "syntax_failure",
  DEPENDENCY_FAILURE: "dependency_failure",
  TOOL_TIMEOUT: "tool_timeout",
  TOOL_CRASH: "tool_crash",
  SECURITY_BLOCK: "security_block",
  PROVIDER_ERROR: "provider_error",
  VERIFICATION_MISSING: "verification_missing",
  TOOL_MISUSE: "tool_misuse",
  STATE_CORRUPTION: "state_corruption",
  UNKNOWN: "unknown",
}

/** Classify a failure text into a stable failure class. */
// v129: was classifyFailure — diagnose.js owns that name and four modules
// import it. This classifies a lesson's recorded failure text.
export function classifyLessonFailure(text = "") {
  const t = String(text ?? "")
  if (/\btests? failed|assertion|AssertionError|1\)\s/i.test(t)) return FAILURE_CLASS.TEST_FAILURE
  if (/BUILD FAILED|build failed|error TS\d+|compile error|error\[E\d+\]/i.test(t)) return FAILURE_CLASS.BUILD_FAILURE
  if (/SyntaxError|unexpected token|EOL while scanning/i.test(t)) return FAILURE_CLASS.SYNTAX_FAILURE
  if (/Cannot find module|module not found|no such package|npm ERR!|ENOENT/i.test(t)) return FAILURE_CLASS.DEPENDENCY_FAILURE
  if (/timed out|timeout|ETIMEDOUT/i.test(t)) return FAILURE_CLASS.TOOL_TIMEOUT
  if (/segmentation fault|core dumped|panic:|OOM|heap out of memory|SIGKILL/i.test(t)) return FAILURE_CLASS.TOOL_CRASH
  if (/BLOCKED:|permission denied|EACCES|safety/i.test(t)) return FAILURE_CLASS.SECURITY_BLOCK
  // a malformed call is its own class: it was never a provider/state problem,
  // and lumping it into "unknown" hides the single most repeatable failure mode
  if (/did not match the schema|invalid arguments|unknown tool|tool not found|missing required argument|arguments? (were|was) invalid/i.test(t)) return FAILURE_CLASS.TOOL_MISUSE
  if (/provider|HTTP \d\d\d|fetch failed|rate limit|ECONNRESET/i.test(t)) return FAILURE_CLASS.PROVIDER_ERROR
  if (/verification|evidence missing|not verified/i.test(t)) return FAILURE_CLASS.VERIFICATION_MISSING
  if (/corrupt|invalid state|invalid transition|drift/i.test(t)) return FAILURE_CLASS.STATE_CORRUPTION
  return FAILURE_CLASS.UNKNOWN
}

/** Detect the ecosystem a set of files belongs to. */
export function detectFramework(files = [], text = "") {
  const hay = `${(files ?? []).join(" ")} ${String(text ?? "")}`.toLowerCase()
  if (/\.py\b|pytest|pip\b|poetry/.test(hay)) return "python"
  if (/\.go\b|go test|go\.mod/.test(hay)) return "go"
  if (/\.rs\b|cargo|error\[e\d+\]/i.test(hay)) return "rust"
  if (/\.php\b|phpunit|composer\.json|pest/i.test(hay)) return "php"
  if (/\.tsx?\b|\.jsx?\b|npm|node|tsc|vitest|jest/.test(hay)) return "node"
  if (/\.rb\b|rspec|gem/.test(hay)) return "ruby"
  if (/\.java\b|gradle|maven/.test(hay)) return "java"
  return null
}

/**
 * Record a structured lesson.
 * @param l { failure, cause, failedStrategy, failedAction, successfulRepair,
 *            applicableContext, task, confidence (0..1),
 *            failureClass, symptoms, rootCause, solution, files, symbols,
 *            framework, model, strategy, scope }
 */
/**
 * v135 — WHICH attempt was the one that worked.
 *
 * v132 records a lesson when a run ends blocked. That is the cheap half. The
 * expensive, useful half is a run that FAILED THREE TIMES AND THEN SUCCEEDED:
 * that run knows something no amount of reading the final diff recovers —
 * which of the things tried was the one that fixed it. It was thrown away.
 *
 * Nothing has to be guessed, because the loop already records the evidence:
 *
 *   commandChecks[]  { command, passed, step, tail }   — every check it ran
 *   writes[] / writeSteps[]                            — each file, and WHEN
 *
 * A proven repair is a check that FAILED and later PASSED. The files written
 * between those two steps are what changed in between, so they are the repair.
 * That is an observation about this run, not an inference about causes: the
 * same command, same working tree, red then green.
 *
 * Deliberately strict:
 *   - the same command must fail and then pass. A different command passing
 *     proves nothing about the one that was failing.
 *   - only the LAST failure counts. Earlier red/green cycles were superseded.
 *   - a check that never failed is not a repair, and a check still failing at
 *     the end is not one either.
 *
 * @returns {Array<{command, attempts, failures, symptom, failureClass, changed: string[], ran: string[], fromStep, toStep}>}
 *          hardest-won first, so a caller taking [0] gets the most informative.
 */
export function provenRepairs({ commandChecks = [], writes = [], writeSteps = [], commands = [], cwd = process.cwd() } = {}) {
  // v168: one check typed two ways is one check — `npm test` failing and
  // `npm test 2>&1 | tail -20` passing is a repair. Grouped, and named, by
  // the normalized command, so the same failure recorded from two spellings
  // is one lesson (recordLesson dedups on its failure text).
  const byCommand = new Map()
  for (const c of Array.isArray(commandChecks) ? commandChecks : []) {
    const k = normalizeCommand(String(c?.command ?? ""), { cwd })
    if (!k) continue
    if (!byCommand.has(k)) byCommand.set(k, [])
    byCommand.get(k).push(c)
  }
  const out = []
  for (const [command, runs] of byCommand) {
    let lastFail = -1
    for (let i = 0; i < runs.length; i++) if (runs[i]?.passed !== true) lastFail = i
    if (lastFail < 0) continue                                  // never failed: nothing was repaired
    const fixed = runs.slice(lastFail + 1).find((r) => r?.passed === true)
    if (!fixed) continue                                        // still red: not a repair
    const failed = runs[lastFail]
    const fromStep = Number(failed?.step ?? 0)
    const toStep = Number(fixed?.step ?? 0)

    // PREFER THE RECORDED WRITE INDEX OVER STEP ARITHMETIC.
    //
    // agent.js runs one model turn's tool calls through `runBatch()`, so every
    // call in a turn carries the SAME step number. Comparing steps therefore
    // cannot separate a write that happened before the passing check from one
    // that ran beside it — and a write that ran beside the check is not proof
    // of anything, because the check had already started.
    //
    // Each check records `writeIndex` (`writesSoFar.length` at the moment it
    // executed), so the slice between two checks is the writes that actually
    // landed in between, in execution order, batching and all. Exact where the
    // step comparison was an approximation.
    const fromIdx = Number.isInteger(failed?.writeIndex) ? failed.writeIndex : null
    const toIdx = Number.isInteger(fixed?.writeIndex) ? fixed.writeIndex : null
    let changed = []
    if (fromIdx !== null && toIdx !== null && toIdx >= fromIdx) {
      changed = [...new Set(writes.slice(fromIdx, toIdx))]
    } else {
      // Older records (and synthetic ones) carry only steps. Same rule at both
      // ends now: a write sharing a step with EITHER check is excluded, since
      // it cannot be ordered against it.
      for (let i = 0; i < writes.length; i++) {
        const at = Number(writeSteps?.[i] ?? -1)
        if (at > fromStep && at < toStep && !changed.includes(writes[i])) changed.push(writes[i])
      }
    }
    // v156: the state-changing COMMANDS run in between, by the same rule as
    // writes — each check records `commandIndex` (commands run so far), so
    // the slice is exactly what ran after the failure and before the pass.
    // No index, no credit: unlike writes there is no step fallback, because a
    // command sharing a turn with a check cannot be ordered against it.
    const fromCmd = Number.isInteger(failed?.commandIndex) ? failed.commandIndex : null
    const toCmd = Number.isInteger(fixed?.commandIndex) ? fixed.commandIndex : null
    const ran = fromCmd !== null && toCmd !== null && toCmd >= fromCmd
      ? [...new Set((Array.isArray(commands) ? commands : []).slice(fromCmd, toCmd).map(String))]
      : []
    const symptom = String(failed?.tail ?? "").slice(0, 300)
    out.push({
      command, attempts: runs.length,
      failures: runs.filter((r) => r?.passed !== true).length,
      symptom, failureClass: classifyLessonFailure(`${command} ${symptom}`),
      changed: changed.slice(0, 12), ran: ran.slice(-6), fromStep, toStep,
    })
  }
  // hardest-won first: the check that took the most tries taught the most
  return out.sort((a, b) => b.failures - a.failures || b.attempts - a.attempts)
}

export function recordLesson(l = {}, cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const files = Array.isArray(l.files) ? l.files.map((f) => redact(String(f)).slice(0, 200)).slice(0, 20) : []
  const symbols = Array.isArray(l.symbols) ? l.symbols.map((s) => redact(String(s)).slice(0, 120)).slice(0, 20) : []
  const lesson = {
    id: `les-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    at: Date.now(),
    // --- legacy fields (kept: memory.js, prompts and older records use them)
    failure: redact(String(l.failure ?? "")).slice(0, 240),
    cause: redact(String(l.cause ?? "")).slice(0, 240),
    failed_strategy: redact(String(l.failedStrategy ?? l.failed_strategy ?? "")).slice(0, 240),
    failed_action: redact(String(l.failedAction ?? l.failed_action ?? "")).slice(0, 240),
    successful_repair: redact(String(l.successfulRepair ?? l.successful_repair ?? "")).slice(0, 300),
    applicable_context: redact(String(l.applicableContext ?? l.applicable_context ?? l.task ?? "")).slice(0, 300),
    task: redact(String(l.task ?? "")).slice(0, 300),
    // --- structured schema (P1)
    failureClass: l.failureClass ?? classifyLessonFailure(`${l.failure ?? ""} ${l.cause ?? ""}`),
    symptoms: redact(String(l.symptoms ?? l.failure ?? "")).slice(0, 400),
    rootCause: redact(String(l.rootCause ?? l.cause ?? "")).slice(0, 400),
    solution: redact(String(l.solution ?? l.successfulRepair ?? l.successful_repair ?? "")).slice(0, 400),
    files,
    symbols,
    framework: l.framework ?? detectFramework(files, `${l.task ?? ""} ${l.failure ?? ""}`),
    model: l.model ?? null,
    strategy: redact(String(l.strategy ?? l.failed_strategy ?? l.failedStrategy ?? "")).slice(0, 200) || null,
    scope: l.scope === LESSON_SCOPE.GLOBAL ? LESSON_SCOPE.GLOBAL : LESSON_SCOPE.PROJECT,
    successCount: 0,
    failureCount: 0,
    firstSeen: Date.now(),
    lastUsed: Date.now(),
    confidence: clamp01(l.confidence ?? 0.6),
    uses: 0,
  }
  // v157: a proven repair, structured — the check it made pass, and the files
  // or commands that did it — so a later run can tell whether re-applying it
  // still works (lessonOutcomes). Text alone is parsed as a fallback.
  if (typeof l.check === "string" && l.check.trim()) {
    lesson.check = redact(l.check.trim()).slice(0, 300)
    lesson.repair = {
      files: (Array.isArray(l.repairFiles) ? l.repairFiles : []).map((f) => redact(String(f)).slice(0, 200)).slice(0, 12),
      commands: (Array.isArray(l.repairCommands) ? l.repairCommands : []).map((c) => redact(String(c)).slice(0, 200)).slice(0, 6),
    }
  }
  // dedup: an identical failure+failedStrategy lesson already present → bump it
  const existing = lessons.find(
    (x) => x.failure === lesson.failure && x.failed_strategy === lesson.failed_strategy && x.cause === lesson.cause
  )
  if (existing) {
    existing.uses++
    existing.lastUsed = Date.now()
    // confidence is evidence-driven: a lesson that fixed the problem gains
    // confidence, one that keeps failing loses it (and can be retired).
    if (lesson.solution || lesson.successful_repair) {
      existing.successCount = (existing.successCount ?? 0) + 1
      existing.solution = lesson.solution || existing.solution
      existing.successful_repair = lesson.successful_repair || existing.successful_repair
      existing.confidence = round2(Math.min(1, Number(existing.confidence ?? 0.6) + 0.1))
    } else {
      existing.failureCount = (existing.failureCount ?? 0) + 1
      existing.confidence = round2(Math.max(0, Number(existing.confidence ?? 0.6) - 0.15))
    }
    for (const f of lesson.files ?? []) if (!(existing.files ?? []).includes(f)) (existing.files ??= []).push(f)
    for (const sym of lesson.symbols ?? []) if (!(existing.symbols ?? []).includes(sym)) (existing.symbols ??= []).push(sym)
    if (lesson.framework && !existing.framework) existing.framework = lesson.framework
    existing.at = Date.now()
    save(cwd, lessons)
    return { ok: true, id: existing.id, deduped: true, confidence: existing.confidence }
  }
  lessons.push(lesson)
  save(cwd, lessons)
  return { ok: true, id: lesson.id }
}

function round2(n) { return Math.round(n * 100) / 100 }

function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0.6
  return Math.max(0, Math.min(1, v))
}

/** v40: promote / retire a lesson by id. Disk is not deleted. */
export function setLessonConfidence(id, value, cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const l = lessons.find((x) => x.id === id)
  if (!l) return { ok: false }
  l.confidence = clamp01(value)
  l.lastUsed = Date.now()
  save(cwd, lessons)
  return { ok: true, id: l.id, confidence: l.confidence }
}

/**
 * v157 — the check and the repair a lesson claims: { check, files, commands },
 * or null when it records no proven repair. From the structured fields
 * recordLesson has stored since v157, else parsed from the text v135/v156
 * wrote ("npm test failed N time(s) before passing" / "changed a.js; ran
 * `node setup.js` — after which `npm test` passed"), so lessons already on
 * disk take part too.
 */
export function lessonRepair(l = {}) {
  if (typeof l.check === "string" && l.check && l.repair && typeof l.repair === "object") {
    const files = Array.isArray(l.repair.files) ? l.repair.files.map(String) : []
    const commands = Array.isArray(l.repair.commands) ? l.repair.commands.map(String) : []
    return files.length || commands.length ? { check: l.check, files, commands } : null
  }
  const text = String(l.successful_repair ?? "")
  const m = /^(.*) — after which `([^`]+)` passed$/.exec(text)
  if (!m) return null
  const files = [], commands = []
  for (const part of m[1].split("; ")) {
    if (part.startsWith("changed ")) files.push(...part.slice(8).split(", ").map((f) => f.trim()).filter(Boolean))
    else if (part.startsWith("ran ")) commands.push(...[...part.matchAll(/`([^`]+)`/g)].map((x) => x[1]))
  }
  return files.length || commands.length ? { check: m[2], files, commands } : null
}

/**
 * v157 — DID A LESSON THAT WAS TRIED AGAIN STILL WORK?
 *
 * A lesson's confidence moved only when the same failure was recorded again
 * (recordLesson's dedup). Measured: a run re-ran a lesson's repair, the check
 * it names still failed, and the lesson stayed exactly as trusted — offered
 * to every later run as "fix that worked".
 *
 * Pure: given one run's evidence, which lessons were RE-APPLIED (a repair
 * file written, or a repair command run, in this run) and what the lesson's
 * own check said AFTERWARDS — after the latest re-applied part, by the same
 * execution-order indices provenRepairs uses. The LAST such check decides.
 * No re-application, or no check after it: no signal, and nothing is said.
 *
 * @returns {Array<{ id, worked: boolean, check }>}
 */
export function lessonOutcomes({ lessons = [], commandChecks = [], writes = [], commands = [], cwd = process.cwd(), skip = [] } = {}) {
  const out = []
  const skipped = new Set(skip)
  const abs = (f) => path.resolve(cwd, String(f))
  const written = (Array.isArray(writes) ? writes : []).map(abs)
  // v168: compared as the same command typed differently is the same command
  // (`node ./setup.js` re-applies a lesson that says `node setup.js`)
  const norm = (c) => normalizeCommand(c, { cwd })
  const ran = (Array.isArray(commands) ? commands : []).map(norm)
  for (const l of Array.isArray(lessons) ? lessons : []) {
    if (!l?.id || skipped.has(l.id)) continue
    const rep = lessonRepair(l)
    if (!rep) continue
    const lastWrite = Math.max(-1, ...rep.files.map((f) => written.lastIndexOf(abs(f))))
    const lastCmd = Math.max(-1, ...rep.commands.map((c) => ran.lastIndexOf(norm(c))))
    if (lastWrite < 0 && lastCmd < 0) continue // not re-applied: no evidence either way
    const after = (Array.isArray(commandChecks) ? commandChecks : []).filter((c) =>
      norm(String(c?.command ?? "")) === norm(rep.check) &&
      (lastWrite < 0 || (Number.isInteger(c.writeIndex) && c.writeIndex > lastWrite)) &&
      (lastCmd < 0 || (Number.isInteger(c.commandIndex) && c.commandIndex > lastCmd)))
    const last = after.at(-1)
    if (!last) continue // re-applied but never checked: no evidence either way
    out.push({ id: l.id, worked: last.passed === true, check: rep.check })
  }
  return out
}

/** v157: step a lesson's standing on one re-application's outcome. */
export const LESSON_OUTCOME_CREDIT = 0.1
export const LESSON_OUTCOME_BLAME = 0.15

export function recordLessonOutcome(id, worked, cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const l = lessons.find((x) => x.id === id)
  if (!l) return { ok: false }
  const from = Number(l.confidence ?? 0.6)
  if (worked) {
    l.successCount = (l.successCount ?? 0) + 1
    l.confidence = round2(clamp01(from + LESSON_OUTCOME_CREDIT))
  } else {
    l.failureCount = (l.failureCount ?? 0) + 1
    l.confidence = round2(clamp01(from - LESSON_OUTCOME_BLAME))
  }
  l.lastUsed = Date.now()
  save(cwd, lessons)
  return { ok: true, id, from, to: l.confidence, retired: l.confidence < LESSON_RETIRE_BELOW }
}

/** Merge duplicate failure+strategy rows. Keep provenance ids. Disk not dropped. */
export function consolidateLessons(cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const map = new Map()
  for (const l of lessons) {
    const key = `${l.failure || ""}|${l.failed_strategy || ""}|${l.cause || ""}`
    if (!map.has(key)) {
      map.set(key, { ...l, provenance: Array.isArray(l.provenance) ? [...l.provenance] : [l.id] })
      continue
    }
    const e = map.get(key)
    const ids = new Set([...(e.provenance || []), l.id, ...(l.provenance || [])])
    e.provenance = [...ids].slice(0, 12)
    e.uses = (e.uses || 0) + (l.uses || 0) + 1
    e.successCount = (e.successCount || 0) + (l.successCount || 0)
    e.failureCount = (e.failureCount || 0) + (l.failureCount || 0)
    e.confidence = Math.max(Number(e.confidence || 0), Number(l.confidence || 0))
    e.solution = e.solution || l.solution
    e.successful_repair = e.successful_repair || l.successful_repair
    for (const f of l.files || []) if (!(e.files || []).includes(f)) (e.files ??= []).push(f)
    if ((l.lastUsed || 0) > (e.lastUsed || 0)) e.lastUsed = l.lastUsed
  }
  const next = [...map.values()]
  save(cwd, next)
  return { ok: true, before: lessons.length, after: next.length }
}

/**
 * Strategies already proven ineffective for a task/context. Returns lessons
 * whose failed strategy matches, relevance-ranked, so the controller can avoid
 * repeating them. `strategyHint` (e.g. "retry", tool name) narrows the match.
 */
export function ineffectiveStrategies(query, { cwd = process.cwd(), strategyHint = "", limit = 5, framework = null, minConfidence = 0 } = {}) {
  let lessons = loadLessons(cwd).filter((l) => l.failed_strategy || l.failed_action)
  // scoping: a lesson learned against a different ecosystem is not evidence
  // here — it must not contaminate an unrelated project's strategy choices.
  if (framework) lessons = lessons.filter((l) => !l.framework || l.framework === framework)
  if (minConfidence > 0) lessons = lessons.filter((l) => Number(l.confidence ?? 0) >= minConfidence)
  else lessons = lessons.filter((l) => Number(l.confidence ?? 0.6) >= LESSON_RETIRE_BELOW)
  lessons = lessons.filter((l) => !lessonIsStale(l, cwd))
  if (!lessons.length) return []
  const scored = rankDocs(String(query ?? "") + " " + String(strategyHint ?? ""), lessons.map((l, i) => ({ i, text: `${l.failure} ${l.cause} ${l.failed_strategy} ${l.failed_action} ${l.applicable_context}` })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => lessons[r.i])
  // a direct strategy-name match always counts even with a weak text score
  if (strategyHint) {
    const hint = String(strategyHint).toLowerCase().trim()
    const words = hint.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
    const matches = (v) => {
      const s2 = String(v ?? "").toLowerCase()
      if (!s2) return false
      if (s2 === hint || s2.includes(hint) || hint.includes(s2)) return true
      return words.some((w) => s2.includes(w))
    }
    // an EXACT strategy-name match always counts; a token overlap counts too,
    // so "re-run" still warns about "re-run until green" (near-miss strategies
    // are exactly the ones an otherwise-honest agent repeats).
    const direct = lessons.filter((l) => matches(l.failed_strategy) || matches(l.failed_action) || matches(l.strategy))
    for (const d of direct) if (!scored.includes(d)) scored.unshift(d)
  }
  return scored.slice(0, limit)
}

/**
 * Lessons with a known successful repair, relevance-ranked (for context).
 *
 * v155 — `includeStale`. A lesson naming a file is stale once that file has
 * changed since it was learned, and by default it is dropped: that stays the
 * rule for every caller that lets a lesson CONSTRAIN something (compose.js,
 * the strategies to avoid), because evidence about an older tree must not
 * steer a newer one.
 *
 * It was also the rule for the prompt, where a lesson only INFORMS, and there
 * it lost what the lessons are for. Measured with real headless runs: a fix
 * one run proved (`npm test` red, lib.js changed, green) was shown to the
 * next run only until lib.js was touched again, by anything. When the same
 * bug came back, which is when that lesson is worth most, it was gone.
 *
 * With `includeStale`, stale lessons come back as copies marked `stale`, and
 * only AFTER every fresh one, so they fill slots fresh knowledge leaves
 * empty and never displace it. The prompt says they may no longer apply.
 */
export function relevantLessons(query, { cwd = process.cwd(), limit = 3, framework = null, minConfidence = 0, includeStale = false } = {}) {
  return rankedLessons(query, { cwd, framework, minConfidence, includeStale }).slice(0, limit)
}

/** Relevance-ranked (BM25) lessons with a repair; fresh first, then stale. */
function rankedLessons(query, { cwd, framework, minConfidence, includeStale }) {
  const lessons = lessonPool(query, { cwd, framework, minConfidence, needRepair: true, includeStale })
  if (!lessons.length) return []
  const hits = rankDocs(String(query), lessonDocs(lessons))
    .filter((r) => r.score > 0)
    .map((r) => lessons[r.i])
  return freshFirst(hits)
}

/** Stable partition: fresh lessons in their order, then stale ones in theirs. */
function freshFirst(lessons) {
  return [...lessons.filter((l) => !l.stale), ...lessons.filter((l) => l.stale)]
}

/**
 * v24: BM25 shortlist, embeddings REORDER only. No embedder / failure → the
 * exact relevantLessons() result. Never widens the shortlist. Never throws.
 */
export async function relevantLessonsAsync(query, {
  cwd = process.cwd(), limit = 3, framework = null, minConfidence = 0,
  embedder = null, alpha, budgetMs = 4000, includeStale = false,
} = {}) {
  const ranked = rankedLessons(query, { cwd, framework, minConfidence, includeStale })
  const bm = ranked.slice(0, limit)
  if (!embedder || typeof embedder.embed !== "function" || !bm.length) return bm
  try {
    // shortlist = BM25's top (limit*4), embeddings only reorder that slice
    const shortN = Math.max(limit * 4, 8)
    const short = ranked.slice(0, shortN)
    if (!short.length) return bm
    const hybrid = await rankDocsHybrid(String(query), short.map((l) => ({ text: lessonText(l), ref: l })), {
      embed: (texts) => embedder.embed(texts),
      alpha,
      budgetMs,
    })
    const out = []
    const seen = new Set()
    for (const r of hybrid) {
      if (!r.ref || seen.has(r.ref) || !short.includes(r.ref)) continue
      seen.add(r.ref)
      out.push(r.ref)
    }
    // embeddings reorder within fresh and within stale, never across them
    const ordered = freshFirst(out).slice(0, limit)
    return ordered.length ? ordered : bm
  } catch {
    return bm
  }
}

/**
 * Compact, model-facing block of relevant learned fixes. "" when none.
 * v155: informs, never constrains, so stale lessons are included (after
 * fresh ones, and labelled) unless the caller says otherwise.
 */
export function lessonsForPrompt(query, opts = {}) {
  return formatLessons(relevantLessons(query, { includeStale: true, ...opts }))
}

/**
 * v28 — lessons that STEER a plan, not just a repair. Same retrieval as
 * the context engine (BM25; embeddings reorder elsewhere). Never promotes
 * an assumption to a requirement — this is advisory text for the planner.
 */
export function lessonsForPlan(query, opts = {}) {
  const hits = relevantLessons(query, { includeStale: true, ...opts, limit: opts.limit ?? 4 })
  const avoided = ineffectiveStrategies(query, { ...opts, limit: opts.limit ?? 4 })
  return {
    text: formatLessons(hits),
    avoided: avoided.map((l) => l.failed_strategy || l.failed_action || l.strategy).filter(Boolean),
    count: hits.length,
  }
}

export async function lessonsForPromptAsync(query, opts = {}) {
  return formatLessons(await relevantLessonsAsync(query, { includeStale: true, ...opts }))
}

/**
 * Async twin of ineffectiveStrategies. Embeddings reorder the BM25 hits;
 * the direct strategy-name match still always counts. Failure → BM25.
 */
export async function ineffectiveStrategiesAsync(query, {
  cwd = process.cwd(), strategyHint = "", limit = 5, framework = null,
  minConfidence = 0, embedder = null, alpha, budgetMs = 4000,
} = {}) {
  const bm = ineffectiveStrategies(query, { cwd, strategyHint, limit, framework, minConfidence })
  if (!embedder || typeof embedder.embed !== "function" || !bm.length) return bm
  try {
    const ranked = await rankDocsHybrid(
      String(query ?? "") + " " + String(strategyHint ?? ""),
      bm.map((l) => ({ text: `${l.failure} ${l.cause} ${l.failed_strategy} ${l.failed_action} ${l.applicable_context}`, ref: l })),
      { embed: (texts) => embedder.embed(texts), alpha, budgetMs },
    )
    const out = []
    const seen = new Set()
    for (const r of ranked) {
      if (!r.ref || seen.has(r.ref) || !bm.includes(r.ref)) continue
      seen.add(r.ref)
      out.push(r.ref)
    }
    return out.length ? out.slice(0, limit) : bm
  } catch {
    return bm
  }
}

export function lessonStats(cwd = process.cwd()) {
  const lessons = loadLessons(cwd)
  const byClass = {}
  for (const l of lessons) byClass[l.failureClass ?? "unknown"] = (byClass[l.failureClass ?? "unknown"] ?? 0) + 1
  return {
    total: lessons.length,
    withRepair: lessons.filter((l) => l.successful_repair || l.solution).length,
    byClass,
    avgConfidence: lessons.length
      ? Math.round((lessons.reduce((a, l) => a + Number(l.confidence ?? 0), 0) / lessons.length) * 100) / 100
      : 0,
    retired: lessons.filter((l) => Number(l.confidence ?? 1) <= 0.15).length,
    path: lessonsPath(cwd),
  }
}

function lessonPool(query, { cwd, framework, minConfidence, needRepair, includeStale = false }) {
  if (!String(query ?? "").trim()) return []
  let lessons = loadLessons(cwd)
  if (needRepair) lessons = lessons.filter((l) => l.successful_repair || l.solution)
  if (framework) lessons = lessons.filter((l) => !l.framework || l.framework === framework)
  const floor = Number(minConfidence) > 0 ? Number(minConfidence) : LESSON_RETIRE_BELOW
  lessons = lessons.filter((l) => Number(l.confidence ?? 0.6) >= floor)
  if (!includeStale) return lessons.filter((l) => !lessonIsStale(l, cwd))
  // copies: `stale` describes this tree, never the stored lesson
  return lessons.map((l) => (lessonIsStale(l, cwd) ? { ...l, stale: true } : l))
}

function lessonAsOf(l) {
  const raw = l.lastUsed || l.last_used || l.firstSeen || l.first_seen || l.at
  if (raw == null) return 0
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

/** A lesson about files is stale when the v32 index (or a graph neighbor) changed after it was recorded. No files / no index → not stale. */
export function lessonIsStale(l, cwd = process.cwd()) {
  const files = Array.isArray(l?.files) ? l.files.map(String).filter(Boolean) : []
  if (!files.length) return false
  const asOf = lessonAsOf(l)
  if (!asOf) return false
  let world
  try { world = worldFromIndex(loadIndex(cwd)) } catch { return false }
  if (!Object.keys(world.writes || {}).length) return false
  return entryIsStale({ files, asOf, text: lessonText(l) }, world)
}

function lessonText(l) {
  return `${l.failure} ${l.cause} ${l.successful_repair} ${l.applicable_context} ${l.task}`
}

function lessonDocs(lessons) {
  return lessons.map((l, i) => ({ i, text: lessonText(l) }))
}

/**
 * v132 — this rendered the one field a lesson might not have.
 *
 * `lessonPool({ needRepair: true })` admits a lesson on `successful_repair`
 * OR `solution`, and `recordLesson` has taken `solution` as a first-class
 * field since the P1 schema. A lesson recorded with only `solution` therefore
 * passed the filter and then printed
 *
 *     - failure: build broke • cause: bad import • fix that worked:
 *
 * — the single piece of knowledge it carried, dropped at the last step, with
 * the empty string still introduced as a fix that worked.
 *
 * The two are also not the same claim, and flattening them would be the other
 * way to be wrong: `successful_repair` is something that DID repair it,
 * `solution` may be the next step nobody has run yet. An unproven lesson says
 * so, so the model can weigh it accordingly.
 */
function formatLessons(hits) {
  if (!hits.length) return ""
  return "LEARNED FROM PAST FAILURES (do not repeat the failed approach):\n" + hits.map((l) => `- ${lessonLine(l)}`).join("\n")
}

/**
 * One lesson as the model reads it. v155: the ONE renderer — engmemory.js's
 * retrieval block, which is how a plain `forge agent` run actually sees
 * lessons, had its own `failure: solution` line, so a blocked run's unproven
 * next step reached the model looking exactly like a fix (the mistake v132
 * corrected here, in the renderer those runs never call), and the symptom
 * that identifies a returning bug was left out.
 */
export function lessonLine(l = {}) {
  const proven = String(l.successful_repair ?? "").trim()
  const proposed = String(l.solution ?? "").trim()
  const fix = proven ? `fix that worked: ${proven}`
    : proposed ? `not repaired — the next step recorded was: ${proposed}`
    : "no repair recorded"
  const files = (Array.isArray(l.files) ? l.files : []).map((f) => path.basename(String(f))).filter(Boolean).slice(0, 3)
  const stale = l.stale ? ` • (learned before ${files.length ? files.join(", ") : "the files it names"} last changed — check it still applies)` : ""
  // v157: what re-applying it did since, so a fix that stopped working says so
  const wins = Number(l.successCount ?? 0), losses = Number(l.failureCount ?? 0)
  const since = wins > 0 || losses > 0 ? ` • since: worked ${wins}×, failed ${losses}×` : ""
  // The fix before the cause, and the cause capped: continuity.js caps the
  // whole engineering-memory block at 700 characters, so whatever comes last
  // is what a long line loses. A recorded cause is often a command's output
  // tail, whose error is at its END — so a long one keeps its end.
  const raw = String(l.cause || "?")
  const cause = raw.length > LESSON_CAUSE_CHARS ? `…${raw.slice(-(LESSON_CAUSE_CHARS - 1))}` : raw
  return `failure: ${l.failure || "?"} • ${fix}${since}${stale} • cause: ${cause}`
}

/** v155: how much of a lesson's cause a prompt line carries. */
export const LESSON_CAUSE_CHARS = 200
