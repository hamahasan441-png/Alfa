/**
 * forge — agent tools (zero dependencies, Node built-ins only)
 *
 * bash, read_file, read_image, write_file, edit_file, multi_edit, apply_patch, list_dir, glob_files,
 * grep_files, fetch_url, web_search, browser, todo, think, memory, delegate, load_skill, git_status,
 * git_diff, git_log, git_blame, github, process, repl, semantic_search
 * (25 tools — v93 "sensewise": background processes, persistent REPL, meaning-ranked code search)
 *
 * v20 hardening:
 *   - safePath: project-boundary enforcement for WRITES, symlink escape checks,
 *     sensitive-file protection for READS (.env, .ssh, keys, credentials, …)
 *   - bash: structural command risk classification (shellguard.js) instead of
 *     regex-only blocking; sudo needs consent; targets outside the project are
 *     refused for the model
 *   - fetch_url: SSRF guard (netguard.js) — DNS resolution + private/loopback/
 *     link-local/metadata/IPv6 checks, DNS-rebinding safe
 *   - load_skill: traversal-safe name validation
 *   - every tool RESULT is secret-redacted (secrets.js) before it enters
 *     conversation history / sessions
 *   - delegate: roles (researcher/reviewer/tester/security/coder), timeout,
 *     concurrency cap, depth guard; no longer misclassified as a write tool
 *   - checkpoints also track CREATED files → undo removes them (hash-verified)
 *   - memory: hierarchical (global + project) with relevance retrieval and
 *     structured failure learning
 */
import { execFile, spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import fs from "node:fs"
import { VERSION } from "./version.js"
import os from "node:os"
import path from "node:path"
import { snapshotBefore, sealCreated, sealEdited, restoreTransactional } from "./checkpoint.js"
import { parsePatch, applyParsedPatch } from "./diffpatch.js"
import { classifyCommand, modelMayRun } from "./shellguard.js"
import { wrapBash, reprobeKernelSupport } from "./sandbox.js"
import { signalGroup } from "./runtime.js"
import { resolveShell } from "./sysshell.js"
import { rewritePythonSkillCommand, pythonEnvironment } from "./python-runtime.js"
import { pinnedFetch, PinnedFetchError } from "./netguard.js"
import { redact } from "./secrets.js"
import { DEFAULT_DIR, AGENT_BUDGETS } from "./config.js"
import { appendMemory, recordLearning, replaceKeepingRules, forgetMatching, projectMemoryPath } from "./memory.js"
import { secureWriteFile, secureUnlink, secureOpenRead, SecureFsError, writeStateFile } from "./securefs.js"
import { generatedBoundary } from "./langengine.js"
import { readLearnedSkill } from "./evolve.js"
import { readLearnedPlaybookByName } from "./extend.js"
import { readDownloadedSkill, readDownloadedToolPlaybook } from "./skilldl.js"
import { playbookText } from "./playbooks.js"
import { createCommandResult, formatCommandResult } from "./cmdout.js"
import { looksLikeCheck, splitOutputFilter, applyOutputFilter, rewriteChecks, checkStatusLines, endsInHead, headLines } from "./checkcmd.js"
import { randomBytes } from "node:crypto"
import {
  loadLocalImage, formatImageToolResult, queuePendingVision,
  providerSupportsVision, MAX_IMAGE_BYTES, MAX_PENDING, isRemotePath,
} from "./vision.js"
// v179: the browser driver loads when the browser tool is first used; the
// classification predicates (asked of every call) come from a leaf module
import { browserMutatesFilesystem, isPageMutating, isVerifyAction } from "./browserpolicy.js"
import { createProcessManager } from "./runtime.js"
import { createRuntimeSession, formatDiscovery } from "./runtimesession.js"
import { createReplManager } from "./repl.js"
import { ghInspect, formatGithub } from "./github.js"
import { assessPlan, gatherPlannerEvidence, alternatives } from "./plannerisk.js"
// v179: tool-only subsystems load on first use, not at every agent boot —
// the browser driver, semantic search, the world model and engineering memory
// were ~275KB of module graph that most runs never touch
let _browserMod = null
export const loadBrowser = () => (_browserMod ??= import("./browser.js"))
/** True once the browser driver was loaded (so there may be a session to close). */
export const browserLoaded = () => _browserMod !== null
const loadCodesearch = () => import("./codesearch.js")
const loadWorldModel = () => import("./worldmodel.js")
const loadEngMemory = () => import("./engmemory.js")

// ---------------------------------------------------------------------------
// path security — project boundary + sensitive files
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// forge's own state lives wherever FORGE_HOME points (default ~/.forge) —
// patterns are built at runtime so a custom home is protected identically
const FORGE_SENSITIVE = [
  [new RegExp(`(^|/)${escapeRe(path.join(DEFAULT_DIR, "config.json"))}$`), "forge config (holds API keys)"],
  [new RegExp(`(^|/)${escapeRe(path.join(DEFAULT_DIR, "sessions"))}/`), "saved chat sessions (private)"],
]

const SENSITIVE_PATTERNS = [
  [/(^|\/)\.env($|\.)/i, "environment secrets file (.env)"],
  [/(^|\/)\.ssh\//i, "SSH directory"],
  [/\/id_(rsa|dsa|ed25519|ecdsa)$/i, "SSH private key"],
  [/\.(pem|key|p12|pfx|keystore)$/i, "key / certificate file"],
  [/(^|\/)\.aws\/|(^|\/)\.gnupg\/|(^|\/)\.kube\/|(^|\/)\.config\/gcloud\//i, "credentials store"],
  [/(^|\/)credentials($|\.)|(^|\/)service[-_]?account[^\/]*\.json$/i, "credentials file"],
  [/(^|\/)\.netrc$|(^|\/)\.npmrc$|(^|\/)\.docker\/config\.json$/i, "file with stored tokens"],
  [/(^|\/)(secrets?|passwords?)[^\/]*\.(json|ya?ml|toml|ini|cfg|txt)$/i, "secrets file"],
  [/^\/etc\/(shadow|gshadow|sudoers)$/i, "system secrets file"],
  ...FORGE_SENSITIVE,
]

function sensitiveReason(target) {
  if (!target) return null
  const norm = String(target).split(path.sep).join("/")
  for (const [re, why] of SENSITIVE_PATTERNS) {
    if (re.test(norm)) return why
  }
  return null
}

function insideDir(target, dir) {
  if (!target || !dir) return false
  const rel = path.relative(path.resolve(dir), path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** realpath with nearest-existing-ancestor fallback (for not-yet-existing
 *  targets) — catches symlink escapes on both existing and new paths. */
function realPathOf(abs) {
  try {
    return fs.realpathSync(abs)
  } catch {
    let dir = path.dirname(abs)
    const rest = [path.basename(abs)]
    let guard = 0
    while (!fs.existsSync(dir) && guard++ < 64) {
      rest.unshift(path.basename(dir))
      dir = path.dirname(dir)
    }
    try {
      return path.join(fs.realpathSync(dir), ...rest)
    } catch {
      return abs
    }
  }
}

/**
 * Resolve + validate a tool path.
 *  write=false (read/scan): allowed anywhere (v88 noguard — sensitive-file
 *    read protection removed with the rest of the guards; secrets.js redaction
 *    still masks known key shapes in tool RESULTS before the model sees them).
 *  write=true: allowed anywhere (v88 noguard — the project write boundary is
 *    gone). Generated dirs (dist/.next/target/node_modules/…) are still
 *    refused unless ctx.allowGeneratedWrites is set — that is a correctness
 *    guard (edit the source, not the build output), not a permission gate.
 * Returns { ok, abs, error }.
 */
export function safePath(ctx, p, { write = false } = {}) {
  const rel = String(p ?? "").trim()
  if (!rel) return { ok: false, abs: null, error: "ERROR: empty path" }
  // v20: expand ~ like a shell would
  const expanded = rel === "~" || rel.startsWith("~/") ? path.join(os.homedir(), rel.slice(1)) : rel
  const abs = path.resolve(ctx.cwd, expanded)
  const real = realPathOf(abs)
  if (write) {
    if (!ctx.allowGeneratedWrites) {
      const gen = generatedBoundary(abs, ctx.root ?? ctx.cwd) || generatedBoundary(real, ctx.root ?? ctx.cwd)
      if (gen) {
        return {
          ok: false, abs, real,
          error: `ERROR: write target is inside generated directory ${gen} (${path.relative(ctx.root ?? ctx.cwd, abs).slice(0, 60)}) — edit the source, not ${gen}`,
        }
      }
    }
    return { ok: true, abs, real }
  }
  // v88 noguard: reads are unrestricted
  return { ok: true, abs, real }
}

// ---------------------------------------------------------------------------
// v21.1 P0 — secure project writes (TOCTOU / symlink-race resistant)
// ---------------------------------------------------------------------------
//
// safePath() is the POLICY check (boundary, sensitive files, opt-outs). It is
// not, by itself, a safe write: it computes realpath at validation time and a
// later writeFileSync() follows whatever the path resolves to at WRITE time.
// projectWrite()/projectUnlink() close that window by anchoring the parent
// directory with O_NOFOLLOW component-by-component, verifying the anchored
// directory is still inside the project, and committing through a
// descriptor-relative temp → fsync → rename (see securefs.js).
//
// In-project symlinks are still honoured the way the old code honoured them:
// a link whose target is INSIDE the project is followed once (via realpath,
// then re-verified). v88 noguard: a link that points outside is written
// through its parent anchor (atomic, no final-component following) instead
// of being refused.

function resolveWriteAnchor(ctx, abs) {
  const root = ctx.root ?? ctx.cwd
  let rootReal
  try { rootReal = fs.realpathSync(root) } catch { rootReal = path.resolve(root) }
  const logical = path.resolve(abs)

  // Trailing symlink: never follow the final component unless the dest is
  // inside the project (in-project aliases). allowOutsideProject does not
  // follow a trailing symlink that lands outside — atomicWriteInDir then
  // refuses ESYMLINK on the logical name, so /etc/hostname is never opened.
  let trailingLink = false
  try { trailingLink = fs.lstatSync(logical).isSymbolicLink() } catch {}
  if (trailingLink) {
    const dest = realPathOf(logical)
    if (insideDir(dest, rootReal)) return { root: rootReal, target: dest }
    const parent = path.dirname(logical)
    let parentReal
    try { parentReal = fs.realpathSync(parent) } catch { parentReal = parent }
    if (insideDir(parentReal, rootReal)) return { root: rootReal, target: logical }
    // v88 noguard: no project boundary — anchored at the target's real parent,
    // still no symlink-following on the final component, still atomic.
    return { root: parentReal, target: logical }
  }

  const real = realPathOf(abs)
  if (insideDir(real, rootReal)) return { root: rootReal, target: real }
  if (insideDir(logical, rootReal) && !fs.existsSync(abs)) return { root: rootReal, target: logical }
  // v88 noguard: writes outside the project are allowed — anchored at the
  // target's real parent, atomic, still no trailing-symlink following.
  return { root: path.dirname(real), target: real }
}

/** Secure, atomic write of `abs` (already policy-checked by safePath). Returns the physical path written. */
function projectWrite(ctx, abs, content) {
  const { root, target } = resolveWriteAnchor(ctx, abs)
  return secureWriteFile(root, target, content).real
}

/**
 * Anchor a READ the way resolveWriteAnchor anchors a write.
 *
 * v88 keeps reads unrestricted (safePath does not gate them), so this is not a
 * boundary check — it picks the directory the open is anchored to so that every
 * component is opened with O_NOFOLLOW and the directory chain cannot be swapped
 * between the check and the read. Writes have been descriptor-relative since
 * v21.1; reads were still `fs.openSync(path)`, which is the asymmetry this
 * closes.
 *
 * A symlinked FILE stays readable: repos alias configs and vendored sources on
 * purpose, so the trailing link is followed ONCE here and the DESTINATION is
 * what gets opened with O_NOFOLLOW. The race being closed is the path changing
 * underneath the tool, not an alias the user put there deliberately.
 */
function resolveReadAnchor(ctx, abs) {
  const root = ctx.root ?? ctx.cwd
  let rootReal
  try { rootReal = fs.realpathSync(root) } catch { rootReal = path.resolve(root) }
  const logical = path.resolve(abs)
  let trailingLink = false
  try { trailingLink = fs.lstatSync(logical).isSymbolicLink() } catch {}
  const real = realPathOf(trailingLink ? realPathOf(logical) : logical)
  if (insideDir(real, rootReal)) return { root: rootReal, target: real }
  // Outside the project: anchored at the target's own parent, so the component
  // chain is still opened with O_NOFOLLOW even though there is no boundary.
  return { root: path.dirname(real), target: real }
}

/** Secure, descriptor-relative open of `abs` for reading. Caller closes `fd`. */
function projectOpenRead(ctx, abs) {
  const { root, target } = resolveReadAnchor(ctx, abs)
  return secureOpenRead(root, target)
}

/** Honest text for a failed read, preserving the historical messages. */
function readErrorText(e, p) {
  if (e instanceof SecureFsError) {
    if (e.code === "ESYMLINK") return `ERROR: refusing to read through a symbolic link (${e.component ?? path.basename(p)}) — the path changed underneath the tool`
    if (e.code === "EESCAPE") return `ERROR: read target escapes the anchored directory — ${e.message}`
    if (e.code === "ENOTFILE" || e.code === "EISDIR") {
      try { if (fs.statSync(p).isDirectory()) return `ERROR: is a directory: ${p}` } catch {}
      return `ERROR: not a regular file: ${p}`
    }
  }
  if (e?.code === "ENOENT") return `ERROR: not found: ${p}`
  if (e?.code === "EISDIR") return `ERROR: is a directory: ${p}`
  if (e?.code === "ELOOP") return `ERROR: refusing to read through a symbolic link (${path.basename(p)}) — the path changed underneath the tool`
  if (e?.code === "EACCES" || e?.code === "EPERM") return `ERROR: permission denied: ${p}`
  return `ERROR: cannot read ${p}: ${String(e?.message ?? e).slice(0, 160)}`
}

/** Secure unlink of `abs` (already policy-checked). Returns true when removed. */
function projectUnlink(ctx, abs) {
  const { root, target } = resolveWriteAnchor(ctx, abs)
  return secureUnlink(root, target)
}

function writeErrorText(e, p) {
  if (e instanceof SecureFsError) {
    if (e.code === "EESCAPE") return `ERROR: write target escapes the project directory — ${e.message}`
    if (e.code === "ESYMLINK") return `ERROR: refusing to write through a symbolic link (${e.component ?? path.basename(p)}) — the path changed underneath the tool`
    if (e.code === "ENOTDIR") return `ERROR: a path component is not a directory (${e.component ?? p})`
    if (e.code === "EISDIR") return `ERROR: is a directory: ${p}`
    return `ERROR: ${e.message}`
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") return `ERROR: permission denied writing ${p}`
  if (e?.code === "ENOSPC") return `ERROR: no space left on device writing ${p}`
  if (e?.code === "ELOOP") return `ERROR: refusing to write through a symbolic link (${p})`
  return `ERROR: write failed (${e?.code ?? "?"}): ${String(e?.message ?? e).slice(0, 160)}`
}

// ---------------------------------------------------------------------------
// tool definitions (wire schema)
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the working directory. Use for builds, tests, git, installs. Output is capped and secret-redacted. No command restrictions (v88 full control).",
      // v125: this said "default 45" while the real default was 180 and the
      // cap 900. A model that wants more room than it is told it has raises
      // the number by hand — which is how a run came to ask for 240s on a
      // suite that needs minutes, get killed at exit 124, and be ordered to
      // REPAIR working code. Read both numbers from the budget so the
      // description cannot drift from the behaviour again.
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_sec: { type: "number", description: `max seconds (default ${AGENT_BUDGETS.timeoutSec}, cap ${AGENT_BUDGETS.bashTimeoutCapSec})` } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Git snapshot of the working directory: branch, changed files, recent commits, diffstat. Use it before editing to understand repo state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Unified diff of changes, token-budgeted. base: 'HEAD' (default — all uncommitted changes), 'stage' (staged only), 'worktree' (unstaged only), or any commit/branch/tag (working tree vs it). Optional path filter, context lines, max_lines budget — long diffs are truncated with a diffstat so context is never blown. Use it to review exactly what changed (yours or the run's) before answering or committing.",
      parameters: { type: "object", properties: {
        base: { type: "string", description: "what to diff against: 'HEAD' (default), 'stage', 'worktree', or a commit/branch/tag" },
        path: { type: "string", description: "limit the diff to this file or directory" },
        context: { type: "number", description: "context lines around hunks (default 3, 0–10)" },
        max_lines: { type: "number", description: "diff line budget (default 400, max 2000)" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Compact commit history: hash, date, author, subject. Optional path filter and per-commit diffstat (stat=true). Use it to read recent intent before editing an area.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "only commits touching this file or directory" },
        limit: { type: "number", description: "max commits (default 15, max 50)" },
        stat: { type: "boolean", description: "include a diffstat per commit (default false)" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_blame",
      description: "Line provenance for a tracked file: commit, author, date per line (start/end window, max 200 lines). Use it to find when and why a line changed. Untracked files are reported as such.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "file to blame (required)" },
        start: { type: "number", description: "first line (default 1)" },
        end: { type: "number", description: "last line (default start+39)" },
      }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "github",
      description: "READ-ONLY GitHub evidence via your gh CLI (no forge-held token). action: status|repo|issues|issue|prs|pr|checks|runs|run|releases. Optional id for issue/pr/checks/run. Writes (push, PR create) are gitship, never this tool.",
      parameters: { type: "object", properties: {
        action: { type: "string", description: "status, repo, issues, issue, prs, pr, checks, runs, run, releases (default repo)" },
        id: { type: "string", description: "issue/PR/run number or ref when required" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Returns content with line numbers. Sensitive files (.env, keys, credentials) are protected.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number", description: "1-based start line" }, limit: { type: "number", description: "max lines (default 400)" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_image",
      description: "Read a local raster image (png/jpeg/gif/webp) and attach it for vision-capable models. Returns mime, pixel size, and byte size. Remote URLs and SVG are refused (the provider accepts neither as an image part — it is a capability limit, not a permission). When the provider cannot accept image parts, only metadata is returned — pixels are never faked.",
      parameters: { type: "object", properties: { path: { type: "string", description: "local file path (not a URL)" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with content (parents auto-created, auto-checkpointed — undo removes created files). Writes must stay inside the project directory.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Exact string replacement in a file. old must appear exactly once unless replace_all=true. Auto-checkpointed.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old", "new"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a directory (recursive to depth 2, skips node_modules/.git/.next).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Regex search across files under a directory. Returns path:line: matches.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string", description: "e.g. *.ts" }, max: { type: "number" } }, required: ["pattern"] },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load the full instructions of an installed skill by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page or JSON API over http(s) and return its text content (HTML tags stripped, capped, secret-redacted). Private/loopback/metadata targets are allowed (v88); the transport still pins the validated IP to the socket and refuses a DNS-rebinding redirect.",
      parameters: { type: "object", properties: { url: { type: "string", description: "absolute http(s) URL" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Find files by glob pattern (supports ** recursive). Newest first. Use to locate files fast.",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "e.g. src/**/*.ts or *.md" }, path: { type: "string", description: "root dir (default cwd)" }, max: { type: "number" } }, required: ["pattern"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return the top results (title + URL + snippet). Use for facts, docs, news.",
      parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number", description: "max results (default 6)" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser",
      description: "Drive a real browser to open, snapshot, click, fill, and screenshot pages. Opt-in binary (chromium or agent-browser). Missing binary returns UNAVAILABLE — the turn continues. http(s) URLs are SSRF-guarded; file:// stays inside the project; javascript:/data: refused. Screenshot pixels attach as vision parts when the provider can see. `errors` lists captured console/page-log/network-load errors — UI verification evidence (a rendering page with errors is NOT verified). `visual_diff {name}` captures a snapshot+ screenshot baseline on first run, then COMPARES later runs (text diff + pixel hash) — visual regression evidence; `update:true` re-baselines.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "snapshot", "click", "fill", "type", "press", "screenshot", "scroll", "back", "reload", "close", "status", "errors", "visual_diff"], description: "open | snapshot | click | fill | type | press | screenshot | scroll | back | reload | close | status | errors | visual_diff (regression baseline compare)" },
          url: { type: "string", description: "absolute http(s) URL, file:// inside the project, or about:blank (open)" },
          ref: { type: "string", description: "interactive ref from snapshot, e.g. @e1" },
          selector: { type: "string", description: "CSS selector when no ref" },
          text: { type: "string", description: "fill/type text" },
          key: { type: "string", description: "key to press (Enter, Tab, Escape, …)" },
          path: { type: "string", description: "optional project path to save a screenshot" },
          amount: { type: "number", description: "scroll pixels (default 500)" },
          name: { type: "string", description: "visual_diff baseline name (1-64 chars)" },
          update: { type: "boolean", description: "visual_diff: re-baseline explicitly (update:true)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description: "Apply MULTIPLE exact string replacements to one file atomically. All edits validated first, then written once. Fails if any old string is missing.",
      parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old", "new"] } } }, required: ["path", "edits"] },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a standard unified diff (patch) to one or more files ATOMICALLY. Supports creation (--- /dev/null), deletion (+++ /dev/null), @@ hunks with context. Whole patch validated before anything is written; original files are auto-checkpointed; undo removes files the patch created.",
      parameters: { type: "object", properties: { patch: { type: "string", description: "unified diff text with ---/+++/@@ sections" } }, required: ["patch"] },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Track a task list for multi-step work: set the full list, list current state, or update one item's status. Statuses: todo | doing | done.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "list", "update"] }, items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } }, required: ["content"] } }, id: { type: "number" }, status: { type: "string" } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "think",
      description: "Reasoning scratchpad: think step by step, plan tool usage, or reflect — zero side effects. Use before complex edits.",
      parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description: "Persistent memory across sessions: read notes, append a fact/preference, record a learned fix (problem → root cause → fix), or replace notes. scope: project (default — anything about this repo) or global (only what is true of the user in every project, e.g. preferences). When the USER states a standing rule for future work (\"from now on…\", \"always…\", \"never…\"), append it with rule=true, quoting their words exactly: it then reaches every later run. forget removes one note named by its text; to remove one of the user's rules, quote the user's own words naming it. replace rewrites the notes but always keeps the user's rules. Secrets are auto-redacted.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "append", "replace", "learn", "forget"] }, text: { type: "string", description: "note text (append/replace)" }, rule: { type: "boolean", description: "append only: this is a standing rule the user stated in their own request. text must quote their words exactly; anything else is saved as an ordinary note" }, scope: { type: "string", enum: ["global", "project"], description: "project (default): about this repo — its code, conventions, fixes, tasks. global: about the user, true in every project (preferences). A read without scope shows both" }, problem: { type: "string", description: "learn: what went wrong" }, root_cause: { type: "string", description: "learn: the underlying cause" }, fix: { type: "string", description: "learn: what actually fixed it" } }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate",
      description: "Spawn a read-only sub-agent to work a subtask and report a summary (it can read/glob/grep/list/fetch but NOT write). Use for investigation that would flood the main context. role tunes its focus: researcher | reviewer | tester | security | coder.",
      parameters: { type: "object", properties: { task: { type: "string" }, role: { type: "string", enum: ["researcher", "reviewer", "tester", "security", "coder"], description: "sub-agent focus (default researcher)" } }, required: ["task"] },
    },
  },
  {
    type: "function",
    function: {
      name: "process",
      description: "Run and manage BACKGROUND processes that survive this tool call (dev servers, watchers, long builds). bash dies after ~45s and cannot keep a server running; this can — spawn, then poll for new output while you browser-test or edit code. Actions: spawn | poll | status | kill | list. Ports are DETECTED from output and the OS socket table — an empty ports list means none detected, never a guess. Background processes are killed when forge exits.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["spawn", "poll", "status", "kill", "list"], description: "what to do" },
        command: { type: "string", description: "shell command to run in the background (spawn)" },
        id: { type: "string", description: "process id for poll/status/kill (p1, p2, … or a name you chose)" },
        name: { type: "string", description: "optional explicit id for spawn (letters, digits, - and _; default auto p<N>)" },
        cwd: { type: "string", description: "working directory for spawn (default: the project root)" },
        timeout_sec: { type: "number", description: "optional auto-kill fuse for spawn (default 3600)" },
        wait_ms: { type: "number", description: "poll: max ms to wait for new output (default 800, max 10000)" },
        max_chars: { type: "number", description: "poll/status: output cap per stream (default 4000)" },
        signal: { type: "string", description: "kill signal: SIGTERM (default) | SIGKILL | SIGINT | SIGHUP" },
      }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "repl",
      description: "Persistent Node.js REPL: variables, imports and loaded data SURVIVE between calls — iterate on data analysis without restarting from zero every time. Runs the REAL node REPL (top-level await, let/const persistence, multiline). Actions: run (code; auto-starts the session) | status | kill | list. One evaluation at a time per session.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["run", "status", "kill", "list"], description: "what to do" },
        code: { type: "string", description: "JavaScript to evaluate (action=run). Send COMPLETE statements in one call — incomplete input is reset and reported." },
        session: { type: "string", description: "session name (default 'main'; letters, digits, - and _)" },
        timeout_ms: { type: "number", description: "run timeout (default 15000, max 60000); a timed-out evaluation stays running — kill the session to reset" },
      }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "semantic_search",
      description: "Find code by MEANING, not literal text: every source file is chunked and ranked against the query (BM25, reranked with provider embeddings when configured). Use for 'where is X handled' when grep_files finds no literal match. Read-only — verifiers may use it too.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "what to find, in natural words (e.g. 'where do we validate user sessions')" },
        path: { type: "string", description: "root dir to search (default: the project root)" },
        limit: { type: "number", description: "max hits (default 8, max 30)" },
      }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "runtime",
      description: "Runtime Intelligence for the PROJECT (not arbitrary commands): discover the project's real runtime shape (type/entrypoint/package manager/build/run scripts/port hints — every fact carries its file evidence, commands are NEVER invented), then launch the DISCOVERED build/run command via the background process manager, probe health with a REAL HTTP request, and prove claims like 'server started' with process + health evidence. `up` is the full lifecycle in one action: (optional build) → launch → WAIT-READY (bounded health polling) → verdict. Also reconciles forge-owned processes after a crash (ledger + pid-reuse guard — never touches unrelated processes). Actions: discover | up | launch | status | health | claim | reconcile | stop.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["discover", "up", "launch", "status", "health", "claim", "reconcile", "stop"], description: "what to do" },
        command: { type: "string", description: "launch/up: explicit run command (default: the DISCOVERED run script — never invented)" },
        build: { type: "boolean", description: "up: run the discovered BUILD command first (bounded wait)" },
        ready_timeout_ms: { type: "number", description: "up: readiness budget (default 30000)" },
        phase: { type: "string", enum: ["run", "build"], description: "launch: which discovered script (default run)" },
        name: { type: "string", description: "launch/stop: process name (default app for run, build for build)" },
        port: { type: "number", description: "health/claim/up: explicit port (default: detected from live processes)" },
        grace_ms: { type: "number", description: "health/claim: how long to wait for a launched process to open its port when no port is given (default 6000; 0 = one look). A server is not unhealthy because npm was still booting." },
        host: { type: "string", description: "health/claim/up host (default 127.0.0.1)" },
        timeout_sec: { type: "number", description: "launch auto-kill fuse (default 3600)" },
        kill: { type: "boolean", description: "reconcile: kill forge-owned orphans (default false — report only)" },
        signal: { type: "string", description: "stop signal (default SIGTERM)" },
      }, required: ["action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "kg_query",
      description: "Query the project's knowledge graph — deterministic reads over the real indexes, no model calls: who imports/depends on a file, the blast radius of changing it, which tests cover it, where a symbol lives, what changed recently, plus the understand-anything knowledge graph when one was built (.ua/knowledge-graph.json). Use it to navigate architecture before editing. Every fact carries its source; nothing is invented.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "natural question: 'what depends on utils.js', 'impact of changing router.js', 'tests for parser', 'where is handleAuth', 'what changed recently'" },
        path: { type: "string", description: "project root (default: the working directory)" },
        max_lines: { type: "number", description: "output budget in lines (default 40, max 120)" },
      }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_whatif",
      description: "Risk-simulate a plan (or a plan CHANGE) through the predictive planner BEFORE committing to it: risk ladder, success-probability estimate, factor breakdown, critical path + single points of failure, real failure lessons, and an original-vs-mutated comparison when you pass mutate (add/remove/update nodes). Deterministic and read-only — it computes, it never executes anything; the numbers are estimates, never proof. Use it to choose between plan shapes.",
      parameters: { type: "object", properties: {
        plan: { type: "array", description: "plan nodes: { id, objective, dependencies?, read_only?, risk?, estimated_cost?, target_files?, verification_requirements? }", items: { type: "object", properties: {
          id: { type: "string" }, objective: { type: "string" }, dependencies: { type: "array", items: { type: "string" } },
          read_only: { type: "boolean" }, risk: { type: "string", enum: ["trivial", "low", "medium", "high", "critical"] },
          estimated_cost: { type: "number" }, target_files: { type: "array", items: { type: "string" } },
          verification_requirements: { type: "array", items: { type: "string" } },
        }, required: ["objective"] } },
        mutate: { type: "object", description: "optional second variant assessed against the base: { add?: [node…], remove?: [id…], update?: [{ id, …patch }] }", properties: {
          add: { type: "array", items: { type: "object" } },
          remove: { type: "array", items: { type: "string" } },
          update: { type: "array", items: { type: "object" } },
        } },
        klass: { type: "string", enum: ["MICRO", "SMALL", "MEDIUM", "LARGE", "ARCHITECTURAL", "RECOVERY"], description: "task-class prior (default MEDIUM)" },
        task: { type: "string", description: "task text — pulls the project's REAL failure lessons into the simulation" },
      }, required: ["plan"] },
    },
  },
  {
    type: "function",
    function: {
      name: "code_context",
      description: "One-call code context pack: semantic (meaning) hits over chunked sources PLUS the structural wiring of the top files — importers, covering tests, blast radius from the world model. Use it to understand how an area works before editing it. Read-only; verifiers may use it too.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "what to understand, in natural words ('where do we validate user sessions')" },
        path: { type: "string", description: "root dir to search (default: the project root)" },
        max_hits: { type: "number", description: "max semantic hits (default 5, max 12)" },
      }, required: ["query"] },
    },
  },
]

/** Tools that mutate the filesystem / run commands — serialized, and blocked
 *  in read-only (plan / sub-agent) mode. v20 fix: `delegate` is READ-ONLY and
 *  no longer listed here (v19 blocked plan-mode delegation by mistake). */
export const WRITE_TOOLS = new Set(["bash", "write_file", "edit_file", "multi_edit", "apply_patch"])
export const FORGE_STATE_MUTATING_TOOLS = new Set(["memory", "todo"])

export const MUTATION_CLASS = {
  FILESYSTEM: "filesystem_mutation",
  FORGE_STATE: "forge_state_mutation",
  NONE: "none",
}

const READONLY_ALLOWED_BASH_PATTERNS = [
  /\b(test|jest|vitest|mocha|pytest|cargo|go)\s+(test|run)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)\b/i,
  /\btsc\b/i,
  /\bnode\s+--check\b/i,
  /\b(cargo|go)\s+(build|vet|check)\b/i,
  /\b(make|gradle|mvn)\b.*\b(test|check|verify)\b/i,
  /\b(git\s+status|git\s+log|git\s+diff|ls|cat|pwd|echo|which|env|date)\b/i,
]

/**
 * P0 — "read-only" means NO artifact mutation, and a shell redirection IS an
 * artifact mutation.
 *
 * Before this, `echo hi > stolen.txt` and `cat a.js > b.js` were allowed in
 * read-only mode: the allow-list matched on the command PREFIX (`echo`, `cat`)
 * and never looked at what the command wrote to. A verifier could therefore
 * overwrite the very file it was supposed to be verifying.
 *
 * Quoted text is stripped first so `node -e "console.log(2>1)"` and
 * `grep "a > b"` are not misread as writes; `2>&1` (an fd duplication, not a
 * file write) and `> /dev/null` are explicitly not writes.
 */
export function hasWriteRedirection(command) {
  let s = String(command ?? "")
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
  s = s.replace(/\d*>&\d*/g, " ")
  const re = />>?\s*([^\s;&|]+)/g
  let m
  while ((m = re.exec(s))) {
    const target = m[1] ?? ""
    if (target.startsWith("&")) continue
    if (target === "/dev/null") continue
    return true
  }
  // `… | tee out.txt` writes a file even though the prefix looks harmless
  if (/(^|[\s|;&(])tee\s+/i.test(s)) return true
  return false
}

function isReadOnlyAllowedBash(command) {
  const cmd = String(command ?? "")
  // redirections are never allowed, whatever the command prefix says
  if (hasWriteRedirection(cmd)) return false
  if (/^\s*(ls|cat|head|tail|wc|pwd|echo|which|env|date|git\s+(status|log|diff|show|branch)|node\s+-v|npm\s+(ls|view|outdated))\b/i.test(cmd)) return true
  for (const re of READONLY_ALLOWED_BASH_PATTERNS) if (re.test(cmd)) return true
  return false
}

/** v122: mutating git subcommands that a read-only role must never run, even
 *  when the classifier labels them low (git commit writes the object store). */
const GIT_MUTATING_SUBS = new Set(["commit", "apply", "am", "add", "stage", "mv", "rm", "merge", "rebase", "cherry-pick", "switch", "gc", "prune", "stash", "worktree", "tag", "notes", "config"])
const BASH_MUTATING_PROGRAMS = new Set(["rm", "rmdir", "mv", "cp", "dd", "tee", "truncate", "chmod", "chown", "chgrp", "shred", "srm", "ln", "install", "patch", "rsync", "tar", "unzip", "mkfs", "sudo", "doas", "su", "kill", "pkill", "killall", "crontab", "systemctl", "service", "sed", "npm", "yarn", "pnpm", "bun", "pip", "pip3", "apt", "apt-get", "apk", "dnf", "yum", "pacman", "brew"])

/**
 * v122 "yolowise" — the widened question a read-only ROLE may answer with the
 * classifier instead of a 12-prefix regex list: "is this a CHECK, not a
 * CHANGE?".
 *
 * The allow-list at the top of this file is a hand-written enumeration of the
 * commands its author thought of, and it failed the way every such list does:
 * `cargo test --features x`, `./scripts/check.sh`, `make lint`, `pytest -q
 * tests/test_x.py -k auth`, `go vet ./...`, `npx tsc --noEmit` — real
 * verification, refused, and the run reported `BLOCKED: bash command is not an
 * approved verification command`. That is not a safety property; it is a guess
 * about what a test looks like.
 *
 * So under YOLO the test becomes structural, and STRICTER in the places that
 * matter: no write redirection (ever), a classification of `safe`/`low`, no
 * mutating program, no mutating git subcommand, and no target outside the
 * project. `git commit` and `rm x` are refused here even though the old list
 * said nothing about them; `pytest -q` is allowed even though the old list had
 * never heard of pytest.
 *
 * What this NEVER relaxes: `readOnly` still refuses the write tools and
 * persistent-state tools (getMutationClass is untouched), so a verifier cannot
 * change the artifact it is verifying — that is the verification contract, not
 * a permission.
 */
export function isVerificationGradeBash(command, ctx = {}) {
  const cmd = String(command ?? "").trim()
  if (!cmd) return false
  if (hasWriteRedirection(cmd)) return false
  const cwd = ctx.cwd ?? process.cwd()
  const root = ctx.root ?? cwd
  let r
  try { r = classifyCommand(cmd, { cwd, root }) } catch { return false }
  if (r.level !== "safe" && r.level !== "low") return false
  if (r.unsafe === true) return false
  const progs = (r.programs || []).map((p) => String(p || "").toLowerCase())
  if (!progs.length) return false
  if (progs.some((p) => BASH_MUTATING_PROGRAMS.has(p))) return false
  if (new RegExp(`\\bgit\\s+(-[^\\s]+\\s+)*(${[...GIT_MUTATING_SUBS].join("|")})\\b`, "i").test(cmd)) return false
  // every named operand stays inside the project (or in scratch space, which
  // is where test runners put their temp files)
  const rootReal = (() => { try { return fs.realpathSync(root) } catch { return path.resolve(root) } })()
  const tmp = (() => { try { return fs.realpathSync(os.tmpdir()) } catch { return os.tmpdir() } })()
  for (const t of r.targets || []) {
    const abs = path.resolve(cwd, String(t))
    if (insideDir(abs, rootReal) || insideDir(abs, tmp)) continue
    return false
  }
  return true
}

/** v122: the options a read-only role's policy question is asked with. The
 *  classifier answer is consulted only when the owner granted full control. */
export function readOnlyOpts(ctx = {}) {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    root: ctx.root ?? ctx.cwd ?? process.cwd(),
    readOnlyBashByClass: ctx.readOnlyBashByClass === true || ctx.yolo === true,
  }
}

// ---------------------------------------------------------------------------
// P0 — VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE
// ---------------------------------------------------------------------------
//
// Verification must not be able to change the artifact it verifies. `readOnly`
// alone already blocks the write tools and persistent-state tools; the
// verifier additionally gets a WHITELIST of tools it may even see, so it
// cannot stumble into a mutating plugin either.

export const VERIFICATION_TOOLS = {
  allowed: [
    "read_file", "read_image", "list_dir", "glob_files", "grep_files", "git_status",
    "git_diff", "git_log", "git_blame", "github",   // read-only git + GitHub evidence
    "bash",            // approved verification commands only (test/build/lint)
    "think",           // reasoning never mutates
    "load_skill",      // read-only skill docs
    "browser",         // snapshot / screenshot / open / status / close only
    "semantic_search",  // read-only meaning search (v93) — locate code without mutating
    "process",         // poll / status / list only — observe the runtime the work launched (§29)
    "runtime",         // discover / status / health / claim / reconcile — runtime EVIDENCE is verification (§11); launch/stop gated below
    "kg_query",        // deterministic project-knowledge reads (v94c) — pure computation over indexes
    "plan_whatif",     // risk simulation over hypothetical plans — computes, never mutates or executes
    "code_context",    // semantic hits + wiring context — read-only like semantic_search
  ],
  forbidden: [
    "write_file", "edit_file", "multi_edit", "apply_patch",
    "memory", "todo",               // persistent Forge state
    "delegate",                     // no recursive write-capable sub-agent
    "repl",                          // evaluates arbitrary code — can write; verification stays read-only
  ],
}

/** Is this tool permitted for a verification (READ_ONLY) agent?
 *  `opts.readOnlyBashByClass` (YOLO) widens ONLY the bash question. */
export function verificationAllows(name, args, opts = {}) {
  const n = String(name ?? "")
  if (VERIFICATION_TOOLS.forbidden.includes(n)) return { ok: false, reason: `${n} is forbidden for a verification agent` }
  if (n === "bash") {
    if (isReadOnlyAllowedBash(String(args?.command ?? ""))) return { ok: true }
    if (opts.readOnlyBashByClass === true && isVerificationGradeBash(args?.command, opts)) return { ok: true }
    return { ok: false, reason: `bash command is not an approved verification command: ${String(args?.command ?? "").slice(0, 80)}` }
  }
  if (n === "browser") {
    const action = String(args?.action ?? "")
    if (browserMutatesFilesystem(args)) return { ok: false, reason: "browser screenshot with path writes a file" }
    if (isPageMutating(action)) return { ok: false, reason: `browser ${action} drives the page — verification may snapshot/screenshot/open/status/close only` }
    if (action && !isVerifyAction(action)) return { ok: false, reason: `browser ${action} is not a verification action` }
    return { ok: true }
  }
  if (n === "process") {
    // §29 runtime observation is verification; starting/stopping is not
    const action = String(args?.action ?? "")
    if (action === "poll" || action === "status" || action === "list") return { ok: true }
    return { ok: false, reason: `process ${action || "(no action)"} starts/stops real processes — verification may poll/status/list only` }
  }
  if (n === "runtime") {
    // §11 runtime evidence IS verification evidence: a health probe proves
    // "server started" far better than re-reading files. Launching/stopping
    // is execution, not verification.
    const action = String(args?.action ?? "")
    if (["discover", "status", "health", "claim", "reconcile"].includes(action)) return { ok: true }
    return { ok: false, reason: `runtime ${action || "(no action)"} launches/stops processes — verification may discover/status/health/claim/reconcile only` }
  }
  if (!VERIFICATION_TOOLS.allowed.includes(n)) return { ok: false, reason: `${n} is not in the verification tool set` }
  return { ok: true }
}

function getMutationClass(name, args) {
  if (WRITE_TOOLS.has(name)) return MUTATION_CLASS.FILESYSTEM
  if (name === "bash") {
    const cmd = String(args?.command ?? "")
    if (isReadOnlyAllowedBash(cmd)) return MUTATION_CLASS.NONE
    return MUTATION_CLASS.FILESYSTEM
  }
  if (FORGE_STATE_MUTATING_TOOLS.has(name)) {
    if (name === "memory") {
      const action = String(args?.action ?? "read")
      if (action === "read") return MUTATION_CLASS.NONE
      return MUTATION_CLASS.FORGE_STATE
    }
    if (name === "todo") {
      const action = String(args?.action ?? "list")
      if (action === "list") return MUTATION_CLASS.NONE
      return MUTATION_CLASS.FORGE_STATE
    }
    return MUTATION_CLASS.FORGE_STATE
  }
  if (name === "browser" && browserMutatesFilesystem(args)) return MUTATION_CLASS.FILESYSTEM
  // v93: process/repl mutate on their ACTING actions only — observation
  // (poll/status/list) is read-only, exactly like memory read vs learn.
  if (name === "process") {
    const action = String(args?.action ?? "")
    if (action === "poll" || action === "status" || action === "list") return MUTATION_CLASS.NONE
    return MUTATION_CLASS.FILESYSTEM // spawn/kill run and stop real processes
  }
  if (name === "repl") {
    const action = String(args?.action ?? "")
    if (action === "status" || action === "list") return MUTATION_CLASS.NONE
    return MUTATION_CLASS.FILESYSTEM // run executes arbitrary (potentially writing) code
  }
  if (name === "semantic_search") return MUTATION_CLASS.NONE
  // v94c "toolwise": kg_query / plan_whatif / code_context are pure reads —
  // deterministic computation over existing indexes, no writes, no processes,
  // no network. They are safe for read-only (plan / verifier) agents.
  if (name === "kg_query" || name === "plan_whatif" || name === "code_context") return MUTATION_CLASS.NONE
  // v93 gap fix: runtime — discovery/health/claims are observation; launch/stop
  // drive real processes.
  if (name === "runtime") {
    const action = String(args?.action ?? "")
    if (["discover", "status", "health", "claim", "reconcile"].includes(action)) return MUTATION_CLASS.NONE
    return MUTATION_CLASS.FILESYSTEM // launch/stop run and stop real processes
  }
  return MUTATION_CLASS.NONE
}

export function isReadOnlyViolation(name, args, readOnly, opts = {}) {
  if (!readOnly) return null
  const mutationClass = getMutationClass(name, args)
  if (mutationClass === MUTATION_CLASS.FILESYSTEM) {
    if (name === "bash" && isReadOnlyAllowedBash(args?.command)) return null
    // v122: under full control a read-only WORKER may run any command the
    // classifier itself calls a check — the role's write tools stay refused.
    if (name === "bash" && opts.readOnlyBashByClass === true && isVerificationGradeBash(args?.command, opts)) return null
    return `BLOCKED: ${name} is a filesystem mutation and is disabled in this read-only agent (mutation class: ${mutationClass})`
  }
  if (mutationClass === MUTATION_CLASS.FORGE_STATE) {
    return `BLOCKED: ${name} mutates persistent Forge state (${args?.action ?? "write"}) and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify`
  }
  return null
}

// ---------------------------------------------------------------------------
// tool context
// ---------------------------------------------------------------------------

export function makeToolContext(opts = {}) {
  const {
    cwd,
    /** "default" | "verifier" — a verifier sees only verificationTools. */
    mode = "default",
    timeoutSec = AGENT_BUDGETS.timeoutSec,
    maxToolOutput = AGENT_BUDGETS.maxToolOutput,
    skillsDir,
    searchUrl,
    memoryPath,
    todoPath,
    delegateRunner,
    readOnly = false,
    root,
    allowOutsideProject = false,
    /**
     * v104 §5 — the SCOPE grant, deliberately separate from `unrestricted`.
     *
     * `unrestricted` is the machine owner's master switch for RISK: sudo,
     * interpreter eval, network upload. It ships true, which meant
     * `allowOutsideProject` was effectively always granted and the user's own
     * `allowOutsideProject: false` never took effect.
     *
     * Scanning the home directory is not a risk question, it is a scope,
     * determinism, privacy and battery question — §5's own list — so it gets
     * its own grant, read ONLY from an explicit setting.
     */
    allowOutsideTraversal = false,
    // v122 "yolowise": the owner's full-control state, resolved ONCE by the
    // caller (agent.js / chat.js) and carried here so every policy question
    // inside the tool layer — the read-only role's bash test, the traversal
    // boundary, the shell verdict — is answered from the same place.
    yolo = false,
    readOnlyBashByClass = null,
    allowGeneratedWrites = false,
    allowSudo = false,
    assumeYes = false,
    allowNetworkUpload = false, // v21.1: curl -d / wget --post-file / scp … from the model
    allowInterpreterEval = false, // v21.2: node -e / python -c / perl -e …
    autonomous = false, // v25: in-project git danger without assumeYes
    unrestricted = false, // v85: owner master switch — every shell guard off
    fetchPrivateUrls = process.env.FORGE_ALLOW_PRIVATE_URLS === "1",
    delegateTimeoutSec = AGENT_BUDGETS.delegateTimeoutSec,
    maxParallelDelegates = 2,
    signal = null,
    subAgent = false,
    runId = null,
    plugins = [], // v20.2 P3-5: user tool plugins (from loadToolPlugins().tools)
    vision = true,
    visionProvider = null,
    browser = true,
    browserBinary,
    browserDriver = null,
    semanticEmbed = null, // v93: optional (texts) => Promise<number[][]> — hybrid rerank for semantic_search
    // v160: the person's OWN words for this run — the task they gave, or
    // their latest chat message (a function, read at call time). The only
    // text a memory `rule` may be quoted from. null: no rules can be minted.
    userText = null,
  } = opts
  // register plugins: write-class ones join WRITE_TOOLS so they are serialized
  // and blocked in read-only sub-agents, exactly like built-in write tools.
  const pluginMap = new Map()
  for (const pl of plugins) {
    if (!pl || !pl.name) continue
    pluginMap.set(pl.name, pl)
    if (!pl.readOnly) WRITE_TOOLS.add(pl.name)
  }
  const ctx = {
    cwd: path.resolve(cwd || process.cwd()),
    root: path.resolve(root || cwd || process.cwd()),
    timeoutSec, maxToolOutput, skillsDir, searchUrl, memoryPath, todoPath,
    delegateRunner, readOnly,
    mode,
    allowOutsideProject, allowOutsideTraversal, allowGeneratedWrites, allowSudo, assumeYes, allowNetworkUpload, allowInterpreterEval, autonomous, unrestricted, fetchPrivateUrls,
    yolo, readOnlyBashByClass,
    delegateTimeoutSec, signal, subAgent, runId,
    userText,
    _plugins: pluginMap,
    _delegateActive: 0,
    _delegateMax: Math.max(1, Math.min(AGENT_BUDGETS.maxParallelSubAgents, maxParallelDelegates)),
    vision: vision !== false,
    visionProvider: visionProvider || null,
    _pendingVision: [],
    browser: browser !== false,
    _browserDriver: browserDriver || null,
    _browser: null,
    semanticEmbed: typeof semanticEmbed === "function" ? semanticEmbed : null,
  }
  if (browserBinary !== undefined) ctx.browserBinary = browserBinary
  ctx.checkPath = (p, opts2) => safePath(ctx, p, opts2)
  ctx.writeScreenshot = (rel, buf) => {
    const sp = safePath(ctx, rel, { write: true })
    if (!sp.ok) return sp
    try {
      fs.mkdirSync(path.dirname(sp.abs), { recursive: true })
      fs.writeFileSync(sp.abs, buf)
      return { ok: true, abs: sp.abs }
    } catch (e) {
      return { ok: false, error: `ERROR: screenshot write failed: ${String(e?.message ?? e).slice(0, 160)}` }
    }
  }
  const allDefs = plugins.length ? [...TOOL_DEFS, ...plugins.map((p) => p.def)] : TOOL_DEFS
  let filteredDefs = allDefs
  if (mode === "verifier") {
    // whitelist: the verifier never even sees a mutating tool
    filteredDefs = allDefs.filter((t) => VERIFICATION_TOOLS.allowed.includes(t.function.name))
  } else if (readOnly) {
    filteredDefs = allDefs.filter((t) => {
      const n = t.function.name
      if (WRITE_TOOLS.has(n)) {
        if (n === "bash") return true
        return false
      }
      return true
    })
  }
  return { defs: filteredDefs, exec: (name, args) => execTool(ctx, name, args || {}), ctx }
}

/** Built-in tool names — used to reject plugins that shadow a built-in. */
export const BUILTIN_TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.function.name))

export function toolCount() {
  return TOOL_DEFS.length
}

function cap(s, limit) {
  const L = limit || 12000
  return s.length > L ? s.slice(0, L) + `\n... (truncated, ${s.length} chars total)` : s
}

// ---------------------------------------------------------------------------
// bash — structural risk classification (v20 shellguard)
// ---------------------------------------------------------------------------

/**
 * Truncate a command's output while KEEPING its trailing status marker.
 * v20 appended `[exit code: N]` and then ran the whole string through cap():
 * once the output exceeded maxToolOutput the marker was cut off, agent.js
 * (`/\[exit code: (-?\d+)\]/`) saw none, recorded exitCode 0 / passed:true and
 * a failing test-suite counted as verified. The marker now travels outside the
 * truncation window.
 */
function capWithMarker(body, marker, limit) {
  const capped = cap(body || "(no output)", limit)
  return marker ? `${capped}\n${marker}` : capped
}

/**
 * Terminate a child AND everything it spawned. The command runs via
 * /bin/sh -c inside its own process group (detached:true), so a single
 * negative-PID signal reaches `sleep 300 &`-style grandchildren that used to
 * survive the parent's SIGKILL and leak after a timeout. v94 todowise: when
 * the platform refuses the group signal, the same EVIDENCE-BASED member walk
 * as runtime.js signals each group member (the old fallback reached only the
 * leader and leaked grandchildren).
 */
function killTree(child, signal = "SIGKILL") {
  if (!child || child.pid == null) return
  try { process.kill(-child.pid, signal); return } catch {}
  try { signalGroup(child.pid, signal) } catch {}
  try { child.kill(signal) } catch {}
}

// ---------------------------------------------------------------------------
// v87 — broken-bwrap auto-fallback
//
// Some kernels/containers ship a bwrap binary that can never start (hidden
// overflowuid, userns disabled): every sandboxed command exits 1 with a
// `bwrap: …` setup error before the real command runs. Detect that exact
// signature ONCE, remember it for the session, and re-run the command
// directly through /bin/sh. A missing isolator is "unsandboxed", never a
// fake sandbox — and never a permission prompt the user has to answer.
// ---------------------------------------------------------------------------
let bwrapBroken = false // session-wide: once bwrap fails to start, stop wrapping

function isBwrapStartFailure(out) {
  const s = String(out || "")
  return /\[exit code: 1\]\s*$/.test(s) && /^\s*bwrap:\s/m.test(s)
}

const plainWrap = (command) => ({ file: resolveShell(), args: ["-c", command], sandboxed: false, kind: "none" }) // v94 knowwise: resolved shell (Termux-safe)

async function runBash(ctx, command, timeoutSec) {
  if (ctx.readOnly) {
    const mutationCheck = getMutationClass("bash", { command })
    const ro = readOnlyOpts(ctx)
    const graded = ro.readOnlyBashByClass === true && isVerificationGradeBash(command, ro)
    if (mutationCheck === MUTATION_CLASS.FILESYSTEM && !isReadOnlyAllowedBash(command) && !graded) {
      return `BLOCKED: write tools are disabled in this read-only agent — bash command "${String(command).slice(0, 80)}" is a filesystem mutation. Read-only workers may run approved verification commands (test/build/lint) but not arbitrary mutations.`
    }
  }
  const verdict = modelMayRun(command, { cwd: ctx.cwd, root: ctx.root }, { allowSudo: ctx.allowSudo, assumeYes: ctx.assumeYes, allowNetworkUpload: ctx.allowNetworkUpload, allowInterpreterEval: ctx.allowInterpreterEval, autonomous: ctx.autonomous === true, unrestricted: ctx.unrestricted === true })
  if (!verdict.ok) return verdict.reason
  const t = Math.min(AGENT_BUDGETS.bashTimeoutCapSec, Math.max(1, timeoutSec || ctx.timeoutSec)) * 1000
  if (ctx.signal?.aborted) return "ERROR: cancelled — command not started (user interrupt)"

  // V4 Phase 2: Python skill invocations get a project-local isolated venv.
  // Shell classification still runs against the original user/model command;
  // only the interpreter path is swapped after policy has accepted it.
  // v168: a CHECK piped into `| tail -N` / `| head -N` reports tail's exit
  // code, so a failing test run came back as success and was recorded as a
  // passing check. The shell may be dash (no PIPESTATUS, no pipefail), so
  // forge runs the check itself and applies the filter to its output: the
  // same lines, and the check's own exit code. Only checks — any other
  // command runs exactly as typed.
  let outFilter = looksLikeCheck(command) ? splitOutputFilter(command) : null
  // v193: a pipe that ends in `head` returns when head has its lines — the
  // shell's job (the check dies at its next write); forge running the check
  // to its end hung on a watch mode until the timeout
  const headCloses = endsInHead(outFilter?.filter)
  if (headCloses) outFilter = null
  // v172: forge writes a tee's file itself, so only inside the project — the
  // sandboxed shell could not write anywhere else, and neither may forge.
  // Any other target is left to the shell, exactly as typed.
  let teePath = null
  if (outFilter?.filter.kind === "tee") {
    const target = path.resolve(ctx.cwd, outFilter.filter.file)
    const root = path.resolve(ctx.root || ctx.cwd)
    if (target === root || !(target + path.sep).startsWith(root + path.sep) || target.includes(`${path.sep}.git${path.sep}`)) outFilter = null
    else teePath = target
  }
  let effectiveCommand = outFilter ? outFilter.base : command
  // v190: anything else with a piped check in it — `npm test | tail -5 &&
  // git commit …`, `npm test | grep x > log` — runs as typed, except that
  // each such pipeline's status is its check's, so a failing check stops
  // what follows its `&&` (the shell may be dash: no pipefail)
  let pipelineRewritten = false
  // v191: and each check in a longer command reports its own status, so
  // `npm test; echo "exit=$?"` / `npm test || true` are recorded as the
  // tests' result, not the last part's
  let checkMark = null, checkStatuses = []
  if (!outFilter && looksLikeCheck(command)) {
    const rw = rewriteChecks(command, { nonce: randomBytes(6).toString("hex") })
    if (rw) { effectiveCommand = rw.command; pipelineRewritten = rw.pipelines > 0; checkMark = rw.mark }
  }
  let pythonEnv = {}
  if (ctx.skillsDir) {
    try {
      const prepared = rewritePythonSkillCommand(effectiveCommand, {
        cwd: ctx.cwd,
        skillsDir: ctx.skillsDir,
        projectRoot: ctx.root,
        install: process.env.FORGE_PYTHON_AUTO_INSTALL !== "0",
      })
      if (prepared?.prepared?.env?.python) {
        effectiveCommand = prepared.command
        pythonEnv = pythonEnvironment({ venv: prepared.prepared.env.dir })
      }
    } catch (e) {
      return `ERROR: Python skill environment preparation failed: ${String(e?.message ?? e).slice(0, 300)}`
    }
  }

  const attempt = (wrapped, envOverrides = {}) => new Promise((resolve) => {
    const MAX_BUF = 4 * 1024 * 1024
    let stdout = "", stderr = "", bytes = 0, overflow = false, done = false
    let timedOut = false, aborted = false
    const startedAt = Date.now()
    // detached → own process group, so killTree() can reach grandchildren
    const child = spawn(wrapped.file, wrapped.args, { cwd: ctx.cwd, env: { ...process.env, ...envOverrides, TERM: "dumb" }, stdio: ["ignore", "pipe", "pipe"], detached: true })
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, t)
    const onAbort = () => { aborted = true; killTree(child) }
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true })
    const FILTER_WINDOW = 256 * 1024
    const PIPE_CAP = 32 * 1024 * 1024
    const collect = (which) => (chunk) => {
      if (overflow) return
      // v168: stdout that a tail/head will cut is kept as a rolling window —
      // the shell's `| tail` kept a huge log small, and so must forge
      // v189: a pipe's stages need all of the check's output (grep cannot
      // work on a window); kept up to PIPE_CAP, past that it is an overflow
      if (outFilter?.filter.kind === "pipe" && which === "out") {
        stdout += chunk
        if (stdout.length > PIPE_CAP) { overflow = true; killTree(child) }
        return
      }
      if (outFilter && outFilter.filter.kind !== "tee" && which === "out") {
        if (outFilter.filter.kind === "head") { if (stdout.length < FILTER_WINDOW) stdout += chunk }
        else { stdout += chunk; if (stdout.length > FILTER_WINDOW * 2) stdout = stdout.slice(-FILTER_WINDOW) }
        return
      }
      bytes += chunk.length
      if (bytes > MAX_BUF) { overflow = true; killTree(child); return }
      if (which === "out") stdout += chunk; else stderr += chunk
    }
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", collect("out")); child.stderr.on("data", collect("err"))
    const finish = async (code, sig, spawnErr) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort)
      const finishedAt = Date.now()
      if (checkMark) ({ stderr, statuses: checkStatuses } = checkStatusLines(stderr, checkMark))
      let out = ""
      if (stdout) out += stdout
      if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr
      if (aborted) return resolve(`ERROR: cancelled — command terminated by user interrupt${out ? `\n${cap(out, 2000)}` : ""}`)
      if (spawnErr) return resolve(`ERROR: ${spawnErr.message}\n[exit code: 127]`)
      if (teePath) {
        try { (outFilter.filter.append ? fs.appendFileSync : fs.writeFileSync)(teePath, stdout) } catch (e) { stderr += `${stderr ? "\n" : ""}tee: ${outFilter.filter.file}: ${e?.code ?? e?.message ?? e}` }
      }
      if (outFilter?.filter.kind === "pipe" && !timedOut && !overflow && !sig) {
        // v189: the check ran; its output goes through the same stages, as typed
        const f = await runFilterStages(outFilter.filter.stages, stdout, wrapped, envOverrides)
        stdout = f.out
        if (f.err) stderr += `${stderr ? "\n" : ""}${f.err.trimEnd()}`
      } else if (outFilter) stdout = applyOutputFilter(stdout, outFilter.filter)
      const rec = createCommandResult({
        command,
        exitCode: typeof code === "number" ? code : null,
        signal: sig || null,
        timedOut,
        killed: timedOut || overflow || !!sig,
        stdout,
        stderr,
        durationMs: finishedAt - startedAt,
        truncated: false,
        processId: child.pid ?? null,
        processGroupId: child.pid ?? null,
        startedAt,
        finishedAt,
        overflow,
        aborted: false,
        timeoutSec: t / 1000,
        maxBuf: MAX_BUF,
      })
      const shown = formatCommandResult(rec, { max: ctx.maxToolOutput })
      // said only when it matters: the shell would have reported success here
      const note = outFilter && typeof code === "number" && code !== 0
        ? (teePath
          ? `\n[forge] the check ran without its "| tee ${outFilter.filter.append ? "-a " : ""}${outFilter.filter.file}" (forge wrote the same output to that file), so this exit code is the check's own — the pipe would have reported success`
          : outFilter.filter.kind === "pipe"
            ? `\n[forge] the check ran first and its output went through "| ${cap(outFilter.filter.stages, 80)}" (the same lines are shown), so this exit code is the check's own — the pipe would have reported the last stage's`
            : `\n[forge] the check ran without its "| ${outFilter.filter.kind} -${outFilter.filter.n}" (the same lines are shown), so this exit code is the check's own — the pipe would have reported success`)
        : pipelineRewritten && headCloses && typeof code === "number" && code !== 0 && String(stdout).replace(/\n$/, "").split("\n").length >= (headLines(command) ?? Infinity)
          ? `\n[forge] \`| head\` closed the pipe once it had its lines, as in the shell — the check may have been cut short there (exit ${code} is the check's own): it did not necessarily finish. Run it without \`| head\` (or with \`| tail\`) to see its result`
          : pipelineRewritten && typeof code === "number" && code !== 0
            ? "\n[forge] a piped check's pipeline reported the check's own exit code, not its last stage's — so a failing check stopped what followed its `&&` (the same output is shown)"
            : ""
      // v191: the check's own status, when the command's differs from it
      const own = checkStatuses.find((n) => n !== 0) ?? (checkStatuses.length ? 0 : null)
      const cmdCode = typeof code === "number" ? code : null
      const ownNote = own === null || own === cmdCode || (own === 0 && cmdCode === null) ? ""
        : own !== 0
          ? `\n[check exit code: ${own}]\n[forge] the check in this command failed (exit ${own}); the command's own status is its last part's${cmdCode === 0 ? ", 0" : ""} — recorded as a failing check`
          : `\n[check exit code: 0]\n[forge] the check in this command passed; what failed came after it — recorded as a passing check`
      resolve(shown + note + ownNote)
    }
    child.on("error", (e) => finish(null, null, e))
    child.on("close", (code, sig) => finish(code, sig, null))
  })

  /**
   * v189: run a check's filter stages (`grep -v x | head -3`) on its output,
   * exactly as typed, in the same sandbox and directory the check ran in.
   * Their own exit code is not the check's and is not reported; what they
   * print on stderr (a bad regex, a missing tool) is.
   */
  const runFilterStages = (stages, input, checkWrap, envOverrides = {}) => new Promise((resolve) => {
    const w = checkWrap?.sandboxed ? wrapBash(stages, { cwd: ctx.cwd, root: ctx.root }) : plainWrap(stages)
    let out = "", err = ""
    let child
    try {
      child = spawn(w.file, w.args, { cwd: ctx.cwd, env: { ...process.env, ...envOverrides, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"], detached: true })
    } catch (e) { return resolve({ out: "", err: `forge: could not run the filter: ${e?.message ?? e}` }) }
    const timer = setTimeout(() => killTree(child), 30000)
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => { if (out.length < 4 * 1024 * 1024) out += d })
    child.stderr.on("data", (d) => { if (err.length < 64 * 1024) err += d })
    child.stdin.on("error", () => {}) // `| head -3` closes its input early
    child.on("error", (e) => { clearTimeout(timer); resolve({ out, err: `forge: could not run the filter: ${e?.message ?? e}` }) })
    child.on("close", () => { clearTimeout(timer); resolve({ out, err }) })
    child.stdin.end(input)
  })

  // v87: wrap only while the sandbox has not proven broken; if the sandboxed
  // spawn dies with a bwrap setup error, re-run the same command unsandboxed
  // and remember — later commands skip the dead wrapper entirely.
  // v94 todowise: the failure also RESETS the sandbox module's one-per-process
  // kernel probe (overflowuid/overflowgid) — a kernel hardened after forge
  // started is re-probed once, cheaply, exactly at the moment the evidence
  // (bwrap start failure) says the cached verdict went stale.
  let wrapped = bwrapBroken ? plainWrap(effectiveCommand) : wrapBash(effectiveCommand, { cwd: ctx.cwd, root: ctx.root })
  let out = await attempt(wrapped, pythonEnv)
  if (wrapped.sandboxed && isBwrapStartFailure(out)) {
    bwrapBroken = true
    // v94 todowise: re-probe the kernel NOW (not lazily) — the failure is the
    // evidence that the cached overflowuid/overflowgid verdict went stale.
    try { reprobeKernelSupport() } catch { /* never let a re-probe break the run */ }
    const why = (out.split("\n").find((l) => /^\s*bwrap:/.test(l)) || "bwrap failed to start").trim().slice(0, 160)
    out = await attempt(plainWrap(effectiveCommand), pythonEnv)
    out += `\n[forge] sandbox skipped: ${why} — kernel support re-probed; command re-run WITHOUT the sandbox (FORGE_SANDBOX=0 makes this permanent).`
  }
  return out
}

// ---------------------------------------------------------------------------
// file tools — all paths through safePath()
// ---------------------------------------------------------------------------

// --- v20.1 P0-4: read_file is bounded --------------------------------------
// v20 called fs.readFileSync() on whatever path it was handed and then split
// the result, so `read_file {"path":"one-gigabyte.log"}` allocated the whole
// file as one string plus one array element per line before the 400-line
// window was even applied. Measured on a 16 MB log: +30 MB RSS. A 2 GB log
// is an OOM kill of the agent process.
// readLineRange() streams instead: READ_CHUNK bytes are in flight at a time,
// only the requested window is kept, no single line is kept in full, and the
// scan stops as soon as the window is full (or the budget is reached).
const READ_CHUNK = 64 * 1024 // bytes per read
const READ_SCAN_CAP = 64 * 1024 * 1024 // never scan more than 64 MB of one file
const READ_MAX_BYTES = 4 * 1024 * 1024 // hard cap on the bytes one read keeps
const READ_TOTAL_CAP = 4 * 1024 * 1024 // once the window is full, keep counting
//   lines only while the file is this small — that keeps the exact "N more
//   lines; total M" note for ordinary source files without ever scanning a
//   huge one to the end
const READ_MAX_LINE = 8000 // one minified line must not blow up the context

/**
 * Stream the requested [start, end) line window out of a file.
 * Bounded in every direction: at most READ_CHUNK bytes in flight, at most
 * READ_MAX_BYTES kept, at most READ_MAX_LINE chars of any single line kept,
 * at most READ_SCAN_CAP bytes scanned.
 * Returns { lines, total, truncated, scanned, completed } — `truncated` means
 * the keep-budget ran out, `completed` means EOF was reached (as opposed to
 * stopping because the requested window was full).
 */
function readLineRange(fd, start, end) {
  const lines = []
  let total = 0 // lines seen
  let scanned = 0 // bytes read
  let kept = 0 // bytes kept for the caller
  let pending = "" // head of the line we are inside of
  let extra = 0 // bytes of the current line we counted but did not store
  let pendingFull = false // current line exceeded READ_MAX_LINE
  let countOnly = false // window is full; only the line count still matters
  let endsWithNL = true // the last byte processed was a newline
  let truncated = false
  let completed = false
  const decoder = new StringDecoder("utf8")
  const buf = Buffer.alloc(READ_CHUNK)
  const countNL = (str) => {
    let c = 0
    for (let i = str.indexOf("\n"); i !== -1; i = str.indexOf("\n", i + 1)) c++
    return c
  }
  // returns true when the keep-budget is exhausted (the caller must stop)
  const emit = (text, realLen) => {
    if (total < start || total >= end) return false
    const shown = realLen > READ_MAX_LINE ? text.slice(0, READ_MAX_LINE) + ` …[line truncated, ${realLen} chars]` : text
    if (kept + shown.length + 1 > READ_MAX_BYTES) return true
    lines.push(shown)
    kept += shown.length + 1
    return false
  }
  {
    while (scanned < READ_SCAN_CAP) {
      let n = 0
      try {
        n = fs.readSync(fd, buf, 0, buf.length, scanned)
      } catch {
        break
      }
      if (n <= 0) {
        completed = true
        break
      }
      scanned += n
      const data = decoder.write(buf.subarray(0, n))
      endsWithNL = data.charCodeAt(data.length - 1) === 10
      // the window is already full: count the remaining lines, store nothing
      if (countOnly) {
        total += countNL(data)
        if (scanned >= READ_TOTAL_CAP) break
        continue
      }
      if (pendingFull) {
        // inside a line longer than READ_MAX_LINE: count bytes, store nothing
        const i = data.indexOf("\n")
        if (i === -1) {
          extra += data.length
          continue
        }
        if (emit(pending, READ_MAX_LINE + extra + i)) {
          truncated = true
          break
        }
        total++
        if (total >= end) {
          total += countNL(data.slice(i + 1))
          if (scanned >= READ_TOTAL_CAP) break
          countOnly = true
          continue
        }
        pending = ""
        extra = 0
        pendingFull = false
        let rest = data.slice(i + 1)
        let nl
        while ((nl = rest.indexOf("\n")) !== -1) {
          const line = rest.slice(0, nl)
          rest = rest.slice(nl + 1)
          if (emit(line, line.length)) {
            truncated = true
            break
          }
          total++
          if (total >= end) break
        }
        if (truncated) break
        if (total >= end) {
          total += countNL(rest)
          if (scanned >= READ_TOTAL_CAP) break
          countOnly = true
          continue
        }
        pending = rest
        continue
      }
      let chunk = pending + data
      let nl
      while ((nl = chunk.indexOf("\n")) !== -1) {
        const line = chunk.slice(0, nl)
        chunk = chunk.slice(nl + 1)
        if (emit(line, line.length)) {
          truncated = true
          break
        }
        total++
        if (total >= end) break
      }
      if (truncated) break
      if (total >= end) {
        // from here on only the line count matters
        total += countNL(chunk)
        if (scanned >= READ_TOTAL_CAP) break
        countOnly = true
        pending = ""
        continue
      }
      pending = chunk
      if (pending.length > READ_MAX_LINE) {
        extra = pending.length - READ_MAX_LINE
        pending = pending.slice(0, READ_MAX_LINE)
        pendingFull = true
      }
    }
    if (!truncated) {
      if (total < end) {
        // the window never filled: what is left is the final line
        if (pending.length || extra) {
          if (emit(pending, pending.length + extra)) truncated = true
          total++
        }
      } else if (completed && !endsWithNL) {
        total++ // the file does not end with a newline
      }
    }
  }
  return { lines, total, truncated, scanned, completed }
}

function read_file(ctx, args) {
  const sp = safePath(ctx, args.path)
  if (!sp.ok) return sp.error
  const p = sp.abs
  // v124: ONE descriptor for the whole read. The old path called existsSync,
  // statSync, openSync (sniff), close, then openSync again inside
  // readLineRange — four independent resolutions of the same name, so the file
  // could be swapped between any two of them, and every one of them followed
  // symlinks. Writes have been descriptor-relative since v21.1; this closes the
  // same window on the read side: the fd is opened once with O_NOFOLLOW on
  // every component, and the size, the binary sniff and the streamed window all
  // come from THAT descriptor.
  let opened
  try {
    opened = projectOpenRead(ctx, p)
  } catch (e) {
    return readErrorText(e, p)
  }
  const { fd, stat } = opened
  try {
    // binary sniff on the first 8KB — never dump mojibake into the context
    const sniff = Buffer.alloc(Math.min(8192, stat.size))
    if (sniff.length) fs.readSync(fd, sniff, 0, sniff.length, 0)
    if (sniff.includes(0)) return `ERROR: binary file (not readable as text): ${p}`
    // v20.1: stream the window out of the file instead of slurping it
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
    const limit = Math.min(2000, Math.floor(Number(args.limit) || 400))
    const { lines, total, truncated, scanned, completed } = readLineRange(fd, offset - 1, offset - 1 + limit)
    const eof = completed || scanned >= stat.size
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
    if (!lines.length) {
      if (offset > total && eof) return `ERROR: offset ${offset} is past the end of the file (${total} line${total === 1 ? "" : "s"})`
      if (!eof) {
        return `ERROR: file too large to page that far — read_file scans at most ${mb(READ_SCAN_CAP)} of ${mb(stat.size)}; ` +
          `offset ${offset} starts beyond line ${total}. Use grep_files to locate the section first.`
      }
      return "(empty file)"
    }
    const numbered = lines.map((l, i) => String(offset + i).padStart(5) + "| " + l).join("\n")
    let note = ""
    const shown = offset - 1 + lines.length
  // v120: every one of these said "there is more" without saying WHERE. The
  // caller then had to derive the next offset itself, and in a real run a
  // 616-line file was paged in three guessed windows. The next offset is the
  // one fact the note is for; it costs nothing to state it.
    const nextOffset = shown + 1
    if (truncated) note = `\n... (read_file kept ${mb(READ_MAX_BYTES)} — continue with offset: ${nextOffset})`
    else if (eof && total > shown) note = `\n... (${total - shown} more lines; total ${total} — continue with offset: ${nextOffset})`
    else if (!eof) note = `\n... (more lines follow — continue with offset: ${nextOffset})`
    return cap(numbered + note, ctx.maxToolOutput)
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

function read_image(ctx, args) {
  const rel = String(args.path ?? "").trim()
  if (isRemotePath(rel)) return "ERROR: read_image is local files only (no remote fetch)"
  const sp = safePath(ctx, rel)
  if (!sp.ok) return sp.error
  const rec = loadLocalImage(sp.abs)
  if (!rec.ok) return rec.error
  const visionOn = ctx.vision !== false
  const capable = visionOn && providerSupportsVision(ctx.visionProvider)
  let attached = false
  let reason = ""
  if (!visionOn) reason = "tools.vision is false (metadata only)"
  else if (!capable) reason = "provider/model does not accept image parts (metadata only — never fake vision)"
  else if (rec.tooBig || !rec.buf) reason = `too large to attach (cap ${MAX_IMAGE_BYTES} bytes)`
  else if ((ctx._pendingVision?.length ?? 0) >= MAX_PENDING) reason = `pending vision cap (${MAX_PENDING} per turn)`
  else if (queuePendingVision(ctx, rec)) attached = true
  else reason = "could not queue image part"
  return formatImageToolResult(rec, { attached, reason })
}

function write_file(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  const existed = fs.existsSync(p)
  // v20: one checkpoint covers the whole mutation — existing files get
  // backups, newly created files get tracked for undo-removal
  const id = snapshotBefore([p], ctx.cwd, existed ? [] : [p], ctx.runId)
  try {
    projectWrite(ctx, p, args.content ?? "")
  } catch (e) {
    return writeErrorText(e, p)
  }
  if (id) { sealCreated(id, ctx.cwd); sealEdited(id, ctx.cwd) } // v94 todowise: post-write seal enables drift attribution at restore
  const cpNote = !id && existed ? " — ⚠ checkpoint failed: this change cannot be undone" : ""
  return `OK wrote ${p} (${(args.content ?? "").length} bytes${existed ? "" : ", created"})${cpNote}`
}

function edit_file(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  if (!fs.existsSync(p)) return `ERROR: not found: ${p}`
  const src = fs.readFileSync(p, "utf8")
  const oldS = args.old ?? ""
  const newS = args.new ?? ""
  if (!src.includes(oldS)) return "ERROR: old string not found in file"
  if (!args.replace_all && src.indexOf(oldS) !== src.lastIndexOf(oldS)) {
    return "ERROR: old string appears multiple times — add more surrounding context to make it unique, or set replace_all=true"
  }
  const cpId = snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  const out = args.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, newS)
  try {
    projectWrite(ctx, p, out)
  } catch (e) {
    return writeErrorText(e, p)
  }
  if (cpId) sealEdited(cpId, ctx.cwd) // v94 todowise: post-write seal enables drift attribution at restore
  return `OK edited ${p}${cpId ? "" : " — ⚠ checkpoint failed: this change cannot be undone"}`
}

// --- shared walk policy (v20.2 P1-2) ---------------------------------------
// One SKIP set for list_dir / grep_files / glob_files (they used to diverge:
// grep_files was missing .turbo/.cache). These are always-noise directories —
// dependency trees, VCS metadata, build/venv output — that only waste the
// agent's context and slow the walk.
const DEFAULT_SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "coverage", "__pycache__", ".turbo", ".cache",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle",
])

/**
 * Best-effort .gitignore directory awareness: read the walk root's .gitignore
 * and return the set of plain directory names it ignores, so the file tools
 * stop indexing a repo's own generated/ignored folders. Deliberately
 * conservative — only bare names (no slashes, no glob metacharacters, not
 * negated) are honored, and only directories are ever skipped, so a gitignored
 * FILE the user asks about is still readable. Cached per root. Never throws.
 */
const _gitignoreCache = new Map()
function gitignoreSkip(root) {
  if (_gitignoreCache.has(root)) return _gitignoreCache.get(root)
  const out = new Set()
  try {
    const raw = fs.readFileSync(path.join(root, ".gitignore"), "utf8")
    for (let line of raw.split("\n")) {
      line = line.trim()
      if (!line || line.startsWith("#") || line.startsWith("!")) continue
      const name = line.replace(/^\/+/, "").replace(/\/+$/, "")
      if (!name || name.includes("/") || /[*?\[\]]/.test(name)) continue
      out.add(name)
    }
  } catch { /* no .gitignore — fine */ }
  _gitignoreCache.set(root, out)
  return out
}

/** Merged skip predicate for a walk rooted at `root`. */
function skipSetFor(root) {
  const gi = gitignoreSkip(root)
  return gi.size ? new Set([...DEFAULT_SKIP, ...gi]) : DEFAULT_SKIP
}


/**
 * v104 §4/§5 — the workspace boundary for TRAVERSAL, enforced in code.
 *
 * `grep_files`, `glob_files` and `list_dir` walk a directory tree. Pointed
 * outside the resolved workspace they become exactly what §5 forbids: a blind
 * recursive scan of the home directory or the filesystem root. Measured before
 * this guard existed: `grep_files` over $HOME took 8.65 SECONDS and read every
 * file it could open, and `list_dir "/"` walked bin/, boot/, dev/ and the rest.
 * That is a correctness, privacy, determinism and battery problem all at once,
 * and on a phone it is the difference between a run and a dead session.
 *
 * `ctx.allowOutsideProject` has existed since v21 — plumbed from config through
 * agent.js and chat.js into every tool context, and READ BY NOTHING. The flag
 * promised a boundary that was never implemented. This is that boundary, so
 * the grant finally means what its name says.
 *
 * Deliberately narrow:
 *   - TRAVERSAL only. A targeted read of a path the model named outright is
 *     bounded and cheap; v88 unrestricted reads on purpose and this does not
 *     quietly reverse that decision.
 *   - The workspace root, not the cwd. A subdirectory of the project is fine.
 *   - Refusal names the boundary and the exact grant that lifts it, so the
 *     model can act on it instead of guessing.
 */
export function traversalBoundary(ctx, target) {
  if (ctx?.allowOutsideTraversal === true) return null
  const root = ctx?.root ?? ctx?.cwd
  if (!root || !target) return null
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const r = real(root)
  const t = real(target)
  if (t === r || t.startsWith(r + path.sep)) return null
  return `BLOCKED: ${t} is outside the workspace (${r}). Searching there would scan a tree this task has no target in — say which path inside the workspace to search, or the user can allow it with: forge config set tools.allowOutsideProject true (full control: forge yolo on)`
}

function list_dir(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const outside = traversalBoundary(ctx, sp.abs)
  if (outside) return outside
  const root = sp.abs
  if (!fs.existsSync(root)) return `ERROR: not found: ${root}`
  const SKIP = skipSetFor(root)
  const lines = []
  const walk = (dir, depth, prefix) => {
    if (depth > 2 || lines.length > 300) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      lines.push(prefix + "(unreadable)")
      return
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        lines.push(prefix + e.name + "/")
        walk(full, depth + 1, prefix + "  ")
      } else {
        let size = ""
        try { size = " " + fs.statSync(full).size + "B" } catch {}
        lines.push(prefix + e.name + size)
      }
      if (lines.length > 300) { lines.push("... (truncated at 300 entries)"); return }
    }
  }
  walk(root, 0, "")
  return lines.join("\n") || "(empty)"
}

/**
 * Reject a pattern that can backtrack catastrophically BEFORE running it.
 *
 * grep_files compiles a pattern the MODEL wrote and runs it over every line of
 * every file in a tree. JavaScript has no regex timeout, so one nested
 * quantifier freezes the agent process outright — `(a+)+$` against a 41-char
 * line never returns. That is not hypothetical; it is how this guard was found.
 *
 * The shape that blows up is a quantified group whose own last token is
 * unbounded: `(a+)+`, `(\s*\w+)+`, `([a-z]+)*`, `(x{2,})+`. Requiring the
 * quantifier to be the group's LAST token keeps anchored patterns like
 * `(a+b)+` — which cannot blow up — working.
 *
 * Deliberately conservative and deliberately honest: it does not claim to catch
 * every catastrophic pattern (overlapping alternation like `(a|a)*` is not
 * detected), so the deadline in the walk is the second line of defence. A
 * rejected pattern gets an error naming the problem, never a silent hang.
 */
const CATASTROPHIC_RE = /\((?![?])[^()]*(?:[+*]|\{\d+,\})\)\s*(?:[+*]|\{\d+,\})/

export function riskyRegexReason(pattern) {
  const p = String(pattern ?? "")
  if (!p) return null
  if (CATASTROPHIC_RE.test(p)) {
    return "nested quantifier (a group ending in + or * that is itself repeated) — this backtracks exponentially and would hang the run"
  }
  return null
}

/** Wall-clock budget for one grep. A pattern that is merely SLOW (not provably
 *  catastrophic) still has to end: the walk stops at the deadline and says so,
 *  rather than returning nothing after an unbounded wait. */
const GREP_DEADLINE_MS = 5000

function grep_files(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const outside = traversalBoundary(ctx, sp.abs)
  if (outside) return outside
  const root = sp.abs
  const risky = riskyRegexReason(args.pattern)
  if (risky) return `ERROR: unsafe regex: ${risky}. Rewrite it without the nested repeat (for example \`\\w+\` instead of \`(\\w+)+\`).`
  let re
  try {
    re = new RegExp(args.pattern, "i")
  } catch (e) {
    return `ERROR: bad regex: ${e.message}`
  }
  const glob = args.glob ? new RegExp("^" + args.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null
  const max = Math.min(120, args.max || 60)
  const SKIP = skipSetFor(root)
  const results = []
  const deadline = Date.now() + GREP_DEADLINE_MS
  let timedOut = false
  const walk = (dir, depth) => {
    if (results.length >= max || depth > 8) return
    if (Date.now() > deadline) { timedOut = true; return }
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (results.length >= max) return
      if (Date.now() > deadline) { timedOut = true; return }
      if (SKIP.has(e.name)) continue
      // v20: hidden entries are never descended into (stops .cache/.config walks)
      if (e.name.startsWith(".") && path.resolve(dir) !== path.resolve(root)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (glob && !glob.test(e.name)) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size > 1024 * 1024) continue
        const text = fs.readFileSync(full, "utf8")
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          // checked per line so a slow pattern cannot run past the budget on
          // one large file (a single catastrophic test() is what the pre-screen
          // above is for — this bounds the aggregate)
          if ((i & 0x3f) === 0 && Date.now() > deadline) { timedOut = true; break }
          if (re.test(lines[i])) {
            results.push(path.relative(ctx.cwd, full) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 240))
            if (results.length >= max) break
          }
        }
      } catch {}
    }
  }
  walk(root, 0)
  const note = timedOut ? `\n... (search stopped at the ${GREP_DEADLINE_MS / 1000}s budget — results may be incomplete; narrow the pattern or the path)` : ""
  if (!results.length) return timedOut ? `(no matches yet)${note}` : "(no matches)"
  return results.join("\n") + note
}

// --- skills ------------------------------------------------------------------

/** v20: skill names are plain directory names — no separators, no traversal. */
export function validSkillName(name) {
  const n = String(name ?? "").trim()
  if (!n || n.length > 64) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return null
  if (n.includes("..")) return null
  return n
}

function load_skill(ctx, args) {
  // validate the NAME first — never touch the filesystem with a hostile name
  const name = validSkillName(args.name)
  if (!name) return `ERROR: invalid skill name "${String(args.name ?? "")}" — use the plain skill directory name (no paths)`
  if (ctx.skillsDir) {
    const base = realPathOf(ctx.skillsDir)
    const target = path.join(ctx.skillsDir, name, "SKILL.md")
    const sp = safePath({ ...ctx, root: ctx.skillsDir }, path.join(name, "SKILL.md"))
    if (!sp.ok) return sp.error
    const real = realPathOf(target)
    if (!insideDir(real, base)) return `ERROR: skill path escapes the skills directory`
    if (fs.existsSync(target)) {
      const md = fs.readFileSync(target, "utf8")
      // v94b: serve up to 64KB (the same ceiling checkSkills enforces) so large
      // bundled playbooks (e.g. the understand-anything pack) load intact, and
      // prefix the resolved skill directory so the agent can locate the skill's
      // own helper scripts / agent definitions without guessing.
      const body = md.length > 65536 ? md.slice(0, 65536) + "\n... (truncated)" : md
      return `[skill dir: ${path.dirname(target)}]\n\n${body}`
    }
  }
  const learned = ctx.cwd ? readLearnedSkill(ctx.cwd, name) : null
  if (learned) return learned
  const play = ctx.cwd ? readLearnedPlaybookByName(ctx.cwd, name) : null
  if (play) return play
  const downloaded = readDownloadedSkill(name)
  if (downloaded) return downloaded
  const toolPlay = readDownloadedToolPlaybook(name)
  if (toolPlay) return toolPlay
  // v165: the first-party playbooks the prompt names ("PLAYBOOKS: …") — a
  // skill of the same name, learned or installed, is found first above
  const firstParty = playbookText(name)
  if (firstParty) return firstParty
  if (!ctx.skillsDir) return "ERROR: no skills directory configured"
  return `ERROR: skill not found: ${name}`
}

// --- web ---------------------------------------------------------------------

async function fetch_url(ctx, args) {
  const url = String(args.url || "").trim()
  if (!/^https?:\/\//i.test(url)) return "ERROR: only absolute http(s) URLs are supported"
  let host = ""
  try { host = new URL(url).hostname } catch { return "ERROR: malformed URL" }
  // v21.1 SSRF guard with DNS PINNING (netguard.pinnedFetch): the host is
  // resolved ONCE, every record is validated (private, loopback, link-local,
  // CGNAT, multicast, IPv6 ULA/link-local, IPv4-mapped/NAT64/6to4/Teredo…),
  // and the socket is pinned to exactly those addresses — the fetch never
  // performs a second, uncontrolled DNS lookup (no rebinding window). Every
  // redirect hop is resolved, validated and pinned again. Local stacks
  // (Ollama, SearXNG) can opt in via tools.fetchPrivateUrls /
  // FORGE_ALLOW_PRIVATE_URLS=1.
  try {
    const res = await pinnedFetch(url, {
      headers: { "user-agent": `forge-agent/${VERSION}`, accept: "text/*,application/json;q=0.9,*/*;q=0.5" },
      allowPrivate: true, // v88 noguard: local/private fetches allowed — no SSRF gate on fetch_url
      timeoutMs: 15000,
      totalTimeoutMs: 30000,
      maxRedirects: 5,
      maxBytes: 2 * 1024 * 1024,
      signal: ctx.signal ?? undefined,
    })
    if (!res.ok) return `ERROR: HTTP ${res.status} for ${res.url}`
    const ct = String(res.headers["content-type"] || "")
    if (!/text|json|xml|javascript|csv|markdown|html|yaml/i.test(ct)) return `ERROR: non-text content-type (${ct}) — binary not supported`
    let text = new TextDecoder().decode(res.body)
    if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim()
    }
    const via = res.hops.length > 1 ? `\n(redirected ${res.hops.length - 1}× → ${res.url})` : ""
    return cap(`URL: ${url}${via}\nContent-Type: ${ct}\n\n${text}`, ctx.maxToolOutput)
  } catch (e) {
    if (e instanceof PinnedFetchError && e.blocked) {
      const hop = e.hop ? ` (redirect hop ${e.hop} → ${String(e.url).slice(0, 120)})` : ""
      return `ERROR: fetch integrity failure: ${e.message}${hop} (the socket must connect to exactly the validated addresses — v88 noguard removed the private-URL gate, not socket pinning)`
    }
    if (e instanceof PinnedFetchError && e.code === "ETOOLARGE") return `ERROR: ${e.message} (limit 2MB)`
    if (e instanceof PinnedFetchError && e.code === "ABORT_ERR") return "ERROR: cancelled — fetch stopped by user interrupt"
    return `ERROR: fetch failed: ${String(e?.message ?? e).slice(0, 200)}`
  }
}

// --- v15 tools ----------------------------------------------------------------

function globToRegex(pattern) {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // v20.0.1: "**/" must match ZERO or more directories — otherwise the
        // most common pattern of all ("**/*.ts") silently missed every file
        // that sits directly in the search root.
        if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2 } else { re += ".*"; i++ }
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + re + "$")
}

function glob_files(ctx, args) {
  const sp = safePath(ctx, args.path || ".")
  if (!sp.ok) return sp.error
  const outside = traversalBoundary(ctx, sp.abs)
  if (outside) return outside
  const root = sp.abs
  if (!fs.existsSync(root)) return `ERROR: not found: ${root}`
  let re
  try { re = globToRegex(String(args.pattern || "*")) } catch (e) { return `ERROR: bad pattern: ${e.message}` }
  const max = Math.min(200, args.max || 100)
  const SKIP = skipSetFor(root)
  const hits = []
  const walk = (dir, depth) => {
    if (hits.length >= max || depth > 10) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (hits.length >= max) return
      if (SKIP.has(e.name)) continue
      if (e.name.startsWith(".") && path.resolve(dir) !== path.resolve(root)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      const rel = path.relative(root, full).split(path.sep).join("/")
      if (re.test(rel) || re.test(path.basename(rel))) {
        let mt = 0
        try { mt = fs.statSync(full).mtimeMs } catch {}
        hits.push({ rel, mt })
      }
    }
  }
  walk(root, 0)
  hits.sort((a, b) => b.mt - a.mt)
  return hits.length ? hits.map((h) => h.rel).join("\n") : "(no matches)"
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .trim()
}

async function web_search(ctx, args) {
  const q = String(args.query || "").trim()
  if (!q) return "ERROR: empty query"
  const max = Math.min(10, args.max || 6)
  // v94 masterwise (§3/§4): adaptive multi-provider search with honest failure
  // handling. The provider layer (searchproviders.js) keeps every historical
  // contract: pinnedFetch-only egress, user-config searchUrl (never project
  // config), UA forge-agent/<version>, first-hop private allowance for the
  // configured endpoint, dedupe + BM25 ranking, and a `tried[]` disclosure on
  // failure. Firecrawl is a first-class provider when FIRECRAWL_API_KEY is
  // set; DuckDuckGo Lite remains the zero-config fallback. A fresh TTL cache
  // on the normalized query avoids re-hitting the network for repeat
  // searches; cached answers are attributed as such. Failures are NEVER
  // reported as fabricated "no results" — they carry the real diagnosis.
  try {
    const { runWebSearch } = await import("./searchproviders.js")
    const out = await runWebSearch({
      query: q, max,
      searchUrl: ctx.searchUrl || "",
      fetchPrivateUrls: ctx.fetchPrivateUrls === true,
      signal: ctx.signal ?? undefined,
    })
    if (out.ok) {
      const body = formatSearch(q, out.results, [])
      const tag = out.cached
        ? `\n(provider: ${out.provider}, cached ${out.ageSec}s ago)`
        : `\n(provider: ${out.provider})`
      return cap(body + tag, 8000)
    }
    return out.error
  } catch (e) {
    // the provider layer never throws; this guard keeps it that way
    return `ERROR: web_search failed: ${String(e?.message ?? e).slice(0, 160)}`
  }
}

function formatSearch(q, results, tried) {
  const lines = [`web search: "${q}"`]
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}`))
  return cap(lines.join("\n"), 8000)
}

function multi_edit(ctx, args) {
  const sp = safePath(ctx, args.path, { write: true })
  if (!sp.ok) return sp.error
  const p = sp.abs
  if (!fs.existsSync(p)) return `ERROR: not found: ${p}`
  const src = fs.readFileSync(p, "utf8")
  const edits = Array.isArray(args.edits) ? args.edits : []
  if (!edits.length) return "ERROR: no edits provided"
  // validate ALL edits first — atomic: one bad edit means zero changes
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (!src.includes(e.old ?? "")) return `ERROR: edit ${i + 1}: old string not found in file (no changes applied)`
    if (!e.replace_all && src.indexOf(e.old) !== src.lastIndexOf(e.old)) {
      return `ERROR: edit ${i + 1}: old string appears multiple times — add context or set replace_all (no changes applied)`
    }
  }
  let out = src
  let applied = 0
  for (const e of edits) {
    if (e.replace_all) { applied += out.split(e.old).length - 1; out = out.split(e.old).join(e.new ?? "") }
    else { out = out.replace(e.old, e.new ?? ""); applied++ }
  }
  const cpId = snapshotBefore([p], ctx.cwd, [], ctx.runId) // v16: auto-checkpoint
  try {
    projectWrite(ctx, p, out)
  } catch (e) {
    return writeErrorText(e, p)
  }
  if (cpId) sealEdited(cpId, ctx.cwd) // v94 todowise: post-write seal enables drift attribution at restore
  return `OK multi_edit ${p}: ${applied} replacement(s), ${edits.length} edit(s), atomic${cpId ? "" : " — ⚠ checkpoint failed: this change cannot be undone"}`
}

// --- v16 apply_patch -----------------------------------------------------------

function apply_patch(ctx, args) {
  const patchText = String(args.patch ?? "")
  if (!patchText.trim()) return "ERROR: no patch text provided"
  // 1. parse the diff
  let parsed
  try {
    parsed = parsePatch(patchText)
  } catch (e) {
    return `ERROR: ${e.message}`
  }
  // 2. collect target paths and load current contents (missing files = creation)
  const paths = []
  for (const f of parsed) {
    const target = f.oldPath === "/dev/null" ? f.newPath : f.newPath === "/dev/null" ? f.oldPath : f.newPath || f.oldPath
    if (!target || target === "/dev/null") return "ERROR: patch file section without a target path"
    if (paths.includes(target)) return `ERROR: patch targets ${target} more than once`
    paths.push(target)
  }
  // v20: boundary + sensitive validation BEFORE anything else
  const sps = paths.map((t) => safePath(ctx, t, { write: true }))
  for (const sp of sps) {
    if (!sp.ok) return sp.error
  }
  const filesMap = new Map()
  for (const t of paths) {
    const sp = safePath(ctx, t, { write: true })
    if (fs.existsSync(sp.abs)) {
      const st = fs.statSync(sp.abs)
      if (st.isDirectory()) return `ERROR: is a directory: ${t}`
      try {
        filesMap.set(t, fs.readFileSync(sp.abs, "utf8"))
      } catch {
        return `ERROR: cannot read ${t}`
      }
    }
  }
  // 3. validate + compute everything in memory — atomic: any bad hunk aborts all
  let applied
  try {
    applied = applyParsedPatch(filesMap, parsed)
  } catch (e) {
    return `ERROR: ${e.message} (no changes applied)`
  }
  // 4. checkpoint originals AND track creations (v20: undo removes them),
  //    then write once
  const checkpointId = snapshotBefore(
    paths.filter((t) => filesMap.has(t)).map((t) => safePath(ctx, t).abs),
    ctx.cwd,
    applied.created.map((t) => safePath(ctx, t).abs),
    ctx.runId, // v20.4 fix: patch checkpoints were the only ones missing the run tag (→ /undo --run skipped them)
  )
  // Per-file writes are atomic (temp → fsync → rename, symlink-safe). If one
  // file cannot be written the already-written files are rolled back from
  // the checkpoint so the patch stays all-or-nothing on disk too.
  const written = []
  for (const [t, content] of applied.results) {
    const p = safePath(ctx, t, { write: true }).abs
    try {
      projectWrite(ctx, p, content)
      written.push(p)
    } catch (e) {
      let rolled = ""
      if (checkpointId) {
        try {
          const r = restoreTransactional(checkpointId, { cwd: ctx.cwd })
          rolled = r?.ok ? " — earlier files of this patch were rolled back" : ` — ROLLBACK ${r?.status ?? "FAILED"}: ${written.length} file(s) may be partially patched, run forge undo`
        } catch { rolled = ` — ROLLBACK FAILED: ${written.length} file(s) may be partially patched, run forge undo` }
      }
      return `${writeErrorText(e, p)}${rolled}`
    }
  }
  const unlinkFailed = []
  for (const t of applied.deleted) {
    const p = safePath(ctx, t, { write: true }).abs
    try { projectUnlink(ctx, p) } catch (e) { unlinkFailed.push(`${t} (${e?.code ?? e?.message})`) }
  }
  if (checkpointId) { sealCreated(checkpointId, ctx.cwd); sealEdited(checkpointId, ctx.cwd) } // v94 todowise: post-write seal enables drift attribution at restore
  if (unlinkFailed.length) return `ERROR: patch applied but could not delete ${unlinkFailed.join(", ")} — files were written; run forge undo to revert`
  const parts = []
  if (applied.created.length) parts.push(`created ${applied.created.join(", ")}`)
  if (applied.deleted.length) parts.push(`deleted ${applied.deleted.join(", ")}`)
  parts.push(`patched ${applied.results.size - applied.created.length} existing file(s)`)
  return `OK apply_patch — ${parts.join(" • ")} (atomic, checkpointed)`
}

// --- git ------------------------------------------------------------------------

function git_status(ctx) {
  const opts = { cwd: ctx.cwd, timeout: 8000, maxBuffer: 512 * 1024 }
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain=v1", "-b"], opts, (err, stdout) => {
      if (err) return resolve("ERROR: not a git repository (or git unavailable)")
      const lines = stdout.split("\n").filter((l) => l.trim())
      const branch = lines[0] ?? ""
      const changed = lines.slice(1)
      execFile("git", ["log", "--oneline", "-5"], opts, (e2, logOut) => {
        const log = e2 ? [] : String(logOut).split("\n").filter((l) => l.trim())
        execFile("git", ["diff", "--stat", "HEAD"], opts, (e3, diffOut) => {
          const out = [
            `git ${branch}`,
            changed.length ? `changes (${changed.length}):\n` + changed.slice(0, 40).map((l) => "  " + l).join("\n") : "working tree clean",
            log.length ? "recent commits:\n" + log.map((l) => "  " + l).join("\n") : "",
            !e3 && diffOut.trim() ? "diffstat:\n" + String(diffOut).trim().split("\n").slice(-3).map((l) => "  " + l).join("\n") : "",
          ].filter(Boolean)
          resolve(cap(out.join("\n"), ctx.maxToolOutput))
        })
      })
    })
  })
}

// --- git inspection (v90): git_diff / git_log / git_blame -----------------------
// All three are read-only views over git plumbing, executed via execFile with
// argument arrays (never a shell string), output secret-redacted by cap() and
// token-budgeted so a huge diff can never blow the context.

function gitExec(ctx, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ctx.cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout ?? ""), errText: String(stderr ?? "") })
    })
  })
}

const GIT_REF_RE = /^[A-Za-z0-9._/~^-]{1,64}$/

/**
 * Validate a git PATHSPEC before it reaches spawn.
 *
 * Found by fuzzing every tool with hostile args: 411 of 414 combinations
 * returned an honest ERROR string, but `git_diff`, `git_log` and `git_blame`
 * THREW on a path containing a NUL byte — child_process rejects the argv entry,
 * and the throw escaped the tool instead of becoming a result the model can
 * read and recover from. Every other file tool already answers a NUL path with
 * an error (read_file: `invalid path component`), so this restores the contract
 * these three broke rather than inventing a new one.
 *
 * Returns an ERROR string when the pathspec is unusable, or null when it is fine.
 */
function gitPathspecError(p) {
  const s = String(p ?? "")
  if (!s) return null
  if (s.includes("\0")) return `ERROR: invalid path — it contains a NUL byte`
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) return `ERROR: invalid path — it contains a control character`
  // NOTE: a leading "-" is NOT rejected. It looks like a flag, but all three
  // callers pass the path after `--`, which ends git's option parsing, and the
  // argv is handed to execFile rather than a shell — so `-report.txt` is just
  // a tracked file with an awkward name, and refusing it would be a bug, not a
  // guard. (Verified against git: add/log/blame/diff all accept it after `--`.)
  return null
}

async function git_diff(ctx, args = {}) {
  const base = String(args.base ?? "HEAD")
  const pathFilter = args.path ? String(args.path) : null
  const badPath = gitPathspecError(pathFilter)
  if (badPath) return badPath
  const context = Math.max(0, Math.min(10, Number(args.context ?? 3) || 0))
  const maxLines = Math.max(20, Math.min(2000, Number(args.max_lines ?? 400) || 400))
  if (!GIT_REF_RE.test(base) || base.startsWith("-")) return "ERROR: invalid base — use 'HEAD', 'stage', 'worktree', or a commit/branch/tag name"

  // target selection: HEAD = staged+unstaged vs HEAD · stage = staged only ·
  // worktree = unstaged only · anything else = working tree vs that ref
  const target = []
  if (base === "stage") target.push("--cached")
  else if (base !== "worktree") target.push(base)
  const tail = pathFilter ? ["--", pathFilter] : []

  const stat = await gitExec(ctx, ["diff", "--no-color", "--no-ext-diff", "--stat", ...target, ...tail])
  const d = await gitExec(ctx, ["diff", "--no-color", "--no-ext-diff", `-U${context}`, ...target, ...tail])
  if (d.err && /not a git repository/i.test(d.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (d.err) return "ERROR: git diff failed: " + d.errText.trim().split("\n")[0].slice(0, 200)

  const body = d.out.replace(/\n$/, "")
  const where = base === "stage" ? "staged" : base === "worktree" ? "in the working tree" : "vs " + base
  if (!body) return `(no differences ${where}${pathFilter ? " for " + pathFilter : ""})`

  const statLine = stat.err ? "" : String(stat.out).trim()
  const lines = body.split("\n")
  if (lines.length <= maxLines) return cap([statLine, body].filter(Boolean).join("\n\n"), ctx.maxToolOutput)

  // over budget: diffstat + head of the diff + how to narrow. Never silently
  // drop the middle of a diff the model believes it saw in full.
  const head = lines.slice(0, maxLines).join("\n")
  return cap(
    [
      `diff ${where}${pathFilter ? " — " + pathFilter : ""} is ${lines.length} lines; showing the first ${maxLines}`,
      statLine,
      "",
      head,
      "",
      `… ${lines.length - maxLines} more diff lines — narrow with path=, a lower context=, or read specific files`,
    ].filter(Boolean).join("\n"),
    ctx.maxToolOutput
  )
}

async function git_log(ctx, args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 15) || 15))
  const pathFilter = args.path ? String(args.path) : null
  const badPath = gitPathspecError(pathFilter)
  if (badPath) return badPath
  const a = ["log", "--no-color", "--date=short", "--pretty=format:%h %ad %an %s", "-n", String(limit)]
  if (args.stat === true) a.push("--stat")
  if (pathFilter) a.push("--", pathFilter)
  const r = await gitExec(ctx, a)
  if (r.err && /not a git repository/i.test(r.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (r.err) return "ERROR: git log failed: " + r.errText.trim().split("\n")[0].slice(0, 200)
  const body = r.out.replace(/\n+$/, "")
  if (!body) return `(no commits${pathFilter ? " touching " + pathFilter : ""})`
  return cap(body, ctx.maxToolOutput)
}

async function git_blame(ctx, args = {}) {
  const file = String(args.path ?? "")
  if (!file) return "ERROR: path is required"
  const badPath = gitPathspecError(file)
  if (badPath) return badPath
  const start = Math.max(1, Number(args.start ?? 1) || 1)
  let end = Number(args.end ?? start + 39)
  if (!Number.isFinite(end) || end < start) end = start
  const WINDOW = 200
  let clamped = false
  if (end - start + 1 > WINDOW) { end = start + WINDOW - 1; clamped = true }

  const r = await gitExec(ctx, ["blame", "--date=short", "-w", "-L", `${start},${end}`, "--", file])
  if (r.err && /not a git repository/i.test(r.errText)) return "ERROR: not a git repository (or git unavailable)"
  if (r.err && /no such path|does not exist/i.test(r.errText)) return `ERROR: ${file} is not tracked by git (untracked or missing)`
  if (r.err) return "ERROR: git blame failed: " + r.errText.trim().split("\n")[0].slice(0, 200)

  const body = r.out.replace(/\n$/, "")
  if (!body) return `(nothing to blame for ${file} lines ${start}-${end})`
  return cap((clamped ? `… blame window capped at ${WINDOW} lines (use start=/end= to move it)\n` : "") + body, ctx.maxToolOutput)
}

function runGithub(ctx, args = {}) {
  const inspect = ghInspect({
    action: String(args.action || "repo"),
    id: String(args.id || ""),
    cwd: ctx.cwd || process.cwd(),
  })
  const head = formatGithub(inspect)
  if (!inspect.ok) return head
  return cap(`${head}\n${inspect.preview || ""}`, ctx.maxToolOutput)
}

// --- todo / think -----------------------------------------------------------------

function readTodo(ctx) {
  try { return JSON.parse(fs.readFileSync(ctx.todoPath, "utf8")) } catch { return { items: [] } }
}

function renderTodo(items) {
  if (!items.length) return "(todo list is empty)"
  const mark = { todo: "[ ]", doing: "[~]", done: "[x]" }
  return items.map((it, i) => `${mark[it.status] || "[ ]"} ${i + 1}. ${it.content}`).join("\n")
}

/**
 * v196: start a todo list from a plan's steps — the same file and format the
 * `todo` tool writes, marked as seeded from a plan so the run's end can say
 * how many were done. Returns the items written ([] when there were none).
 */
export function seedTodo(todoPath, steps, { origin = "plan" } = {}) {
  const items = (Array.isArray(steps) ? steps : []).slice(0, 100).map((c, i) => ({ id: i + 1, content: String(c ?? "").slice(0, 200), status: "todo" })).filter((it) => it.content)
  if (!items.length || !todoPath) return []
  writeStateFile(todoPath, JSON.stringify({ items, origin, seededAt: Date.now() }, null, 1))
  return items
}

/** v196: how far a plan-seeded todo list got: { done, total, open: [contents] }, or null. */
export function planProgress(todoPath, { since = 0 } = {}) {
  let state = null
  try { state = JSON.parse(fs.readFileSync(todoPath, "utf8")) } catch { return null }
  if (state?.origin !== "plan" || !(Number(state.seededAt) >= since) || !Array.isArray(state.items) || !state.items.length) return null
  const open = state.items.filter((it) => it.status !== "done").map((it) => String(it.content ?? ""))
  return { done: state.items.length - open.length, total: state.items.length, open }
}

function todo(ctx, args) {
  const p = ctx.todoPath
  if (!p) return "ERROR: no todo path configured"
  const action = args.action || "list"
  if (ctx.readOnly && action !== "list") {
    return `BLOCKED: todo ${action} mutates persistent Forge state and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify`
  }
  const state = readTodo(ctx)
  if (action === "list") return renderTodo(state.items)
  if (action === "set") {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 100).map((it, i) => ({ id: i + 1, content: String(it.content ?? "").slice(0, 200), status: ["todo", "doing", "done"].includes(it.status) ? it.status : "todo" }))
    if (!items.length) return "ERROR: no items provided for action=set"
    try { writeStateFile(p, JSON.stringify({ items }, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
    return "TODO list saved:\n" + renderTodo(items)
  }
  if (action === "update") {
    const idx = (args.id ?? 0) - 1
    const it = state.items[idx]
    if (!it) return `ERROR: no todo item #${args.id} — use action=list to see ids`
    if (args.status && ["todo", "doing", "done"].includes(args.status)) it.status = args.status
    if (args.content) it.content = String(args.content).slice(0, 200)
    try { writeStateFile(p, JSON.stringify(state, null, 1)) } catch (e) { return `ERROR: ${e.message}` }
    return "TODO updated:\n" + renderTodo(state.items)
  }
  return `ERROR: unknown action "${action}" (set|list|update)`
}

function think(_ctx, args) {
  const t = String(args.thought ?? "").slice(0, 4000)
  if (!t.trim()) return "ERROR: empty thought"
  return "Noted. Reasoning recorded — continue with the plan."
}

// --- memory (v20: hierarchical + learning) ----------------------------------------

/** Who is writing memory: the model via a tool (sub-agent or not), tagged with the run. */
/**
 * v160: is `text` quoted from what the person said? Word for word, ignoring
 * case, punctuation and spacing — a paraphrase is the model's words, and the
 * model's words can come from anything it read. Short fragments do not
 * count: "use it" is in half of all requests.
 */
export const RULE_QUOTE_MIN_WORDS = 4
export function quotedFrom(text, said) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  const t = norm(text)
  if (!t || t.split(" ").length < RULE_QUOTE_MIN_WORDS) return false
  return ` ${norm(said)} `.includes(` ${t} `)
}

function memoryProvenance(ctx) {
  return { source: ctx.subAgent ? "subagent" : "tool", runId: ctx.runId ?? null }
}

function memory(ctx, args) {
  const action = args.action || "read"
  if (ctx.readOnly && action !== "read") {
    return `BLOCKED: memory ${action} mutates persistent Forge state and is disabled in read-only mode — read-only workers may only inspect/search/analyze/read/verify. Memory mutations: append, replace, learn are blocked.`
  }
  // v187: a note belongs to the project it was written in unless the model
  // says it is about the user. The scope used to default to global, so a note
  // about one repo ("…the project files in agentv19") was read in every other
  // project — and a run there went searching the whole disk for agentv19. A
  // standing rule the user states (rule=true) is theirs, so it stays global.
  const scope = args.scope === "project" || args.scope === "global" ? args.scope
    : action === "append" && args.rule === true ? "global" : "project"
  const globalPath = ctx.memoryPath || path.join(DEFAULT_DIR, "memory.md")
  const tierFile = (tier) => tier === "project" ? projectMemoryPath(ctx.cwd) : globalPath
  const tierLabel = (tier) => tier === "project" ? `PROJECT MEMORY (${path.basename(ctx.cwd)}):` : "MEMORY (~/.forge/memory.md — every project):"
  const readTier = (tier) => { try { return fs.readFileSync(tierFile(tier), "utf8") } catch { return "" } }

  if (action === "read") {
    // no scope: both tiers, each labelled — this project's notes and the
    // user's own, never another project's
    const tiers = args.scope === "project" || args.scope === "global" ? [scope] : ["project", "global"]
    const parts = tiers.map((t) => [t, readTier(t)]).filter(([, m]) => m.trim()).map(([t, m]) => `${tierLabel(t)}\n${m.trimEnd()}`)
    const empty = tiers.length === 2 ? "(memory is empty — append facts with action=append)" : `(${scope} memory is empty — append facts with action=append, scope=${scope})`
    return parts.length ? cap(parts.join("\n\n"), 4000) : empty
  }
  if (action === "append") {
    const text = String(args.text ?? "").trim().slice(0, 2000)
    if (!text) return "ERROR: no text to append"
    if (args.rule === true) {
      // v160: a standing rule the person stated in THIS task. Recorded as a
      // rule only when its text is quoted from their own words — never from
      // a file, a web page or a tool result, which could otherwise plant a
      // permanent instruction in every later run.
      const said = typeof ctx.userText === "function" ? ctx.userText() : ctx.userText
      if (!ctx.subAgent && quotedFrom(text, said)) {
        const r = appendMemory(scope, text, ctx.cwd, { source: "task", runId: ctx.runId ?? null })
        return r.ok ? `OK ${scope} rule recorded — it will be in every later run's USER RULES: "${text.slice(0, 80)}"` : `ERROR: ${r.error}`
      }
      const r = appendMemory(scope, text, ctx.cwd, memoryProvenance(ctx))
      return r.ok
        ? `OK saved as an ordinary ${scope} note, NOT as a rule: a rule's text must be quoted word for word from the user's own request, and this is not. Quote their words to record it as a rule.`
        : `ERROR: ${r.error}`
    }
    const r = appendMemory(scope, text, ctx.cwd, memoryProvenance(ctx))
    return r.ok ? `OK ${scope} memory appended: "${text.slice(0, 80)}"` : `ERROR: ${r.error}`
  }
  if (action === "replace") {
    const text = String(args.text ?? "").slice(0, 4000)
    // v161: replaces the notes; the user's rules are written back after them.
    // v187: in the scope it names, project by default — like append. It used
    // to always rewrite global memory, so after a read that shows both tiers
    // a tidied-up rewrite would copy this project's notes into every project.
    const r = replaceKeepingRules(tierFile(scope), text, memoryProvenance(ctx))
    if (!r.ok) return `ERROR: ${r.error}`
    return `OK ${scope} memory replaced (${r.chars} chars)` + (r.keptRules
      ? `; kept the user's ${r.keptRules} standing rule${r.keptRules === 1 ? "" : "s"} — rules are the user's, not notes. To remove one the user asks for, use action=forget quoting their words`
      : "")
  }
  if (action === "forget") {
    // v161: remove one note by its text. A RULE only when the person's own
    // request names it — the same guard that mints one (v160), so content the
    // model read can neither plant a rule nor erase one.
    const text = String(args.text ?? "").trim().slice(0, 400)
    if (!text) return "ERROR: forget needs text naming the note"
    const said = typeof ctx.userText === "function" ? ctx.userText() : ctx.userText
    const allowRule = !ctx.subAgent && quotedFrom(text, said)
    let r = forgetMatching(tierFile(scope), text, { allowRule })
    // no scope: a note saved before v187 (when the default was global) is
    // still found where it was written
    if (!r.ok && !r.rule && !r.matches && !/at least 4/.test(r.error ?? "") && !args.scope) {
      const g = forgetMatching(globalPath, text, { allowRule })
      if (g.ok || g.rule) r = { ...g, tier: "global" }
    }
    if (r.ok) return `OK forgot ${r.rule ? "the user's rule" : "note"} from ${r.tier ?? scope} memory: "${String(r.removed).slice(0, 80)}"`
    if (r.rule) return `NOT removed: "${text.slice(0, 80)}" is one of the user's standing rules, and only their own request can remove it — quote their words naming it, or they can run \`forge memory forget <n>\``
    return `ERROR: ${r.error}`
  }
  if (action === "learn") {
    const problem = String(args.problem ?? "").trim()
    const fix = String(args.fix ?? "").trim()
    if (!problem || !fix) return "ERROR: learn needs problem + fix (root_cause recommended)"
    const r = recordLearning({ problem, rootCause: args.root_cause ?? args.rootCause ?? "", fix }, ctx.cwd, memoryProvenance(ctx))
    return r.ok ? `OK recorded learning to project memory (${r.file}) — future tasks can retrieve it` : `ERROR: ${r.error}`
  }
  return `ERROR: unknown action "${action}" (read|append|replace|learn)`
}

// --- delegate (v20: roles + timeout + concurrency cap + depth guard) ---------------

const ROLE_DIRECTIVES = {
  researcher: "You are a RESEARCH sub-agent: investigate quickly, read code/docs, and report findings. Zero writes. Keep the report dense and under 400 words.",
  reviewer: "You are a CODE REVIEW sub-agent: inspect the relevant files for bugs, edge cases, and quality issues. Report concrete findings with file:line references. Zero writes.",
  tester: "You are a TEST sub-agent: figure out how this project is tested, run the relevant test/build commands (read-only analysis: you may NOT modify files), and report pass/fail evidence. Zero writes.",
  security: "You are a SECURITY sub-agent: look for injection, path traversal, unsafe deserialization, secret exposure, and permission issues. Report concrete risks with file:line references. Zero writes.",
  coder: "You are an ANALYSIS sub-agent for implementation planning: identify exact files and edits needed, but do NOT write — the main agent applies the changes.",
}

async function delegate(ctx, args) {
  // depth guard: sub-agents cannot spawn sub-agents (plan-mode CAN delegate —
  // its delegates are read-only and capped at depth 2)
  if (ctx.subAgent) return "ERROR: delegate is not available inside a sub-agent (depth limit)"
  const task = String(args.task ?? "").trim().slice(0, 2000)
  if (!task) return "ERROR: no task provided"
  if (typeof ctx.delegateRunner !== "function") return "ERROR: delegation not wired in this mode"
  const role = ROLE_DIRECTIVES[args.role] ? args.role : "researcher"
  // concurrency cap: never more than ctx._delegateMax sub-agents in flight
  if (ctx._delegateActive >= ctx._delegateMax) {
    return `ERROR: delegate limit reached (${ctx._delegateMax} sub-agents already running) — wait for them to finish or reduce parallel delegation.`
  }
  ctx._delegateActive++
  const timeoutMs = Math.max(1, ctx.delegateTimeoutSec ?? 180) * 1000
  const timedOut = { v: false }
  let timerId = null
  try {
    const work = Promise.resolve(ctx.delegateRunner(task, role))
    const timer = new Promise((resolve) => {
      timerId = setTimeout(() => { timedOut.v = true; resolve(null) }, timeoutMs)
    })
    const summary = await Promise.race([work, timer])
    if (timedOut.v || summary === null) {
      return `ERROR: sub-agent timed out after ${Math.round(timeoutMs / 1000)}s (agent.delegateTimeoutSec) — narrow the subtask or raise the limit`
    }
    return cap(`SUB-AGENT REPORT (${role}):\n${summary}`, ctx.maxToolOutput)
  } catch (e) {
    if (e?.name === "AbortError" || ctx.signal?.aborted) return "ERROR: cancelled — sub-agent stopped by user interrupt"
    return `ERROR: sub-agent failed: ${String(e?.message ?? e).slice(0, 200)}`
  } finally {
    if (timerId) clearTimeout(timerId)
    ctx._delegateActive--
  }
}

// ---------------------------------------------------------------------------
// self-test (forge doctor --tools)
// ---------------------------------------------------------------------------

export async function selfTestTools({ searchUrl, memoryPath, todoPath } = {}) {
  const os = await import("node:os")
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-"))
  // Hosted IDEs commonly inject Git author/committer variables. They take
  // precedence over `git -c user.*`, which made this self-test blame the host
  // bot instead of the fixture author. Keep the probe hermetic without
  // changing the user's real Git configuration.
  const gitProbeEnv = { ...process.env }
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"]) delete gitProbeEnv[key]
  const ctx = {
    cwd: tmp, root: tmp, timeoutSec: 8, maxToolOutput: 4000, skillsDir: null,
    searchUrl, memoryPath: memoryPath || path.join(tmp, "memory.md"), todoPath: todoPath || path.join(tmp, "todo.json"),
    delegateRunner: null, readOnly: false, allowOutsideProject: false, allowSudo: false, assumeYes: false,
    fetchPrivateUrls: true, delegateTimeoutSec: 60, _delegateActive: 0, _delegateMax: 2,
  }
  const t = async (name, fn) => {
    const t0 = Date.now()
    try {
      const r = await fn()
      const bad = typeof r === "string" && (r.startsWith("ERROR") || r.startsWith("BLOCKED"))
      const evidence = typeof r === "string" && r.includes("[echo verified]") ? "echo verified" : ""
      return { name, ok: !bad, ms: Date.now() - t0, note: bad ? String(r).slice(0, 80) : evidence }
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t0, note: String(e?.message ?? e).slice(0, 80) }
    }
  }
  const results = []
  results.push(await t("bash", async () => {
    const r = await execTool(ctx, "bash", { command: "echo doctor-ok" })
    if (typeof r === "string" && r.includes("doctor-ok")) return r + "\n[echo verified]" // evidence for doctor output
    return r
  }))
  results.push(await t("read_file", () => execTool(ctx, "write_file", { path: "probe.txt", content: "hello" }).then(() => execTool(ctx, "read_file", { path: "probe.txt" }))))
  {
    // 1×1 PNG (IHDR 1x1, IDAT, IEND) — doctor proves read_image without a provider
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000000020001e221bc330000000049454e44ae426082", "hex")
    fs.writeFileSync(path.join(tmp, "probe.png"), png)
    results.push(await t("read_image", () => execTool(ctx, "read_image", { path: "probe.png" })))
  }
  results.push(await t("write_file", () => execTool(ctx, "write_file", { path: "probe.txt", content: "v2" })))
  results.push(await t("edit_file", () => execTool(ctx, "edit_file", { path: "probe.txt", old: "v2", new: "v3" })))
  results.push(await t("multi_edit", () => execTool(ctx, "multi_edit", { path: "probe.txt", edits: [{ old: "v3", new: "a" }].slice(0, 1) })))
  results.push(await t("apply_patch", () =>
    execTool(ctx, "apply_patch", { patch: "--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1,1 @@\n+patch ok\n--- a/probe.txt\n+++ b/probe.txt\n@@ -1,1 +1,1 @@\n-a\n+APPLIED" })
  ))
  results.push(await t("git_status", async () => {
    const { execFileSync } = await import("node:child_process")
    try { execFileSync("git", ["init", "-q"], { cwd: tmp, env: gitProbeEnv }) } catch {}
    const r = await execTool(ctx, "git_status", {})
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return r + "\n[git verified]"
  }))
  results.push(await t("git_diff", async () => {
    const { execFileSync } = await import("node:child_process")
    try {
      execFileSync("git", ["add", "-A"], { cwd: tmp, env: gitProbeEnv })
      execFileSync("git", ["-c", "user.email=doctor@forge.local", "-c", "user.name=forge-doctor", "commit", "-q", "-m", "doctor probe"], { cwd: tmp, env: gitProbeEnv })
    } catch {}
    await execTool(ctx, "write_file", { path: "probe.txt", content: "diff probe v2" })
    const r = await execTool(ctx, "git_diff", {})
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("diff probe v2") ? r + "\n[diff verified]" : "ERROR: git_diff showed no probe change"
  }))
  results.push(await t("git_log", async () => {
    const r = await execTool(ctx, "git_log", { limit: 5 })
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("doctor probe") ? r + "\n[log verified]" : "ERROR: git_log missed the probe commit"
  }))
  results.push(await t("git_blame", async () => {
    // patched.txt was committed by the doctor and NOT modified after — its
    // blame lines carry the probe author (probe.txt was rewritten post-commit,
    // so it would blame to "Not Committed Yet").
    const r = await execTool(ctx, "git_blame", { path: "patched.txt", start: 1, end: 1 })
    if (typeof r === "string" && r.startsWith("ERROR")) return r
    return typeof r === "string" && r.includes("forge-doctor") ? r + "\n[blame verified]" : "ERROR: git_blame missed the probe author"
  }))
  results.push(await t("glob_files", () => execTool(ctx, "glob_files", { pattern: "*.txt" })))
  results.push(await t("list_dir", () => execTool(ctx, "list_dir", { path: "." })))
  results.push(await t("grep_files", () => execTool(ctx, "grep_files", { pattern: "v3|a", path: "." })))
  results.push(await t("todo", () => execTool(ctx, "todo", { action: "set", items: [{ content: "probe", status: "done" }] }).then(() => execTool(ctx, "todo", { action: "list" }))))
  results.push(await t("think", () => execTool(ctx, "think", { thought: "probe" })))
  results.push(await t("memory", () => execTool(ctx, "memory", { action: "append", text: "probe" }).then(() => execTool(ctx, "memory", { action: "read" }))))
  results.push({ name: "load_skill", ok: null, ms: 0, note: "needs skills dir" })
  results.push(await t("kg_query", () => execTool(ctx, "kg_query", { query: "project overview" })))
  results.push(await t("plan_whatif", () => execTool(ctx, "plan_whatif", { plan: [{ id: "n1", objective: "doctor probe step", read_only: true }] })))
  results.push(await t("code_context", () => execTool(ctx, "code_context", { query: "entry point" })))
  // network tools: SKIP cleanly when offline
  try {
    await pinnedFetch("https://example.com", { timeoutMs: 4000, totalTimeoutMs: 4000, maxBytes: 65536 })
    results.push(await t("fetch_url", () => execTool(ctx, "fetch_url", { url: "https://example.com" })))
    if (searchUrl) {
      results.push(await t("web_search", () => execTool(ctx, "web_search", { query: "forge cli", max: 2 })))
    } else {
      const r = await execTool(ctx, "web_search", { query: "forge cli", max: 2 })
      const bad = typeof r === "string" && (r.startsWith("ERROR") || r.startsWith("BLOCKED"))
      results.push(bad
        ? { name: "web_search", ok: null, ms: 0, note: "no searchUrl set; DDG fallback unreachable (ok — set tools.searchUrl)" }
        : { name: "web_search", ok: true, ms: 0, note: "DDG fallback" })
    }
  } catch {
    results.push({ name: "fetch_url", ok: null, ms: 0, note: "offline" })
    results.push({ name: "web_search", ok: null, ms: 0, note: "offline" })
  }
  results.push({ name: "delegate", ok: null, ms: 0, note: "needs a live provider" })
  {
    const { createMockDriver } = await loadBrowser()
    const r = await execTool({ ...ctx, _browserDriver: createMockDriver(), browser: true, vision: false }, "browser", { action: "status" })
    const bad = typeof r === "string" && r.startsWith("ERROR")
    results.push({ name: "browser", ok: bad ? false : true, ms: 0, note: String(r).slice(0, 80) })
  }
  // v93 sensewise probes — real round-trips, not existence checks
  results.push(await t("process", async () => {
    const spawn = await execTool(ctx, "process", { action: "spawn", command: "echo sensewise-proc-ok", name: "doctor_proc" })
    if (typeof spawn === "string" && spawn.startsWith("ERROR")) return spawn
    await new Promise((r) => setTimeout(r, 300))
    const poll = await execTool(ctx, "process", { action: "poll", id: "doctor_proc", wait_ms: 1500 })
    const kill = await execTool(ctx, "process", { action: "kill", id: "doctor_proc", signal: "SIGKILL" })
    if (typeof poll === "string" && poll.includes("sensewise-proc-ok") && typeof kill === "string" && !kill.startsWith("ERROR")) return poll + "\n[echo verified]"
    return `process round-trip failed — spawn: ${String(spawn).slice(0, 60)} poll: ${String(poll).slice(0, 60)}`
  }))
  results.push(await t("repl", async () => {
    const r = await execTool(ctx, "repl", { action: "run", session: "doctor_repl", code: "40 + 2" })
    const kill = await execTool(ctx, "repl", { action: "kill", session: "doctor_repl" })
    if (typeof r === "string" && /42/.test(r) && typeof kill === "string" && !kill.startsWith("ERROR")) return r + "\n[echo verified]"
    return r
  }))
  results.push(await t("semantic_search", async () => {
    fs.writeFileSync(path.join(tmp, "semantic-probe.js"), "export function doctorSemanticProbe() {\n  // doctor probe for meaning-ranked search\n  return 'sensewise'\n}\n")
    const r = await execTool(ctx, "semantic_search", { query: "doctor semantic probe sensewise", limit: 3 })
    if (typeof r === "string" && r.includes("semantic-probe.js")) return r + "\n[echo verified]"
    return r
  }))
  try { disposeToolManagers() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return results
}

// ---------------------------------------------------------------------------
// v93 "sensewise" — process / repl / semantic_search
//
// The managers are PROCESS-level singletons: a background dev server must
// outlive a single tool call (that is the whole point), so state lives in the
// module, not in the per-run ctx. They are disposed when forge exits
// (runtime.js/repl.js exit + signal handlers) and by chat.js's
// shutdownExternals(). Read-only and verifier agents are gated at the ACTION
// level (getMutationClass / verificationAllows) — observation is always
// allowed, starting/stopping/executing never is.
// ---------------------------------------------------------------------------

let _processManager = null
let _replManager = null
const _runtimeSessions = new Map() // cwd → session (bounded by distinct project roots)
export function getProcessManager() {
  if (!_processManager) _processManager = createProcessManager()
  return _processManager
}
export function getReplManager() {
  if (!_replManager) _replManager = createReplManager()
  return _replManager
}
/** The runtime session for a project root — wraps the ONE process manager
 *  (§36: no second process registry; the session adds discovery, ledger,
 *  health, evidence). Sessions are keyed by cwd so tool calls honor ctx.cwd. */
export function getRuntimeSession(cwd = process.cwd()) {
  const key = path.resolve(cwd || process.cwd())
  if (!_runtimeSessions.has(key)) _runtimeSessions.set(key, createRuntimeSession({ cwd: key, mgr: getProcessManager() }))
  return _runtimeSessions.get(key)
}
/** Kill every background process and REPL session (chat.js shutdown, tests). */
export function disposeToolManagers() {
  try { _processManager?.dispose() } catch {}
  try { _replManager?.dispose() } catch {}
  _processManager = null
  _replManager = null
  _runtimeSessions.clear()
}

function formatProcessEntry(e) {
  const bits = [
    `${e.id}: ${e.state}`,
    e.command ? `cmd: ${e.command}` : "",
    e.pid ? `pid ${e.pid}` : "",
    e.exitCode !== null && e.exitCode !== undefined ? `exit ${e.exitCode}` : "",
    e.signal ? `signal ${e.signal}` : "",
    `up ${e.runtimeSec}s`,
    e.ports?.length ? `ports: ${e.ports.join(",")}` : "ports: (none detected)",
    `out ${e.stdoutBytes}B / err ${e.stderrBytes}B`,
    e.outputTruncated ? "output truncated (ring buffer)" : "",
  ].filter(Boolean)
  return bits.join(" | ")
}

async function runProcessTool(ctx, args) {
  const mgr = getProcessManager()
  const action = String(args?.action ?? "")
  if (action === "spawn") {
    const r = mgr.spawn({
      command: args?.command,
      name: args?.name,
      cwd: args?.cwd ? path.resolve(ctx.cwd, String(args.cwd)) : ctx.cwd,
      timeoutSec: args?.timeout_sec,
    })
    if (!r.ok) return r.error
    return `spawned ${r.entry.id} (pid ${r.entry.pid}) — poll: {action:"poll", id:"${r.entry.id}"} | kill: {action:"kill", id:"${r.entry.id}"}\n${formatProcessEntry(r.entry)}`
  }
  if (action === "poll") {
    const r = await mgr.poll(args?.id, { waitMs: args?.wait_ms, maxChars: Math.min(Number(args?.max_chars) || 4000, 20000) })
    if (!r.ok) return r.error
    const parts = [formatProcessEntry(r.entry)]
    if (r.outNewBytes > 0 || r.out.trim()) parts.push("--- new stdout ---\n" + (r.out || "(no new output)"))
    if (r.errNewBytes > 0 || r.err.trim()) parts.push("--- new stderr ---\n" + r.err)
    if (r.truncated) parts.push("(older output was dropped by the ring buffer — byte totals above are the truth)")
    return parts.join("\n")
  }
  if (action === "status") {
    const r = mgr.status(args?.id)
    if (!r.ok) return r.error
    return formatProcessEntry(r.entry)
  }
  if (action === "kill") {
    const r = mgr.kill(args?.id, args?.signal)
    if (!r.ok) return r.error
    return `${formatProcessEntry(r.entry)}\n${r.note ?? ""}`
  }
  if (action === "list") {
    const r = mgr.list()
    const live = r.live.length ? r.live.map(formatProcessEntry).join("\n") : "(no live processes)"
    const hist = r.history.length ? "\nrecent history:\n" + r.history.map(formatProcessEntry).join("\n") : ""
    return `live:\n${live}${hist}`
  }
  return `ERROR: unknown process action "${action}" (spawn | poll | status | kill | list)`
}

async function runReplTool(ctx, args) {
  const mgr = getReplManager()
  const action = String(args?.action ?? "")
  if (action === "run") {
    const r = await mgr.run(args?.session ?? "main", args?.code, { timeoutMs: args?.timeout_ms })
    if (!r.ok) return r.error + (r.session ? `\nsession: ${JSON.stringify(r.session)}` : "")
    const parts = []
    if (r.note) parts.push(`(${r.note})`)
    parts.push(r.output || "(no output)")
    return parts.join("\n")
  }
  if (action === "status") {
    const r = args?.session !== undefined ? mgr.status(args.session) : mgr.status()
    if (!r.ok) return r.error
    return JSON.stringify(r.session ?? r.sessions)
  }
  if (action === "kill") {
    const r = mgr.kill(args?.session ?? "main")
    if (!r.ok) return r.error
    return r.note
  }
  if (action === "list") {
    const r = mgr.list()
    return r.sessions.length
      ? r.sessions.map((s) => `${s.name}: ${s.state}${s.pid ? ` (pid ${s.pid})` : ""}, ${s.calls} call(s)${s.restarted ? ", restarted" : ""}${s.lastError ? `, last: ${s.lastError}` : ""}`).join("\n")
      : "(no repl sessions — the first run starts one)"
  }
  return `ERROR: unknown repl action "${action}" (run | status | kill | list)`
}

async function runSemanticSearchTool(ctx, args) {
  const q = String(args?.query ?? "").trim()
  if (!q) return "ERROR: semantic_search requires a non-empty query"
  const root = path.resolve(ctx.cwd, String(args?.path ?? "."))
  const embed = typeof ctx.semanticEmbed === "function" ? ctx.semanticEmbed : null
  try {
    const { semanticSearch, formatSemanticSearch } = await loadCodesearch()
    const res = await semanticSearch(root, q, { limit: Math.min(Math.max(1, Number(args?.limit) || 8), 30), embed })
    return formatSemanticSearch(res, q)
  } catch (e) {
    return `ERROR: semantic search failed: ${String(e?.message ?? e).slice(0, 200)}`
  }
}

// ---------------------------------------------------------------------------
// v94c "toolwise" — read-only intelligence tools. Each is a THIN composition
// over engines that already exist (worldmodel, plannerisk, codesearch, the
// engmemory knowledge-graph bridge) — no new subsystem, no model calls, no
// network: deterministic computation over real indexes, honest bounds,
// every failure reported, nothing invented. All three are verification-safe
// reads (VERIFICATION_TOOLS.allowed, MUTATION_CLASS.NONE).
// ---------------------------------------------------------------------------

/** shared: normalize a heterogeneous path/score entry list to path strings */
function pathListOf(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((x) => (typeof x === "string" ? x : String(x?.file ?? x?.path ?? "")))
    .filter(Boolean)
    .slice(0, max)
}

/** kg_query — route a natural question at the world model + knowledge graph. */
async function runKgQueryTool(ctx, args) {
  const q = String(args?.query ?? "").trim()
  if (!q) return "ERROR: kg_query requires a non-empty query"
  const root = path.resolve(ctx.cwd, String(args?.path ?? "."))
  const maxLines = Math.min(Math.max(1, Number(args?.max_lines) || 40), 120)
  const lines = []
  let method = "none"
  try {
    const world = (await loadWorldModel()).createWorldModel({ cwd: root })
    // v98 shipwise: chunked walk — the kg_query tool must never freeze the
    // loop on a six-figure repo; the fresh window covers the follow-up queries
    await world.buildAsync()
    const res = world.answer(q)
    method = res?.method ?? "none"
    const a = res?.answer
    if (a && method !== "empty") {
      if (method === "dependents") {
        const deps = pathListOf(a.dependents, 8)
        const cons = pathListOf(a.consumers, 8)
        lines.push(`dependents of ${a.target} (${deps.length}): ${deps.join(", ") || "none found"}`)
        if (cons.length) lines.push(`runtime/contract consumers (${cons.length}): ${cons.join(", ")}`)
      } else if (method === "impact") {
        if (a.unknown || a.degraded) lines.push(`(impact engine could not resolve "${a.target}" — reported honestly, never guessed)`)
        const imp = pathListOf(a.importers, 8)
        const tst = pathListOf(a.tests, 6)
        const cfg = pathListOf(a.configs, 4)
        lines.push(`blast radius of ${a.target}: radius ${a.radius ?? "?"}${imp.length ? ` · importers (${imp.length}): ${imp.join(", ")}` : " · no importers found"}`)
        if (tst.length) lines.push(`covering tests: ${tst.join(", ")}`)
        if (cfg.length) lines.push(`related configs: ${cfg.join(", ")}`)
      } else if (method === "tests") {
        const tst = pathListOf(a.tests, 8)
        lines.push(`tests covering ${a.target} (${tst.length}): ${tst.join(", ") || "none found — no test exercises it (evidence, not comfort)"}`)
      } else if (method === "locate" || method === "locate-fallback") {
        const ms = Array.isArray(a.matches) ? a.matches : []
        lines.push(`${ms.length} match(es) for "${a.target ?? q.slice(0, 40)}":`)
        for (const m of ms.slice(0, 8)) lines.push(`  ${m.path}${m.via ? ` (via ${m.via})` : ""} [${m.lang ?? "?"}]`)
      } else if (method === "language") {
        lines.push(`${a.target} is ${a.language}`)
      } else if (method === "recent") {
        const ch = Array.isArray(a.changes) ? a.changes : []
        lines.push(`${ch.length} file(s) changed in the last 24h (mtime census):`)
        for (const c of ch.slice(0, 8)) lines.push(`  ${c.path}`)
      }
    } else if (method === "empty" || !a) {
      lines.push(`no route matched — try: "what depends on X" · "impact of changing X" · "tests for X" · "where is X" · "what changed recently"`)
    }
    const sum = world.summarize({ maxLines: 3 })
    if (sum) lines.push("", sum)
  } catch (e) {
    lines.push(`world model unavailable: ${String(e?.message ?? e).slice(0, 160)} (reported, never fabricated)`)
  }
  try {
    const kg = (await loadEngMemory()).knowledgeGraphFacts(root)
    if (kg.ok) {
      lines.push("", `knowledge graph (${kg.file}):`)
      for (const t of kg.overview.slice(0, 3)) lines.push(`  ${t}`)
      for (const e of kg.entries.slice(0, 4)) lines.push(`  ${e.text}${e.files?.length ? ` [${e.files.join(", ")}]` : ""}`)
    } else if (method === "none") {
      lines.push("", kg.note)
    }
  } catch { /* the graph is optional garnish — it never breaks the tool */ }
  if (!lines.length) return `kg_query: nothing answered "${q.slice(0, 80)}" (empty project indexes)`
  const head = `KG QUERY [${method}] — deterministic reads over the project indexes (no model, no fabrication)`
  return [head, ...lines.slice(0, maxLines)].join("\n")
}

// --- plan_whatif ------------------------------------------------------------

const WHATIF_MAX_NODES = 24
const WHATIF_RISKS = ["trivial", "low", "medium", "high", "critical"]
const WHATIF_CLASSES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ARCHITECTURAL", "RECOVERY"]

/** validate/normalize one plan node list — honest issues for anything dropped */
function whatifNormalizeNodes(raw, label = "") {
  const issues = []
  const nodes = []
  const arr = Array.isArray(raw) ? raw : []
  const seen = new Set()
  arr.forEach((n, i) => {
    const at = `${label}node ${i + 1}`
    if (!n || typeof n !== "object" || Array.isArray(n)) { issues.push(`${at}: not an object — dropped`); return }
    const objective = String(n.objective ?? n.title ?? "").trim()
    if (!objective) { issues.push(`${at}: missing objective — dropped`); return }
    let id = String(n.id ?? `n${i + 1}`).trim().slice(0, 40) || `n${i + 1}`
    if (seen.has(id)) { issues.push(`${at}: duplicate id "${id}" — renamed`); id = `${id}#${i + 1}` }
    seen.add(id)
    nodes.push({
      id,
      objective: objective.slice(0, 600),
      dependencies: (Array.isArray(n.dependencies) ? n.dependencies : []).map((d) => String(d).trim().slice(0, 40)).filter(Boolean),
      read_only: n.read_only === true,
      risk: WHATIF_RISKS.includes(n.risk) ? n.risk : "low",
      estimated_cost: Math.max(1, Number(n.estimated_cost) || 1),
      targetFiles: (Array.isArray(n.targetFiles) ? n.targetFiles : Array.isArray(n.target_files) ? n.target_files : []).slice(0, 12).map((f) => String(f)),
      verificationRequirements: (Array.isArray(n.verificationRequirements) ? n.verificationRequirements : Array.isArray(n.verification_requirements) ? n.verification_requirements : []).slice(0, 6).map((v) => String(v)),
      optional: n.optional === true,
    })
  })
  return { nodes, issues }
}

/** apply {add, remove, update} mutations — dangling deps cleaned with notes */
function whatifApplyMutations(base, mutate) {
  const issues = []
  let out = base.map((n) => ({ ...n, dependencies: [...n.dependencies], targetFiles: [...n.targetFiles], verificationRequirements: [...n.verificationRequirements] }))
  const m = mutate && typeof mutate === "object" && !Array.isArray(mutate) ? mutate : null
  if (!m) return { out, issues }
  for (const r of (Array.isArray(m.remove) ? m.remove : []).map(String)) {
    if (!out.some((n) => n.id === r)) { issues.push(`mutate.remove: "${r}" does not exist — ignored`); continue }
    out = out.filter((n) => n.id !== r)
  }
  for (const u of Array.isArray(m.update) ? m.update : []) {
    if (!u || typeof u !== "object" || !u.id) { issues.push("mutate.update: entry without id — ignored"); continue }
    const t = out.find((n) => n.id === String(u.id).slice(0, 40))
    if (!t) { issues.push(`mutate.update: "${u.id}" does not exist — ignored`); continue }
    const merged = whatifNormalizeNodes([{ ...t, ...u, id: t.id }], "mutate.update: ").nodes[0]
    if (merged) Object.assign(t, merged)
  }
  const added = whatifNormalizeNodes(Array.isArray(m.add) ? m.add : [], "mutate.add: ")
  issues.push(...added.issues)
  for (const n of added.nodes) {
    if (out.some((x) => x.id === n.id)) { issues.push(`mutate.add: id "${n.id}" already exists — ignored`); continue }
    out.push(n)
  }
  const live = new Set(out.map((n) => n.id))
  for (const n of out) {
    const before = n.dependencies.length
    n.dependencies = n.dependencies.filter((d) => live.has(d))
    if (n.dependencies.length !== before) issues.push(`mutate: dropped ${before - n.dependencies.length} dangling dep(s) from ${n.id}`)
  }
  if (out.length > WHATIF_MAX_NODES) { issues.push(`mutated plan exceeds ${WHATIF_MAX_NODES} nodes — truncated honestly`); out = out.slice(0, WHATIF_MAX_NODES) }
  return { out, issues }
}

/** compact assessment renderer (shared by BASE and MUTATED) */
function whatifRenderAssessment(label, a) {
  const l = [`${label}: risk ${a.risk} [${a.riskLadder}] · success estimate ${a.successProbability} (failure ${a.failureProbability}) · confidence ${a.confidence} · uncertainty ${a.uncertainty}`]
  l.push(`  factors: ${Object.entries(a.factors ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
  const cp = a.criticalPath
  if (cp) l.push(`  critical path: ${(cp.path ?? []).join(" -> ") || "(single node)"}${(cp.spof ?? []).length ? ` · SPOF: ${(cp.spof ?? []).join(", ")}` : ""}${(cp.bottlenecks ?? []).length ? ` · bottlenecks: ${(cp.bottlenecks ?? []).join(", ")}` : ""}`)
  return l
}

/** plan_whatif — deterministic what-if simulation through the risk engine. */
async function runPlanWhatifTool(ctx, args) {
  const { nodes: base, issues } = whatifNormalizeNodes(args?.plan)
  if (!base.length) {
    return `ERROR: plan_whatif needs a plan: [{ id, objective, dependencies, read_only, risk, estimated_cost, target_files }]${issues.length ? ` — ${issues.join("; ")}` : ""}`
  }
  const klass = WHATIF_CLASSES.includes(args?.klass) ? args.klass : "MEDIUM"
  const task = String(args?.task ?? "")
  let lessons = [], calibration = null
  try { ({ lessons, calibration } = gatherPlannerEvidence(ctx.cwd, task)) } catch { /* thin evidence is honest */ }
  const a1 = assessPlan(base, { klass, lessons, calibration, task })
  const lines = [
    "PLAN WHAT-IF — deterministic simulation over the predictive risk engine",
    "(estimates, NOT proof: weak evidence means LOW confidence, never fake precision)",
  ]
  if (issues.length) lines.push(`input notes: ${issues.join("; ")}`)
  lines.push(...whatifRenderAssessment(`BASE plan (${base.length} node(s))`, a1))
  const alts = alternatives(a1, base)
  if (alts && !Array.isArray(alts) && Array.isArray(alts.all) && alts.all.length) {
    lines.push(`  alternatives (risk ${a1.riskLadder} — worth reshaping):`)
    for (const v of alts.all.slice(0, 3)) lines.push(`    ${v.name}: ${v.nodes} node(s), risk ${v.risk}, success ${v.successProbability}, expected verified progress ${v.expectedVerifiedProgress}`)
    if (alts.recommended) lines.push(`  recommended: ${alts.recommended.name} (${alts.basis})`)
    // deepwise: the ORIGINAL plan competes too — show the honest verdict
    if (alts.original && alts.winner) {
      const m = Number(alts.margin ?? 0)
      lines.push(`  vs original: ${alts.bestIsOriginal ? "the original plan already matches the best candidate" : `${alts.winner.name} by ${m >= 0 ? "+" : ""}${m} expected verified progress`} (adoption is decided by the planner, deterministically)`)
    }
  }
  if (args?.mutate !== undefined) {
    const { out: mut, issues: mi } = whatifApplyMutations(base, args.mutate)
    if (mi.length) lines.push(`mutation notes: ${mi.join("; ")}`)
    if (!mut.length) lines.push("MUTATED plan is empty — nothing to assess")
    else {
      const a2 = assessPlan(mut, { klass, lessons, calibration, task })
      lines.push(...whatifRenderAssessment(`MUTATED plan (${mut.length} node(s))`, a2))
      const dP = Number((a2.successProbability - a1.successProbability).toFixed(3))
      const dR = Number((a2.risk - a1.risk).toFixed(3))
      lines.push(`  DELTA: success ${dP >= 0 ? "+" : ""}${dP} · risk ${dR >= 0 ? "+" : ""}${dR} · ladder ${a1.riskLadder} -> ${a2.riskLadder}`)
    }
  }
  lines.push(`  evidence: ${lessons.length} real lesson(s), prediction calibration ${calibration?.sufficient === true ? "sufficient" : "thin"} — the simulation reads YOUR project's history, not a generic prior`)
  return lines.join("\n")
}

/** code_context — semantic hits + the structural wiring of the top files. */
async function runCodeContextTool(ctx, args) {
  const q = String(args?.query ?? "").trim()
  if (!q) return "ERROR: code_context requires a non-empty query"
  const root = path.resolve(ctx.cwd, String(args?.path ?? "."))
  const embed = typeof ctx.semanticEmbed === "function" ? ctx.semanticEmbed : null
  const maxHits = Math.min(Math.max(1, Number(args?.max_hits) || 5), 12)
  let res
  try {
    res = await (await loadCodesearch()).semanticSearch(root, q, { limit: maxHits, embed })
  } catch (e) {
    return `ERROR: semantic search failed: ${String(e?.message ?? e).slice(0, 200)}`
  }
  const lines = [`CODE CONTEXT "${q.slice(0, 100)}" — ${res.hits?.length ?? 0} hit(s) in ${res.files ?? 0} file(s), ${res.chunks ?? 0} chunk(s) [${res.mode ?? "?"}]${res.truncated ? " (scan truncated at bounds — reported, never hidden)" : ""}`]
  if (!res.ok || !res.hits?.length) {
    lines.push(res.note ?? "no matches — try grep_files for exact text")
    return lines.join("\n")
  }
  for (const h of res.hits.slice(0, maxHits)) {
    lines.push(`  ${h.path}:${h.start}-${h.end} (score ${h.score})`)
    for (const s of (h.snippet ?? []).slice(0, 2)) lines.push(`    ${String(s).slice(0, 160)}`)
  }
  const seen = new Set()
  const topFiles = []
  for (const h of res.hits) {
    if (seen.has(h.path)) continue
    seen.add(h.path)
    topFiles.push(h.path)
    if (topFiles.length >= 3) break
  }
  try {
    const world = (await loadWorldModel()).createWorldModel({ cwd: root })
    // v98 shipwise: chunked walk (same law as kg_query)
    await world.buildAsync()
    lines.push("", "wiring (world model — who imports it, what tests cover it):")
    for (const rel of topFiles) {
      try {
        const im = world.impact([path.resolve(root, rel)])
        if (!im || im.unknown) { lines.push(`  ${rel}: (impact engine could not resolve it — honest)`); continue }
        const imp = pathListOf(im.importers, 6)
        const tst = pathListOf(im.tests, 4)
        lines.push(`  ${rel}: radius ${im.radius ?? "?"}${imp.length ? ` · importers: ${imp.join(", ")}` : " · no direct importers found"}${tst.length ? ` · tests: ${tst.join(", ")}` : ""}`)
      } catch { lines.push(`  ${rel}: (wiring lookup failed — reported)`) }
    }
  } catch {
    lines.push("  wiring: world model unavailable — the semantic hits above are still real")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// dispatcher — single choke point: every string result passes through
// secret redaction before it reaches the model / sessions / logs.
// ---------------------------------------------------------------------------

const REDACTED_TOOLS = new Set(["bash", "read_file", "read_image", "fetch_url", "web_search", "browser", "delegate", "git_status", "grep_files", "memory", "process", "repl", "semantic_search", "runtime", "kg_query", "plan_whatif", "code_context", "github"])

/** v93 gap fix §7–§11 — the Runtime Intelligence tool. Backed by
 *  runtimesession.js (discovery with evidence, the shared process manager,
 *  health probes, claims, crash reconcile). */
async function runRuntimeTool(ctx, args) {
  const session = getRuntimeSession(ctx.cwd)
  const action = String(args?.action ?? "")
  if (action === "discover") {
    return formatDiscovery(session.discover())
  }
  if (action === "launch") {
    const r = session.launch({ command: args?.command ?? null, phase: args?.phase === "build" ? "build" : "run", name: args?.name ?? null, timeoutSec: args?.timeout_sec })
    if (!r.ok) return r.error
    return `launched ${r.entry.id} (pid ${r.entry.pid}) — command: ${r.command} (source: ${r.source})\n${formatProcessEntry(r.entry)}\nprobe health: {action:"health"} — claims need process + health evidence`
  }
  if (action === "status") {
    const r = await session.status()
    if (!r.ok) return r.error
    const procs = r.processes.length ? r.processes.map((p) => `${p.id}: ${p.state}${p.pid ? ` (pid ${p.pid})` : ""} ports: ${p.ports?.length ? p.ports.join(",") : "(none detected)"}`).join("\n") : "(no live runtime processes)"
    const led = r.ledger.length ? `\nledger:\n${r.ledger.map((e) => `${e.name} pid ${e.pid} (from ${e.source})`).join("\n")}` : ""
    return `project: ${r.project.type} | run: ${r.project.runCommand ?? "NOT discovered"}\nprocesses:\n${procs}${led}`
  }
  if (action === "health") {
    const r = await session.health({ port: args?.port ?? null, host: args?.host ?? "127.0.0.1", ...(args?.grace_ms != null ? { graceMs: Number(args.grace_ms) } : {}) })
    if (r.error && !r.probe) return `ERROR: ${r.error}`
    const waitedNote = r.waitedMs > 200 && !args?.port ? ` (listener detected after ${r.waitedMs}ms — the boot was slow, not broken)` : ""
    if (r.ok && r.level === "http") return `HEALTHY — ${r.probe.url} → HTTP ${r.probe.status} in ${r.probe.ms}ms (real probe, recorded as runtime evidence)${waitedNote}`
    if (r.ok && r.level === "tcp") return `REACHABLE — TCP listener on ${r.probe.host}:${r.probe.port} in ${r.probe.ms}ms (${r.note ?? "no HTTP response — protocol-aware probe"}) (recorded as runtime evidence)${waitedNote}`
    return `NOT HEALTHY — ${r.probe?.url ?? `${r.probe?.host ?? "127.0.0.1"}:${r.probe?.port ?? "?"}`}: ${r.error ?? "probe failed"} (this is evidence against any 'server started' claim)`
  }
  if (action === "claim") {
    const r = await session.claimServerStarted({ port: args?.port ?? null })
    const lines = [r.ok ? "CLAIM PROVEN: server started" : "CLAIM NOT PROVEN: server started"]
    lines.push(`processes: ${r.processes.length} live${r.processes[0] ? ` (${r.processes[0].id}, pid ${r.processes[0].pid})` : ""}`)
    lines.push(`health: ${r.health.ok ? (r.health.level === "tcp" ? `TCP listener :${r.health.probe?.port} in ${r.health.probe?.ms}ms (no HTTP response — protocol-aware)` : `HTTP ${r.health.probe?.status} in ${r.health.probe?.ms}ms`) : r.health.error ?? "failed"}`)
    return lines.join("\n")
  }
  if (action === "up") {
    // v97 §41: the composite lifecycle — launch → WAIT READY → health verdict,
    // one honest action with per-stage evidence. `build:true` runs the
    // discovered build command first (bounded wait). Nothing is assumed: a
    // non-ready result says exactly how far it got.
    const r = await session.bringUp({
      command: args?.command ?? null,
      build: args?.build === true,
      port: args?.port ?? null,
      host: args?.host ?? "127.0.0.1",
      readyTimeoutMs: Number(args?.ready_timeout_ms) > 0 ? Number(args?.ready_timeout_ms) : 30000,
      timeoutSec: args?.timeout_sec,
    })
    const lines = [r.ok ? "BRING-UP COMPLETE — launched, ready, healthy" : `BRING-UP INCOMPLETE — ${r.error ?? "see stages"}`]
    // plain markers: a tool RESULT is text the model reads, not terminal output
    // (the render layer owns color). `green`/`red` were never defined in this
    // module, so every `runtime up` threw ReferenceError before reaching here.
    for (const s of r.stages) lines.push(`  ${s.ok ? "✓" : "✗"} ${s.stage}: ${s.detail}`)
    if (r.ok) lines.push("next: interact/observe, then {action:\"stop\"} — exit handlers also clean up")
    return lines.join("\n")
  }
  if (action === "reconcile") {
    const r = session.reconcile({ kill: args?.kill === true })
    if (!r.ok) return r.error
    if (!r.entries.length) return "ledger is empty — nothing to reconcile (no forge-owned processes recorded)"
    return r.entries.map((e) => `${e.name}: ${e.verdict} — ${e.note}${e.killed ? ` [${e.killed}]` : ""}`).join("\n")
  }
  if (action === "stop") {
    const r = session.stop({ name: args?.name ?? null, signal: args?.signal ?? "SIGTERM" })
    if (!r.ok) return r.error
    return `${formatProcessEntry(r.entry)}\n${r.note ?? ""}`
  }
  return `ERROR: unknown runtime action "${action}" (discover | up | launch | status | health | claim | reconcile | stop)`
}

export async function execTool(ctx, name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {}
  // VERIFY ⇒ READ_ONLY: enforce the whitelist even if a tool definition leaks
  // through (a plugin, a direct call, or a future refactor).
  if (ctx.mode === "verifier") {
    const allowed = verificationAllows(name, args, readOnlyOpts(ctx))
    if (!allowed.ok) return `BLOCKED: ${allowed.reason} — verification is read-only (VERIFY ⇒ READ_ONLY, REPAIR ⇒ WRITE)`
  }
  if (ctx.readOnly) {
    const violation = isReadOnlyViolation(name, args, true, readOnlyOpts(ctx))
    if (violation) return violation
    const pl = ctx._plugins?.get(name)
    if (pl && !pl.readOnly) {
      return `BLOCKED: write tools are disabled in this read-only agent — plugin ${name} is not read-only`
    }
  }
  let result
  switch (name) {
    case "bash": result = await runBash(ctx, String(args.command ?? ""), args.timeout_sec); break
    case "read_file": result = read_file(ctx, args); break
    case "read_image": result = read_image(ctx, args); break
    case "write_file": result = write_file(ctx, args); break
    case "edit_file": result = edit_file(ctx, args); break
    case "list_dir": result = list_dir(ctx, args); break
    case "grep_files": result = grep_files(ctx, args); break
    case "load_skill": result = load_skill(ctx, args); break
    case "fetch_url": result = await fetch_url(ctx, args); break
    case "glob_files": result = glob_files(ctx, args); break
    case "web_search": result = await web_search(ctx, args); break
    case "browser": result = await (await loadBrowser()).runBrowser(ctx, args); break
    case "multi_edit": result = multi_edit(ctx, args); break
    case "apply_patch": result = apply_patch(ctx, args); break
    case "git_status": result = await git_status(ctx); break
    case "git_diff": result = await git_diff(ctx, args); break
    case "git_log": result = await git_log(ctx, args); break
    case "git_blame": result = await git_blame(ctx, args); break
    case "github": result = runGithub(ctx, args); break
    case "todo": result = todo(ctx, args); break
    case "think": result = think(ctx, args); break
    case "memory": result = memory(ctx, args); break
    case "delegate": result = await delegate(ctx, args); break
    case "process": result = cap(String(await runProcessTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "repl": result = cap(String(await runReplTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "semantic_search": result = cap(String(await runSemanticSearchTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "runtime": result = cap(String(await runRuntimeTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "kg_query": result = cap(String(await runKgQueryTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "plan_whatif": result = cap(String(await runPlanWhatifTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    case "code_context": result = cap(String(await runCodeContextTool(ctx, args) ?? ""), ctx.maxToolOutput); break
    default: {
      // v20.2 P3-5: user tool plugins
      const pl = ctx._plugins?.get(name)
      if (!pl) return `ERROR: unknown tool "${name}"`
      try {
        // v131: `signal` is the user's Ctrl+C. Every other tool in this switch
        // already receives it; plugins (and therefore every MCP tool) did not,
        // so an in-flight MCP call could only be waited out.
        const r = await pl.run(args, { cwd: ctx.cwd, readOnly: ctx.readOnly, signal: ctx.signal ?? null })
        result = typeof r === "string" ? r : JSON.stringify(r ?? null)
        result = cap(result, ctx.maxToolOutput)
      } catch (e) {
        result = `ERROR: plugin ${name} failed: ${String(e?.message ?? e).slice(0, 200)}`
      }
    }
  }
  // all plugin output passes through secret redaction, like built-in tools
  if (typeof result === "string" && (REDACTED_TOOLS.has(name) || ctx._plugins?.has(name))) return redact(result)
  return result
}

// v19 compat export: derived from the real engine (shellguard)
export { FORBIDDEN, classifyCommand } from "./shellguard.js"
