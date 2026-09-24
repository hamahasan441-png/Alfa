/**
 * forge — FORGE-PERF (v116 "measurewise-2", zero dependencies)
 *
 * Why this module exists, stated plainly: until now nothing in forge measured
 * how long forge takes. `bench.js` scores decision QUALITY against a fixed
 * ladder; `evalbench.js` scores whether a task was actually solved (and needs
 * a live model). Neither reports a millisecond, and `grep -rn hrtime` over the
 * production tree returned nothing. That means every past claim about forge
 * being "faster" rested on nobody's measurement, and every future optimization
 * would have had nothing to prove itself against.
 *
 * So this is not an optimization. It is the thing an optimization has to pass.
 *
 *   forge perf                  measure the hot paths, print the report
 *   forge perf --save           store the numbers as this project's baseline
 *   forge perf --compare        measure again and diff against that baseline
 *   forge perf --json           machine output
 *
 * HONESTY RULES (the whole point — see the project's "never fake a hit" line):
 *
 *   1. A case that throws is reported ERR and is EXCLUDED from every summary.
 *      A benchmark that "passes" because the work never ran is worse than no
 *      benchmark: it reports the speed of failing.
 *   2. A difference smaller than the case's OWN measured noise is reported as
 *      "unchanged". Never "faster". The baseline's p95−p50 spread is part of
 *      the band, so a case that jitters by 40ms cannot be declared a 10ms win.
 *   3. Single-sample cases (a cold path is only cold once per process) are
 *      labelled and get a wider band. They are indicative, not conclusive, and
 *      the report says so instead of pretending otherwise.
 *   4. Every number is wall time actually observed here, on this machine, with
 *      this project. Nothing is extrapolated. The raw baseline number is always
 *      shown as recorded.
 *   5. (v148) A VERDICT compares like with like. Each run also times three
 *      fixed workloads that contain no forge code at all — a bare node process,
 *      a fixed CPU loop, a cached read walk — interleaved with the cases, and
 *      stores them with the baseline. When both sides carry them, the baseline
 *      is restated in THIS host's units before the verdict is drawn, and the
 *      factor used is printed. Without this, a baseline recorded on faster
 *      silicon with the same core count and RAM read as a regression: v128's
 *      own code timed 86ms in its baseline and ~112ms on the next host, and
 *      v147 — indistinguishable from v128 there — had six of fifteen cases
 *      marked "slower" for code nobody changed. Rule 4 used to forbid
 *      normalizing; it was written when there was nothing to normalize BY, and
 *      the result was a benchmark that measured the hardware.
 *
 * No model. No network. Read-only with respect to the measured project: the
 * only writes are forge's own caches under ~/.forge/projects/<hash>/, exactly
 * as a normal run would write them (FORGE_INDEX=0 disables those).
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { writeStateFile } from "./securefs.js"
import { projectDir } from "./memory.js"
import { VERSION } from "./version.js"

export const PERF_FILE = "perf-baseline.json"
export const PERF_VERSION = 1

/** Default noise band. A delta must clear ALL of these to be called a change. */
export const NOISE_MS = 2
export const NOISE_PCT = 0.08
/** A single-sample case has no spread to measure, so it gets a wider band. */
export const SINGLE_NOISE_PCT = 0.25

const FORGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// host calibration (v148)
// ---------------------------------------------------------------------------

/**
 * Bumped whenever a probe's WORKLOAD changes. A baseline calibrated with a
 * different workload is not a yardstick for this one, and is treated exactly
 * like a baseline with no calibration at all.
 */
export const CALIBRATION_VERSION = 1

/**
 * Past this much measurement error in the host factor, a verdict would rest
 * more on the correction than on the case, and the row says "inconclusive".
 *
 * Two things feed the error, and the split is the lesson of building this:
 *
 *   SPEED — the factor itself is best-of-N over best-of-N: what this silicon
 *   can do against what that silicon could do. Its error is how far each
 *   side's best moved between the first and second half of its run. (The
 *   first cut used single-sample spread, p50/min − 1; measured at ~0.3 per
 *   side on an idle host, it made every row "inconclusive" — a guard that
 *   always fires is the feature switched off.)
 *
 *   CONTENTION — how much further the probe's median sat above its best THIS
 *   run than in the baseline's. Contention is NOT normalized, because it is
 *   not a property of the host: measured under four CPU hogs, one run slowed
 *   the CLI cold start 110% and the next left it untouched while the probes
 *   read ×2. A p50-over-p50 factor turned that into four false "faster" rows;
 *   a best-over-best factor ignored it and let prompt composition read 51%
 *   "slower". Neither is attribution. So contention is counted as error: it
 *   widens the band, and past the limit the row says it cannot tell.
 */
export const CALIBRATION_MAX_ERROR = 0.5

const CPU_ITERATIONS = 4_000_000
const CPU_STRING_CHARS = 40_000

// Three helpers, not one function: fused, V8 compiled the combined loop
// WORSE after a few calls (measured 12ms for the first three, then a flat
// 17ms), so the probe's length depended on JIT tiering — best-of-N then
// caught the early fast sample and "measured the host" as whatever tier it
// happened to be in. Apart, each is flat from the first warm call.
function cpuHash(n) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < n; i++) h = Math.imul(h ^ (i & 0xff), 16777619) >>> 0
  return h
}
function cpuFloat(n) {
  let x = 0
  for (let i = 0; i < n; i++) x += Math.sqrt(i & 0xffff)
  return Math.floor(x) >>> 0
}
function cpuString(seed, n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push(String.fromCharCode(97 + ((seed >>> (i & 15)) + i) % 26))
  const s = parts.join("")
  let k = 0
  for (let i = 0; i < s.length; i++) k = (k * 31 + s.charCodeAt(i)) >>> 0
  return k
}

/**
 * The fixed CPU workload. Integer hashing, float math and string building —
 * the three things forge's in-process paths actually spend time on — folded
 * into a checksum that is RETURNED, so the optimizer cannot delete the loop.
 * The checksum is pinned by the test suite: editing this workload without
 * bumping CALIBRATION_VERSION fails a test instead of silently corrupting
 * every comparison against an older baseline.
 */
export function calibrationCpuWork() {
  const h = cpuHash(CPU_ITERATIONS)
  return (h ^ cpuFloat(CPU_ITERATIONS) ^ cpuString(h, CPU_STRING_CHARS)) >>> 0
}

const IO_FILES = 192

// The io probe READS a corpus it built untimed. The first cut wrote and
// unlinked 48 files per rep, which on ext4 measures the journal: it moved
// from 22ms to 48ms within minutes on one idle host. Every io-calibrated case
// (tree walk, glob, grep, incremental repo map) is a read over page-cached
// files — syscalls and copies, not writeback — so that is what this times.
function ioSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cal-"))
  const body = "x".repeat(1024)
  for (let i = 0; i < IO_FILES; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), body)
  return dir
}
function ioTeardown(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* tmp is tmp */ } }
const IO_WALKS = 5
function calibrationIoWork(dir) {
  let n = 0
  for (let w = 0; w < IO_WALKS; w++) {
    for (const f of fs.readdirSync(dir)) {
      n += fs.statSync(path.join(dir, f)).size
      n += fs.readFileSync(path.join(dir, f), "utf8").length
    }
  }
  return n
}

/**
 * The yardsticks. NONE of them may import forge: if optimizing forge could
 * move a probe, the probe would stop measuring the host and start cancelling
 * out the very improvement it is meant to reveal. (Pinned by source scan.)
 */
export const CALIBRATION_PROBES = Object.freeze({
  spawn: { label: "bare node process (node -e \"\")", reps: 9, run: () => { spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }) } },
  cpu: { label: "fixed arithmetic + string work", reps: 7, run: () => calibrationCpuWork() },
  io: { label: `fixed cached-read walk (${IO_WALKS} × ${IO_FILES} × 1KB)`, reps: 7, setup: ioSetup, teardown: ioTeardown, run: (dir) => calibrationIoWork(dir) },
})

/** Which yardstick a case is restated by, when it names none. */
export const DEFAULT_CALIBRATE = "cpu"

/**
 * Measure the host ALONGSIDE the cases, not before them.
 *
 * The probes are sampled in a full pass at the start, one rep each between
 * every case, and a full pass at the end, so they experience whatever the
 * cases experienced. The first cut sampled only at the start and end and
 * summarised with best-of-N; under four CPU hogs it read the host as ×1.01
 * while prompt composition ran 51% slower. Two reasons, both measured: a
 * short probe rep often escapes preemption entirely, so the MINIMUM ignores
 * sustained contention (the cases report p50, so the ratio compared different
 * statistics); and a pass at each end sees nothing of load that comes and
 * goes in between.
 */
export function createCalibrator() {
  const state = {}, samples = {}
  for (const [id, p] of Object.entries(CALIBRATION_PROBES)) {
    try {
      state[id] = p.setup ? p.setup() : undefined
      p.run(state[id]) // warm: the first call pays JIT and cache fill, not the host's speed
      samples[id] = []
    } catch { /* a probe that cannot run leaves its cases uncalibrated */ }
  }
  const once = (id) => {
    const t0 = process.hrtime.bigint()
    CALIBRATION_PROBES[id].run(state[id])
    samples[id].push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  return {
    /** `full`: each probe's own rep count; otherwise one rep of each. */
    sample({ full = false } = {}) {
      for (const id of Object.keys(samples)) {
        try { for (let i = 0; i < (full ? CALIBRATION_PROBES[id].reps : 1); i++) once(id) }
        catch { delete samples[id] }
      }
    },
    finish() {
      for (const [id, p] of Object.entries(CALIBRATION_PROBES)) { try { p.teardown?.(state[id]) } catch { /* tmp is tmp */ } }
      return summarizeCalibration(samples)
    },
  }
}

/**
 * Samples in TIME ORDER per probe → the stored record. The halves are what
 * the error is computed from: a host that was one speed for the first half of
 * the run and another for the second cannot be summarised by one factor with
 * any confidence, and the error says by how much.
 */
export function summarizeCalibration(samples) {
  const probes = {}
  for (const [id, p] of Object.entries(CALIBRATION_PROBES)) {
    const all = (samples?.[id] ?? []).filter((x) => Number.isFinite(x) && x > 0)
    if (all.length < 2) continue
    const med = (xs) => round2(quantile(xs.slice().sort((a, b) => a - b), 0.5))
    const best = (xs) => round2(Math.min(...xs))
    const mid = Math.floor(all.length / 2)
    probes[id] = {
      min: best(all),
      p50: med(all),
      reps: all.length,
      // best-of-N of each half of the run, in time order
      halves: [best(all.slice(0, mid)), best(all.slice(mid))],
      label: p.label,
    }
  }
  return { v: CALIBRATION_VERSION, probes }
}

/**
 * How this host compares to the one that recorded the baseline, per probe.
 *
 * Returns null when either side has no calibration (or a different workload
 * version): the comparison then falls back to raw numbers, exactly as it did
 * before v148, and says so.
 */
export function hostDrift(baseline, current) {
  const b = baseline?.calibration, c = current?.calibration
  if (!b || !c || b.v !== c.v || b.v !== CALIBRATION_VERSION) return null
  const probes = {}
  for (const id of Object.keys(CALIBRATION_PROBES)) {
    const bp = b.probes?.[id], cp = c.probes?.[id]
    if (!(bp?.min > 0) || !(cp?.min > 0)) continue
    // Speed error: how far best-of-N moved between the halves of the run.
    // Absent (a hand-built record): single-sample spread, which overstates the
    // error — wrong in the cautious direction.
    const speedError = (q) => {
      const h = Array.isArray(q.halves) ? q.halves.filter((x) => x > 0) : []
      if (h.length >= 2) return Math.max(...h) / Math.min(...h) - 1
      return Math.max(0, (Number(q.p50) || q.min) / q.min - 1)
    }
    const spread = (q) => (Number(q.p50) > 0 ? q.p50 / q.min : 1)
    const contention = Math.max(0, spread(cp) / spread(bp) - 1)
    probes[id] = {
      ratio: round2(cp.min / bp.min),
      // The two sides are independent measurements (different run, often a
      // different host), so their relative errors combine in quadrature, as
      // for any ratio of independent estimates. Contention is a bias, not
      // noise, and adds on top. (Summing linearly — the first cut — cost
      // ~5-10 points of sensitivity for no reason but the arithmetic.)
      error: round2(Math.hypot(speedError(bp), speedError(cp)) + contention),
      contention: round2(contention),
      base: bp.min,
      cur: cp.min,
    }
  }
  return Object.keys(probes).length ? { probes } : null
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const round2 = (x) => Math.round(Number(x) * 100) / 100

/**
 * Measure a genuinely cold path: a path is only cold once per process, so the
 * only honest way to repeat it is a fresh process each time. The child times
 * the work ITSELF and prints the number, so node's own startup is excluded —
 * what comes back is the work, not the spawn.
 */
function childMs(expr, cwd) {
  const code = `
    const t0 = process.hrtime.bigint()
    await (${expr})
    process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6))
  `
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, encoding: "utf8" })
  const ms = Number(String(r.stdout ?? "").trim())
  if (!Number.isFinite(ms)) throw new Error(`cold measurement failed: ${String(r.stderr ?? "").trim().slice(0, 120)}`)
  return ms
}

/**
 * Time one case. Warmup runs are executed and DISCARDED (they are not faster
 * numbers, they are a different measurement: a cold path). A throw at any
 * point ends the case — a partially measured case reports no number at all.
 */
async function timeCase(c, ctx) {
  const warmup = Math.max(0, Number(c.warmup ?? 0))
  const reps = Math.max(1, Number(c.reps ?? 5))
  const samples = []
  try {
    // A case may need a precondition it does not want to measure. `repomap` and
    // `semantic_search` both read an index off disk: without warming it first,
    // whichever rep happens to run after the tree changed pays a rebuild and
    // the case reports a regression that is really just its own precondition
    // moving. Measured, not theorized — the first run after the test suite
    // reported repo-map-first at 175ms and the next three at ~34ms.
    if (typeof c.prepare === "function") await c.prepare(ctx)
    for (let i = 0; i < warmup; i++) await c.run(ctx)
    for (let i = 0; i < reps; i++) {
      if (c.innerMs) { samples.push(Number(await c.run(ctx))); continue }
      const t0 = process.hrtime.bigint()
      await c.run(ctx)
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    if (samples.some((x) => !Number.isFinite(x))) throw new Error("a rep produced no measurement")
  } catch (e) {
    return { id: c.id, group: c.group, label: c.label, reps: 0, err: String(e?.message ?? e).slice(0, 200) }
  }
  const sorted = samples.slice().sort((a, b) => a - b)
  return {
    id: c.id,
    group: c.group,
    label: c.label,
    calibrate: c.calibrate ?? DEFAULT_CALIBRATE,
    reps: samples.length,
    single: samples.length === 1,
    p50: round2(quantile(sorted, 0.5)),
    p95: round2(quantile(sorted, 0.95)),
    mean: round2(samples.reduce((a, b) => a + b, 0) / samples.length),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    err: null,
  }
}

// ---------------------------------------------------------------------------
// the cases — the paths a real run actually pays for (§86)
// ---------------------------------------------------------------------------

const TASK = "fix the off-by-one in the pager so the last page is not dropped"

const MIXED_BATCH = [
  { id: "a", name: "read_file", args: { path: "agent.js", limit: 80 } },
  { id: "b", name: "grep_files", args: { pattern: "runAgent", path: "." } },
  { id: "c", name: "glob_files", args: { pattern: "*.js" } },
  { id: "d", name: "list_dir", args: { path: "." } },
  { id: "e", name: "read_file", args: { path: "meta.js", limit: 80 } },
  { id: "f", name: "write_file", args: { path: "out.txt", content: "x" } },
  { id: "g", name: "read_file", args: { path: "tools.js", limit: 80 } },
  { id: "h", name: "bash", args: { command: "npm test" } },
]

const TOOL_LOG = [
  { name: "read_file", result: "ok" },
  { name: "grep_files", result: "3 matches" },
  { name: "edit_file", result: "edited src/pager.js" },
  { name: "bash", result: "PASS 12 tests" },
]

// Each case names the yardstick it is restated by (`calibrate`), because the
// cases are bound by different things and one host factor would be a lie of
// precision. The assignments are judgements, stated so they can be argued with:
//   spawn — the CLI cold starts, and the two "cold process" cases: they time
//           work INSIDE a fresh child, which is dominated by module load and
//           compile, the same costs a bare node boot pays.
//   io    — the tree walks, glob, grep and the incremental repo map: stat and
//           read over the project.
//   cpu   — everything else (the default): in-process decisions, composition,
//           the warm semantic search.
// A case measuring the wrong yardstick is not hidden — its row prints the
// factor it was restated by.
export const PERF_CASES = [
  // ---- startup: what the user waits for before anything happens ----------
  {
    id: "startup-help", calibrate: "spawn", group: "startup", label: "CLI cold start (forge --help)",
    reps: 3, warmup: 1,
    run: () => { spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "--help"], { stdio: "ignore" }) },
  },
  {
    id: "startup-status", calibrate: "spawn", group: "startup", label: "CLI cold start (forge status)",
    reps: 3, warmup: 1,
    run: () => { spawnSync(process.execPath, [path.join(FORGE_DIR, "forge.js"), "status"], { stdio: "ignore" }) },
  },

  // ---- decision paths: cheap, but run on EVERY step ----------------------
  {
    id: "classify-task", group: "decide", label: "task classification",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.classify.classifyTask(TASK) },
  },
  {
    id: "route-plan", group: "decide", label: "tool-batch scheduling (8 calls)",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.router.planExecution(MIXED_BATCH, { registry: ctx.registry, ctx: { cwd: ctx.cwd } }) },
  },
  {
    id: "route-select", group: "decide", label: "tool selection (router.route)",
    reps: 100, warmup: 10,
    run: (ctx) => { ctx.router.route({ task: TASK, registry: ctx.registry, context: { cwd: ctx.cwd } }) },
  },
  {
    id: "classify-search", group: "decide", label: "search intent classification",
    reps: 200, warmup: 20,
    // v117 runs this before every search hint, so it has to be free. If it is
    // not, the thing meant to remove wasted work becomes wasted work.
    run: (ctx) => { ctx.router.classifySearch("what calls parseConfig in the loader") },
  },
  {
    id: "gate-fastpath", group: "decide", label: "completion gate (fast path)",
    reps: 200, warmup: 20,
    run: (ctx) => { ctx.completion.canCompleteFastPath({ finalText: "fixed and tested", toolLog: TOOL_LOG, commandChecks: [] }) },
  },

  // ---- discovery: the paths that touch the filesystem --------------------
  {
    id: "list-source-files", calibrate: "io", group: "search", label: "source-file walk",
    reps: 5, warmup: 1,
    run: (ctx) => { ctx.repomap.listSourceFiles(ctx.cwd, { maxFiles: 400 }) },
  },
  {
    id: "glob-js", calibrate: "io", group: "search", label: "glob_files **/*.js",
    reps: 5, warmup: 1,
    run: (ctx) => ctx.tools.execTool(ctx.toolCtx, "glob_files", { pattern: "**/*.js" }),
  },
  {
    id: "grep-symbol", calibrate: "io", group: "search", label: "grep_files (symbol)",
    reps: 5, warmup: 1,
    run: (ctx) => ctx.tools.execTool(ctx.toolCtx, "grep_files", { pattern: "export function", path: "." }),
  },
  {
    id: "semantic-first", calibrate: "spawn", group: "search", label: "semantic_search (cold process)",
    reps: 3, warmup: 0, innerMs: true,
    // warm the ON-DISK index first: this case measures the cold PROCESS, not a
    // cold index. Without this it silently measures whichever of the two the
    // machine happened to be in.
    prepare: (ctx) => ctx.codesearch.semanticSearch(ctx.cwd, "warm the on-disk index", { limit: 1, maxFiles: 200 }),
    run: (ctx) => childMs(`import("${JSON.stringify(path.join(FORGE_DIR, "codesearch.js")).slice(1, -1)}").then((m) => m.semanticSearch(process.cwd(), "where is the completion gate decided", { limit: 5, maxFiles: 200 }))`, ctx.cwd),
  },
  {
    id: "semantic-warm", group: "search", label: "semantic_search (chunks cached)",
    reps: 3, warmup: 1,
    run: (ctx) => ctx.codesearch.semanticSearch(ctx.cwd, "where is the completion gate decided", { limit: 5, maxFiles: 200 }),
  },

  // ---- index + context: the expensive per-run construction ---------------
  {
    id: "repomap-first", calibrate: "spawn", group: "context", label: "repo map (cold process)",
    reps: 3, warmup: 0, innerMs: true,
    prepare: (ctx) => { ctx.repomap.buildRepoMap(ctx.cwd, { maxFiles: 400 }) },
    run: (ctx) => childMs(`import("${JSON.stringify(path.join(FORGE_DIR, "repomap.js")).slice(1, -1)}").then((m) => m.buildRepoMap(process.cwd(), { maxFiles: 400 }))`, ctx.cwd),
  },
  {
    id: "repomap-warm", calibrate: "io", group: "context", label: "repo map (incremental)",
    reps: 3, warmup: 1,
    run: (ctx) => { ctx.repomap.buildRepoMap(ctx.cwd, { maxFiles: 400 }) },
  },
  {
    id: "compose-context", group: "context", label: "prompt composition",
    reps: 10, warmup: 2,
    run: (ctx) => { ctx.compose.compose(TASK, { cwd: ctx.cwd }) },
  },
]

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function buildContext(cwd) {
  const [router, classify, completion, repomap, compose, codesearch, tools, capabilities] = await Promise.all([
    import("./router.js"), import("./classify.js"), import("./completion.js"),
    import("./repomap.js"), import("./compose.js"), import("./codesearch.js"),
    import("./tools.js"), import("./capabilities.js"),
  ])
  return {
    cwd,
    router, classify, completion, repomap, compose, codesearch, tools,
    registry: capabilities.createRegistry({ config: {} }),
    toolCtx: { cwd, root: cwd, timeoutSec: 10, maxToolOutput: 20000, readOnly: true, _plugins: new Map() },
  }
}

export async function runPerf({ cwd = process.cwd(), only = null, cases = PERF_CASES, onCase = null, calibrate = true, interleave = true } = {}) {
  const wanted = only
    ? cases.filter((c) => c.id === only || c.group === only || c.id.startsWith(only))
    : cases
  const ctx = await buildContext(cwd)
  let tier = "unknown", burst = false, cores = os.cpus()?.length ?? 0, totalMB = Math.round(os.totalmem() / 1048576)
  try {
    const { resourceProfile } = await import("./profile.js")
    const p = resourceProfile()
    tier = p.tier; burst = Boolean(p.burst); cores = p.cores; totalMB = p.totalMB
  } catch { /* an unreadable /proc must not stop a measurement */ }
  const cal = calibrate ? createCalibrator() : null
  cal?.sample({ full: true })
  const results = []
  for (const c of wanted) {
    const r = await timeCase(c, ctx)
    results.push(r)
    onCase?.(r)
    if (interleave) cal?.sample()
  }
  cal?.sample({ full: true })
  const calibration = cal ? cal.finish() : null
  return {
    v: PERF_VERSION,
    forge: VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    machine: { cores, totalMB, tier, burst },
    cwd,
    ts: Date.now(),
    ...(calibration ? { calibration } : {}),
    cases: results,
  }
}

export function summarize(run) {
  const cases = run?.cases ?? []
  const ok = cases.filter((c) => !c.err)
  const errored = cases.filter((c) => c.err)
  const byGroup = {}
  for (const c of ok) {
    byGroup[c.group] = byGroup[c.group] ?? { group: c.group, cases: 0, totalP50: 0 }
    byGroup[c.group].cases++
    byGroup[c.group].totalP50 = round2(byGroup[c.group].totalP50 + c.p50)
  }
  return {
    measured: ok.length,
    errored: errored.length,
    // The sum is NOT a score: it is the total of one pass over the measured
    // cases, and it only means anything compared against the same case set.
    totalP50: round2(ok.reduce((a, c) => a + c.p50, 0)),
    groups: Object.values(byGroup),
    errors: errored.map((c) => ({ id: c.id, err: c.err })),
  }
}

// ---------------------------------------------------------------------------
// baseline + comparison (§89/§90 — an optimization must prove itself)
// ---------------------------------------------------------------------------

export function perfBaselinePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), PERF_FILE)
}

export function savePerfBaseline(cwd, run) {
  try {
    writeStateFile(perfBaselinePath(cwd), JSON.stringify(run, null, 1))
    return perfBaselinePath(cwd)
  } catch { return null }
}

export function loadPerfBaseline(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(perfBaselinePath(cwd), "utf8"))
    return j && typeof j === "object" && Array.isArray(j.cases) ? j : null
  } catch { return null }
}

/**
 * The band a delta must clear before it is called anything at all.
 *
 * It is the widest of: an absolute floor, a percentage of the baseline, and —
 * the part that matters — the baseline case's OWN p95−p50 spread. A case that
 * naturally varies by 40ms cannot report a 10ms improvement, because that
 * "improvement" is indistinguishable from the case having a good day.
 */
export function noiseBand(base, { noiseMs = NOISE_MS, noisePct = NOISE_PCT } = {}) {
  if (!base || base.err) return Infinity
  const spread = Math.max(0, (Number(base.p95) || 0) - (Number(base.p50) || 0))
  const pct = base.single ? Math.max(noisePct, SINGLE_NOISE_PCT) : noisePct
  return Math.max(noiseMs, (Number(base.p50) || 0) * pct, spread)
}

/**
 * Compare a run against a baseline.
 *
 * With calibration on both sides (v148), each case's baseline is restated in
 * this host's units — `base.p50 × (this host's probe ÷ the baseline host's
 * probe)` — and the verdict is drawn against THAT. The band is restated the
 * same way and then widened by the probe's own measurement error, so an
 * unstable host makes the comparison more cautious, never more confident.
 *
 * What restating cannot do is hide a regression in one case: the factor comes
 * from workloads that contain no forge code, so a case that got slower while
 * its yardstick did not is still slower. (tests/test-perf-calibration.mjs
 * proves both directions.)
 */
export function comparePerf(baseline, current, opts = {}) {
  const baseById = new Map((baseline?.cases ?? []).map((c) => [c.id, c]))
  const drift = hostDrift(baseline, current)
  const rows = []
  for (const cur of current?.cases ?? []) {
    const base = baseById.get(cur.id) ?? null
    if (!base) { rows.push({ id: cur.id, group: cur.group, label: cur.label, verdict: "new", base: null, cur: cur.err ? null : cur.p50 }); continue }
    if (cur.err || base.err) {
      rows.push({ id: cur.id, group: cur.group, label: cur.label, verdict: "n/a", base: base.err ? null : base.p50, cur: cur.err ? null : cur.p50, err: cur.err ?? base.err })
      continue
    }
    const probe = cur.calibrate ?? base.calibrate ?? DEFAULT_CALIBRATE
    const d = drift?.probes?.[probe] ?? null
    const factor = d ? d.ratio : 1
    const expected = round2(base.p50 * factor)
    const band = noiseBand(base, opts) * factor + (d ? expected * d.error : 0)
    const delta = round2(cur.p50 - expected)
    const pct = expected > 0 ? round2((delta / expected) * 100) : 0
    const verdict = d && d.error > CALIBRATION_MAX_ERROR ? "inconclusive"
      : delta < -band ? "faster" : delta > band ? "slower" : "unchanged"
    rows.push({
      id: cur.id, group: cur.group, label: cur.label,
      base: base.p50, expected, cur: cur.p50, delta, pct, band: round2(band),
      calibrate: d ? probe : null, factor: d ? factor : null,
      single: Boolean(base.single || cur.single), verdict,
    })
  }
  const missing = [...baseById.keys()].filter((id) => !(current?.cases ?? []).some((c) => c.id === id))
  const count = (v) => rows.filter((r) => r.verdict === v).length
  return {
    rows,
    faster: count("faster"),
    slower: count("slower"),
    unchanged: count("unchanged"),
    inconclusive: count("inconclusive"),
    unusable: count("n/a") + count("new"),
    missing,
    // The only verdict that matters for a merge decision: did anything get
    // measurably worse? "No improvement" is a result; a regression is a stop.
    // "Inconclusive" is neither — the host was too unstable to tell.
    regressed: count("slower") > 0,
    baselineAt: baseline?.ts ?? null,
    sameMachine: JSON.stringify(baseline?.machine ?? null) === JSON.stringify(current?.machine ?? null),
    // null: one side has no calibration, and the verdicts are on raw numbers.
    host: drift,
    hostNote: drift ? null : uncalibratedReason(baseline, current),
  }
}

function uncalibratedReason(baseline, current) {
  const b = baseline?.calibration, c = current?.calibration
  if (!b) return "the baseline predates host calibration (v148) — verdicts are on raw numbers and cannot tell a slower host from slower code; run `forge perf --save` to record one"
  if (!c) return "this run was not calibrated — verdicts are on raw numbers"
  if (b.v !== c.v || b.v !== CALIBRATION_VERSION) return `the calibration workloads differ (baseline v${b.v}, this run v${c.v}) — verdicts are on raw numbers; run \`forge perf --save\``
  return "no probe measured on both sides — verdicts are on raw numbers"
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

export function formatPerfReport(run, { json = false } = {}) {
  if (json) return JSON.stringify(run, null, 1)
  const s = summarize(run)
  const out = []
  out.push(`FORGE-PERF ${run.forge} • node ${run.node} • ${run.platform}`)
  out.push(`machine: ${run.machine.cores} cores • ${run.machine.totalMB}MB • tier ${run.machine.tier}${run.machine.burst ? " (burst)" : ""}`)
  out.push(`project: ${run.cwd}`)
  out.push("")
  out.push(`${pad("case", 34)}${padL("p50", 9)}${padL("p95", 9)}${padL("reps", 6)}`)
  out.push("─".repeat(58))
  let group = null
  for (const c of run.cases) {
    if (c.group !== group) { group = c.group; out.push(`${group}:`) }
    if (c.err) { out.push(`  ${pad(c.label, 32)}${padL("ERR", 9)}  ${c.err.slice(0, 60)}`); continue }
    const note = c.single ? " *" : ""
    out.push(`  ${pad(c.label, 32)}${padL(c.p50.toFixed(1) + "ms", 9)}${padL(c.p95.toFixed(1) + "ms", 9)}${padL(c.reps + note, 6)}`)
  }
  out.push("─".repeat(58))
  out.push(`${s.measured} measured • ${s.errored} errored • one pass ≈ ${s.totalP50.toFixed(1)}ms`)
  if (run.cases.some((c) => c.single && !c.err)) out.push("* single sample — a cold path is only cold once per process; indicative, not conclusive")
  if (s.errored) {
    out.push("")
    out.push("errored (EXCLUDED from every number above):")
    for (const e of s.errors) out.push(`  ${e.id}: ${e.err}`)
  }
  return out.join("\n")
}

export function formatComparison(cmp, { json = false } = {}) {
  if (json) return JSON.stringify(cmp, null, 1)
  const out = []
  const cal = Boolean(cmp.host)
  if (cal) {
    // Say what the host factor IS before any verdict that depends on it.
    const parts = Object.entries(cmp.host.probes).map(([id, d]) =>
      `${id} ×${d.ratio.toFixed(2)}${d.contention > 0.1 ? ` (loaded +${Math.round(d.contention * 100)}%)` : ""}${d.error > CALIBRATION_MAX_ERROR ? " (cannot tell)" : ""}`)
    out.push(`host vs baseline host: ${parts.join(" • ")}  — each baseline is restated in this host's units before the verdict`)
    out.push(`${pad("case", 34)}${padL("recorded", 10)}${padL("restated", 10)}${padL("now", 10)}${padL("delta", 10)}  verdict`)
    out.push("─".repeat(84))
  } else {
    out.push(`${pad("case", 34)}${padL("base", 10)}${padL("now", 10)}${padL("delta", 10)}  verdict`)
    out.push("─".repeat(74))
  }
  for (const r of cmp.rows) {
    const gap = cal ? padL("—", 10) : ""
    if (r.verdict === "new") { out.push(`  ${pad(r.label ?? r.id, 32)}${padL("—", 10)}${gap}${padL(r.cur == null ? "ERR" : r.cur.toFixed(1), 10)}${padL("—", 10)}  new case`); continue }
    if (r.verdict === "n/a") { out.push(`  ${pad(r.label ?? r.id, 32)}${padL(r.base ?? "ERR", 10)}${gap}${padL(r.cur ?? "ERR", 10)}${padL("—", 10)}  not comparable`); continue }
    const d = `${r.delta > 0 ? "+" : ""}${r.delta.toFixed(1)}ms`
    const restated = cal ? padL(r.factor == null ? "—" : r.expected.toFixed(1), 10) : ""
    const why = r.verdict === "inconclusive" ? ` (host too ${cmp.host.probes[r.calibrate]?.contention > 0.1 ? "loaded" : "unstable"} on ${r.calibrate} to attribute)` : ""
    out.push(`  ${pad(r.label ?? r.id, 32)}${padL(r.base.toFixed(1), 10)}${restated}${padL(r.cur.toFixed(1), 10)}${padL(d, 10)}  ${r.verdict}${why}${r.single ? " *" : ""}`)
  }
  out.push("─".repeat(cal ? 84 : 74))
  out.push(`${cmp.faster} faster • ${cmp.slower} slower • ${cmp.unchanged} unchanged${cmp.inconclusive ? ` • ${cmp.inconclusive} inconclusive` : ""}${cmp.unusable ? ` • ${cmp.unusable} not comparable` : ""}`)
  out.push("a delta inside the case's own measured noise is reported as unchanged, never as an improvement")
  if (cmp.hostNote) out.push(`note: ${cmp.hostNote}`)
  if (!cmp.sameMachine) out.push("WARNING: the baseline was recorded on a DIFFERENT machine profile — these numbers are not comparable")
  if (cmp.missing.length) out.push(`baseline has ${cmp.missing.length} case(s) this run did not measure: ${cmp.missing.slice(0, 5).join(", ")}`)
  if (cmp.regressed) out.push("REGRESSION: at least one case is measurably slower than the baseline")
  return out.join("\n")
}
