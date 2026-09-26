/**
 * forge — hierarchical memory (v20 tiers, v21.1 storage pipeline + provenance).
 *
 *   GLOBAL  ~/.forge/memory.md                     user preferences, durable facts
 *   PROJECT ~/.forge/projects/<hash>/memory.md     per-project notes + learned fixes
 *   TASK    the session file itself (messages + rolling summary)
 *
 * v19 dumped up to 2000 chars of the global file into EVERY system prompt.
 * v20 retrieves by relevance instead: lines are scored against the current
 * query (task / user message) and only the top matches are injected, from
 * BOTH tiers, deduplicated, capped. Writes go through secret redaction so
 * credentials never land in long-term memory.
 *
 * v21.1: ONE storage pipeline. Every mutation (append / learn / forget / prune
 * / replace) goes through `writeMemoryFile`: the file's real path is resolved
 * (a user's symlinked memory.md keeps working), the new content is written to
 * a temp file next to it, fsynced and renamed into place, mode 0600. A crash
 * or a concurrent writer can no longer leave a half-written or interleaved
 * memory file; the last complete write wins as a unit. Every entry also
 * carries PROVENANCE — who stored it (cli / tool / agent / …), when, and from
 * which run — on a comment line directly above it:
 *
 *   <!-- forge: source=tool at=2026-09-07T10:00:00.000Z run=r-abc -->
 *   - prefer tabs
 *
 * Comment lines are never injected into prompts and never scored; they travel
 * with their entry through forget / prune, and files written by older
 * versions (no comments) read exactly as before.
 *
 * Everything here is best-effort: a broken memory can never break the CLI.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { DEFAULT_DIR } from "./config.js"
import { redact } from "./secrets.js"
import { rankDocs, rankDocsHybrid } from "./retrieval.js"
import { entryIsStale, worldFromCwd } from "./memgraph.js"
import { projectRoot, legacyKeyInput } from "./projectkey.js"

export const GLOBAL_MEMORY_PATH = path.join(DEFAULT_DIR, "memory.md")
export const PROJECTS_DIR = path.join(DEFAULT_DIR, "projects")

/**
 * v108 rootwise — the key is the PROJECT, not the directory you happened to be
 * standing in. Before this, `projectHash("/repo") !== projectHash("/repo/src")`,
 * so `cd src` gave forge a brand-new empty project: no memory, no sessions, no
 * open tasks (reproduced, all three). Someone who always launched from the
 * repository root is unaffected — the root of a root is the root, so their key
 * is byte-identical and nothing moves.
 */
export function projectHash(cwd) {
  return crypto.createHash("sha1").update(projectRoot(cwd)).digest("hex").slice(0, 12)
}

/** The key this directory WOULD have had before v108. Read-only: used to adopt
 *  a store written by an older forge, never to write a new one. */
export function legacyProjectDir(cwd) {
  const legacy = crypto.createHash("sha1").update(legacyKeyInput(cwd)).digest("hex").slice(0, 12)
  return path.join(PROJECTS_DIR, legacy)
}

export function projectDir(cwd) {
  const dir = path.join(PROJECTS_DIR, projectHash(cwd))
  adoptLegacyStore(cwd, dir)
  markProjectRoot(cwd, dir)
  return dir
}

/**
 * v174: every project folder records the directory it belongs to, so state
 * for a directory that was deleted can be told apart and pruned
 * (projectprune.js) — proven by the path hashing to the folder's name, never
 * guessed. Written once, only into a folder that already exists: asking for a
 * project's path must not create its store.
 */
export const ROOT_MARKER = "root.json"
const marked = new Set()
function markProjectRoot(cwd, dir) {
  if (marked.has(dir)) return
  try {
    if (!fs.existsSync(dir)) return
    marked.add(dir)
    const file = path.join(dir, ROOT_MARKER)
    if (fs.existsSync(file)) return
    fs.writeFileSync(file, JSON.stringify({ root: projectRoot(cwd) }) + "\n", { mode: 0o600 })
  } catch { /* best-effort: an unmarked folder is only ever kept, never pruned */ }
}

/**
 * One-time, non-destructive adoption of a pre-v108 store.
 *
 * Only when the new project dir does NOT exist and the legacy one does, and
 * only when they differ — i.e. exactly the subdirectory-launch case the key
 * change fixes. If both exist, both are left alone: merging two real stores is
 * not a decision this function is entitled to make. Nothing is ever deleted.
 */
let adopted = null
function adoptLegacyStore(cwd, dir) {
  try {
    if (adopted === null) adopted = new Set()
    if (adopted.has(dir)) return
    adopted.add(dir)
    if (fs.existsSync(dir)) return
    const legacy = legacyProjectDir(cwd)
    if (legacy === dir || !fs.existsSync(legacy)) return
    fs.mkdirSync(PROJECTS_DIR, { recursive: true })
    fs.renameSync(legacy, dir)
  } catch { /* adoption is best-effort — a fresh store is correct, just emptier */ }
}

export function projectMemoryPath(cwd) {
  return path.join(projectDir(cwd), "memory.md")
}

// --- reading ----------------------------------------------------------------

/** Provenance comment line: `<!-- forge: k=v k=v -->` (never injected/scored). */
const PROVENANCE_RE = /^\s*<!--\s*forge:\s*(.*?)\s*-->\s*$/
export const MEMORY_SOURCES = new Set(["cli", "task", "tool", "agent", "subagent", "repair", "import", "unknown"])

export function formatProvenance(p = {}) {
  const source = MEMORY_SOURCES.has(p.source) ? p.source : "unknown"
  const ts = p.at != null && !Number.isNaN(new Date(p.at).getTime()) ? new Date(p.at) : new Date()
  const at = ts.toISOString()
  const parts = [`source=${source}`, `at=${at}`]
  if (p.runId) parts.push(`run=${String(p.runId).replace(/[\s>]/g, "_").slice(0, 40)}`)
  if (p.model) parts.push(`model=${String(p.model).replace(/[\s>]/g, "_").slice(0, 40)}`)
  return `<!-- forge: ${parts.join(" ")} -->`
}

export function parseProvenance(line) {
  const m = PROVENANCE_RE.exec(String(line ?? ""))
  if (!m) return null
  const out = { source: "unknown", at: null, runId: null, model: null }
  for (const kv of m[1].split(/\s+/)) {
    const i = kv.indexOf("=")
    if (i < 1) continue
    const k = kv.slice(0, i), v = kv.slice(i + 1)
    if (k === "source" && MEMORY_SOURCES.has(v)) out.source = v
    else if (k === "at" && !Number.isNaN(Date.parse(v))) out.at = v
    else if (k === "run") out.runId = v
    else if (k === "model") out.model = v
  }
  return out
}

function readLines(p) {
  try {
    const raw = fs.readFileSync(p, "utf8")
    return raw.split("\n").filter((l) => !PROVENANCE_RE.test(l)).map((l) => l.replace(/^[-•*]\s+/, "").trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * v21.1 — the ONE write path for memory files: resolve the real target (so a
 * symlinked memory.md is honoured, but never a symlink swapped in at write
 * time), write to a temp file in the same directory, fsync, rename over the
 * target, fsync the directory. Mode 0600: memory may hold personal notes.
 */
/**
 * Advisory lock around a memory file's read-modify-write. Created with
 * O_EXCL (atomic on every platform), holds the owner pid + time; a lock older
 * than LOCK_STALE_MS whose owner is gone is broken. Waits synchronously
 * (Atomics.wait) up to LOCK_WAIT_MS — the memory layer is sync by contract.
 */
const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 10_000
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e?.code === "EPERM" } }

const HELD_LOCKS = new Set()
export function withMemoryLock(file, fn) {
  if (HELD_LOCKS.has(file)) return fn() // re-entrant within this process (appendMemory → appendEntry)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `.${path.basename(file)}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd = null
  for (;;) {
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); break } catch (e) {
      if (e?.code !== "EEXIST") throw e
      // stale? (owner dead, or lock much older than any legitimate hold)
      try {
        const st = fs.statSync(lock)
        const owner = Number((() => { try { return fs.readFileSync(lock, "utf8").split(" ")[0] } catch { return "" } })())
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS || (owner && owner !== process.pid && !pidAlive(owner))) { try { fs.unlinkSync(lock) } catch {}; continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`memory file is locked by another writer: ${lock}`)
      sleepSync(5 + Math.floor(Math.random() * 10))
    }
  }
  try { fs.writeSync(fd, `${process.pid} ${Date.now()}`) } catch {}
  HELD_LOCKS.add(file)
  try { return fn() } finally {
    HELD_LOCKS.delete(file)
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(lock) } catch {}
  }
}

export function writeMemoryFile(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  let target = file
  try { target = fs.realpathSync(file) } catch { /* absent: create in place */ }
  const tdir = path.dirname(target)
  let st = null
  try { st = fs.lstatSync(target) } catch {}
  if (st && !st.isFile()) throw new Error(`memory path is not a regular file: ${target}`)
  const tmp = path.join(tdir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    const buf = Buffer.from(String(text ?? ""), "utf8")
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = null
    fs.renameSync(tmp, target)
    try { const dfd = fs.openSync(tdir, "r"); try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) } } catch {}
    return target
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

// v20.2 (P3-2): relevance scoring moved to retrieval.js (BM25). The old
// token-overlap helpers (words/score) were retired with that switch.

/** Both memory tiers as one scored-at-read pool (400 lines per tier cap). */
export function memoryPool(cwd = process.cwd()) {
  const global = memoryEntries("global", cwd).slice(0, 400)
  const project = memoryEntries("project", cwd).slice(0, 400)
  return [
    ...global.map((e) => ({ l: e.text, tier: "global", provenance: e.provenance || null })),
    ...project.map((e) => ({ l: e.text, tier: "project", provenance: e.provenance || null })),
  ]
}

function livePool(pool, cwd, opts = {}) {
  // v137: an empty pool has nothing to filter, so it needs no world.
  //
  // This guard came after the `worldFromCwd` call, which meant a fresh
  // checkout — no memory file, pool length 0 — still paid a full repo graph
  // build (measured 64ms here, twice per run: relevantMemory and
  // relevantLearnings both land in livePool) only to hand back the empty
  // array it was given. The staleness filter is a function OF the pool; with
  // no pool there is no question to answer.
  if (!pool.length) return pool
  const writes = opts.writes
  const graph = opts.graph
  const world = (writes && typeof writes === "object")
    ? { writes, graph: graph || { files: [], edges: [] } }
    : worldFromCwd(cwd)
  if (!Object.keys(world.writes || {}).length) return pool
  return pool.filter((e) => e.tier === "global" || !entryIsStale({ text: e.l, l: e.l, provenance: e.provenance }, world))
}

/** BM25 shortlist over the pool: pool entries ordered by score > 0. */
function bm25Shortlist(query, pool, cap = Infinity) {
  return rankDocs(query, pool.map((e, i) => ({ i, text: e.l })))
    .filter((r) => r.score > 0)
    .slice(0, cap)
    .map((r) => pool[r.i])
}

/** Deduplicate (near-)identical lines and cap the pick count. */
function dedupePick(entries, limit) {
  const seen = new Set()
  const picked = []
  for (const e of entries) {
    const key = e.l.toLowerCase().slice(0, 80)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(e)
    if (picked.length >= limit) break
  }
  return picked
}

/** Format picked entries as the prompt block ("" when nothing picked). */
function formatMemory(picked, cwd) {
  if (!picked.length) return ""
  const g = picked.filter((e) => e.tier === "global").map((e) => `- ${e.l}`)
  const p = picked.filter((e) => e.tier === "project").map((e) => `- ${e.l}`)
  const out = []
  if (g.length) out.push("USER MEMORY (persistent):\n" + g.join("\n"))
  // v108: name the PROJECT, not the subdirectory you are standing in — the
  // memory belongs to the project and saying "(src)" misreports where it lives.
  if (p.length) out.push(`PROJECT MEMORY (${path.basename(projectRoot(cwd))}):\n` + p.join("\n"))
  return out.join("\n\n").slice(0, 1600)
}

/**
 * v159 — WHAT THE USER TOLD FORGE TO REMEMBER IS A RULE, NOT A SEARCH RESULT.
 *
 * `forge memory add "…" [--project]` is how a person states a standing
 * instruction. Memory reached a prompt only through BM25 against the task
 * text, so a rule arrived only when the task happened to share its words.
 * Measured with real headless runs, both tiers: "Always use pnpm in this
 * project, never npm or yarn." was in the prompt for "use pnpm to add lodash"
 * and absent for "add lodash as a dependency" — the task it was written for.
 *
 * So user-authored entries (provenance source "cli" — the only source that
 * is unambiguously the person; the memory TOOL is the model writing its own
 * notes) are always included, in their own section, framed as instructions.
 * Project rules come before global ones (more specific). They are exempt from
 * staleness: "never hand-edit gen/api.ts" does not stop applying because
 * gen/api.ts changed. The section is bounded; what does not fit is counted,
 * never silently dropped. Everything else stays relevance-ranked.
 */
export const RULES_MAX_CHARS = 800
export const RULES_MAX = 20

// v160: "task" — a rule the person stated in a task, recorded by the memory
// tool only when quoted from their own words (tools.js quotedFrom)
const RULE_SOURCES = new Set(["cli", "task"])
const isRule = (e) => RULE_SOURCES.has(e?.provenance?.source)

/** The user's standing rules, project first, newest kept when over RULES_MAX. */
export function standingRules(cwd = process.cwd()) {
  const pick = (tier) => memoryEntries(tier, cwd).filter(isRule).map((e) => ({ text: e.text, tier, source: e.provenance?.source ?? "cli" }))
  return [...pick("project"), ...pick("global")]
}

/** The prompt section for the rules; "" when there are none. */
export function formatRules(rules = []) {
  if (!rules.length) return ""
  const head = "USER RULES (the user's standing instructions — follow them unless the current task explicitly says otherwise):"
  const lines = []
  let used = head.length
  for (const r of rules.slice(0, RULES_MAX)) {
    const tags = [r.tier === "global" ? "all projects" : "", r.source === "task" ? "stated in a task" : ""].filter(Boolean)
    const line = `- ${String(r.text).replace(/\s*\n\s*/g, " ")}${tags.length ? ` (${tags.join("; ")})` : ""}`
    if (used + line.length + 1 > RULES_MAX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  const hidden = rules.length - lines.length
  if (hidden > 0) lines.push(`- (+${hidden} more rule${hidden === 1 ? "" : "s"} not shown — see \`forge memory list --all\`)`)
  return [head, ...lines].join("\n")
}

/**
 * `rules`: true (default) renders the user's rules first and keeps them out of
 * the ranked part; "exclude" leaves them out entirely (a caller whose prompt
 * already carries them, e.g. engineering memory); false is the pre-v159 pool.
 */
function splitRules(pool, rules) {
  if (rules === false) return { ranked: pool, section: "" }
  const ranked = pool.filter((e) => !isRule(e))
  return { ranked, section: rules === "exclude" ? "" : null }
}

/**
 * Relevant memory for a query from both tiers.
 * Returns a compact string ready for a system prompt ("" when nothing matches).
 */
export function relevantMemory(query, { cwd = process.cwd(), limit = 10, writes, graph, rules = true } = {}) {
  const section = rules === true ? formatRules(standingRules(cwd)) : ""
  if (!String(query ?? "").trim()) return section
  const { ranked } = splitRules(livePool(memoryPool(cwd), cwd, { writes, graph }), rules)
  // v20.2 (P3-2): BM25 relevance instead of raw token overlap
  const rest = ranked.length ? formatMemory(dedupePick(bm25Shortlist(query, ranked), limit), cwd) : ""
  return [section, rest].filter(Boolean).join("\n\n")
}

/**
 * v23 semantic variant: reranks the BM25 shortlist with provider embeddings
 * when an `embedder` (embeddings.js createEmbedder) is supplied. The shortlist
 * is BM25's — embeddings only REORDER it, they never widen it — so a bad or
 * offline embeddings endpoint degrades to exactly the v20.2 behaviour. Every
 * failure path returns the plain BM25 result; this function never throws.
 */
export async function relevantMemoryAsync(query, { cwd = process.cwd(), limit = 10, embedder = null, alpha, budgetMs = 4000, writes, graph, rules = true } = {}) {
  const section = rules === true ? formatRules(standingRules(cwd)) : ""
  if (!String(query ?? "").trim()) return section
  const { ranked: pool } = splitRules(livePool(memoryPool(cwd), cwd, { writes, graph }), rules)
  if (!pool.length) return section
  if (!embedder || typeof embedder.embed !== "function") return relevantMemory(query, { cwd, limit, writes, graph, rules })
  try {
    const shortN = Math.max(limit * 4, 24)
    const short = bm25Shortlist(query, pool, shortN)
    if (!short.length) return section
    const reranked = await rankDocsHybrid(query, short.map((e) => ({ text: e.l, ref: e })), {
      embed: (texts) => embedder.embed(texts),
      alpha,
      budgetMs,
    })
    return [section, formatMemory(dedupePick(reranked.map((r) => r.ref), limit), cwd)].filter(Boolean).join("\n\n")
  } catch {
    return relevantMemory(query, { cwd, limit, writes, graph, rules })
  }
}

/** Full stats for /status and doctor. */
export function memoryStats(cwd = process.cwd()) {
  return {
    globalLines: readLines(GLOBAL_MEMORY_PATH).length,
    globalPath: GLOBAL_MEMORY_PATH,
    projectLines: readLines(projectMemoryPath(cwd)).length,
    projectPath: projectMemoryPath(cwd),
  }
}

// --- writing ----------------------------------------------------------------

// v20.2 memory hygiene: an append-only file grows without bound. Every
// autonomous run appends notes, and relevantMemory() reads up to 400 lines per
// tier and scores them — so unbounded growth means slower reads and, worse,
// near-duplicate notes crowding out real signal in the injected context. We now
// (1) skip an append whose bullet text already exists verbatim, and (2) trim the
// file to MEMORY_MAX_ENTRIES entries (oldest first) after writing. Both are
// best-effort; a failure here can never break the CLI.
export const MEMORY_MAX_ENTRIES = 500

function memoryFileFor(tier, cwd) {
  return tier === "project" ? projectMemoryPath(cwd) : GLOBAL_MEMORY_PATH
}

/** Path for a tier ("global" | "project"). */
export function memoryPathFor(tier, cwd = process.cwd()) {
  return memoryFileFor(tier, cwd)
}

/**
 * Parse a memory file into entries. A bullet line ("- note") is one entry; a
 * "LEARNING:" line plus its following "root-cause:"/"fix:" lines is one entry
 * (kept together so list/forget never split a learning block). Returns
 * [{ text, lines }] preserving order.
 */
export function memoryEntries(tier, cwd = process.cwd()) {
  return entriesOfFile(memoryFileFor(tier, cwd))
}

/** memoryEntries for an explicit file (the memory tool's global path). */
export function entriesOfFile(file) {
  let raw = ""
  try { raw = fs.readFileSync(file, "utf8") } catch { return [] }
  const src = raw.split("\n")
  const entries = []
  let pending = null // provenance comment waiting for its entry
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (!line.trim()) continue
    const prov = parseProvenance(line)
    if (prov) { pending = { line, prov }; continue }
    const lines = pending ? [pending.line] : []
    const provenance = pending?.prov ?? null
    pending = null
    if (/^\s*LEARNING:/i.test(line)) {
      const block = [line]
      while (i + 1 < src.length && /^\s*(root-cause|fix):/i.test(src[i + 1])) block.push(src[++i])
      entries.push({ text: block.join("\n"), lines: [...lines, ...block], provenance })
    } else {
      entries.push({ text: line.replace(/^[-•*]\s+/, "").trim(), lines: [...lines, line], provenance })
    }
  }
  return entries
}

function writeEntries(tier, entries, cwd) {
  const file = memoryFileFor(tier, cwd)
  const body = entries.map((e) => e.lines.join("\n")).join("\n")
  writeMemoryFile(file, body ? body + "\n" : "")
  return file
}

/** Append entry lines (with provenance) through the single pipeline; prunes to the cap. */
function appendEntry(tier, lines, cwd, provenance, max = MEMORY_MAX_ENTRIES) {
  return withMemoryLock(memoryFileFor(tier, cwd), () => {
    const entries = memoryEntries(tier, cwd)
    entries.push({ text: "", lines: [formatProvenance(provenance), ...lines], provenance })
    const kept = entries.length > max ? entries.slice(entries.length - max) : entries
    return writeEntries(tier, kept, cwd)
  })
}

/**
 * Append one note to a tier ("global" | "project"). Redacted, deduped, capped.
 * `provenance` = { source, runId?, model?, at? } — who is storing this and why.
 */
export function appendMemory(tier, text, cwd = process.cwd(), provenance = {}) {
  const file = memoryFileFor(tier, cwd)
  const line = redact(String(text ?? "").trim()).slice(0, 400)
  if (!line) return { ok: false, error: "empty text" }
  try {
    return withMemoryLock(file, () => {
      // dedup: an identical bullet already present is a no-op — checked under the lock
      const existing = memoryEntries(tier, cwd)
      if (existing.some((e) => e.text === line)) return { ok: true, file, deduped: true }
      appendEntry(tier, [`- ${line}`], cwd, provenance)
      return { ok: true, file }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Replace a whole tier (or an explicit file) with `text` — redacted, one pipeline. */
export function replaceMemory(tierOrFile, text, cwd = process.cwd(), provenance = {}) {
  try {
    const file = tierOrFile === "global" || tierOrFile === "project" ? memoryFileFor(tierOrFile, cwd) : String(tierOrFile)
    const body = redact(String(text ?? "")).trimEnd()
    withMemoryLock(file, () => writeMemoryFile(file, body ? `${formatProvenance(provenance)}\n${body}\n` : ""))
    return { ok: true, file, chars: body.length }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/**
 * v161 — THE MODEL'S `replace` NO LONGER ERASES THE USER'S RULES.
 *
 * The memory tool's `replace` rewrote the whole global memory file, which
 * since v159 holds the person's standing rules. Measured with a real headless
 * run: a file told the model its memory was outdated, the model called
 * `memory replace ""`, and "Never push directly to the main branch." (saved
 * with `forge memory add`) was gone.
 *
 * Replacing still replaces everything the model manages — its notes — and the
 * rules are written back after it. Nothing is refused; the person removes a
 * rule themselves (`forge memory forget <n>` / `clear`), or asks the model to
 * by naming it (forgetMatching, which needs their own words, as minting does).
 */
export function replaceKeepingRules(file, text, provenance = {}) {
  try {
    const body = redact(String(text ?? "")).trimEnd()
    let keptRules = 0
    withMemoryLock(file, () => {
      const rules = entriesOfFile(file).filter(isRule)
      keptRules = rules.length
      const parts = [body ? `${formatProvenance(provenance)}\n${body}` : "", ...rules.map((e) => e.lines.join("\n"))].filter(Boolean)
      writeMemoryFile(file, parts.length ? parts.join("\n") + "\n" : "")
    })
    return { ok: true, file, chars: body.length, keptRules }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Is this entry one of the person's rules (`forge memory add`, or quoted from a task)? */
export function isRuleEntry(e) { return isRule(e) }

/**
 * v161: remove the ONE entry a text names (the note itself, or a run of at
 * least 4 of its words). A rule is removed only with `allowRule` — the caller
 * found the person's own words naming it. Ambiguity is reported, never
 * guessed. Returns { ok, removed?, rule?, error?, matches? }.
 */
export function forgetMatching(file, text, { allowRule = false } = {}) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  const q = norm(text)
  if (!q || q.split(" ").length < 4) return { ok: false, error: "name the note with at least 4 of its words" }
  try {
    return withMemoryLock(file, () => {
      const entries = entriesOfFile(file)
      const hits = entries.map((e, i) => [e, i]).filter(([e]) => ` ${norm(e.text)} `.includes(` ${q} `))
      if (!hits.length) return { ok: false, error: "no note matches that text", matches: 0 }
      if (hits.length > 1) return { ok: false, error: `${hits.length} notes match — quote more of the one you mean`, matches: hits.length }
      const [[entry, idx]] = hits
      if (isRule(entry) && !allowRule) return { ok: false, rule: true, error: "that is one of the user's rules" }
      entries.splice(idx, 1)
      const out = entries.map((e) => e.lines.join("\n")).join("\n")
      writeMemoryFile(file, out ? out + "\n" : "")
      return { ok: true, removed: entry.text, rule: isRule(entry) }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Merge exact-duplicate bullets. Keep first provenance. */
export function consolidateMemory(tier, cwd = process.cwd()) {
  try {
    return withMemoryLock(memoryFileFor(tier, cwd), () => {
      const entries = memoryEntries(tier, cwd)
      const seen = new Set()
      const kept = []
      for (const e of entries) {
        const key = String(e.text || "").trim()
        if (!key || seen.has(key)) continue
        seen.add(key)
        kept.push(e)
      }
      writeEntries(tier, kept, cwd)
      return { ok: true, before: entries.length, after: kept.length }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Trim a tier to the newest MEMORY_MAX_ENTRIES entries. Returns count removed. */
export function pruneMemory(tier, cwd = process.cwd(), max = MEMORY_MAX_ENTRIES) {
  try {
    return withMemoryLock(memoryFileFor(tier, cwd), () => {
      const entries = memoryEntries(tier, cwd)
      if (entries.length <= max) return { ok: true, removed: 0 }
      const kept = entries.slice(entries.length - max)
      writeEntries(tier, kept, cwd)
      return { ok: true, removed: entries.length - kept.length }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Remove entry N (1-based, as shown by `memory list`) from a tier. */
export function forgetMemory(tier, n, cwd = process.cwd()) {
  try {
    return withMemoryLock(memoryFileFor(tier, cwd), () => {
      const entries = memoryEntries(tier, cwd)
      const idx = Number(n) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) {
        return { ok: false, error: `no entry ${n} (${entries.length} in ${tier} memory)` }
      }
      const [removed] = entries.splice(idx, 1)
      writeEntries(tier, entries, cwd)
      return { ok: true, removed: removed.text }
    })
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Clear a whole tier. Returns count removed. */
export function clearMemory(tier, cwd = process.cwd()) {
  try {
    const n = memoryEntries(tier, cwd).length
    const file = memoryFileFor(tier, cwd)
    try { fs.rmSync(file, { force: true }) } catch {}
    return { ok: true, removed: n, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Structured failure learning: { problem, rootCause, fix } → project memory. */
export function recordLearning({ problem, rootCause, fix } = {}, cwd = process.cwd(), provenance = {}) {
  const block = [
    `LEARNING: ${redact(String(problem ?? "").slice(0, 200))}`,
    `  root-cause: ${redact(String(rootCause ?? "").slice(0, 200))}`,
    `  fix: ${redact(String(fix ?? "").slice(0, 240))}`,
  ]
  try {
    const file = appendEntry("project", block, cwd, provenance)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** Parse LEARNING blocks (a LEARNING: line + its root-cause:/fix: lines). */
export function parseLearnings(cwd = process.cwd()) {
  const lines = readLines(projectMemoryPath(cwd))
  const learnings = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("LEARNING:")) continue
    const block = [lines[i]]
    let j = i + 1
    // readLines trims indentation, so match "root-cause:"/"fix:" without \s+
    while (j < lines.length && /^(root-cause|fix):/i.test(lines[j])) { block.push(lines[j]); j++ }
    learnings.push(block.join("\n"))
  }
  return learnings
}

function liveLearnings(cwd, opts = {}) {
  // v137: read what is to be filtered BEFORE building the thing that filters
  // it — same defect, and same fix, as livePool above. `memoryEntries` is a
  // file read that measured 0ms; `worldFromCwd` measured 64ms. Ordering them
  // the other way round meant a project with no recorded LEARNING blocks —
  // every fresh checkout — paid the graph build to filter an empty list.
  const blocks = memoryEntries("project", cwd).filter((e) => /^\s*LEARNING:/i.test(e.text) || /^LEARNING:/i.test(e.text))
  if (!blocks.length) return []
  const writes = opts.writes
  const graph = opts.graph
  const world = (writes && typeof writes === "object")
    ? { writes, graph: graph || { files: [], edges: [] } }
    : worldFromCwd(cwd)
  if (!Object.keys(world.writes || {}).length) return blocks.map((e) => e.text)
  return blocks.filter((e) => !entryIsStale(e, world)).map((e) => e.text)
}

/** Retrieve learned fixes relevant to a query (for the context engine). */
export function relevantLearnings(query, { cwd = process.cwd(), limit = 3, writes, graph } = {}) {
  const learnings = liveLearnings(cwd, { writes, graph })
  if (!learnings.length) return ""
  if (!String(query ?? "").trim()) return ""
  // v20.2 (P3-2): BM25 relevance
  const scored = rankDocs(query, learnings.map((l, i) => ({ i, text: l })))
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => learnings[r.i])
  return scored.length ? "LEARNED FIXES (relevant past failures):\n" + scored.join("\n") : ""
}

/**
 * v23 semantic variant of relevantLearnings — same BM25-shortlist-then-rerank
 * contract as relevantMemoryAsync (embeddings reorder, never widen; failures
 * fall back to the exact BM25 result).
 */
export async function relevantLearningsAsync(query, { cwd = process.cwd(), limit = 3, embedder = null, alpha, budgetMs = 4000, writes, graph } = {}) {
  if (!String(query ?? "").trim()) return ""
  const learnings = liveLearnings(cwd, { writes, graph })
  if (!learnings.length) return ""
  if (!embedder || typeof embedder.embed !== "function") return relevantLearnings(query, { cwd, limit, writes, graph })
  try {
    const short = rankDocs(query, learnings.map((l, i) => ({ i, text: l })))
      .filter((r) => r.score > 0)
      .slice(0, Math.max(limit * 4, 8))
    if (!short.length) return ""
    const reranked = await rankDocsHybrid(query, short.map((r) => ({ text: learnings[r.i], ref: learnings[r.i] })), {
      embed: (texts) => embedder.embed(texts),
      alpha,
      budgetMs,
    })
    const picked = reranked.slice(0, limit).map((r) => r.ref)
    return picked.length ? "LEARNED FIXES (relevant past failures):\n" + picked.join("\n") : ""
  } catch {
    return relevantLearnings(query, { cwd, limit, writes, graph })
  }
}

// keep os import meaningful (homedir fallback if DEFAULT_DIR unset)
void os
