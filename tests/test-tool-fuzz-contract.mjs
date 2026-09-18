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
    // a leading "-" would be read by git as a FLAG, not a path — argument injection
    const dash = String(await execTool(ctx, t, { path: "--upload-pack=touch /tmp/pwn" }))
    ok(`${t}: a flag-shaped pathspec is refused`, /^ERROR:/.test(dash) && /may not start with/.test(dash), dash.slice(0, 70))
    const ctrl = String(await execTool(ctx, t, { path: `a${String.fromCharCode(7)}b` }))
    ok(`${t}: a control character is refused`, /^ERROR:/.test(ctrl), ctrl.slice(0, 70))
  }
}

console.log("== ordinary git usage is not collateral damage ==")
{
  // run against the forge checkout itself, which is a real repo
  const repo = path.dirname(new URL("../package.json", import.meta.url).pathname)
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

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== tool-fuzz-contract suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
