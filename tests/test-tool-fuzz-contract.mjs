#!/usr/bin/env node
/**
 * forge — every tool answers hostile args with an ERROR, never a throw (v124).
 *
 * The tool layer's contract is that a bad call comes back as a string the model
 * can READ and recover from. A throw is different in kind: it escapes the tool
 * and becomes the caller's problem, and the model learns nothing it can act on.
 *
 * That contract was being kept by 411 of 414 tool/arg combinations. The three
 * that broke it were `git_diff`, `git_log` and `git_blame` with a NUL byte in
 * `path`: child_process rejects the argv entry, and the throw escaped. Every
 * other file tool already answered a NUL path with an error — read_file says
 * `invalid path component` — so those three were the outliers, not the rule.
 *
 * This suite is the fuzz that found them, kept as a regression: it sweeps every
 * wire tool with a battery of hostile arguments and asserts the SAME property
 * for all of them. It is deliberately a property test, not a list of three
 * fixes, so the next tool to break the contract is caught by the same net.
 *
 * Tools that spawn, hit the network, or mutate global state are out of scope
 * here (the suites that own them exercise them directly); this pass is about
 * the argument-handling contract of the in-process tools.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-toolfuzz-home-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}

const { TOOL_DEFS, execTool } = await import("../tools.js")

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-toolfuzz-"))
fs.writeFileSync(path.join(ROOT, "a.txt"), "hello\nworld\n")
const ctx = { cwd: ROOT, root: ROOT, timeoutSec: 3, maxToolOutput: 8000, readOnly: true, _plugins: new Map() }

const NUL = String.fromCharCode(0)
// spawning / networking / globally-stateful tools belong to their own suites
const OUT_OF_SCOPE = new Set([
  "bash", "fetch_url", "web_search", "browser", "process", "repl",
  "mcp", "lsp", "delegate", "spawn_agent", "task", "python",
])

const HOSTILE = [
  {}, null, undefined,
  { path: "../../../../etc/passwd" }, { path: "" }, { path: NUL }, { path: NUL + "a" },
  { path: "-rf" }, { path: "--upload-pack=touch /tmp/pwn" },
  { pattern: "(((((" }, { pattern: null }, { pattern: {} }, { pattern: NUL },
  { limit: -1, offset: -1, max: -1 },
  { limit: Infinity, offset: NaN, max: 1e9 },
  { path: "a.txt", offset: "abc", limit: "xyz" },
  { content: "x".repeat(5000) },
  { name: "../escape" }, { name: NUL },
  { path: "a.txt", old_string: "", new_string: "" },
  { url: "not-a-url" }, { command: "" },
]

console.log("== every in-process tool returns, none throws ==")
{
  const threw = []
  let ran = 0
  const names = TOOL_DEFS.map((d) => d.function?.name).filter((n) => n && !OUT_OF_SCOPE.has(n))
  for (const name of names) {
    for (const args of HOSTILE) {
      ran++
      try { await execTool(ctx, name, args) }
      catch (e) { threw.push(`${name}(${JSON.stringify(args ?? null).slice(0, 44)}) threw ${String(e?.message ?? e).slice(0, 60)}`) }
    }
  }
  ok(`swept ${ran} tool/arg combinations across ${names.length} in-process tools`, ran > 300, String(ran))
  ok("NONE of them threw — every answer is a value the model can read",
    threw.length === 0, threw.slice(0, 4).join(" | "))
}

console.log("== a returned answer is always a readable value, never undefined ==")
{
  let bad = []
  for (const name of ["read_file", "glob_files", "grep_files", "git_log", "git_diff", "git_blame"]) {
    if (!TOOL_DEFS.some((d) => d.function?.name === name)) continue
    const r = await execTool(ctx, name, { path: NUL, pattern: "x" })
    if (r === undefined || r === null) bad.push(name)
  }
  ok("hostile input still yields a defined result", bad.length === 0, bad.join(","))
}

console.log("== the git pathspec guard (the three that broke the contract) ==")
{
  for (const t of ["git_diff", "git_log", "git_blame"]) {
    const nul = String(await execTool(ctx, t, { path: NUL }))
    ok(`${t}: a NUL path is an honest ERROR`, /^ERROR:/.test(nul) && /NUL byte/.test(nul), nul.slice(0, 70))
    // A leading "-" is NOT refused, and must not be: all three callers pass the
    // path after `--`, which ends git's option parsing, and the argv goes to
    // execFile rather than a shell. `-report.txt` is a legal tracked filename
    // (verified against git), so the first version of this guard rejected real
    // files. What still matters is that it is never read as an OPTION.
    const dash = String(await execTool(ctx, t, { path: "-report.txt" }))
    ok(`${t}: a leading-dash FILENAME is accepted, not mistaken for a flag`,
      !/may not start with/.test(dash), dash.slice(0, 70))
    ok(`${t}: …and is never parsed as an option`,
      !/unknown option|unrecognized option|ambiguous argument/i.test(dash), dash.slice(0, 70))
    // the injection shape stays in the sweep above: it must not THROW, and it
    // reaches git only as a pathspec, which simply matches no tracked file
    const inject = String(await execTool(ctx, t, { path: "--upload-pack=touch /tmp/pwn" }))
    // only OPTION-PARSER diagnostics count as failure here. git legitimately
    // echoes the pathspec back in a no-match message ("no commits touching
    // --upload-pack=…"), so matching the payload text itself would flag the
    // correct behaviour as a bug.
    ok(`${t}: a flag-shaped pathspec never becomes an option`,
      !/unknown option|unrecognized option|ambiguous argument/i.test(inject), inject.slice(0, 90))
    const ctrl = String(await execTool(ctx, t, { path: `a${String.fromCharCode(7)}b` }))
    ok(`${t}: a control character is refused`, /^ERROR:/.test(ctrl), ctrl.slice(0, 70))
  }
}

console.log("== ordinary git usage is not collateral damage ==")
{
  // run against the forge checkout itself, which is a real repo
  // fileURLToPath, not .pathname: pathname keeps percent-escapes (a checkout
  // under a path containing a space) and is not a native Windows path, either
  // of which makes the isGit check below miss and silently skip this section
  const repo = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
  const gctx = { ...ctx, cwd: repo, root: repo, timeoutSec: 20 }
  const isGit = fs.existsSync(path.join(repo, ".git"))
  if (!isGit) {
    ok("skipped: not a git checkout", true)
  } else {
    const log = String(await execTool(gctx, "git_log", { limit: 2 }))
    ok("git_log with no path still works", !/^ERROR:/.test(log), log.slice(0, 70))
    const logPath = String(await execTool(gctx, "git_log", { limit: 2, path: "tools.js" }))
    ok("git_log with a real path still works", !/^ERROR:/.test(logPath), logPath.slice(0, 70))
    const rel = String(await execTool(gctx, "git_blame", { path: "./version.js", start: 1, end: 1 }))
    ok("a ./-relative path is still accepted", !/^ERROR:/.test(rel), rel.slice(0, 70))
  }
}

console.log("== a real tracked file whose name starts with '-' is readable ==")
{
  // the regression the first version of the guard caused, proven end to end
  // against git rather than argued from the source
  const dashRepo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dashrepo-"))
  const git = (await import("node:child_process")).execFileSync
  const run = (args) => git("git", args, { cwd: dashRepo, stdio: "pipe" })
  let usable = true
  try {
    run(["init", "-q"])
    run(["config", "user.email", "t@example.invalid"])
    run(["config", "user.name", "t"])
    fs.writeFileSync(path.join(dashRepo, "-report.txt"), "hello\n")
    run(["add", "--", "-report.txt"])
    run(["commit", "-qm", "add a dash-named file"])
  } catch { usable = false }

  if (!usable) {
    ok("skipped: git unavailable in this environment", true)
  } else {
    const dctx = { ...ctx, cwd: dashRepo, root: dashRepo, timeoutSec: 20 }
    const log = String(await execTool(dctx, "git_log", { path: "-report.txt" }))
    ok("git_log reads a '-'-named file", !/^ERROR:/.test(log) && /dash-named/.test(log), log.slice(0, 90))
    const blame = String(await execTool(dctx, "git_blame", { path: "-report.txt", start: 1, end: 1 }))
    ok("git_blame reads a '-'-named file", !/^ERROR:/.test(blame) && /hello/.test(blame), blame.slice(0, 90))
    const diff = String(await execTool(dctx, "git_diff", { path: "-report.txt" }))
    ok("git_diff accepts a '-'-named file", !/^ERROR:/.test(diff), diff.slice(0, 90))
  }
  try { fs.rmSync(dashRepo, { recursive: true, force: true }) } catch {}
}

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== tool-fuzz-contract suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
