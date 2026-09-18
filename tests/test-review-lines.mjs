#!/usr/bin/env node
/**
 * forge — reviewer line numbers are CLAIMS, not evidence (v124).
 *
 * The code-review pass merges two kinds of finding: deterministic ones, which
 * carry observed evidence, and the ones a reviewer AGENT reports as strict
 * JSON. The agent's `file:line` comes from its reading of a diff, and a wrong
 * coordinate is worse than no coordinate — it points the reader at an
 * unrelated line while reading exactly like a fact.
 *
 * v124 checks every claimed line against the lines the diff actually ADDED,
 * parsed from the hunk headers it already has. The FINDING is never dropped —
 * a real bug reported at the wrong line is still a real bug — only the
 * coordinate is demoted, and the claim is preserved as `claimedLine`.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-revlines-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { addedLineNumbers, verifyFindingLines, mergeFindings } = await import("../codereview.js")

const DIFF = [
  "--- a/x.js", "+++ b/x.js",
  "@@ -1,4 +1,6 @@",
  " const a = 1",       // new 1  context
  "+const b = 2",       // new 2  ADDED
  "+const c = 3",       // new 3  ADDED
  " const d = 4",       // new 4  context
  "-const old = 5",     // old side only — consumes no new line
  " const e = 6",       // new 5  context
  "@@ -20,3 +22,4 @@",
  " keep()",            // new 22 context
  "+added()",           // new 23 ADDED
  " tail()",            // new 24 context
  "\\ No newline at end of file",
].join("\n")

console.log("== hunk headers are read exactly ==")
{
  eq("only the added new-side lines are reported", [...addedLineNumbers(DIFF)].sort((a, b) => a - b), [2, 3, 23])
  ok("a deletion consumes no new-side line", !addedLineNumbers(DIFF).has(5))
  ok("context lines are not 'added'", !addedLineNumbers(DIFF).has(1) && !addedLineNumbers(DIFF).has(22))
  ok("the second hunk is offset by its own header", addedLineNumbers(DIFF).has(23))
  // hostile / empty input never throws
  for (const bad of ["", null, undefined, "not a diff", "@@ malformed @@\n+x", "@@ -1 +1 @@\n+one"]) {
    let threw = false
    try { addedLineNumbers(bad) } catch { threw = true }
    ok(`does not throw on ${JSON.stringify(String(bad).slice(0, 18))}`, threw === false)
  }
  eq("a single-line hunk header (no counts) still parses", [...addedLineNumbers("@@ -1 +7 @@\n+x")], [7])
}

console.log("== a claimed line that the diff really added is kept ==")
{
  const facts = { files: [{ file: "x.js", diff: DIFF }] }
  const [f] = verifyFindingLines([{ severity: "blocker", file: "x.js", line: 2, issue: "real" }], facts)
  eq("line survives", f.line, 2)
  eq("and is marked verified", f.lineVerified, true)
  ok("no claimedLine is recorded when it checks out", f.claimedLine === undefined)
}

console.log("== a claimed line the diff never touched is demoted, not trusted ==")
{
  const facts = { files: [{ file: "x.js", diff: DIFF }] }
  const [f] = verifyFindingLines([{ severity: "blocker", file: "x.js", line: 99, issue: "hallucinated coordinate" }], facts)
  eq("the coordinate is removed", f.line, null)
  eq("the claim is preserved for the record", f.claimedLine, 99)
  eq("and it is marked unverified", f.lineVerified, false)
  ok("the FINDING itself survives — a real bug at a wrong line is still a bug",
    f.severity === "blocker" && /hallucinated/.test(f.issue))
  // a context line is not an added line: reviewing unchanged code is not evidence
  const [ctx] = verifyFindingLines([{ file: "x.js", line: 4, issue: "context line" }], facts)
  eq("a context line does not verify", ctx.lineVerified, false)
}

console.log("== nothing to check against is stated honestly, never guessed ==")
{
  const facts = { files: [{ file: "x.js", diff: DIFF }] }
  const [noLine] = verifyFindingLines([{ file: "x.js", line: null, issue: "file-level" }], facts)
  eq("a file-level finding is lineVerified:null", noLine.lineVerified, null)
  const [otherFile] = verifyFindingLines([{ file: "other.js", line: 7, issue: "file not in the diff set" }], facts)
  eq("an unknown file keeps its line", otherFile.line, 7)
  eq("…but is NOT claimed as verified", otherFile.lineVerified, null)
  const [noDiff] = verifyFindingLines([{ file: "y.js", line: 3, issue: "diff unavailable" }], { files: [{ file: "y.js", diff: null }] })
  eq("a file whose diff was not captured keeps its line", noDiff.line, 3)
  eq("…and is lineVerified:null, not false", noDiff.lineVerified, null)
}

console.log("== it is total: bad shapes in, sane findings out ==")
{
  for (const bad of [null, undefined, "nope", 42, {}]) {
    let threw = false
    try { verifyFindingLines(bad, { files: [] }) } catch { threw = true }
    ok(`verifyFindingLines(${JSON.stringify(bad)}) does not throw`, threw === false)
  }
  let threw = false
  try { verifyFindingLines([{ file: "x.js", line: 2 }], null) } catch { threw = true }
  ok("null facts does not throw", threw === false)
  eq("…and refuses to claim verification without facts",
    verifyFindingLines([{ file: "x.js", line: 2 }], null)[0].lineVerified, null)
}

console.log("== it composes with the merge step the live path uses ==")
{
  const facts = { files: [{ file: "x.js", diff: DIFF }] }
  const det = [{ severity: "major", id: "debugger_left", file: "x.js", detail: "a debugger statement was added" }]
  const llm = [
    { severity: "blocker", id: "bad_check", file: "x.js", line: 3, issue: "inverted expiry comparison", fix_hint: "flip it" },
    { severity: "major", id: "ghost", file: "x.js", line: 4242, issue: "claims a line that does not exist", fix_hint: "n/a" },
  ]
  const out = verifyFindingLines(mergeFindings(det, llm), facts)
  const real = out.find((f) => f.id === "bad_check")
  const ghost = out.find((f) => f.id === "ghost")
  ok("the merged reviewer finding keeps its verified line", real?.line === 3 && real.lineVerified === true, JSON.stringify(real))
  ok("the merged hallucinated line is demoted", ghost?.line === null && ghost.claimedLine === 4242 && ghost.lineVerified === false, JSON.stringify(ghost))
  ok("every merged finding carries a verdict", out.every((f) => "lineVerified" in f))
  ok("no finding was lost in the process", out.length === 3, String(out.length))
}

console.log("== the live review pass applies it (wiring is real) ==")
{
  const src = fs.readFileSync(new URL("../codereview.js", import.meta.url), "utf8")
  ok("runCodeReview verifies before returning", /verifyFindingLines\(mergeFindings\(det, llm\), facts\)/.test(src))
  ok("addedLineNumbers is exported for the audit", /export function addedLineNumbers/.test(src))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== review-lines suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
