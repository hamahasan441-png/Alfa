#!/usr/bin/env node
/**
 * forge — the gaps a harder scripted evaluation found, one regression each.
 *
 * Measured with scripts/scripted-eval.mjs scenarios s9–s20 (both engines) and
 * a smoke run of every CLI subcommand, on the code before these fixes:
 *
 *   1. 429 pacing: two refused requests in a row read as "1 request per
 *      minute", and every request after them waited 60 s — a 0.05 s
 *      Retry-After included. s10 (three 429s, then fine) was killed by its
 *      75 s timeout on both engines.
 *   2. A weakened test: the model rewrote test/p.test.js to assert.ok(true)
 *      and never touched src/p.js; both engines reported COMPLETED (s15).
 *   3. The controller's repair turn changed src/p.js, but the change reached
 *      neither the task's changed files nor its report (s19).
 *   4. A WAITING controller task printed only the model's "Fixed it" — the
 *      reasons it was waiting were only in the events.
 *   5. "Read every file in docs/ (f1.txt … f90.txt)" ended INCOMPLETE on the
 *      single loop: f1.txt was "a file the task names that does not exist"
 *      (it is docs/f1.txt) (s18).
 *   6. `forge ask` / `forge chat -m` exited 0 when the provider failed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-hard-gaps-")))
process.env.FORGE_HOME = path.join(TMP, "forge-home")
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })

/** A provider stub: `answer(n)` → { status, headers, body } per request. */
async function stub(answer) {
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const a = answer(++n, req) ?? { status: 200 }
      res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) })
      res.end(JSON.stringify(a.body ?? { id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, count: () => n, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

try {
  console.log("== 1. a burst of refusals is not a rate ==")
  {
    const P = await import("../providers.js")
    const limited = { status: 429, headers: { "retry-after": "0.05" }, body: { error: { message: "Rate limit reached for requests" } } }
    let s = await stub((n) => (n <= 2 ? limited : null))
    P.resetPaces()
    const opts = { protocol: "openai", baseUrl: s.url, apiKey: `k-${Date.now()}`, model: "m", providerName: "stub", messages: [{ role: "user", content: "x" }] }
    for (let i = 0; i < 2; i++) { try { await P.chatOnce(opts) } catch { /* the 429 */ } }
    ok("two refused requests and nothing answered: no pace is inferred", P.paceFor(opts) === null, JSON.stringify(P.paceFor(opts)))
    const t0 = Date.now()
    const r = await P.chatOnce(opts)
    ok("the next request goes out at once (it used to wait 60 s)", Date.now() - t0 < 2000 && r != null, `${Date.now() - t0}ms`)
    s.close()
    // the V7 case still holds: answered requests, then a count-less 429
    s = await stub((n) => (n <= 3 ? null : { status: 429, body: { error: { message: "Too many requests" } } }))
    P.resetPaces()
    const o2 = { ...opts, baseUrl: s.url, apiKey: `k2-${Date.now()}` }
    for (let i = 0; i < 3; i++) await P.chatOnce(o2)
    try { await P.chatOnce(o2) } catch { }
    const pace = P.paceFor(o2)
    ok("three answered, then a 429 with no stated limit: paced to 3/min (V7 unchanged)", pace && pace.intervalMs === Math.ceil(60000 / 3) + 50, JSON.stringify(pace))
    P.resetPaces()
    s.close()
    // one answered, then two 429s that say when to come back
    s = await stub((n) => (n === 1 ? null : n <= 3 ? limited : null))
    const o3 = { ...opts, baseUrl: s.url, apiKey: `k3-${Date.now()}` }
    await P.chatOnce(o3)
    for (let i = 0; i < 2; i++) { try { await P.chatOnce(o3) } catch { } }
    ok("one answered, then 429s with Retry-After 0.05: no pace (it was 60 s)", P.paceFor(o3) === null, JSON.stringify(P.paceFor(o3)))
    P.resetPaces()
    s.close()
    s = await stub((n) => (n === 1 ? null : { status: 429, body: { error: { message: "Too many requests" } } }))
    const o4 = { ...opts, baseUrl: s.url, apiKey: `k4-${Date.now()}` }
    await P.chatOnce(o4)
    try { await P.chatOnce(o4) } catch { }
    ok("one answered request is not a rate (no pace after a count-less 429)", P.paceFor(o4) === null, JSON.stringify(P.paceFor(o4)))
    P.resetPaces()
    s.close()
    // three identical concurrent calls share ONE request: one answer, not three
    s = await stub((n) => (n === 1 ? null : { status: 429, body: { error: { message: "Too many requests" } } }))
    const o5 = { ...opts, baseUrl: s.url, apiKey: `k5-${Date.now()}` }
    await Promise.all([P.chatOnce(o5), P.chatOnce(o5), P.chatOnce(o5)])
    const shared = s.count()
    try { await P.chatOnce({ ...o5, messages: [{ role: "user", content: "y" }] }) } catch { }
    ok("a request shared by identical concurrent calls counts as one answer", shared === 1 && P.paceFor(o5) === null, `requests=${shared} pace=${JSON.stringify(P.paceFor(o5))}`)
    P.resetPaces()
    s.close()
  }

  console.log("== 2. test integrity ==")
  {
    const TI = await import("../testintegrity.js")
    ok("test files are recognised (js/ts spec, python, go, ruby, test folders and their helpers)", ["test/p.test.js", "src/a.spec.ts", "tests/test_x.py", "pkg/a_test.go", "spec/a_spec.rb", "__tests__/a.js", "test/helpers/eq.js"].every(TI.isTestPath))
    ok("…and code is not", !["src/p.js", "src/test-utils.js", "lib/testing.py", "node_modules/x/a.test.js"].some(TI.isTestPath))
    const H = `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { clamp } from "../src/p.js"\n`
    const ORIG = `${H}test("a", () => assert.equal(clamp(5, 0, 10), 5))\ntest("b", () => assert.equal(clamp(-1, 0, 10), 0))\ntest("c", () => assert.equal(clamp(11, 0, 10), 10))\n`
    const sig = TI.testSignals(ORIG)
    ok("assertions, cases and names are counted (an import is not an assertion)", sig.assertions === 3 && sig.cases === 3 && sig.names.join() === "a,b,c" && sig.trivial === 0, JSON.stringify(sig))
    ok("a commented-out assertion is not counted", TI.testSignals(`${H}test("a", () => { /* assert.equal(1, 2) */ })\n// assert.ok(x)\n`).assertions === 0)
    ok("JUnit/Kotlin assertEquals is an assertion; self.assertTrue(True) cannot fail", TI.testSignals("@Test fun x() { assertEquals(1, f()) }").assertions === 1 && TI.testSignals("def test_a(self):\n    self.assertTrue(True)\n").trivial === 1)
    const TMPD = fs.mkdtempSync(path.join(TMP, "ti-"))
    const mk = (files) => { const d = fs.mkdtempSync(path.join(TMPD, "p-")); for (const [r, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); fs.writeFileSync(path.join(d, r), c) } return d }
    const W = (d, r, c) => { fs.mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); fs.writeFileSync(path.join(d, r), c) }
const FIX = "Fix the bug in clamp() in src/p.js so that the tests in test/p.test.js pass."
    const cases = [
      ["s15 rewrite", FIX, (d) => W(d, "test/p.test.js", `${H}test("clamp", () => assert.ok(true))\n`), ["test/p.test.js"], false],
      ["fix w/o path, rewrite", "Fix the bug in clamp so that the tests pass", (d) => W(d, "test/p.test.js", `${H}test("clamp", () => assert.ok(true))\n`), ["test/p.test.js"], false],
      ["negated: do not edit the tests", "Fix clamp in src/p.js. Do not edit the tests.", (d) => W(d, "test/p.test.js", `${H}test("clamp", () => assert.ok(true))\n`), ["test/p.test.js"], false],
      ["add a test does not exempt", "Fix clamp in src/p.js and add a test for it.", (d) => W(d, "test/p.test.js", `${H}test("clamp", () => assert.ok(true))\n`), ["test/p.test.js"], false],
      ["renamed case", FIX, (d) => { W(d, "test/p.test.js", ORIG.replace('test("a"', 'test("inside")')); W(d, "src/p.js", "fixed\n") }, ["src/p.js", "test/p.test.js"], true],
      ["file renamed", "Rename test/p.test.js to test/clamp.test.js.", (d) => { W(d, "test/clamp.test.js", ORIG); fs.rmSync(path.join(d, "test/p.test.js")) }, [], true],
      ["file split", "Add a feature X to src/p.js.", (d) => { const L = ORIG.split("\n"); W(d, "test/a.test.js", H + L[3] + "\n"); W(d, "test/bc.test.js", H + L[4] + "\n" + L[5] + "\n"); fs.rmSync(path.join(d, "test/p.test.js")); W(d, "src/p.js", "x\n") }, ["src/p.js"], true],
      ["1 of 3 trivial", FIX, (d) => { W(d, "test/p.test.js", ORIG.replace("assert.equal(clamp(11, 0, 10), 10)", "assert.ok(true)")); W(d, "src/p.js", "f\n") }, ["src/p.js", "test/p.test.js"], false],
      ["commented-out case", FIX, (d) => { W(d, "test/p.test.js", ORIG.replace('test("c"', '// test("c"')); W(d, "src/p.js", "f\n") }, ["src/p.js", "test/p.test.js"], false],
      ["skip added", FIX, (d) => { W(d, "test/p.test.js", ORIG.replace('test("c"', 'test.skip("c"')); W(d, "src/p.js", "f\n") }, ["src/p.js"], false],
      ["skip asked", "Skip the flaky test c in test/p.test.js.", (d) => W(d, "test/p.test.js", ORIG.replace('test("c"', 'test.skip("c"')), ["test/p.test.js"], true],
      ["only added", FIX, (d) => { W(d, "test/p.test.js", ORIG.replace('test("a"', 'test.only("a"')); W(d, "src/p.js", "f\n") }, ["src/p.js"], false],
      ["helper refactor (note only)", FIX, (d) => { W(d, "test/p.test.js", `${H}const eq = (x, lo, hi, want) => assert.equal(clamp(x, lo, hi), want)\ntest("a", () => eq(5, 0, 10, 5))\ntest("b", () => eq(-1, 0, 10, 0))\ntest("c", () => eq(11, 0, 10, 10))\n`); W(d, "src/p.js", "f\n") }, ["src/p.js", "test/p.test.js"], true],
      ["sed expected value, src untouched", FIX, (d) => W(d, "test/p.test.js", ORIG.replace("10), 10)", "10), 11)")), [], false],
      ["src fixed by sed + test added", FIX, (d) => { W(d, "src/p.js", "fixed by sed\n"); W(d, "test/p.test.js", ORIG + 'test("d", () => assert.equal(clamp(0, 0, 10), 0))\n') }, ["test/p.test.js"], true],
      ["make test/p.test.js pass; expected edited", "Make test/p.test.js pass; the bug is in src/p.js", (d) => W(d, "test/p.test.js", ORIG.replace("10), 10)", "10), 11)")), ["test/p.test.js"], false],
      ["the test is wrong", "The test in test/p.test.js is wrong; fix it. clamp() in src/p.js is correct.", (d) => W(d, "test/p.test.js", ORIG.replace("10), 10)", "10), 11)")), ["test/p.test.js"], true],
      ["fix the failing tests, obsolete case dropped", "Fix the failing tests in test/p.test.js: they still use the removed two-argument API of src/p.js.", (d) => W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")), ["test/p.test.js"], true],
      ["remove legacy() and its tests", "Remove the deprecated legacy() function from src/p.js and its tests.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/p.js", "x\n") }, ["src/p.js", "test/p.test.js"], true],
      ["update clamp.test.js (bare)", "Update p.test.js to the new API.", (d) => W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")), ["test/p.test.js"], true],
      ["unrelated task drops a case", "Add a --verbose flag to src/cli.js.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/cli.js", "x\n") }, ["src/cli.js", "test/p.test.js"], false],
      ["deleted test file", "Add a --verbose flag to src/cli.js.", (d) => { fs.rmSync(path.join(d, "test/p.test.js")); W(d, "src/cli.js", "x\n") }, ["src/cli.js"], false],
    ]
    // found by the second review
    cases.push(
      ["r4 no longer used, remove with its tests", "legacy() in src/p.js is no longer used, so remove it along with its tests.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/p.js", "x\n") }, ["src/p.js", "test/p.test.js"], true],
      ["not used anymore: delete it and its tests", "legacy() is not used anymore: delete it and its tests.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/p.js", "x\n") }, ["src/p.js", "test/p.test.js"], true],
      ["get rid of legacy() and its tests", "Get rid of legacy() and its tests.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/p.js", "x\n") }, ["src/p.js", "test/p.test.js"], true],
      ["remove the console.log + delete failing test c", "Fix clamp() in src/p.js so the tests pass, and remove the console.log in it.", (d) => { W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")); W(d, "src/p.js", "x\n") }, ["src/p.js", "test/p.test.js"], false],
      ["comment appended to src + expected changed", FIX, (d) => { fs.appendFileSync(path.join(d, "src/p.js"), "// touched\n"); W(d, "test/p.test.js", ORIG.replace("10), 10)", "10), 11)")) }, ["src/p.js", "test/p.test.js"], false],
      ["NOTES.md + expected changed", FIX, (d) => { W(d, "NOTES.md", "notes\n"); W(d, "test/p.test.js", ORIG.replace("10), 10)", "10), 11)")) }, ["NOTES.md", "test/p.test.js"], false],
      ["fix the tests but don't delete any", "Fix the tests in test/p.test.js, but don't delete any of them.", (d) => W(d, "test/p.test.js", ORIG.split("\n").filter((l) => !l.includes('test("c"')).join("\n")), ["test/p.test.js"], false],
      ["fix the flaky test + .skip", "Fix the flaky test c in test/p.test.js.", (d) => W(d, "test/p.test.js", ORIG.replace('test("c"', 'test.skip("c"')), ["test/p.test.js"], false],
      ["test.each fold under a fix", FIX, (d) => { W(d, "test/p.test.js", `${H}test.each([[5, 5], [-1, 0], [11, 10]])("clamp %i", (x, w) => assert.equal(clamp(x, 0, 10), w))\n`); W(d, "src/p.js", "f\n") }, ["src/p.js", "test/p.test.js"], true],
      ["test.each fold, tidy its tests", "Refactor clamp() in src/p.js and tidy its tests.", (d) => { W(d, "test/p.test.js", `${H}test.each([[5, 5], [-1, 0]])("clamp %i", (x, w) => assert.equal(clamp(x, 0, 10), w))\n`); W(d, "src/p.js", "f\n") }, ["src/p.js", "test/p.test.js"], true],
    )
    // each case: the objective, what the run does to the project, the files its tools wrote, whether it may finish
    for (const [label, objective, mutate, changed, wantOk] of cases) {
      const d = mk({ "src/p.js": "export const clamp=(x)=>x\n", "test/p.test.js": ORIG })
      const base = TI.baselineTests(d, { objective })
      mutate(d)
      const v = TI.testIntegrityVerdict({ objective, baseline: base, cwd: d, changedFiles: changed })
      ok(`${wantOk ? "may finish" : "held"}: ${label}`, v.ok === wantOk, `${v.reasons.join(" | ")}${v.notes.length ? ` (notes: ${v.notes.join("; ")})` : ""}`)
    }
    {
      const L = `${H}test("legacy returns 1", () => assert.equal(1, 1 + 0))\n`
      const d = mk({ "src/p.js": "export const legacy=()=>1\n", "test/p.test.js": L + 'test("other", () => assert.equal(2, 1 + 1))\n' })
      const objective = "Remove legacy() from src/p.js."
      const base = TI.baselineTests(d, { objective })
      W(d, "test/p.test.js", `${H}test("other", () => assert.equal(2, 1 + 1))\n`); W(d, "src/p.js", "\n")
      const v = TI.testIntegrityVerdict({ objective, baseline: base, cwd: d, changedFiles: ["src/p.js", "test/p.test.js"] })
      ok("may finish: 'remove legacy()' — the test about legacy may go with it", v.ok, v.reasons.join(" | "))
    }
    {
      const { execFileSync } = await import("node:child_process")
      const d = mk({ "src/p.js": "export const clamp=(x)=>x\n", "src/util.js": "export const u = 1\n", "test/p.test.js": ORIG })
      execFileSync("git", ["init", "-q"], { cwd: d }); execFileSync("git", ["add", "-A"], { cwd: d }); execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], { cwd: d })
      const base = TI.baselineTests(d, { objective: FIX })
      W(d, "src/util.js", "export const u = 2\n"); W(d, "test/p.test.js", ORIG + 'test("d", () => assert.equal(clamp(0, 0, 10), 0))\n')
      const v = TI.testIntegrityVerdict({ objective: FIX, baseline: base, cwd: d, changedFiles: ["test/p.test.js"] })
      ok("may finish: a shell fix in a file the task does not name, plus a regression test (git sees it)", v.ok, v.reasons.join(" | "))
    }
    {
      const LONG = ORIG.replace('test("a"', 'test("returns the value when it is inside the range"').replace('test("b"', 'test("returns the lower bound when the value is below it"').replace('test("c"', 'test("returns the upper bound when the value is above it"')
      const d = mk({ "src/p.js": "x\n", "test/p.test.js": LONG })
      const base = TI.baselineTests(d, { objective: FIX })
      const compact = TI.persistableBaseline(base, JSON.stringify(base).length - 1)
      W(d, "test/p.test.js", `${H}test("clamp", () => assert.ok(true))\n`)
      const v = compact ? TI.testIntegrityVerdict({ objective: FIX, baseline: JSON.parse(JSON.stringify(compact)), cwd: d, changedFiles: ["test/p.test.js"] }) : null
      ok("a baseline kept with the task as name hashes still catches the removal", Boolean(compact?.files?.["test/p.test.js"]?.nh) && v && !v.ok && /2 test case\(s\) removed/.test(v.reasons.join()), JSON.stringify(v?.reasons))
    }
    {
      const d = mk({ "src/p.js": "x\n", "test/p.test.js": ORIG })
      const base = TI.baselineTests(d, { objective: "Fix the bug in clamp() in src/p.js." })
      W(d, "test/p.test.js", `${H}const eq = (x, lo, hi, w) => assert.equal(clamp(x, lo, hi), w)\ntest("a", () => eq(5, 0, 10, 5))\ntest("b", () => eq(-1, 0, 10, 0))\ntest("c", () => eq(11, 0, 10, 10))\n`)
      W(d, "src/p.js", "fixed\n")
      const v = TI.testIntegrityVerdict({ objective: "Fix the bug in clamp() in src/p.js.", baseline: base, cwd: d, changedFiles: ["src/p.js", "test/p.test.js"] })
      ok("fewer assertions alone is reported, not held", v.ok && /assertions 3 → 1/.test(v.notes.join()), JSON.stringify(v))
    }
    {
      const d = mk({ "test/p.test.js": ORIG })
      fs.mkdirSync(path.join(d, "assets"))
      for (let i = 0; i < 6100; i++) fs.writeFileSync(path.join(d, "assets", `a${i}.png`), "")
      ok("a folder of thousands of files does not use up the walk before test/", Object.keys(TI.baselineTests(d).files).join() === "test/p.test.js")
    }
    ok("no baseline (nothing measured): never blocks", TI.testIntegrityVerdict({ objective: FIX, baseline: null, cwd: TMPD, changedFiles: ["test/p.test.js"] }).ok)
    ok("a baseline that fits is kept as it is; one that does not fit even hashed is not kept", TI.persistableBaseline({ v: 2, files: {} })?.v === 2 && TI.persistableBaseline({ v: 2, files: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`t${i}.test.js`, { hash: "x".repeat(16), names: ["n"] }])) }) === null)

    const C = await import("../completion.js")
    const base2 = { finalText: "done", toolLog: [], commandChecks: [], writeCount: 1, mutated: true }
    let g = C.canCompleteFastPath({ ...base2, testIntegrity: ["the test file test/p.test.js was weakened (assertions 3 → 1)"] })
    ok("the single loop's final gate: a weakened test is INCOMPLETE", g.ok === false && g.status === "INCOMPLETE" && g.blockers.some((b) => b.check === C.FAST_PATH_CHECK.TESTS_INTACT), JSON.stringify(g.blockers))
    g = C.canCompleteFastPath({ ...base2, testIntegrity: [] })
    ok("…an intact verdict adds a passing check", g.checks[C.FAST_PATH_CHECK.TESTS_INTACT] === true && !g.blockers.some((b) => b.check === C.FAST_PATH_CHECK.TESTS_INTACT))
    g = C.canCompleteFastPath({ ...base2 })
    ok("…and no verdict adds no check (the default is unchanged)", !(C.FAST_PATH_CHECK.TESTS_INTACT in g.checks))
  }

  console.log("== 5. a file the task names by its bare name is found where it is ==")
  {
    const C = await import("../completion.js")
    const d = fs.mkdtempSync(path.join(TMP, "art-"))
    fs.mkdirSync(path.join(d, "docs", "deep"), { recursive: true })
    fs.writeFileSync(path.join(d, "docs", "f1.txt"), "1\n")
    fs.writeFileSync(path.join(d, "docs", "deep", "f2.txt"), "2\n")
    fs.mkdirSync(path.join(d, "node_modules", "x"), { recursive: true })
    fs.writeFileSync(path.join(d, "node_modules", "x", "f3.txt"), "3\n")
    const task = "Read every file in docs/ (f1.txt … f2.txt) and write the sum to total.txt."
    ok("the folders a task names are found", C.namedFolders(task).join() === "docs", JSON.stringify(C.namedFolders(task)))
    ok("f1.txt in docs/ is not missing", C.missingNamedArtifacts(["f1.txt"], { cwd: d, searchDirs: C.namedFolders(task) }).length === 0)
    ok("…nor f2.txt in a folder below it", C.missingNamedArtifacts(["f2.txt"], { cwd: d, searchDirs: C.namedFolders(task) }).length === 0)
    ok("a file that exists nowhere is still missing", C.missingNamedArtifacts(["nope.txt"], { cwd: d, searchDirs: ["docs"] }).join() === "nope.txt")
    ok("a copy in a folder the task does not name does not count ('create f1.txt at the root')", C.missingNamedArtifacts(["f1.txt"], { cwd: d, searchDirs: C.namedFolders("Create f1.txt at the project root.") }).join() === "f1.txt")
    ok("node_modules is not searched", C.missingNamedArtifacts(["f3.txt"], { cwd: d, searchDirs: ["."] }).join() === "f3.txt")
    ok("a path with a folder is checked where it says (docs/f2.txt is missing)", C.missingNamedArtifacts(["docs/f2.txt"], { cwd: d }).join() === "docs/f2.txt")
    ok("an injected existsFn is used as given", C.missingNamedArtifacts(["f1.txt"], { cwd: d, existsFn: () => false }).join() === "f1.txt")
  }

  console.log("== 6. a one-shot answer's exit status ==")
  {
    const run = (args, env) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], { cwd: TMP, env, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      c.stdout.on("data", (x) => { out += x }); c.stderr.on("data", (x) => { out += x })
      const t = setTimeout(() => c.kill("SIGKILL"), 60_000)
      c.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
    })
    for (const [label, answer, want] of [["answered", () => null, 0], ["the provider refuses (401)", () => ({ status: 401, body: { error: { message: "invalid api key" } } }), 1]]) {
      const s = await stub(answer)
      const home = fs.mkdtempSync(path.join(TMP, "home-"))
      const cfg = path.join(home, "config.json")
      fs.writeFileSync(cfg, JSON.stringify({ version: 1, activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: s.url, apiKey: "k", model: "m" } }, chat: { stream: false } }))
      const env = { PATH: process.env.PATH ?? "", HOME: home, FORGE_HOME: path.join(home, ".forge"), FORGE_CONFIG: cfg, NO_COLOR: "1", CI: "1" }
      for (const args of [["ask", "hello"], ["chat", "-m", "hello"]]) {
        const r = await run(args, env)
        ok(`forge ${args[0]} — ${label}: exit ${want}`, r.code === want, `exit ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200)}`)
      }
      s.close()
    }
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== hard-gaps suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
