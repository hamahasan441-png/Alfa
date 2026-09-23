#!/usr/bin/env node
/**
 * forge v141 — ONE definition of "a lesson strong enough to act on".
 *
 * Before this there were two confidence floors and no name for the concept
 * between them:
 *
 *   lessons.js  LESSON_RETIRE_BELOW = 0.15   "keep it at all"
 *   evolve.js   HARD_AVOID_MIN      = 0.5    "trust it enough to constrain"
 *
 * The second sat among the SKILL_* thresholds in a module about skills, and
 * `compose.js:indexKnow` imported it from there to filter LESSONS — then
 * re-derived the remaining two criteria (a recorded repair, files to check it
 * against) inline. So the answer to "what makes a lesson actionable?" lived in
 * three places and no reader held all of it.
 *
 * This suite is the proof that naming it changed NOTHING. Two claims:
 *
 *   1. `LESSON_PROVEN_MIN` is the number `HARD_AVOID_MIN` always was, and
 *      evolve.js now re-exports it rather than holding a second copy.
 *   2. `lessonMayConstrain` selects exactly what the v140 inline code did —
 *      proved by running the real compose() path over a matrix designed so a
 *      predicate that was too strict OR too loose would disagree.
 *
 * The matrix is the point. A refactor test that only feeds it lessons which
 * pass is furniture: it would still pass if `lessonMayConstrain` were
 * `() => true`. Every rejecting clause gets a lesson that trips only it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tier-home-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const L = await import("../lessons.js")
const E = await import("../evolve.js")
const C = await import("../compose.js")

console.log("== one number, one home ==")
{
  eq("LESSON_PROVEN_MIN", L.LESSON_PROVEN_MIN, 0.5)
  eq("HARD_AVOID_MIN is unchanged", E.HARD_AVOID_MIN, 0.5)
  ok("HARD_AVOID_MIN is the same value, not a copy", E.HARD_AVOID_MIN === L.LESSON_PROVEN_MIN)
  ok("the retire floor is still lower", L.LESSON_RETIRE_BELOW < L.LESSON_PROVEN_MIN)
  // evolve.js must not have re-declared the literal; a second copy is exactly
  // the defect this version removes, and it would still satisfy the checks above.
  const src = fs.readFileSync(new URL("../evolve.js", import.meta.url), "utf8")
  ok("evolve.js holds no second literal", !/HARD_AVOID_MIN\s*=\s*0?\.\d/.test(src))
  ok("evolve.js takes the value from lessons.js", /HARD_AVOID_MIN\s*=\s*LESSON_PROVEN_MIN/.test(src))
}

console.log("== the tiers ==")
{
  eq("below the retire floor", L.lessonTier({ confidence: 0.1 }), L.LESSON_TIER.RETIRED)
  eq("exactly at the retire floor", L.lessonTier({ confidence: 0.15 }), L.LESSON_TIER.ADVISORY)
  eq("between the floors informs only", L.lessonTier({ confidence: 0.3 }), L.LESSON_TIER.ADVISORY)
  eq("just under proven", L.lessonTier({ confidence: 0.49 }), L.LESSON_TIER.ADVISORY)
  eq("exactly at proven", L.lessonTier({ confidence: 0.5 }), L.LESSON_TIER.PROVEN)
  eq("well above proven", L.lessonTier({ confidence: 0.9 }), L.LESSON_TIER.PROVEN)
  // the store's own default when a record predates the confidence field
  eq("a lesson with no confidence uses the 0.6 default", L.lessonTier({}), L.LESSON_TIER.PROVEN)
  eq("a non-numeric confidence is not trusted", L.lessonTier({ confidence: "high" }), L.LESSON_TIER.RETIRED)
  // ?? falls back on null, so a null confidence takes the 0.6 default — the
  // same reading lessonPool has always used. The tier must not disagree with
  // the filter that feeds it; that disagreement is what this version removes.
  eq("null takes the default, as lessonPool reads it", L.lessonTier({ confidence: null }), L.LESSON_TIER.PROVEN)
  eq("a missing lesson takes the default too", L.lessonTier(null), L.LESSON_TIER.PROVEN)
}

console.log("== may this lesson constrain? ==")
{
  const full = { confidence: 0.8, successful_repair: "awaited the refresh", files: ["src/a.js"] }
  ok("confidence + repair + files", L.lessonMayConstrain(full))
  ok("advisory confidence may not constrain", !L.lessonMayConstrain({ ...full, confidence: 0.3 }))
  ok("a retired lesson may not constrain", !L.lessonMayConstrain({ ...full, confidence: 0.05 }))
  ok("no repair may not constrain", !L.lessonMayConstrain({ ...full, successful_repair: "" }))
  ok("a whitespace repair is no repair", !L.lessonMayConstrain({ ...full, successful_repair: "   " }))
  ok("solution counts as a repair", L.lessonMayConstrain({ confidence: 0.8, solution: "sync NTP", files: ["a.js"] }))
  ok("no files may not constrain", !L.lessonMayConstrain({ ...full, files: [] }))
  ok("a missing files array may not constrain", !L.lessonMayConstrain({ ...full, files: undefined }))
  ok("files must be an array, not a string", !L.lessonMayConstrain({ ...full, files: "src/a.js" }))
  ok("an array of empties is no files", !L.lessonMayConstrain({ ...full, files: ["", null] }))
  ok("a missing lesson may not constrain", !L.lessonMayConstrain(null))
}

/**
 * The differential. compose().know is the only consumer, so drive the real
 * path and compare against the v140 selection, re-implemented here from the
 * code this version replaced.
 */
console.log("== compose selects exactly what it selected before ==")
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tier-proj-"))
  fs.writeFileSync(path.join(DIR, "package.json"), JSON.stringify({ name: "tier-fixture" }))

  // Every lesson shares the query's vocabulary so BM25 ranks them all; what
  // separates them is which rejecting clause each one trips.
  const matrix = [
    { name: "proven, repair, relative files", conf: 0.9, repair: "awaited the token refresh", files: ["src/auth.js"], expect: true },
    { name: "exactly at the proven floor", conf: 0.5, repair: "pinned the auth clock", files: ["src/clock.js"], expect: true },
    { name: "advisory confidence", conf: 0.3, repair: "restarted the auth broker", files: ["src/broker.js"], expect: false },
    { name: "proven but no files", conf: 0.9, repair: "re-read the auth spec", files: [], expect: false },
    { name: "proven but only an absolute path", conf: 0.9, repair: "chmod the auth keyring", files: ["/etc/auth/keyring"], expect: false },
    { name: "proven but only an escaping path", conf: 0.9, repair: "moved the auth fixture", files: ["../../auth/fixture.js"], expect: false },
  ]

  for (const m of matrix) {
    L.recordLesson({
      failure: `auth token refresh failure: ${m.name}`,
      cause: "auth token refresh",
      failedStrategy: "retry the auth refresh",
      successfulRepair: m.repair,
      applicableContext: "auth token refresh",
      task: "fix the auth token refresh",
      files: m.files,
      confidence: m.conf,
    }, DIR)
  }

  const stored = L.loadLessons(DIR)
  eq("the fixture stored every lesson", stored.length, matrix.length)

  // --- v140, verbatim in behaviour: the pool floor came from evolve.js and
  // the remaining criteria were re-derived at the call site.
  // KERNEL_HINT is imported, not copied: v141 did not touch it, and §36 says
  // one implementation. relKnowFile is private to compose.js, so the v140
  // shape is restated here — that is what a differential reference is for.
  const { KERNEL_HINT } = await import("../extend.js")
  const relKnowFileV140 = (f) => {
    const s = String(f || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()
    if (!s || s.length > 160) return ""
    if (s.startsWith("/") || s.startsWith("~") || s.includes("://")) return ""
    if (s.split("/").some((p) => p === ".." || p === "")) return ""
    return s
  }
  const v140 = (task) => {
    const hits = L.relevantLessons(task, { cwd: DIR, limit: 4, minConfidence: E.HARD_AVOID_MIN })
    const out = []
    for (const l of hits) {
      if (out.length >= 2) break
      const repair = String(l.successful_repair || l.solution || "").trim()
      if (!repair) continue
      if (KERNEL_HINT.test(repair)) continue
      const files = (Array.isArray(l.files) ? l.files : []).map(relKnowFileV140).filter(Boolean).slice(0, 4)
      if (!files.length) continue
      out.push(repair.slice(0, 240))
    }
    return out
  }

  // MICRO/SMALL skip [know] entirely (compose.js:isMicro), so the task has to
  // be one that actually reaches indexKnow — otherwise both sides return []
  // and the differential proves nothing.
  const TASK = "refactor the auth token refresh across the login service and the gateway, updating every caller and its tests"
  // indexKnow returns {name, repair, files, ...}, not the lesson record, so
  // the repair string is the identity here — unique per matrix row by design.
  const now = (C.compose(TASK, { cwd: DIR }).know || []).map((k) => k.repair)
  const before = v140(TASK)

  ok("the v140 reference selects something", before.length > 0)
  eq("v141 selects the same lessons, in the same order", now, before)

  // Non-vacuity: the matrix must actually be discriminating. If every lesson
  // passed, the comparison above would hold for a predicate of `() => true`.
  const admitted = new Set(now)
  const byName = new Map(matrix.map((m) => [m.name, m.repair]))
  const wouldPass = matrix.filter((m) => m.expect)
  const wouldFail = matrix.filter((m) => !m.expect)
  ok("the matrix contains lessons that must be rejected", wouldFail.length >= 3)
  for (const m of wouldFail) ok(`rejected: ${m.name}`, !admitted.has(m.repair))
  // compose caps [know] at 2, so only assert that the admitted ones come from
  // the passing set — never from the rejected one.
  ok("every admitted lesson is one that should pass", now.every((r) => wouldPass.some((m) => m.repair === r)))
  ok("compose admits at most two", now.length <= 2)

  // The clause compose keeps for itself: lessonMayConstrain accepts a lesson
  // whose only file is absolute (it is a truthy file), and compose still drops
  // it. That local check is load-bearing, not dead code.
  const absRepair = byName.get("proven but only an absolute path")
  const abs = stored.find((l) => l.successful_repair === absRepair)
  ok("the absolute-path lesson is in the store", !!abs)
  ok("lessonMayConstrain accepts the absolute-path lesson", L.lessonMayConstrain(abs))
  ok("compose rejects it anyway", !admitted.has(absRepair))

  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
}

console.log("== an advisory lesson still informs ==")
{
  // The distinction only matters if the middle tier is reachable: a 0.3 lesson
  // must reach the prompt and must not reach the constraint path.
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tier-adv-"))
  L.recordLesson({
    failure: "flaky websocket handshake in the gateway",
    cause: "websocket handshake race",
    failedStrategy: "increase the websocket timeout",
    successfulRepair: "awaited the websocket handshake ack",
    applicableContext: "websocket handshake",
    task: "fix the websocket handshake",
    files: ["src/ws.js"],
    confidence: 0.3,
  }, DIR)
  const q = "fix the flaky websocket handshake in the gateway"
  const informs = L.relevantLessons(q, { cwd: DIR, limit: 3 })
  const constrains = L.relevantLessons(q, { cwd: DIR, limit: 3, minConfidence: L.LESSON_PROVEN_MIN })
  ok("an advisory lesson is retrievable", informs.length === 1)
  eq("its tier", L.lessonTier(informs[0]), L.LESSON_TIER.ADVISORY)
  ok("it may not constrain", !L.lessonMayConstrain(informs[0]))
  ok("the proven floor excludes it", constrains.length === 0)
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== lesson-tiers suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
