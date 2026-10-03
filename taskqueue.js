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
 *  - Items run ONE AT A TIME. Two agents writing the same checkout at once
 *    would race; parallel items need per-item worktrees (TODO.md).
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
export const ITEM_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  INTERRUPTED: "INTERRUPTED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED", // the child left no result file — it crashed or never started
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
 * Run PENDING items one at a time until none are left (or `max` ran).
 * @param {object}   o
 * @param {string}   [o.file]       queue file (default: this project's)
 * @param {Function} [o.runItem]    (item, { resultFile }) → Promise<{exitCode, signal?, error?}>
 * @param {boolean}  [o.stopOnFail] stop after the first item that did not complete
 * @param {number}   [o.max]        run at most this many items
 * @param {Function} [o.onItem]     ({ phase: "start"|"end", item, position, pending }) progress callback
 * @param {Function} [o.alive]      pid liveness check (tests)
 * @returns {Promise<{ ran: object[], stopped: string|null, refused?: string }>}
 */
export async function runQueue({ file, runItem = spawnAgentItem, stopOnFail = false, max = Infinity, onItem = null, alive = pidAlive, signal = null } = {}) {
  const qf = file ?? queuePath()
  const resultDir = path.join(path.dirname(qf), "queue-results")
  reconcileQueue({ file: qf, alive })
  const claimed = tx(qf, (q) => {
    if (q.runner && q.runner.pid !== process.pid && alive(q.runner.pid)) return { ok: false, why: `another queue runner is already working here (pid ${q.runner.pid})` }
    q.runner = { pid: process.pid, started_at: Date.now() }
    return { ok: true }
  })
  if (!claimed.ok) return { ran: [], stopped: null, refused: claimed.why }
  const ran = []
  let stopped = null
  try {
    while (ran.length < max) {
      if (signal?.aborted) { stopped = "aborted"; break }
      const next = tx(qf, (q) => {
        const i = q.items.findIndex((it) => it.status === ITEM_STATUS.PENDING)
        if (i < 0) return null
        const it = q.items[i]
        Object.assign(it, { status: ITEM_STATUS.RUNNING, started_at: Date.now(), runner_pid: process.pid })
        return { item: { ...it }, position: i + 1, pending: q.items.filter((x) => x.status === ITEM_STATUS.PENDING).length }
      })
      if (!next) break
      onItem?.({ phase: "start", ...next })
      fs.mkdirSync(resultDir, { recursive: true, mode: 0o700 })
      const resultFile = path.join(resultDir, `${next.item.id}.json`)
      try { fs.rmSync(resultFile, { force: true }) } catch {}
      let exit
      try { exit = await runItem(next.item, { resultFile }) } catch (e) { exit = { exitCode: null, error: String(e?.message ?? e) } }
      const r = readResult(resultFile)
      const status = r?.status && r.status !== "RUNNING" ? String(r.status) : ITEM_STATUS.FAILED
      const result = r
        ? { status, reason: r.reason ?? null, error: r.error ?? null, exitCode: r.exitCode ?? exit?.exitCode ?? null, elapsedMs: r.elapsedMs ?? null, steps: r.steps ?? null, toolCalls: r.toolCalls ?? null, wrote: Boolean(r.wrote), provider: r.provider ?? null, model: r.model ?? null }
        : { status, reason: exit?.signal ? `signal ${exit.signal}` : null, error: exit?.error ?? `no result file (exit ${exit?.exitCode ?? "?"})`, exitCode: exit?.exitCode ?? null }
      const done = tx(qf, (q) => {
        const it = q.items.find((x) => x.id === next.item.id)
        if (!it) return null // removed while running — nothing to record into
        Object.assign(it, { status, finished_at: Date.now(), result, runner_pid: undefined })
        return { ...it }
      })
      const finished = done ?? { ...next.item, status, result }
      ran.push(finished)
      onItem?.({ phase: "end", item: finished, position: next.position })
      if (status === "ABORTED" || exit?.signal === "SIGINT" || exit?.signal === "SIGTERM") { stopped = "aborted"; break }
      if (stopOnFail && !okStatus(status)) { stopped = `stopped after ${status} (--stop-on-fail)`; break }
    }
  } finally {
    try { tx(qf, (q) => { if (q.runner?.pid === process.pid) q.runner = null }) } catch {}
  }
  return { ran, stopped }
}
