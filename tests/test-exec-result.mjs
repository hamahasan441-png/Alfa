#!/usr/bin/env node
/**
 * forge — the structured command-execution result (audit 2026-10, C1) and
 * honest isolation reporting (C2).
 *
 * C1. A bash call's outcome reached verification as TEXT: runBash appended
 * "[exit code: N]" and agent.js / the ledger parsed it back. Measured on the
 * old code:
 *   - a PASSING command whose output ends with a literal "[exit code: 1]"
 *     line was recorded failing (and the run ended INCOMPLETE);
 *   - a FAILING test run whose last line was a credential prompt
 *     ("Password: ") had its marker eaten by secret redaction — recorded
 *     PASSING, and the run ended COMPLETED;
 *   - a passing test whose NAME said "FAIL" or "timed out" passed in the
 *     single loop and failed in the controller's ledger (two verdicts);
 *   - signals, timeouts and spawn errors were inferred from words.
 * Now runBash builds one record where the process ends (cmdout.createExecResult),
 * carries it beside the unchanged model-facing text, and the single loop and
 * the ledger judge it with the same function (cmdout.checkVerdict).
 *
 * C2. The isolation a run's bash commands get is reported (run_start, the
 * run's result, the journal, `forge doctor`): none, bwrap, a sandbox asked
 * for but unavailable (and why), or refused when it is REQUIRED. A command
 * that ran under bwrap and printed its own "bwrap: …" line is never run a
 * second time; FORGE_SANDBOX=required / sandbox.required fail closed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-execres-"))
process.env.FORGE_HOME = path.join(TMP, "forge-home")
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })
for (const k of ["FORGE_SANDBOX", "FORGE_BWRAP", "FORGE_SHELL"]) delete process.env[k]

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}

const tools = await import("../tools.js")
const C = await import("../cmdout.js")
const SB = await import("../sandbox.js")
const VL = await import("../verifyledger.js")
const A = await import("../agent.js")
const P = await import("../providers.js")
const meta = await import("../meta.js")

const verdict = (e) => (typeof C.checkVerdict === "function" && e ? C.checkVerdict(e) : {})
const resetSandbox = () => { try { SB.resetSandboxStartFailure?.() } catch { } try { SB.resetKernelProbe?.() } catch { } }

let projN = 0
const newProj = () => { const d = path.join(TMP, `proj-${++projN}`); fs.mkdirSync(d, { recursive: true }); return d }

/** One bash call through the real tool layer; `exec` is the structured result. */
async function bash(command, { cwd = newProj(), timeoutSec = 20, max, sandbox } = {}) {
  const tc = tools.makeToolContext({ cwd, root: cwd, timeoutSec, ...(max ? { maxToolOutput: max } : {}), ...(sandbox ? { sandbox } : {}) })
  let exec = null
  const text = await tc.exec("bash", { command }, { onExec: (e) => { exec = e } })
  return { text: String(text), exec, cwd }
}

/** A ledger record exactly as the controller writes one (meta.js segment loop). */
function ledgerRecord(chk) {
  const ledger = VL.createLedger()
  return ledger.recordCommand(chk.command, chk.tail + (chk.passed ? "" : ` [exit code: ${chk.exitCode}]`), {
    exitCode: chk.exitCode, affectedFiles: ["t.js"], taskId: "t", nodeId: "n1",
    ...(chk.exec ? { exec: chk.exec } : {}),
  })
}

// ── a scripted OpenAI-protocol model: write a file, run `npm test`, answer ──
async function singleLoop(testJs, { command = "npm test" } = {}) {
  const work = newProj()
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), testJs)
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const x = 1\n" }) }
        : n === 2 ? { name: "bash", arguments: JSON.stringify({ command }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Done — I ran the tests." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const events = []
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "add feature.js and run the tests", onEvent: (e) => events.push(e) }) } catch (e) { r = { error: String(e?.stack ?? e) } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  return { r, events, work }
}

/** The controller (meta.runMeta) recording the single loop's checks into its ledger. */
async function controllerRecords(work, checks) {
  const prev = process.cwd()
  process.chdir(work)
  const fake = async (args) => {
    if (args.planOnly) return { text: "1. run the tests", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done", budgetHit: false, steps: 2, toolRecords: [{ tool: "edit_file", files_changed: ["feature.js"] }], commandChecks: checks, toolLog: [{ name: "edit_file" }, { name: "bash" }] }
  }
  let r = null
  try {
    r = await meta.runMeta({ config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {}, skills: { enabled: false } }, provider: { name: "x", model: "m" }, task: "add feature.js and run the tests", runAgent: fake, workers: false, maxSegments: 2, signal: new AbortController().signal })
  } catch (e) { r = { error: String(e?.stack ?? e) } }
  process.chdir(prev)
  return (r?.task?.tests_run ?? []).filter((t) => t.command === checks[0]?.command)
}

try {
  console.log("== C1: an output's own \"[exit code: …]\" line is not the exit status ==")
  {
    const r = await bash(`echo ok; echo "[exit code: 1]"; exit 0`)
    ok("model-facing text is unchanged (the output, verbatim)", r.text === "ok\n[exit code: 1]\n", JSON.stringify(r.text))
    ok("structured: exit 0, executed, succeeded", r.exec?.exitCode === 0 && r.exec?.executed === true && r.exec?.succeeded === true, JSON.stringify(r.exec))
    ok("verdict: passed", verdict(r.exec).passed === true)
    const f = await bash(`echo "[exit code: 0]"; echo "1 failing"; exit 3`)
    ok("a failing run that prints \"[exit code: 0]\" still fails (exit 3)", f.exec?.exitCode === 3 && verdict(f.exec).passed === false && verdict(f.exec).exitCode === 3)
  }

  console.log("== C1: redaction / truncation cannot erase the status ==")
  {
    const r = await bash(`echo "1 failing"; printf 'Password: '; exit 1`)
    ok("structured: exit 1 although the text's marker went to redaction", r.exec?.exitCode === 1 && verdict(r.exec).passed === false, JSON.stringify({ text: r.text, exec: r.exec }))
    const s = await bash(`echo "api_key=sk-abcdefghijklmnopqrstuvwxyz0123"; exit 0`)
    ok("the record's output tails pass secret redaction too", typeof s.exec?.stdoutTail === "string" && !s.exec.stdoutTail.includes("abcdefghijklmnopqrstuvwxyz0123"))
    const big = await bash(`i=0; while [ $i -lt 400 ]; do echo "line $i of noise"; i=$((i+1)); done; exit 3`, { max: 400 })
    ok("display truncated, status kept: exit 3, truncated flag", /truncated/.test(big.text) && big.exec?.exitCode === 3 && big.exec?.truncated === true && verdict(big.exec).passed === false)
    const bigPass = await bash(`i=0; while [ $i -lt 400 ]; do echo "ok $i - case $i"; i=$((i+1)); done; echo "# pass 400"; echo "# fail 0"; exit 0`, { max: 400 })
    ok("a truncated GREEN run passes: a display cut is not a verdict", bigPass.exec?.truncated === true && verdict(bigPass.exec).passed === true)
    const rec = VL.evaluateVerification("npm test", bigPass.text, { exec: bigPass.exec })
    ok("…in the ledger as well", rec.passed === true && rec.exitCode === 0)
  }

  console.log("== C1: signals, timeouts and spawn errors are facts, not words ==")
  {
    const s = await bash(`exec sh -c 'kill -TERM $$'`)
    ok("model text unchanged ([exit code: 137])", /\[exit code: 137\]/.test(s.text), JSON.stringify(s.text))
    ok("structured: killed by SIGTERM — no exit code of its own", s.exec?.signal === "SIGTERM" && s.exec?.exitCode === null && s.exec?.executed === true && s.exec?.succeeded === false, JSON.stringify(s.exec))
    const v = verdict(s.exec)
    ok("verdict: 143 (128+SIGTERM), a signal, not passed", v.exitCode === 143 && v.failureShape === "signal" && v.passed === false, JSON.stringify(v))
    const k = await bash(`exec sh -c 'kill -KILL $$'`)
    ok("SIGKILL: 137, killed", k.exec?.signal === "SIGKILL" && verdict(k.exec).exitCode === 137 && verdict(k.exec).killed === true)

    const t = await bash(`sleep 6`, { timeoutSec: 1 })
    ok("timeout: model text unchanged", /\[command timed out after 1s\]\n\[exit code: 124\]/.test(t.text), JSON.stringify(t.text))
    ok("structured: timedOut, not succeeded", t.exec?.timedOut === true && t.exec?.succeeded === false, JSON.stringify(t.exec))
    ok("verdict: 124, timeout", verdict(t.exec).exitCode === 124 && verdict(t.exec).timedOut === true && verdict(t.exec).failureShape === "timeout")
    const named = await bash(`echo "  ✓ aborts when the upstream timed out after 50ms"; echo "  3 passing (60ms)"; exit 0`)
    ok("a PASSING test named \"…timed out after…\" is no timeout", named.exec?.timedOut === false && verdict(named.exec).passed === true)

    process.env.FORGE_SHELL = path.join(TMP, "no-such-shell")
    const se = await bash(`npm test`)
    delete process.env.FORGE_SHELL
    ok("spawn error: model text unchanged", /^ERROR: spawn .*ENOENT\n\[exit code: 127\]$/.test(se.text), JSON.stringify(se.text))
    ok("structured: attempted, NOT executed, the spawn error recorded", se.exec?.attempted === true && se.exec?.executed === false && se.exec?.succeeded === false && /ENOENT/.test(se.exec?.spawnError ?? ""), JSON.stringify(se.exec))
    ok("verdict: not passed, 127, not started", verdict(se.exec).passed === false && verdict(se.exec).exitCode === 127 && verdict(se.exec).failureShape === "not_started")
    const out = await bash(`echo "ERROR: deprecated flag (ignored)"; echo "5 passed"; exit 0`)
    ok("a green run whose output starts with \"ERROR\" ran (attempted+executed, passed)", out.exec?.attempted === true && out.exec?.executed === true && verdict(out.exec).passed === true)
  }

  console.log("== C1: the runner's own summary, not a test name ==")
  {
    const named = await bash(`echo "ok 1 - handles FAIL state"; echo "ok 2 - returns an error for bad input"; echo "# tests 2"; echo "# pass 2"; echo "# fail 0"; exit 0`)
    ok("exit 0 + \"FAIL\" in a test name: passed", verdict(named.exec).passed === true && named.exec?.reportedFailures === 0)
    const lying = await bash(`echo "# tests 3"; echo "# pass 2"; echo "# fail 1"; exit 0`)
    ok("exit 0 but the runner's summary reports 1 failure: NOT passed", lying.exec?.reportedFailures === 1 && verdict(lying.exec).passed === false && verdict(lying.exec).failureShape === "test_failure")
    for (const [label, txt] of [["mocha", "  2 passing\\n  1 failing"], ["jest", "Tests:       1 failed, 3 passed, 4 total"], ["pytest", "==== 1 failed, 2 passed in 0.12s ===="], ["cargo", "test result: FAILED. 3 passed; 1 failed; 0 ignored"]]) {
      const r = await bash(`printf '${txt}\\n'; exit 0`)
      ok(`${label} summary with failures at exit 0: NOT passed`, verdict(r.exec).passed === false, JSON.stringify(r.exec?.stdoutTail))
    }
    const zero = await bash(`echo "Tests:       0 failed, 4 passed, 4 total"; echo "test result: ok. 4 passed; 0 failed"; exit 0`)
    ok("zero-count summaries are not failures", verdict(zero.exec).passed === true)
  }

  console.log("== C1 end to end: the single loop and the controller give ONE verdict ==")
  {
    // (a) a passing suite whose test NAMES say FAIL / error / timed out
    const greenJs = "console.log('ok 1 - handles FAIL state'); console.log('ok 2 - retries a request that timed out'); console.log('ok 3 - returns an error for bad input'); console.log('# tests 3'); console.log('# pass 3'); console.log('# fail 0')\n"
    const g = await singleLoop(greenJs)
    const gc = g.r?.commandChecks?.[0]
    ok("single loop: the check is recorded PASSED", gc?.passed === true && gc?.exitCode === 0, JSON.stringify(gc ?? g.r?.error))
    ok("single loop: the check carries its structured result", gc?.exec?.executed === true && gc?.exec?.succeeded === true)
    ok("single loop: COMPLETED with the check covering the write", g.r?.status === "COMPLETED", `status=${g.r?.status}`)
    ok("the ledger, fed the same check the controller's way, PASSES it too", gc ? ledgerRecord(gc).passed === true : false)
    const gt = gc ? await controllerRecords(g.work, g.r.commandChecks) : []
    ok("the controller (meta.runMeta) records the same verdict: PASSED", gt.length > 0 && gt.every((t) => t.passed === true), JSON.stringify(gt))

    // (b) a passing run whose output ends with a logged "[exit code: 1]"
    const m = await singleLoop("console.log('# pass 3'); console.log('child run finished'); console.log('[exit code: 1]'); process.exit(0)\n")
    const mc = m.r?.commandChecks?.[0]
    ok("passing run ending in a literal \"[exit code: 1]\": recorded PASSED", mc?.passed === true && mc?.exitCode === 0, JSON.stringify(mc))
    ok("…and the run COMPLETED (was INCOMPLETE)", m.r?.status === "COMPLETED", `status=${m.r?.status}`)

    // (c) a real failing test run whose last line is a credential prompt
    const p = await singleLoop("console.log('1 failing'); process.stdout.write('Password: '); process.exit(1)\n")
    const pc = p.r?.commandChecks?.[0]
    ok("failing run whose marker redaction ate: recorded FAILED, exit 1", pc?.passed === false && pc?.exitCode === 1, JSON.stringify(pc))
    ok("…and the run is NOT COMPLETED (was COMPLETED)", p.r?.status !== "COMPLETED", `status=${p.r?.status}`)
    const pt = pc ? await controllerRecords(p.work, p.r.commandChecks) : []
    ok("the controller records it FAILED too", pt.length > 0 && pt.every((t) => t.passed === false), JSON.stringify(pt))

    // (d) a plain failing suite still fails everywhere
    const f = await singleLoop("console.log('# pass 1'); console.log('# fail 1'); process.exit(1)\n")
    const fc = f.r?.commandChecks?.[0]
    ok("a real failing test run is still FAILED in the single loop", fc?.passed === false && fc?.exitCode === 1)
    ok("…and in the ledger", fc ? ledgerRecord(fc).passed === false : false)
    ok("…and the run does not complete", f.r?.status !== "COMPLETED", `status=${f.r?.status}`)

    // a check with no structured result (an old journal, a fake) is judged from its text, as before
    const legacy = ledgerRecord({ command: "npm test", exitCode: 0, passed: true, tail: "0 tests passed but then: FAIL" })
    ok("no structure → the text fallback is unchanged (a FAIL shape still fails)", legacy.passed === false)

    // C2: the single loop names its isolation
    const start = g.events.find((e) => e.type === "run_start")
    ok("run_start names the isolation: none (no sandbox asked for)", start?.isolation?.mode === "none", JSON.stringify(start?.isolation))
    ok("the run's result records it, with what the commands ran under", g.r?.isolation?.mode === "none" && (g.r?.isolation?.used ?? []).includes("none"), JSON.stringify(g.r?.isolation))
    let journal = null
    try { journal = JSON.parse(fs.readFileSync(path.join(process.env.FORGE_HOME, "runs", `${g.r.runId}.json`), "utf8")) } catch { }
    ok("…and so does the run's journal", journal ? journal.isolation?.mode === "none" : true, JSON.stringify(journal?.isolation))
  }

  console.log("== C2: the isolation in effect is reported, never overstated ==")
  {
    const none = SB.isolationStatus?.({ env: {} })
    ok("nothing asked → mode none", none?.mode === "none", JSON.stringify(none))
    ok("…said plainly: direct shell, no OS isolation", /directly in .*\(no OS isolation/.test(none?.label ?? ""))

    process.env.FORGE_SANDBOX = "1"
    process.env.FORGE_BWRAP = path.join(TMP, "missing-bwrap")
    resetSandbox()
    const missing = SB.isolationStatus?.()
    ok("FORGE_SANDBOX=1 without a bwrap → fell back, and why", missing?.mode === "fallback" && /does not exist/.test(missing?.fallback ?? ""), JSON.stringify(missing))
    const fb = await bash("echo hi")
    ok("the command still runs directly (text unchanged)", fb.text === "hi\n")
    ok("…and its record says it fell back", fb.exec?.isolation?.kind === "none" && /does not exist/.test(fb.exec?.isolation?.fallback ?? ""), JSON.stringify(fb.exec?.isolation))
    delete process.env.FORGE_SANDBOX
    const cfgOn = SB.isolationStatus?.({ config: { sandbox: { enabled: true } } })
    ok("config sandbox.enabled (forge yolo on --sandbox) is a request too", cfgOn?.requested === "on" && cfgOn?.mode === "fallback", JSON.stringify(cfgOn))

    // a bwrap that dies at startup, with FORGE_SANDBOX=1 (setuid bit: skips the kernel probe)
    const broken = path.join(TMP, "broken-bwrap")
    fs.writeFileSync(broken, "#!/bin/sh\necho \"bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied\" >&2\nexit 1\n")
    fs.chmodSync(broken, 0o4755)
    process.env.FORGE_SANDBOX = "1"
    process.env.FORGE_BWRAP = broken
    resetSandbox()
    const before = SB.isolationStatus?.()
    ok("a bwrap that has not failed yet is reported as bwrap", before?.mode === "bwrap", JSON.stringify(before))
    const br = await bash("echo ran >> side.txt; echo alive")
    ok("fallback as before: the real output + the one-time announcement", br.text.includes("alive") && br.text.includes("sandbox skipped") && br.text.includes("WITHOUT the sandbox"), JSON.stringify(br.text))
    ok("the command ran once (directly)", fs.readFileSync(path.join(br.cwd, "side.txt"), "utf8") === "ran\n")
    ok("structured: ran directly, the fallback recorded", br.exec?.isolation?.kind === "none" && /overflowuid/.test(br.exec?.isolation?.fallback ?? ""), JSON.stringify(br.exec?.isolation))
    const after = SB.isolationStatus?.()
    ok("the session's isolation now says it fell back (not just printed once)", after?.mode === "fallback" && /failed to start/.test(after?.fallback ?? ""), JSON.stringify(after))
    const later = await bash("echo later")
    ok("later commands: no second announcement, still recorded as a fallback", later.text === "later\n" && /failed to start/.test(later.exec?.isolation?.fallback ?? ""))

    // fail CLOSED: FORGE_SANDBOX=required with the same broken bwrap
    process.env.FORGE_SANDBOX = "required"
    resetSandbox()
    const rq = await bash("echo ran >> side.txt; echo alive")
    ok("required + broken bwrap: the command did NOT run", !fs.existsSync(path.join(rq.cwd, "side.txt")), JSON.stringify(rq.text))
    ok("…recorded as not executed", rq.exec?.executed === false && rq.exec?.succeeded === false && verdict(rq.exec).passed === false, JSON.stringify(rq.exec))
    ok("…and said: not run without the sandbox", /sandbox required|sandbox is required/.test(rq.text) && !rq.text.includes("WITHOUT the sandbox (FORGE_SANDBOX=0"), JSON.stringify(rq.text))
    const rq2 = await bash("echo ran >> side.txt")
    ok("…nor any later command", !fs.existsSync(path.join(rq2.cwd, "side.txt")))
    process.env.FORGE_BWRAP = path.join(TMP, "missing-bwrap")
    resetSandbox()
    const refused = SB.isolationStatus?.()
    ok("required + no bwrap → mode refused", refused?.mode === "refused" && refused?.failClosed === true, JSON.stringify(refused))
    const rq3 = await bash("echo ran >> side.txt")
    ok("required + no bwrap: refused before running (attempted=false)", rq3.text.startsWith("BLOCKED: the sandbox is required") && rq3.exec?.attempted === false && !fs.existsSync(path.join(rq3.cwd, "side.txt")), JSON.stringify(rq3))
    delete process.env.FORGE_SANDBOX
    const rq4 = await bash("echo ran >> side.txt", { sandbox: { required: true } })
    ok("config sandbox.required fails closed the same way", rq4.text.startsWith("BLOCKED: the sandbox is required") && !fs.existsSync(path.join(rq4.cwd, "side.txt")), JSON.stringify(rq4.text))
    process.env.FORGE_SANDBOX = "0"
    const off = await bash("echo ran >> side.txt", { sandbox: { required: true } })
    ok("FORGE_SANDBOX=0 still wins over the config (env first)", fs.existsSync(path.join(off.cwd, "side.txt")))

    // a WORKING bwrap: a command that printed its own "bwrap:" line and failed ran ONCE
    const working = path.join(TMP, "working-bwrap")
    fs.writeFileSync(working, "#!/bin/sh\n# stand-in for a working bwrap: honour --chdir, then exec the rest\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in\n    --chdir) cd \"$2\"; shift 2; exec \"$@\";;\n    --unshare-pid|--die-with-parent) shift;;\n    --dev|--proc|--tmpfs) shift 2;;\n    *) shift 3;;\n  esac\ndone\nexit 99\n")
    fs.chmodSync(working, 0o4755)
    process.env.FORGE_SANDBOX = "1"
    process.env.FORGE_BWRAP = working
    resetSandbox()
    const w = await bash(`echo x >> runs.log; echo "bwrap: setting up uid map: Permission denied (nested build)" >&2; exit 1`)
    const runs = fs.existsSync(path.join(w.cwd, "runs.log")) ? fs.readFileSync(path.join(w.cwd, "runs.log"), "utf8").split("\n").filter(Boolean).length : 0
    ok("a sandboxed command that printed \"bwrap: …\" and failed ran ONCE (was re-run unsandboxed)", runs === 1, `runs=${runs} text=${JSON.stringify(w.text)}`)
    ok("…its record: executed inside bwrap, exit 1, no fallback", w.exec?.isolation?.kind === "bwrap" && w.exec?.exitCode === 1 && w.exec?.executed === true && !w.exec?.isolation?.fallback, JSON.stringify(w.exec))
    ok("…and the session still reports bwrap", SB.isolationStatus?.()?.mode === "bwrap")
    const w2 = await bash("echo second")
    ok("the next command is still sandboxed", w2.text === "second\n" && w2.exec?.isolation?.kind === "bwrap")
    delete process.env.FORGE_SANDBOX
    delete process.env.FORGE_BWRAP
    resetSandbox()
  }

  console.log("== C2: forge doctor prints the isolation in effect ==")
  {
    const doctor = (env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "doctor"], { cwd: TMP, env: { ...process.env, ...env, FORGE_HOME: path.join(TMP, "doctor-home") }, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      const done = () => { try { child.kill("SIGKILL") } catch { } resolve(out) }
      const timer = setTimeout(done, 30000)
      child.stdout.on("data", (d) => { out += d; if (/isolation:.*\n/.test(out)) { clearTimeout(timer); done() } })
      child.on("close", () => { clearTimeout(timer); resolve(out) })
    })
    const d1 = await doctor({})
    ok("no sandbox asked: \"isolation: none\"", /isolation: none — bash tool commands run directly/.test(d1), d1.slice(-600))
    const d2 = await doctor({ FORGE_SANDBOX: "1", FORGE_BWRAP: path.join(TMP, "missing-bwrap") })
    ok("asked but unavailable: \"fell back\" with the reason", /isolation: none \(fell back\).*FORGE_SANDBOX=1.*does not exist/.test(d2), d2.slice(-600))
    const d3 = await doctor({ FORGE_SANDBOX: "required", FORGE_BWRAP: path.join(TMP, "missing-bwrap") })
    ok("required but unavailable: \"refused\"", /isolation: refused — the sandbox is REQUIRED/.test(d3), d3.slice(-600))
  }

  console.log("== C2: no user-facing text claims more than the code gives ==")
  {
    const render = fs.readFileSync(path.join(ROOT, "render.js"), "utf8")
    ok("the run summary no longer calls checkpointed changes \"preserved safely\"", !/preserved safely/.test(render) && !/safe undo available/.test(render))
    const help = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
    ok("help: checkpoints do not contain shell commands", /checkpoints restore forge's own file edits/.test(help))
    const { yoloState } = await import("../yolo.js")
    ok("yolo report: FORGE_SANDBOX=0 is not reported as a sandbox even with sandbox.enabled saved", yoloState({ sandbox: { enabled: true } }, { FORGE_SANDBOX: "0" }).sandbox === false)
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== exec-result suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
