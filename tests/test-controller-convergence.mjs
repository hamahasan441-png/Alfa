#!/usr/bin/env node
/**
 * The controller converges: it finishes what can be finished, says what
 * cannot be checked, and stops when it is not making progress.
 *
 * Measured before these fixes, with a scripted model (same task on both
 * engines):
 *   - "create hello.txt containing hi": single loop 2 model calls, COMPLETED_
 *     UNVERIFIED; the controller 134 calls and 32 segments, ending WAITING,
 *     with the file written in segment 1. It demanded a syntax check and a
 *     focused test for a .txt file in a project with no tests.
 *   - a JS change where nobody ever runs the tests: 134 calls, 32 segments.
 *   - a JS change where the verifier DOES run `node --test`: never completed —
 *     `node --test` was not recognised as a test, the verifier was not allowed
 *     to run it, and its passing TAP tail ("# fail 0") was read as a failure.
 *
 * Real controller (meta.js via runtask.js) against a scripted OpenAI-compatible
 * mock over HTTP, in temporary projects.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-converge-"))
process.env.FORGE_HOME = path.join(TMP, "home")
process.env.NO_COLOR = "1"
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })

const V = await import("../verifyledger.js")
const { verificationAllows } = await import("../tools.js")
const { runTask } = await import("../runtask.js")
const { runAgent } = await import("../agent.js")
const { createForgeCore } = await import("../core.js")

const toolCall = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
const say = (t) => ({ role: "assistant", content: t })

async function mockModel(script) {
  const log = []
  const server = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(b) } catch { }
      log.push(body)
      const message = script(log.length, body)
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const delta = { role: "assistant", content: message.content ?? "" }
        if (message.tool_calls) delta.tool_calls = message.tool_calls.map((t, i) => ({ index: i, ...t }))
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
        res.end("data: [DONE]\n\n"); return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { log, provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "k", model: "mock-1" }, close: () => { server.closeAllConnections?.(); server.close() } }
}

async function controller({ task, script, setup = null }) {
  const m = await mockModel(script)
  const dir = fs.mkdtempSync(path.join(TMP, "proj-"))
  if (setup) setup(dir)
  const prev = process.cwd()
  process.chdir(dir)
  const events = []
  let out = null, thrown = null
  try {
    out = await runTask({ task, mode: "meta", provider: m.provider, runAgent, createForgeCore, env: {},
      config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } },
      onEvent: (e) => events.push(e), agentOpts: { journal: false } })
  } catch (e) { thrown = e } finally { process.chdir(prev); m.close() }
  const res = out?.res ?? {}
  return { dir, calls: m.log.length, events, res, status: res.taskStatus, text: String(res.text ?? ""), thrown, segments: events.filter((e) => e.type === "SEGMENT_STARTED").length }
}
const writesOnce = (file, content, answer) => (n, body) => {
  if (!body.tools?.length) return say(`1. ${answer}`)
  if ((body.messages || []).some((m) => m.role === "tool")) return say(answer)
  return toolCall(`c${n}`, "write_file", { path: file, content })
}
const withNodeTests = (dir) => {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test" } }))
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "util.test.js"), "import test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../util.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n")
}

try {
  console.log("== what evidence can exist (verifyledger.inapplicableEvidence) ==")
  ok("verifyledger exports inapplicableEvidence", typeof V.inapplicableEvidence === "function")
  if (typeof V.inapplicableEvidence === "function") {
    const empty = fs.mkdtempSync(path.join(TMP, "empty-"))
    const typesOf = (xs) => xs.map((x) => x.type).sort().join(",")
    ok("only a text file changed: no syntax, test or build can apply", typesOf(V.inapplicableEvidence(["syntax", "focused_test", "build"], ["hello.txt"], { cwd: empty })) === "build,focused_test,syntax")
    ok("README / LICENSE count as prose too", V.inapplicableEvidence(["syntax"], ["README", "docs/LICENSE"], { cwd: empty }).length === 1)
    ok("only a CSV changed: no syntax checker, but tests may still cover it", typesOf(V.inapplicableEvidence(["syntax", "focused_test"], ["data/rows.csv"], { cwd: empty })) === "focused_test,syntax")
    const js = V.inapplicableEvidence(["syntax", "focused_test"], ["util.js"], { cwd: empty })
    ok("a JS change keeps its syntax check; tests drop only when the project has none", typesOf(js) === "focused_test" && /no tests or test runner/.test(js[0].reason), JSON.stringify(js))
    const withTests = fs.mkdtempSync(path.join(TMP, "wt-")); withNodeTests(withTests)
    ok("a project with a test runner keeps the test requirement", V.inapplicableEvidence(["syntax", "focused_test"], ["util.js"], { cwd: withTests }).length === 0)
    const placeholder = fs.mkdtempSync(path.join(TMP, "ph-"))
    fs.writeFileSync(path.join(placeholder, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }))
    ok("npm's placeholder test script is not a test runner", typesOf(V.inapplicableEvidence(["focused_test"], ["a.js"], { cwd: placeholder })) === "focused_test")
    ok("a test that already ran in this task proves tests exist", V.inapplicableEvidence(["focused_test"], ["a.js"], { cwd: empty, ran: new Set(["focused_test"]) }).length === 0)
    ok("nothing changed: nothing is dropped", V.inapplicableEvidence(["syntax"], [], { cwd: empty }).length === 0)
    const L = V.createLedger()
    ok("the ledger judges applicability only for a caller that names the project", L.status("medium", ["hello.txt"]).missing.join(",") === "syntax,focused_test")
    const st = L.status("medium", ["hello.txt"], { cwd: empty })
    ok("…and with it: NOT_AVAILABLE, with the reason, never 'verified'", st.status === "NOT_AVAILABLE" && st.ok === true && /not verified — no automated check applies/.test(st.reason) && st.notApplicable.length === 2, JSON.stringify(st))
  }

  console.log("== test runs are recognised and read correctly ==")
  {
    ok("`node --test file` is a focused test", V.classifyCheckCommand("node --test test/util.test.js") === "focused_test")
    ok("`node --test` alone, `bun test` are test runs", V.classifyCheckCommand("node --test") === "regression_test" && V.classifyCheckCommand("bun test") === "regression_test")
    ok("`node script.js` is still not a test", V.classifyCheckCommand("node script.js") === "runtime")
    ok("a passing TAP tail collapsed to one line is not a failure", V.detectFailureShape("# pass 1 # fail 0 # cancelled 0 # skipped 0 # todo 0") === null)
    ok("…a failing one still is", V.detectFailureShape("# pass 0 # fail 2 # cancelled 0") === "test_failure")
    const r = V.evaluateVerification("node --test test/util.test.js", "# pass 1 # fail 0 # cancelled 0", { exitCode: 0 })
    ok("the verifier's passing `node --test` is recorded as PASSED", r.passed === true && r.type === "focused_test", JSON.stringify({ passed: r.passed, type: r.type, shape: r.failureShape }))
    ok("the read-only verifier may run `node --test`", verificationAllows("bash", { command: "node --test test/util.test.js" }).ok === true)
    ok("…but not `node --test; rm x`", verificationAllows("bash", { command: "node --test; rm x" }).ok === false)
    ok("bare `pytest -q` stays behind the full-control switch (v122)", verificationAllows("bash", { command: "pytest -q" }).ok === false)
  }

  console.log("== a text file: done in a few calls, honestly 'not verified' ==")
  {
    const r = await controller({ task: "create hello.txt containing hi", script: writesOnce("hello.txt", "hi\n", "Created hello.txt containing hi.") })
    ok("the file is written", fs.readFileSync(path.join(r.dir, "hello.txt"), "utf8") === "hi\n")
    ok("COMPLETED in one segment (it took 32 segments and ended WAITING)", r.status === "COMPLETED" && r.segments === 1, `status=${r.status} segments=${r.segments}`)
    ok("in at most 10 model calls (it took 134)", r.calls <= 10, `calls=${r.calls}`)
    const vs = r.events.filter((e) => e.type === "VERIFICATION_STATUS").at(-1)
    ok("verification is NOT_AVAILABLE, never PASSED", vs?.status === "NOT_AVAILABLE", JSON.stringify(vs))
    ok("the answer says it is not verified, and why", /\*\*Not verified\*\* — no automated check applies/.test(r.text) && /hello\.txt/.test(r.text), r.text)
    ok("the completion level is IMPLEMENTED, not VERIFIED", /Completion: IMPLEMENTED/.test(r.text), r.text)
  }

  console.log("== nobody runs the tests: stop early, say what to run ==")
  {
    const r = await controller({ task: "add an add(a, b) function to util.js", setup: withNodeTests,
      script: writesOnce("util.js", "export const add = (a, b) => a + b\n", "Added add() to util.js.") })
    ok("not COMPLETED: the change has no test evidence", r.status !== "COMPLETED", r.status)
    ok("WAITING after a few segments (it ran to the 32-segment fuse)", r.status === "WAITING" && r.segments <= 4, `status=${r.status} segments=${r.segments}`)
    ok("in at most 30 model calls (it took 134)", r.calls <= 30, `calls=${r.calls}`)
    ok("the answer names what is missing, the check to run and how to resume", /Stopped: no progress/.test(r.text) && /focused_test/.test(r.text) && /`npm test`/.test(r.text) && /forge tasks --resume task-/.test(r.text), r.text)
    ok("a TASK_STALLED event records it", r.events.some((e) => e.type === "TASK_STALLED" && e.attempts >= 3))
    ok("forge ran the syntax check itself (no model asked for it)", r.events.some((e) => e.type === "FORGE_CHECK_RAN" && e.kind === "syntax" && e.passed === true))
  }

  console.log("== the verifier runs `node --test`: COMPLETED ==")
  {
    const script = (n, body) => {
      if (!body.tools?.length) return say("1. add an add() function to util.js")
      const tools = (body.messages || []).filter((m) => m.role === "tool").length
      const readOnly = !body.tools.some((t) => (t.function?.name ?? t.name) === "write_file")
      if (readOnly) return tools === 0 ? toolCall(`v${n}`, "bash", { command: "node --test test/util.test.js" }) : say("node --test passed.")
      if (tools === 0) return toolCall(`c${n}`, "write_file", { path: "util.js", content: "export const add = (a, b) => a + b\n" })
      return say("Added add() to util.js.")
    }
    const r = await controller({ task: "add an add(a, b) function to util.js", setup: withNodeTests, script })
    ok("COMPLETED in one segment", r.status === "COMPLETED" && r.segments === 1, `status=${r.status} segments=${r.segments} ${r.text.slice(0, 200)}`)
    const passed = r.events.filter((e) => e.type === "VERIFICATION_PASSED")
    ok("the verifier's `node --test` is the evidence, announced as the ledger recorded it", passed.some((e) => e.vtype === "focused_test" && /node --test/.test(e.command)) && !r.events.some((e) => e.type === "VERIFICATION_FAILED"))
  }

  console.log("== forge's own syntax check catches a broken file ==")
  {
    const r = await controller({ task: "add an add(a, b) function to util.js", setup: withNodeTests,
      script: writesOnce("util.js", "export const add = (a, b) => { a + \n", "Added add() to util.js.") })
    ok("a syntax error is recorded by forge's own check", r.events.some((e) => e.type === "FORGE_CHECK_RAN" && e.kind === "syntax" && e.passed === false))
    ok("…and the task is not COMPLETED", r.status !== "COMPLETED", r.status)
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== controller-convergence suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
