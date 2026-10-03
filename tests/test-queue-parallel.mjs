/**
 * Phase 5 — `forge queue run --parallel N`: items in their own git
 * worktrees, merged back through one serialized lane. Uses REAL git in a
 * temp repo; the agent is a fake that writes files into its cwd.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-qpar-"))
process.env.FORGE_HOME = path.join(tmp, "home")
const Q = await import("../taskqueue.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
let repoN = 0
function repo(files = { "a.txt": "a\n", "b.txt": "b\n", "shared.txt": "one\ntwo\nthree\n" }) {
  const dir = path.join(tmp, `repo${++repoN}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t")
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c)
  fs.writeFileSync(path.join(dir, ".gitignore"), ".forge/\n")
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base")
  return dir
}
const qfile = (dir) => path.join(tmp, `q-${path.basename(dir)}.json`)
// fake agent: item.task is "write <file> <content>" (or "slow write …"); writes in its cwd
const writer = ({ status = () => "COMPLETED", seen = null, gate = null } = {}) => async (item, { resultFile, cwd }) => {
  seen?.push({ task: item.task, cwd })
  if (gate) await gate(item)
  const [, file, ...content] = item.task.replace(/^slow /, "").split(" ")
  fs.writeFileSync(path.join(cwd, file), content.join(" ") + "\n")
  fs.writeFileSync(resultFile, JSON.stringify({ status: status(item), exitCode: 0, elapsedMs: 5 }))
  return { exitCode: 0 }
}

await t("parallel items run at the same time, in worktrees, and all merge back", async () => {
  const dir = repo(), file = qfile(dir)
  for (const x of ["write a.txt A", "write b.txt B", "write c.txt C"]) Q.addItem(x, { file })
  let running = 0, peak = 0
  const gate = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 60)); running-- }
  const seen = []
  const res = await Q.runQueue({ file, root: dir, parallel: 3, runItem: writer({ seen, gate }) })
  assert.equal(res.parallel, 3); assert.equal(peak, 3, "three ran at once")
  assert.ok(seen.every((s) => s.cwd !== dir && s.cwd.includes(".forge")), "each ran in a worktree, never the checkout")
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "A\n")
  assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "B\n")
  assert.equal(fs.readFileSync(path.join(dir, "c.txt"), "utf8"), "C\n")
  const q = Q.readQueue({ file })
  assert.ok(q.items.every((i) => i.status === "COMPLETED" && i.result.merge.merge === "merged"))
  assert.equal(git(dir, "worktree", "list").trim().split("\n").length, 1, "every worktree removed")
})
await t("two items changing the same line: one merges, the other is CONFLICT with its patch kept", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("write shared.txt first", { file }); Q.addItem("write shared.txt second", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: writer() })
  const statuses = res.ran.map((i) => i.status).sort()
  assert.deepEqual(statuses, ["COMPLETED", "CONFLICT"])
  const bad = res.ran.find((i) => i.status === "CONFLICT")
  assert.ok(bad.result.merge.patch && fs.existsSync(bad.result.merge.patch))
  assert.match(bad.note, /did not merge/)
  const content = fs.readFileSync(path.join(dir, "shared.txt"), "utf8")
  assert.ok(content === "first\n" || content === "second\n", "exactly one change landed, never a mix")
})
await t("an item that did not complete keeps its patch and is not merged", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("write a.txt half", { file }); Q.addItem("write b.txt done", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: writer({ status: (i) => (i.task.includes("half") ? "INCOMPLETE" : "COMPLETED") }) })
  const half = res.ran.find((i) => i.task.includes("half"))
  assert.equal(half.status, "INCOMPLETE"); assert.equal(half.result.merge.merge, "held")
  assert.ok(fs.existsSync(half.result.merge.patch))
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "a\n", "not merged")
  assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "done\n")
})
await t("an item that changed nothing: no merge needed", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("noop", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: async (item, { resultFile }) => { fs.writeFileSync(resultFile, JSON.stringify({ status: "COMPLETED" })); return { exitCode: 0 } } })
  assert.equal(res.ran[0].result.merge.merge, "nothing")
})
await t("--parallel is refused on a dirty checkout, and nothing is claimed", async () => {
  const dir = repo(), file = qfile(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "local edit\n")
  Q.addItem("write b.txt B", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: writer() })
  assert.match(res.refused, /clean checkout — 1 uncommitted file\(s\) \(a\.txt\)/)
  assert.equal(Q.readQueue({ file }).items[0].status, "PENDING")
})
await t("--parallel is refused outside a git repository", async () => {
  const dir = path.join(tmp, "plain"); fs.mkdirSync(dir, { recursive: true })
  const file = path.join(tmp, "q-plain.json")
  Q.addItem("write a.txt A", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: writer() })
  assert.match(res.refused, /needs a git repository/)
})
await t("--parallel 1 is the sequential queue: runs in the checkout itself", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("write a.txt X", { file })
  const seen = []
  const res = await Q.runQueue({ file, root: dir, parallel: 1, runItem: async (item, ctx) => { seen.push(ctx.cwd); fs.writeFileSync(ctx.resultFile, JSON.stringify({ status: "COMPLETED" })); return { exitCode: 0 } } })
  assert.equal(seen[0], undefined, "no cwd override: the child runs where forge runs")
  assert.equal(res.ran[0].result.merge, undefined)
})
await t("--stop-on-fail stops starting new items; in-flight ones finish", async () => {
  const dir = repo(), file = qfile(dir)
  for (const x of ["write a.txt 1", "write b.txt 2", "write c.txt 3", "write d.txt 4"]) Q.addItem(x, { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, stopOnFail: true, runItem: writer({ status: (i) => (i.task.includes("a.txt") ? "INCOMPLETE" : "COMPLETED"), gate: async (i) => { if (!i.task.includes("a.txt")) await new Promise((r) => setTimeout(r, 40)) } }) })
  assert.match(res.stopped, /INCOMPLETE/)
  assert.ok(res.ran.length >= 2 && res.ran.length < 4, `ran ${res.ran.length}`)
  assert.ok(Q.readQueue({ file }).items.some((i) => i.status === "PENDING"))
})
await t("a failing worktree creation is FAILED for that item, others continue", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("write a.txt A", { file }); Q.addItem("write b.txt B", { file })
  const real = Q.worktreeIsolation({ root: dir })
  let first = true
  const iso = { ...real, prepare: async (item) => { if (first) { first = false; throw new Error("disk full") } return real.prepare(item) } }
  const res = await Q.runQueue({ file, root: dir, parallel: 2, isolation: iso, runItem: writer() })
  assert.deepEqual(res.ran.map((i) => i.status).sort(), ["COMPLETED", "FAILED"])
  assert.match(res.ran.find((i) => i.status === "FAILED").result.error, /disk full/)
})
await t("a project that gitignores .forge (and an agent that writes .forge state) still merges", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("write a.txt state", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 2, runItem: async (item, ctx) => {
    fs.mkdirSync(path.join(ctx.cwd, ".forge"), { recursive: true }); fs.writeFileSync(path.join(ctx.cwd, ".forge", "x.json"), "{}")
    return writer()(item, ctx)
  } })
  assert.equal(res.ran[0].status, "COMPLETED", JSON.stringify(res.ran[0].result?.merge))
  assert.equal(res.ran[0].result.merge.merge, "merged"); assert.deepEqual(res.ran[0].result.merge.files, ["a.txt"])
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "state\n")
})
await t("--parallel is clamped to 1..8", async () => {
  const dir = repo(), file = qfile(dir)
  Q.addItem("noop", { file })
  const res = await Q.runQueue({ file, root: dir, parallel: 99, runItem: async (item, { resultFile }) => { fs.writeFileSync(resultFile, JSON.stringify({ status: "COMPLETED" })); return { exitCode: 0 } } })
  assert.equal(res.parallel, Q.MAX_PARALLEL)
})
await t("forge.js passes --parallel to the queue", () => {
  const src = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  assert.match(src, /stopOnFail: flags\["stop-on-fail"\] === true, max, parallel, signal: ac\.signal,/)
  assert.match(src, /--parallel must be a whole number from 1 to/)
})

console.log(`\n== queue-parallel suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
