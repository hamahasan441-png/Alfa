#!/usr/bin/env node
/**
 * forge — one score, and it has to have room above it (v129).
 *
 * "Is forge getting better?" had no answer. Five harnesses each answered a
 * different question and none of them combined:
 *
 *   bench.js                24 decision-quality cases    100%
 *   perfbench.js            tool microbenchmarks         vs a saved baseline
 *   evalbench.js            was the task SOLVED          needs a provider
 *   agent-benchmark.js      wraps evalbench              NOT_RUN without one
 *   intelligence-benchmark  deterministic integration    its own score
 *
 * bench.js sits at 100% and `tests/test-v29.mjs` pins it there on purpose, so
 * it is a regression guard and cannot be a growth target. benchsuite.js
 * composes the existing harnesses (§36 — not a sixth) and adds a `programme`
 * lane holding what forge cannot do yet.
 *
 * The two properties this suite exists to protect:
 *
 *   1. THE SCORE HAS ROOM ABOVE IT. A benchmark you already pass measures
 *      nothing. If the programme lane ever reaches 100%, either the
 *      capabilities shipped (delete the cases and add harder ones) or someone
 *      weakened them. Either way a human should look.
 *
 *   2. A FAILING PROGRAMME CASE IS NOT A BROKEN BUILD. Those cases fail by
 *      design until the capability ships. If they set the exit code, CI would
 *      be red forever and would stop being read. Only the guard lanes
 *      (capability, speed) can fail the command.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-suite-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const {
  runSuite, formatSuite, PROGRAMME_CASES, LANE, HOW,
  protocolAtLeast, measureBootMs, BOOT_BUDGET_MS, BOOT_BASELINE_MS, TARGET_MCP_PROTOCOL,
} = await import("../benchsuite.js")

console.log("== the programme lane describes real, missing capability ==")
{
  ok(`there are programme cases (${PROGRAMME_CASES.length})`, PROGRAMME_CASES.length >= 8, String(PROGRAMME_CASES.length))
  eq("every case has a stable id", PROGRAMME_CASES.filter((c) => !c.id || typeof c.id !== "string").length, 0)
  eq("every case says WHY it matters", PROGRAMME_CASES.filter((c) => !c.why).length, 0)
  eq("every case declares how strongly it is checked",
    PROGRAMME_CASES.filter((c) => ![HOW.EXERCISED, HOW.SURFACE, HOW.MEASURED].includes(c.how)).length, 0)
  eq("ids are unique", PROGRAMME_CASES.length, new Set(PROGRAMME_CASES.map((c) => c.id)).size)
  eq("every case is runnable", PROGRAMME_CASES.filter((c) => typeof c.check !== "function").length, 0)
}


// v164: two sections ask for the programme lane alone. It is the same call on
// the same tree, and each run is ~25s of real end-to-end cases, so they share
// one result instead of paying for it twice (the suite was at its 120s budget).
let programmeOnce = null
const programmeOnly = () => (programmeOnce ??= runSuite({ cwd: ROOT, only: [LANE.PROGRAMME] }))

console.log("== the room above the benchmark is STRUCTURAL, not a stopwatch ==")
{
  // The lane must stay open for reasons that do not depend on how fast this
  // machine is. A single MEASURED case was all that held it open at v133, and
  // a quick runner closed it, taking two suites red with it.
  //
  // The first version of this guard counted case DECLARATIONS — which would
  // have passed happily in exactly the situation it exists to catch: every
  // deterministic case succeeding while `boot-budget` is the only failure. It
  // has to count what is actually OPEN.
  const prog = await programmeOnly()
  const open = prog.results.filter((r) => !r.ok)
  const openDeterministic = open.filter((r) => r.how !== HOW.MEASURED)
  ok(`at least one OPEN case is deterministic (${openDeterministic.length} of ${open.length} open)`,
    openDeterministic.length > 0,
    `open: ${open.map((r) => `${r.id}(${r.how})`).join(", ") || "none"} — the lane's room rests on a stopwatch`)
}

console.log("== the score has room above it (the whole point) ==")
{
  const s = await runSuite({ cwd: ROOT, only: [LANE.CAPABILITY, LANE.PROGRAMME] })
  ok(`the combined score is below 100% (${s.score}%)`, s.score < 100, `${s.score}%`)
  ok("…because the programme lane is not satisfied yet",
    s.lanes[LANE.PROGRAMME].passed < s.lanes[LANE.PROGRAMME].total,
    JSON.stringify(s.lanes[LANE.PROGRAMME]))
  // If this ever fails, it is GOOD NEWS that needs a human: the capabilities
  // shipped, so retire these cases and write harder ones.
  ok("…and if the programme lane is ever full, that is a prompt to raise the bar",
    s.lanes[LANE.PROGRAMME].passed < s.lanes[LANE.PROGRAMME].total,
    "programme lane is complete — delete the shipped cases and add harder ones")

  // Deliberately NOT asserting the capability lane is 100% here: that is
  // test-v29's job, and duplicating it made this suite fail for a reason that
  // has nothing to do with the scorer. What this suite owns is the COMPOSITION
  // — how lanes are combined, skipped and classified.
  eq("the capability lane is composed in at its full size", s.lanes[LANE.CAPABILITY].total, 24)
}

console.log("== a programme failure is 'not yet', never a regression ==")
{
  // programme ALONE: every case in it fails today, so if programme failures
  // could set `regressed` this would be the loudest possible proof.
  const s = await programmeOnly()
  // NOT "every case is open": that assertion breaks the day a capability
  // ships, which is precisely when the suite should be quiet. What must hold
  // is that open cases exist (room above the benchmark) and that they never
  // count as regressions.
  ok(`the lane still has open cases (${s.notYet}/${s.total})`, s.notYet > 0 && s.total > 0,
    JSON.stringify({ notYet: s.notYet, total: s.total }))
  eq("…and a lane whose failures are all 'not yet' is not a regression", s.regressed, false)
  eq("…and the regression list is empty", s.regressions, [])
  const text = formatSuite(s)
  ok("the report separates 'not yet' from 'REGRESSED'", /not yet \(\d+\)/.test(text) && !/REGRESSED/.test(text), text.slice(0, 160))
  // Keyed to the OPEN cases, whatever they are today — naming one case's
  // `why` string made this assertion fail the moment that capability shipped,
  // which is exactly when the suite should be quiet.
  const openWhy = PROGRAMME_CASES.filter((c) => s.results.some((r) => r.id === c.id && !r.ok)).map((c) => c.why)
  ok(`…and prints why each open case matters (${openWhy.length})`,
    openWhy.length > 0 && openWhy.every((w) => text.includes(String(w).slice(0, 40))), text.slice(0, 400))
}

console.log("== a lane that cannot run is SKIPPED, never passed and never failed ==")
{
  const s = await runSuite({ cwd: ROOT, only: [LANE.PROGRAMME, LANE.AUTONOMY] })
  eq("autonomy without a provider does not run", s.lanes[LANE.AUTONOMY].ran, false)
  ok("…and says so in words", /provider/i.test(String(s.lanes[LANE.AUTONOMY].skipped)), s.lanes[LANE.AUTONOMY].skipped)
  eq("…and contributes nothing to the denominator", s.total, s.lanes[LANE.PROGRAMME].total)
  ok("…and the report shows it as SKIPPED", /autonomy\s+SKIPPED/.test(formatSuite(s)))
  eq("…and a skipped lane is not a regression", s.regressed, false)
}

console.log("== the report and the exit code agree about what a regression IS ==")
{
  // formatSuite counted every non-programme failure while runSuite counted
  // only the guard lanes, so an autonomy failure printed under "REGRESSED —
  // these used to pass" while summary.regressed stayed false and the command
  // exited 0: two contradictory statements about one run, in one report.
  const { GUARD_LANES } = await import("../benchsuite.js")
  // v137 added `discipline`. It guards because every case in it asserts
  // something that holds TODAY, exercised against the real modules — a red one
  // is a regression, which is the whole definition of a guard lane. The
  // programme lane still must NOT be here: it is meant to be red.
  eq("the guard lanes are named once", [...GUARD_LANES].sort(), [LANE.CAPABILITY, LANE.DISCIPLINE, LANE.SPEED].sort())
  eq("the programme lane never guards the exit code", GUARD_LANES.has(LANE.PROGRAMME), false)
  const faked = {
    version: "t", name: "FORGE-SUITE", passed: 1, failed: 1, total: 2, score: 50,
    regressed: false, regressions: [], notYet: 0, ms: 1,
    lanes: { [LANE.AUTONOMY]: { ran: true, passed: 0, total: 1, score: 0 } },
    results: [{ id: "eval-x", name: "x", lane: LANE.AUTONOMY, how: HOW.EXERCISED, ok: false, note: "" }],
  }
  const text = formatSuite(faked)
  ok("an autonomy failure is NOT printed as a regression when the summary says there is none",
    !/REGRESSED/.test(text), text.slice(0, 200))
}

console.log("== the protocol comparison is a date comparison, not a string guess ==")
{
  ok("2025-03-26 satisfies a 2025-03-26 target", protocolAtLeast("2025-03-26", "2025-03-26"))
  ok("a later revision satisfies it", protocolAtLeast("2025-06-18", "2025-03-26"))
  ok("2024-11-05 does NOT", !protocolAtLeast("2024-11-05", "2025-03-26"))
  ok("an empty version never satisfies", !protocolAtLeast("", "2025-03-26") && !protocolAtLeast(null, "2025-03-26"))
  // v131: the target was "2025-03-26", set from memory. Checking it against
  // the specification showed it was wrong twice over — the current revision is
  // 2026-07-28, and 2025-03-26 is itself a LEGACY revision, so reaching the old
  // target would have proved nothing. Two things must hold now: the target is
  // the real modern revision, and the legacy one forge still offers on the
  // fallback path is genuinely on the other side of the line.
  const { PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } = await import("../mcp.js")
  ok(`the target (${TARGET_MCP_PROTOCOL}) is the modern revision forge speaks (${MODERN_PROTOCOL_VERSION})`,
    protocolAtLeast(MODERN_PROTOCOL_VERSION, TARGET_MCP_PROTOCOL))
  ok(`…and the legacy fallback (${PROTOCOL_VERSION}) is on the far side of it`,
    !protocolAtLeast(PROTOCOL_VERSION, TARGET_MCP_PROTOCOL))
}

console.log("== boot is measured on the path that matters, best-of-N ==")
{
  // The first attempt at this measured `time node forge.js --version` ONCE and
  // read 1.0s. Both halves were wrong: one run is mostly cold cache and shell
  // overhead, and --version short-circuits before the agent ever loads.
  const { ms, error } = await measureBootMs({ runs: 3 })
  ok("a boot measurement is produced", error === null && Number.isFinite(ms), String(error))
  ok(`it is a plausible number (${ms}ms)`, ms > 0 && ms < 10000, `${ms}ms`)
  // A budget at or above the cost is a case that can never fail — the
  // vacuous-assertion trap this project keeps catching. But the first version
  // of this check compared the budget against THIS HOST's measurement, which
  // made it a stopwatch: on a fast CI runner the measurement dropped below the
  // budget, `boot-budget` passed, the programme lane filled, and five
  // assertions about "the benchmark has room above it" failed at once — on the
  // same commit that passed on a slower runner minutes earlier.
  //
  // The budget must beat the cost the case was WRITTEN against. That is a
  // property of the code, identical on every machine.
  ok(`the budget (${BOOT_BUDGET_MS}ms) is below the cost this case was written against (${BOOT_BASELINE_MS}ms), so it demands a real reduction`,
    BOOT_BUDGET_MS < BOOT_BASELINE_MS,
    `budget ${BOOT_BUDGET_MS}ms vs baseline ${BOOT_BASELINE_MS}ms — the case asks for nothing`)
  console.log(`       (this host boots in ${ms}ms — reported, never asserted: it is the runner's speed, not the code's)`)
  // best-of-N must not be slower than a single run by construction
  const single = await measureBootMs({ runs: 1 })
  ok("best-of-3 is no worse than best-of-1", ms <= single.ms + 50, `${ms} vs ${single.ms}`)
}

console.log("== `forge bench` exits 0 while the programme lane is open ==")
{
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "forge.js"), ...args],
      { cwd: ROOT, timeout: 180000, env: { ...process.env, NO_COLOR: "1" } },
      // stderr too: the validation errors this suite asserts on are written
      // there, and a helper that drops them can only check the exit code.
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: String(stdout || ""), errOut: String(stderr || "") }))
  })
  // the programme lane fails completely by design — the sharpest test that a
  // "not yet" never sets the exit code
  const r = await run(["bench", "--lane", "programme"])
  eq("forge bench exits 0 while programme cases are still open", r.code, 0)
  ok("…and prints the combined score", /FORGE-SUITE v.*score/.test(r.out), r.out.slice(0, 120))
  ok("…and shows the programme lane's standing", /programme\s+\s*\d+\//.test(r.out), r.out.slice(0, 200))
  ok("…and only that lane is reported", !/capability\s+\d/.test(r.out), r.out.slice(0, 200))

  const full = await run(["bench"])
  ok("the default run names every lane", /capability/.test(full.out) && /programme/.test(full.out), full.out.slice(0, 200))
  ok("…and is the combined report", /FORGE-SUITE/.test(full.out))

  // A mistyped lane ran NOTHING and reported total 0, score 0, regressed
  // false, exit 0 — a typo that reads as a clean benchmark.
  // `!== 0` would also be satisfied by a crash; the validation path exits 1
  // deliberately, and that is what is being pinned.
  const typo = await run(["bench", "--lane", "capabilty"])
  eq("a misspelled --lane exits with a validation error", typo.code, 1)
  // `--lane ","` normalizes to an empty list. It used to print `0/0 score 0%`
  // and exit 0 — a benchmark that ran nothing, reading as a clean one.
  const empty = await run(["bench", "--lane", ","])
  eq("--lane with no usable name is rejected too", empty.code, 1)
  ok("…and says what to pass instead", /--lane needs at least one lane name/.test(`${empty.out}${empty.errOut}`), `${empty.out}${empty.errOut}`.slice(0, 160))

  const c = await run(["bench", "--cases"])
  ok("forge bench --cases still reports the original FORGE-BENCH format",
    /FORGE-BENCH v.*score/.test(c.out), c.out.slice(0, 120))
}

console.log("== the composed harnesses are reused, not reimplemented (§36) ==")
{
  const src = fs.readFileSync(path.join(ROOT, "benchsuite.js"), "utf8")
  for (const [what, re] of [
    ["bench.js", /await import\("\.\/bench\.js"\)/],
    ["perfbench.js", /await import\("\.\/perfbench\.js"\)/],
    ["evalbench.js", /await import\("\.\/evalbench\.js"\)/],
  ]) ok(`${what} is composed, not copied`, re.test(src))
  ok("perf verdicts come from perfbench's own comparison", /comparePerf\(/.test(src))
  ok("…and its saved baseline loader is reused", /loadPerfBaseline\(/.test(src))
  ok("no second copy of the bench cases", !/BENCH_CASES\s*=\s*\[/.test(src))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== benchsuite suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
