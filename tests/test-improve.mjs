#!/usr/bin/env node
/**
 * forge — v174 improvewise: `forge improve`.
 *
 * The loop PLAN → RUN → GATE → KEEP, pinned with a stub agent and a stub gate
 * on a throwaway git repository. What is asserted is that the loop cannot be
 * talked past:
 *   - an agent that edits the grader is discarded, whatever the gate says;
 *   - an agent that deletes, moves or edits an existing test is discarded
 *     (it may only ADD tests), including through commits it made itself;
 *   - an agent that writes into the person's own checkout is discarded;
 *   - the kept commit is exactly the tree that was gated;
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

const { planImprovements, formatPlan, parseNameStatus, gradeChange, runImprovement, formatRun, ITEM_KIND, VERDICT, PROTECTED } = await import("../improve.js")

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
    stats: { orphaned: 3, duplicateBodies: 1 },
    findings: [
      { kind: "orphaned-capability", file: "a.js", name: "few", testRefs: 2, evidence: "a.js exports few" },
      { kind: "orphaned-capability", file: "b.js", name: "many", testRefs: 9, evidence: "b.js exports many" },
      { kind: "orphaned-capability", file: "c.js", name: "formatX", testRefs: 20, cosmetic: true, evidence: "cosmetic" },
      { kind: "orphaned-capability", file: "d.js", name: "alias", testRefs: 20, thin: true, evidence: "thin" },
      { kind: "dead-export", file: "e.js", name: "dead", testRefs: 0, evidence: "dead" },
      { kind: "duplicate-body", file: "p.js", name: "validate", bytes: 200, duplicates: [{ file: "p.js", name: "validate" }, { file: "q.js", name: "validate" }], evidence: "p.js:validate, q.js:validate share a 200-byte body" },
    ],
  }
  const items = planImprovements({ suite, audit })
  eq("regression, then not-yet, then orphans by evidence, then duplicate cleanup last", items.map((i) => i.id), ["regression:cap-a", "not-yet:prog-b", "orphan:b.js:many", "orphan:a.js:few", "duplicate:p.js+q.js:validate"])
  ok("cosmetic, thin-alias and dead exports are not handed to an agent", !items.some((i) => /formatX|alias|dead/.test(i.id)))
  ok("a non-guard, non-programme failure is not planned", !items.some((i) => i.id.includes("auto-c")))
  ok("bench tasks forbid editing the grader", items.filter((i) => i.caseId).every((i) => /Do not edit benchsuite\.js/.test(i.task)))
  ok("orphan tasks allow 'change nothing' and forbid deleting tests", /change nothing and say why/.test(items[2].task) && /Do not delete tests/.test(items[2].task))
  const dup = items.find((i) => i.kind === ITEM_KIND.DUPLICATE)
  ok("a duplicate-body finding becomes a ranked consolidation item", Boolean(dup) && dup.kind === "duplicate-body")
  ok("the duplicate task names both sites and says consolidate carefully, not add a layer", /p\.js:validate, q\.js:validate/.test(dup.task) && /unify, not to add another layer/.test(dup.task) && /update EVERY caller/.test(dup.task))
  ok("the duplicate item has no caseId (its gate is bench+tests, not a bench case)", dup.caseId === undefined)
  eq("the duplicate group shows in the plan summary", /duplicate-body group/.test(formatPlan(items, { suite, audit })), true)
  eq("limit is honoured", planImprovements({ suite, audit, limit: 2 }).length, 2)
  ok("an empty plan says so", /nothing to work on/.test(formatPlan([], {})))
  ok("the plan text says nothing is merged for you", /never merged for you/.test(formatPlan(items, { suite, audit })))
}

console.log("== 2. GATE, the part that needs no process ==")
{
  eq("name-status parsing records both sides of a rename", parseNameStatus("M\ta.js\nA\ttests/new.mjs\nR100\ttests/t.mjs\tother/t.mjs\n"),
    [{ code: "M", path: "a.js", role: null }, { code: "A", path: "tests/new.mjs", role: null }, { code: "R", path: "tests/t.mjs", role: "from" }, { code: "R", path: "other/t.mjs", role: "to" }])
  ok("editing a bench file fails", !gradeChange([{ code: "M", path: "benchsuite.js" }]).ok)
  ok("editing the test runner fails", !gradeChange([{ code: "M", path: "tests/run-all.mjs" }]).ok)
  ok("editing improve.js itself fails", PROTECTED.includes("improve.js") && !gradeChange([{ code: "M", path: "improve.js" }]).ok)
  ok("deleting a test fails", !gradeChange([{ code: "D", path: "tests/test-x.mjs" }]).ok)
  ok("moving a test out of tests/ fails", !gradeChange(parseNameStatus("R100\ttests/test-x.mjs\telsewhere/x.mjs")).ok)
  ok("editing an existing test fails", /edited existing test/.test(gradeChange([{ code: "M", path: "tests/test-x.mjs" }]).reason))
  ok("adding a test and editing code passes", gradeChange([{ code: "A", path: "tests/test-new.mjs" }, { code: "M", path: "agent.js" }]).ok)
  ok("moving a file INTO tests/ is an addition, and passes", gradeChange(parseNameStatus("R100\thelper.mjs\ttests/helper.mjs")).ok)
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

console.log("== 4. what CodeRabbit found on #102 ==")
{
  const before = branches()
  let r = await runImprovement({ root: repo, item, now, gate: passGate,
    runAgent: async () => { fs.writeFileSync("tests/test-a.mjs", "// weakened\n"); fs.writeFileSync("lib.js", "export const x = 6\n"); return { status: "COMPLETED" } } })
  eq("editing an existing test is discarded", r.verdict, VERDICT.DISCARDED)
  r = await runImprovement({ root: repo, item, now, gate: passGate,
    runAgent: async () => { fs.mkdirSync("other"); execFileSync("git", ["mv", "tests/test-a.mjs", "other/test-a.mjs"]); return { status: "COMPLETED" } } })
  eq("git mv of a test out of tests/ is discarded", r.verdict, VERDICT.DISCARDED)
  ok("…as a moved test", /deleted or moved existing test/.test(r.reason), r.reason)
  eq("…and neither left a branch", branches(), before)

  r = await runImprovement({ root: repo, item, now, gate: passGate,
    runAgent: async () => {
      fs.writeFileSync("lib.js", "export const x = 7\n")
      execFileSync("git", ["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qam", "agent's own commit"])
      fs.writeFileSync("benchsuite.js", "// edited after committing\n")
      execFileSync("git", ["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qam", "and another"])
      return { status: "COMPLETED" }
    } })
  eq("changes the agent committed itself are still graded", r.verdict, VERDICT.DISCARDED)
  ok("…so a committed grader edit is caught", /changed the grader: benchsuite\.js/.test(r.reason), r.reason)

  r = await runImprovement({ root: repo, item, now, gate: passGate,
    runAgent: async () => { fs.writeFileSync("lib.js", "export const x = 8\n"); execFileSync("git", ["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qam", "own"]); return { status: "COMPLETED" } } })
  eq("an agent that committed a good change is still kept", r.verdict, VERDICT.KEPT)
  eq("…as ONE commit on top of the base", git(repo, "rev-list", "--count", `${head0}..${r.branch}`), "1")
  ok("…with forge's message", /^forge improve:/.test(git(repo, "log", "-1", "--format=%s", r.branch)))

  r = await runImprovement({ root: repo, item, now,
    gate: async ({ dir }) => { fs.writeFileSync(path.join(dir, "gate-output.log"), "written by the gate\n"); return passGate() },
    runAgent: async () => { fs.writeFileSync("lib.js", "export const x = 9\n"); return { status: "COMPLETED" } } })
  eq("a gate that writes files still keeps the change", r.verdict, VERDICT.KEPT)
  ok("…but what the gate wrote is not in the commit", !git(repo, "ls-tree", "-r", "--name-only", r.branch).split("\n").includes("gate-output.log"))

  const before2 = branches()
  r = await runImprovement({ root: repo, item, now, gate: passGate,
    runAgent: async () => { fs.writeFileSync(path.join(repo, "escaped.txt"), "outside the worktree\n"); fs.writeFileSync("lib.js", "export const x = 10\n"); return { status: "COMPLETED" } } })
  eq("an agent that wrote into the person's checkout is discarded", r.verdict, VERDICT.DISCARDED)
  ok("…and the report says the checkout changed and where", /your checkout at .* changed while the agent ran/.test(r.reason) && /escaped\.txt/.test(r.reason), r.reason)
  eq("…and leaves no branch", branches(), before2)
  fs.rmSync(path.join(repo, "escaped.txt"))

  let staged = 0
  r = await runImprovement({ root: repo, item, now, gate: passGate,
    git: async (args, opts) => { if (args[0] === "add" && ++staged === 1) return { err: true, code: 1, out: "", errText: "fatal: unable to index file" } ; return (await import("../worktree.js")).runGit(args, opts) },
    runAgent: async () => { fs.writeFileSync("lib.js", "export const x = 11\n"); return { status: "COMPLETED" } } })
  eq("a failed git add stops before anything is committed", r.verdict, VERDICT.ERROR)
  ok("…and says so", /git add failed/.test(r.reason), r.reason)
}

fs.rmSync(repo, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
