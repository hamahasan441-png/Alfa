#!/usr/bin/env node
/**
 * forge v148 — the benchmark that measured the hardware.
 *
 * `forge bench` at v147 reported six speed regressions and exited 1. None was
 * real. Measured on one host, interleaved, v128's own code and v147's were
 * indistinguishable (CLI cold start p50 ~110ms both; prompt composition ~142ms
 * both) — but v128's baseline had recorded 86ms and 110ms on a faster host with
 * the same core count and RAM. `sameMachine` compared {cores, totalMB, tier},
 * said "comparable", and every case read as a regression.
 *
 * v148 times three workloads that contain no forge code alongside the cases,
 * stores them with the baseline, and restates the baseline in this host's
 * units before drawing a verdict. Measured on real runs before writing this
 * file (numbers in CHANGELOG): 23 false verdicts across nine raw comparisons
 * became 0.
 *
 * What this suite has to prove is the dangerous direction: that restating
 * CANNOT hide a real regression. A normalizer that explains away everything
 * would score perfectly on false alarms and be worthless.
 */
import fs from "node:fs"
import os from "node:os"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const P = await import("../perfbench.js")
const {
  CALIBRATION_VERSION, CALIBRATION_MAX_ERROR, CALIBRATION_PROBES, DEFAULT_CALIBRATE,
  calibrationCpuWork, createCalibrator, summarizeCalibration, hostDrift,
  comparePerf, formatComparison, runPerf, PERF_CASES,
} = P
const SRC = fs.readFileSync(new URL("../perfbench.js", import.meta.url), "utf8")

// --- fixtures ---------------------------------------------------------------
// A quiet probe record: best-of-N and median close together, halves agree.
const probe = (min, { spread = 1.05, halves = null } = {}) =>
  ({ min, p50: min * spread, reps: 20, halves: halves ?? [min, min * 1.02] })
const cal = (k = 1, opts = {}) => ({
  v: CALIBRATION_VERSION,
  probes: { spawn: probe(40 * (opts.spawn ?? k), opts), cpu: probe(15 * (opts.cpu ?? k), opts), io: probe(8 * (opts.io ?? k), opts) },
})
// Tight cases (p95 barely above p50) so the band is the floor, not the spread.
const kase = (id, p50, calibrate) => ({ id, group: "g", label: id, calibrate, p50, p95: p50 * 1.02, reps: 10, single: false })
const CASES = [kase("boot", 100, "spawn"), kase("think", 150, "cpu"), kase("walk", 20, "io")]
const run = (k, cases = CASES, calOpts = {}) => ({
  machine: { cores: 4 }, ts: 1,
  calibration: cal(k, calOpts),
  cases: cases.map((c) => ({ ...c, p50: c.p50 * k, p95: c.p95 * k })),
})
const verdicts = (cmp) => Object.fromEntries(cmp.rows.map((r) => [r.id, r.verdict]))
const strip = ({ calibration, ...r }) => r

console.log("== the bug: a slower host with unchanged code ==")
{
  const base = run(1), cur = run(1.3)
  const raw = comparePerf(strip(base), cur)
  eq("RAW (pre-v148) calls all three regressions", raw.slower, 3)
  ok("…and the machine profile says they are comparable, which is how it shipped", raw.sameMachine === true)
  const c = comparePerf(base, cur)
  eq("calibrated: nothing got slower", verdicts(c), { boot: "unchanged", think: "unchanged", walk: "unchanged" })
  ok("…and the run is not marked regressed", c.regressed === false)
  eq("the factor used is reported, not implied", c.rows.map((r) => r.factor), [1.3, 1.3, 1.3])
  eq("the recorded number is kept as recorded", c.rows.map((r) => r.base), [100, 150, 20])
  eq("…and restated beside it", c.rows.map((r) => r.expected), [130, 195, 26])
}

console.log("== the dangerous direction: restating cannot hide a regression ==")
{
  // Same slow host, and one case genuinely got 40% worse on top of it.
  const cur = run(1.3)
  cur.cases.find((c) => c.id === "think").p50 *= 1.4
  const c = comparePerf(run(1), cur)
  eq("the regressed case is still slower", verdicts(c).think, "slower")
  eq("…and only it", c.slower, 1)
  ok("…and the run IS marked regressed", c.regressed === true)

  // A FASTER host where a case did not speed up has regressed relative to
  // everything else. Raw numbers call it unchanged; that is the miss.
  const fast = run(0.7)
  fast.cases.find((c) => c.id === "think").p50 = 150
  const f = comparePerf(run(1), fast)
  eq("on a faster host, a case that stood still is slower", verdicts(f).think, "slower")
  eq("…which raw numbers call unchanged", verdicts(comparePerf(strip(run(1)), fast)).think, "unchanged")
}

console.log("== each case is restated by its own yardstick ==")
{
  // Only process spawn got slower on this host (a slower disk, say).
  const cur = run(1, CASES, { spawn: 1.3 })
  cur.cases.find((c) => c.id === "boot").p50 = 130
  cur.cases.find((c) => c.id === "think").p50 = 195
  const c = comparePerf(run(1), cur)
  eq("a spawn-bound case 30% slower on a 30%-slower-spawn host: unchanged", verdicts(c).boot, "unchanged")
  eq("a cpu-bound case 30% slower when cpu did not move: slower", verdicts(c).think, "slower")
  eq("factors per row", c.rows.map((r) => [r.id, r.calibrate, r.factor]), [["boot", "spawn", 1.3], ["think", "cpu", 1], ["walk", "io", 1]])

  const noTag = comparePerf({ ...run(1), cases: [{ ...kase("x", 10) }] }, { ...run(1.3), cases: [{ ...kase("x", 13) }] })
  eq(`a case with no calibrate field uses ${DEFAULT_CALIBRATE}`, noTag.rows[0].calibrate, DEFAULT_CALIBRATE)
}

console.log("== contention is detected, never normalized ==")
{
  // The probe's median sat far above its best this run, and not at baseline:
  // the host was busy. Measured, that makes cases slow by amounts no single
  // factor predicts — so the verdict must refuse, not guess.
  const cur = run(1.6, CASES, { spread: 2.2 })
  const c = comparePerf(run(1), cur)
  eq("heavily loaded: every row inconclusive", Object.values(verdicts(c)), ["inconclusive", "inconclusive", "inconclusive"])
  ok("inconclusive is not a regression", c.regressed === false && c.slower === 0)
  eq("…and is counted", c.inconclusive, 3)
  ok("the drift reports the contention it saw", c.host.probes.cpu.contention > 1, JSON.stringify(c.host.probes.cpu))
  // Contention barely moves best-of-N, which is WHY the factor uses it.
  eq("and the speed factor ignores it (min over min)", c.host.probes.cpu.ratio, 1.6)

  // Moderate contention widens the band instead of refusing outright.
  const mild = run(1, CASES, { spread: 1.3 })
  mild.cases.find((c) => c.id === "think").p50 = 150 * 1.15
  const quiet = run(1)
  quiet.cases.find((c) => c.id === "think").p50 = 150 * 1.15
  eq("+15% on a quiet host: slower", verdicts(comparePerf(run(1), quiet)).think, "slower")
  const m = comparePerf(run(1), mild)
  ok("+15% under mild contention: the band widened past it", verdicts(m).think === "unchanged" && m.rows.find((r) => r.id === "think").band > 150 * 0.15,
    JSON.stringify(m.rows.find((r) => r.id === "think")))
}

console.log("== the error is the estimate's error ==")
{
  const b = { calibration: cal(1) }
  // Best-of-N moved 30% between the halves of the current run: the host
  // changed speed mid-run, and one factor cannot summarise it.
  const shaky = { calibration: cal(1, { halves: [15, 19.5] }) }
  shaky.calibration.probes.spawn.halves = [40, 52]
  shaky.calibration.probes.io.halves = [8, 10.4]
  const d = hostDrift(b, shaky)
  ok("halves that disagree raise the error", d.probes.cpu.error >= 0.3, JSON.stringify(d.probes.cpu))
  // Independent sides combine in quadrature, not linearly.
  const both = hostDrift({ calibration: cal(1, { halves: [15, 18] }) }, { calibration: cal(1, { halves: [15, 18] }) })
  eq("two sides at 0.2 each combine to hypot, 0.28 — not 0.4", both.probes.cpu.error, Math.round(Math.hypot(0.2, 0.2) * 100) / 100)
  // A hand-built record without halves falls back to single-sample spread,
  // which overstates the error: the cautious direction.
  const old = { calibration: { v: CALIBRATION_VERSION, probes: { cpu: { min: 10, p50: 13 } } } }
  const fb = hostDrift(old, old)
  ok("no halves: falls back to p50/min spread, cautiously", fb.probes.cpu.error >= 0.3 && fb.probes.cpu.error < 0.5, JSON.stringify(fb.probes.cpu))
}

console.log("== an uncalibrated side falls back to raw — and says so ==")
{
  const base = strip(run(1)), cur = run(1.3)
  const c = comparePerf(base, cur)
  ok("no drift", c.host === null)
  eq("verdicts are the raw ones", verdicts(c), verdicts(comparePerf(strip(run(1)), strip(run(1.3)))))
  ok("the note says the baseline predates calibration", /predates host calibration/.test(c.hostNote ?? ""), c.hostNote)
  ok("…and names the fix", /forge perf --save/.test(c.hostNote ?? ""))
  ok("the report prints the note", /note: the baseline predates/.test(formatComparison(c)))
  ok("the current side missing is named differently", /this run was not calibrated/.test(comparePerf(run(1), strip(run(1))).hostNote ?? ""))
  const v0 = run(1); v0.calibration = { ...v0.calibration, v: CALIBRATION_VERSION + 1 }
  const vc = comparePerf(v0, run(1.3))
  ok("a different workload version is not a yardstick", vc.host === null && /workloads differ/.test(vc.hostNote ?? ""), vc.hostNote)
  ok("no drift at all when neither side is calibrated", hostDrift(strip(run(1)), strip(run(1))) === null)
}

console.log("== the report says what it did before any verdict ==")
{
  const txt = formatComparison(comparePerf(run(1), run(1.3)))
  ok("a host line comes first", /^host vs baseline host: spawn ×1\.30 • cpu ×1\.30 • io ×1\.30/.test(txt), txt.split("\n")[0])
  ok("recorded and restated are both columns", /recorded\s+restated\s+now/.test(txt))
  ok("the pre-v148 rule is still stated", /never as an improvement/.test(txt))
  const loaded = formatComparison(comparePerf(run(1), run(1.6, CASES, { spread: 2.2 })))
  ok("a loaded host is named as loaded", /\(loaded \+\d+%\)/.test(loaded) && /host too loaded on cpu to attribute/.test(loaded), loaded)
  ok("…and the count includes inconclusive", /3 inconclusive/.test(loaded))
}

console.log("== the probes contain no forge code ==")
{
  // If optimizing forge could move a probe, the probe would cancel out the
  // very improvement it exists to reveal.
  const section = SRC.slice(SRC.indexOf("// host calibration (v148)"), SRC.indexOf("export function createCalibrator"))
  ok("the calibration section exists", section.length > 500)
  ok("…and imports nothing (no dynamic import inside it)", !/import\(/.test(section))
  ok("the spawn probe runs a bare node, not forge", /spawnSync\(process\.execPath, \["-e", ""\]/.test(section))
  ok("…and nothing in it names a forge module", !/\.\/[a-z-]+\.js/.test(section))
  eq("three yardsticks", Object.keys(CALIBRATION_PROBES).sort(), ["cpu", "io", "spawn"])
  // The io probe times READS. Writing per rep measured the ext4 journal and
  // moved 22ms → 48ms within minutes on one idle host.
  const ioWork = SRC.slice(SRC.indexOf("function calibrationIoWork"), SRC.indexOf("/**\n * The yardsticks."))
  ok("the timed io work only reads", !/writeFileSync|rmSync|mkdtemp/.test(ioWork) && /readFileSync/.test(ioWork))
}

console.log("== the cpu workload is pinned ==")
{
  // Editing the workload without bumping CALIBRATION_VERSION would compare a
  // new yardstick to an old one and call the difference the host.
  eq(`checksum at calibration v${CALIBRATION_VERSION}`, calibrationCpuWork(), 4028006296)
  eq("…and stable across calls", calibrationCpuWork(), calibrationCpuWork())
  // Fused, V8 compiled the loop worse after three calls (12ms → 17ms): the
  // yardstick's length depended on JIT tier. Split helpers stay flat.
  ok("the workload is split into separately compiled helpers",
    /function cpuHash\(/.test(SRC) && /function cpuFloat\(/.test(SRC) && /function cpuString\(/.test(SRC))
  calibrationCpuWork(); calibrationCpuWork()
  const t = []
  for (let i = 0; i < 9; i++) { const t0 = process.hrtime.bigint(); calibrationCpuWork(); t.push(Number(process.hrtime.bigint() - t0) / 1e6) }
  t.sort((a, b) => a - b)
  // Generous (CI is noisy); the failure it guards was a 40% tier step.
  ok("warm reps stay within 2× of each other", t[4] / t[0] < 2, t.map((x) => x.toFixed(1)).join(" "))
}

console.log("== the calibrator, live ==")
{
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("forge-cal-")).length
  const c = createCalibrator()
  c.sample({ full: true })
  c.sample(); c.sample()
  c.sample({ full: true })
  const rec = c.finish()
  eq("version stamped", rec.v, CALIBRATION_VERSION)
  for (const [id, p] of Object.entries(CALIBRATION_PROBES)) {
    const r = rec.probes[id]
    ok(`${id}: measured`, r && r.min > 0, JSON.stringify(r))
    eq(`${id}: reps = two full passes + two singles`, r?.reps, p.reps * 2 + 2)
    ok(`${id}: best ≤ median`, r && r.min <= r.p50)
    ok(`${id}: two halves, each a best-of`, Array.isArray(r?.halves) && r.halves.length === 2 && r.halves.every((h) => h >= r.min))
  }
  eq("the io corpus is removed", fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("forge-cal-")).length, tmpBefore)

  // Time order matters: halves are the first and second half as sampled.
  const s = summarizeCalibration({ cpu: [10, 11, 12, 20, 21, 22] })
  eq("halves are best-of each time-ordered half", s.probes.cpu.halves, [10, 20])
  ok("a probe with fewer than two samples is left out, not guessed", !("spawn" in summarizeCalibration({ spawn: [5] }).probes))
}

console.log("== runPerf carries it ==")
{
  const cases = [{ id: "k", group: "t", label: "k", reps: 2, run: () => 1 }]
  const r = await runPerf({ cwd: process.cwd(), cases })
  ok("a run is calibrated by default", r.calibration?.v === CALIBRATION_VERSION && Object.keys(r.calibration.probes).length === 3,
    JSON.stringify(r.calibration))
  eq("the case records its yardstick", r.cases[0].calibrate, DEFAULT_CALIBRATE)
  // 2 full passes, 1 case → 1 interleaved single
  eq("interleaved: one rep of each probe per case", r.calibration.probes.cpu.reps, CALIBRATION_PROBES.cpu.reps * 2 + 1)
  const ni = await runPerf({ cwd: process.cwd(), cases, interleave: false })
  eq("interleave:false keeps only the two full passes", ni.calibration.probes.cpu.reps, CALIBRATION_PROBES.cpu.reps * 2)
  const off = await runPerf({ cwd: process.cwd(), cases, calibrate: false })
  ok("calibrate:false records none", !("calibration" in off))
}

console.log("== the real cases name real yardsticks ==")
{
  for (const c of PERF_CASES) {
    const y = c.calibrate ?? DEFAULT_CALIBRATE
    ok(`${c.id} → ${y}`, y in CALIBRATION_PROBES)
  }
  const by = (id) => PERF_CASES.find((c) => c.id === id)?.calibrate
  eq("the CLI cold starts are restated by process spawn", [by("startup-help"), by("startup-status")], ["spawn", "spawn"])
  eq("the tree walks by io", [by("list-source-files"), by("glob-js"), by("grep-symbol")], ["io", "io", "io"])
  eq("composition by cpu (the default)", by("compose-context") ?? DEFAULT_CALIBRATE, "cpu")
}

console.log("== the bench speed lane ==")
{
  const B = fs.readFileSync(new URL("../benchsuite.js", import.meta.url), "utf8")
  const lane = B.slice(B.indexOf("async function runSpeed"), B.indexOf("async function runAutonomy"))
  // Inconclusive must stay out of the score: it is neither a pass (nothing
  // was proved) nor a fail (nothing was shown broken).
  ok("scorable is faster/slower/unchanged only — inconclusive is excluded",
    /r\.verdict === "faster" \|\| r\.verdict === "slower" \|\| r\.verdict === "unchanged"/.test(lane) && !/"inconclusive"/.test(lane.replace(/\/\/.*$/gm, "")))
  ok("a restated row says by what", /r\.factor != null/.test(lane) && /recorded \$\{r\.base\}ms × \$\{r\.factor\}/.test(lane))
  // An uncalibrated comparison is a limitation, not a verdict — the rule the
  // lane already applied to a different machine profile, extended to the case
  // the profile cannot see.
  ok("an uncalibrated comparison skips the lane with its reason",
    /if \(!cmp\.host\) \{\s*return \{ ran: false, skipped: "the perf baseline is not host-calibrated/.test(lane))
  ok("…after the machine-profile check, not instead of it",
    lane.indexOf("cmp.sameMachine === false") > -1 && lane.indexOf("cmp.sameMachine === false") < lane.indexOf("if (!cmp.host)"))
  ok(`the inconclusive limit is a stated constant (${CALIBRATION_MAX_ERROR})`, CALIBRATION_MAX_ERROR > 0 && CALIBRATION_MAX_ERROR < 1)
}

console.log(`\n== perf-calibration suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
