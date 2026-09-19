#!/usr/bin/env node
/**
 * forge — the context budget says when it hit its bound (v124).
 *
 * The context engine assembles sections (profile, repo map, memory, learnings,
 * lessons, skills, cross-refs, requested files) in priority order and fits them
 * to a token budget, dropping whatever does not fit. That is the right policy.
 * Not saying so was the bug.
 *
 * Three things were wrong, and they compounded:
 *
 *   1. the fit loop set `s.dropped = true` and then `continue`d — on an object
 *      it never pushed anywhere, so the marker died with the local;
 *   2. `sections` therefore carried only survivors, and the
 *      `kept.filter(s => !s.dropped)` that built the text could never match;
 *   3. `budgetOverflow`, added in v96 with the comment "the caller must be
 *      able to see that", had no reader anywhere in the tree.
 *
 * All three callers (`segment`, `repair`, `verification`) read `.text` and
 * discarded the rest. Measured on this checkout at a 800-token budget, the repo
 * map — 980 of 1099 available tokens, 89% of the context — was dropped, and a
 * segment that ran without it was indistinguishable in the run log from a repo
 * that never had one.
 *
 * Now the build returns a fit record and `buildContextBlock` in meta.js emits
 * CONTEXT_TRUNCATED when the context did not fit. This is a signal, never a
 * failure: a context that does not fit is still the best context available, so
 * the build is returned unchanged and the run continues either way.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ctxfit-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const { createContextEngine } = await import("../context.js")
// fileURLToPath, not .pathname (which keeps percent-escapes and is not a
// native Windows path)
const REPO = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const eng = createContextEngine({ cwd: REPO, config: {} })

console.log("== a build that fits says so, and reports no loss ==")
{
  const r = await eng.buildAsync("fix the shell guard", { budgetTokens: 60000 })
  ok("fitsBudget is true when everything was kept", r.fitsBudget === true, JSON.stringify(r.dropped))
  eq("nothing is reported dropped", r.dropped, [])
  eq("and no tokens were lost", r.droppedTokens, 0)
  ok("budgetOverflow is absent, not false-y noise", !("budgetOverflow" in r))
  ok("the budget travels with the result", r.budget === 60000, String(r.budget))
  ok("used tokens are within the budget", r.tokens <= r.budget, `${r.tokens}/${r.budget}`)
}

console.log("== a section that does not fit is NAMED, not silently lost ==")
{
  // pick a budget that keeps the cheap sections and forces out the repo map
  const full = await eng.buildAsync("fix the shell guard", { budgetTokens: 60000 })
  const biggest = [...full.sections].sort((a, b) => b.tokens - a.tokens)[0]
  ok("this checkout has a section big enough to test with", Boolean(biggest), JSON.stringify(full.sections.map((s) => s.name)))
  const tight = await eng.buildAsync("fix the shell guard", { budgetTokens: Math.max(1, biggest.tokens - 1) })

  ok("fitsBudget is false when something was dropped", tight.fitsBudget === false)
  ok("the dropped section is named", tight.dropped.some((d) => d.name === biggest.name),
    JSON.stringify(tight.dropped))
  ok("…with its token cost, so the size of the loss is visible",
    tight.dropped.every((d) => Number.isFinite(d.tokens) && d.tokens > 0), JSON.stringify(tight.dropped))
  eq("droppedTokens is the sum of what was dropped",
    tight.droppedTokens, tight.dropped.reduce((a, d) => a + d.tokens, 0))
  ok("the dropped section is NOT in the kept list", !tight.sections.some((s) => s.name === biggest.name))
  ok("and its text is NOT in the rendered block", !tight.sections.some((s) => s.name === biggest.name && tight.text.includes(s.text)))
  ok("what survived still fits the budget", tight.tokens <= tight.budget, `${tight.tokens}/${tight.budget}`)

  // the regression itself: the loss must be recoverable from the result alone
  const lost = full.sections.filter((s) => !tight.sections.some((k) => k.name === s.name)).map((s) => s.name)
  ok("every section the tight build lost is accounted for in `dropped`",
    lost.every((n) => tight.dropped.some((d) => d.name === n)), `lost=${lost} dropped=${tight.dropped.map((d) => d.name)}`)
}

console.log("== an oversized FIRST section is kept, and admits it ==")
{
  // the first section is always kept — an empty context helps nobody — but a
  // silent 3x overflow is not "fit", so it must be flagged.
  const r = await eng.buildAsync("x", { budgetTokens: 1 })
  ok("the block is not empty", r.text.length > 0, String(r.text.length))
  ok("one section survived", r.sections.length >= 1, String(r.sections.length))
  ok("budgetOverflow is set", r.budgetOverflow === true, JSON.stringify(Object.keys(r)))
  ok("…and it really is over budget", r.tokens > r.budget, `${r.tokens}/${r.budget}`)
  ok("fitsBudget is false for an overflow too", r.fitsBudget === false)
}

console.log("== the fit record is on every build, sync and async alike ==")
{
  for (const [label, r] of [["buildAsync", await eng.buildAsync("x", { budgetTokens: 4000 })],
                            ["build", eng.build("x", { budgetTokens: 4000 })]]) {
    for (const k of ["budget", "dropped", "droppedTokens", "fitsBudget"]) {
      ok(`${label}() returns ${k}`, k in r, JSON.stringify(Object.keys(r)))
    }
    ok(`${label}(): dropped is an array`, Array.isArray(r.dropped))
    ok(`${label}(): fitsBudget is a boolean`, typeof r.fitsBudget === "boolean")
  }
}

console.log("== meta.js routes every build through the reporting helper ==")
{
  const src = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  ok("the helper exists", /async function buildContextBlock\(/.test(src))
  ok("it emits CONTEXT_TRUNCATED", /type: "CONTEXT_TRUNCATED"/.test(src))
  ok("it only reports when the context did NOT fit", /built\.fitsBudget === false/.test(src))
  ok("emitting can never break a task", /catch \{ \/\* telemetry must never break a task \*\/ \}/.test(src))

  // no caller may go around it — that is how the signal died the first time
  const raw = [...src.matchAll(/ctxEngine\.buildAsync\(/g)].length
  eq("exactly one ctxEngine.buildAsync call remains (inside the helper)", raw, 1)
  const idx = src.indexOf("ctxEngine.buildAsync(")
  const helperAt = src.indexOf("async function buildContextBlock(")
  ok("…and it is the one inside the helper", idx > helperAt && idx - helperAt < 400)

  // `await` excludes the function's own definition line
  const calls = [...src.matchAll(/await buildContextBlock\(ctxEngine,/g)].length
  ok(`all three callsites use the helper (found ${calls})`, calls === 3, String(calls))
  for (const phase of ["segment", "repair", "verification"]) {
    ok(`the "${phase}" phase is labelled`, new RegExp(`phase: "${phase}"`).test(src))
  }
}

console.log("== the helper emits exactly when it should, and nothing when it fits ==")
{
  // run the real helper source against the real engine
  const src = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("async function buildContextBlock"), src.indexOf("async function repairSegment"))
  const buildContextBlock = vm.runInNewContext(`(${body.trim()})`, {})

  const seen = []
  const emit = (e) => seen.push(e)
  const ids = { emit, phase: "segment", taskId: "t1", runId: "r1", segmentId: 2, nodeId: null }

  const fitted = await buildContextBlock(eng, "fix the shell guard", { budgetTokens: 60000 }, ids)
  eq("a context that fits emits nothing", seen.length, 0)
  ok("…and the build result is returned unchanged", fitted.fitsBudget === true && typeof fitted.text === "string")

  const full = await eng.buildAsync("fix the shell guard", { budgetTokens: 60000 })
  const biggest = [...full.sections].sort((a, b) => b.tokens - a.tokens)[0]
  const tight = await buildContextBlock(eng, "fix the shell guard", { budgetTokens: Math.max(1, biggest.tokens - 1) }, ids)

  eq("a context that did not fit emits one event", seen.length, 1)
  const ev = seen[0]
  eq("…of the right type", ev.type, "CONTEXT_TRUNCATED")
  ok("it carries the run identity", ev.taskId === "t1" && ev.runId === "r1" && ev.segmentId === 2)
  ok("it names the phase", ev.phase === "segment")
  ok("it names what was dropped", Array.isArray(ev.dropped) && ev.dropped.includes(biggest.name), JSON.stringify(ev.dropped))
  ok("it quantifies the loss", ev.droppedTokens > 0, String(ev.droppedTokens))
  ok("it reports budget and usage", ev.budget > 0 && ev.used >= 0, `${ev.used}/${ev.budget}`)
  ok("the reason is a readable sentence naming the budget",
    typeof ev.reason === "string" && ev.reason.includes(String(ev.budget)), ev.reason)
  ok("and the caller still gets the block — truncation is a signal, not a failure",
    typeof tight.text === "string" && tight.text.length > 0)

  // an overflow reports the distinct reason
  seen.length = 0
  await buildContextBlock(eng, "x", { budgetTokens: 1 }, ids)
  ok("an oversized first section reports budgetOverflow", seen[0]?.budgetOverflow === true, JSON.stringify(seen[0]))
  ok("…with a reason that says it was kept anyway", /kept anyway/.test(String(seen[0]?.reason)), String(seen[0]?.reason))
}

console.log("== the helper is defensive: a broken sink never breaks a task ==")
{
  const src = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("async function buildContextBlock"), src.indexOf("async function repairSegment"))
  const buildContextBlock = vm.runInNewContext(`(${body.trim()})`, {})

  let threw = false
  try {
    await buildContextBlock(eng, "x", { budgetTokens: 1 }, { emit: () => { throw new Error("sink is down") }, phase: "segment" })
  } catch { threw = true }
  ok("an emit that throws does not propagate", threw === false)

  threw = false
  try { await buildContextBlock(eng, "x", { budgetTokens: 1 }, {}) } catch { threw = true }
  ok("no emit at all is fine", threw === false)

  threw = false
  let out = null
  try { out = await buildContextBlock(eng, "x", { budgetTokens: 1 }) } catch { threw = true }
  ok("no options object at all is fine", threw === false && out !== null)

  // a build result that is a bare string (the documented legacy shape) must pass through
  threw = false
  try {
    out = await buildContextBlock({ buildAsync: async () => "just a string" }, "x", {}, { emit: () => { throw new Error("nope") } })
  } catch { threw = true }
  ok("a string build result passes through untouched", threw === false && out === "just a string")
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== context-fit suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
