/**
 * diagnose.rootCause — deterministic root-cause extraction from raw failure
 * output across test runners, compilers and stack traces, and its wiring into
 * the controller's DEFECT REPORT. Zero network.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { controllerSource } from "./controller-source.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const { rootCause, formatRootCause, FAILURE } = await import("../diagnose.js")

let n = 0
const t = (name, fn) => { try { fn(); n++; console.log(`  ok   ${name}`) } catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 } }

t("empty / whitespace output → found:false, never a guess", () => {
  for (const s of ["", "   ", "\n\n"]) { const rc = rootCause(s); assert.equal(rc.found, false); assert.equal(formatRootCause(rc), "") }
})
t("clean output with no failure signature → found:false", () => {
  const rc = rootCause("all good\nup and running\n42")
  assert.equal(rc.found, false)
})

t("vitest: failing test name, assertion, and source file:line", () => {
  const rc = rootCause("FAIL  src/sum.test.js > sums\nAssertionError: expected 5 to be 6\n at src/sum.js:12:7\n 1 failed, 3 passed")
  assert.ok(rc.found)
  assert.match(rc.cause, /expected 5 to be 6/)
  assert.equal(rc.location, "src/sum.js:12:7")
  assert.equal(rc.frames[0].line, 12)
})
t("node:test: ✗ test name and ERR_ASSERTION, with user frame (not node internals)", () => {
  const rc = rootCause("✗ adds two numbers\n  AssertionError [ERR_ASSERTION]: 5 == 6\n      at Test.<anonymous> (/app/test/math.test.js:8:10)\n tests 4\n fail 1")
  assert.equal(rc.test, "adds two numbers")
  assert.match(rc.cause, /ERR_ASSERTION/)
  assert.equal(rc.location, "/app/test/math.test.js:8:10")
})
t("pytest: FAILED path::test and the assertion detail", () => {
  const rc = rootCause("FAILED tests/test_api.py::test_login - assert 401 == 200\nE   assert 401 == 200\n  tests/test_api.py:42: AssertionError")
  assert.match(rc.test, /test_api\.py::test_login/)
  assert.equal(rc.location, "tests/test_api.py:42")
})
t("tsc: the TS error code, message and location", () => {
  const rc = rootCause("src/index.ts:30:15 - error TS2345: Argument of type string is not assignable to parameter of type number.")
  assert.match(rc.cause, /error TS2345/)
  assert.equal(rc.location, "src/index.ts:30:15")
})
t("go panic and rust panic are captured as the cause", () => {
  assert.match(rootCause("panic: runtime error: index out of range [5]\n  main.go:19").cause, /panic: runtime error/)
  assert.match(rootCause("thread 'main' panicked at 'oops', src/lib.rs:4:9").cause, /panicked at/)
})
t("node internals and runner frames are skipped in favour of user code", () => {
  const rc = rootCause([
    "TypeError: cannot read properties of undefined (reading 'x')",
    "    at node:internal/process/task_queues:95:5",
    "    at /app/node_modules/vitest/dist/index.js:1:1",
    "    at parse (/app/src/parser.js:88:21)",
  ].join("\n"))
  assert.equal(rc.location, "/app/src/parser.js:88:21", "the first non-internal, non-runner frame wins")
  assert.match(rc.cause, /TypeError: cannot read properties/)
})
t("syntax failure: the SyntaxError line is the cause even without a location", () => {
  const rc = rootCause("SyntaxError: Unexpected token '}'\n", { code: FAILURE.SYNTAX_FAILURE })
  assert.match(rc.cause, /SyntaxError: Unexpected token/)
})
t("a bare count summary is a fallback cause when nothing sharper matches", () => {
  const rc = rootCause("running suite\n2 failed, 10 passed")
  assert.ok(rc.found)
  assert.match(formatRootCause(rc), /2 failed, 10 passed/)
})
t("formatRootCause orders test → cause → location", () => {
  const rc = rootCause("FAIL  a.test.js > does x\nexpected true to be false\n at a.js:3:1")
  assert.equal(formatRootCause(rc), "failing: a.test.js > does x — expected true to be false — at a.js:3:1")
})
t("it reads only what the output states — no fabricated file or line", () => {
  const rc = rootCause("AssertionError: expected 1 to equal 2")
  assert.equal(rc.location, null)
  assert.equal(rc.frames.length, 0)
  assert.match(rc.cause, /expected 1 to equal 2/)
})

// ---- wiring: the controller's DEFECT REPORT mines stdoutTail via rootCause --
t("meta.js builds the DEFECT REPORT root-cause line from a record's stdoutTail", () => {
  const src = controllerSource()
  assert.match(src, /rootCause, formatRootCause/)
  assert.match(src, /rootCause\(f\.stdoutTail \?\? f\.evidence \?\? ""/)
  assert.match(src, /root cause: \$\{one\}/)
})

console.log(`\n== rootcause suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
