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
  protocolAtLeast, measureBootMs, BOOT_BUDGET_MS, TARGET_MCP_PROTOCOL,
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
  const s = await runSuite({ cwd: ROOT, only: [LANE.PROGRAMME] })
  ok(`every programme case is open (${s.notYet}/${s.total})`, s.notYet === s.total && s.total > 0,
    JSON.stringify({ notYet: s.notYet, total: s.total }))
  eq("…and a lane of pure failures is still not a regression", s.regressed, false)
  eq("…and the regression list is empty", s.regressions, [])
  const text = formatSuite(s)
  ok("the report separates 'not yet' from 'REGRESSED'", /not yet \(\d+\)/.test(text) && !/REGRESSED/.test(text), text.slice(0, 160))
  ok("…and prints why each open case matters", /pinned to 2024-11-05|the server cannot know/.test(text))
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

console.log("== the protocol comparison is a date comparison, not a string guess ==")
{
  ok("2025-03-26 satisfies a 2025-03-26 target", protocolAtLeast("2025-03-26", "2025-03-26"))
  ok("a later revision satisfies it", protocolAtLeast("2025-06-18", "2025-03-26"))
  ok("2024-11-05 does NOT", !protocolAtLeast("2024-11-05", "2025-03-26"))
  ok("an empty version never satisfies", !protocolAtLeast("", "2025-03-26") && !protocolAtLeast(null, "2025-03-26"))
  // the target must itself be ahead of what forge speaks, or the case is a no-op
  const { PROTOCOL_VERSION } = await import("../mcp.js")
  ok(`the target (${TARGET_MCP_PROTOCOL}) is ahead of what forge speaks (${PROTOCOL_VERSION})`,
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
  // a budget at or above the current cost is a case that can never fail, which
  // is the vacuous-assertion trap this project keeps catching
  ok(`the budget (${BOOT_BUDGET_MS}ms) is BELOW today's cost (${ms}ms), so the case can actually fail`,
    BOOT_BUDGET_MS < ms,
    `budget ${BOOT_BUDGET_MS}ms vs measured ${ms}ms — raise the bar or drop the case`)
  // best-of-N must not be slower than a single run by construction
  const single = await measureBootMs({ runs: 1 })
  ok("best-of-3 is no worse than best-of-1", ms <= single.ms + 50, `${ms} vs ${single.ms}`)
}

console.log("== `forge bench` exits 0 while the programme lane is open ==")
{
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "forge.js"), ...args],
      { cwd: ROOT, timeout: 180000, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout) => resolve({ code: err?.code ?? 0, out: String(stdout || "") }))
  })
  // the programme lane fails completely by design — the sharpest test that a
  // "not yet" never sets the exit code
  const r = await run(["bench", "--lane", "programme"])
  eq("forge bench exits 0 with EVERY programme case failing", r.code, 0)
  ok("…and prints the combined score", /FORGE-SUITE v.*score/.test(r.out), r.out.slice(0, 120))
  ok("…and shows the lane at 0%", /programme\s+\s*0\//.test(r.out), r.out.slice(0, 200))
  ok("…and only that lane is reported", !/capability\s+\d/.test(r.out), r.out.slice(0, 200))

  const full = await run(["bench"])
  ok("the default run names every lane", /capability/.test(full.out) && /programme/.test(full.out), full.out.slice(0, 200))
  ok("…and is the combined report", /FORGE-SUITE/.test(full.out))

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
