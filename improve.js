/**
 * forge — v174 "improvewise": forge improves forge, behind a gate it cannot talk past.
 *
 * forge already had the two halves of a self-improvement loop and nothing
 * joining them:
 *
 *   - `forge bench` says what used to work and no longer does (REGRESSED) and
 *     what forge cannot do yet (the programme lane's "not yet" cases);
 *   - `forge selfaudit` says which tested capability no production code calls.
 *
 * A person read both reports, picked something, and asked an agent to fix it.
 * This module mechanizes that, and keeps the one part that must stay human:
 *
 *   PLAN   both reports become ONE ranked list, each item a ready task.
 *   RUN    the top item goes to forge's own agent, in a throwaway git worktree
 *          on its own branch — never the checkout you are working in.
 *   GATE   the change is kept only if, IN THAT WORKTREE, with the CHANGED code:
 *            - it did not touch the grader (bench cases, eval tasks, the test
 *              runner) and did not delete a test;
 *            - `forge bench` shows no regression, and the targeted bench case
 *              now passes;
 *            - the fast test suite passes (unless the gate is lowered to
 *              `bench`, which the result then says).
 *   KEEP   a kept change is a COMMIT ON A BRANCH (forge/improve-…). It is never
 *          merged, pushed or applied to your checkout: a person reviews it.
 *          Anything that fails the gate is deleted, branch and all.
 *
 * What this is NOT: an agent grading its own homework. The agent's claim of
 * success counts for nothing; only the gate, run on the changed code, decides.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { runGit } from "./worktree.js"

export const ITEM_KIND = Object.freeze({
  REGRESSION: "regression",
  NOT_YET: "not-yet",
  ORPHANED: "orphaned-capability",
})

export const VERDICT = Object.freeze({
  KEPT: "KEPT",
  DISCARDED: "DISCARDED",
  NO_CHANGE: "NO_CHANGE",
  ERROR: "ERROR",
})

// Files that GRADE forge. A change that fixes a bench case by editing the case
// is the textbook way for a self-improving system to lie, so any edit here
// fails the gate outright — whatever the tests then say.
export const PROTECTED = Object.freeze(["benchsuite.js", "bench.js", "evalbench.js", "disciplines.js", "improve.js", "tests/run-all.mjs"])

const RANK = { [ITEM_KIND.REGRESSION]: 0, [ITEM_KIND.NOT_YET]: 1, [ITEM_KIND.ORPHANED]: 2 }

/** Both reports → one ranked list. Regressions first (something broke), then
 *  capabilities forge lacks, then tested-but-unwired code, best-evidenced first. */
export function planImprovements({ suite = null, audit = null, limit = 10 } = {}) {
  const items = []
  for (const r of suite?.results ?? []) {
    if (r.ok) continue
    const regression = (suite.regressions ?? []).includes(r.id)
    const notYet = r.lane === "programme"
    if (!regression && !notYet) continue
    const detail = [r.note || r.name, r.why].filter(Boolean).join(" — ")
    items.push({
      id: `${regression ? "regression" : "not-yet"}:${r.id}`,
      kind: regression ? ITEM_KIND.REGRESSION : ITEM_KIND.NOT_YET,
      caseId: r.id,
      title: regression ? `bench case ${r.id} regressed` : `bench case ${r.id} is not met yet`,
      evidence: detail,
      task: regression
        ? `The forge bench case "${r.id}" used to pass and now fails: ${detail}\n` +
          `Find the cause in forge's code and fix it. Do not edit benchsuite.js, bench.js, evalbench.js or tests/run-all.mjs — the case is the judge, not the defendant. ` +
          `Run \`node forge.js bench --lane ${r.lane}\` to confirm the case passes, and keep the existing tests passing.`
        : `The forge bench programme case "${r.id}" fails — this is a capability forge does not have yet: ${detail}\n` +
          `Implement the capability in forge's code so the case passes. Do not edit benchsuite.js, bench.js, evalbench.js or tests/run-all.mjs — changing the case is not implementing it. ` +
          `Add a focused test under tests/ for the new behaviour, run \`node forge.js bench --lane programme\` to confirm, and keep the existing tests passing.`,
    })
  }
  for (const f of audit?.findings ?? []) {
    if (f.kind !== "orphaned-capability" || f.thin || f.cosmetic) continue
    items.push({
      id: `orphan:${f.file}:${f.name}`,
      kind: ITEM_KIND.ORPHANED,
      file: f.file, name: f.name, testRefs: f.testRefs ?? 0,
      title: `${f.file}:${f.name} is tested but never called`,
      evidence: f.evidence,
      task: `forge's self-audit reports: ${f.evidence}.\n` +
        `Read ${f.name} in ${f.file} and the tests that exercise it, then decide:\n` +
        `- if forge's production path should be using it, wire it in where it belongs and add a test that proves the production path now calls it;\n` +
        `- if it is genuinely not needed on the production path, change nothing and say why.\n` +
        `Do not delete tests, and keep the existing tests passing.`,
    })
  }
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.testRefs ?? 0) - (a.testRefs ?? 0))
  return items.slice(0, Math.max(0, limit))
}

export function formatPlan(items, { suite = null, audit = null } = {}) {
  const lines = ["FORGE IMPROVE — what forge would work on next, most urgent first", ""]
  if (suite) lines.push(`  bench:     ${suite.passed}/${suite.total} · ${suite.regressions?.length ?? 0} regression(s) · ${suite.notYet ?? 0} not yet`)
  if (audit?.stats) lines.push(`  selfaudit: ${audit.stats.orphaned} orphaned capabilit${audit.stats.orphaned === 1 ? "y" : "ies"} (tested, never called)`)
  lines.push("")
  if (!items.length) {
    lines.push("  nothing to work on — no regressions, no open programme cases, no orphaned capability.")
    return lines.join("\n")
  }
  items.forEach((it, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. [${it.kind}] ${it.title}`)
    lines.push(`      ${String(it.evidence).replace(/\s+/g, " ").slice(0, 200)}`)
    lines.push(`      id: ${it.id}`)
  })
  lines.push("", "  forge improve --run            hand item 1 to forge's own agent, in a throwaway worktree",
    "  forge improve --run --item ID  pick one",
    "  a change is kept only if the gate passes, as a commit on a forge/improve-… branch — never merged for you")
  return lines.join("\n")
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"
}

/** Paths the change touched, from porcelain status — renames count for both sides. */
export function changedPaths(porcelain) {
  const out = []
  for (const line of String(porcelain).split("\n")) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    for (const p of rest.split(" -> ")) out.push({ code, path: p.replace(/^"|"$/g, "") })
  }
  return out
}

/** The part of the gate that needs no process: did it touch the grader, or delete a test? */
export function gradeChange(changes) {
  const touched = changes.filter((c) => PROTECTED.includes(c.path)).map((c) => c.path)
  if (touched.length) return { ok: false, reason: `changed the grader: ${[...new Set(touched)].join(", ")}` }
  const deleted = changes.filter((c) => c.code.includes("D") && /^tests\//.test(c.path)).map((c) => c.path)
  if (deleted.length) return { ok: false, reason: `deleted test file(s): ${deleted.join(", ")}` }
  return { ok: true, reason: "" }
}

function runNode(args, { cwd, env = {}, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const keep = (d) => { out += d; if (out.length > 400_000) out = out.slice(-200_000) }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }) })
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e?.message ?? e) }) })
  })
}

/** The gate, run on the CHANGED code in the worktree — never this process's modules. */
export async function defaultGate({ dir, item, level = "full" }) {
  const steps = []
  const bench = await runNode(["forge.js", "bench", "--json"], { cwd: dir, timeoutMs: 10 * 60_000 })
  let suite = null
  try { suite = JSON.parse(bench.out.slice(bench.out.indexOf("{"))) } catch { /* reported below */ }
  if (!suite) return { ok: false, steps: [{ name: "bench", ok: false, note: `bench output was not JSON (exit ${bench.code})` }] }
  const benchOk = !suite.regressed
  steps.push({ name: "bench", ok: benchOk, note: benchOk ? `${suite.passed}/${suite.total}, no regression` : `regressed: ${suite.regressions.join(", ")}` })
  if (!benchOk) return { ok: false, steps }
  if (item?.caseId) {
    const r = suite.results.find((x) => x.id === item.caseId)
    const caseOk = Boolean(r?.ok)
    steps.push({ name: `case ${item.caseId}`, ok: caseOk, note: caseOk ? "now passes" : `still fails: ${r?.note ?? "case not found"}` })
    if (!caseOk) return { ok: false, steps }
  }
  if (level === "bench") {
    steps.push({ name: "tests", ok: true, skipped: true, note: "skipped (--gate bench): the fast test suite did NOT run" })
    return { ok: true, steps }
  }
  const tests = await runNode(["tests/run-all.mjs"], { cwd: dir, env: { FORGE_FAST: "1" }, timeoutMs: 30 * 60_000 })
  const tail = tests.out.trim().split("\n").slice(-1)[0] ?? ""
  steps.push({ name: "tests", ok: tests.code === 0, note: tests.code === 0 ? tail : `failed (exit ${tests.code}): ${tail}` })
  return { ok: tests.code === 0, steps }
}

/**
 * One item through RUN → GATE → KEEP. `runAgent` and `gate` are injected so the
 * loop itself is testable without a live model or a ten-minute suite.
 */
export async function runImprovement({
  root, item, runAgent, provider, config = {}, gate = defaultGate, level = "full",
  git = runGit, onEvent = null, timeoutMs = 20 * 60_000, now = Date.now,
} = {}) {
  const emit = (e) => { try { onEvent?.(e) } catch { /* reporting never fails the run */ } }
  const branch = `forge/improve-${slug(item.id)}-${now().toString(36)}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-improve-"))
  fs.rmSync(dir, { recursive: true, force: true })
  const base = { item: item.id, branch: null, files: [], gate: null }

  const add = await git(["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: root })
  if (add.err) return { ...base, verdict: VERDICT.ERROR, reason: `could not create a worktree: ${add.errText.trim().slice(0, 200)}` }
  emit({ type: "worktree", dir, branch })

  const discard = async () => {
    await git(["worktree", "remove", "--force", dir], { cwd: root })
    await git(["branch", "-D", branch], { cwd: root })
  }

  const prev = process.cwd()
  let agentStatus = "ERROR", agentError = null
  try {
    process.chdir(dir)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await runAgent({ config, provider, task: item.task, journal: false, signal: ctl.signal, onEvent: (e) => emit({ type: "agent", event: e }) })
      agentStatus = String(res?.status ?? "UNKNOWN")
    } finally { clearTimeout(timer) }
  } catch (e) {
    agentError = String(e?.message ?? e).slice(0, 300)
  } finally {
    process.chdir(prev)
  }
  emit({ type: "agent-done", status: agentStatus, error: agentError })

  const st = await git(["status", "--porcelain", "--untracked-files=all"], { cwd: dir })
  const changes = changedPaths(st.out)
  const files = [...new Set(changes.map((c) => c.path))]
  if (!files.length) {
    await discard()
    return { ...base, verdict: agentError ? VERDICT.ERROR : VERDICT.NO_CHANGE, agentStatus, reason: agentError ?? "the agent changed nothing" }
  }

  const graded = gradeChange(changes)
  if (!graded.ok) {
    await discard()
    return { ...base, files, verdict: VERDICT.DISCARDED, agentStatus, reason: graded.reason }
  }

  emit({ type: "gate", files })
  let verdict
  try { verdict = await gate({ dir, item, level }) } catch (e) { verdict = { ok: false, steps: [{ name: "gate", ok: false, note: String(e?.message ?? e) }] } }
  if (!verdict.ok) {
    await discard()
    const failed = verdict.steps.find((s) => !s.ok)
    return { ...base, files, gate: verdict, verdict: VERDICT.DISCARDED, agentStatus, reason: `gate failed at ${failed?.name ?? "?"}: ${failed?.note ?? ""}` }
  }

  await git(["add", "-A"], { cwd: dir })
  const who = (await git(["config", "user.email"], { cwd: dir })).out.trim() ? [] : ["-c", "user.name=forge", "-c", "user.email=forge@localhost"]
  const msg = `forge improve: ${item.title}\n\nitem: ${item.id}\ngate: ${verdict.steps.map((s) => `${s.name} ${s.skipped ? "skipped" : s.ok ? "ok" : "FAIL"}`).join(", ")}\nagent status: ${agentStatus}\n`
  const commit = await git([...who, "commit", "-q", "-m", msg], { cwd: dir })
  if (commit.err) {
    await discard()
    return { ...base, files, gate: verdict, verdict: VERDICT.ERROR, agentStatus, reason: `commit failed: ${commit.errText.trim().slice(0, 200)}` }
  }
  // The branch stays; the worktree does not. A person reviews the branch.
  await git(["worktree", "remove", "--force", dir], { cwd: root })
  return { ...base, branch, files, gate: verdict, verdict: VERDICT.KEPT, agentStatus, reason: "gate passed" }
}

export function formatRun(r) {
  const lines = [`  ${r.verdict.padEnd(9)} ${r.item}`]
  if (r.reason) lines.push(`            ${r.reason}`)
  for (const s of r.gate?.steps ?? []) lines.push(`            ${s.skipped ? "skip" : s.ok ? "ok  " : "FAIL"} ${s.name}: ${s.note}`)
  if (r.files?.length) lines.push(`            files: ${r.files.slice(0, 8).join(", ")}${r.files.length > 8 ? ` … +${r.files.length - 8}` : ""}`)
  if (r.verdict === VERDICT.KEPT) {
    lines.push(`            kept on branch ${r.branch} — review it: git diff HEAD...${r.branch}`)
    if (r.gate?.steps?.some((s) => s.skipped)) lines.push("            the gate was lowered to bench only — run the full suite before trusting it")
  }
  return lines.join("\n")
}
