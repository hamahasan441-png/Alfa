/**
 * forge — local-first source resolution (v97 "unifiedwise", ∞ §4, zero dependencies)
 *
 * THE rule this module enforces: before engineering work begins, determine what
 * source the user actually means — and the LOCAL artifact always outranks a
 * remote one unless the user explicitly selected the remote.
 *
 * Resolution ladder (highest authority first):
 *   1. explicitly provided local file        → sourceType "file"
 *   2. explicitly provided local folder      → "folder"
 *   3. explicitly provided local ZIP/archive → "archive" (extracted, inspected)
 *   4. explicitly provided URL (https)       → "url"     (downloaded zip)
 *   5. explicitly provided git repository    → "git"     (shallow clone)
 *   6. current workspace / project (cwd)     → "workspace" / "git-repo"
 *   7. remote discovery/search — NEVER automatic. This module does not search
 *      the web for a repo that "looks like" the task; that would be the exact
 *      GitHub-bias failure §4 forbids.
 *
 * A repository the user asked to change is not a search and not a zip. A
 * normal GitHub page (https, git@, or a tree URL) is cloned, or an existing
 * checkout of that same repository is reused. An archive URL is an archive
 * only when the user pointed at an archive. A URL mentioned as documentation
 * stays a reference. Two work targets, or a URL whose role is unclear, stop
 * and ask — the launch directory is never a silent fallback. Clone, auth,
 * identity, and destination failures stop the same way, and they do not
 * delete or reset work that was already in a checkout.
 *
 * ZIP handling follows the §4 pipeline: inspect archive → identify project
 * root → detect languages / manifests / build systems / tests / configuration /
 * git metadata → extract safely (zip-slip guarded, entry + size caps) → operate
 * on the extracted LOCAL project.
 *
 * Persistence: ~/.forge/projects/<hash>/source.json records sourceType,
 * sourceId, localPath, archivePath, projectId, origin, authority, discovery
 * evidence and the REASON the source was selected — so a resumed session, the
 * meta controller and the world model all agree on what "the project" is.
 *
 * Conflict rule: if a local ZIP/folder is explicitly provided while the cwd is
 * a git repository, the EXPLICIT local selection wins and the conflict is
 * recorded with both candidates — never silently, never the other way around.
 */
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
import path from "node:path"
import os from "node:os"
import { lazyBuiltin, lazyExport, loadBuiltin } from "./lazybuiltin.js"
const promisify = lazyExport("util", "promisify") // loaded on first use (lazybuiltin.js)
const zlib = lazyBuiltin("zlib") // loaded on first use (lazybuiltin.js)
const crypto = lazyBuiltin("crypto") // loaded on first use (lazybuiltin.js)
const execFile = lazyExport("child_process", "execFile") // loaded on first use (lazybuiltin.js)
import { DEFAULT_DIR } from "./config.js"
import { projectDir, projectHash } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { pinnedFetch, assertFetchableUrl } from "./netguard.js"

// promisified on first use: doing it here would load child_process at startup
let execFilePromised = null
const execFileP = (...args) => (execFilePromised ??= promisify(execFile))(...args)

export const SOURCES_DIR = path.join(DEFAULT_DIR, "sources")

// extraction safety caps (a project archive, not a skill pack — bigger, still bounded)
const MAX_ZIP_ENTRIES = 20000
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024 // 512 MB extracted
const MAX_ZIP_FILE_BYTES = 64 * 1024 * 1024   // 64 MB per entry
const MAX_URL_BYTES = 256 * 1024 * 1024       // download cap
const GIT_CLONE_TIMEOUT_MS = 120000

/** Manifests that identify a project root / build system (basename → label). */
export const ROOT_MANIFESTS = [
  ["package.json", "node"], ["deno.json", "node"], ["bun.lockb", "node"],
  ["Cargo.toml", "rust"], ["go.mod", "go"], ["pyproject.toml", "python"],
  ["requirements.txt", "python"], ["setup.py", "python"], ["Pipfile", "python"],
  ["pom.xml", "java"], ["build.gradle", "java"], ["build.gradle.kts", "java"],
  ["Gemfile", "ruby"], ["composer.json", "php"], ["mix.exs", "elixir"],
  ["Makefile", "make"], ["CMakeLists.txt", "cmake"], ["meson.build", "meson"],
  ["flake.nix", "nix"], ["docker-compose.yml", "compose"], ["docker-compose.yaml", "compose"],
  ["pubspec.yaml", "dart"], ["build.zig", "zig"], ["tsconfig.json", "node"],
]

const LANG_BY_EXT = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java",
  ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".scala": "scala", ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".sql": "sql",
  ".lua": "lua", ".dart": "dart", ".zig": "zig", ".vue": "vue", ".svelte": "svelte",
}

function sha12(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------------------
// ZIP inspection + safe extraction (project-grade, zero dependencies)
// ---------------------------------------------------------------------------

/** Minimal ZIP local-file-header walker (store + deflate). Same technique as
 *  zipingest.js but project-scale: entry caps, total-size caps, zip-slip guard.
 *  Returns [{ name, size, compressedSize, method }] or null when not a zip. */
export function listProjectZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  if (buf.readUInt32LE(0) !== 0x04034b50) return null // PK\x03\x04
  const out = []
  let off = 0
  let total = 0
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break // central directory / garbage
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const size = buf.readUInt32LE(off + 22)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    if (off + 30 + nameLen > buf.length) break
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen)
    if (out.length >= MAX_ZIP_ENTRIES) return { entries: out, truncated: true }
    if (size <= MAX_ZIP_FILE_BYTES && !name.endsWith("/")) {
      out.push({ name, size, compressedSize: compSize, method })
      total += size
      if (total > MAX_ZIP_TOTAL_BYTES) return { entries: out, truncated: true }
    }
    off += 30 + nameLen + extraLen + compSize
  }
  if (!out.length) return null
  return { entries: out, truncated: false }
}

export function isZipFile(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

/** Identify the project root inside an archive: the shallowest directory that
 *  contains a root manifest. Falls back to the shallowest common prefix.
 *  SECURITY: a "root" that is or contains `..` (or is absolute) is rejected —
 *  the root-prefix logic must never launder a zip-slip path into a safe one. */
export function identifyZipRoot(entries) {
  const safe = (root) => {
    if (!root) return ""
    if (root === ".." || root.startsWith("../") || root.startsWith("/") || root.includes("\0")) return ""
    return root
  }
  const names = entries.map((e) => e.name)
  const manifestHit = {} // dirDepth → name
  for (const n of names) {
    const base = n.split("/").pop()
    if (ROOT_MANIFESTS.some(([m]) => m === base)) {
      const dir = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""
      const depth = dir ? dir.split("/").length : 0
      if (manifestHit.depth == null || depth < manifestHit.depth) manifestHit.depth = depth
    }
  }
  if (manifestHit.depth != null) {
    // find the actual dir name at that depth with a manifest
    for (const n of names) {
      const base = n.split("/").pop()
      if (!ROOT_MANIFESTS.some(([m]) => m === base)) continue
      const dir = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ""
      if ((dir ? dir.split("/").length : 0) === manifestHit.depth) return safe(dir)
    }
  }
  // fallback: shallowest common directory prefix
  const first = names[0] ?? ""
  const prefix = first.includes("/") ? first.slice(0, first.lastIndexOf("/") + 1) : ""
  if (prefix && names.every((n) => n.startsWith(prefix))) return safe(prefix.slice(0, -1))
  return ""
}

/** Extract a project zip into `dest` (created). Zip-slip guarded; entry +
 *  byte caps; returns { files, root, truncated, skipped } — honest counts. */
export function extractProjectZip(buf, dest) {
  const listing = listProjectZipEntries(buf)
  if (!listing) return { ok: false, error: "not a zip archive" }
  const root = identifyZipRoot(listing.entries)
  const rootPrefix = root ? root + "/" : ""
  fs.mkdirSync(dest, { recursive: true })
  const files = []
  let skipped = 0
  let off = 0
  let written = 0
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const size = buf.readUInt32LE(off + 22)
    const crc = buf.readUInt32LE(off + 14)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen)
    const dataStart = off + 30 + nameLen + extraLen
    off = dataStart + compSize
    if (name.endsWith("/")) continue
    const rel = name.startsWith(rootPrefix) && name !== rootPrefix ? name.slice(rootPrefix.length) : name
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || rel.includes("\0")) { skipped++; continue }
    if (size > MAX_ZIP_FILE_BYTES || written + size > MAX_ZIP_TOTAL_BYTES) { skipped++; continue }
    if (files.length >= MAX_ZIP_ENTRIES) return { ok: true, files, root, truncated: true, skipped }
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    try {
      if (method === 0) data = raw
      else if (method === 8) data = zlib.inflateRawSync(raw)
      else { skipped++; continue }
    } catch { skipped++; continue }
    if (data.length !== size || (size > 0 && crc32(data) !== crc)) { skipped++; continue }
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    files.push(rel)
    written += size
  }
  return { ok: true, files, root, truncated: listing.truncated, skipped }
}

// crc32 (same table approach as zipingest; zlib.crc32 may not exist on older node)
let CRC_TABLE = null
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// project discovery (shared by archive + folder + workspace)
// ---------------------------------------------------------------------------

/** Inspect a LOCAL directory: languages census, manifests, build systems,
 *  tests, CI, git metadata. Facts only — never a guess dressed as a fact. */
export function inspectProjectDir(dir) {
  const base = path.resolve(dir)
  const out = { dir: base, exists: false, manifests: [], languages: {}, tests: [], buildSystems: [], ci: [], git: false, gitRemote: null, fileCount: 0 }
  try { fs.statSync(base); out.exists = true } catch { return out }
  const walk = (d, depth) => {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      // v97 fix: only the workspace ROOT is "a git repo" — a nested checkout
      // (submodule clone, sibling project) must not relabel the parent.
      if (e.name === ".git" && d === base) { out.git = true; continue }
      if (e.name === "node_modules" || e.name === ".forge" || e.name === "target" || e.name === "__pycache__") continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      out.fileCount++
      if (depth <= 1 && ROOT_MANIFESTS.some(([m]) => m === e.name)) out.manifests.push(e.name)
      const ext = path.extname(e.name).toLowerCase()
      const lang = LANG_BY_EXT[ext]
      if (lang) out.languages[lang] = (out.languages[lang] ?? 0) + 1
      if (/^(test|spec)_|[-.](test|spec)\./i.test(e.name)) out.tests.push(path.relative(base, full))
      if (depth <= 1 && /^(Dockerfile|Makefile|CMakeLists\.txt|meson\.build)$/.test(e.name)) out.buildSystems.push(e.name)
      if (e.name.endsWith(".yml") || e.name.endsWith(".yaml")) {
        const rel = path.relative(base, full).replace(/\\/g, "/")
        if (/^\.github\/workflows\//.test(rel) || /^\.gitlab-ci\.yml$/.test(rel)) out.ci.push(rel)
      }
    }
  }
  walk(base, 0)
  out.tests = out.tests.slice(0, 40)
  out.gitRemote = gitRemoteUrl(base)
  return out
}

/** A git ref or path segment that must never reach the git argv. */
function isSafeGitRef(ref) {
  const s = String(ref ?? "")
  if (!s || s.length > 200) return false
  if (s.startsWith("-") || s.includes("..") || s.includes("\\") || /[\s\0~^:?*\[@]/.test(s)) return false
  return /^[\w./-]+$/.test(s)
}

function isSafeRelPath(rel) {
  const s = String(rel ?? "")
  if (!s || s.length > 400) return false
  if (s.startsWith("/") || s.includes("\0") || s.split("/").some((p) => p === ".." || p === ".")) return false
  return /^[\w .@%+-]+(?:\/[\w .@%+-]+)*$/.test(s)
}

/**
 * Canonical identity of a repository URL.
 * A normal GitHub page is a git repository, never a zip.
 * Tree URLs keep the branch and optional subdirectory separate from the clone root.
 */
export function parseRepositoryUrl(raw) {
  let s = String(raw ?? "").trim().replace(/[)>,.;]+$/g, "")
  if (!s) return null
  const hash = s.indexOf("#")
  if (hash >= 0) s = s.slice(0, hash)
  const q = s.indexOf("?")
  if (q >= 0) s = s.slice(0, q)
  s = s.replace(/\/+$/, "")
  if (s.startsWith("-")) return { kind: "reject", why: "refused a URL that looks like a flag" }
  // ssh://git@github.com is the git user, not a secret. Anything else before
  // the host (a token, user:password) must not be stored as an origin URL.
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)@/i.exec(s)
  if (userinfo && userinfo[1] !== "git") return { kind: "reject", why: "refused a URL with embedded credentials — use a credential helper" }

  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(s)
  if (ssh) {
    return gitIdentity(ssh[1], ssh[2], { cloneUrl: `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}.git` })
  }
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.*))?$/i.exec(s)
  if (gh) {
    const owner = gh[1]
    const name = gh[2].replace(/\.git$/i, "")
    const rest = gh[3] || ""
    if (/^(archive\/|releases\/download\/)/i.test(rest) || /\.zip$/i.test(rest)) {
      return { kind: "archive", owner, name, url: String(raw).trim().replace(/[)>,.;]+$/, "").replace(/#.*$/, ""), why: "GitHub archive URL" }
    }
    if (/^(issues|pulls?|wiki|actions|releases|commits?|compare|settings|security|projects|discussions|graphs|network|pulse|stargazers|watchers|forks|labels|milestones)(\/|$)/i.test(rest)) {
      return { kind: "reject", why: `github.com/${owner}/${name}/${rest.split("/")[0]} is not a repository checkout` }
    }
    let branch = null
    let subdir = null
    let file = null
    if (rest) {
      const tree = /^(tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(rest)
      if (!tree) return { kind: "reject", why: `unsupported GitHub path /${rest}` }
      try { branch = decodeURIComponent(tree[2]) } catch { return { kind: "reject", why: "branch is not valid URL encoding" } }
      if (!isSafeGitRef(branch)) return { kind: "reject", why: `refused unsafe branch "${branch}"` }
      if (tree[1] === "blob" && tree[3]) {
        // a link to ONE file: the repository is the workspace, the file its focus
        try { file = decodeURIComponent(tree[3]) } catch { file = null }
        if (file && !isSafeRelPath(file)) file = null
      }
      if (tree[1] === "tree" && tree[3]) {
        try { subdir = decodeURIComponent(tree[3]).replace(/\/+$/, "") } catch { return { kind: "reject", why: "subdirectory is not valid URL encoding" } }
        if (!isSafeRelPath(subdir)) return { kind: "reject", why: `refused unsafe subdirectory "${subdir}"` }
      }
    }
    return gitIdentity(owner, name, { branch, subdir, file, cloneUrl: `https://github.com/${owner}/${name}.git` })
  }
  if (/^https?:\/\/.+\.zip$/i.test(s) || /^https?:\/\/codeload\.github\.com\//i.test(s)) {
    return { kind: "archive", url: s, why: "explicit archive URL" }
  }
  if (/^file:\/\/.+/i.test(s) || (/\.git$/i.test(s) && /^https?:\/\//i.test(s)) || /^ssh:\/\//i.test(s) || /^git@/i.test(s)) {
    if (s.includes("..") || s.includes("\0") || s.includes(" ")) return { kind: "reject", why: "refused unsafe git URL" }
    return { kind: "git", owner: null, name: null, slug: null, cloneUrl: s, canonical: s.replace(/\.git$/i, ""), branch: null, subdir: null }
  }
  return null
}

function gitIdentity(owner, name, extra = {}) {
  if (!owner || !name || owner.startsWith(".") || name.startsWith(".") || owner === ".." || name === "..") {
    return { kind: "reject", why: "malformed repository owner or name" }
  }
  return {
    kind: "git",
    owner, name,
    slug: `${owner}/${name}`,
    cloneUrl: extra.cloneUrl || `https://github.com/${owner}/${name}.git`,
    canonical: `https://github.com/${owner}/${name}`,
    branch: extra.branch || null,
    subdir: extra.subdir || null,
    ...(extra.file ? { file: extra.file } : {}),
  }
}

function sameRepository(a, b) {
  const pa = typeof a === "string" ? parseRepositoryUrl(a) : a
  const pb = typeof b === "string" ? parseRepositoryUrl(b) : b
  if (pa?.kind === "git" && pb?.kind === "git" && pa.slug && pb.slug) return pa.slug.toLowerCase() === pb.slug.toLowerCase()
  if (pa?.kind === "git" && pb?.kind === "git" && pa.cloneUrl && pb.cloneUrl) return pa.cloneUrl.replace(/\.git$/i, "") === pb.cloneUrl.replace(/\.git$/i, "")
  return false
}

/** Current checkout's origin, including git worktrees (.git is a file). */
export function gitRemoteUrl(dir) {
  try {
    const gitPath = path.join(dir, ".git")
    let gitDir = gitPath
    const st = fs.statSync(gitPath)
    if (st.isFile()) {
      const txt = fs.readFileSync(gitPath, "utf8")
      const m = /^gitdir:\s*(.+)$/m.exec(txt)
      if (!m) return null
      gitDir = path.resolve(path.dirname(gitPath), m[1].trim())
    }
    let configPath = path.join(gitDir, "config")
    try {
      const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()
      configPath = path.resolve(gitDir, common, "config")
    } catch { /* main checkout keeps config beside HEAD */ }
    const cfg = fs.readFileSync(configPath, "utf8")
    const hit = /\[remote "origin"\][^\[]*url\s*=\s*(\S+)/.exec(cfg)
    return hit ? hit[1] : null
  } catch { return null }
}

/** The checkout whose origin is this repository, walking up from `cwd`.
 *  A different repository on the way stops the walk — its parent is not ours. */
function matchingCheckout(cwd, parsed) {
  if (!parsed || parsed.kind !== "git") return null
  let cur = path.resolve(cwd)
  for (let i = 0; i < 40; i++) {
    const remote = gitRemoteUrl(cur)
    if (remote) {
      if (sameRepository(remote, parsed.cloneUrl) || sameRepository(remote, parsed.canonical)) return cur
      return null
    }
    if (fs.existsSync(path.join(cur, ".git"))) return null
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function redactSecrets(s) {
  return String(s ?? "")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s]+)@/g, "$1***@")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}\b/g, "***")
    .slice(0, 400)
}

function realInside(root, target) {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const r = real(root)
  const t = real(target)
  const rel = path.relative(r, t)
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
}

function underSources(dest) {
  const root = path.resolve(SOURCES_DIR)
  const d = path.resolve(dest)
  const rel = path.relative(root, d)
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false
  // A missing sources directory is fine. A symlink that resolves outside it is not.
  let cur = d
  for (let i = 0; i < 40; i++) {
    let st = null
    try { st = fs.lstatSync(cur) } catch { st = null }
    if (st?.isSymbolicLink()) {
      let real
      try { real = fs.realpathSync(cur) } catch { return false }
      let rootReal = root
      try { rootReal = fs.realpathSync(root) } catch { /* not created yet */ }
      const escaped = path.relative(rootReal, real)
      if (escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) return false
    }
    if (st && !st.isSymbolicLink()) return true
    const parent = path.dirname(cur)
    if (parent === cur) return true
    cur = parent
  }
  return false
}

function normRepoUrl(u) {
  return String(u ?? "").trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase()
}

/** True when `dest` is a git checkout of `identity` (slug, clone URL, or both). */
function gitCheckoutMatches(dest, identity) {
  if (!identity) return false
  try { if (!fs.existsSync(path.join(dest, ".git"))) return false } catch { return false }
  const remote = gitRemoteUrl(dest)
  if (!remote) return false
  if (identity.slug && (sameRepository(remote, identity.cloneUrl || "") || sameRepository(remote, identity.canonical || ""))) return true
  if (identity.cloneUrl && normRepoUrl(remote) === normRepoUrl(identity.cloneUrl)) return true
  if (identity.canonical && normRepoUrl(remote) === normRepoUrl(identity.canonical)) return true
  const got = parseRepositoryUrl(remote)
  if (identity.slug && got?.kind === "git" && got.slug && got.slug.toLowerCase() === String(identity.slug).toLowerCase()) return true
  return false
}

function cloneEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
}

function gitFailure(e) {
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : ""
  return redactSecrets(stderr || e?.message || e).slice(0, 300)
}

function sourceEventsHome() {
  const home = String(process.env.FORGE_HOME || process.env.FORGE_DATA_DIR || "").trim()
  return home ? path.resolve(home) : path.dirname(SOURCES_DIR)
}

function recordSourceEvent(ev) {
  try {
    const dir = sourceEventsHome()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const safe = {
      ok: ev.ok === true,
      action: ev.action ?? null,
      reason: redactSecrets(ev.reason || ""),
      canonical: ev.canonical ? redactSecrets(ev.canonical) : null,
      branch: ev.branch ?? null,
      subdir: ev.subdir ?? null,
      localPath: ev.localPath ?? null,
      previousCwd: ev.previousCwd ?? null,
      changed: ev.changed === true,
      reused: ev.reused === true,
      head: ev.head ?? null,
      remote: ev.remote ? redactSecrets(ev.remote) : null,
      error: ev.ok ? null : redactSecrets(ev.error || ev.reason || ""),
    }
    fs.appendFileSync(path.join(dir, "source-events.jsonl"), JSON.stringify({ ts: Date.now(), type: "SOURCE_RESOLVED", ...safe }) + "\n")
  } catch { /* telemetry must not decide where work happens */ }
}

async function gitDirty(dir) {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: dir, timeout: 15000, env: cloneEnv(), maxBuffer: 1024 * 1024 })
    return String(stdout ?? "").trim().length > 0
  } catch { return true }
}

async function gitHeadInfo(dir) {
  try {
    const head = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 10000, env: cloneEnv(), maxBuffer: 64 * 1024 })
    let branch = null
    try {
      const b = await execFileP("git", ["branch", "--show-current"], { cwd: dir, timeout: 10000, env: cloneEnv(), maxBuffer: 64 * 1024 })
      branch = String(b.stdout ?? "").trim() || null
    } catch { branch = null }
    return { head: String(head.stdout ?? "").trim() || null, branch }
  } catch { return { head: null, branch: null } }
}

function gitUrlResolution(parsed, ev) {
  const cloneUrl = parsed.cloneUrl
  const key = `${cloneUrl}\n${parsed.branch || ""}\n${parsed.subdir || ""}`
  const id = sha12(key)
  const where = parsed.slug || redactSecrets(cloneUrl)
  return {
    sourceType: "git-url", sourceId: id, localPath: null, archivePath: null,
    origin: redactSecrets(parsed.canonical || cloneUrl), authority: "explicit-git-url",
    canonical: parsed.canonical || null, branch: parsed.branch || null, subdir: parsed.subdir || null,
    reason: `git repository ${where}${parsed.branch ? ` branch ${parsed.branch}` : ""}${parsed.subdir ? ` subdirectory ${parsed.subdir}` : ""} — shallow clone, not an archive`,
    evidence: [...ev, evidence("git-url", redactSecrets(parsed.slug ? parsed.canonical : cloneUrl))],
    inspect: null,
    extract: {
      needed: true, git: cloneUrl, branch: parsed.branch || null, subdir: parsed.subdir || null,
      identity: { slug: parsed.slug || null, cloneUrl, canonical: parsed.canonical || null },
      dest: path.join(SOURCES_DIR, id),
    },
    conflict: null,
  }
}

// Reading a repository is working on it too: "audit <url>" used to be
// "ambiguous" and stopped to ask, because only change verbs counted. Verbs
// that just as often point AT a URL ("check the changelog at …", "run the
// tests the way … does", "build it like …") stay out: those must still ask.
const WORK_INTENT = /\b(update|fix|repair|implement|patch|refactor|rewrite|migrate|debug|inspect|review|clone|modify|edit|change|add|upgrade|port|work on|working on|in this repository|this repository|the repository|this repo|the repo|audit|analy[sz]e|explain|summari[sz]e|understand|study|scan|document|explore|look at|go through)\b/i
const MENTION_INTENT = /\b(see also|see the|see docs|documented|documentation|docs|for example|e\.g\.|example|reference|according to|inspired by|similar to|cf\.|as described|readme says)\b/i
const GH_URL = /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>"'`)\]]+/gi
const BARE_REPO = /(?:^|[\s"'`(])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w-]*)(?=$|[\s"'`),.:;!?])/g
const PATHISH_OWNER = new Set(["src", "lib", "app", "test", "tests", "doc", "docs", "bin", "dist", "build", "packages", "pkg", "internal", "cmd", "scripts", "config", "node_modules", "public", "assets", "components", "pages", "routes", "hooks", "utils", "util", "core", "tools", "vendor", "spec", "fixtures", "migrations", "api", "web", "server", "client", "frontend", "backend", "shared", "common", "types", "static", "images", "img", "css", "js", "ts", "forge"])
// "the repo" in this codebase means the checkout you are already in.
// Ask only when GitHub itself is the unnamed target.
const UNNAMED_GITHUB_REPO = /\bgithub\s+(?:repository|repo)\b/i

/** owner/name only. Same acceptance as reporun.parseRepoSpec, without importing it (that pulls child_process at startup). */
function ownerNameSpec(token) {
  const s = String(token ?? "").trim().replace(/\.git$/i, "").replace(/\/+$/, "")
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s)
  if (!m || m[1].startsWith(".") || m[2].startsWith(".") || m[1] === ".." || m[2] === "..") return null
  return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` }
}

function overlapsSpan(spans, index, len) {
  const end = index + len
  return spans.some(([a, b]) => index < b && end > a)
}

/**
 * Does this task ask to work ON a repository, or only mention one?
 * One clear work target becomes the source. A bare URL, two work targets,
 * or a repository that is implied but not named, is ambiguous — the caller
 * must stop and ask, never guess a checkout.
 */
export function repoIntentInTask(text, { cwd = process.cwd() } = {}) {
  const raw = String(text ?? "")
  if (/:\/\/[^/\s]+@github\.com\//i.test(raw)) {
    return { action: "ambiguous", urls: [], reason: "refused a repository URL with embedded credentials — use a credential helper" }
  }
  const found = []
  for (const m of raw.matchAll(GH_URL)) {
    const url = m[0].replace(/[)>,.;:]+$/g, "")
    const parsed = parseRepositoryUrl(url.startsWith("http") ? url : `https://${url.replace(/^\/+/, "")}`)
    const before = raw.slice(Math.max(0, m.index - 96), m.index)
    const after = raw.slice(m.index, Math.min(raw.length, m.index + url.length + 48))
    found.push({ url, parsed, index: m.index, work: WORK_INTENT.test(before) || WORK_INTENT.test(after), mention: MENTION_INTENT.test(before) })
  }
  const spans = found.map((f) => [f.index, f.index + f.url.length])
  for (const m of raw.matchAll(BARE_REPO)) {
    const token = m[1]
    const index = m.index + m[0].indexOf(token)
    if (overlapsSpan(spans, index, token.length)) continue
    if (token.includes(".") || token.toLowerCase().startsWith("github.com/")) continue
    // `projects/app` that exists right here is a folder, not github.com/projects/app
    try { if (fs.existsSync(path.resolve(cwd, token))) continue } catch { /* not a local path */ }
    const spec = ownerNameSpec(token)
    if (!spec) continue
    if (PATHISH_OWNER.has(spec.owner.toLowerCase()) || PATHISH_OWNER.has(spec.name.toLowerCase())) continue
    if (spec.owner.length < 2 || spec.name.length < 2) continue
    const parsed = parseRepositoryUrl(spec.url.replace(/\.git$/i, ""))
    if (!parsed || parsed.kind !== "git") continue
    const before = raw.slice(Math.max(0, index - 96), index)
    found.push({ url: parsed.canonical, parsed, index, work: WORK_INTENT.test(before), mention: MENTION_INTENT.test(before) })
  }
  if (!found.length) {
    if (UNNAMED_GITHUB_REPO.test(raw) && WORK_INTENT.test(raw) && !MENTION_INTENT.test(raw)) {
      return { action: "ambiguous", urls: [], reason: "the task refers to a repository but does not identify which one" }
    }
    return { action: "none", reason: "no repository URL in the task" }
  }
  const targets = []
  const mentions = []
  const unclear = []
  for (const f of found) {
    if (!f.parsed || f.parsed.kind === "reject") { unclear.push(f); continue }
    if (f.parsed.kind !== "git") { mentions.push(f); continue }
    if (f.work && !f.mention) targets.push(f)
    else if (f.mention && !f.work) mentions.push(f)
    else unclear.push(f)
  }
  const sameTarget = targets.length > 0 && targets.every((t) => t.parsed?.slug && t.parsed.slug.toLowerCase() === targets[0].parsed.slug.toLowerCase())
  if (sameTarget && unclear.length === 0) {
    return { action: "target", url: targets[0].url, parsed: targets[0].parsed, reason: "the task names one repository to change" }
  }
  if (targets.length > 1) {
    return { action: "ambiguous", urls: targets.map((t) => t.parsed.canonical || t.url), reason: "the task names more than one repository to change" }
  }
  if (unclear.length) {
    return { action: "ambiguous", urls: unclear.map((t) => t.url), reason: "a repository URL is present but it is not clear it is the thing to change" }
  }
  return { action: "none", reason: "the repository URL is a reference, not the working target" }
}

// ---------------------------------------------------------------------------
// source records (§4 persistence)
// ---------------------------------------------------------------------------

export function sourceRecordPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), "source.json")
}

/** Persist the authoritative source record for a project directory. */
export function saveSourceRecord(cwd, record) {
  try {
    const prev = readSourceRecord(cwd)
    const rec = {
      version: 1,
      projectId: projectHash(cwd),
      resolvedAt: Date.now(),
      ...record,
      history: [...(prev?.history ?? []), { resolvedAt: Date.now(), sourceType: record?.sourceType ?? null, localPath: record?.localPath ?? null }].slice(-8),
    }
    writeStateFile(sourceRecordPath(cwd), JSON.stringify(rec, null, 1))
    return rec
  } catch { return null }
}

export function readSourceRecord(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(sourceRecordPath(cwd), "utf8"))
    return j && typeof j === "object" ? j : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// THE resolver
// ---------------------------------------------------------------------------

function evidence(kind, detail) {
  return { kind, detail: String(detail).slice(0, 240) }
}

/**
 * Resolve what source the user means. `input` is the explicit source argument
 * (path / zip / https URL / git URL) or null (→ the current workspace).
 * Never contacts the network unless `input` is an explicit URL; NEVER searches
 * for a remote that "looks like" the task (§4: no GitHub bias).
 */
export function resolveSource(input, { cwd = process.cwd(), downloadUrl = null } = {}) {
  const base = path.resolve(cwd)
  const ev = []
  const raw = String(input ?? "").trim()

  // --- explicit local file / folder / zip -----------------------------------
  if (raw) {
    const p = path.resolve(base, raw)
    let st = null
    try { st = fs.statSync(p) } catch { /* fall through to URL/git handling */ }
    if (st?.isFile()) {
      const buf = fs.readFileSync(p)
      if (isZipFile(buf) || /\.zip$/i.test(p)) {
        const id = sha12(`${p}:${buf.length}:${crc32(buf.subarray(0, Math.min(buf.length, 1 << 20)))}`)
        ev.push(evidence("archive", `local zip ${p} (${buf.length} bytes, ${listProjectZipEntries(buf)?.entries.length ?? 0} entries)`))
        const inspect = inspectZipBuffer(buf)
        ev.push(evidence("detect", `root=${inspect.root || "(top)"} manifests=[${inspect.manifests.slice(0, 6).join(",")}] langs=[${Object.keys(inspect.languages).slice(0, 6).join(",")}] git=${inspect.git}`))
        const cwdIsGit = gitRemoteUrl(base) != null || fs.existsSync(path.join(base, ".git"))
        if (cwdIsGit) ev.push(evidence("conflict", `cwd ${base} is a git repo — the EXPLICIT local archive wins (user-selected source overrides workspace)`))
        return {
          sourceType: "archive", sourceId: id, localPath: null, archivePath: p,
          origin: `file://${p}`, authority: "explicit-local-archive",
          reason: "explicitly provided local ZIP archive — local-first ladder tier 3",
          evidence: ev, inspect, extract: { needed: true, buffer: () => buf, dest: path.join(SOURCES_DIR, id) },
          conflict: cwdIsGit ? { candidates: ["local-archive", "workspace-git"], winner: "local-archive", why: "explicit user selection" } : null,
        }
      }
      ev.push(evidence("file", `explicit local file ${p}`))
      return {
        sourceType: "file", sourceId: sha12(p), localPath: p, archivePath: null,
        origin: `file://${p}`, authority: "explicit-local-file",
        reason: "explicitly provided local file — local-first ladder tier 1",
        evidence: ev, inspect: null, extract: null, conflict: null,
      }
    }
    if (st?.isDirectory()) {
      const inspect = inspectProjectDir(p)
      ev.push(evidence("folder", `explicit local folder ${p} (${inspect.fileCount} files, manifests=[${inspect.manifests.slice(0, 6).join(",")}])`))
      const st2 = inspect.git ? "git-repo" : "folder"
      return {
        sourceType: st2, sourceId: sha12(p), localPath: p, archivePath: null,
        origin: inspect.gitRemote ?? `file://${p}`, authority: "explicit-local-folder",
        reason: `explicitly provided local folder — local-first ladder tier 2${inspect.git ? " (contains .git)" : ""}`,
        evidence: ev, inspect, extract: null, conflict: null,
      }
    }
    // --- explicit URL, git remote, or GitHub repository page ----------------
    // A normal GitHub page is a git repository. Only an archive URL is a zip.
    const parsed = parseRepositoryUrl(raw)
    if (parsed?.kind === "reject") {
      return {
        sourceType: "unresolved", sourceId: null, localPath: null, archivePath: null,
        origin: redactSecrets(raw), authority: "none",
        reason: parsed.why, evidence: [...ev, evidence("reject", parsed.why)], inspect: null, extract: null, conflict: null,
      }
    }
    if (parsed?.kind === "git") return gitUrlResolution(parsed, ev)
    if (parsed?.kind === "archive") {
      const url = parsed.url || raw
      return {
        sourceType: "url", sourceId: sha12(url), localPath: null, archivePath: null,
        origin: redactSecrets(url), authority: "explicit-url",
        reason: parsed.why || "explicitly provided archive URL — local-first ladder tier 4 (download + inspect)",
        evidence: [...ev, evidence("url", redactSecrets(url))], inspect: null,
        extract: { needed: true, url, dest: path.join(SOURCES_DIR, sha12(url)) }, conflict: null,
      }
    }
    if (/^https?:\/\//i.test(raw)) {
      if (/github\.com|codeload\.github\.com/i.test(raw)) {
        return {
          sourceType: "unresolved", sourceId: null, localPath: null, archivePath: null,
          origin: redactSecrets(raw), authority: "none",
          reason: "not a GitHub repository checkout — refusing to download it as an archive",
          evidence: [...ev, evidence("reject", "github URL is not a repository or an archive")], inspect: null, extract: null, conflict: null,
        }
      }
      return {
        sourceType: "url", sourceId: sha12(raw), localPath: null, archivePath: null,
        origin: redactSecrets(raw), authority: "explicit-url",
        reason: "explicitly provided https URL — local-first ladder tier 4 (download + inspect)",
        evidence: [...ev, evidence("url", redactSecrets(raw))], inspect: null,
        extract: { needed: true, url: raw, dest: path.join(SOURCES_DIR, sha12(raw)) }, conflict: null,
      }
    }
    return {
      sourceType: "unresolved", sourceId: null, localPath: null, archivePath: null,
      origin: redactSecrets(raw), authority: "none",
      reason: `input "${redactSecrets(raw)}" does not exist locally and is not a URL — refusing to guess (never fabricate a source)`,
      evidence: [...ev, evidence("miss", `stat failed for ${p}; not a URL`)], inspect: null, extract: null, conflict: null,
    }
  }

  // --- implicit: the current workspace -------------------------------------
  const inspect = inspectProjectDir(base)
  ev.push(evidence("workspace", `cwd ${base} (${inspect.fileCount} files, manifests=[${inspect.manifests.slice(0, 6).join(",")}])`))
  const st = inspect.git ? "git-repo" : "workspace"
  return {
    sourceType: st, sourceId: sha12(base), localPath: base, archivePath: null,
    origin: inspect.gitRemote ?? `file://${base}`,
    authority: inspect.git ? "current-git-workspace" : "current-workspace",
    reason: `no explicit source — the current workspace is authoritative for active local work (§4)${inspect.gitRemote ? `; git remote ${inspect.gitRemote} recorded as origin, NOT as authority` : ""}`,
    evidence: ev, inspect, extract: null, conflict: null,
  }
}

/** Inspect a zip buffer WITHOUT extracting: root, manifests, languages, tests, git. */
export function inspectZipBuffer(buf) {
  const listing = listProjectZipEntries(buf)
  if (!listing) return { ok: false, root: "", manifests: [], languages: {}, tests: 0, git: false, entries: 0, truncated: false }
  const root = identifyZipRoot(listing.entries)
  const rootPrefix = root ? root + "/" : ""
  const manifests = []
  const languages = {}
  let tests = 0
  let git = false
  for (const e of listing.entries) {
    const rel = e.name.startsWith(rootPrefix) ? e.name.slice(rootPrefix.length) : e.name
    if (rel.startsWith(".git/")) git = true
    const base = rel.split("/").pop()
    if (!rel.includes("/") && ROOT_MANIFESTS.some(([m]) => m === base)) manifests.push(base)
    const ext = path.extname(base).toLowerCase()
    const lang = LANG_BY_EXT[ext]
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1
    if (/^(test|spec)_|[-.](test|spec)\./i.test(base)) tests++
  }
  return { ok: true, root, manifests, languages, tests, git, entries: listing.entries.length, truncated: listing.truncated }
}

/** Clone or reuse a git source. Never overwrites a different checkout, never
 *  follows a symlink out of the sources directory, never resets local work. */
async function materializeGit(res) {
  const dest = res.extract.dest
  if (!dest || !underSources(dest)) return { ok: false, error: "refusing a clone destination outside the sources directory" }
  const url = String(res.extract.git ?? "")
  if (!url || url.startsWith("-") || /[\s\0]/.test(url)) return { ok: false, error: "refused an unsafe git URL" }
  const branch = res.extract.branch || null
  if (branch && !isSafeGitRef(branch)) return { ok: false, error: "refused an unsafe branch name" }
  const subdir = res.extract.subdir || null
  if (subdir && !isSafeRelPath(subdir)) return { ok: false, error: "refused an unsafe subdirectory" }
  const identity = res.extract.identity || { cloneUrl: url, canonical: url, slug: null }

  let listed = null
  try { listed = fs.lstatSync(dest) } catch { listed = null }
  if (listed?.isSymbolicLink()) return { ok: false, error: "refusing to clone through a symlink" }
  if (listed && !listed.isDirectory()) return { ok: false, error: "clone destination exists and is not a directory — refusing to overwrite it" }

  const finish = async (reused) => {
    if (!gitCheckoutMatches(dest, identity)) {
      return { ok: false, error: `checkout is not ${identity.slug || redactSecrets(identity.cloneUrl)} — refusing to use it` }
    }
    let localPath = dest
    if (subdir) {
      const sub = path.resolve(dest, subdir)
      if (!realInside(dest, sub)) return { ok: false, error: "subdirectory escapes the cloned repository" }
      let st = null
      try { st = fs.statSync(sub) } catch { st = null }
      if (!st?.isDirectory()) return { ok: false, error: `subdirectory "${subdir}" does not exist in the checkout` }
      localPath = sub
    }
    return { ok: true, localPath, reused, root: dest, remote: redactSecrets(gitRemoteUrl(dest)) }
  }

  if (listed?.isDirectory() && fs.readdirSync(dest).length) {
    if (!gitCheckoutMatches(dest, identity)) {
      return { ok: false, error: "clone destination is not empty and is not the requested repository — refusing to overwrite it" }
    }
    // fetch updates remote refs only. It does not reset, clean, or checkout.
    try {
      await execFileP("git", ["fetch", "--prune", "origin"], { cwd: dest, timeout: GIT_CLONE_TIMEOUT_MS, env: cloneEnv(), maxBuffer: 1024 * 1024 })
    } catch (e) {
      return { ok: false, error: `git fetch failed: ${gitFailure(e)}` }
    }
    if (branch) {
      const have = (await gitHeadInfo(dest)).branch
      if (have !== branch) {
        if (await gitDirty(dest)) return { ok: false, error: `the existing checkout is on ${have || "a detached commit"} with uncommitted changes — not switching to ${branch}` }
        try {
          await execFileP("git", ["checkout", "-q", branch], { cwd: dest, timeout: 60000, env: cloneEnv(), maxBuffer: 1024 * 1024 })
        } catch (e) {
          return { ok: false, error: `could not check out ${branch}: ${gitFailure(e)}` }
        }
      }
    }
    return finish(true)
  }

  if (listed?.isDirectory()) {
    try { fs.rmdirSync(dest) } catch { return { ok: false, error: "clone destination exists and could not be prepared" } }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const args = ["clone", "--depth", "1", "--single-branch"]
  if (branch) args.push("--branch", branch)
  args.push("--", url, dest)
  try {
    await execFileP("git", args, { timeout: GIT_CLONE_TIMEOUT_MS, env: cloneEnv(), maxBuffer: 1024 * 1024 })
  } catch (e) {
    try { if (fs.existsSync(dest) && underSources(dest)) fs.rmSync(dest, { recursive: true, force: true }) } catch { /* a leftover partial is not entered */ }
    return { ok: false, error: `git clone failed: ${gitFailure(e)}` }
  }
  return finish(false)
}

/**
 * Materialize a resolved source: extract the archive / clone the repo /
 * download the URL into ~/.forge/sources/<id>/ and return the LOCAL project
 * directory. Idempotent — an existing extraction is REUSED and re-validated,
 * never blindly re-done (§49 zero waste). Never throws; returns { ok, error }.
 */
export async function materializeSource(res) {
  if (!res?.extract?.needed) return { ok: true, localPath: res?.localPath ?? null, reused: true }
  if (res.extract.git) return materializeGit(res)
  const dest = res.extract.dest
  try {
    if (res.extract.url) {
      await assertFetchableUrl(res.extract.url, { allowPrivate: false })
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) return { ok: true, localPath: dest, reused: true }
      const buf = await pinnedFetch(res.extract.url, { maxBytes: MAX_URL_BYTES })
      if (!isZipFile(buf)) return { ok: false, error: "URL did not return a zip archive (PK header missing)" }
      const r = extractProjectZip(buf, dest)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, localPath: dest, reused: false, files: r.files.length, root: r.root }
    }
    if (res.extract.buffer) {
      const buf = res.extract.buffer()
      const r = extractProjectZip(buf, dest)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, localPath: dest, reused: false, files: r.files.length, root: r.root }
    }
    return { ok: false, error: "no materialization strategy for this source" }
  } catch (e) {
    return { ok: false, error: redactSecrets(e?.message ?? e).slice(0, 300) }
  }
}

function sourceDecision(partial) {
  const event = {
    ok: partial.ok === true,
    action: partial.action ?? null,
    reason: partial.reason || partial.error || "",
    canonical: partial.canonical ?? null,
    branch: partial.branch ?? null,
    subdir: partial.subdir ?? null,
    localPath: partial.localPath ?? null,
    previousCwd: partial.previousCwd ?? null,
    changed: partial.changed === true,
    reused: partial.reused === true,
    head: partial.head ?? null,
    remote: partial.remote ?? null,
    error: partial.ok ? null : (partial.error || partial.reason || "source resolution failed"),
  }
  recordSourceEvent(event)
  if (partial.ok && partial.localPath && partial.action && partial.action !== "cwd") {
    process.env.FORGE_BOUND_ROOT = path.resolve(partial.localPath)
    // a folder the task named gets a writes-only shell check (tools.js); a
    // repository binding keeps its own confinement
    if (partial.kind === "local") process.env.FORGE_BOUND_KIND = "local"
    else if (!partial.fromLock) delete process.env.FORGE_BOUND_KIND
    // why this place was chosen travels with the binding: the CLI and chat
    // bind BEFORE runAgent, which then only sees "already chosen"
    if (!partial.fromLock) {
      try {
        process.env.FORGE_BOUND_INFO = JSON.stringify({
          action: partial.action, kind: partial.kind ?? null, localKind: partial.localKind ?? null, reason: partial.reason ?? null,
          focus: partial.focus ?? [], archive: partial.archive ?? null, previousCwd: partial.previousCwd ?? null, canonical: partial.canonical ?? null,
          localPath: path.resolve(partial.localPath),
        })
      } catch { /* the binding stands without its explanation */ }
    }
  }
  return { ...partial, event }
}

function enterWorkspace(localPath, { chdir, started }) {
  if (!localPath) return { ok: false, error: "source resolved without a local directory" }
  let target = localPath
  try {
    const st = fs.statSync(target)
    if (st.isFile()) target = path.dirname(target)
    else if (!st.isDirectory()) return { ok: false, error: "resolved source is not a directory" }
  } catch {
    return { ok: false, error: `resolved workspace does not exist: ${localPath}` }
  }
  const resolved = path.resolve(target)
  if (chdir && resolved !== path.resolve(process.cwd())) {
    try { process.chdir(resolved) }
    catch (e) {
      try { process.chdir(started) } catch { /* the launch directory itself could not be restored */ }
      return { ok: false, error: `cannot enter ${resolved}: ${redactSecrets(e?.message ?? e)}` }
    }
  }
  return { ok: true, path: resolved }
}

/**
 * Bind the process workspace for one user invocation.
 *
 * Precedence: explicit --source, then a resumed task's recorded directory,
 * then one clear repository the task asks to change, then the current
 * directory. A stale source record is never consulted. Failure does not
 * change the directory. `FORGE_SOURCE_LOCK=explicit|resume|bound` keeps a
 * workspace that this process already chose.
 */
/**
 * The task names a place on disk rather than a repository URL: a folder, a
 * file (→ its repository or folder), a project .zip, a folder to create, or a
 * local project by name. One tree → bound like a named repository (chdir +
 * FORGE_BOUND_ROOT); several trees → not bound, the places are reported;
 * two projects by the same name → ask.
 */
async function adoptLocalTarget({ task, started, chdir, fallbackReason }) {
  const stay = (extra = {}) => sourceDecision({ ok: true, action: "cwd", localPath: started, previousCwd: started, changed: false, reason: fallbackReason, ...extra })
  let tp, wsm
  try { tp = await import("./taskpaths.js"); wsm = await import("./workspace.js") } catch { return stay() }
  // the directory this process was first started in (chat and web keep
  // running in a bound workspace; a later task may point back to it)
  if (!process.env.FORGE_LAUNCH_CWD) process.env.FORGE_LAUNCH_CWD = started
  const launch = process.env.FORGE_LAUNCH_CWD
  // started inside a real project? then a path elsewhere is told, not bound
  const hereRoot = tp.gitRootOf(started) ?? started
  let homeReal = os.homedir()
  try { homeReal = fs.realpathSync(homeReal) } catch { /* as is */ }
  // started inside some other project: only an unmistakable reference to
  // forge moves the run out of it ("upgrade yourself", "forge's own source")
  const inOtherProject = tp.looksLikeProject(hereRoot) && hereRoot !== homeReal && !wsm.isForgeRuntime(started)
  const selfTask = wsm.taskTargetsForge(task, { cwd: started, strict: inOtherProject })
  const launchIsWorkspace = tp.looksLikeProject(hereRoot) && hereRoot !== homeReal && !(wsm.isForgeRuntime(started) && !selfTask)
  // A TASK ABOUT FORGE ITSELF ("improve forge's retry logic", "upgrade
  // yourself", "fix your own bug in agent.js") works in forge's own source
  // tree, wherever it was started — unless it names another place outright.
  const forgeRoot = wsm.forgeRuntimeRoot()
  if (selfTask && forgeRoot && !wsm.isForgeRuntime(started)) {
    const named = tp.localTargetsInTask(task, { cwd: started, launchIsWorkspace, launch })
    const elsewhere = named.action === "target" && !wsm.isForgeRuntime(named.root)
    if (!elsewhere) {
      const entered = enterWorkspace(forgeRoot, { chdir, started })
      if (entered.ok) {
        return sourceDecision({
          ok: true, action: "target", kind: "local", localKind: "self", localPath: entered.path, previousCwd: started,
          changed: entered.path !== started, reused: true, canonical: null, focus: [], outsideFiles: [],
          remote: gitRemoteUrl(entered.path), reason: "the task is about forge itself",
        })
      }
    }
  }
  let local = tp.localTargetsInTask(task, { cwd: started, launchIsWorkspace, launch })
  if (local.action === "none" && !(local.focus?.length) && !(local.outsideFiles?.length)) {
    const named = tp.namedProjectInTask(task, { cwd: started, launchIsWorkspace })
    if (named.action === "ask") return sourceDecision({ ok: false, action: "ask", error: named.reason, previousCwd: started, changed: false, reason: named.reason, candidates: named.candidates })
    if (named.action === "target") local = named
  }
  if (local.action === "spread") {
    // places in two trees: no single tree may confine the run (a move between
    // them would be refused) — release an earlier binding too
    delete process.env.FORGE_BOUND_ROOT; delete process.env.FORGE_BOUND_INFO; delete process.env.FORGE_BOUND_KIND
    return stay({ places: local.places, reason: local.reason })
  }
  if (local.action !== "target") return stay({ focus: local.focus ?? [], outsideFiles: local.outsideFiles ?? [] })
  let root = local.root
  if (local.kind === "zip") {
    const r = await activateSource(root, { cwd: started })
    if (!r.ok) return sourceDecision({ ok: false, action: "stop", error: r.error, previousCwd: started, changed: false, reason: r.error })
    root = r.localPath
  }
  if (local.create) {
    try { fs.mkdirSync(root, { recursive: true }) } catch (e) {
      return sourceDecision({ ok: false, action: "stop", error: `could not create ${root}: ${redactSecrets(e?.message ?? e)}`, previousCwd: started, changed: false, reason: "create failed" })
    }
  }
  const entered = enterWorkspace(root, { chdir, started })
  if (!entered.ok) return sourceDecision({ ok: false, action: "stop", error: entered.error, previousCwd: started, changed: false, reason: entered.error })
  return sourceDecision({
    ok: true, action: "target", kind: "local", localKind: local.kind, localPath: entered.path, previousCwd: started,
    changed: entered.path !== started, reused: true, canonical: null, focus: local.focus ?? [], outsideFiles: local.outsideFiles ?? [],
    created: local.create === true, archive: local.kind === "zip" ? local.root : null,
    remote: gitRemoteUrl(entered.path), reason: local.reason,
  })
}

export async function adoptInvocationSource({ explicit = null, task = "", cwd = process.cwd(), resumeCwd = null, chdir = true } = {}) {
  const started = path.resolve(cwd)
  const lock = process.env.FORGE_SOURCE_LOCK
  if ((lock === "explicit" || lock === "resume" || lock === "bound") && !explicit) {
    const here = enterWorkspace(started, { chdir, started })
    if (!here.ok) return sourceDecision({ ok: false, action: "stop", error: here.error, previousCwd: started, changed: false, reason: here.error })
    // the binding made earlier in this invocation, with its reason and focus
    let info = null
    try { info = process.env.FORGE_BOUND_INFO ? JSON.parse(process.env.FORGE_BOUND_INFO) : null } catch { info = null }
    if (lock === "bound" && info && info.localPath && path.resolve(info.localPath) === here.path) {
      return sourceDecision({ ok: true, ...info, localPath: here.path, changed: false, reused: true, fromLock: true })
    }
    return sourceDecision({ ok: true, action: lock === "explicit" ? "explicit" : "cwd", localPath: here.path, previousCwd: started, changed: false, reused: true, reason: "this invocation already chose its workspace" })
  }

  if (explicit) {
    const r = await activateSource(String(explicit), { cwd: started })
    if (!r.ok) return sourceDecision({ ok: false, action: "stop", error: r.error, resolution: r.resolution, previousCwd: started, changed: false, fallback: false, reason: r.error })
    const root = r.resolution?.extract?.dest
    const ident = r.resolution?.extract?.identity
    if (root && ident && !gitCheckoutMatches(root, ident)) {
      return sourceDecision({ ok: false, action: "stop", error: "cloned repository identity does not match the requested repository", previousCwd: started, changed: false, reason: "identity mismatch" })
    }
    const entered = enterWorkspace(r.localPath, { chdir, started })
    if (!entered.ok) return sourceDecision({ ok: false, action: "stop", error: entered.error, resolution: r.resolution, previousCwd: started, changed: false, reason: entered.error })
    const info = root ? await gitHeadInfo(root) : { head: null, branch: null }
    return sourceDecision({
      ok: true, action: "explicit", localPath: entered.path, previousCwd: started,
      changed: entered.path !== started, reused: r.reused === true, resolution: r.resolution,
      canonical: r.resolution?.canonical ?? null, branch: r.resolution?.branch ?? info.branch, subdir: r.resolution?.subdir ?? null,
      head: info.head, remote: root ? gitRemoteUrl(root) : null, reason: "explicit --source",
    })
  }

  if (typeof resumeCwd === "string") {
    if (!resumeCwd.trim()) {
      return sourceDecision({ ok: false, action: "stop", error: "the resumed task has no recorded workspace — not falling back to the current directory", previousCwd: started, changed: false, reason: "resume workspace missing" })
    }
    const recorded = path.resolve(resumeCwd)
    let isDir = false
    try { isDir = fs.statSync(recorded).isDirectory() } catch { isDir = false }
    if (!isDir) {
      return sourceDecision({ ok: false, action: "stop", error: `the resumed workspace does not exist (${recorded}) — not falling back to the current directory`, previousCwd: started, changed: false, reason: "resume workspace missing" })
    }
    const entered = enterWorkspace(recorded, { chdir, started })
    if (!entered.ok) return sourceDecision({ ok: false, action: "stop", error: entered.error, previousCwd: started, changed: false, reason: entered.error })
    return sourceDecision({ ok: true, action: "resume", localPath: entered.path, previousCwd: started, changed: entered.path !== started, reused: true, reason: "resumed the workspace recorded for this task" })
  }

  const intent = repoIntentInTask(task, { cwd: started })
  if (intent.action === "ambiguous") {
    const listed = (intent.urls || []).map((u) => redactSecrets(u)).join(", ")
    const error = listed ? `${intent.reason}: ${listed}` : intent.reason
    return sourceDecision({ ok: false, action: "ask", error, previousCwd: started, changed: false, reason: intent.reason, urls: intent.urls || [] })
  }
  if (intent.action !== "target") {
    // no repository URL: does the task name a folder, file, archive or local
    // project instead? (taskpaths.js) — bound exactly like a named repository
    return await adoptLocalTarget({ task, started, chdir, fallbackReason: intent.reason })
  }

  const parsed = intent.parsed
  const root = matchingCheckout(started, parsed)
  if (root) {
    let local = started
    if (parsed.subdir) {
      if (!isSafeRelPath(parsed.subdir)) return sourceDecision({ ok: false, action: "stop", error: "refused an unsafe subdirectory", previousCwd: started, changed: false, reason: "unsafe subdirectory" })
      const sub = path.resolve(root, parsed.subdir)
      let isDir = false
      try { isDir = fs.statSync(sub).isDirectory() } catch { isDir = false }
      if (!realInside(root, sub) || !isDir) {
        return sourceDecision({ ok: false, action: "stop", error: `subdirectory "${parsed.subdir}" is not inside the checkout`, previousCwd: started, changed: false, reason: "subdirectory missing" })
      }
      local = sub
    }
    if (parsed.branch) {
      const have = (await gitHeadInfo(root)).branch
      if (have !== parsed.branch) {
        if (await gitDirty(root)) {
          return sourceDecision({ ok: false, action: "stop", error: `this checkout is on ${have || "a detached commit"} with uncommitted changes — not switching to ${parsed.branch}`, previousCwd: started, changed: false, reason: "dirty checkout" })
        }
        try {
          await execFileP("git", ["checkout", "-q", parsed.branch], { cwd: root, timeout: 60000, env: cloneEnv(), maxBuffer: 1024 * 1024 })
        } catch (e) {
          return sourceDecision({ ok: false, action: "stop", error: `could not check out ${parsed.branch}: ${gitFailure(e)}`, previousCwd: started, changed: false, reason: "branch checkout failed" })
        }
      }
    }
    const entered = enterWorkspace(local, { chdir, started })
    if (!entered.ok) return sourceDecision({ ok: false, action: "stop", error: entered.error, previousCwd: started, changed: false, reason: entered.error })
    const info = await gitHeadInfo(root)
    return sourceDecision({
      ok: true, action: "reuse-workspace", localPath: entered.path, previousCwd: started,
      changed: entered.path !== started, reused: true, canonical: parsed.canonical, branch: parsed.branch || info.branch, subdir: parsed.subdir || null,
      head: info.head, remote: gitRemoteUrl(root), reason: "the current checkout is already the requested repository",
      focus: parsed.file ? [parsed.file] : [],
    })
  }

  const activated = await activateSource(intent.url, { cwd: started })
  if (!activated.ok) {
    return sourceDecision({ ok: false, action: "stop", error: activated.error, resolution: activated.resolution, previousCwd: started, changed: false, fallback: false, canonical: parsed.canonical, reason: activated.error })
  }
  const cloneRoot = activated.resolution?.extract?.dest
  const ident = activated.resolution?.extract?.identity
  if (!cloneRoot || !ident || !gitCheckoutMatches(cloneRoot, ident)) {
    return sourceDecision({ ok: false, action: "stop", error: "cloned repository identity does not match the requested repository", previousCwd: started, changed: false, canonical: parsed.canonical, reason: "identity mismatch" })
  }
  const entered = enterWorkspace(activated.localPath, { chdir, started })
  if (!entered.ok) return sourceDecision({ ok: false, action: "stop", error: entered.error, previousCwd: started, changed: false, reason: entered.error })
  if (path.resolve(entered.path) === started) {
    try { process.chdir(started) } catch { /* already there */ }
    return sourceDecision({ ok: false, action: "stop", error: "refusing to stay in the launch directory — it is not the requested repository", previousCwd: started, changed: false, reason: "refused launch directory" })
  }
  const info = await gitHeadInfo(cloneRoot)
  return sourceDecision({
    ok: true, action: "target", localPath: entered.path, previousCwd: started,
    changed: true, reused: activated.reused === true, resolution: activated.resolution,
    canonical: parsed.canonical, branch: parsed.branch || info.branch, subdir: parsed.subdir || null,
    head: info.head, remote: gitRemoteUrl(cloneRoot), reason: intent.reason,
    focus: parsed.file ? [parsed.file] : [],
  })
}

/**
 * One-shot helper for CLI/chat/agent entry points: resolve `input` (or the
 * workspace), materialize when needed, persist the source record for the
 * FINAL local directory, and return { resolution, localPath, record }.
 * On an unresolvable input the result is { ok:false, error } — the caller
 * must stop, never proceed on a guessed source.
 */
export async function activateSource(input, { cwd = process.cwd() } = {}) {
  const res = resolveSource(input, { cwd })
  if (res.sourceType === "unresolved") return { ok: false, error: res.reason, resolution: res }
  const mat = await materializeSource(res)
  if (!mat.ok) return { ok: false, error: mat.error, resolution: res }
  const localPath = mat.localPath ?? res.localPath
  const record = saveSourceRecord(localPath, {
    sourceType: res.sourceType,
    sourceId: res.sourceId,
    localPath,
    archivePath: res.archivePath,
    origin: res.origin,
    authority: res.authority,
    reason: res.reason,
    evidence: res.evidence,
    conflict: res.conflict,
    canonical: res.canonical ?? null,
    branch: res.branch ?? null,
    subdir: res.subdir ?? null,
    remote: mat.remote ?? null,
  })
  return { ok: true, resolution: res, localPath, record, reused: mat.reused === true, remote: mat.remote ?? null }
}

/** Human-readable one-line summary of a resolution (CLI/banner). */
export function formatSource(res, { maxChars = 200 } = {}) {
  if (!res) return ""
  const bits = [`source: ${res.sourceType}`, res.localPath ? `local: ${res.localPath}` : null, res.archivePath ? `archive: ${res.archivePath}` : null, res.origin ? `origin: ${res.origin}` : null, `authority: ${res.authority}`]
  let s = bits.filter(Boolean).join(" • ")
  if (res.reason) s += `\n  why: ${res.reason}`
  return s.slice(0, maxChars * 2)
}

/**
 * Ensure the workspace has a source record (§4 persistence on the implicit
 * path too). Idempotent: an existing record is NEVER overwritten by an
 * implicit resolution — only explicit --source runs re-record authority.
 * Best-effort; returns the record or null.
 */
export function ensureWorkspaceSource(cwd = process.cwd()) {
  try {
    const existing = readSourceRecord(cwd)
    if (existing) return existing
    const res = resolveSource(null, { cwd })
    return saveSourceRecord(cwd, {
      sourceType: res.sourceType,
      sourceId: res.sourceId,
      localPath: res.localPath,
      archivePath: res.archivePath,
      origin: res.origin,
      authority: res.authority,
      reason: res.reason,
      evidence: res.evidence,
      conflict: res.conflict,
    })
  } catch { return null }
}
