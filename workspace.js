/**
 * forge — workspace identity (v103, zero dependencies)
 *
 * THE DISTINCTION THIS MODULE EXISTS FOR:
 *
 *   FORGE_RUNTIME     the directory forge's own source lives in
 *   TARGET_WORKSPACE  the project the user's task is actually about
 *
 * Before this module nothing in the repository knew the difference — there was
 * no forgeRoot, no isForgeRuntime, nothing. Reproduced: launched from its own
 * source tree and asked "Build a REST API for my project", forge wrote
 * server.js into its own repository, reported COMPLETED, and nothing anywhere
 * said the working directory was forge itself.
 *
 * That only happens when forge runs FROM its own checkout, which is exactly
 * what someone developing forge does all day. A globally installed forge has
 * its runtime under node_modules and can never collide.
 *
 * The detection is EXACT, not a heuristic: this file's own location is the
 * forge runtime by definition (import.meta.url), so "is the cwd inside the
 * forge runtime" is a path containment test with no guessing in it.
 *
 * What this module does NOT do: decide for the user. Working on forge itself
 * is a legitimate task, so a collision is REPORTED with its evidence and the
 * task's own wording is what says whether forge is the intended target. The
 * resolver never overrides an explicitly selected workspace — sourceresolve.js
 * already owns explicit selection (--source), and this module reads its record
 * rather than re-deriving or competing with it.
 */
import { loadBuiltin } from "./lazybuiltin.js"
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { inspectProjectDir, gitRemoteUrl, readSourceRecord } from "./sourceresolve.js"
import { projectRoot } from "./projectkey.js"
import { redactSecrets } from "./secrets.js"
import { taskNeedsNoFiles } from "./taskpaths.js"

/** How the target workspace was decided, most authoritative first. */
export const RESOLUTION = Object.freeze({
  EXPLICIT: "explicit",          // a path the caller/user named outright
  SOURCE_RECORD: "source-record", // sourceresolve.js persisted an earlier explicit selection
  TASK_CONTEXT: "task-context",   // an active task already fixed its workspace
  CWD: "cwd",                     // the working directory, with nothing better available
})

/** Confidence in `targetWorkspace`. Only ever lowered by evidence, never raised. */
export const CONFIDENCE = Object.freeze({
  CERTAIN: "certain",      // the user said so, directly or in a persisted record
  LIKELY: "likely",        // cwd is an ordinary project and nothing contradicts it
  AMBIGUOUS: "ambiguous",  // cwd is forge's own tree and the task does not say forge
})

/**
 * The forge runtime root: the directory this module is in. Definitional — the
 * code that is running is the runtime, so there is nothing here to guess.
 */
export function forgeRuntimeRoot() {
  try { return path.dirname(fileURLToPath(import.meta.url)) } catch { return null }
}

/** Is `dir` the forge runtime tree, or inside it? Path containment, realpath'd
 *  on both sides so a symlinked checkout is not mistaken for a different tree. */
export function isForgeRuntime(dir, root = forgeRuntimeRoot()) {
  if (!dir || !root) return false
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const d = real(dir)
  const r = real(root)
  return d === r || d.startsWith(r + path.sep)
}

/**
 * Does the task text name forge as its subject?
 *
 * Deliberately narrow. "forge" appears in ordinary sentences ("forge a plan"),
 * so a bare mention is not consent to write into forge's own source. The task
 * must name forge as the THING being worked on — forge itself, this repo, the
 * agent's own code — or name one of forge's own files.
 */
export function taskTargetsForge(task = "", { root = forgeRuntimeRoot(), cwd = null, strict = false } = {}) {
  const t = String(task ?? "")
  if (!t.trim()) return false
  // the owner calls it forge, or Alfa (the repository it lives in)
  const NAME = "(?:forge|alfa)"
  const VERB = "(?:improve|upgrade|update|fix|refactor|audit|review|extend|enhance|debug|test|optimi[sz]e|harden|evolve|rewrite|change|modify)"
  // `strict` (started inside some other project): only what cannot be about
  // that project — "fix the forge recipe in src/game.js" is a game's forge
  if (!strict && (
    new RegExp(`\\b${VERB}\\b[^.\\n]{0,24}\\b${NAME}\\b`, "i").test(t) ||
    new RegExp(`\\b${NAME}'s\\s+(?:own\\s+)?[a-z]`, "i").test(t)
  )) return true
  if (
    new RegExp(`\\b${NAME}\\b[^.\\n]{0,24}\\b(itself|repo|repository|source|codebase|runtime|cli|agent|engine)\\b`, "i").test(t) ||
    /\balfa\b/i.test(t) ||
    /\b(this|the)\s+(agent|cli|tool)'?s?\s+own\b/i.test(t) ||
    /\bforge\/[a-z0-9_-]+\.js\b/i.test(t) ||
    // "upgrade yourself", "improve yourself"
    new RegExp(`\\b${VERB}\\s+yourself\\b`, "i").test(t) ||
    // "your own source / codebase / engine / system prompt" — the agent's own
    // internals; "your own code / bug / changes" is NOT (in a project that is
    // usually the code the agent just wrote there)
    /\byour\s+own\s+(source(?:\s+code)?|codebase|code\s*base|repo|repository|engine|internals|implementation|prompts?|system\s+prompt|tools?|tool\s+layer|controller|agent\s+loop|runtime)\b/i.test(t)
  ) return true
  // started inside forge's own tree, "improve your own retry logic" is forge
  if (root && cwd && isForgeRuntime(cwd, root) && /\byour\s+own\b|\byourself\b/i.test(t)) return true
  // "fix your own bug in agent.js": a self-reference AND a file that exists in
  // forge's own tree (and not where the run started)
  if (root && /\b(your|yourself|yours)\b/i.test(t)) {
    for (const m of t.matchAll(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:m?js|json|md))(?=$|[\s"'`),:;!?]|\.(?:\s|$))/g)) {
      const rel = m[1]
      try {
        if (fs.statSync(path.join(root, rel)).isFile() && !(cwd && fs.existsSync(path.resolve(cwd, rel)) && !isForgeRuntime(cwd, root))) return true
      } catch { /* not one of forge's files */ }
    }
  }
  return false
}

/** Stable identity for a repository: its origin URL when it has one, else its
 *  real path. Used to tell "the same project" from "a project that looks alike". */
export function repositoryIdentityOf(dir) {
  if (!dir) return null
  // the remote belongs to the repository root, not to a subfolder of it
  const remote = gitRemoteUrl(repositoryRootOf(dir) ?? dir) ?? gitRemoteUrl(dir)
  if (remote) return String(remote).replace(/\.git$/, "")
  try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
}

/**
 * Walk up for the enclosing git repository root; null when there is none.
 *
 * v108: the walk itself lives in projectkey.js, which memory.js also uses to
 * key every per-project store. Two copies of "where does this project begin"
 * is exactly how the stores and the workspace resolver would drift apart, so
 * there is one. This wrapper keeps the narrower contract it always had —
 * a GIT root or null, never a manifest and never the directory itself.
 */
export function repositoryRootOf(dir) {
  const root = projectRoot(dir ?? ".")
  try { return fs.existsSync(path.join(root, ".git")) ? root : null } catch { return null }
}

/** A coarse project type from the manifests already detected by sourceresolve. */
export function projectTypeOf(inspection) {
  const m = new Set(inspection?.manifests ?? [])
  if (m.has("package.json")) return "node"
  if (m.has("pyproject.toml") || m.has("requirements.txt") || m.has("setup.py")) return "python"
  if (m.has("Cargo.toml")) return "rust"
  if (m.has("go.mod")) return "go"
  if (m.has("pubspec.yaml")) return "dart"
  if (m.has("build.gradle") || m.has("build.gradle.kts") || m.has("pom.xml")) return "jvm"
  if (m.has("Gemfile")) return "ruby"
  if (m.has("composer.json")) return "php"
  const langs = Object.entries(inspection?.languages ?? {})
  if (langs.length) return langs.sort((a, b) => b[1] - a[1])[0][0]
  return null
}

/**
 * Resolve who the target project is.
 *
 * @param cwd        the working directory
 * @param explicit   a path the caller/user named outright (wins over everything)
 * @param task       the task text — only used to tell whether forge is the subject
 * @param taskWorkspace  the workspace an active task already fixed, if any
 * @param inspect    injectable for tests; defaults to sourceresolve.inspectProjectDir
 *
 * @returns {{
 *   forgeRoot, targetWorkspace, repositoryRoot, repositoryIdentity, projectType,
 *   workspaceConfidence, resolutionSource,
 *   runningInsideForge, targetIsForge, selfTargeted, conflict
 * }}
 */
export function resolveWorkspace({ cwd = process.cwd(), explicit = null, task = "", taskWorkspace = null, inspect = inspectProjectDir } = {}) {
  const forgeRoot = forgeRuntimeRoot()

  let targetWorkspace = null
  let resolutionSource = RESOLUTION.CWD
  if (explicit) { targetWorkspace = path.resolve(String(explicit)); resolutionSource = RESOLUTION.EXPLICIT }
  if (!targetWorkspace && taskWorkspace) { targetWorkspace = path.resolve(String(taskWorkspace)); resolutionSource = RESOLUTION.TASK_CONTEXT }
  if (!targetWorkspace) {
    // an explicit --source selection persisted earlier still outranks a bare cwd
    try {
      const rec = readSourceRecord(cwd)
      if (rec?.localPath && rec.sourceType && rec.sourceType !== "workspace" && rec.sourceType !== "git-repo") {
        targetWorkspace = path.resolve(rec.localPath)
        resolutionSource = RESOLUTION.SOURCE_RECORD
      }
    } catch { /* no record is not an error — fall through to cwd */ }
  }
  if (!targetWorkspace) { targetWorkspace = path.resolve(cwd); resolutionSource = RESOLUTION.CWD }

  const runningInsideForge = isForgeRuntime(cwd, forgeRoot)
  const targetIsForge = isForgeRuntime(targetWorkspace, forgeRoot)
  const selfTargeted = taskTargetsForge(task, { root: forgeRoot, cwd })

  let inspection = null
  try { inspection = inspect(targetWorkspace) } catch { inspection = null }

  // The one case worth a word: the target IS forge's own tree, the user did not
  // choose it outright, and the task never said forge. Writing here would edit
  // the agent's own source while the user was thinking about their project.
  const ambiguous = targetIsForge && !selfTargeted && resolutionSource === RESOLUTION.CWD
  const workspaceConfidence = ambiguous
    ? CONFIDENCE.AMBIGUOUS
    : (resolutionSource === RESOLUTION.CWD ? CONFIDENCE.LIKELY : CONFIDENCE.CERTAIN)

  return {
    forgeRoot,
    targetWorkspace,
    repositoryRoot: repositoryRootOf(targetWorkspace),
    repositoryIdentity: repositoryIdentityOf(targetWorkspace),
    projectType: projectTypeOf(inspection),
    workspaceConfidence,
    resolutionSource,
    runningInsideForge,
    targetIsForge,
    selfTargeted,
    conflict: ambiguous
      ? {
          kind: "target-is-forge-runtime",
          detail: `the working directory is forge's own source tree (${forgeRoot}) and the task does not name forge as its subject`,
        }
      : null,
  }
}

/** A file the task names that already exists in this checkout, or null. */
function existingFileInTask(task, cwd) {
  const re = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),.:;!?])/g
  for (const m of String(task ?? "").matchAll(re)) {
    const rel = m[1]
    if (rel.includes("..") || /^https?:/i.test(rel)) continue
    try {
      if (fs.statSync(path.resolve(cwd, rel)).isFile()) return rel
    } catch { /* named, but not in this checkout */ }
  }
  return null
}

/**
 * Which workspace is this task about? One answer, said in a line.
 *
 *   file        the task names a file that is already in this checkout
 *   self        the task names forge, and this checkout is forge
 *   this-repo   "my github repo" and this checkout has a GitHub origin
 *   other-repo  the task named a repository and the run already bound it
 *   ask         it could be this tree or another repo, and guessing would be a lie
 *   unsaid      still this directory; the old warning applies, the run may continue
 *   cwd         an ordinary project, nothing else was claimed
 */
export function workspaceDecision({ cwd = process.cwd(), task = "", bound = null } = {}) {
  const d = decideWorkspace({ cwd, task, bound })
  // one explicit label for WHAT kind of workspace this is — the model reads
  // it, the events carry it (agent.js SOURCE_RESOLVED / WORKSPACE_KIND)
  const kind = workspaceKindOf(d, bound)
  if (d.workspace) d.workspace.workspaceKind = kind
  d.workspaceKind = kind
  return d
}

/** "folder", "file", "GitHub repository", "archive", "forge itself", "task only", … */
export function workspaceKindOf(d, bound = null) {
  const ws = d?.workspace ?? {}
  switch (d?.kind) {
    case "local": {
      const lk = bound?.localKind
      if (lk === "self") return "forge itself — its own source"
      if (lk === "zip") return "archive — its unpacked copy"
      if (lk === "new-dir") return "new project folder"
      if (/names the project/.test(String(bound?.reason ?? ""))) return "project found by name"
      if ((bound?.focus ?? []).length && /names \S+\.[A-Za-z0-9]{1,8}\b/.test(String(bound?.reason ?? ""))) return "file — the folder it is in"
      return lk === "repo" ? "git repository the task names" : "folder the task names"
    }
    case "other-repo": return `GitHub repository${bound?.canonical ? ` ${bound.canonical}` : ""}`
    case "this-repo": return "GitHub repository — this checkout"
    case "file": return "file in this project"
    case "self": return "forge itself — its own source"
    case "ask": return "unclear — forge asks which"
    case "unsaid": return "forge's own source, though the task is not about forge"
    default:
      if (ws.taskOnly) return "task only — no files needed"
      if ((bound?.places ?? []).length) return "several places the task names"
      if (ws.atHome) return "home folder — no project"
      return ws.repositoryRoot || ws.projectType ? "project where forge was started" : "folder where forge was started"
  }
}

function decideWorkspace({ cwd = process.cwd(), task = "", bound = null } = {}) {
  const here = path.resolve(cwd)
  const focus = Array.isArray(bound?.focus) ? bound.focus.filter(Boolean).slice(0, 6) : []
  const focusLine = focus.length ? ` Focus: ${focus.join(", ")}.` : ""
  // a folder, file, archive or local project the task named (taskpaths.js)
  if (bound && bound.action === "target" && bound.kind === "local" && bound.localPath) {
    const where = bound.localPath
    const from = bound.previousCwd && path.resolve(bound.previousCwd) !== path.resolve(where) ? `, not the directory forge was started in (${bound.previousCwd})` : ""
    const line = bound.localKind === "self"
      ? `the task is about forge itself: ${where} is forge's own source tree${from}. Changes here change the agent that is running them.`
      : bound.localKind === "zip"
      ? `the task names the archive ${bound.archive}; it was unpacked to ${where}, and that copy is the workspace${from}.`
      : bound.localKind === "new-dir"
        ? `the task asks for a new project in ${where}; that folder was created and is the workspace${from}.`
        : /names the project/.test(String(bound.reason ?? ""))
          ? `${bound.reason}. That project is the workspace${from}.`
          : `${String(bound.reason ?? "the task names this place")}. The workspace is ${where}${from}.`
    const ws = resolveWorkspace({ cwd: here, task, explicit: where })
    return { kind: "local", certain: true, workspace: { ...ws, decisionKind: "local", decisionLine: line + focusLine, focus }, line: line + focusLine }
  }
  if (bound && (bound.action === "target" || bound.action === "explicit" || bound.action === "reuse-workspace") && bound.localPath && path.resolve(bound.localPath) !== path.resolve(bound.previousCwd ?? here)) {
    const identity = bound.canonical || bound.localPath
    const ws = resolveWorkspace({ cwd: here, task, explicit: bound.localPath })
    return {
      kind: "other-repo",
      certain: true,
      workspace: { ...ws, decisionKind: "other-repo", decisionLine: `the task named ${identity}. That repository is the workspace, not the directory forge was launched from.${focusLine}`, focus },
      line: `the task named ${identity}. That repository is the workspace, not the directory forge was launched from.${focusLine}`,
    }
  }
  const ws = resolveWorkspace({ cwd: here, task })
  const file = existingFileInTask(task, here)
  if (file) {
    const line = `the task names ${file}, which is in this checkout. The workspace is this file's repository, not another one.`
    return { kind: "file", certain: true, file, workspace: { ...ws, decisionKind: "file", decisionLine: line }, line }
  }
  if (ws.targetIsForge && ws.selfTargeted) {
    const line = `the task is about forge itself. The workspace is forge's own source tree (${ws.forgeRoot}); changes here change the agent that is running them.`
    return { kind: "self", certain: true, workspace: { ...ws, decisionKind: "self", decisionLine: line }, line }
  }
  if (/\b(another|other|different)\s+(?:github\s+)?(?:repo|repository)\b/i.test(task)) {
    const line = "which repository? The task says another repo but does not name it. Give owner/name, a GitHub URL, or --cwd <dir>."
    return { kind: "ask", certain: false, workspace: { ...ws, decisionKind: "ask", decisionLine: line }, line }
  }
  const mine = /\bmy\s+(?:github\s+)?(?:repo|repository)\b|\bthis\s+github\s+(?:repo|repository)\b/i.test(task)
  const origin = ws.repositoryIdentity
  const originIsGithub = typeof origin === "string" && /github\.com[:/]/i.test(origin)
  if (mine && originIsGithub) {
    const line = `this checkout is ${displayRemote(origin) ?? "a GitHub repository"}. "my github repo" means this repository, not a different one and not a single file.`
    return { kind: "this-repo", certain: true, workspace: { ...ws, decisionKind: "this-repo", decisionLine: line, conflict: null, workspaceConfidence: CONFIDENCE.CERTAIN }, line }
  }
  if (mine && !originIsGithub) {
    const line = "which repository? This directory is not a GitHub checkout, and the task does not give owner/name or a URL."
    return { kind: "ask", certain: false, workspace: { ...ws, decisionKind: "ask", decisionLine: line }, line }
  }
  if (ws.conflict && /\bmy\s+project\b|\ba\s+project\b|\bnew\s+project\b|\bfor\s+my\s+app\b/i.test(task)) {
    const line = `this directory is forge's own source (${ws.forgeRoot}), and the task describes a different project. Name the repository, pass --cwd <dir>, or say the task is about forge.`
    return { kind: "ask", certain: false, workspace: { ...ws, decisionKind: "ask", decisionLine: line }, line }
  }
  if (ws.conflict) {
    return { kind: "unsaid", certain: false, workspace: { ...ws, decisionKind: "unsaid" }, line: formatWorkspace(ws) }
  }
  // the launch directory, possibly with places the task named elsewhere
  const places = Array.isArray(bound?.places) ? bound.places.slice(0, 6) : []
  const outside = Array.isArray(bound?.outsideFiles) ? bound.outsideFiles.slice(0, 4) : []
  const extra = [
    places.length ? `The task names places in more than one folder (${places.join(", ")}); nothing outside them was chosen for you — work in those places.` : "",
    outside.length ? `It also names ${outside.join(", ")}, outside this workspace.` : "",
  ].filter(Boolean).join(" ")
  // not a project, and the task asks for an answer, not files
  const isProject = Boolean(ws.repositoryRoot) || (Boolean(ws.projectType) && !isBareHome(here, ws.repositoryRoot))
  const taskOnly = !isProject && !places.length && !focus.length && !outside.length && taskNeedsNoFiles(task)
  const atHome = isBareHome(here, ws.repositoryRoot)
  return { kind: "cwd", certain: true, workspace: { ...ws, decisionKind: "cwd", focus, extraLine: extra || null, taskOnly, atHome }, line: extra }
}

/**
 * The line the model is told. Empty when there is nothing worth saying — an
 * ordinary project in an ordinary directory needs no commentary.
 */
export function formatWorkspace(ws) {
  if (!ws) return ""
  const body = formatWorkspaceBody(ws)
  return ws.workspaceKind && body ? `${body}\n[workspace] kind: ${ws.workspaceKind}.` : body
}

function formatWorkspaceBody(ws) {
  const about = describeWorkspace(ws)
  if (ws.decisionLine && ws.decisionKind && ws.decisionKind !== "unsaid") return `[workspace] ${about}\n[workspace] ${ws.decisionLine}`
  if (ws.conflict) {
    return [
      `[workspace] WARNING: this working directory IS forge's own source tree (${ws.forgeRoot}).`,
      `The task does not say it is about forge, so this is probably NOT where the user's project lives.`,
      `Do not create project files here. Ask which directory the project is in, or work only where the user pointed you.`,
    ].join(" ")
  }
  if (ws.targetIsForge && ws.selfTargeted) {
    return `[workspace] working ON forge itself — ${ws.targetWorkspace} is forge's own source tree, and the task names it. Treat edits here as changes to the agent's own code.`
  }
  if (ws.resolutionSource !== RESOLUTION.CWD) {
    return `[workspace] target project: ${ws.targetWorkspace}${ws.projectType ? ` (${ws.projectType})` : ""} — selected by ${ws.resolutionSource}, not by the working directory.`
  }
  // an ordinary run: still say WHAT the workspace is — the model knew only a
  // path, not that it was a git checkout of some repository on some branch,
  // or someone's home folder with no project in it
  const lines = [`[workspace] ${about}`]
  if (ws.extraLine) lines.push(`[workspace] ${ws.extraLine}`)
  if (ws.focus?.length) lines.push(`[workspace] the task names ${ws.focus.join(", ")} in it.`)
  return lines.join("\n")
}

/** The current branch of a git checkout (read from .git/HEAD, no git process), or null. */
export function gitBranchOf(root) {
  if (!root) return null
  try {
    let gitDir = path.join(root, ".git")
    const st = fs.statSync(gitDir)
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"))
      if (!m) return null
      gitDir = path.resolve(root, m[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : `detached at ${head.slice(0, 12)}`
  } catch { return null }
}

/**
 * One sentence on what the workspace IS: its path, whether it is a git
 * checkout (which remote, which branch), what kind of project, or that it is
 * a home folder with no project in it.
 */
export function displayRemote(identity) {
  if (typeof identity !== "string" || !identity || identity.startsWith("/") || /^[A-Za-z]:[\\/]/.test(identity)) return null
  const bare = identity
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1") // user:token@
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/:]+@([^:/]+):/, "$1/")              // git@host:owner/name
    .replace(/[?#].*$/, "")
  return redactSecrets(bare)?.text ?? null
}

export function describeWorkspace(ws) {
  if (!ws?.targetWorkspace) return ""
  const root = ws.targetWorkspace
  const bits = []
  const repoRoot = ws.repositoryRoot
  if (repoRoot) {
    // never a credential: a token in the remote URL would go to the model
    const shown = displayRemote(ws.repositoryIdentity)
    const branch = gitBranchOf(repoRoot)
    bits.push(`a git repository${shown ? ` (${shown})` : " with no remote"}${branch ? `, branch ${branch}` : ""}${repoRoot !== root ? `, rooted at ${repoRoot}` : ""}`)
  } else {
    bits.push("a folder, not a git repository")
  }
  const atHome = isBareHome(root, repoRoot)
  if (ws.projectType && !atHome) bits.push(`${ws.projectType} project`)
  const line = `workspace: ${root} — ${bits.join(", ")}.`
  // a task that needs no files is not told to make a project folder
  if (ws.taskOnly) return `${line} This task needs no project folder: it asks for an answer (a question, a piece of text, a value), not files. Answer it directly; if you do write a file, put it here and say where.`
  return atHome
    ? `${line} This is the home folder, not a project: put a new project in its own folder (for example ${path.join(root, "<name>")}) and say where.`
    : line
}

// the home folder is a project only when a manifest sits right in it — not
// because some project somewhere below it has .js files
const HOME_MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "pubspec.yaml", "composer.json", "Gemfile"]
function isBareHome(root, repoRoot) {
  let home = null
  try { home = fs.realpathSync(os.homedir()) } catch { home = os.homedir() }
  let real = root
  try { real = fs.realpathSync(root) } catch { /* as given */ }
  return real === home && !repoRoot && !HOME_MANIFESTS.some((m) => { try { return fs.existsSync(path.join(real, m)) } catch { return false } })
}

/**
 * Does the task text NAME this file — the path itself (relative to the
 * working directory, absolute, or ~/…) or a directory holding it? A write
 * outside the project that the task asked for ("write the report to
 * ../shared/report.md") is not a stray write. Only path-shaped words count
 * (a "/" or a leading ~), and "/", the home directory and the project's own
 * ancestors (`..`) name nothing in particular.
 */
export function taskNamesPath(task, file, { cwd = process.cwd(), home = process.env.HOME || "" } = {}) {
  const text = String(task ?? "")
  if (!text || !file) return false
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const under = (x, d) => x === d || x.startsWith(d.endsWith(path.sep) ? d : d + path.sep)
  const f = path.resolve(String(file))
  const fr = real(f)
  const here = path.resolve(cwd)
  for (const word of text.split(/[\s`'"()[\]<>{},;]+/)) {
    const t = word.replace(/[.:!?]+$/, "")
    if (!t || (!t.includes("/") && !t.startsWith("~"))) continue
    const abs = t.startsWith("~") ? (home ? path.join(home, t.slice(1)) : null) : path.resolve(here, t)
    if (!abs || abs === path.parse(abs).root || (home && abs === path.resolve(home)) || under(here, abs)) continue
    const ar = real(abs)
    if (under(f, abs) || under(fr, ar)) return true
  }
  return false
}

/**
 * v104 §4 — did this write land outside the resolved workspace?
 *
 * v88 removed the write boundary deliberately, so this does not block a write.
 * It answers the question the completion report needs: did a task edit a tree
 * nobody pointed it at? Path containment against the target, realpath'd, with
 * the same "no workspace resolved → nothing to compare" honesty as the rest of
 * this module.
 */
export function outsideWorkspace(ws, file) {
  const root = ws?.targetWorkspace
  if (!root || !file) return false
  if (String(file) === "(shell write)") return false   // unknown target, never guessed at
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const r = real(root)
  const f = real(file)
  return !(f === r || f.startsWith(r + path.sep))
}
