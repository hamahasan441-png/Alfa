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
const CREATE_INTENT = /\b(create|new|make|init|initiali[sz]e|scaffold|start|set\s*up|bootstrap|generate|build)\b/i
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
 * What the task names on disk, resolved:
 *   { action: "none" }                        nothing named, or only things in the launch tree
 *   { action: "target", root, kind, focus, reason, created? }
 *   { action: "spread", places, reason }      several trees named: do not bind, tell the model
 * `focus`: the named files/folders inside the root (relative), for the prompt.
 */
export function localTargetsInTask(text = "", { cwd = process.cwd(), home = os.homedir() } = {}) {
  const here = realOf(cwd)
  const hereRoot = gitRootOf(here) ?? here
  const tokens = pathTokensInTask(text)
  const found = []      // { abs, kind: "dir"|"file"|"zip", root, bindable }
  const missing = []    // nonexistent tokens (for create-intent)
  for (const { token, index } of tokens) {
    const expanded = expandHome(token, home)
    const abs = path.resolve(here, expanded)
    // a bare name ("README.md") only counts when it is right here — it is not a path elsewhere
    const bare = !token.includes("/") && !token.startsWith("~")
    if (isDir(abs) && !bare) {
      const real = realOf(abs)
      const root = gitRootOf(real) ?? real
      found.push({ token, abs: real, kind: "dir", root, bindable: !isSystemPath(root) && real !== realOf(home) })
    } else if (isFile(abs)) {
      const real = realOf(abs)
      if (/\.zip$/i.test(real) && !bare) { found.push({ token, abs: real, kind: "zip", root: real, bindable: true }); continue }
      const root = gitRootOf(real) ?? path.dirname(real)
      found.push({ token, abs: real, kind: "file", root, bindable: !isSystemPath(root) && root !== realOf(home) })
    } else if (!bare && (token.startsWith("/") || token.startsWith("~") || token.startsWith("./") || token.startsWith("../"))) {
      missing.push({ token, abs: path.resolve(here, expanded), index })
    }
  }

  // a folder the task asks to create, under an existing parent, outside system trees
  if (!found.some((f) => f.root !== hereRoot) && missing.length === 1) {
    const m = missing[0]
    const before = String(text).slice(Math.max(0, m.index - 80), m.index)
    const parent = path.dirname(m.abs)
    if (CREATE_INTENT.test(before) && !path.extname(m.abs) && isDir(parent) && !isSystemPath(parent) && !under(realOf(here), m.abs)) {
      return { action: "target", root: m.abs, kind: "new-dir", create: true, focus: [], reason: `the task asks to create ${m.token}` }
    }
  }

  if (!found.length) return { action: "none", reason: "the task names no folder or file on disk" }
  const focusOf = (root) => found.filter((f) => under(f.abs, root) && f.abs !== root).map((f) => path.relative(root, f.abs)).filter(Boolean)
  const roots = [...new Set(found.map((f) => f.root))]
  const unbindable = found.filter((f) => !f.bindable)
  const outside = roots.filter((r) => r !== hereRoot)

  // everything named is in the launch tree (or is a system file): stay, but say what was named
  if (!outside.length || outside.every((r) => found.filter((f) => f.root === r).every((f) => !f.bindable))) {
    return {
      action: "none", focus: focusOf(hereRoot),
      outsideFiles: unbindable.map((f) => f.abs),
      reason: unbindable.length ? "the task names a system file; the workspace stays where forge started" : "everything the task names is in this checkout",
    }
  }
  const bindRoots = [...new Set(found.filter((f) => f.bindable).map((f) => f.root))]
  if (bindRoots.length === 1) {
    const root = bindRoots[0]
    const named = found.find((f) => f.root === root)
    const kind = named.kind === "zip" ? "zip" : isDir(path.join(root, ".git")) || fs.existsSync(path.join(root, ".git")) ? "repo" : "folder"
    return {
      action: "target", root, kind, focus: named.kind === "zip" ? [] : focusOf(root),
      outsideFiles: unbindable.map((f) => f.abs),
      reason: `the task names ${named.token}`,
    }
  }
  return {
    action: "spread",
    places: found.map((f) => f.abs),
    reason: `the task names places in ${bindRoots.length} different trees (${bindRoots.slice(0, 4).join(", ")})`,
  }
}

/**
 * "fix my shop project" / "the project called shop" — a local project by NAME.
 * Only looked up when forge was not started inside a project (in a project,
 * "my app" means this one). Searched one level deep in the usual places.
 *   { action: "none" } | { action: "target", root, reason } | { action: "ask", candidates, reason }
 */
export function namedProjectInTask(text = "", { cwd = process.cwd(), home = os.homedir() } = {}) {
  const raw = String(text ?? "")
  const names = new Set()
  for (const m of raw.matchAll(/\b(?:my|the|our)\s+([A-Za-z0-9][\w.-]{1,40})\s+(?:project|repo|repository|app|application|folder|codebase|site|website|code)\b/gi)) names.add(m[1])
  for (const m of raw.matchAll(/\b(?:project|repo|repository|folder|app)\s+(?:called|named)\s+["'`]?([A-Za-z0-9][\w.-]{1,40})/gi)) names.add(m[1])
  const wanted = [...names].filter((n) => !NAME_STOP.has(n.toLowerCase()))
  if (!wanted.length) return { action: "none", reason: "the task names no project" }
  const here = realOf(cwd)
  if (looksLikeProject(here) || (gitRootOf(here) && gitRootOf(here) !== realOf(home))) return { action: "none", reason: "forge was started inside a project" }
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
      if (looksLikeProject(dir) && !isSystemPath(dir)) hits.add(dir)
    }
  }
  const list = [...hits]
  if (list.length === 1) return { action: "target", root: list[0], kind: fs.existsSync(path.join(list[0], ".git")) ? "repo" : "folder", focus: [], reason: `the task names the project "${wanted[0]}", found at ${list[0]}` }
  if (list.length > 1) return { action: "ask", candidates: list, reason: `the task names "${wanted[0]}" and there are ${list.length} projects by that name: ${list.join(", ")}` }
  return { action: "none", reason: `no local project named "${wanted[0]}"` }
}
