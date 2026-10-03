/**
 * Phase 8 — GitHub repo tasks everywhere: `forge queue add --repo`, repo
 * items in `forge queue run` (also --parallel), `forge run --result-json`,
 * and repo runs from `forge web`. Zero network.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-repoq-"))
process.env.FORGE_HOME = path.join(tmp, "home")
const Q = await import("../taskqueue.js")
const { createWebServer } = await import("../web.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
let fileN = 0
const fresh = () => path.join(tmp, `q${++fileN}`, "queue.json")
const done = (status = "COMPLETED", extra = {}) => async (item, { resultFile }) => { fs.writeFileSync(resultFile, JSON.stringify({ status, ...extra })); return { exitCode: 0 } }

await t("queue add --repo: owner/name, URLs and ssh are normalised; junk refused", () => {
  const file = fresh()
  assert.equal(Q.addItem("a", { file, repo: "acme/app" }).repo, "acme/app")
  assert.equal(Q.addItem("b", { file, repo: "https://github.com/acme/app.git" }).repo, "acme/app")
  assert.equal(Q.addItem("c", { file, repo: "git@github.com:acme/app.git", base: "dev", pr: true }).pr, true)
  for (const bad of ["acme", "../x/y", "https://gitlab.com/a/b", "a b/c"]) assert.throws(() => Q.addItem("x", { file, repo: bad }), /not a GitHub repository/, bad)
  assert.throws(() => Q.addItem("x", { file, repo: "acme/app", base: "bad base" }), /bad base branch/)
  const plain = Q.addItem("d", { file })
  assert.equal("repo" in plain, false, "a plain item carries no repo fields")
})
await t("a repo item runs as `forge run --repo … --result-json`", async () => {
  const stub = path.join(tmp, "stub.js")
  fs.writeFileSync(stub, `const a = process.argv.slice(2); require("fs").writeFileSync(a[a.indexOf("--result-json") + 1], JSON.stringify({ status: "COMPLETED", reason: a.join(" ") }))`)
  const rf = path.join(tmp, "r.json")
  await Q.spawnAgentItem({ task: "add health", repo: "acme/app", base: "dev", pr: true }, { forgeJs: stub, resultFile: rf, stdio: "ignore" })
  assert.equal(JSON.parse(fs.readFileSync(rf, "utf8")).reason, `run --repo acme/app --base dev --pr --result-json ${rf} add health`)
  await Q.spawnAgentItem({ task: "x", repo: "acme/app" }, { forgeJs: stub, resultFile: rf, stdio: "ignore" })
  assert.equal(JSON.parse(fs.readFileSync(rf, "utf8")).reason, `run --repo acme/app --result-json ${rf} x`)
})
await t("the repo result reaches the item: status, branch, PR in the note", async () => {
  const file = fresh()
  Q.addItem("add health", { file, repo: "acme/app", pr: true })
  const res = await Q.runQueue({ file, runItem: done("COMPLETED", { repo: { branch: "forge/add-health-abc123", committed: true, pushed: true, pr: "https://github.com/acme/app/pull/7" } }) })
  assert.equal(res.ran[0].status, "COMPLETED")
  assert.equal(res.ran[0].result.repo.pr, "https://github.com/acme/app/pull/7")
  assert.match(Q.readQueue({ file }).items[0].note, /branch forge\/add-health-abc123 · PR https:\/\/github\.com\/acme\/app\/pull\/7/)
})
await t("nothing delivered is said in the note, with the reason", async () => {
  const file = fresh()
  Q.addItem("x", { file, repo: "acme/app" })
  await Q.runQueue({ file, runItem: done("COMPLETED_UNVERIFIED", { repo: { branch: "forge/x-1", committed: false, reason: "verification is PENDING" } }) })
  assert.match(Q.readQueue({ file }).items[0].note, /nothing delivered: verification is PENDING/)
})
await t("--parallel: two items on the same repo never run at once; other repos do", async () => {
  const file = fresh()
  Q.addItem("one", { file, repo: "acme/app" }); Q.addItem("two", { file, repo: "acme/app" }); Q.addItem("three", { file, repo: "acme/other" })
  const live = new Map(); let overlapSame = false, peak = 0, running = 0
  const iso = { check: async () => { throw new Error("checkout check must be skipped when every item is a repo item") }, prepare: async () => { throw new Error("repo items never get a worktree") }, finish: async () => ({}) }
  const res = await Q.runQueue({ file, parallel: 3, isolation: iso, runItem: async (item, ctx) => {
    running++; peak = Math.max(peak, running)
    if (live.get(item.repo)) overlapSame = true
    live.set(item.repo, true); await new Promise((r) => setTimeout(r, 50)); live.set(item.repo, false); running--
    return done()(item, ctx)
  } })
  assert.equal(res.refused, undefined)
  assert.equal(overlapSame, false); assert.equal(peak, 2, "acme/app and acme/other ran side by side")
  assert.deepEqual(res.ran.map((i) => i.status), ["COMPLETED", "COMPLETED", "COMPLETED"])
  assert.ok(res.ran.every((i) => i.result.merge === undefined), "no worktree merge for repo items")
})
await t("--parallel with a mix: the checkout check still runs for local items", async () => {
  const file = fresh()
  Q.addItem("local", { file }); Q.addItem("remote", { file, repo: "acme/app" })
  const res = await Q.runQueue({ file, parallel: 2, isolation: { check: async () => ({ ok: false, reason: "dirty" }) }, runItem: done() })
  assert.equal(res.refused, "dirty")
})
await t("forge run writes --result-json; forge queue add takes --repo/--base/--pr", () => {
  const src = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  assert.match(src, /writeAgentResult\(resultFile, \{\s*status: String\(out\.res\?\.taskStatus \?\? "COMPLETED"\)/)
  assert.match(src, /repo: \{ slug: spec, dir: out\.dir, branch: out\.branch, base: out\.base, committed:/)
  assert.match(src, /Q\.addItem\(task, \{ mode, repo: typeof flags\.repo === "string" \? flags\.repo : null, base: typeof flags\.base === "string" \? flags\.base : null, pr: flags\.pr === true \}\)/)
  assert.match(src, /runRepo: async \(\{ task, repo, base, pr, onEvent, signal, onPrepared \}\) =>/)
  assert.match(src, /const projQueue = Q\.queuePath\(projRoot\)/)
})

// --- forge web: repo runs ------------------------------------------------
function req(port, method, p, body = null, token = "tok-tok-tok-tok-tok-tok") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, "x-forge-token": token, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d) } catch { } resolve({ status: res.statusCode, json: j }) })
    })
    r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end()
  })
}
const TOKEN = "tok-tok-tok-tok-tok-tok"
// a "clone" with origin/main and a work branch carrying one commit + one uncommitted change
const clone = path.join(tmp, "clone"); fs.mkdirSync(clone)
const g = (...a) => execFileSync("git", a, { cwd: clone, stdio: "ignore" })
g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
fs.writeFileSync(path.join(clone, "app.js"), "v1\n"); g("add", "-A"); g("commit", "-qm", "base")
g("update-ref", "refs/remotes/origin/main", "HEAD"); g("checkout", "-qb", "forge/work")
fs.writeFileSync(path.join(clone, "health.js"), "ok\n"); g("add", "-A"); g("commit", "-qm", "forge: add health")
fs.writeFileSync(path.join(clone, "app.js"), "v2\n")
const repoCalls = []
let release
const runRepo = async (o) => {
  repoCalls.push(o)
  o.onPrepared({ dir: clone, branch: "forge/work", base: "main" })
  await new Promise((r) => { release = r })
  return { ok: true, dir: clone, branch: "forge/work", base: "main", res: { taskStatus: "COMPLETED", text: "done" }, delivery: { committed: true, sha: "abc", pushed: true, pr: "https://github.com/acme/app/pull/9" } }
}
const web = createWebServer({ cwd: tmp, run: async () => ({ res: { taskStatus: "COMPLETED" } }), runRepo, token: TOKEN })
await web.listen(0)
const port = web.port
await t("web: POST /run with a repo calls runRepo on the orchestrator, with the PR consent", async () => {
  assert.equal((await req(port, "POST", "/run", { task: "add health", repo: "acme/app", base: "main", pr: true })).status, 202)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(repoCalls[0].repo, "acme/app"); assert.equal(repoCalls[0].base, "main"); assert.equal(repoCalls[0].pr, true)
  const st = (await req(port, "GET", `/state?t=${TOKEN}`)).json
  assert.equal(st.run.mode, "meta"); assert.equal(st.run.repo.slug, "acme/app"); assert.equal(st.run.repo.branch, "forge/work")
})
await t("web: /diff shows the clone's work branch since origin/<base> — committed and not", async () => {
  const d = (await req(port, "GET", `/diff?t=${TOKEN}`)).json
  assert.equal(d.where, clone)
  assert.deepEqual(d.files.map((f) => f.path).sort(), ["app.js", "health.js"])
  assert.match(d.diff, /\+ok/); assert.match(d.diff, /-v1\n\+v2/)
})
await t("web: the run ends with branch, commit and PR recorded", async () => {
  release()
  await new Promise((r) => setTimeout(r, 80))
  const st = (await req(port, "GET", `/state?t=${TOKEN}`)).json
  assert.equal(st.run.status, "COMPLETED"); assert.equal(st.run.repo.delivery.pr, "https://github.com/acme/app/pull/9")
})
await t("web: a bad repo or base is 400; no runRepo is 404", async () => {
  assert.equal((await req(port, "POST", "/run", { task: "x", repo: "../etc/x" })).status, 400)
  assert.equal((await req(port, "POST", "/run", { task: "x", repo: "acme/app", base: "a b" })).status, 400)
  const bare = createWebServer({ cwd: tmp, run: async () => ({}), token: TOKEN }); await bare.listen(0)
  assert.equal((await req(bare.port, "POST", "/run", { task: "x", repo: "acme/app" })).status, 404)
  await bare.close()
})
await t("web: a failed repo preparation is an ERROR with its reason", async () => {
  const w2 = createWebServer({ cwd: tmp, run: async () => ({}), runRepo: async () => ({ ok: false, reason: "the clone has uncommitted changes" }), token: TOKEN }); await w2.listen(0)
  await req(w2.port, "POST", "/run", { task: "x", repo: "acme/app" })
  await new Promise((r) => setTimeout(r, 60))
  const st = (await req(w2.port, "GET", `/state?t=${TOKEN}`)).json
  assert.equal(st.run.status, "ERROR"); assert.match(st.run.error, /uncommitted changes/)
  await w2.close()
})
await web.close()

console.log(`\n== repo-everywhere suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
