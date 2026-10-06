/**
 * forge — several attempts, keep the one that passes (`forge agent --tries N`)
 *
 * One attempt at a task is one draw: the same model on the same task can get
 * it right the second time it tries from scratch. When there is a CHECK that
 * can tell a right answer from a wrong one — your tests — more draws turn
 * into a better result, and the check, not the agent's own word, decides
 * which draw you get.
 *
 *   forge agent --tries 3 "make the parser handle quoted commas"
 *   forge agent --tries 3 --check "npm test" "…"
 *   forge agent --tries 4 --parallel 2 "…"     (two at a time)
 *
 * How:
 *   - every attempt runs as a REAL `forge agent` in its own git worktree, so
 *     attempts cannot see or break each other or your checkout
 *   - each worktree starts from your working tree as it is now: committed
 *     work, uncommitted edits and new files alike (the "seed")
 *   - after an attempt, the check runs in its worktree
 *   - one at a time (default): the first attempt that passes wins and the
 *     rest never run — you pay for more attempts only when you need them;
 *     --parallel N runs N at a time, stops after the first round with a pass,
 *     and keeps the smallest passing change
 *   - the winner's change is applied to your checkout (checked first: it
 *     lands whole or not at all); every attempt's change and log is kept in
 *     forge's data folder, so a losing attempt is still one `git apply` away
 *
 * The check is, in order: --check, agent.triesCheck, the project's own test
 * command (router.detectTestCommand). With no check at all, the agent's own
 * result decides — and the summary says so, because that is a weaker test.
 * A check that already passes BEFORE any attempt cannot tell attempts apart;
 * forge measures that first and says so too.
 *
 * Off by default (--tries 1 is a normal run): more attempts cost more, and
 * whether they pay is a Phase 0 measurement, not an assumption.
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { runGit, probeGit, createWorktree, removeWorktree, mergeBack } from "./worktree.js"

export const TRIES_MAX = 8
export const TRIES_SCHEMA = "forge.tries/1"
const CHECK_TIMEOUT_MS = 10 * 60 * 1000
const ATTEMPT_TIMEOUT_MS = 45 * 60 * 1000
const SEED_MAX_FILES = 5000
const SEED_MAX_BYTES = 200 * 1024 * 1024
const EXCLUDE = [":(exclude).forge", ":(exclude).forge/**"]
const IDENT = ["-c", "user.name=forge", "-c", "user.email=forge@localhost", "-c", "commit.gpgsign=false"]
const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim())?.trim() ?? ""
const tail = (s, n = 1500) => { const t = String(s ?? ""); return t.length > n ? "…" + t.slice(-n) : t }

/** Parse and bound --tries. Returns { n, error }. */
export function parseTries(v) {
  if (v === undefined || v === null || v === false) return { n: 1, error: null }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > TRIES_MAX) return { n: 1, error: `--tries must be an integer from 1 to ${TRIES_MAX}` }
  return { n, error: null }
}

// ---- the seed: your working tree as it is now --------------------------------

async function repoRoot(cwd) {
  const r = await runGit(["rev-parse", "--show-toplevel"], { cwd })
  return r.err ? null : String(r.out).trim() || null
}

/**
 * What the worktrees must start from beyond HEAD: tracked edits (as one
 * binary patch) and untracked, not-ignored files. forge's own .forge is not
 * project content and is left out.
 */
export async function readSeed(root) {
  const diff = await runGit(["diff", "HEAD", "--binary", "--", ".", ...EXCLUDE], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  if (diff.err) return { ok: false, reason: "git diff failed: " + firstLine(diff.errText) }
  const ls = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  if (ls.err) return { ok: false, reason: "git ls-files failed: " + firstLine(ls.errText) }
  const untracked = String(ls.out).split("\0").filter((f) => f && f !== ".forge" && !f.startsWith(".forge/"))
  if (untracked.length > SEED_MAX_FILES) return { ok: false, reason: `${untracked.length} untracked files — too many to copy into each attempt (add them to .gitignore or commit them)` }
  let bytes = 0
  for (const f of untracked) { try { bytes += fs.lstatSync(path.join(root, f)).size } catch { } }
  if (bytes > SEED_MAX_BYTES) return { ok: false, reason: `untracked files total ${Math.round(bytes / 1048576)} MB — too much to copy into each attempt` }
  return { ok: true, patch: String(diff.out), untracked, bytes }
}

/** Put the seed into a fresh worktree and commit it there, so an attempt's
 *  change is measured from exactly what you had. Returns the seed commit. */
async function plantSeed({ root, dir, seed, base, scratch }) {
  if (!seed.patch.trim() && !seed.untracked.length) return { ok: true, sha: base }
  if (seed.patch.trim()) {
    const pf = path.join(scratch, `seed-${path.basename(dir)}.patch`)
    fs.writeFileSync(pf, seed.patch, { mode: 0o600 })
    const ap = await runGit(["apply", "--whitespace=nowarn", "--binary", pf], { cwd: dir })
    if (ap.err) return { ok: false, reason: "could not reproduce your uncommitted edits in the attempt: " + firstLine(ap.errText) }
  }
  for (const f of seed.untracked) {
    const src = path.join(root, f), dst = path.join(dir, f)
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      const st = fs.lstatSync(src)
      if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst)
      else if (st.isFile()) { fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode & 0o777) }
    } catch (e) { return { ok: false, reason: `could not copy ${f} into the attempt: ${e?.message ?? e}` } }
  }
  let add = await runGit(["add", "-A", "--", ".", ...EXCLUDE], { cwd: dir })
  if (add.err && /ignored by one of your \.gitignore files/i.test(add.errText)) add = await runGit(["add", "-A", "--", "."], { cwd: dir })
  if (add.err) return { ok: false, reason: "git add failed in the attempt: " + firstLine(add.errText) }
  const c = await runGit([...IDENT, "commit", "-q", "--no-verify", "--allow-empty", "-m", "forge tries: your uncommitted work"], { cwd: dir })
  if (c.err) return { ok: false, reason: "could not record your uncommitted work in the attempt: " + firstLine(c.errText) }
  const sha = await runGit(["rev-parse", "HEAD"], { cwd: dir })
  return sha.err ? { ok: false, reason: "rev-parse failed" } : { ok: true, sha: String(sha.out).trim() }
}

/** Everything an attempt changed since its seed — committed or not — as one
 *  binary patch, written to `file`. */
async function captureAttempt({ dir, seedSha, file }) {
  let intent = await runGit(["add", "-A", "-N", "--", ".", ...EXCLUDE], { cwd: dir })
  if (intent.err && /ignored by one of your \.gitignore files/i.test(intent.errText)) intent = await runGit(["add", "-A", "-N", "--", "."], { cwd: dir })
  if (intent.err) return { ok: false, reason: "git add -N failed: " + firstLine(intent.errText) }
  const diff = await runGit(["diff", "--binary", seedSha, "--", ".", ...EXCLUDE], { cwd: dir, maxBuffer: 256 * 1024 * 1024 })
  if (diff.err) return { ok: false, reason: "git diff failed: " + firstLine(diff.errText) }
  const names = await runGit(["diff", "--name-only", seedSha, "--", ".", ...EXCLUDE], { cwd: dir })
  const patch = String(diff.out)
  const files = String(names.out).split("\n").map((s) => s.trim()).filter(Boolean)
  if (!patch.trim()) return { ok: true, patchPath: null, files: [], bytes: 0 }
  fs.writeFileSync(file, patch, { mode: 0o600 })
  return { ok: true, patchPath: file, files, bytes: Buffer.byteLength(patch) }
}

// ---- running things ----------------------------------------------------------

/** Run the check: a shell command, in `cwd`, bounded. Never throws. */
export function runCheck(command, { cwd, timeoutMs = CHECK_TIMEOUT_MS, env = process.env } = {}) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]]
    let out = ""
    let child
    try { child = spawn(shell[0], shell[1], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }) }
    catch (e) { return resolve({ ok: false, code: null, output: String(e?.message ?? e), ms: 0, timedOut: false }) }
    const keep = (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000) }
    child.stdout.on("data", keep); child.stderr.on("data", keep)
    let timedOut = false
    const t = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL") } catch { } }, timeoutMs)
    child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, code: null, output: String(e?.message ?? e), ms: Date.now() - t0, timedOut }) })
    child.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0 && !timedOut, code, output: tail(out), ms: Date.now() - t0, timedOut }) })
  })
}

/**
 * The default attempt runner: a real `forge agent` child in the attempt's
 * directory. FORGE_TRIES_CHILD stops the child from starting tries of its own.
 */
export function spawnAttempt({ forgeEntry, task, args = [], cwd, resultFile, logFile, timeoutMs = ATTEMPT_TIMEOUT_MS, env = process.env, signal = null }) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, "a", 0o600)
    const child = spawn(process.execPath, [forgeEntry, "agent", task, ...args, "--result-json", resultFile], {
      cwd, env: { ...env, FORGE_TRIES_CHILD: "1", NO_COLOR: "1" }, stdio: ["ignore", fd, fd],
    })
    let timedOut = false
    const t = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM") } catch { } }, timeoutMs)
    const onAbort = () => { try { child.kill("SIGTERM") } catch { } }
    signal?.addEventListener?.("abort", onAbort, { once: true })
    child.on("close", (code) => {
      clearTimeout(t); signal?.removeEventListener?.("abort", onAbort)
      try { fs.closeSync(fd) } catch { }
      let result = null
      try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")) } catch { }
      resolve({ exitCode: code, timedOut, result })
    })
  })
}

// ---- choosing ------------------------------------------------------------------

/** Did this attempt pass? With a usable check, the check decides; otherwise
 *  the agent's own result does (and the summary says which). */
export function attemptPassed(a, { checkUsable }) {
  if (a.error) return false
  if (checkUsable) return a.check?.ok === true
  const st = String(a.agent?.status ?? "")
  const agentOk = st === "COMPLETED" && a.agent?.exitCode === 0
  // a check that cannot discriminate still must not get WORSE
  return agentOk && (a.check ? a.check.ok === true : true)
}

/** The winner: a passing attempt with the smallest change; ties → earliest. */
export function pickWinner(attempts, opts) {
  const passing = attempts.filter((a) => attemptPassed(a, opts))
  passing.sort((x, y) => (x.change?.bytes ?? 0) - (y.change?.bytes ?? 0) || x.n - y.n)
  return passing[0] ?? null
}

// ---- the run -------------------------------------------------------------------

/**
 * @param o.cwd         where the task was asked (inside a git repository)
 * @param o.task        the task text
 * @param o.tries       number of attempts (2..TRIES_MAX)
 * @param o.check       check command, or null to detect / fall back
 * @param o.parallel    attempts run at a time (1 = one by one)
 * @param o.dataDir     forge's data folder (attempt patches, logs, summary)
 * @param o.runAttempt  ({ n, cwd, resultFile, logFile }) → { exitCode, timedOut, result }
 * @param o.detectCheck (cwd) → command or ""
 * @param o.onProgress  (event) → void
 */
export async function runTries(o) {
  const tries = Math.max(1, Math.min(TRIES_MAX, Number(o.tries) || 1))
  const say = (ev) => { try { o.onProgress?.(ev) } catch { } }
  const root = await repoRoot(o.cwd)
  if (!root) return { ok: false, reason: "--tries runs each attempt in its own git worktree — this directory is not inside a git repository" }
  const probe = probeGit(root)
  if (!probe.ok) return { ok: false, reason: `--tries needs git worktrees: ${probe.reason}` }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: root })
  if (head.err || !String(head.out).trim()) return { ok: false, reason: "--tries needs at least one commit to start the attempts from" }
  const base = String(head.out).trim()
  const rel = path.relative(root, fs.realpathSync(o.cwd))
  const seed = await readSeed(root)
  if (!seed.ok) return { ok: false, reason: seed.reason }

  const runId = `tries-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  const store = path.join(o.dataDir, "tries", runId)
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })

  // the check: explicit, configured, or the project's own tests
  let check = String(o.check ?? "").trim() || null
  let checkSource = check ? "given" : null
  if (!check) {
    try { const d = String(o.detectCheck?.(o.cwd) ?? "").trim(); if (d) { check = d; checkSource = "detected" } } catch { }
  }

  const atOnce = Math.max(1, Math.min(tries, Number(o.parallel) || 1))
  const summary = {
    schema: TRIES_SCHEMA, runId, task: o.task, tries, parallel: atOnce,
    root, cwd: o.cwd, base, seeded: Boolean(seed.patch.trim() || seed.untracked.length),
    check, checkSource, checkUsable: Boolean(check), baseline: null,
    attempts: [], winner: null, applied: null, store, startedAt: Date.now(), finishedAt: null,
  }
  const writeSummary = () => { try { fs.writeFileSync(path.join(store, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 }) } catch { } }

  const made = []
  const prepare = async (n) => {
    const wt = await createWorktree({ root, nodeId: `try-${n}`, runId })
    if (!wt.ok) return { ok: false, reason: wt.reason }
    made.push(wt.dir)
    const planted = await plantSeed({ root, dir: wt.dir, seed, base, scratch: store })
    if (!planted.ok) return { ok: false, reason: planted.reason, dir: wt.dir }
    return { ok: true, dir: wt.dir, seedSha: planted.sha, cwd: path.join(wt.dir, rel) }
  }

  const attempt = async (n, prepared) => {
    const a = { n, dir: prepared?.dir ?? null, agent: null, check: null, change: null, ms: 0, error: null }
    const t0 = Date.now()
    try {
      if (!prepared?.ok) throw new Error(prepared?.reason ?? "could not prepare the attempt")
      say({ type: "attempt-start", n, tries })
      const ran = await o.runAttempt({ n, cwd: prepared.cwd, resultFile: path.join(store, `attempt-${n}.result.json`), logFile: path.join(store, `attempt-${n}.log`) })
      const r = ran?.result ?? {}
      a.agent = {
        status: ran?.timedOut ? "TIMED_OUT" : (r.status ?? (ran?.exitCode === 0 ? "COMPLETED" : "ERROR")),
        exitCode: ran?.exitCode ?? null, steps: r.steps ?? null, toolCalls: r.toolCalls ?? null,
        usage: r.usage ?? null, costUsd: r.costUsd ?? null, reason: r.reason ?? r.error ?? null,
      }
      a.change = await captureAttempt({ dir: prepared.dir, seedSha: prepared.seedSha, file: path.join(store, `attempt-${n}.patch`) })
      if (!a.change.ok) throw new Error(a.change.reason)
      if (check) a.check = await runCheck(check, { cwd: prepared.cwd })
    } catch (e) { a.error = String(e?.message ?? e).slice(0, 400) }
    a.ms = Date.now() - t0
    summary.attempts.push(a)
    summary.attempts.sort((x, y) => x.n - y.n)
    writeSummary()
    say({ type: "attempt-end", n, tries, attempt: a, passed: attemptPassed(a, { checkUsable: summary.checkUsable }) })
    return a
  }

  try {
    // can the check tell a right answer from a wrong one? Measured on the
    // seed, before anything changed: a check that already passes cannot.
    const first = await prepare(1)
    if (check && first.ok) {
      say({ type: "baseline-start", check })
      summary.baseline = await runCheck(check, { cwd: first.cwd })
      if (summary.baseline.ok) summary.checkUsable = false
      say({ type: "baseline-end", baseline: summary.baseline, usable: summary.checkUsable })
    }
    writeSummary()

    // rounds of `atOnce`; a round with a pass ends the run
    for (let start = 1; start <= tries; start += atOnce) {
      if (o.signal?.aborted) break
      const ns = Array.from({ length: Math.min(atOnce, tries - start + 1) }, (_, i) => start + i)
      const preps = await Promise.all(ns.map((n) => (n === 1 ? first : prepare(n))))
      const round = await Promise.all(ns.map((n, i) => attempt(n, preps[i])))
      if (round.some((a) => attemptPassed(a, { checkUsable: summary.checkUsable }))) break
    }

    const w = pickWinner(summary.attempts, { checkUsable: summary.checkUsable })
    summary.winner = w ? w.n : null
    if (w) {
      if (!w.change?.patchPath) summary.applied = { ok: true, applied: false, files: [], note: "the winning attempt changed nothing" }
      else {
        const m = await mergeBack({ root, patchPath: w.change.patchPath })
        summary.applied = { ok: m.ok, applied: Boolean(m.applied), files: m.files ?? w.change.files, reason: m.reason ?? null, conflicts: m.conflicts ?? [] }
      }
    }
  } finally {
    if (!o.keep) for (const dir of made) { try { await removeWorktree({ root, dir }) } catch { } }
    summary.kept = o.keep ? made : []
    summary.finishedAt = Date.now()
    writeSummary()
  }
  return { ok: true, summary }
}

// ---- reporting -------------------------------------------------------------------

const fmtMs = (ms) => ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`

/** Plain-text report of a tries run. */
export function formatTries(s) {
  if (!s) return ""
  const lines = []
  const by = s.checkUsable ? `check: ${s.check}${s.checkSource === "detected" ? " (your project's tests)" : ""}`
    : s.check ? `check: ${s.check} — it already passed before any attempt, so it cannot tell attempts apart; the agent's own result decided (and the check still had to pass)`
      : "no check found — the agent's own result decided (give one with --check \"<command>\")"
  lines.push(`tries: ${s.attempts.length} of ${s.tries} attempt(s) run${s.parallel > 1 ? `, ${s.parallel} at a time` : ""} • ${by}`)
  if (s.seeded) lines.push("  each attempt started from your working tree, uncommitted changes included")
  for (const a of s.attempts) {
    const passed = attemptPassed(a, { checkUsable: s.checkUsable })
    const mark = a.n === s.winner ? "WINNER" : passed ? "passed" : "failed"
    const what = a.error ? `error: ${a.error}`
      : [`agent ${a.agent?.status ?? "?"}`,
        a.check ? `check ${a.check.ok ? "passed" : a.check.timedOut ? "timed out" : `failed (exit ${a.check.code})`}` : null,
        a.change ? `${a.change.files?.length ?? 0} file(s) changed` : null,
        a.agent?.steps != null ? `${a.agent.steps} step(s)` : null,
        a.agent?.costUsd != null ? `$${a.agent.costUsd.toFixed(4)}` : null,
        fmtMs(a.ms)].filter(Boolean).join(" • ")
    lines.push(`  ${String(a.n).padStart(2)}. ${mark.padEnd(6)}  ${what}`)
  }
  if (s.winner == null) {
    lines.push("no attempt passed — your checkout was not changed")
    const withPatch = s.attempts.filter((a) => a.change?.patchPath)
    if (withPatch.length) lines.push(`  every attempt's change is kept: git apply ${withPatch[0].change.patchPath}`)
  } else if (s.applied?.applied) {
    lines.push(`applied attempt ${s.winner} to your checkout: ${(s.applied.files ?? []).slice(0, 8).join(", ")}${(s.applied.files ?? []).length > 8 ? " …" : ""}`)
  } else if (s.applied && !s.applied.ok) {
    lines.push(`attempt ${s.winner} passed but could NOT be applied — ${s.applied.reason}${s.applied.conflicts?.length ? ` (${s.applied.conflicts.join(", ")})` : ""}`)
    lines.push(`  its change is kept: git apply ${s.attempts.find((a) => a.n === s.winner)?.change?.patchPath}`)
  } else if (s.applied) lines.push(`attempt ${s.winner} passed; ${s.applied.note}`)
  const cost = s.attempts.reduce((t, a) => (a.agent?.costUsd != null && t != null ? t + a.agent.costUsd : null), 0)
  if (cost != null && s.attempts.length) lines.push(`  total cost $${cost.toFixed(4)}`)
  lines.push(`  details: ${path.join(s.store, "summary.json")}`)
  return lines.join("\n")
}
