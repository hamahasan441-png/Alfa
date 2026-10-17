#!/usr/bin/env node
/**
 * The controller's outcomes and its accounting are honest.
 *
 * Measured with the scripted two-engine eval (scripts/scripted-eval.mjs)
 * before these fixes:
 *   - a provider outage (HTTP 503 for every call) before any work: the single
 *     loop ended ERROR, exit 1, error = the 503. The controller ended WAITING,
 *     exit 0, result.error empty — the 503 only in the text "planning
 *     failed: …". A cancel during planning also ended WAITING.
 *   - "add multiply() to src/math.js, use it in src/index.js, run
 *     `node --test`": the work done and the suite green, the controller asked
 *     for a focused test that the green whole-suite run could never satisfy
 *     (and its stall stop advised `npm test`, which produces the same record)
 *     — WAITING after 22 model calls; the single loop completed.
 *   - the controller's result reported 44–89% of the input tokens and tool
 *     calls the provider served: only the main segments were counted, never
 *     the planner, plan critique, reviewer, verifier, repair, workers or
 *     synthesis; the agent result file (`forge agent --result-json`) carried
 *     the LAST sub-run's usage event alone.
 *
 * Real controller (meta.js via runtask.js — and the real CLI for the result
 * file) against a scripted OpenAI-compatible mock over HTTP that counts every
 * call, token and tool call it serves, in temporary projects.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const FORGE = path.join(ROOT, "forge.js")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-outcomes-"))
process.env.FORGE_HOME = path.join(TMP, "home")
process.env.NO_COLOR = "1"
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })

const V = await import("../verifyledger.js")
const RT = await import("../runtask.js")
const { runTask } = RT
const exitCodeOf = typeof RT.exitCodeOf === "function" ? RT.exitCodeOf : () => "exitCodeOf missing"
const { runAgent } = await import("../agent.js")
const { createForgeCore } = await import("../core.js")
const { readTask } = await import("../taskstate.js")

// ── the scripted model ────────────────────────────────────────────────────
let SEQ = 0
const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: `c${++SEQ}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
const say = (t) => ({ role: "assistant", content: t })
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => typeof p === "string" ? p : p?.text ?? "").join("") : ""
const firstUser = (body) => textOf((body.messages ?? []).find((m) => m.role === "user")?.content)
const convo = (body) => (body.messages ?? []).filter((m) => m.role !== "system").map((m) => textOf(m.content)).join("\n")
/** the tool calls of this conversation, with their results */
function history(body) {
  const msgs = body.messages ?? []
  const results = new Map(msgs.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, textOf(m.content)]))
  const out = []
  for (const m of msgs) for (const tc of (m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
    let args = {}
    try { args = JSON.parse(tc.function?.arguments ?? "{}") } catch { }
    out.push({ name: tc.function?.name ?? "", args, result: results.has(tc.id) ? results.get(tc.id) : null })
  }
  return out
}
const ranTests = (body) => history(body).filter((x) => x.name === "bash" && /node --test/.test(String(x.args?.command ?? "")) && x.result != null)
const lastIsRed = (body) => { const r = ranTests(body).at(-1)?.result ?? ""; return /# fail [1-9]|\[exit code: [1-9]/.test(r) }

const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name)
/** Which role forge gave the model in this request (by what it was asked). */
function roleOf(body) {
  const first = firstUser(body)
  if (!toolNames(body).length) return "plan"
  if (/CODE REVIEWER/.test(first)) return "review"
  if (/Write the final answer to the person who asked/.test(first)) return "synthesis"
  if (/read-only investigation subtask/.test(convo(body))) return "worker"
  if (/before success is claimed the following evidence is required/.test(first)) return "verifier"
  if (/^A previous step FAILED and needs repair/.test(first)) return "repair"
  return "work"
}
/** a tool call when this step offers the tool; otherwise look at the file (a step may offer only inspection) */
const use = (body, name, args, fallback = "src/math.js") => toolNames(body).includes(name) ? toolCall(name, args) : toolCall("read_file", { path: fallback })

/** An OpenAI-compatible mock that counts what it serves — the provider's side of the wire. */
async function mockModel(script) {
  const log = []
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "stub" }] })); return }
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", async () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { }
      const entry = { n: log.length + 1, role: roleOf(body), http: 200, promptTokens: 0, completionTokens: 0, toolCalls: 0 }
      log.push(entry)
      if (process.env.OUTCOMES_DEBUG) console.log(`       [mock #${entry.n} ${entry.role}] tools=${(body.tools ?? []).map((t) => t.function?.name).join(",").slice(0, 120)} first=${JSON.stringify(firstUser(body).slice(0, 140))} last=${JSON.stringify(textOf((body.messages ?? []).at(-1)?.content).slice(0, 140))}`)
      let r
      try { r = await script(body, entry) } catch (e) { r = { httpStatus: 500, msg: String(e?.message ?? e) } }
      if (r === "HANG") { entry.hung = true; return }
      if (r?.httpStatus) {
        entry.http = r.httpStatus
        res.writeHead(r.httpStatus, { "content-type": "application/json", ...(r.headers ?? {}) })
        res.end(JSON.stringify({ error: { message: r.msg } }))
        return
      }
      // usage that differs per call, so a double count or a missed call shows
      entry.toolCalls = r.tool_calls?.length ?? 0
      entry.promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4) + 3
      entry.completionTokens = Math.ceil(JSON.stringify({ c: r.content ?? "", t: r.tool_calls ?? [] }).length / 4) + 1
      const usage = { prompt_tokens: entry.promptTokens, completion_tokens: entry.completionTokens, total_tokens: entry.promptTokens + entry.completionTokens }
      const finish = r.tool_calls ? "tool_calls" : "stop"
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const delta = { role: "assistant", content: r.content ?? "" }
        if (r.tool_calls) delta.tool_calls = r.tool_calls.map((t, i) => ({ index: i, ...t }))
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`)
        res.end("data: [DONE]\n\n")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ index: 0, message: r, finish_reason: finish }], usage }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const sum = (k) => log.reduce((s, e) => s + (e[k] ?? 0), 0)
  return {
    log, baseUrl, port: server.address().port,
    provider: { name: "mock", protocol: "openai", baseUrl, apiKey: "k", model: "stub" },
    served: () => ({ promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), toolCalls: sum("toolCalls"), calls: log.length }),
    byRole: () => log.reduce((m, e) => { m[e.role] = (m[e.role] ?? 0) + 1; return m }, {}),
    close: () => { try { server.closeAllConnections?.() } catch { } server.close() },
  }
}

const CONFIG = { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } }

async function run({ mode = "meta", task, script, setup = null, config = CONFIG, signal = null, onMock = null }) {
  const m = await mockModel(script)
  onMock?.(m)
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`))
  if (setup) setup(dir)
  const prev = process.cwd()
  process.chdir(dir)
  const events = []
  let out = null, thrown = null
  try {
    out = await runTask({ task, mode, provider: m.provider, runAgent, createForgeCore, env: {}, config, signal,
      onEvent: (e) => { events.push(e); if (process.env.OUTCOMES_DEBUG && /VERIFICATION_STATUS|COMPLETION_GATE|SEGMENT_STARTED|DAG_NODE|VERIFICATION_PASSED|VERIFICATION_FAILED|TASK_STALLED|REPAIR_STARTED/.test(String(e?.type))) console.log(`       [ev] ${JSON.stringify(e).slice(0, 360)}`) }, agentOpts: { journal: false } })
  } catch (e) { thrown = e } finally { process.chdir(prev); m.close() }
  const res = out?.res ?? thrown?.result ?? null
  return { m, dir, out, thrown, res, meta: out?.meta ?? thrown?.meta ?? null, events, status: res?.taskStatus ?? res?.status ?? null }
}

const harnessTests = (dir) => spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH ?? "", HOME: dir, NO_COLOR: "1" } }).status === 0
const write = (dir, rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content) }
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), "utf8") } catch { return null } }

// ── projects ──────────────────────────────────────────────────────────────
const PKG = JSON.stringify({ name: "p", version: "1.0.0", type: "module", scripts: { test: "node --test" } }) + "\n"
const MATH_ADD = "export function add(a, b) {\n  return a + b\n}\n"
const INDEX_SUM = "import { add } from \"./math.js\"\n\nexport function sum(xs) {\n  return xs.reduce((s, x) => add(s, x), 0)\n}\n"
const MATH_MUL = `${MATH_ADD}\nexport function multiply(a, b) {\n  return a * b\n}\n`
const INDEX_PRODUCT = "import { add, multiply } from \"./math.js\"\n\nexport function sum(xs) {\n  return xs.reduce((s, x) => add(s, x), 0)\n}\n\nexport function product(xs) {\n  return xs.reduce((p, x) => multiply(p, x), 1)\n}\n"
const MATH_TEST = "import test from \"node:test\"\nimport assert from \"node:assert/strict\"\nimport * as math from \"../src/math.js\"\nimport * as index from \"../src/index.js\"\n\ntest(\"add\", () => assert.equal(math.add(2, 3), 5))\ntest(\"sum\", () => assert.equal(index.sum([1, 2, 3]), 6))\ntest(\"multiply\", () => assert.equal(math.multiply?.(3, 4) ?? 12, 12))\ntest(\"product\", () => assert.equal(index.product?.([2, 3, 4]) ?? 24, 24))\n"
const mathProject = (dir) => { write(dir, "package.json", PKG); write(dir, "src/math.js", MATH_ADD); write(dir, "src/index.js", INDEX_SUM); write(dir, "test/math.test.js", MATH_TEST) }
const S2_TASK = "Add a multiply(a, b) function to src/math.js and use it in src/index.js to implement and export product(xs), the product of an array of numbers. Run the tests with `node --test`."
const S2_PLAN = "1. Add multiply(a, b) to src/math.js (implementation)\n2. Implement and export product(xs) in src/index.js using multiply (implementation)\n3. Run node --test to verify (verification)"
const outage = (status = 503, msg = "Service Unavailable: the model is overloaded") => () => ({ httpStatus: status, msg, headers: { "retry-after": "0.05" } })

try {
  // ═══════════════════════════════════════════════════════════════════════
  console.log("== B1: the provider fails before any work — FAILED, error set, exit 1 (as the single loop) ==")
  {
    const meta = await run({ task: "create hello.txt containing hi", script: outage(503) })
    ok("the controller returns its outcome (it does not throw)", !meta.thrown, meta.thrown?.message)
    eq("status FAILED (it was WAITING)", meta.status, "FAILED")
    ok("result.error carries the provider's 503 (it was empty)", /503/.test(String(meta.res?.error ?? "")) && /overloaded/.test(String(meta.res?.error ?? "")), JSON.stringify(meta.res?.error))
    eq("exit code 1 (it was 0)", exitCodeOf(meta.res), 1)
    ok("the text says the task failed and why", /task failed/i.test(String(meta.res?.text ?? "")) && /503/.test(String(meta.res?.text ?? "")), meta.res?.text)
    ok("bounded: only the planner's own transport retries reached the provider", meta.m.log.length <= 4 && meta.m.log.every((e) => e.role === "plan"), JSON.stringify(meta.m.byRole()))
    ok("no progress claimed: no segment, nothing written, no completion", meta.res?.segments === 0 && meta.res?.wrote === false && !meta.events.some((e) => e.type === "SEGMENT_STARTED" || e.type === "TASK_COMPLETED"), JSON.stringify({ seg: meta.res?.segments, wrote: meta.res?.wrote }))
    const rec = meta.res?.taskId ? readTask(meta.res.taskId) : null
    ok("the task record says FAILED, with no plan and no segment", rec?.status === "FAILED" && !(rec?.plan?.steps?.length || (Array.isArray(rec?.plan) && rec.plan.length)) && (rec?.segment_count ?? 0) === 0, JSON.stringify({ status: rec?.status, plan: rec?.plan, seg: rec?.segment_count }))
    ok("…and it is not offered for resume as if paused", rec?.status !== "WAITING")

    const single = await run({ mode: "single", task: "create hello.txt containing hi", script: outage(503) })
    ok("the single loop throws the same provider error", /503/.test(String(single.thrown?.message ?? "")), single.thrown?.message)
    eq("both engines: the same error text", String(meta.res?.error ?? ""), String(single.thrown?.message ?? ""))
  }
  {
    const meta = await run({ task: "create hello.txt containing hi", script: outage(401, "invalid api key") })
    eq("not retryable (401): FAILED", meta.status, "FAILED")
    eq("…after ONE call — retrying cannot help", meta.m.log.length, 1)
    ok("…with its error, exit 1", /401|invalid api key/i.test(String(meta.res?.error ?? "")) && exitCodeOf(meta.res) === 1, JSON.stringify(meta.res?.error))
  }
  {
    // a cancel while the planner is waiting on the provider is a cancel
    const ctrl = new AbortController()
    const meta = await run({ task: "create hello.txt containing hi", signal: ctrl.signal, script: (body, e) => { if (e.role === "plan") { setTimeout(() => ctrl.abort(), 50); return "HANG" } return say("ok") } })
    eq("a cancel during planning throws AbortError (exit 130), as in a segment", meta.thrown?.name, "AbortError")
    eq("…carrying the CANCELLED result (it was WAITING)", meta.thrown?.result?.taskStatus, "CANCELLED")
  }
  {
    // the web chat shows a returned failure the way it shows a thrown one
    const { createWebChat } = await import("../webchat.js")
    const m = await mockModel(outage(503))
    const proj = fs.mkdtempSync(path.join(TMP, "webchat-"))
    const prev = process.cwd()
    process.chdir(proj)
    let reply = null, thrown = null
    try {
      const chat = createWebChat({
        config: { providers: {} }, cwd: proj, getProvider: () => m.provider, stream: async function* () { }, systemPrompt: async () => "test",
        runAgentTurn: ({ task, onEvent, signal }) => runTask({ task, mode: "meta", provider: m.provider, runAgent, createForgeCore, signal, env: {}, config: CONFIG, onEvent }),
      })
      reply = await chat.send({ id: "outcomes-503", text: "create hello.txt containing hi", mode: "agent" }, {})
    } catch (e) { thrown = e } finally { process.chdir(prev); m.close() }
    ok("web chat: the turn resolves", !thrown, thrown?.message)
    ok("web chat: a FAILED controller turn shows its error (it showed none)", reply?.status === "FAILED" && /503/.test(String(reply?.error ?? "")), JSON.stringify({ status: reply?.status, error: reply?.error }))
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("== B2: a green full suite that runs the covering test is focused evidence (verifyledger) ==")
  {
    const proj = fs.mkdtempSync(path.join(TMP, "ledger-"))
    mathProject(proj)
    const covering = (cwd, files) => files.some((f) => /src\/(math|index)\.js$/.test(f)) ? ["test/math.test.js"] : []
    const suite = (L, out = "# pass 4\n# fail 0\n[exit code: 0]", exitCode = 0) => {
      L.recordCommand("node --check src/math.js", "ok", { exitCode: 0, affectedFiles: ["src/math.js", "src/index.js"] })
      return L.recordCommand("node --test", out, { exitCode, affectedFiles: ["src/math.js", "src/index.js"] })
    }
    const L1 = V.createLedger({ coveringTests: covering })
    suite(L1)
    const st = L1.status("medium", ["src/math.js", "src/index.js"], { cwd: proj })
    ok("a passing `node --test` that ran test/math.test.js satisfies focused_test", st.ok === true && st.satisfied.includes("focused_test") && st.status === "PASSED", JSON.stringify({ ok: st.ok, missing: st.missing, reason: st.reason }))
    ok("…and says so: which suite, which covering test", st.subsumed?.[0]?.by === "regression_test" && /full suite `node --test`/.test(st.reason) && /test\/math\.test\.js/.test(st.reason), st.reason)
    const L2 = V.createLedger({ coveringTests: covering })
    suite(L2)
    ok("no project named: a whole suite is still not focused evidence (unchanged)", L2.status("medium", ["src/math.js", "src/index.js"]).missing.includes("focused_test"))
    const L3 = V.createLedger({ coveringTests: () => [] })
    suite(L3)
    ok("no test imports the changed files: still not focused evidence", L3.status("medium", ["src/lonely.js"], { cwd: proj }).missing.includes("focused_test"))
    const L4 = V.createLedger({ coveringTests: covering })
    suite(L4, "# pass 3\n# fail 1\n[exit code: 1]", 1)
    const red = L4.status("medium", ["src/math.js", "src/index.js"], { cwd: proj })
    ok("a RED suite is a failure, never evidence", red.ok === false && red.anyFailure === true, JSON.stringify({ ok: red.ok, anyFailure: red.anyFailure }))
    const L5 = V.createLedger({ coveringTests: covering })
    suite(L5)
    L5.touch(["src/math.js"])
    ok("a suite run before the last change is stale, not evidence", L5.status("medium", ["src/math.js", "src/index.js"], { cwd: proj }).missing.includes("focused_test"))
    const L6 = V.createLedger({ coveringTests: covering })
    L6.recordCommand("node --test", "# pass 4\n# fail 0\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/math.js"], nodeId: "n1" })
    ok("another node's suite run is not this node's evidence", L6.status("medium", ["src/math.js"], { nodeId: "n2", cwd: proj }).missing.includes("focused_test"))
    // only a suite the command SHOWS to include the covering test counts
    const viaSuite = (cmd) => {
      const L = V.createLedger({ coveringTests: covering })
      L.recordCommand("node --check src/math.js", "ok", { exitCode: 0, affectedFiles: ["src/math.js", "src/index.js"] })
      L.recordCommand(cmd, "# pass 4\n# fail 0\n[exit code: 0]", { exitCode: 0, affectedFiles: ["src/math.js", "src/index.js"], type: "regression_test" })
      return L.status("medium", ["src/math.js", "src/index.js"], { cwd: proj })
    }
    for (const cmd of ["make test", "node --test --test-name-pattern=add", "node --test test/other.test.js"]) {
      ok(`a green \`${cmd}\` that may not run test/math.test.js is not focused evidence`, viaSuite(cmd).missing.includes("focused_test"), JSON.stringify(viaSuite(cmd).reason))
    }
    ok("`c8 node --test` (coverage wrapper, runner's own discovery) still counts", viaSuite("c8 node --test").satisfied.includes("focused_test"))
    ok("suiteRunsTests: npm test → the package's test script", JSON.stringify(V.suiteRunsTests("npm test", ["test/math.test.js"], proj)) === (JSON.parse(fs.readFileSync(path.join(proj, "package.json"), "utf8")).scripts?.test === "node --test" ? '["test/math.test.js"]' : "[]"))
  }

  console.log("== review: the covering test must exercise the change, and the suite must be shown to run it ==")
  {
    const VF = await import("../verify.js")
    const proj = fs.mkdtempSync(path.join(TMP, "cover-"))
    mathProject(proj)
    // a new module that imports math.js, and no test that imports IT
    write(proj, "src/lonely.js", "import { add } from './math.js'\nexport const lonely = (x) => add(x, 1) * 0\n")
    eq("a new untested module that imports math.js has NO covering test", VF.coveringTests(proj, ["src/lonely.js"]), [])
    eq("math.js is covered by the test that imports it", VF.coveringTests(proj, ["src/math.js"]), ["test/math.test.js"])
    write(proj, "test/index.test.js", "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport * as idx from '../src/index.js'\ntest('idx', () => assert.ok(idx))\n")
    ok("…and through a module that imports it (index.js imports math.js)", VF.coveringTests(proj, ["src/math.js"]).includes("test/index.test.js"), JSON.stringify(VF.coveringTests(proj, ["src/math.js"])))
    // end to end through the ledger, real commands: a green `npm test` is NOT focused evidence for the untested module
    const T = await import("../tools.js")
    const tc = T.makeToolContext({ cwd: proj, root: proj, timeoutSec: 60 })
    const run = async (cmd) => { let exec = null; const text = await tc.exec("bash", { command: cmd }, { onExec: (e) => { exec = e } }); return { text: String(text), exec } }
    const L = V.createLedger({ coveringTests: (cwd, files) => VF.coveringTests(cwd, files) })
    const syn = await run("node --check src/lonely.js"); L.recordCommand("node --check src/lonely.js", syn.text, { exec: syn.exec, affectedFiles: ["src/lonely.js"] })
    const green = await run("npm test"); L.recordCommand("npm test", green.text, { exec: green.exec, affectedFiles: ["src/lonely.js"] })
    const st = L.status("medium", ["src/lonely.js"], { cwd: proj })
    ok("a green `npm test` does not verify an untested module (it was PASSED)", st.ok === false && st.missing.includes("focused_test"), JSON.stringify({ status: st.status, missing: st.missing, reason: st.reason }))
    // commands that may not run the covering test prove nothing
    for (const cmd of ["cd docs && node --test", "cd docs && npm test", "bun test", "npm test; echo done", "node --test || true", "node --test | tail -3", "env -C docs node --test",
      "node --test --test-name-pattern=add", "jest --config jest.ci.json", "jest --listTests", "jest --testMatch=**/x.test.js", "npx jest --selectProjects=e2e",
      "vitest run --dir=src/other", "vitest run --config vitest.ci.ts", "vitest", "mocha --dry-run", "mocha --exclude=test/math.test.js", "mocha --config ci.yml",
      "pytest --collect-only", "pytest -c ci.ini", "python -m pytest --help", "npm --prefix docs test", "npm test -- --test-name-pattern=add"]) {
      eq(`suiteRunsTests(\`${cmd}\`) proves nothing`, V.suiteRunsTests(cmd, ["test/math.test.js"], proj), [])
    }
    for (const cmd of ["node --test", "npm test", "npm run test", "npm ci && npm test", "node --check src/math.js && node --test", "c8 node --test", "node --test --test-reporter=spec", "node --test --test-reporter spec"]) {
      eq(`suiteRunsTests(\`${cmd}\`) ran test/math.test.js`, V.suiteRunsTests(cmd, ["test/math.test.js"], proj), ["test/math.test.js"])
    }
    write(proj, "vite.config.cjs", "module.exports = {}\n")
    eq("a vite config the old list missed (vite.config.cjs) makes vitest unknown", V.suiteRunsTests("vitest run", ["test/math.test.js"], proj), [])
    write(proj, "pyproject.toml", "[tool.pytest.ini_options]\naddopts = \"-k fast\"\n")
    eq("any pytest config section (addopts may filter) makes pytest unknown", V.suiteRunsTests("pytest", ["tests/test_a.py"], proj), [])
  }

  console.log("== review: a delegated sub-agent's model calls are the run's usage ==")
  {
    const m = await mockModel((body) => {
      const first = firstUser(body)
      if (/SUBTASK/.test(first)) return say("sub report: math.js exports add")
      if (!(body.messages ?? []).some((x) => x.role === "tool") && toolNames(body).includes("delegate")) return toolCall("delegate", { task: "SUBTASK read src/math.js and report its exports", role: "researcher" })
      return say("math.js exports add.")
    })
    const proj = fs.mkdtempSync(path.join(TMP, "deleg-"))
    mathProject(proj)
    const prev = process.cwd()
    process.chdir(proj)
    let r = null
    try { r = await runAgent({ config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } }, provider: m.provider, task: "what does src/math.js export? ask a sub-agent", journal: false }) } finally { process.chdir(prev) }
    m.close()
    const served = m.served()
    ok("the delegate ran (the sub-agent made its own model call)", served.calls >= 3 && m.log.some((e) => e.role !== "plan"), JSON.stringify(m.byRole()))
    eq("result usage: promptTokens == served (it dropped the sub-agent's)", r?.usage?.promptTokens, served.promptTokens)
    eq("result usage: completionTokens == served", r?.usage?.completionTokens, served.completionTokens)
    ok("…and says how much was the delegate's", r?.usage?.delegated?.runs === 1 && r.usage.delegated.promptTokens > 0, JSON.stringify(r?.usage?.delegated))
  }

  console.log("== review: a worktree worker stopped at its timeout keeps the usage it made ==")
  {
    let n = 0
    const m = await mockModel((body) => { n++; return n === 1 ? toolCall("read_file", { path: "src/math.js" }) : "HANG" })
    const wt = fs.mkdtempSync(path.join(TMP, "wt-"))
    const dir = path.join(wt, "node")
    fs.mkdirSync(dir)
    mathProject(dir)
    const { runIsolatedNode } = await import("../worktree.js")
    const res = await runIsolatedNode({ dir, spec: { nodeId: "n1", role: "coder", task: "read src/math.js", provider: m.provider, config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } }, maxSteps: 4 }, timeoutMs: 4000 })
    m.close()
    ok("the timed-out worker is a failure", res?.status === "failed", JSON.stringify({ s: res?.status, e: res?.error }))
    eq("…whose usage keeps the call it completed (it reported 0)", res?.usage?.promptTokens, m.log[0]?.promptTokens)
  }

  console.log("== B2: the multi-file change (eval s2) completes on the controller ==")
  {
    const script = (body, e) => {
      if (e.role === "plan") return say(S2_PLAN)
      if (e.role === "review") return say(JSON.stringify({ findings: [] }))
      const dir = process.cwd()
      if (e.role === "verifier") return ranTests(body).length ? say("node --test passes.") : use(body, "bash", { command: "node --test" })
      if (!/multiply/.test(read(dir, "src/math.js") ?? "")) return use(body, "write_file", { path: "src/math.js", content: MATH_MUL })
      // a model the governor has moved to VERIFY (write tools hidden) checks
      // its step instead of re-reading files until the stuck detector fires —
      // what the script used to do, which cost a replan and an extra segment
      if (!/product/.test(read(dir, "src/index.js") ?? "") && !toolNames(body).includes("write_file")) {
        return ranTests(body).length ? say("Added multiply(a, b) to src/math.js; node --test passes. product(xs) is the next step.") : use(body, "bash", { command: "node --test" })
      }
      if (!/product/.test(read(dir, "src/index.js") ?? "")) return use(body, "write_file", { path: "src/index.js", content: INDEX_PRODUCT })
      const runs = ranTests(body)
      if (!runs.length) return use(body, "bash", { command: "node --test" })
      return say("Added multiply(a, b) to src/math.js and product(xs) to src/index.js. node --test: all tests pass.")
    }
    const r = await run({ task: S2_TASK, script, setup: mathProject })
    console.log(`       calls by role: ${JSON.stringify(r.m.byRole())} — status ${r.status}`)
    eq("COMPLETED (it ended WAITING)", r.status, "COMPLETED")
    ok("no stall stop on a task whose check is green", !r.events.some((e) => e.type === "TASK_STALLED"))
    const planNodes = r.events.find((e) => e.type === "DAG_BUILT")?.nodes ?? 0
    ok(`one segment per plan step, no repair spent on a green suite (${r.res?.segments} segment(s) for ${planNodes} step(s), ${r.res?.repairs} repair(s), ${r.m.log.length} calls)`, planNodes > 0 && r.res?.segments <= planNodes && r.res?.repairs === 0 && !r.events.some((e) => e.type === "REPAIR_STARTED"), JSON.stringify(r.m.byRole()))
    ok("the full suite's pass counted as the focused test, and the verdict says which test it ran", r.events.some((e) => e.type === "VERIFICATION_STATUS" && e.ok === true && /full suite `node --test`/.test(String(e.reason)) && /test\/math\.test\.js/.test(String(e.reason))), JSON.stringify(r.events.filter((e) => e.type === "VERIFICATION_STATUS").map((e) => e.reason)))
    ok("the work is really done: the harness's own `node --test` is green", harnessTests(r.dir) && /export function product/.test(read(r.dir, "src/index.js") ?? ""))
  }
  {
    // no false completion: a green suite that never runs a test of the changed file
    const script = (body, e) => {
      if (e.role === "plan") return say("1. Add lonely() to src/lonely.js (implementation)\n2. Run node --test to verify (verification)")
      if (e.role === "review") return say(JSON.stringify({ findings: [] }))
      if (e.role === "verifier" || e.role === "repair") return ranTests(body).length ? say("node --test passes.") : use(body, "bash", { command: "node --test" })
      if (read(process.cwd(), "src/lonely.js") == null) return use(body, "write_file", { path: "src/lonely.js", content: "export const lonely = () => 1\n" })
      return ranTests(body).length ? say("Added lonely(). node --test passes.") : use(body, "bash", { command: "node --test" })
    }
    const r = await run({ task: "Add a lonely() function in a new file src/lonely.js and export it from there. Run the tests with `node --test`.", script, setup: mathProject })
    ok("a green suite with NO test of the changed file is not COMPLETED", r.status !== "COMPLETED", r.status)
    const vs = r.events.filter((e) => e.type === "VERIFICATION_STATUS").at(-1)
    ok("…focused_test is what is missing", (vs?.missing ?? []).includes("focused_test"), JSON.stringify(vs))
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("== B3: usage counts every model call: planner, critique, worker, segments, reviewer, verifier, synthesis ==")
  {
    const script = (body, e) => {
      const dir = process.cwd()
      if (e.role === "plan") return say("1. Inspect src/math.js and src/index.js and report what they export (read-only investigation)\n2. Add multiply(a, b) to src/math.js and product(xs) to src/index.js (implementation)")
      if (e.role === "review") return say(JSON.stringify({ findings: [] }))
      if (e.role === "synthesis") return say("multiply and product were added; node --test passed.")
      if (e.role === "worker") return history(body).length ? say("src/math.js exports add; src/index.js exports sum.") : toolCall("read_file", { path: "src/math.js" })
      if (e.role === "verifier" || e.role === "repair") return ranTests(body).length ? say("node --test passes.") : use(body, "bash", { command: "node --test" })
      // the implementer writes and does NOT test: the verifier is asked for it
      if (!/multiply/.test(read(dir, "src/math.js") ?? "")) return use(body, "write_file", { path: "src/math.js", content: MATH_MUL })
      if (!/product/.test(read(dir, "src/index.js") ?? "")) return use(body, "write_file", { path: "src/index.js", content: INDEX_PRODUCT })
      return say("Added multiply(a, b) and product(xs).")
    }
    const r = await run({ task: S2_TASK, script, setup: mathProject, config: { ...CONFIG, agent: { ...CONFIG.agent, synthesis: "model" } } })
    const roles = r.m.byRole()
    const served = r.m.served()
    console.log(`       calls by role: ${JSON.stringify(roles)} — status ${r.status}`)
    ok("the run made planner, worker, implementer, reviewer and verifier calls", ["plan", "worker", "work", "review", "verifier"].every((k) => roles[k] > 0), JSON.stringify(roles))
    eq("result usage: input tokens == what the provider served", r.res?.usage?.promptTokens, served.promptTokens)
    eq("result usage: output tokens == what the provider served", r.res?.usage?.completionTokens, served.completionTokens)
    eq("toolCallsTotal == the tool calls the provider asked for", r.res?.toolCallsTotal, served.toolCalls)
    eq("usage.toolCalls == toolCallsTotal", r.res?.usage?.toolCalls, served.toolCalls)
    const last = r.events.filter((e) => e.type === "TASK_USAGE").at(-1)
    eq("the running TASK_USAGE total ends at the same numbers", [last?.prompt, last?.completion, last?.toolCalls], [served.promptTokens, served.completionTokens, served.toolCalls])
    if (roles.synthesis) ok("…synthesis included", true)
  }
  {
    // repair: a wrong first fix, a red test, the repair agent fixes it
    const BROKEN = "Math.min(lo, Math.max(x, hi))", WRONG = "Math.max(lo, Math.min(x, hi + 1))", RIGHT = "Math.max(lo, Math.min(x, hi))"
    const src = (expr) => `export function clamp(x, lo, hi) {\n  return ${expr}\n}\n`
    const setup = (dir) => {
      write(dir, "package.json", PKG)
      write(dir, "src/p.js", src(BROKEN))
      write(dir, "test/p.test.js", "import test from \"node:test\"\nimport assert from \"node:assert/strict\"\nimport { clamp } from \"../src/p.js\"\n\ntest(\"inside\", () => assert.equal(clamp(5, 0, 10), 5))\ntest(\"below\", () => assert.equal(clamp(-1, 0, 10), 0))\ntest(\"above\", () => assert.equal(clamp(11, 0, 10), 10))\n")
    }
    const script = (body, e) => {
      if (e.role === "plan") return say("1. Fix clamp() in src/p.js (implementation)\n2. Run node --test test/p.test.js to verify (verification)")
      if (e.role === "review") return say(JSON.stringify({ findings: [] }))
      if (e.role === "verifier") return ranTests(body).length ? say(lastIsRed(body) ? "FAILS" : "passes") : use(body, "bash", { command: "node --test test/p.test.js" }, "src/p.js")
      const s = read(process.cwd(), "src/p.js") ?? ""
      const h = history(body)
      let i = -1
      h.forEach((x, k) => { if (x.name === "edit_file" || x.name === "write_file") i = k })
      const since = h.slice(i + 1).filter((x) => x.name === "bash" && /node --test/.test(String(x.args?.command ?? "")) && x.result != null)
      if (s.includes(BROKEN)) return use(body, "edit_file", { path: "src/p.js", old: BROKEN, new: WRONG }, "src/p.js")
      // the wrong fix: anyone who sees its test red makes the right one
      if (s.includes(WRONG) && (lastIsRed(body) || (since.length && /# fail [1-9]|\[exit code: [1-9]/.test(since.at(-1).result)))) return use(body, "edit_file", { path: "src/p.js", old: WRONG, new: RIGHT }, "src/p.js")
      if (s.includes(WRONG) && e.role === "repair") return use(body, "bash", { command: "node --test test/p.test.js" }, "src/p.js")
      if (!since.length) return use(body, "bash", { command: "node --test test/p.test.js" }, "src/p.js")
      return say(/# fail [1-9]|\[exit code: [1-9]/.test(since.at(-1).result) ? "still red" : "Fixed clamp(); node --test test/p.test.js passes.")
    }
    const r = await run({ task: "Fix the bug in clamp() in src/p.js so that the tests in test/p.test.js pass.", script, setup })
    const served = r.m.served()
    const repaired = r.events.some((e) => e.type === "REPAIR_STARTED")
    console.log(`       calls by role: ${JSON.stringify(r.m.byRole())} — status ${r.status}, repair ${repaired ? "ran" : "did not run"}`)
    ok("a repair ran", repaired)
    eq("with repair: input tokens == served", r.res?.usage?.promptTokens, served.promptTokens)
    eq("with repair: tool calls == served", r.res?.toolCallsTotal, served.toolCalls)
  }
  {
    // a run that ended in planning: nothing served, nothing reported — and no crash
    const r = await run({ task: "create hello.txt containing hi", script: outage(503) })
    eq("planning outage: usage is zero, as served", [r.res?.usage?.promptTokens, r.res?.toolCallsTotal], [0, 0])
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("== the real CLI: the agent result file ==")
  const cli = (args, { cwd, port }) => {
    const home = fs.mkdtempSync(path.join(TMP, "clihome-"))
    const child = spawn(process.execPath, [FORGE, "agent", "--yolo", "--provider", "openai", "--model", "stub", "--base-url", `http://127.0.0.1:${port}/v1`, ...args],
      { cwd, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: path.join(home, ".forge"), OPENAI_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
    const exited = new Promise((r) => { const t = setTimeout(() => child.kill("SIGKILL"), 90000); child.once("exit", (code, signal) => { clearTimeout(t); r({ code, signal }) }) })
    return { exited, out: () => out }
  }
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
  {
    const work = fs.mkdtempSync(path.join(TMP, "cli-"))
    const m = await mockModel((body, e) => {
      if (e.role === "plan") return say("1. Create hello.txt containing hi (implementation)")
      if (e.role === "review") return say(JSON.stringify({ findings: [] }))
      if (e.role === "verifier") return history(body).length ? say("hello.txt contains hi.") : toolCall("read_file", { path: "hello.txt" })
      if (String(read(work, "hello.txt") ?? "").trim() !== "hi") return toolCall("write_file", { path: "hello.txt", content: "hi\n" })
      return say("Created hello.txt containing hi.")
    })
    const rj = path.join(TMP, "cli-usage.json")
    const r = await cli(["--auto", "--headless", "--result-json", rj, "--", "create hello.txt containing hi"], { cwd: work, port: m.port }).exited
    m.close()
    const j = readJson(rj)
    const served = m.served()
    console.log(`       calls by role: ${JSON.stringify(m.byRole())} — exit ${r.code}, status ${j?.status}`)
    ok("the controller run made more than one sub-run (planner + segment + reviewer)", m.log.length >= 3 && m.byRole().plan >= 1, JSON.stringify(m.byRole()))
    eq("result file: inputTokens == served (it carried the last sub-run's event)", j?.usage?.inputTokens, served.promptTokens)
    eq("result file: outputTokens == served", j?.usage?.outputTokens, served.completionTokens)
    eq("result file: toolCalls == served", j?.toolCalls, served.toolCalls)
  }
  {
    const work = fs.mkdtempSync(path.join(TMP, "cli-"))
    const m = await mockModel(outage(503))
    const rj = path.join(TMP, "cli-outage.json")
    const r = await cli(["--auto", "--headless", "--result-json", rj, "--", "create hello.txt containing hi"], { cwd: work, port: m.port }).exited
    m.close()
    const j = readJson(rj)
    eq("CLI, provider outage at planning: exit 1 (it was 0)", r.code, 1)
    eq("…result file FAILED with exitCode 1", [j?.status, j?.exitCode], ["FAILED", 1])
    ok("…and the provider's error", /503/.test(String(j?.error ?? "")), JSON.stringify(j?.error))
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== controller-outcomes suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
