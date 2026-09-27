#!/usr/bin/env node
/**
 * forge — v174 improvewise: `forge improve`.
 *
 * The loop PLAN → RUN → GATE → KEEP, pinned with a stub agent and a stub gate
 * on a throwaway git repository. What is asserted is that the loop cannot be
 * talked past:
 *   - an agent that edits the grader is discarded, whatever the gate says;
 *   - an agent that deletes a test is discarded;
 *   - a failing gate discards the change, branch and all;
 *   - a passing gate keeps the change ONLY as a commit on its own branch —
 *     the checkout the person is working in is never touched;
 *   - an agent that changes nothing is NO_CHANGE, not a success.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-improve-home-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { planImprovements, formatPlan, changedPaths, gradeChange, runImprovement, formatRun, ITEM_KIND, VERDICT, PROTECTED } = await import("../improve.js")

console.log("== 1. PLAN: both reports become one ranked list ==")
{
  const suite = {
    passed: 3, total: 6, notYet: 1, regressions: ["cap-a"],
    results: [
      { id: "cap-ok", lane: "capability", ok: true },
      { id: "cap-a", lane: "capability", ok: false, note: "used to work" },
      { id: "prog-b", lane: "programme", ok: false, note: "missing", why: "because" },
      { id: "auto-c", lane: "autonomy", ok: false, note: "not a guard lane" },
    ],
  }
  const audit = {
    stats: { orphaned: 3 },
    findings: [
      { kind: "orphaned-capability", file: "a.js", name: "few", testRefs: 2, evidence: "a.js exports few" },
      { kind: "orphaned-capability", file: "b.js", name: "many", testRefs: 9, evidence: "b.js exports many" },
      { kind: "orphaned-capability", file: "c.js", name: "formatX", testRefs: 20, cosmetic: true, evidence: "cosmetic" },
      { kind: "orphaned-capability", file: "d.js", name: "alias", testRefs: 20, thin: true, evidence: "thin" },
      { kind: "dead-export", file: "e.js", name: "dead", testRefs: 0, evidence: "dead" },
    ],
  }
  const items = planImprovements({ suite, audit })
  eq("regression, then not-yet, then orphans by evidence", items.map((i) => i.id), ["regression:cap-a", "not-yet:prog-b", "orphan:b.js:many", "orphan:a.js:few"])
  ok("cosmetic, thin-alias and dead exports are not handed to an agent", !items.some((i) => /formatX|alias|dead/.test(i.id)))
  ok("a non-guard, non-programme failure is not planned", !items.some((i) => i.id.includes("auto-c")))
  ok("bench tasks forbid editing the grader", items.filter((i) => i.caseId).every((i) => /Do not edit benchsuite\.js/.test(i.task)))
  ok("orphan tasks allow 'change nothing' and forbid deleting tests", /change nothing and say why/.test(items[2].task) && /Do not delete tests/.test(items[2].task))
  eq("limit is honoured", planImprovements({ suite, audit, limit: 2 }).length, 2)
  ok("an empty plan says so", /nothing to work on/.test(formatPlan([], {})))
  ok("the plan text says nothing is merged for you", /never merged for you/.test(formatPlan(items, { suite, audit })))
}

console.log("== 2. GATE, the part that needs no process ==")
{
  eq("porcelain parsing, renames count both sides", changedPaths(" M a.js\n?? tests/new.mjs\nR  old.js -> new.js\n").map((c) => c.path), ["a.js", "tests/new.mjs", "old.js", "new.js"])
  ok("editing a bench file fails", !gradeChange([{ code: " M", path: "benchsuite.js" }]).ok)
  ok("editing the test runner fails", !gradeChange([{ code: " M", path: "tests/run-all.mjs" }]).ok)
  ok("editing improve.js itself fails", PROTECTED.includes("improve.js") && !gradeChange([{ code: " M", path: "improve.js" }]).ok)
  ok("deleting a test fails", !gradeChange([{ code: " D", path: "tests/test-x.mjs" }]).ok)
  ok("adding a test and editing code passes", gradeChange([{ code: "??", path: "tests/test-new.mjs" }, { code: " M", path: "agent.js" }]).ok)
}

console.log("== 3. RUN → GATE → KEEP on a real git repository ==")
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim()
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-improve-repo-"))
git(repo, "init", "-q", "-b", "main")
git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t")
fs.writeFileSync(path.join(repo, "lib.js"), "export const x = 1\n")
fs.writeFileSync(path.join(repo, "benchsuite.js"), "// grader\n")
fs.mkdirSync(path.join(repo, "tests"))
fs.writeFileSync(path.join(repo, "tests", "test-a.mjs"), "// a test\n")
git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init")
const head0 = git(repo, "rev-parse", "HEAD")
const item = { id: "orphan:lib.js:x", kind: ITEM_KIND.ORPHANED, title: "lib.js:x is tested but never called", task: "wire x in" }
const branches = () => git(repo, "branch", "--list", "forge/*").split("\n").map((s) => s.trim()).filter(Boolean)
const passGate = async () => ({ ok: true, steps: [{ name: "bench", ok: true, note: "fine" }, { name: "tests", ok: true, note: "fine" }] })
const failGate = async () => ({ ok: false, steps: [{ name: "bench", ok: true, note: "fine" }, { name: "tests", ok: false, note: "1 suite failed" }] })
let n = 0
const now = () => ++n * 1000
let seenCwd = null
{
  const agentCwdBefore = process.cwd()
  const r = await runImprovement({
    root: repo, item, now, gate: passGate,
    runAgent: async () => { seenCwd = process.cwd(); fs.writeFileSync("lib.js", "export const x = 2\n"); return { status: "COMPLETED" } },
  })
  eq("a passing gate keeps the change", r.verdict, VERDICT.KEPT)
  ok("the agent worked in a worktree, not the checkout", seenCwd && path.basename(seenCwd).startsWith("forge-improve-") && !seenCwd.startsWith(fs.realpathSync(repo)), seenCwd)
  eq("the process cwd is restored", process.cwd(), agentCwdBefore)
  ok("the change is a commit on its own branch", branches().includes(r.branch) && git(repo, "show", `${r.branch}:lib.js`) === "export const x = 2", r.branch)
  eq("the person's checkout is untouched", [git(repo, "rev-parse", "HEAD"), fs.readFileSync(path.join(repo, "lib.js"), "utf8")], [head0, "export const x = 1\n"])
  ok("the commit message records the gate", /gate: bench ok, tests ok/.test(git(repo, "log", "-1", "--format=%B", r.branch)))
  eq("the worktree is gone afterwards", git(repo, "worktree", "list").split("\n").length, 1)
  ok("the report tells the person how to review it", /git diff HEAD\.\.\.forge\/improve-/.test(formatRun(r)))
}
{
  const before = branches()
  const r = await runImprovement({
    root: repo, item, now, gate: failGate,
    runAgent: async () => { fs.writeFileSync("lib.js", "export const x = 3\n"); return { status: "COMPLETED" } },
  })
  eq("a failing gate discards", r.verdict, VERDICT.DISCARDED)
  ok("…and says where it failed", /gate failed at tests: 1 suite failed/.test(r.reason), r.reason)
  eq("…and leaves no branch behind", branches(), before)
  eq("the agent's claim of COMPLETED counted for nothing", r.agentStatus, "COMPLETED")
}
{
  let gateRan = false
  const before = branches()
  const r = await runImprovement({
    root: repo, item, now, gate: async () => { gateRan = true; return passGate() },
    runAgent: async () => { fs.writeFileSync("benchsuite.js", "// grader, edited to pass\n"); fs.writeFileSync("lib.js", "export const x = 4\n"); return { status: "COMPLETED" } },
  })
  eq("editing the grader is discarded", r.verdict, VERDICT.DISCARDED)
  ok("…before the gate even runs", !gateRan)
  ok("…with the reason named", /changed the grader: benchsuite\.js/.test(r.reason), r.reason)
  eq("…and no branch is left", branches(), before)
}
{
  const r = await runImprovement({
    root: repo, item, now, gate: passGate,
    runAgent: async () => { fs.rmSync("tests/test-a.mjs"); return { status: "COMPLETED" } },
  })
  eq("deleting a test is discarded", r.verdict, VERDICT.DISCARDED)
}
{
  const r = await runImprovement({ root: repo, item, now, gate: passGate, runAgent: async () => ({ status: "COMPLETED" }) })
  eq("an agent that changed nothing is NO_CHANGE", r.verdict, VERDICT.NO_CHANGE)
  eq("no worktree is left behind by any outcome", git(repo, "worktree", "list").split("\n").length, 1)
}
{
  const r = await runImprovement({ root: repo, item, now, gate: passGate, runAgent: async () => { throw new Error("HTTP 402 out of credits") } })
  eq("an agent that never ran is ERROR", r.verdict, VERDICT.ERROR)
  ok("…with the provider's reason", /402/.test(r.reason), r.reason)
}
{
  const r = await runImprovement({ root: repo, item, now, gate: async () => ({ ok: true, steps: [{ name: "bench", ok: true, note: "fine" }, { name: "tests", ok: true, skipped: true, note: "skipped" }] }),
    runAgent: async () => { fs.writeFileSync("lib.js", "export const x = 5\n"); return { status: "COMPLETED" } } })
  eq("a lowered gate can still keep", r.verdict, VERDICT.KEPT)
  ok("…but the report warns the full suite did not run", /lowered to bench only/.test(formatRun(r)))
}

fs.rmSync(repo, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
