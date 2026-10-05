/**
 * forge — move an older forge's data out of ~/.forge into forge's own folder
 * (`forge data migrate`, loaded only by that command).
 *
 * Before datadir.js, forge kept everything in ~/.forge. This copies it into
 * the current data folder and moves the provider API keys into the keys file:
 *
 *   - every file is COPIED; nothing already in the new folder is overwritten
 *     (a file that exists there with different bytes is a conflict, listed)
 *   - config.json: its API keys go to the keys file (a key already there
 *     wins); the rest becomes the new config.json if there is none yet
 *   - runtime/ and compile-cache/ are rebuildable caches: not copied
 *   - symlinks are not followed and not copied (listed)
 *   - with removeOld, ~/.forge is deleted ONLY when every file is verified
 *     copied (same bytes at the destination) and there are no conflicts;
 *     otherwise nothing is deleted and the report says why
 */
import fs from "node:fs"
import path from "node:path"
import { collectKeys, withoutKeys, readKeysFile, keysFileBody } from "./datadir.js"
import { writeStateFile } from "./securefs.js"

const CACHES = new Set(["runtime", "compile-cache"])

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b)
    if (sa.size !== sb.size) return false
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch { return false }
}

function walk(dir, rel = "", out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name
    if (!rel && CACHES.has(e.name)) { out.push({ rel: r, kind: "cache" }); continue }
    if (e.isSymbolicLink()) out.push({ rel: r, kind: "symlink" })
    else if (e.isDirectory()) walk(dir, r, out)
    else if (e.isFile()) out.push({ rel: r, kind: "file" })
  }
  return out
}

/**
 * Copy `from` into `to`. Returns what happened; throws only when `from`
 * cannot be read at all.
 */
export function migrateLegacyData({ from, to, keysFile = null, removeOld = false } = {}) {
  const r = { from, to, keysFile, copied: [], existing: [], conflicts: [], skipped: [], keysMoved: 0, keysKept: 0, configWritten: false, removed: false, why: null }
  if (!from || !to || path.resolve(from) === path.resolve(to)) { r.why = "the old and new folders are the same"; return r }
  if (!fs.existsSync(from)) { r.why = `nothing to migrate: ${from} does not exist`; return r }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })

  for (const item of walk(from)) {
    const src = path.join(from, item.rel), dst = path.join(to, item.rel)
    if (item.kind !== "file") { r.skipped.push(`${item.rel} (${item.kind})`); continue }
    if (item.rel === "config.json") {
      let cfg = null
      try { cfg = JSON.parse(fs.readFileSync(src, "utf8")) } catch { r.conflicts.push("config.json (not valid JSON — left in place)"); continue }
      if (keysFile) {
        const keys = collectKeys(cfg)
        const have = readKeysFile(keysFile).keys
        const merged = { ...have }
        for (const [p, v] of Object.entries(keys)) { if (have[p]) r.keysKept++; else { merged[p] = v; r.keysMoved++ } }
        if (r.keysMoved) { fs.mkdirSync(path.dirname(keysFile), { recursive: true, mode: 0o700 }); writeStateFile(keysFile, keysFileBody(merged)) }
        cfg = withoutKeys(cfg)
      }
      if (fs.existsSync(dst)) r.existing.push("config.json (the new folder already has one; its settings were kept)")
      else { writeStateFile(dst, JSON.stringify(cfg, null, 2) + "\n"); r.configWritten = true; r.copied.push("config.json") }
      continue
    }
    if (fs.existsSync(dst)) {
      if (sameBytes(src, dst)) r.existing.push(item.rel)
      else r.conflicts.push(item.rel)
      continue
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)
    try { fs.chmodSync(dst, fs.statSync(src).mode & 0o777) } catch { /* best effort */ }
    if (!sameBytes(src, dst)) { r.conflicts.push(`${item.rel} (copy did not verify)`); continue }
    r.copied.push(item.rel)
  }

  if (removeOld) {
    const blockers = r.conflicts.length ? `${r.conflicts.length} conflict(s)` : r.skipped.some((x) => / \(symlink\)$/.test(x)) ? "symlinks that were not copied" : null
    if (blockers) r.why = `${from} was NOT removed: ${blockers} — resolve them, then run again`
    else { fs.rmSync(from, { recursive: true, force: true }); r.removed = true }
  }
  return r
}

export function formatMigration(r) {
  const out = []
  if (r.why && !r.copied.length && !r.existing.length && !r.conflicts.length) return r.why
  out.push(`migrated ${r.from} → ${r.to}`)
  out.push(`  copied     ${r.copied.length} file(s)`)
  if (r.existing.length) out.push(`  already    ${r.existing.length} identical or kept in the new folder`)
  if (r.keysFile) out.push(`  api keys   ${r.keysMoved} moved to ${r.keysFile}${r.keysKept ? ` (${r.keysKept} already there, kept)` : ""}`)
  if (r.skipped.length) out.push(`  skipped    ${r.skipped.join(", ")}`)
  for (const c of r.conflicts.slice(0, 20)) out.push(`  conflict   ${c}`)
  if (r.removed) out.push(`  removed    ${r.from}`)
  else if (r.why) out.push(`  ${r.why}`)
  else out.push(`  ${r.from} is still there — remove it with: forge data migrate --remove-old`)
  return out.join("\n")
}
