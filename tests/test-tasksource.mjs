#!/usr/bin/env node
/**
 * A task that names another repository must not edit the launch checkout.
 * Git remotes are local bare repos via url.insteadOf — no network.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tasksource-"))
const home = path.join(tmp, "home")
process.env.FORGE_HOME = home
delete process.env.FORGE_SOURCE_LOCK
delete process.env.FORGE_BOUND_ROOT
const MOD = await import("../sourceresolve.js")
const { safePath, execTool } = await import("../tools.js")

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const bare = path.join(tmp, "remote", "widget.git")
const seed = path.join(tmp, "seed")
fs.mkdirSync(seed, { recursive: true })
fs.mkdirSync(path.dirname(bare), { recursive: true })
sh(seed, "init", "-q", "-b", "main")
sh(seed, "config", "user.email", "t@t")
sh(seed, "config", "user.name", "t")
fs.mkdirSync(path.join(seed, "pkg"))
fs.writeFileSync(path.join(seed, "app.js"), "export const v = 1\n")
fs.writeFileSync(path.join(seed, "pkg", "readme.txt"), "pkg\n")
fs.writeFileSync(path.join(seed, ".gitignore"), ".forge/\n")
sh(seed, "add", "-A")
sh(seed, "commit", "-qm", "base")
sh(seed, "checkout", "-qb", "dev")
fs.writeFileSync(path.join(seed, "dev.txt"), "dev\n")
sh(seed, "add", "-A")
sh(seed, "commit", "-qm", "dev")
sh(seed, "checkout", "-q", "main")
execFileSync("git", ["clone", "-q", "--bare", seed, bare])

const alfa = path.join(tmp, "alfa")
fs.mkdirSync(alfa)
sh(alfa, "init", "-q", "-b", "main")
sh(alfa, "config", "user.email", "t@t")
sh(alfa, "config", "user.name", "t")
fs.writeFileSync(path.join(alfa, "KEEP.txt"), "alfa\n")
sh(alfa, "add", "-A")
sh(alfa, "commit", "-qm", "alfa")
sh(alfa, "remote", "add", "origin", "https://github.com/acme/alfa.git")

const already = path.join(tmp, "already")
execFileSync("git", ["clone", "-q", bare, already])
sh(already, "remote", "set-url", "origin", "https://github.com/acme/widget.git")
const wt = path.join(tmp, "wt")
sh(already, "worktree", "add", "-q", "-b", "wt-main", wt, "main")

const missingRemote = path.join(tmp, "missing-remote")
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
  GIT_CONFIG_VALUE_0: "https://github.com/acme/widget.git",
  GIT_CONFIG_KEY_1: `url.${missingRemote}.insteadOf`,
  GIT_CONFIG_VALUE_1: "https://github.com/acme/missing.git",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_VALUE_2: "t@t",
  GIT_CONFIG_KEY_3: "user.name",
  GIT_CONFIG_VALUE_3: "t",
  GIT_TERMINAL_PROMPT: "0",
})

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const keep = () => fs.readFileSync(path.join(alfa, "KEEP.txt"), "utf8")
async function fromAlfa(task, extra = {}) {
  process.chdir(alfa)
  delete process.env.FORGE_SOURCE_LOCK
  const r = await MOD.adoptInvocationSource({ task, cwd: alfa, ...extra })
  return r
}

console.log("== task source: external repository, not the launch checkout ==")

await t("a GitHub page is a git repository, a zip URL stays a zip", () => {
  const page = MOD.resolveSource("https://github.com/acme/widget", { cwd: alfa })
  assert.equal(page.sourceType, "git-url")
  assert.equal(page.extract.git, "https://github.com/acme/widget.git")
  assert.equal(MOD.resolveSource("https://example.com/p.zip", { cwd: alfa }).sourceType, "url")
  assert.equal(MOD.resolveSource("https://example.com/repo.git", { cwd: alfa }).sourceType, "git-url")
  assert.equal(MOD.resolveSource("https://github.com/acme/widget/archive/refs/heads/main.zip", { cwd: alfa }).sourceType, "url")
})

await t("explicit --source wins over a repository named in the task", async () => {
  const folder = path.join(tmp, "explicit")
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, "local.txt"), "chosen\n")
  const r = await fromAlfa("Update https://github.com/acme/missing", { explicit: folder })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, "explicit")
  assert.equal(path.resolve(r.localPath), path.resolve(folder))
  assert.equal(keep(), "alfa\n")
})

await t("two repositories is a question, and the launch checkout is not touched", async () => {
  const r = await fromAlfa("Update https://github.com/acme/widget and fix https://github.com/acme/other")
  assert.equal(r.ok, false)
  assert.equal(r.action, "ask")
  assert.equal(process.cwd(), alfa)
  assert.equal(r.changed, false)
  assert.equal(keep(), "alfa\n")
})

await t("a repository mentioned but not named is not guessed", async () => {
  const r = await fromAlfa("Please update the GitHub repository")
  assert.equal(r.ok, false)
  assert.equal(r.action, "ask")
  assert.match(r.error, /does not identify/)
  assert.equal(process.cwd(), alfa)
})

await t("no repository in the task stays on the current checkout", async () => {
  const r = await fromAlfa("Fix the parser in src/parser.js")
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, "cwd")
  assert.equal(path.resolve(r.localPath), alfa)
  assert.equal(process.cwd(), alfa)
})

await t("a bare URL is not assumed to be the thing to change", async () => {
  const planned = MOD.resolveSource("https://github.com/acme/widget", { cwd: alfa }).extract.dest
  const r = await fromAlfa("https://github.com/acme/widget")
  assert.equal(r.ok, false)
  assert.equal(r.action, "ask")
  assert.equal(fs.existsSync(planned), false)
  assert.equal(process.cwd(), alfa)
})

await t("embedded credentials are refused and never recorded", async () => {
  const secret = "ghp_SuperSecretTokenValue99"
  const r = await fromAlfa(`Update https://user:${secret}@github.com/acme/widget`)
  assert.equal(r.ok, false)
  assert.equal(r.action, "ask")
  assert.equal(JSON.stringify(r).includes(secret), false)
  const log = fs.existsSync(path.join(home, "source-events.jsonl")) ? fs.readFileSync(path.join(home, "source-events.jsonl"), "utf8") : ""
  assert.equal(log.includes(secret), false)
  assert.equal(process.cwd(), alfa)
})

await t("an unsafe subdirectory is not checked out", async () => {
  const r = await fromAlfa("Update https://github.com/acme/widget/tree/main/../../etc")
  assert.equal(r.ok, false)
  assert.equal(process.cwd(), alfa)
  assert.equal(keep(), "alfa\n")
})

await t("a non-empty unrelated destination is not overwritten", async () => {
  const dest = MOD.resolveSource("https://github.com/acme/other", { cwd: alfa }).extract.dest
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, "mine.txt"), "keep-me\n")
  const r = await fromAlfa("Update https://github.com/acme/other")
  assert.equal(r.ok, false, "expected refusal")
  assert.match(r.error, /not empty|refusing/)
  assert.equal(fs.readFileSync(path.join(dest, "mine.txt"), "utf8"), "keep-me\n")
  assert.equal(process.cwd(), alfa)
})

await t("a symlink destination is not cloned through", async () => {
  const dest = MOD.resolveSource("https://github.com/acme/linked", { cwd: alfa }).extract.dest
  const outside = path.join(tmp, "outside-link")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "safe.txt"), "safe\n")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.symlinkSync(outside, dest)
  const r = await fromAlfa("Update https://github.com/acme/linked")
  assert.equal(r.ok, false)
  assert.equal(fs.readFileSync(path.join(outside, "safe.txt"), "utf8"), "safe\n")
  assert.equal(fs.readdirSync(outside).includes(".git"), false)
  assert.equal(process.cwd(), alfa)
})

await t("the current checkout is reused when it is already the requested repository", async () => {
  process.chdir(already)
  delete process.env.FORGE_SOURCE_LOCK
  const planned = MOD.resolveSource("https://github.com/acme/widget", { cwd: already }).extract.dest
  const r = await MOD.adoptInvocationSource({ task: "Update https://github.com/acme/widget", cwd: already })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, "reuse-workspace")
  assert.equal(path.resolve(r.localPath), already)
  assert.equal(fs.existsSync(path.join(planned, ".git")), false)
  assert.equal(keep(), "alfa\n")
})

await t("a worktree of the requested repository is reused", async () => {
  process.chdir(wt)
  delete process.env.FORGE_SOURCE_LOCK
  const r = await MOD.adoptInvocationSource({ task: "Fix https://github.com/acme/widget", cwd: wt })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, "reuse-workspace")
  assert.equal(path.resolve(r.localPath), wt)
  assert.equal(keep(), "alfa\n")
})

await t("a clone failure does not fall back to the launch checkout", async () => {
  const r = await fromAlfa("Update https://github.com/acme/missing")
  assert.equal(r.ok, false)
  assert.match(r.error, /clone failed|fetch failed|not a git|unable to access|does not exist/i)
  assert.equal(r.fallback, false)
  assert.equal(process.cwd(), alfa)
  assert.equal(keep(), "alfa\n")
})

let cloneDir = null
await t("Update https://github.com/acme/widget leaves Alfa and lands in an isolated clone", async () => {
  const r = await fromAlfa("Update https://github.com/acme/widget so it exports health")
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, "target")
  assert.equal(r.reused, false)
  assert.equal(r.canonical, "https://github.com/acme/widget")
  assert.notEqual(path.resolve(r.localPath), alfa)
  assert.equal(process.cwd(), path.resolve(r.localPath))
  assert.equal(sh(r.localPath, "config", "--get", "remote.origin.url").trim(), "https://github.com/acme/widget.git")
  assert.match(r.head, /^[0-9a-f]{7,40}$/)
  assert.equal(r.previousCwd, alfa)
  assert.equal(fs.existsSync(path.join(alfa, "health.js")), false)
  assert.equal(keep(), "alfa\n")
  const log = fs.readFileSync(path.join(home, "source-events.jsonl"), "utf8")
  const last = JSON.parse(log.trim().split("\n").at(-1))
  assert.equal(last.type, "SOURCE_RESOLVED")
  assert.equal(last.canonical, "https://github.com/acme/widget")
  assert.equal(last.previousCwd, alfa)
  assert.equal(last.localPath, path.resolve(r.localPath))
  assert.equal(last.head, r.head)
  assert.equal(last.reused, false)
  cloneDir = path.resolve(r.localPath)
})

await t("file tools write only inside the resolved repository", async () => {
  assert.ok(cloneDir)
  process.chdir(cloneDir)
  const ctx = { cwd: cloneDir, root: cloneDir, runId: "tasksource", maxToolOutput: 4000, timeoutSec: 30 }
  const wrote = await execTool(ctx, "write_file", { path: "health.js", content: "export const ok = true\n" })
  assert.match(String(wrote), /^OK wrote/)
  assert.equal(fs.readFileSync(path.join(cloneDir, "health.js"), "utf8"), "export const ok = true\n")
  assert.equal(fs.existsSync(path.join(alfa, "health.js")), false)
  const blocked = await execTool(ctx, "write_file", { path: path.join(alfa, "PWNED.txt"), content: "nope\n" })
  assert.match(String(blocked), /BLOCKED/)
  assert.equal(fs.existsSync(path.join(alfa, "PWNED.txt")), false)
  const shelled = await execTool(ctx, "bash", { command: "echo nope >> /workspace/tasksource-pwned.txt" })
  assert.match(String(shelled), /BLOCKED/)
  assert.equal(fs.existsSync("/workspace/tasksource-pwned.txt"), false)
  const escaped = safePath(ctx, "../KEEP.txt", { write: true })
  assert.equal(escaped.ok, false)
})

await t("owner/name is the same repository and is not the launch checkout", async () => {
  const r = await fromAlfa("Update acme/widget to add a health check")
  assert.equal(r.ok, true, r.error)
  assert.equal(r.canonical, "https://github.com/acme/widget")
  assert.equal(path.resolve(r.localPath), cloneDir)
  assert.notEqual(path.resolve(r.localPath), alfa)
  assert.equal(keep(), "alfa\n")
})

await t("uncommitted work in the clone is not reset", async () => {
  fs.writeFileSync(path.join(cloneDir, "app.js"), "local work\n")
  const r = await fromAlfa("Update https://github.com/acme/widget")
  assert.equal(r.ok, true, r.error)
  assert.equal(r.reused, true)
  assert.equal(fs.readFileSync(path.join(cloneDir, "app.js"), "utf8"), "local work\n")
  assert.equal(keep(), "alfa\n")
})

await t("a tree URL checks out that branch and subdirectory only", async () => {
  const r = await fromAlfa("Implement https://github.com/acme/widget/tree/dev/pkg")
  assert.equal(r.ok, true, r.error)
  assert.equal(r.branch, "dev")
  assert.equal(r.subdir, "pkg")
  assert.equal(path.basename(r.localPath), "pkg")
  assert.equal(fs.readFileSync(path.join(r.localPath, "readme.txt"), "utf8"), "pkg\n")
  assert.equal(sh(path.dirname(r.localPath), "branch", "--show-current").trim(), "dev")
  assert.notEqual(path.resolve(r.localPath), alfa)
  const ctx = { cwd: r.localPath, root: r.localPath, runId: "tasksource-sub", maxToolOutput: 4000, timeoutSec: 30 }
  const blocked = safePath(ctx, "../dev.txt", { write: true })
  assert.equal(blocked.ok, false)
  assert.equal(keep(), "alfa\n")
})

console.log(`\n== tasksource: ${n} passed, ${process.exitCode ? "failed" : "0 failed"} ==`)
