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
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "./version.js"
import { DISCIPLINE } from "./disciplines.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const LANE = Object.freeze({
  CAPABILITY: "capability",   // bench.js — decision quality (frozen at 24)
  DISCIPLINE: "discipline",   // disciplines.js — the five engineering invariants
  PROGRAMME: "programme",     // what forge cannot do yet
  SPEED: "speed",             // perfbench.js — wall time
  AUTONOMY: "autonomy",       // evalbench — did it actually finish the job
})

/**
 * The lanes that DECIDE THE EXIT CODE. Named once, because `runSuite` and
 * `formatSuite` each had their own idea of what a regression is — runSuite
 * counted capability+speed, formatSuite counted everything that was not
 * programme — so an autonomy failure printed under "REGRESSED — these used to
 * pass" while the summary said `regressed: false` and the command exited 0.
 */
/*
 * v137 adds `discipline`. It belongs here and the programme lane does not,
 * for the same reason speed does: every discipline case asserts something
 * that is TRUE TODAY, exercised against the real modules. A red one means
 * forge regressed, which is exactly what a guard lane is for. Roadmap work in
 * those same five subjects stays in the programme lane, tagged with its
 * discipline — so the axes stay separate and neither lane learns to be red.
 */
export const GUARD_LANES = new Set(["capability", "discipline", "speed"])

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
 * What booting cost when this case was written (best-of-7, spawned, v128).
 *
 * The budget has to be below THIS, not below whatever the current host
 * happens to measure. v133 learned the difference the hard way: the
 * non-vacuity check for `boot-budget` was `BOOT_BUDGET_MS < measured`, which
 * is a stopwatch — on a fast CI runner the measurement dropped under the
 * budget, the case passed, and every assertion protecting "the benchmark has
 * room above it" failed at once. Two suites went red for being on a quick
 * machine.
 */
export const BOOT_BASELINE_MS = 178

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
    if (mode === "elicit") {
      if (!params?.inputResponses) {
        return send({ jsonrpc: "2.0", id, result: { resultType: "input_required", requestState: "OPAQUE::elicit::1", inputRequests: { who: { method: "elicitation/create", params: {
          mode: "form",
          message: "Please provide your GitHub username",
          requestedSchema: { type: "object", properties: { name: { type: "string" }, count: { type: "integer" } }, required: ["name"] },
        } } } } })
      }
      const r = params.inputResponses.who ?? {}
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.action + ":" + (r.content?.name ?? "-") + ":" + (r.content?.count ?? "-") }] } })
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
 * A hosted legacy MCP server, on the loopback, with a back-channel.
 *
 * Unlike the stdio stubs this one cannot be a spawned file: the thing under
 * test is an HTTP transport, so the server has to be an HTTP server. It is
 * torn down in a `finally` — a bench case that leaks a listening socket would
 * hold the whole suite open.
 */
async function httpBackChannelScenario({ dropAfterOpen = false } = {}) {
  const out = { opened: false, declared: false, answered: false, rootsOk: false, reopened: false, error: null, gets: 0 }
  let srv = null, sse = null, client = null
  try {
    const http = await import("node:http")
    const posts = []
    srv = http.createServer((req, res) => {
      if (req.method === "GET") {
        out.gets += 1
        if (out.gets > 1) out.reopened = true
        out.opened = true
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.flushHeaders()
        sse = res
        return
      }
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        let msg = null
        try { msg = JSON.parse(body) } catch { /* recorded as null */ }
        posts.push(msg)
        res.writeHead(200, { "content-type": "application/json" })
        if (msg?.method === "initialize") {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hosted", version: "1" } } }))
        }
        if (msg?.method === "server/discover") {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }))
        }
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg?.id ?? null, result: {} }))
      })
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${srv.address().port}/mcp`
    const m = await import("./mcp.js")
    m.clearEraCache?.()
    client = await m.connectServer(`bench-http-${mcpRun++}`, { url, allowPrivate: true }, { timeoutMs: 4000 })
    const init = posts.find((p) => p?.method === "initialize")
    out.declared = Boolean(init?.params?.capabilities?.roots)
    if (dropAfterOpen) {
      // The server hangs up on the channel. A client that re-opens will show
      // up as a second GET within the window below.
      try { sse?.end() } catch {}
      sse = null
      const until = Date.now() + 2000
      while (Date.now() < until && !out.reopened) await new Promise((r) => setTimeout(r, 50))
      return out
    }
    sse?.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 4242, method: "roots/list", params: {} })}\n\n`)
    const deadline = Date.now() + 3000
    let reply = null
    while (Date.now() < deadline && !reply) {
      reply = posts.find((p) => p?.id === 4242 && p?.method === undefined) ?? null
      if (!reply) await new Promise((r) => setTimeout(r, 25))
    }
    out.answered = Boolean(reply)
    out.rootsOk = Array.isArray(reply?.result?.roots) && reply.result.roots.length > 0 &&
      reply.result.roots.every((x) => String(x?.uri ?? "").startsWith("file://"))
  } catch (e) {
    out.error = `http back-channel scenario could not run: ${String(e?.message ?? e).slice(0, 140)}`
  } finally {
    // Teardown is AWAITED. `srv.close()` is asynchronous, and a listening
    // socket still winding down while the speed lane starts timing process
    // boots is measurement noise this case would be injecting into the lane
    // that runs after it.
    try { client?.close() } catch {}
    try { sse?.end() } catch {}
    if (srv) {
      try { srv.closeAllConnections?.() } catch {}
      await new Promise((r) => { try { srv.close(r) } catch { r() } })
    }
  }
  return out
}

/**
 * v150: a headless run that is KILLED — the way a harness ends a task that
 * ran out of time — and whether it still leaves its result file.
 *
 * The model is an in-process Anthropic-wire stub that asks for the same slow
 * bash command forever, so the run is guaranteed to be mid-flight when the
 * SIGTERM lands. Not tests/tbench-stub-model.mjs: tests/ is not shipped, and
 * this case must run from an installed package.
 */
async function headlessTerminatedScenario({ killAfterSteps = 2, deadlineMs = 15000 } = {}) {
  const out = { steps: 0, exit: null, signal: null, file: false, status: null, inputTokens: 0, error: null }
  const http = await import("node:http")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-term-case-"))
  const resultFile = path.join(dir, "result.json")
  let srv = null, child = null
  try {
    let n = 0
    srv = http.createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        n += 1
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: `msg_${n}`, type: "message", role: "assistant", model: "stub", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `toolu_${n}`, name: "bash", input: { command: `sleep 0.2; echo tick-${n}` } }],
          usage: { input_tokens: 100, output_tokens: 10 },
        }))
      })
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    const base = `http://127.0.0.1:${srv.address().port}`
    fs.mkdirSync(path.join(dir, "home"))
    fs.mkdirSync(path.join(dir, "work"))
    child = spawn(process.execPath, [path.join(HERE, "forge.js"), "agent", "--headless", "--yolo",
      "--provider", "anthropic", "--model", "stub", "--base-url", base, "--max-steps", "500",
      "--result-json", resultFile, "--", "keep going"], {
      cwd: path.join(dir, "work"),
      env: { PATH: process.env.PATH, HOME: path.join(dir, "home"), ANTHROPIC_API_KEY: "stub-key", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const exited = new Promise((r) => child.once("exit", (code, signal) => { out.exit = code; out.signal = signal; r() }))
    const until = Date.now() + deadlineMs
    let log = ""
    child.stdout.on("data", (c) => { log += c })
    while (Date.now() < until && out.exit === null) {
      out.steps = (log.match(/\[step \d+\]/g) ?? []).length
      if (out.steps >= killAfterSteps) break
      await new Promise((r) => setTimeout(r, 50))
    }
    if (out.exit !== null) { out.error = `forge exited on its own (${out.exit}) before it could be killed`; return out }
    child.kill("SIGTERM")
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 5000)
    await exited
    clearTimeout(timer)
    out.file = fs.existsSync(resultFile)
    if (out.file) {
      try {
        const j = JSON.parse(fs.readFileSync(resultFile, "utf8"))
        out.status = j.status ?? null
        out.inputTokens = Number(j.usage?.inputTokens ?? 0)
      } catch { out.error = "the result file is not JSON" }
    }
  } catch (e) {
    out.error = `terminated-run scenario could not run: ${String(e?.message ?? e).slice(0, 140)}`
  } finally {
    try { child?.kill("SIGKILL") } catch {}
    if (srv) {
      try { srv.closeAllConnections?.() } catch {}
      await new Promise((r) => { try { srv.close(r) } catch { r() } })
    }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.CONTEXT,
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
    discipline: DISCIPLINE.HARNESS,
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
    discipline: DISCIPLINE.LOOP,
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
    id: "mcp-elicitation",
    name: "an MCP server can ask the USER for a value mid-call",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "forge never declares `elicitation`, and the spec forbids a server asking for an undeclared capability — so a server that needs a value from the human cannot get one",
    async check() {
      // v142: EXERCISED, not SURFACE. Declaring the capability is not the
      // capability — the old check would have passed on a `clientCapabilities`
      // that named `elicitation` over a client that could not answer one. This
      // drives a real stub server through the whole path: InputRequiredResult
      // → fulfilInputRequests → handleElicitation → the installed asker → the
      // retry carrying the typed values.
      const a = await import("./ask.js")
      const m = await import("./mcp.js")
      const answers = ["y", "octocat", "3"]
      let asked = 0
      a.setAsker(async () => answers[Math.min(asked++, answers.length - 1)])
      let r, caps, capsAlone
      try {
        caps = m.clientCapabilities()
        r = await mcpScenario("elicit")
      } finally { a.clearAsker() }
      // With nobody to ask, the capability must NOT be declared: a server is
      // entitled to ask for what a client declares, and would get silence.
      capsAlone = a.stdioIsInteractive() ? null : m.clientCapabilities()
      if (r.error) return ok(false, r.error)
      const declared = Boolean(caps?.elicitation?.form)
      const withheld = capsAlone === null ? true : !capsAlone.elicitation
      const calls = r.received.filter((msg) => msg.method === "tools/call")
      const echoed = calls[1]?.params?.requestState === "OPAQUE::elicit::1"
      const answer = calls[1]?.params?.inputResponses?.who
      const typed = answer?.action === "accept" && answer?.content?.name === "octocat" && answer?.content?.count === 3
      return ok(declared && withheld && echoed && typed && r.text === "accept:octocat:3",
        `declared=${declared}, withheld with no human=${withheld}, asked=${asked}, verbatim requestState=${echoed}, typed answer=${typed}, server saw "${r.text}"`)
    },
  },
  {
    id: "mcp-http-back-channel",
    name: "a HOSTED legacy MCP server can ask forge for anything",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "the legacy HTTP handshake declares `capabilities: {}` on purpose — over POST-only Streamable HTTP there is no channel to answer a server-initiated request on, so hosted legacy servers get a client that can never be asked",
    async check() {
      // v143: EXERCISED, not SURFACE. The old check grepped mcp.js for a GET,
      // which a GET that opened nothing would have satisfied — and declaring
      // capabilities was never the capability either. This runs a real HTTP
      // server on the loopback, lets it send a server-initiated `roots/list`
      // down the SSE channel, and asserts forge's ANSWER came back.
      const r = await httpBackChannelScenario()
      if (r.error) return ok(false, r.error)
      return ok(r.declared && r.answered && r.rootsOk,
        `GET opened=${r.opened}, capabilities declared=${r.declared}, server request answered=${r.answered}, real roots=${r.rootsOk}`)
    },
  },
  {
    id: "mcp-elicitation-url",
    name: "an MCP server can send the user to a URL for a secret",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "form mode must NOT carry passwords, API keys or payment details — the spec says so — so URL mode is the only way a server can obtain one, and forge declares only `form`: a server needing a credential has no route to the user at all",
    async check() {
      // v143 opened this; v144 closes it. EXERCISED throughout: the check is
      // the whole flow, with the hand-off faked so no browser window opens on
      // whoever is running the benchmark — everything before the hand-off,
      // including the consent prompt and the url vetting, is the real code.
      const a = await import("./ask.js")
      const b = await import("./openurl.js")
      const m = await import("./mcp.js")
      const opened = []
      const asked = []
      a.setAsker(async (p) => { asked.push(p); return "y" })
      b.setUrlOpener(async (href) => { opened.push(href); return { ok: true, reason: "" } })
      let caps, res, refused
      try {
        caps = m.clientCapabilities()
        res = await m.handleElicitation(
          { mode: "url", message: "Please provide your API key", url: "https://accounts.example.com/oauth/authorize" },
          { name: "bench" })
        // A scheme an operating system would execute must never reach the
        // opener, whatever the user answers.
        refused = await m.handleElicitation(
          { mode: "url", message: "sign in", url: "javascript:alert(1)" }, { name: "bench" })
      } finally { a.clearAsker(); b.clearUrlOpener() }
      const declared = Boolean(caps?.elicitation?.url)
      const accepted = res?.action === "accept" && res?.content === undefined
      const shown = asked.some((p) => p.includes("https://accounts.example.com/oauth/authorize"))
      const safe = refused?.action === "decline" && opened.length === 1
      return ok(declared && accepted && shown && safe,
        `declared=${declared}, accept-without-content=${accepted}, full url shown before consent=${shown}, dangerous scheme refused=${safe}`)
    },
  },
  {
    id: "mcp-back-channel-reconnect",
    name: "a dropped MCP back-channel is re-opened",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "v143 opened the SSE channel and declared capabilities on the strength of it; if the stream then ends — the server restarted, a proxy timed it out — forge notices and does nothing, so a long session keeps the declaration and loses the channel",
    async check() {
      // Open a real channel, end it from the SERVER side, and see whether
      // forge comes back. This is the honest successor to the case v143
      // closed: the capability exists, its durability does not.
      const r = await httpBackChannelScenario({ dropAfterOpen: true })
      if (r.error) return ok(false, r.error)
      return ok(r.reopened,
        r.reopened ? `channel opened, dropped by the server, re-opened (${r.gets} GETs)`
          : `channel opened=${r.opened}, dropped by the server, re-opened=${r.reopened} — the declaration outlives the channel it was based on`)
    },
  },
  {
    id: "run-teaches-on-success",
    name: "a run that succeeded the HARD way teaches the next one",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "v132 records a lesson only when a run ends blocked; three failed approaches followed by one that worked is the MOST useful thing to remember, and it is thrown away",
    async check() {
      // The reader already distinguishes them — `formatLessons` says "fix that
      // worked" only for a proven repair — so what is missing is a writer that
      // can name WHICH attempt was the one that worked.
      const L = await import("./lessons.js")
      if (!exportsFn(L, "recordLesson")) return ok(false, "lessons.js has no recordLesson()")
      const src = fs.readFileSync(path.join(HERE, "agent.js"), "utf8")
      // The property is "a COMPLETED run records a PROVEN repair", and it has
      // to be checked as one thing. An earlier version of this case tested
      // `recordsSuccess && !onlyOnFailure`, which a `successfulRepair:` field
      // bolted onto the failure-only branch would have satisfied — and which
      // would ALSO have broken the day the (correct) failure branch stayed.
      // Requiring the field inside a COMPLETED-gated block is the real test.
      const onCompleted = /resStatus === "COMPLETED"\)? \{[\s\S]{0,1400}?successfulRepair:/.test(src)
      const derived = /provenRepairs\(/.test(src)
      return ok(onCompleted && derived,
        !derived ? "nothing derives WHICH attempt worked from the run's own evidence"
          : "no successful-repair lesson is recorded on a run that COMPLETED")
    },
  },
  {
    id: "single-file-build",
    name: "forge can be built as one self-contained file",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    why: "install is npm-only; a single .mjs makes it droppable on any box with node and no registry",
    async check() {
      // Actually BUILD it and actually RUN it. A file-exists check would pass
      // on a script that produces a broken artifact, which is the failure this
      // case is supposed to notice.
      const script = path.join(HERE, "scripts", "build-single-file.mjs")
      if (!fs.existsSync(script)) return ok(false, "scripts/build-single-file.mjs missing")
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sfb-case-"))
      const out = path.join(dir, "forge.mjs")
      try {
        const node = (args, env) => new Promise((resolve) => {
          execFile(process.execPath, args, { cwd: HERE, timeout: 180000, env: { ...process.env, NO_COLOR: "1", ...env } },
            (err, stdout) => resolve({ err, out: String(stdout || "").trim() }))
        })
        const built = await node([script, "--out", out])
        if (built.err || !fs.existsSync(out)) return ok(false, `build failed: ${String(built.err?.message ?? "no artifact").slice(0, 120)}`)
        // a fresh FORGE_HOME, so this measures a COLD install, not a warm cache
        const home = path.join(dir, "home")
        const mine = await node([out, "--version"], { FORGE_HOME: home })
        const theirs = await node([path.join(HERE, "forge.js"), "--version"], { FORGE_HOME: home })
        const size = fs.statSync(out).size
        return ok(!mine.err && mine.out === theirs.out && mine.out.length > 0,
          mine.err ? `the artifact did not run: ${String(mine.err.message).slice(0, 100)}`
            : mine.out !== theirs.out ? `artifact says ${JSON.stringify(mine.out)}, source says ${JSON.stringify(theirs.out)}`
            : `${(size / 1024).toFixed(0)}KB, ${mine.out}`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
    },
  },
  {
    id: "headless-terminated-result",
    name: "a headless run that is killed still reports what it spent",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "v149 made forge a Terminal-Bench agent, and a harness ends a task that runs out of time by killing it; measured at v150, a SIGTERM after 12 steps exited 143 with NO result file, so the steps and tokens of every timed-out task vanish from the report — exactly the tasks whose cost matters most",
    async check() {
      const r = await headlessTerminatedScenario()
      if (r.error) return ok(false, r.error)
      const reported = r.file && r.status !== null && r.inputTokens > 0
      return ok(reported,
        r.file ? `killed after ${r.steps} steps: result file status=${r.status}, input tokens=${r.inputTokens}`
          : `killed after ${r.steps} steps (exit ${r.exit ?? r.signal}): no result file — what the run spent is lost`)
    },
  },
  {
    id: "boot-budget",
    name: `an agent run boots in under ${BOOT_BUDGET_MS}ms`,
    lane: LANE.PROGRAMME, how: HOW.MEASURED,
    why: "v134 took it from 178ms to ~112ms by deferring node:http/https/net/dns (netlazy.js); what is left is the 106-module graph itself, not builtins",
    async check() {
      const { ms, error } = await measureBootMs()
      if (error) return ok(false, error)
      return ok(ms <= BOOT_BUDGET_MS, `${ms}ms (budget ${BOOT_BUDGET_MS}ms)`)
    },
  },
]

async function runProgramme({ discipline = null } = {}) {
  const want = (d) => !discipline || (d && (Array.isArray(discipline) ? discipline.includes(d) : discipline === d))
  const results = []
  for (const c of PROGRAMME_CASES) {
    if (!want(c.discipline)) continue
    let r
    try { r = await c.check() } catch (e) { r = ok(false, `threw: ${String(e?.message ?? e).slice(0, 120)}`) }
    results.push({ id: c.id, name: c.name, lane: c.lane, discipline: c.discipline ?? null, how: c.how, why: c.why, ok: r.pass, note: r.note })
  }
  return { ran: true, results }
}

/**
 * The discipline lane. Delegates to `disciplines.js` (which owns the cases)
 * and stamps the lane on, so a discipline result is indistinguishable in
 * shape from any other lane's — `runSuite` and `formatSuite` need no special
 * case, and `GUARD_LANES` works on it unchanged.
 */
async function runDisciplineLane({ discipline = null } = {}) {
  const { runDisciplines } = await import("./disciplines.js")
  const r = await runDisciplines({ only: discipline })
  return { ran: true, results: r.results.map((x) => ({ ...x, lane: LANE.DISCIPLINE })) }
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
    // A baseline recorded on a DIFFERENT machine is not a comparison, it is a
    // coincidence. perfbench computes `sameMachine` and warns about it, but
    // this lane scored the rows anyway — so an incomparable measurement could
    // set `regressed` and make `forge bench` exit 1 for being on other
    // hardware. A degraded comparison is a reported limitation, never a
    // pass/fail result.
    if (cmp.sameMachine === false) {
      return { ran: false, skipped: "the perf baseline was recorded on a DIFFERENT machine profile — timings are not comparable; run `forge perf --save` here", results: [] }
    }
    // v148: the same rule, for the case the machine profile cannot see. A
    // baseline without host calibration cannot tell a slower host from slower
    // code — measured, v147's six "regressions" were all a faster host with
    // the same cores and RAM — so it is a reported limitation, not a verdict.
    // `forge perf --compare` still prints the raw rows, with that note.
    if (!cmp.host) {
      return { ran: false, skipped: "the perf baseline is not host-calibrated — raw timings cannot tell a slower host from slower code, so they are not scored; run `forge perf --save` to record a calibrated one", results: [] }
    }
    const scorable = cmp.rows.filter((r) => r.verdict === "faster" || r.verdict === "slower" || r.verdict === "unchanged")
    return {
      ran: scorable.length > 0,
      skipped: scorable.length ? null : "no comparable perf cases (baseline and run share no ids)",
      note: null,
      results: scorable.map((r) => ({
        id: `perf-${r.id}`,
        name: r.label ?? r.id,
        lane: LANE.SPEED,
        how: HOW.MEASURED,
        ok: r.verdict !== "slower",
        // v148: the baseline was restated in this host's units; say by how
        // much — "slower 109ms vs 86ms" was the line that reported the
        // hardware as a regression. (Inconclusive rows never reach here: they
        // are outside `scorable`, like "new" and "n/a".)
        note: r.factor != null
          ? `${r.verdict} ${r.cur}ms vs ${r.expected}ms (recorded ${r.base}ms × ${r.factor} ${r.calibrate}; ${r.pct > 0 ? "+" : ""}${r.pct}%)`
          : `${r.verdict} ${r.cur}ms vs ${r.base}ms (${r.pct > 0 ? "+" : ""}${r.pct}%)`,
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
  cwd = process.cwd(), only = null, discipline = null, provider = null, runAgent = null,
  tasks = null, timeoutMs = 180000,
} = {}) {
  const t0 = Date.now()
  const want = (l) => !only || (Array.isArray(only) ? only.includes(l) : only === l)

  // v137: `discipline` slices ACROSS lanes — the discipline lane's own cases
  // and any programme case tagged with that subject. Asking for one
  // discipline therefore means the lanes that carry no discipline tag
  // (capability, speed, autonomy) have nothing to contribute and are skipped
  // rather than reported as 0/0.
  const sliced = Boolean(discipline)

  const lanes = {}
  if (want(LANE.CAPABILITY) && !sliced) lanes[LANE.CAPABILITY] = await runCapability()
  if (want(LANE.DISCIPLINE)) lanes[LANE.DISCIPLINE] = await runDisciplineLane({ discipline })
  if (want(LANE.PROGRAMME)) {
    const p = await runProgramme({ discipline })
    // A discipline slice that matches no programme case is NOT a lane that
    // scored zero — it is a lane with nothing to say about that subject.
    // Reporting it as `0/0 null%` invited exactly the misreading the --lane
    // validation above exists to prevent.
    lanes[LANE.PROGRAMME] = p.results.length
      ? p
      : { ran: false, results: [], skipped: `no programme case is tagged ${Array.isArray(discipline) ? discipline.join(",") : discipline}` }
  }
  if (want(LANE.SPEED) && !sliced) lanes[LANE.SPEED] = await runSpeed({ cwd })
  if (want(LANE.AUTONOMY) && !sliced) lanes[LANE.AUTONOMY] = await runAutonomy({ provider, runAgent, tasks, timeoutMs })

  // ASKING FOR LANES AND RUNNING NONE MUST NEVER READ AS A CLEAN BENCHMARK.
  //
  // This is the v133.1 hole reopened one level deeper, by this release's own
  // slice logic. `--lane capability --discipline prompt` selects a lane the
  // slice then skips, so nothing ran and the summary said `0/0 score 0%,
  // regressed: false` — and `forge bench` exited 0. The --lane validation in
  // forge.js was written to close exactly this, but it validates each flag
  // ALONE; the emptiness lives in the INTERSECTION, which only runSuite sees.
  //
  // So the guard belongs here, at the boundary where the intersection is
  // known, rather than as a third flag check in the CLI.
  if (!Object.keys(lanes).length) {
    const l = Array.isArray(only) ? only.join(",") : (only ?? "all")
    const d = Array.isArray(discipline) ? discipline.join(",") : discipline
    throw new Error(`no lane ran: lane=${l} with discipline=${d} select nothing — a discipline slice covers only the ${LANE.DISCIPLINE} and ${LANE.PROGRAMME} lanes`)
  }

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
  const regressions = results.filter((r) => !r.ok && GUARD_LANES.has(r.lane))
  const notYet = results.filter((r) => !r.ok && r.lane === LANE.PROGRAMME)

  return {
    version: VERSION,
    name: "FORGE-SUITE",
    discipline: discipline ?? null,
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
  const slice = summary.discipline ? `  [discipline: ${Array.isArray(summary.discipline) ? summary.discipline.join(",") : summary.discipline}]` : ""
  lines.push(`FORGE-SUITE v${summary.version}  ${summary.passed}/${summary.total}  score ${summary.score}%  ${summary.ms}ms${slice}`)
  for (const [name, s] of Object.entries(summary.lanes)) {
    if (!s.ran) { lines.push(`  ${name.padEnd(11)} SKIPPED  ${s.skipped ?? ""}`); continue }
    lines.push(`  ${name.padEnd(11)} ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)}  ${s.score}%`)
  }
  // The SAME definition runSuite uses for `regressed` (capability + speed are
  // the guard lanes). Reading `!== PROGRAMME` instead meant an autonomy failure
  // printed under "REGRESSED — these used to pass" while summary.regressed
  // stayed false and `forge bench` exited 0: two contradictory statements about
  // one run, in one report.
  const regressions = summary.results.filter((r) => !r.ok && GUARD_LANES.has(r.lane))
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
