#!/usr/bin/env node
// v174 — state for project directories that no longer exist is removed.
//
// forge keeps a folder per project under ~/.forge/projects and never removed
// one: every directory forge ever ran in left a folder behind for good (one
// developer home: 5,550 folders, 92MB). A folder now goes only when it is
// PROVEN stale: it records its directory (and that path hashes to the
// folder's name), the directory is gone while its parent is still there, and
// nothing in it was touched for 30 days.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-"))
process.env.FORGE_HOME = HOME
const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forge.js")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const M = await import("../memory.js")
const R = await import("../projectprune.js")

const DAY = 24 * 3600 * 1000
const key = (root) => crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-work-"))
const PROJECTS = M.PROJECTS_DIR

/** A project folder for `root`, recorded in `file`, last touched `ageDays` ago. */
function fakeProject(root, { ageDays = 40, file = "root.json", recorded = root, name = key(root) } = {}) {
  const dir = path.join(PROJECTS, name)
  fs.mkdirSync(dir, { recursive: true })
  if (file) fs.writeFileSync(path.join(dir, file), JSON.stringify({ root: recorded }))
  fs.writeFileSync(path.join(dir, "lessons.json"), "[]")
  const t = (Date.now() - ageDays * DAY) / 1000
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t)
  fs.utimesSync(dir, t, t)
  return dir
}
const exists = (p) => fs.existsSync(p)
const reset = () => fs.rmSync(PROJECTS, { recursive: true, force: true })

console.log("== 1. a folder's directory is trusted only when it is proven ==")
{
  reset()
  const gone = path.join(WORK, "gone-a")
  const d1 = fakeProject(gone)
  ok("root.json that hashes to the folder's name is a proof", R.recordedRoot(d1)?.root === gone, JSON.stringify(R.recordedRoot(d1)))
  const d2 = fakeProject(path.join(WORK, "gone-b"), { name: "aaaaaaaaaaaa" })
  ok("a root that does not hash to the folder's name is not", R.recordedRoot(d2) === null)
  const d3 = fakeProject("relative/dir", { name: key("relative/dir") })
  ok("a relative path is not", R.recordedRoot(d3) === null)
  const legacyRoot = path.join(WORK, "gone-c")
  const d4 = fakeProject(legacyRoot, { file: "index.json" })
  ok("a pre-v174 index.json root that is the key is a proof", R.recordedRoot(d4)?.source === "index.json")
  // an index of a SUBDIRECTORY: the project may be alive while src/ is gone
  const d5 = fakeProject(path.join(WORK, "proj"), { file: "index.json", recorded: path.join(WORK, "proj", "src") })
  ok("an index of a subdirectory is not (the project may be alive)", R.recordedRoot(d5) === null)
  const d6 = fakeProject(path.join(WORK, "gone-d"), { file: null })
  ok("a folder that records nothing is not", R.recordedRoot(d6) === null)
}

console.log("== 2. only a proven-stale folder is removed ==")
{
  reset()
  const live = path.join(WORK, "live"); fs.mkdirSync(live, { recursive: true })
  const dGone = fakeProject(path.join(WORK, "gone-1"))
  const dLive = fakeProject(live)
  const dRecent = fakeProject(path.join(WORK, "gone-2"), { ageDays: 5 })
  const dVolume = fakeProject(path.join(WORK, "unmounted-drive", "proj"))
  const dUnknown = fakeProject(path.join(WORK, "gone-3"), { file: null })
  const dKeep = fakeProject(path.join(WORK, "gone-4"))
  const odd = path.join(PROJECTS, "not-a-project"); fs.mkdirSync(odd)
  const r = R.pruneProjectState({ keep: [dKeep] })
  ok("a gone directory's 40-day-old folder is removed", !exists(dGone) && r.removed.length === 1, JSON.stringify(r.removed))
  ok("…the removal names the directory", r.removed[0]?.root === path.join(WORK, "gone-1"))
  ok("a live directory's folder is kept, however old", exists(dLive) && r.kept.live === 1)
  ok("a folder touched 5 days ago is kept", exists(dRecent) && r.kept.recent === 1)
  ok("a directory missing with its parent (unmounted drive) is kept", exists(dVolume) && r.kept.volumeGone === 1)
  ok("a folder without a provable directory is kept", exists(dUnknown) && r.kept.unknown === 1)
  ok("the current project is never removed", exists(dKeep))
  ok("a folder that is not a project key is not touched", exists(odd))
  // a live project whose store has one fresh file but an old folder
  const dFresh = fakeProject(path.join(WORK, "gone-5"))
  // rewriting an existing file moves only its own mtime, not the folder's
  fs.appendFileSync(path.join(dFresh, "lessons.json"), "\n")
  ok("(the folder's own mtime is still 40 days old)", Date.now() - fs.statSync(dFresh).mtimeMs > 30 * DAY)
  R.pruneProjectState({})
  ok("one file touched recently keeps the folder", exists(dFresh))
}

console.log("== 3. a dry run lists, with sizes, and removes nothing ==")
{
  reset()
  const d = fakeProject(path.join(WORK, "gone-dry"))
  const r = R.pruneProjectState({ dryRun: true })
  ok("the stale folder is listed", r.stale.length === 1 && r.stale[0].root === path.join(WORK, "gone-dry"))
  ok("…with its size", r.stale[0]?.bytes > 0, JSON.stringify(r.stale[0]))
  ok("…and is still there", exists(d) && r.removed.length === 0)
}

console.log("== 4. once a day, bounded, and the stamp only after a complete pass ==")
{
  reset()
  try { fs.rmSync(R.PRUNE_STAMP) } catch {}
  const d = fakeProject(path.join(WORK, "gone-daily"))
  const partial = R.pruneProjectState({ budgetMs: -1 })
  ok("a pass out of budget says it is incomplete and removes nothing", partial.complete === false && exists(d))
  R._resetPruneGuard()
  const r1 = R.maybePruneProjectState({ cwd: WORK })
  ok("the first run of the day prunes", r1?.removed.length === 1 && !exists(d), JSON.stringify(r1))
  ok("…and writes the day's stamp", exists(R.PRUNE_STAMP))
  const d2 = fakeProject(path.join(WORK, "gone-daily-2"))
  ok("a second call in the same process does nothing", R.maybePruneProjectState({ cwd: WORK }) === null && exists(d2))
  R._resetPruneGuard()
  ok("another process the same day does nothing", R.maybePruneProjectState({ cwd: WORK }) === null && exists(d2))
  const t = (Date.now() - 2 * DAY) / 1000; fs.utimesSync(R.PRUNE_STAMP, t, t)
  R._resetPruneGuard()
  const r3 = R.maybePruneProjectState({ cwd: WORK })
  ok("a day later it prunes again", r3?.removed.length === 1 && !exists(d2))
  // a pass that runs out of budget leaves the stamp alone, so the next run continues
  fs.rmSync(R.PRUNE_STAMP)
  fakeProject(path.join(WORK, "gone-daily-3"))
  R._resetPruneGuard()
  R.maybePruneProjectState({ cwd: WORK, budgetMs: -1 })
  ok("an incomplete pass writes no stamp", !exists(R.PRUNE_STAMP))
}

console.log("== 5. every project folder records its directory ==")
{
  reset()
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-proj-"))
  fs.mkdirSync(path.join(proj, ".git"))
  const sub = path.join(proj, "src"); fs.mkdirSync(sub)
  const dir = M.projectDir(sub)
  ok("asking for a project's path does not create its store", !exists(dir))
  fs.mkdirSync(dir, { recursive: true })
  M.projectDir(sub)
  const rec = JSON.parse(fs.readFileSync(path.join(dir, M.ROOT_MARKER), "utf8"))
  ok("once the store exists, root.json records the PROJECT root (not the subdirectory)", rec.root === proj, JSON.stringify(rec))
  ok("…and it is a proof for the pruner", R.recordedRoot(dir)?.root === proj)
  fs.rmSync(proj, { recursive: true, force: true })
}

console.log("== 6. forge doctor --prune shows, --prune --yes removes ==")
{
  reset()
  const d = fakeProject(path.join(WORK, "gone-doctor"))
  const env = { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }
  const dry = spawnSync(process.execPath, [FORGE, "doctor", "--prune"], { env, cwd: WORK, encoding: "utf8", timeout: 60000 })
  const dryLine = (dry.stdout.split("\n").find((l) => l.includes("projects:")) ?? "")
  ok("doctor --prune lists the stale folder", /1 for directories gone 30\+ days/.test(dryLine) && dry.stdout.includes("gone-doctor"), dryLine)
  ok("…says how to remove it, and removes nothing", dry.stdout.includes("forge doctor --prune --yes") && exists(d))
  const yes = spawnSync(process.execPath, [FORGE, "doctor", "--prune", "--yes"], { env, cwd: WORK, encoding: "utf8", timeout: 60000 })
  ok("doctor --prune --yes removes it", !exists(d) && /1 removed/.test(yes.stdout), (yes.stdout.split("\n").find((l) => l.includes("projects:")) ?? "") + yes.stderr.slice(0, 200))
}

try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
console.log(`== prune-state suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
