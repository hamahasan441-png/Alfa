/**
 * Phase 7 — `forge run --repo owner/name "task"` (reporun.js).
 * Real git: a local bare repository stands in for github.com through git's
 * `url.<local>.insteadOf` rewrite, so nothing touches the network. gh is a
 * stub (never the real CLI — a test must not open real pull requests).
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reporun-"))
process.env.FORGE_HOME = path.join(tmp, "home")
const R = await import("../reporun.js")
const { maybeShip } = await import("../gitship.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

// the "GitHub" remote: a bare repo with main (default) and dev
const bare = path.join(tmp, "remote", "acme", "app.git")
const seed = path.join(tmp, "seed")
fs.mkdirSync(seed, { recursive: true }); fs.mkdirSync(path.dirname(bare), { recursive: true })
sh(seed, "init", "-q", "-b", "main"); sh(seed, "config", "user.email", "t@t"); sh(seed, "config", "user.name", "t")
fs.writeFileSync(path.join(seed, "app.js"), "export const v = 1\n"); fs.writeFileSync(path.join(seed, ".gitignore"), ".forge/\n")
sh(seed, "add", "-A"); sh(seed, "commit", "-qm", "base")
sh(seed, "checkout", "-qb", "dev"); fs.writeFileSync(path.join(seed, "dev.txt"), "dev\n"); sh(seed, "add", "-A"); sh(seed, "commit", "-qm", "dev"); sh(seed, "checkout", "-q", "main")
execFileSync("git", ["clone", "-q", "--bare", seed, bare])
// every git process in this test rewrites the GitHub URL to the bare repo
Object.assign(process.env, { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t", GIT_CONFIG_KEY_2: "user.name", GIT_CONFIG_VALUE_2: "t" })
const ghCalls = []
const gh = (args) => { ghCalls.push(args); return { ok: false, out: "", err: "not logged in", missing: false } }
const home = process.env.FORGE_HOME

await t("parseRepoSpec accepts owner/name and GitHub URLs, nothing else", () => {
  assert.equal(R.parseRepoSpec("acme/app").slug, "acme/app")
  assert.equal(R.parseRepoSpec("https://github.com/acme/app.git").url, "https://github.com/acme/app.git")
  assert.equal(R.parseRepoSpec("github.com/acme/app/").name, "app")
  assert.equal(R.parseRepoSpec("git@github.com:acme/app.git").slug, "acme/app")
  for (const bad of ["", "acme", "../x/y", "acme/app/extra", "https://gitlab.com/a/b", "/etc/passwd", "a b/c"]) assert.equal(R.parseRepoSpec(bad), null, bad)
})
await t("branchNameFor: forge/<task words>-<id>, or the name given", () => {
  assert.match(R.branchNameFor("Add a /health endpoint, please!"), /^forge\/add-a-health-endpoint-please-[0-9a-f]{6}$/)
  assert.equal(R.branchNameFor("x", "feature/mine"), "feature/mine")
})
await t("deliveryConfig: commit always; push + PR only with --pr", () => {
  assert.deepEqual(R.deliveryConfig({ gitship: { commit: "off" } }).gitship, { commit: "on", branch: "off", push: "off", pr: "off" })
  assert.deepEqual(R.deliveryConfig({}, { pr: true, base: "dev" }).gitship, { commit: "on", branch: "off", push: "auto", pr: "auto", prBase: "dev" })
})
let first
await t("first run clones into FORGE_HOME/repos/<owner>/<name> on a fresh branch from the default base", () => {
  first = R.prepareRepo({ spec: "acme/app", home, task: "add health", gh })
  assert.equal(first.ok, true, first.reason)
  assert.equal(first.dir, path.join(home, "repos", "acme", "app")); assert.equal(first.cloned, true); assert.equal(first.base, "main")
  assert.equal(sh(first.dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), first.branch)
  assert.equal(sh(first.dir, "config", "--get", "remote.origin.url").trim(), "https://github.com/acme/app.git")
  assert.ok(ghCalls.some((a) => a[0] === "auth"), "gh was asked first (private repos)")
})
await t("a later run fetches, and --base picks another branch", () => {
  const p = R.prepareRepo({ spec: "acme/app", home, task: "x", base: "dev", branch: "forge/on-dev", gh })
  assert.equal(p.ok, true, p.reason); assert.equal(p.cloned, false); assert.equal(p.base, "dev")
  assert.ok(fs.existsSync(path.join(p.dir, "dev.txt")))
})
await t("refused: uncommitted changes in the clone are never reset", () => {
  fs.writeFileSync(path.join(first.dir, "app.js"), "local work\n")
  const p = R.prepareRepo({ spec: "acme/app", home, task: "x", gh })
  assert.equal(p.ok, false); assert.match(p.reason, /uncommitted changes — they are yours/)
  assert.equal(fs.readFileSync(path.join(first.dir, "app.js"), "utf8"), "local work\n")
  sh(first.dir, "checkout", "--", "app.js")
})
await t("refused: an unknown base, an invalid branch name, a foreign origin", () => {
  assert.match(R.prepareRepo({ spec: "acme/app", home, base: "nope", gh }).reason, /base branch nope does not exist/)
  assert.match(R.prepareRepo({ spec: "acme/app", home, branch: "bad..name", gh }).reason, /not a valid branch name/)
  const other = path.join(home, "repos", "acme", "other"); fs.mkdirSync(other, { recursive: true }); sh(other, "init", "-q"); sh(other, "remote", "add", "origin", "https://github.com/evil/other.git")
  assert.match(R.prepareRepo({ spec: "acme/other", home, gh }).reason, /origin is not acme\/other/)
  assert.match(R.prepareRepo({ spec: "not a repo", home, gh }).reason, /use owner\/name/)
})
await t("runOnRepo: runs in the clone on the controller, delivers the verified commit, pushes with --pr", async () => {
  const seen = {}
  // stands in for runTask → meta → attemptCompletion → maybeShip, with the REAL gitship
  const runTask = async ({ task, config, mode, onEvent }) => {
    Object.assign(seen, { cwd: process.cwd(), mode, gitship: config.gitship })
    fs.writeFileSync(path.join(process.cwd(), "health.js"), "export const ok = true\n")
    const ship = await maybeShip({ root: process.cwd(), config: { ...config, gitship: { ...config.gitship, pr: "off" } }, taskId: "t-1", runId: "r-1", objective: task, changedFiles: ["health.js"], verificationStatus: "PASSED" })
    onEvent({ type: "GITSHIP_COMMITTED", sha: ship.sha, files: ship.files, pushed: ship.pushed, text: ship.reason })
    return { res: { taskStatus: "COMPLETED", text: "added health.js" } }
  }
  const before = process.cwd()
  const out = await R.runOnRepo({ spec: "acme/app", task: "add a health module", home, pr: true, runTask, createForgeCore: () => ({}), gh })
  assert.equal(out.ok, true, out.reason); assert.equal(process.cwd(), before, "cwd restored")
  assert.equal(seen.cwd, out.dir); assert.equal(seen.mode, "meta")
  assert.deepEqual(seen.gitship, { commit: "on", branch: "off", push: "auto", pr: "auto", prBase: "main" })
  assert.equal(out.delivery.committed, true); assert.equal(out.delivery.pushed, true); assert.deepEqual(out.delivery.files, ["health.js"])
  // the branch really reached the "remote", with the commit on it
  const remoteLog = execFileSync("git", ["--git-dir", bare, "log", "--format=%s", out.branch], { encoding: "utf8" })
  assert.match(remoteLog, /^forge: add a health module/)
  assert.equal(execFileSync("git", ["--git-dir", bare, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), "base", "main is untouched")
})
await t("runOnRepo without --pr: the commit stays on the local branch", async () => {
  const runTask = async ({ task, config, onEvent }) => {
    fs.writeFileSync(path.join(process.cwd(), "b.js"), "1\n")
    const ship = await maybeShip({ root: process.cwd(), config, taskId: "t-2", runId: "r-2", objective: task, changedFiles: ["b.js"], verificationStatus: "PASSED" })
    onEvent({ type: "GITSHIP_COMMITTED", sha: ship.sha, files: ship.files, pushed: ship.pushed, text: ship.reason })
    return { res: { taskStatus: "COMPLETED" } }
  }
  const out = await R.runOnRepo({ spec: "acme/app", task: "add b", home, runTask, gh })
  assert.equal(out.delivery.committed, true); assert.equal(out.delivery.pushed, false)
  assert.throws(() => execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", out.branch], { stdio: "ignore" }), "not pushed")
})
await t("an unverified completion is never delivered", async () => {
  const runTask = async ({ task, config, onEvent }) => {
    fs.writeFileSync(path.join(process.cwd(), "c.js"), "1\n")
    const ship = await maybeShip({ root: process.cwd(), config, taskId: "t-3", objective: task, changedFiles: ["c.js"], verificationStatus: "COMPLETED_UNVERIFIED" })
    onEvent({ type: "GITSHIP_SKIPPED", reason: ship.reason })
    return { res: { taskStatus: "COMPLETED_UNVERIFIED" } }
  }
  const out = await R.runOnRepo({ spec: "acme/app", task: "add c", home, pr: true, runTask, gh })
  assert.equal(out.delivery.committed, false); assert.match(out.delivery.reason, /unverified completion — verification is COMPLETED_UNVERIFIED/)
  sh(out.dir, "checkout", "-q", "--", "."); fs.rmSync(path.join(out.dir, "c.js"), { force: true })
})
await t("gitship names head and base for gh pr create", () => {
  const src = fs.readFileSync(new URL("../gitship.js", import.meta.url), "utf8")
  assert.match(src, /\["pr", "create", "--title", title, "--body-file", prPath, \.\.\.\(headBranch && headBranch !== "HEAD" \? \["--head", headBranch\] : \[\]\), \.\.\.\(prBase \? \["--base", prBase\] : \[\]\)\]/)
})
await t("forge run is wired in forge.js", () => {
  const src = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  assert.match(src, /case "run": \{/); assert.match(src, /runOnRepo\(\{/)
})

console.log(`\n== reporun suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
