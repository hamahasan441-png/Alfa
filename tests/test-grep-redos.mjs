#!/usr/bin/env node
/**
 * forge — grep_files must not be able to hang the agent (v124).
 *
 * grep_files compiles a regex the MODEL wrote and runs it over every line of
 * every file under a path. JavaScript has no regex timeout, so ONE nested
 * quantifier freezes the whole agent process: before this guard,
 * `grep_files {"pattern":"(a+)+$"}` against a single 41-character line never
 * returned — the run had to be killed. Patterns of that shape are easy to write
 * by accident (`(\s*\w+)+` is a plausible "words on a line" attempt).
 *
 * Two defences, both in the house idiom (bounded, honest, never fatal):
 *   1. a deterministic pre-screen rejects the provably catastrophic shape
 *      BEFORE compiling, naming the problem and how to rewrite it;
 *   2. a wall-clock deadline bounds the walk, so a merely SLOW pattern returns
 *      partial results that say they are partial, instead of running forever.
 *
 * The pre-screen is deliberately conservative: it flags a group whose LAST
 * token is unbounded and which is itself repeated, so anchored patterns like
 * `(a+b)+` — which cannot blow up — keep working.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-redos-home-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 200) : ""}`) }
}

const { execTool, riskyRegexReason } = await import("../tools.js")

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-redos-"))
// the exact input that used to hang: a long run of one char with no match at the end
fs.writeFileSync(path.join(ROOT, "f.txt"), `${"a".repeat(40)}X\nhello world\nfoo_bar baz\n`)
const ctx = { cwd: ROOT, root: ROOT, timeoutSec: 10, maxToolOutput: 32000, readOnly: true, _plugins: new Map() }
const grep = async (pattern) => String(await execTool(ctx, "grep_files", { pattern, path: "." }))

console.log("== the catastrophic shape is refused, and refused FAST ==")
{
  // Each of these hung the process indefinitely before the guard. The time
  // bound is the assertion that matters: a regression here does not fail the
  // suite politely, it hangs it, so the bound is what turns that into a FAIL.
  for (const p of ["(a+)+$", "(\\s*\\w+)+", "([a-z]+)*", "(x{2,})+", "(\\d+)+$"]) {
    const t0 = Date.now()
    const out = await grep(p)
    const ms = Date.now() - t0
    ok(`refuses ${p}`, /^ERROR: unsafe regex/.test(out), out.slice(0, 90))
    ok(`…in well under a second (${ms}ms)`, ms < 1000, `${ms}ms`)
  }
  ok("the error names the cause", /nested quantifier/.test(await grep("(a+)+$")))
  ok("…and tells the caller how to rewrite it", /Rewrite it without the nested repeat/.test(await grep("(a+)+$")))
}

console.log("== legitimate patterns are NOT collateral damage ==")
{
  ok("a plain word still matches", /hello world/.test(await grep("hello")))
  ok("a character class + quantifier still works", /foo_bar/.test(await grep("[a-z]+_[a-z]+")))
  ok("an unquantified group still works", /foo_bar/.test(await grep("(foo|bar)")))
  ok("a bounded repeat still works", /aaaa/.test(await grep("a{2,4}")))
  ok("anchors still work", /hello world/.test(await grep("^h.*d$")))
  ok("a bare quantifier still works", /hello world/.test(await grep("\\w+")))
  // the deliberate limit of the conservative rule: a group whose last token is
  // NOT the quantified one cannot blow up, so it must still be allowed
  ok("an ANCHORED repeated group is allowed ((a+b)+ cannot blow up)",
    !/unsafe regex/.test(await grep("(a+b)+")), await grep("(a+b)+"))
}

console.log("== the pre-screen is a pure, total predicate ==")
{
  ok("flags a nested quantifier", typeof riskyRegexReason("(a+)+") === "string")
  ok("passes an ordinary pattern", riskyRegexReason("foo.*bar") === null)
  ok("passes a non-capturing group", riskyRegexReason("(?:ab)+") === null)
  ok("empty is not risky", riskyRegexReason("") === null)
  for (const bad of [null, undefined, 42, {}, []]) {
    let threw = false
    try { riskyRegexReason(bad) } catch { threw = true }
    ok(`riskyRegexReason(${JSON.stringify(bad)}) does not throw`, threw === false)
  }
}

console.log("== an invalid regex keeps its own honest error ==")
{
  const out = await grep("(unclosed")
  ok("bad regex is reported as bad regex, not as unsafe", /^ERROR: bad regex/.test(out), out.slice(0, 80))
}

console.log("== the walk is bounded by a deadline as the second defence ==")
{
  const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("function grep_files(ctx, args)"), src.indexOf("// --- skills ---"))
  ok("a deadline is computed for the walk", /const deadline = Date\.now\(\) \+ GREP_DEADLINE_MS/.test(body))
  ok("the directory walk checks it", /if \(Date\.now\(\) > deadline\) \{ timedOut = true; return \}/.test(body))
  ok("the per-line loop checks it too", /0x3f\) === 0 && Date\.now\(\) > deadline/.test(body))
  ok("and a timed-out search SAYS it may be incomplete", /results may be incomplete/.test(body))
  ok("the guard runs before the regex is compiled",
    body.indexOf("riskyRegexReason(args.pattern)") < body.indexOf("new RegExp(args.pattern"))
}

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== grep-redos suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
