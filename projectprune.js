/**
 * forge — state for project directories that no longer exist is removed (v174).
 *
 * forge keeps a folder per project under ~/.forge/projects (indexes, lessons,
 * profiles, world model, sessions' project data). Nothing ever removed one: a
 * directory that was deleted left its folder behind for good. A container-per-
 * task harness, /tmp experiments or CI add one per run; one developer home
 * had 5,550 of them (92MB).
 *
 * A folder is removed only when all of this is PROVEN, never guessed:
 *  - it records the directory it belongs to (root.json, or a pre-v174
 *    index.json), and that path hashes to the folder's own name — so the
 *    record is the project's key, not a subdirectory or a copied file;
 *  - that directory is gone, and its PARENT is still there — a project on an
 *    unmounted drive or network share is missing with its whole volume, and
 *    that is not a deletion;
 *  - nothing in the folder was touched for 30 days.
 * A folder that records no provable root is left alone.
 *
 * Runs at most once a day, at the start of a run or chat, synchronously and
 * within a small time budget: a short headless run can exit before background
 * work would finish, and a pass that runs out of budget just continues at the
 * next run (the day's stamp is written only after a complete pass).
 * `forge doctor --prune` shows what would go; `--prune --yes` removes it.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { PROJECTS_DIR, projectDir, ROOT_MARKER } from "./memory.js"

export const PRUNE_AFTER_DAYS = 30
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
export const PRUNE_BUDGET_MS = 150
export const PRUNE_STAMP = path.join(DEFAULT_DIR, "projects-pruned-at")

const DAY_MS = 24 * 60 * 60 * 1000
const keyOf = (root) => crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)

function rootFrom(file, name) {
  try {
    const root = JSON.parse(fs.readFileSync(file, "utf8"))?.root
    if (typeof root === "string" && path.isAbsolute(root) && keyOf(root) === name) return root
  } catch { /* absent or unreadable — not a proof */ }
  return null
}

/** The directory a project folder provably belongs to, or null. */
export function recordedRoot(dir) {
  const name = path.basename(dir)
  const own = rootFrom(path.join(dir, ROOT_MARKER), name)
  if (own) return { root: own, source: ROOT_MARKER }
  // pre-v174 folders: the index records the directory it indexed, which is
  // the key only when it hashes to the folder's name
  const idx = rootFrom(path.join(dir, "index.json"), name)
  return idx ? { root: idx, source: "index.json" } : null
}

/** Newest mtime of the folder and its direct entries (a live project touches
 *  some file in it; nested stores touch their own directory). */
function newestMtime(dir) {
  let newest = 0
  try { newest = fs.lstatSync(dir).mtimeMs } catch { return 0 }
  try {
    for (const e of fs.readdirSync(dir)) {
      try { newest = Math.max(newest, fs.lstatSync(path.join(dir, e)).mtimeMs) } catch { /* raced away */ }
    }
  } catch { /* unreadable — the folder's own mtime stands */ }
  return newest
}

function sizeOf(p, depth = 0) {
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory() || depth > 8) return st.size
    let n = 0
    for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e), depth + 1)
    return n
  } catch { return 0 }
}

/**
 * One pass over the project folders.
 * Returns { checked, complete, removed[], stale[], kept: { live, recent, unknown, volumeGone } }.
 * dryRun lists what would go (with sizes) and removes nothing.
 */
export function pruneProjectState({ now = Date.now(), dryRun = false, projectsDir = PROJECTS_DIR, keep = [], budgetMs = Infinity, afterDays = PRUNE_AFTER_DAYS } = {}) {
  const out = { checked: 0, complete: true, removed: [], stale: [], kept: { live: 0, recent: 0, unknown: 0, volumeGone: 0 } }
  let names = []
  try { names = fs.readdirSync(projectsDir) } catch { return out }
  const keepSet = new Set(keep.filter(Boolean).map((k) => path.resolve(k)))
  const t0 = Date.now()
  for (const name of names) {
    if (Date.now() - t0 > budgetMs) { out.complete = false; break }
    if (!/^[0-9a-f]{12}$/.test(name)) continue
    const dir = path.join(projectsDir, name)
    if (keepSet.has(path.resolve(dir))) continue
    try { if (!fs.lstatSync(dir).isDirectory()) continue } catch { continue }
    out.checked++
    const rec = recordedRoot(dir)
    if (!rec) { out.kept.unknown++; continue }
    if (fs.existsSync(rec.root)) { out.kept.live++; continue }
    if (!fs.existsSync(path.dirname(rec.root))) { out.kept.volumeGone++; continue }
    const ageDays = Math.floor((now - newestMtime(dir)) / DAY_MS)
    if (ageDays < afterDays) { out.kept.recent++; continue }
    const entry = { dir, root: rec.root, ageDays }
    if (dryRun) { entry.bytes = sizeOf(dir); out.stale.push(entry); continue }
    try { fs.rmSync(dir, { recursive: true, force: true }); out.removed.push(entry) } catch { /* in use or read-only — next pass */ }
  }
  return out
}

let started = false
/** Once per process, at most once a day: prune within a small budget. */
export function maybePruneProjectState({ cwd = process.cwd(), now = Date.now(), budgetMs = PRUNE_BUDGET_MS } = {}) {
  if (started) return null
  started = true
  try {
    try { if (now - fs.statSync(PRUNE_STAMP).mtimeMs < PRUNE_EVERY_MS) return null } catch { /* never pruned */ }
    const r = pruneProjectState({ now, keep: [projectDir(cwd)], budgetMs })
    if (r.complete) { try { fs.mkdirSync(DEFAULT_DIR, { recursive: true }); fs.writeFileSync(PRUNE_STAMP, `${new Date(now).toISOString()}\n`) } catch { /* retried next run */ } }
    return r
  } catch { return null } // housekeeping must never break a run
}

/** Test hook: let the once-per-process guard run again. */
export function _resetPruneGuard() { started = false }
