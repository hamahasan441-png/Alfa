/**
 * forge — which folder, file or project does the TASK name? (zero dependencies)
 *
 * A task says where it is about in plain words:
 *
 *   fix the bug in /home/kali/app/src/main.py      a file → its repository (or folder)
 *   in ~/projects/app add a login page             a folder
 *   change the heading in ../site/index.html       a relative path outside this checkout
 *   fix the tests in ~/Downloads/proj.zip          a project archive
 *   create a new project in ~/projects/todo        a folder that does not exist yet
 *   fix my shop project                            a local project, by name
 *
 * Before this module only a GitHub URL / owner/name moved the workspace
 * (sourceresolve.js repoIntentInTask), and a named file was recognised only
 * when it was already in the launch checkout. Everything else ran in the
 * directory forge was started from, and the model was told nothing — so
 * "in ~/projects/app add a login page" launched from ~ wrote into ~.
 *
 * What it decides, and what it refuses to guess:
 *   - only paths that EXIST (or a folder the task explicitly asks to create
 *     under an existing parent) count; a path in a code snippet that is not on
 *     disk is ignored
 *   - system locations (/etc, /usr, /proc, …) are never a workspace; a task
 *     that edits /etc/hosts is told the file, not bound to /etc
 *   - when everything named lives in ONE tree, that tree is the workspace
 *   - when a task names places in SEVERAL trees ("move ~/a/x.js to ~/b/"),
 *     nothing is bound — binding confines writes to one tree, which would break
 *     exactly that task — and the caller tells the model every place named
 *   - a project named only by its name is looked up in the usual places, and
 *     only when forge was not started inside a project; two matches → ask
 *
 * The caller (sourceresolve.adoptInvocationSource) binds the result the same
 * way it binds a named GitHub repository: chdir + FORGE_BOUND_ROOT.
 */
import { loadBuiltin } from "./lazybuiltin.js"
import path from "node:path"
import os from "node:os"

const fs = loadBuiltin("fs")

/** Never a workspace: the system's own trees (a file there may still be the task's focus). */
const SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/sys", "/dev", "/boot", "/run",
  "/var/log", "/var/lib", "/var/cache", "/var/run", "/var/spool", "/var/mail", "/snap", "/nix/store", "/system", "/vendor", "/apex"]
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
  "build.gradle.kts", "pubspec.yaml", "Gemfile", "composer.json", "CMakeLists.txt", "Makefile", "index.html", "deno.json", "mix.exs"]
const NAME_STOP = new Set(["new", "own", "whole", "current", "this", "that", "the", "my", "our", "first", "next", "main", "old", "local",
  "web", "mobile", "android", "ios", "flutter", "react", "vue", "angular", "svelte", "next", "nuxt", "python", "node", "nodejs", "js", "ts",
  "java", "kotlin", "swift", "rust", "go", "golang", "php", "ruby", "django", "flask", "fastapi", "express", "laravel", "spring", "dotnet",
  "github", "git", "personal", "school", "work", "side", "test", "demo", "sample", "simple", "small", "big", "full", "entire", "existing"])

const realOf = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/** A system location (never bound). The filesystem root itself counts. */
export function isSystemPath(p) {
  const r = realOf(p)
  if (r === path.parse(r).root) return true
  return SYSTEM_ROOTS.some((s) => under(r, s))
}

/** The enclosing git repository root of `p` (a file or a directory), or null. */
export function gitRootOf(p) {
  let dir = isDir(p) ? realOf(p) : path.dirname(realOf(p))
  for (let i = 0; i < 64; i++) {
    try { if (fs.existsSync(path.join(dir, ".git"))) return dir } catch { /* keep walking */ }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

/** Is `dir` a project (a git checkout or a folder with a manifest)? */
export function looksLikeProject(dir) {
  if (!isDir(dir)) return false
  if (fs.existsSync(path.join(dir, ".git"))) return true
  return MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)))
}

/**
 * Path-like tokens in a task: absolute, ~/…, ./…, ../…, a relative path with
 * a slash, or a bare file name with an extension. Quoted paths may contain
 * spaces. URLs and git remotes are not paths.
 */
export function pathTokensInTask(text = "") {
  const raw = String(text ?? "")
  const out = []
  const push = (t, index) => {
    let s = String(t).trim().replace(/[.,;:!?)\]}>]+$/, "").replace(/^[(<[{]+/, "")
    if (!s || s.length > 400) return
    if (/:\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s) || /^(?:www\.)?github\.com\//i.test(s)) return
    out.push({ token: s, index })
  }
  // URLs and remote specs (user@host:/path) are not local paths: blank them
  // (same length, so positions still line up with the original text)
  const scan = raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => " ".repeat(m.length))
    .replace(/\S+@[\w.-]+:\S*/g, (m) => " ".repeat(m.length))
  // quoted first (they may hold spaces), then the unquoted words around them
  const quoted = []
  for (const m of scan.matchAll(/(["'`])((?:~|\.{1,2}|\/)[^"'`\n]{0,300}?)\1/g)) { quoted.push([m.index, m.index + m[0].length]); push(m[2], m.index) }
  for (const m of scan.matchAll(/(?:^|[\s(=:])((?:~(?=\/|$|\s)|\.{1,2}\/|\/)?[\w.@+~-]*(?:\/[\w.@+ -]*?[\w.@+-])*(?:\/[\w.@+-]+|\.[A-Za-z0-9]{1,10}|\/)?)(?=$|[\s"'`),;:!?\]}>])/g)) {
    const token = m[1]
    const at = m.index + m[0].indexOf(token)
    if (quoted.some(([a, b]) => at >= a && at < b)) continue
    if (!token || token === "~" && !/\s~(\s|$)/.test(` ${raw} `)) continue
    const pathish = token.startsWith("/") || token.startsWith("~") || token.startsWith("./") || token.startsWith("../") || token.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(token)
    if (!pathish || /^\d+(\.\d+)*$/.test(token) || /^\.+$/.test(token)) continue
    push(token, at)
  }
  // de-duplicate by token, keep first position
  const seen = new Set()
  return out.filter((x) => (seen.has(x.token) ? false : (seen.add(x.token), true))).sort((a, b) => a.index - b.index)
}

function expandHome(token, home) {
  if (token === "~") return home
  if (token.startsWith("~/")) return path.join(home, token.slice(2))
  return token
}

/**
 * A place that is never a workspace even when named: credential and config
 * folders directly under home (~/.ssh, ~/.gnupg, ~/.aws, ~/.config, browser
 * profiles …) and forge's own data folder. A pasted task must not make
 * ~/.ssh the official — and only writable — place.
 */
export function isSensitivePath(p, home = os.homedir()) {
  const r = realOf(p)
  const h = realOf(home)
  if (under(r, h) && r !== h) {
    const first = path.relative(h, r).split(path.sep)[0]
    if (first.startsWith(".")) return true
  }
  const fh = process.env.FORGE_HOME ? realOf(process.env.FORGE_HOME) : null
  return Boolean(fh && under(r, fh))
}

// "write a README like ../other/README.md", "copy settings from ~/x/config":
// a path the task REFERS to is not where it works
const REFERENCE_BEFORE = /\b(like|similar to|based on|inspired by|as in|as done in|compare[ds]?(?: (?:to|with))?|e\.g\.|for example|from|the same as|mirror(?:ing)?|reference|(?:style|pattern|format|layout|structure|conventions?|approach|example)\s+(?:of|in|from|used in))\s+(?:the\s+|a\s+|an\s+|this\s+|that\s+)?(?:file\s+|folder\s+|one\s+(?:in|at)\s+)?$/i
// "in ~/projects/app", "work on ~/site", "cd ../other", "open the project at ~/x"
const WORK_LOCATION_BEFORE = /\b(in|inside|into|on|at|under|cd|open|enter|go to|switch to|work(?:ing)? (?:on|in))\s+(?:the\s+|my\s+|our\s+)?(?:folder|directory|dir|project|repo|repository|workspace|codebase)?\s*(?:at|in)?\s*$/i
// "create a new project in ~/projects/todo" — an explicit new FOLDER/PROJECT
const CREATE_FOLDER_BEFORE = /\b(create|make|init|initiali[sz]e|scaffold|start|set\s*up|bootstrap|generate)\b[^.\n]{0,40}\b(project|folder|directory|repo|repository|workspace|app|site|website)\b[^.\n]{0,24}$/i

/** The project a named path belongs to: its git root (not a dotfiles repo at
 *  ~), else the nearest folder above it with a manifest, never climbing to the
 *  home folder, a system folder or / . null when it is in no project. */
function ownerRootOf(real, isDirP, homeReal) {
  const start = isDirP ? real : path.dirname(real)
  const g = gitRootOf(start)
  if (g && g !== homeReal) return g
  for (let d = start; d !== homeReal && path.dirname(d) !== d && !isSystemPath(d); d = path.dirname(d)) {
    if (MANIFESTS.some((m) => fs.existsSync(path.join(d, m)))) return d
  }
  return null
}

/**
 * What the task names on disk, resolved:
 *   { action: "none", focus, outsideFiles }   nothing to move to; places named are told
 *   { action: "target", root, kind, focus, reason, create? }
 *   { action: "spread", places, reason }      several trees named: do not bind, tell the model
 *
 * `launchIsWorkspace`: forge was started inside a real project (not the home
 * folder, not forge's own source for a task about something else). Then the
 * launch project stays the workspace, and a path elsewhere is TOLD, not bound
 * — "the crash log is in /tmp" or "like ../other/README.md" must not move the
 * run and lock the user's project. Only an explicit "create a new project in
 * …" or "in/at <another project folder>" moves it.
 * `launch`: the directory this process was first started in (chat, web): a
 * relative path not found here is looked for there, so "now fix src/a.js"
 * after an earlier task moved the run comes back.
 */
export function localTargetsInTask(text = "", { cwd = process.cwd(), home = os.homedir(), launchIsWorkspace = null, launch = null } = {}) {
  const here = realOf(cwd)
  const homeReal = realOf(home)
  const hereGit = gitRootOf(here)
  // a dotfiles repository at ~ does not make the home folder one project
  const hereRoot = hereGit && hereGit !== homeReal ? hereGit : here
  // the launch TREE: the folder forge was started in, unless that is the home
  // folder or a system folder, where a named subfolder is its own place
  const launchTree = hereRoot !== homeReal && !isSystemPath(hereRoot) && path.dirname(hereRoot) !== hereRoot ? hereRoot : null
  const launchIsProject = Boolean(launchTree && (launchIsWorkspace || looksLikeProject(launchTree)))
  // the caller knows more (forge's own source for a task about something else
  // is not the workspace); a direct call decides from the folder itself
  const startedInProject = launchIsWorkspace ?? launchIsProject
  const raw = String(text ?? "")
  const tokens = pathTokensInTask(raw).filter((t) => t.token !== "~")
  const found = []      // { token, abs, kind, root, inLaunch, reference, workLoc }
  const missing = []    // nonexistent tokens (for create-intent)
  const launchReal = launch ? realOf(launch) : null
  for (const { token, index } of tokens) {
    const before = raw.slice(Math.max(0, index - 60), index)
    const reference = REFERENCE_BEFORE.test(before)
    const workLoc = WORK_LOCATION_BEFORE.test(before)
    const expanded = expandHome(token, home)
    const bare = !token.includes("/") && !token.startsWith("~")
    let abs = path.resolve(here, expanded)
    // back to the launch project: a relative path that is not here but is there
    if (launchReal && launchReal !== here && !path.isAbsolute(expanded) && !fs.existsSync(abs) && fs.existsSync(path.resolve(launchReal, expanded))) {
      abs = path.resolve(launchReal, expanded)
    }
    const dir = isDir(abs), file = !dir && isFile(abs)
    if ((dir && !bare) || file) {
      const real = realOf(abs)
      let inLaunch = Boolean(launchTree && under(real, launchTree))
      const own = ownerRootOf(real, dir, homeReal)
      // started in a folder of projects (~/projects, not itself a project):
      // a project inside it is its own place
      if (inLaunch && !launchIsProject && own && own !== launchTree && under(own, launchTree)) inLaunch = false
      const kind = dir ? "dir" : /\.zip$/i.test(real) && !bare && !inLaunch ? "zip" : "file"
      // inside the launch tree the workspace is the launch tree — never a
      // subfolder of it (a non-git project's src/ is not the project)
      const root = inLaunch ? launchTree : kind === "zip" ? real : (own ?? (dir ? real : path.dirname(real)))
      const bindable = !inLaunch && !reference && !isSystemPath(root) && !isSensitivePath(root, home) && root !== homeReal
      found.push({ token, abs: real, kind, root, inLaunch, reference, workLoc, bindable })
    } else if (!bare && (token.startsWith("/") || token.startsWith("~") || token.startsWith("./") || token.startsWith("../"))) {
      missing.push({ token, abs: path.resolve(here, expanded), index, before })
    }
  }

  // an explicit new project/folder, under an existing parent, never inside
  // the launch project, never in a system or credential folder
  if (missing.length === 1 && !found.some((f) => f.bindable)) {
    const m = missing[0]
    const parent = path.dirname(m.abs)
    if (CREATE_FOLDER_BEFORE.test(m.before) && !path.extname(m.abs) && isDir(parent) && !isSystemPath(parent) && !isSensitivePath(m.abs, home) && !(launchIsProject && under(m.abs, launchTree))) {
      return { action: "target", root: m.abs, kind: "new-dir", create: true, focus: [], reason: `the task asks to create ${m.token}` }
    }
  }

  if (!found.length) return { action: "none", reason: "the task names no folder or file on disk" }
  const focusOf = (root) => found.filter((f) => under(f.abs, root) && f.abs !== root).map((f) => path.relative(root, f.abs)).filter(Boolean)
  const outsideNamed = found.filter((f) => !f.inLaunch && !(f.abs === here || under(f.abs, here))).map((f) => f.abs)
  // staying: what the task names here, relative to the run's folder
  const hereFocus = found.filter((f) => (f.inLaunch || under(f.abs, here)) && f.abs !== here).map((f) => path.relative(here, f.abs)).filter(Boolean)
  const stay = (reason) => ({ action: "none", focus: hereFocus, outsideFiles: outsideNamed, reason })
  const candidates = found.filter((f) => f.bindable)
  if (!candidates.length) return stay(outsideNamed.length ? "the places named elsewhere are references, system or private folders" : "everything the task names is in this workspace")

  if (startedInProject) {
    // started in a project: only an explicit "in/at <another project folder>" moves the run
    const moves = candidates.filter((f) => f.kind === "dir" && f.workLoc && looksLikeProject(f.root))
    const roots = [...new Set(moves.map((f) => f.root))]
    if (roots.length !== 1) return stay("forge was started in a project; places named elsewhere are told, not bound")
    const named = moves.find((f) => f.root === roots[0])
    return { action: "target", root: roots[0], kind: fs.existsSync(path.join(roots[0], ".git")) ? "repo" : "folder", focus: focusOf(roots[0]), outsideFiles: outsideNamed.filter((p) => !under(p, roots[0])), reason: `the task says to work in ${named.token}` }
  }

  const bindRoots = [...new Set(candidates.map((f) => f.root))]
  if (bindRoots.length === 1) {
    const root = bindRoots[0]
    const named = candidates.find((f) => f.root === root)
    const kind = named.kind === "zip" ? "zip" : fs.existsSync(path.join(root, ".git")) ? "repo" : "folder"
    return {
      action: "target", root, kind, focus: named.kind === "zip" ? [] : focusOf(root),
      outsideFiles: outsideNamed.filter((p) => !under(p, root)),
      reason: `the task names ${named.token}`,
    }
  }
  return {
    action: "spread",
    places: candidates.map((f) => f.abs),
    reason: `the task names places in ${bindRoots.length} different trees (${bindRoots.slice(0, 4).join(", ")})`,
  }
}

/**
 * "fix my shop project" / "the project called shop" — a local project by NAME.
 * Only looked up when forge was not started inside a project (in a project,
 * "my app" means this one). Searched one level deep in the usual places.
 *   { action: "none" } | { action: "target", root, reason } | { action: "ask", candidates, reason }
 */
export function namedProjectInTask(text = "", { cwd = process.cwd(), home = os.homedir(), launchIsWorkspace = null } = {}) {
  const raw = String(text ?? "")
  const names = new Set()
  // only "project / repo / codebase" name a project: "the server code", "the
  // Desktop folder" and "my notes app idea" do not
  for (const m of raw.matchAll(/\b(?:my|the|our)\s+([A-Za-z0-9][\w.-]{1,40})\s+(?:project|repo|repository|codebase)\b/gi)) names.add(m[1])
  for (const m of raw.matchAll(/\b(?:project|repo|repository|folder|app)\s+(?:called|named)\s+["'`]?([A-Za-z0-9][\w.-]{1,40})/gi)) names.add(m[1])
  const wanted = [...names].filter((n) => !NAME_STOP.has(n.toLowerCase()))
  if (!wanted.length) return { action: "none", reason: "the task names no project" }
  const here = realOf(cwd)
  const inProject = launchIsWorkspace ?? (looksLikeProject(here) || Boolean(gitRootOf(here) && gitRootOf(here) !== realOf(home)))
  if (inProject) return { action: "none", reason: "forge was started inside a project" }
  const places = [here, home, ...["projects", "Projects", "project", "src", "code", "Code", "dev", "git", "repos", "work", "workspace", "Documents", "Desktop", "github", "GitHub"].map((d) => path.join(home, d)),
    "/sdcard", "/sdcard/Download", "/sdcard/Documents", "/storage/emulated/0"]
  const hits = new Set()
  for (const place of [...new Set(places.map(realOf))]) {
    let entries = []
    try { entries = fs.readdirSync(place, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (!wanted.some((w) => w.toLowerCase() === e.name.toLowerCase())) continue
      const dir = realOf(path.join(place, e.name))
      if (looksLikeProject(dir) && !isSystemPath(dir) && !isSensitivePath(dir, home)) hits.add(dir)
    }
  }
  const list = [...hits]
  if (list.length === 1) return { action: "target", root: list[0], kind: fs.existsSync(path.join(list[0], ".git")) ? "repo" : "folder", focus: [], reason: `the task names the project "${wanted[0]}", found at ${list[0]}` }
  if (list.length > 1) return { action: "ask", candidates: list, reason: `the task names "${wanted[0]}" and there are ${list.length} projects by that name: ${list.join(", ")}` }
  return { action: "none", reason: `no local project named "${wanted[0]}"` }
}
