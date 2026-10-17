/**
 * forge — structured command results + output intelligence (Ω, zero deps)
 *
 * Every command execution produces a structured record. Success is the
 * process result (exitCode / signal / timedOut), NEVER inferred from a
 * truncated stdout. The model-facing string still carries `[exit code: N]`
 * OUTSIDE the truncation window (the v20.0.1 defect).
 *
 * Long output is summarised for the UI: counts, first failure, duration,
 * truncation flag. The full text stays on `stdout`/`stderr` for diagnosis.
 */
export function createCommandResult({
  command = "",
  exitCode = null,
  signal = null,
  timedOut = false,
  killed = false,
  stdout = "",
  stderr = "",
  durationMs = 0,
  truncated = false,
  processId = null,
  processGroupId = null,
  startedAt = 0,
  finishedAt = 0,
  overflow = false,
  aborted = false,
  timeoutSec = null,
  maxBuf = null,
} = {}) {
  const code = Number.isInteger(exitCode) ? exitCode : (timedOut ? 124 : (signal ? 137 : (aborted ? 130 : null)))
  const ok = !timedOut && !aborted && !overflow && code === 0
  return {
    command: String(command ?? "").slice(0, 2000),
    exitCode: code,
    signal: signal ?? null,
    timedOut: !!timedOut,
    killed: !!killed || !!timedOut || !!overflow,
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
    durationMs: Math.max(0, Number(durationMs) || 0),
    truncated: !!truncated || !!overflow,
    processId: processId ?? null,
    processGroupId: processGroupId ?? null,
    startedAt: startedAt || 0,
    finishedAt: finishedAt || 0,
    overflow: !!overflow,
    aborted: !!aborted,
    timeoutSec: timeoutSec ?? null,
    maxBuf: maxBuf ?? null,
    ok,
  }
}

/**
 * Authoritative model-facing string. Marker (timeout / overflow / exit / kill)
 * is appended AFTER the body is capped so agent.js can always parse it.
 */
export function formatCommandResult(r, { max = 12000 } = {}) {
  const body = composeBody(r)
  const marker = markerOf(r)
  const capped = capKeepTail(body || "(no output)", max)
  return marker ? `${capped}\n${marker}` : capped
}

function composeBody(r) {
  let out = r.stdout || ""
  if (r.stderr) out += (out ? "\n--- stderr ---\n" : "") + r.stderr
  return out
}

function markerOf(r) {
  if (r.aborted) return ""
  if (r.timedOut) {
    const sec = r.timeoutSec ?? Math.round((r.durationMs || 0) / 1000) ?? "?"
    return `[command timed out after ${sec}s]\n[exit code: 124]`
  }
  if (r.overflow) {
    const n = r.maxBuf ? `${r.maxBuf} bytes` : "buffer"
    return `[output exceeded ${n} — process killed]\n[exit code: 1]`
  }
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return `[exit code: ${r.exitCode}]`
  if (r.exitCode == null && r.signal) return `[killed by ${r.signal}]\n[exit code: 137]`
  return ""
}

function capKeepTail(s, limit) {
  if (s.length <= limit) return s
  const head = Math.floor(limit * 0.7)
  const tail = Math.max(200, limit - head - 80)
  return `${s.slice(0, head)}\n... (truncated, ${s.length} chars total; tail kept)\n${s.slice(-tail)}`
}

const FAIL_LINE = /\b(FAIL|FAILED|Error|ERROR|AssertionError|✗|×|not ok|Traceback|Exception|Expected |Received )\b/
const TEST_COUNTS = /(\d+)\s+failed[^\n]*?(\d+)\s+passed|(\d+)\s+passed[^\n]*?(\d+)\s+failed|Tests:\s+[^\n]*?(\d+)\s+failed[^\n]*?(\d+)\s+passed/i

export function parseTestCounts(text = "") {
  const t = String(text)
  const m = TEST_COUNTS.exec(t)
  if (m) {
    const failed = Number(m[1] || m[4] || m[5] || 0)
    const passed = Number(m[2] || m[3] || m[6] || 0)
    return { failed, passed, total: failed + passed }
  }
  const failN = /\b(\d+)\s+(?:test|spec|assertion)s?\s+failed/i.exec(t)
  const passN = /\b(\d+)\s+(?:test|spec)s?\s+passed/i.exec(t)
  if (failN || passN) {
    const failed = failN ? Number(failN[1]) : 0
    const passed = passN ? Number(passN[1]) : 0
    return { failed, passed, total: failed + passed }
  }
  return null
}

export function extractFirstFailure(text = "") {
  const lines = String(text).split("\n")
  for (const line of lines) {
    if (FAIL_LINE.test(line) && line.trim().length > 4) return line.trim().slice(0, 240)
  }
  return ""
}

/**
 * UI summary of a command. Never invents a pass. Full text stays on `text`.
 */
export function summarizeCommand(r, { maxLines = 6 } = {}) {
  const text = typeof r === "string" ? r : composeBody(r)
  const rec = typeof r === "string" ? parseCommandResult(r) : r
  const counts = parseTestCounts(text)
  const first = extractFirstFailure(text)
  const lines = String(text).split("\n")
  const summary = []
  if (counts) summary.push(`${counts.failed} failed / ${counts.passed} passed`)
  if (first) {
    summary.push("First failure:")
    summary.push(first)
  } else {
    const head = lines.filter((l) => l.trim()).slice(0, 2)
    summary.push(...head.map((l) => l.replace(/\s+/g, " ").slice(0, 120)))
  }
  if (rec.timedOut) summary.push(`timed out after ${Math.round((rec.durationMs || 0) / 1000)}s`)
  else if (rec.exitCode != null && rec.exitCode !== 0) summary.push(`Process exited with code ${rec.exitCode}`)
  if (rec.durationMs) summary.push(`Duration: ${(rec.durationMs / 1000).toFixed(1)}s`)
  if (rec.truncated) summary.push("[full output available]")
  return {
    ok: rec.ok === true,
    exit: rec.exitCode,
    lines: lines.length,
    summary: summary.filter(Boolean).slice(0, maxLines),
    hidden: rec.truncated ? Math.max(0, lines.length - maxLines) : 0,
    counts,
    firstFailure: first,
    durationMs: rec.durationMs,
    timedOut: rec.timedOut,
    truncated: rec.truncated,
    text,
  }
}

/**
 * The exit status forge appended to a command's output, or null when there is
 * none. The marker runBash appends comes AFTER the command's own output
 * (formatCommandResult), so it is the LAST `[exit code: N]` in the string —
 * only "[forge] …" notes follow it. Reading the FIRST one let a failing check
 * whose own output printed "[exit code: 0]" (a sub-run's log line) be recorded
 * as passing.
 */
export function exitMarkerCode(text = "", { ownLine = false } = {}) {
  const re = ownLine ? /\[exit code: (-?\d+)\]\s*$/gm : /\[exit code: (-?\d+)\]/g
  let code = null
  for (const m of String(text ?? "").matchAll(re)) code = Number(m[1])
  return code
}

// ---------------------------------------------------------------------------
// The STRUCTURED execution result (audit 2026-10, group C1).
//
// A bash call's outcome used to reach verification as TEXT: runBash appended
// `[exit code: N]` to the output and every consumer parsed it back. A passing
// command whose own output ended with "[exit code: 1]" was recorded failing;
// a failing one whose last line was a credential prompt ("Password: ") had
// the marker eaten by secret redaction and was recorded PASSING; signals,
// timeouts and spawn errors were inferred from words. The record below is
// built where the process actually ends (tools.js runBash) and travels beside
// the model-facing text, which is unchanged. Text parsing remains only for
// results that carry no record (old journals, MCP, other tools).
// ---------------------------------------------------------------------------

export const EXEC_SCHEMA = "forge.exec/1"
const EXEC_TAIL = 2000
const SUMMARY_WINDOW_LINES = 60

// Linux numbering (macOS agrees on every signal a test run realistically dies of)
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGXCPU: 24, SIGXFSZ: 25 }

/** True for a structured execution result built by createExecResult. */
export function isExecResult(x) {
  return Boolean(x) && typeof x === "object" && x.schema === EXEC_SCHEMA
}

/**
 * What a test runner's OWN summary says, read from the end of the output
 * (where every runner prints it): `failed` = the failure count it reports
 * (0 when it reports none or none is found), `noTests` = it says nothing ran.
 * Only summary SHAPES count — a test NAME containing "FAIL", "error" or
 * "timed out" is not a summary. Zero counts ("# fail 0", "0 failed") are not
 * failures.
 */
export function runnerSummary(text = "") {
  const lines = String(text ?? "").split("\n")
  const t = lines.slice(-SUMMARY_WINDOW_LINES).join("\n")
  let failed = 0
  const take = (n) => { const v = Number(n); if (Number.isFinite(v) && v > failed) failed = v }
  const each = (re, f) => { for (const m of t.matchAll(re)) f(m) }
  // TAP / node --test: "# fail 2"
  each(/^#\s*fail(?:ed)?\s+(\d+)\s*$/gim, (m) => take(m[1]))
  // mocha "  2 failing", a bare "3 failed" line
  each(/^\s*(\d+)\s+(?:failing|failed)\b/gim, (m) => take(m[1]))
  // jest "Tests:  1 failed, 2 passed" · vitest " Tests  1 failed | 2 passed" · "Test Suites: 1 failed"
  each(/^\s*Test(?:s|\s+Suites|\s+Files):?\s+[^\n]*?\b(\d+)\s+failed\b/gim, (m) => take(m[1]))
  // pytest "==== 1 failed, 2 passed in 0.1s ====" (also "1 error")
  each(/^=+[^\n]*?\b(\d+)\s+(?:failed|errors?)\b[^\n]*=+\s*$/gim, (m) => take(m[1]))
  // cargo "test result: FAILED. 3 passed; 1 failed;"
  each(/test result:\s*FAILED\.[^\n]*?\b(\d+)\s+failed/gi, (m) => take(Math.max(1, Number(m[1]))))
  // python unittest "FAILED (failures=1, errors=2)"
  each(/^FAILED\s*\(([^)\n]*)\)/gim, (m) => { for (const n of m[1].matchAll(/(?:failures|errors)=(\d+)/g)) take(n[1]) })
  // maven / junit "Tests run: 4, Failures: 1, Errors: 0"
  each(/Tests run:\s*\d+,\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/gi, (m) => take(Number(m[1]) + Number(m[2])))
  // rspec "3 examples, 1 failure"
  each(/\b\d+\s+examples?,\s*(\d+)\s+failures?\b/gi, (m) => take(m[1]))
  // go "--- FAIL: TestX" / "FAIL\tpkg 0.01s"; jest "FAIL src/a.test.js"
  if (/^(?:--- FAIL:|FAIL\t|FAIL\s+\S+\.(?:test|spec)\.\w+)/m.test(t)) take(1)
  const noTests = /no tests? (found|ran|executed|matched)|no test files|\b0 tests? (found|ran|executed)|No test suite/i.test(t)
  return { failed, noTests }
}

/**
 * Build the structured result of ONE command run. `stdout`/`stderr` are the
 * full captured streams (the summary is read from them before any display
 * truncation); only their tails are kept on the record.
 *
 * attempted — forge tried to run it (policy let it through, a spawn was made)
 * executed  — the process actually started (false: spawn error, sandbox start failure)
 * succeeded — the PROCESS succeeded: exit 0, no signal, no timeout, no
 *             cancellation, no output overflow, and a status that is the
 *             command's own (statusKnown)
 */
export function createExecResult({
  command = "",
  attempted = true,
  executed = true,
  exitCode = null,
  signal = null,
  timedOut = false,
  spawnError = null,
  cancelled = false,
  overflow = false,
  statusKnown = true,
  durationMs = 0,
  stdout = "",
  stderr = "",
  truncated = false,
  isolation = null,
} = {}) {
  const out = String(stdout ?? ""), err = String(stderr ?? "")
  const code = Number.isInteger(exitCode) ? exitCode : null
  const ran = attempted !== false && executed !== false
  const summary = ran ? runnerSummary(out && err ? `${out}\n${err}` : out || err) : { failed: 0, noTests: false }
  const succeeded = ran && code === 0 && !signal && !timedOut && !cancelled && !overflow && !spawnError && statusKnown !== false
  return {
    schema: EXEC_SCHEMA,
    command: String(command ?? "").slice(0, 300),
    attempted: attempted !== false,
    executed: ran,
    succeeded,
    exitCode: code,
    signal: signal || null,
    timedOut: !!timedOut,
    spawnError: spawnError ? String(spawnError).slice(0, 200) : null,
    cancelled: !!cancelled,
    overflow: !!overflow,
    statusKnown: statusKnown !== false,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    stdoutTail: out.slice(-EXEC_TAIL),
    stderrTail: err.slice(-EXEC_TAIL),
    truncated: !!truncated || !!overflow,
    reportedFailures: summary.failed,
    noTests: summary.noTests,
    isolation: isolation ?? null,
  }
}

/**
 * THE verdict on a check, from its structured result — the one function the
 * single loop (agent.js commandChecks) and the controller's ledger
 * (verifyledger.evaluateVerification) both call, so they cannot disagree.
 *
 * Process metadata decides: exit 0 is success even when the output contains
 * "FAIL" or "timed out" in a test name — unless the runner's OWN summary
 * reports failures (> 0) or that no test ran. `exitCode` is the legacy number
 * consumers compare (124 timeout, 128+n signal, 127 spawn error, 1 overflow);
 * null only when nothing was ever observed.
 */
export function checkVerdict(x) {
  const e = x ?? {}
  const sig = e.signal || null
  const exitCode = e.timedOut ? 124
    : e.overflow ? 1
    : e.cancelled ? 130
    : e.spawnError || e.executed === false ? (Number.isInteger(e.exitCode) ? e.exitCode : 127)
    : Number.isInteger(e.exitCode) ? e.exitCode
    : sig ? 128 + (SIGNUM[sig] ?? 9)
    : null
  const statusUnknown = e.statusKnown === false
  const runnerFailed = Number(e.reportedFailures) > 0
  const passed = e.succeeded === true && !runnerFailed && e.noTests !== true
  const failureShape = passed ? null
    : e.timedOut ? "timeout"
    : sig === "SIGKILL" || e.overflow ? "killed"
    : sig ? "signal"
    : e.spawnError || e.executed === false ? "not_started"
    : e.cancelled ? "cancelled"
    : statusUnknown ? "status_unknown"
    : runnerFailed ? "test_failure"
    : e.noTests ? "no_tests"
    : exitCode === 127 ? "not_found"
    : "exit_status"
  return {
    passed,
    exitCode,
    exitCodeKnown: exitCode != null && !statusUnknown,
    timedOut: !!e.timedOut,
    statusUnknown,
    signal: sig,
    killed: sig === "SIGKILL" || !!e.overflow,
    executed: e.executed !== false,
    failureShape,
  }
}

/** Parse the model-facing string back into a structured result. */
export function parseCommandResult(text = "") {
  const s = String(text ?? "")
  const timedOut = /\[command timed out after/.test(s)
  const overflow = /\[output exceeded /.test(s)
  const killed = /\[killed by /.exec(s)
  const abort = /^ERROR: cancelled/.test(s)
  const marked = exitMarkerCode(s, { ownLine: true })
  const exitCode = marked != null ? marked : (timedOut ? 124 : (abort ? 130 : (overflow ? 1 : 0)))
  return createCommandResult({
    exitCode,
    timedOut,
    overflow,
    aborted: abort,
    killed: timedOut || overflow || !!killed,
    signal: killed ? killed[1] : null,
    stdout: s,
    truncated: /\(truncated/.test(s) || overflow,
    ok: !timedOut && !overflow && !abort && exitCode === 0,
  })
}
