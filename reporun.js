/**
 * forge — repo to pull request in one command (Phase 7, zero dependencies)
 *
 *   forge run --repo owner/name "add a health endpoint"
 *   forge run --repo owner/name --base dev --branch forge/health "…" --pr
 *
 * Arena's Agent Mode: pick a GitHub repo and branch, the agent works in a
 * sandbox copy, you review the diff, then push and open a PR. Here:
 *
 *  1. CHECKOUT  the repo is cloned once into <FORGE_HOME>/repos/<owner>/<name>
 *               (`gh repo clone` when gh is signed in — private repos work —
 *               else `git clone`). Later runs fetch. A clone with uncommitted
 *               changes is refused, never reset: those changes are yours.
 *  2. BRANCH    a fresh working branch from origin/<base> (--base, default:
 *               the remote's default branch): --branch, or forge/<slug>-<id>.
 *               Your own checkout elsewhere is never touched.
 *  3. RUN       the task on the controller (runTask, mode "meta") inside the
 *               clone, so the plan, model chain, verification gate and combine
 *               step all apply.
 *  4. DELIVER   through gitship, the same verified-delivery path as always:
 *               only verified files, only after the completion gate passes,
 *               never an unverified completion. Without --pr the commit stays
 *               on the local branch. With --pr (your explicit consent for this
 *               run) it is pushed — never forced — and a PR is opened with your
 *               own `gh` against --base.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

/** "owner/name", "github.com/owner/name", "https://github.com/owner/name(.git)". */
export function parseRepoSpec(raw) {
  const s = String(raw ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "")
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(s)
  // what `gh repo clone` leaves as origin when gh uses the ssh protocol
  if (!m) m = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+)$/i.exec(s)
  if (!m) m = /^([\w.-]+)\/([\w.-]+)$/.exec(s)
  if (!m || m[1].startsWith(".") || m[2].startsWith(".") || m[1] === ".." || m[2] === "..") return null
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` }
}

/** forge/<words-of-the-task>-<6 hex>, or the name given (validated by git). */
export function branchNameFor(task, given = null) {
  if (given) return String(given).trim()
  const words = String(task ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 6).join("-") || "task"
  return `forge/${words.slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`
}

export function reposRoot(home) { return path.join(home, "repos") }

const defaultGit = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  return { ok: r.status === 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? r.error?.message ?? "") }
}
const defaultGh = (args, cwd) => {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 300000 })
  return { ok: r.status === 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? r.error?.message ?? ""), missing: Boolean(r.error) }
}
const first = (s) => String(s ?? "").trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? ""

/**
 * Steps 1–2: get a clean clone on a fresh working branch.
 * @returns {{ ok, dir?, branch?, base?, cloned?, reason? }}
 */
export function prepareRepo({ spec, home, base = null, branch = null, task = "", git = defaultGit, gh = defaultGh } = {}) {
  const repo = typeof spec === "string" ? parseRepoSpec(spec) : spec
  if (!repo) return { ok: false, reason: `not a GitHub repository: "${spec}" — use owner/name` }
  const dir = path.join(reposRoot(home), repo.owner, repo.name)
  let cloned = false
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const auth = gh(["auth", "status"], process.cwd())
    let r = !auth.missing && auth.ok ? gh(["repo", "clone", repo.slug, dir], process.cwd()) : null
    if (!r || !r.ok) r = git(["clone", repo.url, dir], process.cwd())
    if (!r.ok) return { ok: false, reason: `could not clone ${repo.slug}: ${first(r.err)}` }
    cloned = true
  } else {
    // the configured URL as written (get-url would apply insteadOf rewrites)
    const origin = git(["config", "--get", "remote.origin.url"], dir)
    const o = parseRepoSpec(origin.out.trim())
    if (!o || o.slug.toLowerCase() !== repo.slug.toLowerCase()) return { ok: false, reason: `${dir} exists but its origin is not ${repo.slug} (${origin.out.trim() || "none"}) — move it away first` }
    const dirty = git(["status", "--porcelain", "--", ".", ":(exclude).forge", ":(exclude).forge/**"], dir)
    if (!dirty.ok) return { ok: false, reason: `git status failed in ${dir}: ${first(dirty.err)}` }
    if (dirty.out.trim()) return { ok: false, reason: `the clone at ${dir} has uncommitted changes — they are yours, so forge will not reset them. Commit, stash or discard them first` }
    const f = git(["fetch", "--prune", "origin"], dir)
    if (!f.ok) return { ok: false, reason: `git fetch failed: ${first(f.err)}` }
  }
  let baseBranch = base
  if (!baseBranch) {
    const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)
    baseBranch = head.ok ? head.out.trim().replace(/^origin\//, "") : null
    if (!baseBranch) {
      const rs = git(["remote", "set-head", "origin", "--auto"], dir)
      const again = rs.ok ? git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir) : { ok: false }
      baseBranch = again.ok ? again.out.trim().replace(/^origin\//, "") : "main"
    }
  }
  const baseRef = `origin/${baseBranch}`
  if (!git(["rev-parse", "--verify", "--quiet", baseRef], dir).ok) return { ok: false, reason: `the base branch ${baseBranch} does not exist on origin` }
  const work = branchNameFor(task, branch)
  if (!git(["check-ref-format", "--branch", work], dir).ok) return { ok: false, reason: `"${work}" is not a valid branch name` }
  const co = git(["checkout", "-q", "-B", work, baseRef], dir)
  if (!co.ok) return { ok: false, reason: `could not create branch ${work}: ${first(co.err)}` }
  return { ok: true, dir, branch: work, base: baseBranch, cloned, repo }
}

/**
 * The run's config: delivery ON for this run only. Commit always (to the new
 * branch); push + PR only with `pr` — the person's explicit consent.
 */
export function deliveryConfig(config = {}, { pr = false, base = null } = {}) {
  return {
    ...config,
    gitship: { ...(config.gitship ?? {}), commit: "on", branch: "off", push: pr ? "auto" : "off", pr: pr ? "auto" : "off", ...(base ? { prBase: base } : {}) },
  }
}

/**
 * Steps 1–4. `runTask`/`createForgeCore` are injected (runtask.js / core.js).
 * @returns {{ ok, reason?, dir, branch, base, res?, delivery? }}
 */
export async function runOnRepo({ spec, task, home, base = null, branch = null, pr = false, config = {}, provider, runTask, createForgeCore, runAgent = null, onEvent = null, signal = null, git = defaultGit, gh = defaultGh } = {}) {
  if (!String(task ?? "").trim()) return { ok: false, reason: "no task given" }
  const prep = prepareRepo({ spec, home, base, branch, task, git, gh })
  if (!prep.ok) return prep
  const prevCwd = process.cwd()
  let delivery = null
  try {
    process.chdir(prep.dir)
    const cfg = deliveryConfig(config, { pr, base: prep.base })
    const out = await runTask({
      task, config: cfg, provider, runAgent, createForgeCore, mode: "meta", signal,
      onEvent: (ev) => {
        if (ev?.type === "GITSHIP_COMMITTED") delivery = { committed: true, sha: ev.sha, files: ev.files ?? [], pushed: Boolean(ev.pushed), text: ev.text ?? "", prPath: ev.prPath ?? null, pr: (/· PR (\S+)/.exec(ev.text ?? "") ?? [])[1] ?? null }
        else if (ev?.type === "GITSHIP_SKIPPED") delivery = { committed: false, reason: ev.reason }
        onEvent?.(ev)
      },
    })
    return { ok: true, dir: prep.dir, branch: prep.branch, base: prep.base, cloned: prep.cloned, res: out.res, delivery }
  } finally {
    try { process.chdir(prevCwd) } catch { }
  }
}
