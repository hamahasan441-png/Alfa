/**
 * forge — FORGE-SUITE: one score, several lanes (v129, zero dependencies)
 *
 * WHY THIS EXISTS
 *
 * "Is forge getting better?" had no answer, because five separate harnesses
 * each answered a different question and none of them combined:
 *
 *   bench.js                 24 decision-quality cases     100% — cannot improve
 *   perfbench.js             tool microbenchmarks          timings vs a baseline
 *   evalbench.js             was the task SOLVED           needs a live provider
 *   agent-benchmark.js       wraps evalbench's EVAL_TASKS  NOT_RUN without one
 *   intelligence-benchmark   deterministic integration     its own score
 *
 * A capability benchmark pinned at 100% is a thermometer stuck at one reading:
 * `tests/test-v29.mjs` asserts `score === 100` and `BENCH_CASES.length === 24`,
 * so bench.js is frozen BY DESIGN and must stay that way. It is a regression
 * guard, not a growth target.
 *
 * So this module does not touch it. It COMPOSES the existing harnesses (§36 —
 * no sixth implementation) and adds one new lane, `programme`, holding the
 * capabilities forge does not have yet. Those cases FAIL on the day they are
 * written. That is the point: a benchmark you already pass measures nothing,
 * and "beat your own benchmark" needs a benchmark with room above it.
 *
 * HONESTY RULES
 *
 *   - A lane that cannot run (no provider, no baseline) is SKIPPED, never
 *     failed, and is excluded from the denominator. The report says so.
 *   - Every case declares HOW it is checked: "exercised" means the behaviour
 *     ran, "surface" means only its presence was checked. A surface check is
 *     weaker evidence and is labelled as such rather than quietly counted
 *     as equal.
 *   - A programme case is deleted only when the capability ships, never
 *     because it is inconvenient.
 */
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "./version.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const LANE = Object.freeze({
  CAPABILITY: "capability",   // bench.js — decision quality (frozen at 24)
  PROGRAMME: "programme",     // what forge cannot do yet
  SPEED: "speed",             // perfbench.js — wall time
  AUTONOMY: "autonomy",       // evalbench — did it actually finish the job
})

/** How strong a case's evidence is. Reported, never averaged away. */
export const HOW = Object.freeze({
  EXERCISED: "exercised",     // the behaviour was run
  SURFACE: "surface",         // only its presence was checked
  MEASURED: "measured",       // a number was taken off the clock
})

/**
 * Boot budget for the path that actually matters.
 *
 * A first pass at this measured `time node forge.js --version` once and read
 * 1.0s. Both halves of that were wrong: a single run is mostly cold-cache and
 * shell overhead, and `--version` short-circuits long before the agent loads.
 * Best-of-7, spawned, on this tree at v128:
 *
 *     bare node process        28ms
 *     + import agent.js       178ms     <- the real pre-first-model-call cost
 *     + import chat.js        205ms
 *     forge --version          81ms
 *
 * So startup is not 1.0s and never was. What IS real is ~150ms of module
 * loading before an agent run can do anything, driven by 48/56/33 eager
 * top-level imports in agent/chat/tools. 120ms is roughly half of that
 * overhead removed — a target worth hitting and small enough to be honest.
 */
export const BOOT_BUDGET_MS = 120

/** The MCP revision forge should speak. 2024-11-05 is what it speaks today. */
export const TARGET_MCP_PROTOCOL = "2025-03-26"

const ok = (pass, note = "") => ({ pass: Boolean(pass), note: String(note || "") })

/**
 * Does a module export a callable under this name?
 *
 * Looked up by STRING, deliberately. These probes ask about exports that do
 * not exist yet, and writing them as `m.cancelCall` would make the repo's
 * import-integrity audit (tests/test-v129, tests/test-package — it resolves
 * namespace property access) report a broken reference for every capability
 * on the roadmap. The audit is right; a missing export should be loud. So the
 * question is asked in a form that is a lookup rather than a reference.
 */
const exportsFn = (mod, name) => typeof mod?.[name] === "function"

/**
 * Spawn a fresh node process that imports `spec`, and return the best
 * (lowest) wall time of N runs — the real cost of booting that path.
 *
 * Best-of-N, not mean: a shared CI runner produces spikes that have nothing to
 * do with the code, and the FASTEST observation is the one least polluted by
 * another process. test-v101 learned this the hard way when a mean-based
 * timing assertion failed 3 runs in 8 under load.
 */
export async function measureBootMs({ runs = 5, timeoutMs = 60000, spec = "./agent.js" } = {}) {
  const target = path.join(HERE, spec.replace(/^\.\//, ""))
  const code = `await import(${JSON.stringify(target)})`
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now()
    const okRun = await new Promise((resolve) => {
      execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: HERE, timeout: timeoutMs }, (err) => resolve(!err))
    })
    if (!okRun) return { ms: null, error: `could not import ${spec} in a fresh process` }
    best = Math.min(best, Date.now() - t0)
  }
  return { ms: best, error: null }
}

/** Semver-ish date-or-number compare that tolerates MCP's YYYY-MM-DD scheme. */
export function protocolAtLeast(have, want) {
  const norm = (v) => String(v ?? "").trim()
  const a = norm(have), b = norm(want)
  if (!a || !b) return false
  return a >= b   // both are zero-padded YYYY-MM-DD; lexical order is date order
}

/**
 * The programme lane: capabilities forge does not have yet.
 *
 * Each case is a predicate over the real modules. Every one of these fails at
 * v128 — verified by measurement, not assumed:
 *
 *   mcp.js greps for "sampling", "roots", "ping", "progressToken",
 *   "notifications/cancelled", "logging/setLevel" all return ZERO, and its
 *   initialize sends `capabilities: {}` under the comment "a minimal client:
 *   we consume tools, advertise nothing".
 */
export const PROGRAMME_CASES = [
  {
    id: "mcp-protocol-current",
    name: "MCP speaks a current protocol revision",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "pinned to 2024-11-05; newer revisions carry cancellation, progress and structured content",
    async check() {
      const m = await import("./mcp.js")
      return ok(protocolAtLeast(m.PROTOCOL_VERSION, TARGET_MCP_PROTOCOL),
        `PROTOCOL_VERSION=${m.PROTOCOL_VERSION}, want >= ${TARGET_MCP_PROTOCOL}`)
    },
  },
  {
    id: "mcp-capabilities-declared",
    name: "MCP client declares its own capabilities",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "initialize sends `capabilities: {}` — the server cannot know what forge supports",
    async check() {
      const m = await import("./mcp.js")
      const caps = exportsFn(m, "clientCapabilities") ? m["clientCapabilities"]() : null
      return ok(caps && typeof caps === "object" && Object.keys(caps).length > 0,
        caps ? `declared ${Object.keys(caps).join(",") || "nothing"}` : "no clientCapabilities() export")
    },
  },
  {
    id: "mcp-cancel",
    name: "an in-flight MCP call can be cancelled",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "no notifications/cancelled — a slow MCP tool can only be waited out",
    async check() {
      const m = await import("./mcp.js")
      return ok(exportsFn(m, "cancelCall"), "no cancelCall() export")
    },
  },
  {
    id: "mcp-progress",
    name: "MCP progress notifications reach the run",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "no progressToken support — a long server call is indistinguishable from a hung one",
    async check() {
      const m = await import("./mcp.js")
      return ok(exportsFn(m, "onProgress"), "no onProgress() export")
    },
  },
  {
    id: "mcp-sampling",
    name: "an MCP server can ask the model for a completion",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "sampling/createMessage is what makes a server intelligent rather than a remote function table",
    async check() {
      const m = await import("./mcp.js")
      return ok(exportsFn(m, "handleSampling"), "no handleSampling() export")
    },
  },
  {
    id: "mcp-roots",
    name: "MCP roots are advertised to servers",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "roots/list tells a server which directories it may reason about",
    async check() {
      const m = await import("./mcp.js")
      return ok(exportsFn(m, "listRoots"), "no listRoots() export")
    },
  },
  {
    id: "mcp-ping",
    name: "a dead MCP server is detected rather than awaited",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "no ping — a silently dead stdio server looks identical to a slow one",
    async check() {
      const m = await import("./mcp.js")
      return ok(exportsFn(m, "pingServer"), "no pingServer() export")
    },
  },
  {
    id: "tool-result-summary",
    name: "a large tool result is summarised before it enters history",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "raw tool output goes straight into context; only whole-history compaction exists, and it runs far too late",
    async check() {
      // Deliberately asks context.js, the module that already owns the token
      // budget, rather than a new sibling: §36 says one implementation per
      // responsibility, and "how much of the context may this consume" is
      // already its job. It also keeps this probe from naming a file that
      // does not exist, which the packaging audit correctly rejects.
      const mod = await import("./context.js")
      if (!exportsFn(mod, "summarizeToolResult")) return ok(false, "context.js has no summarizeToolResult()")
      const big = Array.from({ length: 4000 }, (_, i) => `line ${i} of some verbose tool output`).join("\n")
      const out = String(mod["summarizeToolResult"](big, { budget: 2000, tool: "bash" }) ?? "")
      return ok(out.length > 0 && out.length < big.length / 2, `${big.length} chars -> ${out.length}`)
    },
  },
  {
    id: "single-file-build",
    name: "forge can be built as one self-contained file",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "install is npm-only today; a single .mjs would make it droppable anywhere",
    async check() {
      const script = path.join(HERE, "scripts", "build-single-file.mjs")
      return ok(fs.existsSync(script), "scripts/build-single-file.mjs missing")
    },
  },
  {
    id: "boot-budget",
    name: `an agent run boots in under ${BOOT_BUDGET_MS}ms`,
    lane: LANE.PROGRAMME, how: HOW.MEASURED,
    why: "178ms to import agent.js in a fresh process (bare node is 28ms) — ~150ms of eager imports before anything happens",
    async check() {
      const { ms, error } = await measureBootMs()
      if (error) return ok(false, error)
      return ok(ms <= BOOT_BUDGET_MS, `${ms}ms (budget ${BOOT_BUDGET_MS}ms)`)
    },
  },
]

async function runProgramme() {
  const results = []
  for (const c of PROGRAMME_CASES) {
    let r
    try { r = await c.check() } catch (e) { r = ok(false, `threw: ${String(e?.message ?? e).slice(0, 120)}`) }
    results.push({ id: c.id, name: c.name, lane: c.lane, how: c.how, why: c.why, ok: r.pass, note: r.note })
  }
  return { ran: true, results }
}

async function runCapability() {
  try {
    const { runBench } = await import("./bench.js")
    const s = runBench()
    return {
      ran: true,
      results: s.results.map((r) => ({
        id: r.id, name: r.name, lane: LANE.CAPABILITY, how: HOW.EXERCISED, ok: r.ok, note: "",
      })),
    }
  } catch (e) {
    return { ran: false, skipped: `bench.js unavailable: ${String(e?.message ?? e).slice(0, 100)}`, results: [] }
  }
}

/**
 * Speed lane. perfbench compares against a SAVED baseline; with no baseline
 * there is nothing to pass or fail, so the lane is skipped rather than
 * invented. It is still reported, because a missing baseline is itself worth
 * seeing.
 */
async function runSpeed({ cwd }) {
  try {
    const pb = await import("./perfbench.js")
    const baseline = pb.loadPerfBaseline(cwd)
    if (!baseline) {
      return { ran: false, skipped: `no ${pb.PERF_FILE} for this project — run \`forge perf --save\` to create one`, results: [] }
    }
    const run = await pb.runPerf({ cwd })
    const cmp = pb.comparePerf(baseline, run)
    // A case passes when it did not get measurably SLOWER. "No improvement" is
    // a result; a regression is a stop. Cases perfbench itself calls unusable
    // ("new", "n/a") are not scored either way — they proved nothing.
    const scorable = cmp.rows.filter((r) => r.verdict === "faster" || r.verdict === "slower" || r.verdict === "unchanged")
    return {
      ran: scorable.length > 0,
      skipped: scorable.length ? null : "no comparable perf cases (baseline and run share no ids)",
      note: cmp.sameMachine ? null : "baseline was recorded on a DIFFERENT machine — timings are not comparable",
      results: scorable.map((r) => ({
        id: `perf-${r.id}`,
        name: r.label ?? r.id,
        lane: LANE.SPEED,
        how: HOW.MEASURED,
        ok: r.verdict !== "slower",
        note: `${r.verdict} ${r.cur}ms vs ${r.base}ms (${r.pct > 0 ? "+" : ""}${r.pct}%)`,
      })),
    }
  } catch (e) {
    return { ran: false, skipped: `perfbench unavailable: ${String(e?.message ?? e).slice(0, 100)}`, results: [] }
  }
}

/**
 * Autonomy lane. Needs a live provider. Without one it is SKIPPED — never
 * passed (we proved nothing) and never failed (nothing was broken).
 */
async function runAutonomy({ provider, runAgent, tasks, timeoutMs }) {
  if (!provider || !runAgent) {
    return { ran: false, skipped: "no live provider — pass { provider, runAgent } to score autonomy", results: [] }
  }
  try {
    const eb = await import("./evalbench.js")
    const out = await eb.runEval({ tasks: tasks ?? eb.EVAL_TASKS, runAgent, provider, timeoutMs })
    const rows = Array.isArray(out) ? out : (out?.results ?? [])
    return {
      ran: true,
      results: rows.map((r) => ({
        id: `eval-${r.id ?? r.task ?? "task"}`, name: String(r.name ?? r.id ?? "task"),
        lane: LANE.AUTONOMY, how: HOW.EXERCISED, ok: r.ok === true || r.solved === true,
        note: r.status ? String(r.status) : "",
      })),
    }
  } catch (e) {
    return { ran: false, skipped: `evalbench unavailable: ${String(e?.message ?? e).slice(0, 100)}`, results: [] }
  }
}

/**
 * Run every lane that can run and return ONE score.
 *
 * `only` restricts to named lanes. `provider`/`runAgent` unlock autonomy.
 */
export async function runSuite({
  cwd = process.cwd(), only = null, provider = null, runAgent = null,
  tasks = null, timeoutMs = 180000,
} = {}) {
  const t0 = Date.now()
  const want = (l) => !only || (Array.isArray(only) ? only.includes(l) : only === l)

  const lanes = {}
  if (want(LANE.CAPABILITY)) lanes[LANE.CAPABILITY] = await runCapability()
  if (want(LANE.PROGRAMME)) lanes[LANE.PROGRAMME] = await runProgramme()
  if (want(LANE.SPEED)) lanes[LANE.SPEED] = await runSpeed({ cwd })
  if (want(LANE.AUTONOMY)) lanes[LANE.AUTONOMY] = await runAutonomy({ provider, runAgent, tasks, timeoutMs })

  const results = []
  const laneStats = {}
  for (const [name, lane] of Object.entries(lanes)) {
    const passed = lane.results.filter((r) => r.ok).length
    laneStats[name] = {
      ran: lane.ran,
      skipped: lane.skipped ?? null,
      passed,
      total: lane.results.length,
      score: lane.results.length ? Math.round((passed / lane.results.length) * 1000) / 10 : null,
    }
    // a skipped lane contributes nothing in either direction
    if (lane.ran) results.push(...lane.results)
  }

  const passed = results.filter((r) => r.ok).length
  const total = results.length

  // A FAILING PROGRAMME CASE IS NOT A BROKEN BUILD.
  //
  // The programme lane holds capabilities forge does not have yet; every case
  // in it fails the day it is written and keeps failing until that capability
  // ships. If those counted as errors, `forge bench` would exit non-zero
  // forever and CI would learn to ignore it — which is exactly how a red
  // build becomes furniture.
  //
  // So the two lanes that are GUARDS (capability: decision quality that used
  // to work; speed: timings that used to be faster) decide the exit code, and
  // the programme lane is reported as "not yet" rather than "failed".
  const regressions = results.filter((r) => !r.ok && (r.lane === LANE.CAPABILITY || r.lane === LANE.SPEED))
  const notYet = results.filter((r) => !r.ok && r.lane === LANE.PROGRAMME)

  return {
    version: VERSION,
    name: "FORGE-SUITE",
    passed,
    failed: total - passed,
    total,
    score: total ? Math.round((passed / total) * 1000) / 10 : 0,
    regressed: regressions.length > 0,
    regressions: regressions.map((r) => r.id),
    notYet: notYet.length,
    lanes: laneStats,
    results,
    ms: Date.now() - t0,
  }
}

const dimNote = (t) => String(t)

export function formatSuite(summary, { json = false } = {}) {
  if (json) return JSON.stringify(summary, null, 2)
  const lines = []
  lines.push(`FORGE-SUITE v${summary.version}  ${summary.passed}/${summary.total}  score ${summary.score}%  ${summary.ms}ms`)
  for (const [name, s] of Object.entries(summary.lanes)) {
    if (!s.ran) { lines.push(`  ${name.padEnd(11)} SKIPPED  ${s.skipped ?? ""}`); continue }
    lines.push(`  ${name.padEnd(11)} ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)}  ${s.score}%`)
  }
  const regressions = summary.results.filter((r) => !r.ok && r.lane !== LANE.PROGRAMME)
  if (regressions.length) {
    lines.push("")
    lines.push(`REGRESSED (${regressions.length}) — these used to pass:`)
    for (const f of regressions) lines.push(`  ${f.id.padEnd(24)} ${f.note || f.name}`)
  }
  const notYet = summary.results.filter((r) => !r.ok && r.lane === LANE.PROGRAMME)
  if (notYet.length) {
    lines.push("")
    lines.push(`not yet (${notYet.length}) — the room above the benchmark:`)
    for (const f of notYet) {
      lines.push(`  ${f.id.padEnd(24)} ${f.note || f.name}`)
      if (f.why) lines.push(`  ${" ".repeat(24)} ${dimNote(f.why)}`)
    }
  }
  return lines.join("\n")
}
