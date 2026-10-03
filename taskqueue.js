/**
 * forge — task queue (zero dependencies)
 *
 * forge works on one task per run. Before this module, giving it five tasks
 * meant five commands typed one after another, each waited on. The queue
 * lets you line tasks up and have them run back to back, unattended:
 *
 *   forge queue add "fix the login bug"
 *   forge queue add --single "update the README"
 *   forge queue run            # runs every PENDING item, oldest first
 *
 * Design:
 *  - One queue per project (projectDir(cwd)/queue.json), so tasks run in the
 *    directory they were queued for.
 *  - Every read-modify-write goes through withStateFileLock, so `queue add`
 *    from another terminal while `queue run` is going is safe — the runner
 *    re-reads the file before each item and picks the new one up.
 *  - Each item runs as its own `forge agent … --result-json <file>` child
 *    process. The queue reuses the whole agent path (run-mode choice,
 *    verification, checkpoints) and judges the item by the result file the
 *    agent writes — never by guessing from output.
 *  - Items run ONE AT A TIME in your checkout by default. `--parallel N`
 *    (Phase 5) runs N at once, each in its own git worktree, merging back
 *    through one serialized lane — see worktreeIsolation below.
 *  - Only one runner per project: a second `queue run` is refused while the
 *    first runner's process is alive.
 *  - A RUNNING item whose runner died is marked INTERRUPTED, never silently
 *    re-run: half of its work may already be on disk. `forge queue retry`
 *    puts it back, and `forge tasks --resume` can continue the agent's task.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { projectDir } from "./memory.js"
import { writeStateFile, withStateFileLock } from "./securefs.js"
import { pidAlive } from "./runlog.js"

export const QUEUE_SCHEMA = 1
export const MAX_QUEUE_ITEMS = 200
export const MAX_PARALLEL = 8
export const ITEM_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  INTERRUPTED: "INTERRUPTED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED", // the child left no result file — it crashed or never started
  CONFLICT: "CONFLICT", // --parallel: the item's changes could not be merged back (patch kept)
  // anything else is the agent's own result status: COMPLETED,
  // COMPLETED_UNVERIFIED, INCOMPLETE, WAITING, ERROR, ABORTED …
})
const OPEN = new Set([ITEM_STATUS.PENDING, ITEM_STATUS.RUNNING])
const MODES = new Set(["auto", "single", "meta"])

const here = path.dirname(fileURLToPath(import.meta.url))

export function queuePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "queue.json")
}

function empty() { return { schema: QUEUE_SCHEMA, runner: null, items: [] } }

function readRaw(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    if (j && Array.isArray(j.items)) return { ...empty(), ...j }
  } catch {}
  return empty()
}

/** Read-modify-write under the state lock. `fn(q)` mutates q and returns a value. */
function tx(file, fn) {
  return withStateFileLock(file, () => {
    const q = readRaw(file)
    const out = fn(q)
    writeStateFile(file, JSON.stringify(q, null, 1), { mode: 0o600 })
    return out
  })
}

export function readQueue({ file } = {}) {
  return readRaw(file ?? queuePath())
}

/** Resolve "3" (1-based position) or an id / id prefix to an item index. */
export function findItem(q, ref) {
  const r = String(ref ?? "").trim()
  if (!r) return -1
  if (/^\d+$/.test(r)) {
    const i = Number(r) - 1
    return i >= 0 && i < q.items.length ? i : -1
  }
  const hits = q.items.map((it, i) => (it.id === r || it.id.startsWith(r) ? i : -1)).filter((i) => i >= 0)
  return hits.length === 1 ? hits[0] : -1
}

export function addItem(task, { file, mode = "auto" } = {}) {
  const t = String(task ?? "").trim()
  if (!t) throw new Error("queue add needs a task")
  if (!MODES.has(mode)) throw new Error(`unknown mode "${mode}" — use auto, single or meta`)
  return tx(file ?? queuePath(), (q) => {
    if (q.items.filter((it) => OPEN.has(it.status)).length >= MAX_QUEUE_ITEMS) throw new Error(`the queue already holds ${MAX_QUEUE_ITEMS} open items`)
    const item = { id: crypto.randomBytes(4).toString("hex"), task: t.slice(0, 4000), mode, status: ITEM_STATUS.PENDING, added_at: Date.now(), started_at: null, finished_at: null, result: null, note: null }
    q.items.push(item)
    // keep the file bounded: drop the oldest FINISHED items first
    while (q.items.length > MAX_QUEUE_ITEMS) {
      const i = q.items.findIndex((it) => !OPEN.has(it.status))
      if (i < 0) break
      q.items.splice(i, 1)
    }
    return { ...item, position: q.items.indexOf(item) + 1 }
  })
}

export function removeItem(ref, { file } = {}) {
  return tx(file ?? queuePath(), (q) => {
    const i = findItem(q, ref)
    if (i < 0) return { ok: false, why: `no queue item matches "${ref}"` }
    if (q.items[i].status === ITEM_STATUS.RUNNING) return { ok: false, why: "that item is running — stop the runner (Ctrl+C) first" }
    const [it] = q.items.splice(i, 1)
    return { ok: true, item: it }
  })
}

export function retryItem(ref, { file } = {}) {
  return tx(file ?? queuePath(), (q) => {
    const i = findItem(q, ref)
    if (i < 0) return { ok: false, why: `no queue item matches "${ref}"` }
    const it = q.items[i]
    if (OPEN.has(it.status)) return { ok: false, why: `that item is already ${it.status}` }
    Object.assign(it, { status: ITEM_STATUS.PENDING, started_at: null, finished_at: null, note: `retry of ${it.result?.status ?? it.status}`, result: null })
    return { ok: true, item: it }
  })
}

/** Remove finished items (default) or every item that is not running (all). */
export function clearQueue({ file, all = false } = {}) {
  return tx(file ?? queuePath(), (q) => {
    const before = q.items.length
    q.items = q.items.filter((it) => it.status === ITEM_STATUS.RUNNING || (!all && it.status === ITEM_STATUS.PENDING))
    return { removed: before - q.items.length }
  })
}

/** RUNNING items whose runner process is gone → INTERRUPTED. Returns how many. */
export function reconcileQueue({ file, alive = pidAlive } = {}) {
  return tx(file ?? queuePath(), (q) => {
    let n = 0
    for (const it of q.items) {
      if (it.status === ITEM_STATUS.RUNNING && !alive(it.runner_pid)) {
        Object.assign(it, { status: ITEM_STATUS.INTERRUPTED, finished_at: Date.now(), note: "the runner stopped while this was running — part of its work may be on disk; `forge queue retry` re-runs it" })
        n++
      }
    }
    if (q.runner && !alive(q.runner.pid)) q.runner = null
    return n
  })
}

/** Default item runner: a `forge agent` child that writes a result file. */
export function spawnAgentItem(item, { cwd = process.cwd(), resultFile, forgeJs = path.join(here, "forge-boot.js"), stdio = "inherit", env = process.env } = {}) {
  const args = [forgeJs, "agent"]
  if (item.mode === "single") args.push("--single")
  if (item.mode === "meta") args.push("--auto")
  args.push("--result-json", resultFile, item.task)
  return new Promise((resolve) => {
    let child
    try { child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", stdio, stdio] }) }
    catch (e) { resolve({ exitCode: null, error: String(e?.message ?? e) }); return }
    child.on("error", (e) => resolve({ exitCode: null, error: String(e?.message ?? e) }))
    child.on("exit", (code, signal) => resolve({ exitCode: code, signal }))
  })
}

function readResult(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

const okStatus = (s) => s === "COMPLETED" || s === "COMPLETED_UNVERIFIED"

/**
 * Phase 5 — run queue items in parallel, each in its own git worktree.
 *
 * Two agents writing one checkout at once would race, so a parallel item
 * never touches your checkout while it runs: it gets a `git worktree` of
 * HEAD, works there, and its changes come back as one patch through a
 * SERIALIZED merge lane (worktree.js mergeBack: checked first, 3-way if
 * needed, never half-applied). Rules:
 *  - refused unless the project is a git repo with commits and NO uncommitted
 *    changes (outside .forge): a worktree of HEAD cannot see them, and its
 *    patch could fight them
 *  - a COMPLETED / COMPLETED_UNVERIFIED item is merged; any other status
 *    keeps its patch (result.merge.patch) and is NOT merged — apply it
 *    yourself with `git apply <patch>` if you want it
 *  - a patch that does not apply is CONFLICT, with the files and the patch
 *  - the worktree is always removed afterwards
 */
export function worktreeIsolation({ root = process.cwd(), wt = null } = {}) {
  let W = wt
  const mod = async () => (W ??= await import("./worktree.js"))
  let lane = Promise.resolve()
  const serial = (fn) => { const run = lane.then(fn, fn); lane = run.catch(() => {}); return run }
  return {
    async check() {
      const w = await mod()
      const avail = w.isolationAvailable({ root })
      if (!avail.ok) return { ok: false, reason: `--parallel needs a git repository with commits (${avail.reason})` }
      const head = await w.runGit(["rev-parse", "HEAD"], { cwd: root })
      if (head.err || !String(head.out).trim()) return { ok: false, reason: "--parallel needs at least one commit (each item works on a worktree of HEAD)" }
      const dirty = await w.uncommittedFiles(root)
      if (dirty === null) return { ok: false, reason: "--parallel could not read git status" }
      if (dirty.size) return { ok: false, reason: `--parallel needs a clean checkout — ${dirty.size} uncommitted file(s) (${[...dirty].slice(0, 3).join(", ")}${dirty.size > 3 ? ", …" : ""}). Commit or stash them, or run without --parallel` }
      return { ok: true }
    },
    async prepare(item) {
      const w = await mod()
      const made = await w.createWorktree({ root, nodeId: `q-${item.id}`, runId: "queue" })
      if (!made.ok) throw new Error(`could not create a worktree: ${made.reason}`)
      return { cwd: made.dir }
    },
    async finish(item, prep, status) {
      const w = await mod()
      try {
        const cap = await w.captureChanges({ root, dir: prep.cwd, nodeId: `q-${item.id}` })
        if (!cap.ok) return { merge: "failed", reason: cap.reason }
        if (cap.clean || !cap.patchPath) return { merge: "nothing", files: [] }
        if (!okStatus(status)) return { merge: "held", patch: cap.patchPath, files: cap.files, reason: `the task ended ${status} — its changes were kept as a patch, not merged` }
        const m = await serial(() => w.mergeBack({ root, patchPath: cap.patchPath }))
        if (m.ok) return { merge: "merged", files: m.files ?? cap.files }
        return { merge: "conflict", patch: cap.patchPath, files: cap.files, conflicts: m.conflicts ?? [], reason: m.reason }
      } finally {
        await w.removeWorktree({ root, dir: prep.cwd })
      }
    },
  }
}

/**
 * Run PENDING items until none are left (or `max` ran) — one at a time, or
 * `parallel` at once in worktrees (worktreeIsolation).
 * @param {object}   o
 * @param {string}   [o.file]       queue file (default: this project's)
 * @param {Function} [o.runItem]    (item, { resultFile, cwd }) → Promise<{exitCode, signal?, error?}>
 * @param {boolean}  [o.stopOnFail] stop starting items after the first one that did not complete
 * @param {number}   [o.max]        run at most this many items
 * @param {number}   [o.parallel]   items at once (1 = in your checkout, as before; 2–8 = worktrees)
 * @param {object}   [o.isolation]  { check, prepare, finish } (tests); default worktreeIsolation
 * @param {string}   [o.root]       the project checkout (default process.cwd())
 * @param {Function} [o.onItem]     ({ phase: "start"|"end", item, position, pending }) progress callback
 * @param {Function} [o.alive]      pid liveness check (tests)
 * @returns {Promise<{ ran: object[], stopped: string|null, refused?: string, parallel: number }>}
 */
export async function runQueue({ file, runItem = spawnAgentItem, stopOnFail = false, max = Infinity, parallel = 1, isolation = null, root = process.cwd(), onItem = null, alive = pidAlive, signal = null } = {}) {
  const qf = file ?? queuePath()
  const resultDir = path.join(path.dirname(qf), "queue-results")
  const width = Math.max(1, Math.min(MAX_PARALLEL, Math.floor(Number(parallel) || 1)))
  const iso = width > 1 ? (isolation ?? worktreeIsolation({ root })) : null
  if (iso) {
    const ok = await iso.check()
    if (!ok.ok) return { ran: [], stopped: null, refused: ok.reason, parallel: width }
  }
  reconcileQueue({ file: qf, alive })
  const claimed = tx(qf, (q) => {
    if (q.runner && q.runner.pid !== process.pid && alive(q.runner.pid)) return { ok: false, why: `another queue runner is already working here (pid ${q.runner.pid})` }
    q.runner = { pid: process.pid, started_at: Date.now(), parallel: width }
    return { ok: true }
  })
  if (!claimed.ok) return { ran: [], stopped: null, refused: claimed.why, parallel: width }
  const ran = []
  let stopped = null
  let launched = 0

  const claimNext = () => tx(qf, (q) => {
    const i = q.items.findIndex((it) => it.status === ITEM_STATUS.PENDING)
    if (i < 0) return null
    const it = q.items[i]
    Object.assign(it, { status: ITEM_STATUS.RUNNING, started_at: Date.now(), runner_pid: process.pid })
    return { item: { ...it }, position: i + 1, pending: q.items.filter((x) => x.status === ITEM_STATUS.PENDING).length }
  })

  const runOne = async (next) => {
    onItem?.({ phase: "start", ...next })
    fs.mkdirSync(resultDir, { recursive: true, mode: 0o700 })
    const resultFile = path.join(resultDir, `${next.item.id}.json`)
    try { fs.rmSync(resultFile, { force: true }) } catch {}
    let exit, prep = null, merge = null
    try {
      if (iso) prep = await iso.prepare(next.item)
      exit = await runItem(next.item, { resultFile, ...(prep?.cwd ? { cwd: prep.cwd } : {}) })
    } catch (e) { exit = { exitCode: null, error: String(e?.message ?? e) } }
    const r = readResult(resultFile)
    let status = r?.status && r.status !== "RUNNING" ? String(r.status) : ITEM_STATUS.FAILED
    const result = r
      ? { status, reason: r.reason ?? null, error: r.error ?? null, exitCode: r.exitCode ?? exit?.exitCode ?? null, elapsedMs: r.elapsedMs ?? null, steps: r.steps ?? null, toolCalls: r.toolCalls ?? null, wrote: Boolean(r.wrote), provider: r.provider ?? null, model: r.model ?? null }
      : { status, reason: exit?.signal ? `signal ${exit.signal}` : null, error: exit?.error ?? `no result file (exit ${exit?.exitCode ?? "?"})`, exitCode: exit?.exitCode ?? null }
    if (iso && prep) {
      try { merge = await iso.finish(next.item, prep, status) } catch (e) { merge = { merge: "failed", reason: String(e?.message ?? e).slice(0, 200) } }
      result.merge = merge
      if (merge.merge === "conflict" || merge.merge === "failed") status = ITEM_STATUS.CONFLICT
    }
    const note = merge?.merge === "conflict" ? `changes did not merge (${(merge.conflicts ?? []).slice(0, 3).join(", ") || "conflict"}) — patch kept: ${merge.patch}`
      : merge?.merge === "held" ? `not merged (${result.status}) — patch kept: ${merge.patch}`
      : merge?.merge === "failed" ? `merge failed: ${merge.reason}` : null
    const done = tx(qf, (q) => {
      const it = q.items.find((x) => x.id === next.item.id)
      if (!it) return null // removed while running — nothing to record into
      Object.assign(it, { status, finished_at: Date.now(), result, runner_pid: undefined, note: note ?? it.note })
      return { ...it }
    })
    const finished = done ?? { ...next.item, status, result }
    ran.push(finished)
    onItem?.({ phase: "end", item: finished, position: next.position })
    if (status === "ABORTED" || exit?.signal === "SIGINT" || exit?.signal === "SIGTERM") stopped ??= "aborted"
    else if (stopOnFail && !okStatus(status)) stopped ??= `stopped after ${status} (--stop-on-fail)`
  }

  const lane = async () => {
    while (!stopped && launched < max) {
      if (signal?.aborted) { stopped ??= "aborted"; return }
      const next = claimNext()
      if (!next) return
      launched++
      await runOne(next)
    }
  }
  try {
    await Promise.all(Array.from({ length: width }, lane))
  } finally {
    try { tx(qf, (q) => { if (q.runner?.pid === process.pid) q.runner = null }) } catch {}
  }
  return { ran, stopped, parallel: width }
}
