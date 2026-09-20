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
import os from "node:os"
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

/**
 * The MCP revision forge should speak.
 *
 * This said "2025-03-26" at v129 and it was wrong twice over: that target was
 * set from memory, and checking it against the specification showed both that
 * the current revision is 2026-07-28 AND that 2025-03-26 is itself a LEGACY
 * revision — so hitting the old target would have achieved nothing at all.
 *
 * The line between the eras is what matters, not the date: <= 2025-11-25 is
 * legacy (a handshake, a negotiated session version, server-initiated
 * requests); >= 2026-07-28 is modern (no handshake, a version per request,
 * MRTR). A client on the wrong side of it cannot talk to the other side.
 */
export const TARGET_MCP_PROTOCOL = "2026-07-28"

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
 * Drive the REAL MCP client against a real stub server over real pipes.
 *
 * The v129 MCP cases were all `exportsFn(m, "someName")` — they asked whether a
 * function existed, which is a question a one-line stub can answer. Protocol
 * behaviour is not like that: "falls back on any non-modern error", "echoes the
 * requestState verbatim", "uses a new id on the retry" are all properties of
 * the BYTES, and the only honest way to check them is to write the bytes.
 *
 * The stub logs everything it receives to a JSONL file, so each case asserts on
 * what actually crossed the pipe rather than on what the client meant to send.
 */
const MCP_STUB = `
import fs from "node:fs"
const mode = process.argv[2], LOG = process.argv[3]
let buf = "", retried = false
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const note = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + "\\n") } catch {} }
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    note(m); handle(m)
  }
})
function handle(m) {
  const { id, method, params } = m
  if (String(method || "").startsWith("notifications/")) return
  if (method === "server/discover") {
    if (mode === "legacy") return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
    if (mode === "legacy_weird") return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } })
    if (mode === "wrongversion" && !retried) {
      retried = true
      return send({ jsonrpc: "2.0", id, error: { code: -32022, message: "unsupported", data: { supported: ["2026-07-28"] } } })
    }
    return send({ jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28"], serverInfo: { name: mode, version: "1" }, capabilities: { tools: {} } } })
  }
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } })
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } })
  if (method === "tools/call") {
    if (mode === "hang") return
    if (mode === "progress") {
      const t = params?._meta?.progressToken
      if (t) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: t, progress: 1, total: 2 } })
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } })
    }
    if (mode === "mrtr") {
      if (!params?.inputResponses) {
        return send({ jsonrpc: "2.0", id, result: { resultType: "input_required", inputRequests: { where: { method: "roots/list", params: {} } }, requestState: "OPAQUE::do-not-touch::9" } })
      }
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "roots=" + (params.inputResponses.where?.roots ?? []).length }] } })
    }
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } })
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
}
`

let mcpStubDir = null
let mcpRun = 0
async function mcpScenario(mode, { cancelAfterMs = 0 } = {}) {
  const out = { era: null, methods: [], received: [], events: [], text: null, tookMs: 0, error: null }
  try {
    if (!mcpStubDir) {
      mcpStubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bench-mcp-"))
      fs.writeFileSync(path.join(mcpStubDir, "stub.mjs"), MCP_STUB)
    }
    const log = path.join(mcpStubDir, `log-${mode}-${mcpRun++}.jsonl`)
    const m = await import("./mcp.js")
    m.clearEraCache?.()
    const spec = { command: process.execPath, args: [path.join(mcpStubDir, "stub.mjs"), mode, log] }
    const client = await m.connectServer(`bench-${mode}-${mcpRun}`, spec,
      { timeoutMs: 6000, onEvent: (e) => out.events.push(e) })
    out.era = client.era ?? null
    const t0 = Date.now()
    try {
      const ac = cancelAfterMs > 0 ? new AbortController() : null
      if (ac) setTimeout(() => ac.abort(), cancelAfterMs)
      const r = await client.callTool("echo", {}, { signal: ac?.signal })
      out.text = r?.text ?? null
    } catch { /* a cancelled or hung call is the POINT of some scenarios */ }
    out.tookMs = Date.now() - t0
    // a cancellation notification is fire-and-forget; let it reach the pipe
    await new Promise((r) => setTimeout(r, 120))
    client.close()
    out.received = String(fs.readFileSync(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    out.methods = out.received.map((x) => x.method)
  } catch (e) {
    out.error = `stub scenario "${mode}" could not run: ${String(e?.message ?? e).slice(0, 140)}`
  }
  return out
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
    id: "mcp-protocol-modern",
    name: "MCP speaks the modern protocol era",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: `pinned to 2024-11-05, a legacy revision — the spec's own matrix says a legacy client meeting a modern server simply fails`,
    async check() {
      const m = await import("./mcp.js")
      const modern = m.MODERN_PROTOCOL_VERSION
      return ok(protocolAtLeast(modern, TARGET_MCP_PROTOCOL) && m.MCP_ERA?.MODERN && m.MCP_ERA?.LEGACY,
        `modern=${modern ?? "none"}, legacy=${m.PROTOCOL_VERSION}, want a client that speaks both`)
    },
  },
  {
    id: "mcp-era-probe",
    name: "the era is probed, and any non-modern answer falls back",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "without a probe forge can only speak one era; and a fallback keyed to one error code is the classic way to get this wrong",
    async check() {
      const legacy = await mcpScenario("legacy")       // answers -32601
      const weird = await mcpScenario("legacy_weird")  // answers -32602
      const modern = await mcpScenario("modern")
      if (legacy.error || weird.error || modern.error) return ok(false, legacy.error || weird.error || modern.error)
      const probedFirst = [legacy, weird, modern].every((r) => r.methods[0] === "server/discover")
      const fellBack = legacy.era === "legacy" && weird.era === "legacy" &&
        legacy.methods.includes("initialize") && weird.methods.includes("initialize")
      const wentModern = modern.era === "modern" && !modern.methods.includes("initialize")
      return ok(probedFirst && fellBack && wentModern,
        `probe-first=${probedFirst}, -32601/-32602 both fall back=${fellBack}, modern skips the handshake=${wentModern}`)
    },
  },
  {
    id: "mcp-version-negotiation",
    name: "an unsupported-version error is negotiated, not fallen back from",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "-32022 means 'modern, but not that revision' — treating it as a fallback signal downgrades a server that was reachable",
    async check() {
      const r = await mcpScenario("wrongversion")
      if (r.error) return ok(false, r.error)
      const retried = r.methods.filter((x) => x === "server/discover").length === 2
      return ok(r.era === "modern" && retried && !r.methods.includes("initialize"),
        `era=${r.era}, discover attempts=${r.methods.filter((x) => x === "server/discover").length}, handshake=${r.methods.includes("initialize")}`)
    },
  },
  {
    id: "mcp-capabilities-declared",
    name: "MCP client declares its own capabilities",
    lane: LANE.PROGRAMME, how: HOW.SURFACE,
    why: "initialize sent `capabilities: {}` — a server may not ask for anything a client never declared, so nothing was ever asked",
    async check() {
      const m = await import("./mcp.js")
      const caps = exportsFn(m, "clientCapabilities") ? m["clientCapabilities"]() : null
      return ok(caps && typeof caps === "object" && Object.keys(caps).length > 0,
        caps ? `declared ${Object.keys(caps).join(",") || "nothing"}` : "no clientCapabilities() export")
    },
  },
  {
    id: "mcp-mrtr",
    name: "a server can ask the client for input mid-call (MRTR)",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "the modern spec replaced server-initiated requests with InputRequiredResult; without it roots and sampling are unreachable",
    async check() {
      const r = await mcpScenario("mrtr")
      if (r.error) return ok(false, r.error)
      const calls = r.received.filter((msg) => msg.method === "tools/call")
      const echoed = calls[1]?.params?.requestState === "OPAQUE::do-not-touch::9"
      const freshId = calls.length === 2 && calls[0].id !== calls[1].id
      const answered = Array.isArray(calls[1]?.params?.inputResponses?.where?.roots)
      return ok(echoed && freshId && answered && /roots=[1-9]/.test(r.text ?? ""),
        `rounds=${calls.length}, verbatim requestState=${echoed}, new id=${freshId}, roots answered=${answered}`)
    },
  },
  {
    id: "mcp-cancel",
    name: "an in-flight MCP call can be cancelled",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "no notifications/cancelled — a slow MCP tool could only be waited out, to the request timeout, with the server still working",
    async check() {
      const r = await mcpScenario("hang", { cancelAfterMs: 120 })
      if (r.error) return ok(false, r.error)
      const cancelled = r.received.find((msg) => msg.method === "notifications/cancelled")
      const call = r.received.find((msg) => msg.method === "tools/call")
      return ok(Boolean(cancelled) && cancelled?.params?.requestId === call?.id && r.tookMs < 3000,
        `server told to stop=${Boolean(cancelled)}, id matched=${cancelled?.params?.requestId === call?.id}, ${r.tookMs}ms`)
    },
  },
  {
    id: "mcp-progress",
    name: "MCP progress notifications reach the run",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "no progressToken support — a long server call was indistinguishable from a hung one",
    async check() {
      const r = await mcpScenario("progress")
      if (r.error) return ok(false, r.error)
      const call = r.received.find((msg) => msg.method === "tools/call")
      const asked = Boolean(call?.params?._meta?.progressToken)
      return ok(asked && r.events.some((e) => e.type === "mcp_progress"),
        `progressToken sent=${asked}, events=${r.events.map((e) => e.type).join(",") || "none"}`)
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
      if (!exportsFn(mod, "summarizeForHistory")) return ok(false, "context.js has no summarizeForHistory()")
      const big = Array.from({ length: 4000 }, (_, i) => `line ${i} of some verbose tool output`).join("\n")
      const out = String(mod["summarizeForHistory"](big, { budget: 2000, tool: "bash" }) ?? "")
      return ok(out.length > 0 && out.length < big.length / 2, `${big.length} chars -> ${out.length}`)
    },
  },
  {
    id: "mcp-server-recovery",
    name: "a server that died mid-session is reconnected, not reported dead",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "a lazily-connected server that crashed stayed memoized as a corpse — every later call in the session returned `is closed (exited …)` and nothing ever retried",
    async check() {
      const m = await import("./mcp.js")
      if (!exportsFn(m, "clientReusable")) return ok(false, "mcp.js has no clientReusable()")
      const reusable = m["clientReusable"]
      const cases = [
        ["a dead client is not reused", await reusable({ isAlive: () => false }), false],
        ["a busy client is reused without a round-trip", await reusable({ isAlive: () => true, lastUsedAt: Date.now() }), true],
        ["an idle client that answers is reused", await reusable({ isAlive: () => true, lastUsedAt: 0, ping: async () => true }), true],
        ["an idle client that does not answer is dropped", await reusable({ isAlive: () => true, lastUsedAt: 0, ping: async () => false }), false],
        ["nothing is not a client", await reusable(null), false],
      ]
      const wrong = cases.filter(([, got, want]) => got !== want).map(([n]) => n)
      // …and the decision has to be ON the reuse path, not merely available
      const src = fs.readFileSync(path.join(HERE, "mcp.js"), "utf8")
      const wired = /if \(await clientReusable\(client\)\) return client/.test(src) &&
        /lazyClients\.delete\(name\)/.test(src)
      return ok(wrong.length === 0 && wired,
        wrong.length ? `wrong: ${wrong.join("; ")}` : wired ? "" : "clientReusable is not on the ensureConnected reuse path")
    },
  },
  {
    id: "run-teaches-next-run",
    name: "a run that ends blocked leaves knowledge the next run reads",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "the READ side was wired (context.js puts lessons in every prompt) but only meta.js and one optional tool ever WROTE one, so a plain runAgent that failed taught nothing",
    async check() {
      // The loop is exercised for real in a throwaway project: record through
      // the same function agent.js calls, read back through the same function
      // context.js calls. What cannot run without a provider — that runAgent
      // reaches the recorder — is checked at the call site.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lesson-"))
      try {
        const L = await import("./lessons.js")
        if (!exportsFn(L, "recordLesson") || !exportsFn(L, "lessonsForPrompt")) return ok(false, "lessons.js is missing its read or write half")
        const marker = "widget assembly refused every write"
        L["recordLesson"]({
          failure: "run ended BLOCKED on MUTATIONS_ALL_REFUSED", cause: marker,
          // a blocked run has no proven repair — only the next step the
          // completion gate named, which is what agent.js records
          solution: "re-run with a policy that allows the writes the task needs",
          task: "assemble the widget", applicableContext: "assemble the widget", confidence: 0.35,
        }, cwd)
        const back = String(L["lessonsForPrompt"]("assemble the widget", { cwd, limit: 3 }) ?? "")
        // …and the unproven next step must survive the render, not be printed
        // as an empty "fix that worked"
        const readable = back.includes(marker) && /not repaired — the next step recorded was: re-run with a policy/.test(back)
        const src = fs.readFileSync(path.join(HERE, "agent.js"), "utf8")
        const wired = /const \{ recordLesson \} = await import\("\.\/lessons\.js"\)/.test(src) && /\brecordLesson\(\{/.test(src)
        return ok(readable && wired,
          !readable ? "a recorded lesson did not come back out of the reader"
            : "agent.js never records one, so the reader has nothing to read")
      } finally { try { fs.rmSync(cwd, { recursive: true, force: true }) } catch {} }
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
        id: r.id, name: r.name, lane: LANE.CAPABILITY, how: HOW.EXERCISED, ok: r.ok,
        // v130: name the failing metric. This read `note: ""`, so a capability
        // failure in the lane report said only that the case failed — chasing
        // one took five separate isolation attempts.
        note: r.ok ? "" : Object.entries(r.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k).join(","),
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
