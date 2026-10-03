/**
 * Phase 6 — `forge web` (web.js): the local workspace page and its server.
 * Real HTTP on 127.0.0.1, a fake run function, a real git repo for /diff.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-web-"))
process.env.FORGE_HOME = path.join(tmp, "home")
const { createWebServer, applyEvent, freshRunState, pageHtml } = await import("../web.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
function req(port, method, p, { headers = {}, body = null, host = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: host ?? `127.0.0.1:${port}`, ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => { let json = null; try { json = JSON.parse(data) } catch { } resolve({ status: res.statusCode, body: data, json, headers: res.headers }) })
    })
    r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end()
  })
}
const TOKEN = "test-token-abcdefghijklmnop"
const H = { "x-forge-token": TOKEN }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(25) } throw new Error("timed out waiting") }

await t("applyEvent builds the plan from controller events", () => {
  const s = freshRunState("x", "meta")
  applyEvent(s, { type: "DAG_BUILT", graph: { nodes: [{ id: "a", title: "Inspect", role: "researcher" }, { id: "b", objective: "Patch", role: "coder" }] } })
  applyEvent(s, { type: "DAG_NODE_STARTED", nodeId: "a" })
  applyEvent(s, { type: "CREW_MODEL_ROUTED", nodeId: "a", provider: "p", model: "fast" })
  applyEvent(s, { type: "DAG_NODE_COMPLETED", nodeId: "a" })
  applyEvent(s, { type: "WORKER_STARTED", nodeId: "b" })
  applyEvent(s, { type: "WORKER_COMPLETED", nodeId: "b", ok: false })
  applyEvent(s, { type: "MODEL_SELECTED", provider: "p", model: "big" })
  assert.deepEqual(s.plan.map((x) => [x.id, x.title, x.status, x.model]), [["a", "Inspect", "completed", "p/fast"], ["b", "Patch", "failed", null]])
  assert.equal(s.model, "p/big")
})
await t("applyEvent tracks tool activity, pairing results by who ran them", () => {
  const s = freshRunState()
  applyEvent(s, { type: "tool_start", name: "read_file", args: "{\"path\":\"a.js\"}", step: 1 })
  applyEvent(s, { type: "tool_start", name: "grep_files", sub: "worker:n2" })
  applyEvent(s, { type: "tool_result", result: "ok", ms: 12 })
  applyEvent(s, { type: "tool_result", result: "ERROR: nothing", sub: "worker:n2" })
  applyEvent(s, { type: "tool_start", name: "bash", step: 2 })
  applyEvent(s, { type: "tool_result", result: "ERROR: boom" })
  assert.deepEqual(s.activity.map((a) => [a.name, a.who, a.ok]), [["read_file", null, true], ["grep_files", "worker:n2", false], ["bash", null, false]])
})

// a git repo the server diffs
const repo = path.join(tmp, "repo"); fs.mkdirSync(repo)
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" })
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t")
fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); git("add", "-A"); git("commit", "-qm", "base")

let release = null
const runs = []
const run = async ({ task, mode, onEvent, signal }) => {
  runs.push({ task, mode })
  onEvent({ type: "DAG_BUILT", graph: { nodes: [{ id: "n1", title: "Do it", role: "coder" }] } })
  onEvent({ type: "DAG_NODE_STARTED", nodeId: "n1" })
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n")
  fs.writeFileSync(path.join(repo, "new.txt"), "fresh\n")
  await new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))) })
  onEvent({ type: "DAG_NODE_COMPLETED", nodeId: "n1" })
  return { mode: "meta", why: "test", res: { taskStatus: "COMPLETED", text: "Changed a.txt." } }
}
const qItems = []
const queue = { list: () => ({ items: qItems }), add: (task, { mode }) => { const it = { id: String(qItems.length + 1), task, mode, status: "PENDING" }; qItems.push(it); return it }, runAll: async ({ parallel, onItem }) => { for (const it of qItems) { it.status = "COMPLETED"; onItem({ phase: "end", item: it }) } return { parallel } } }
const web = createWebServer({ cwd: repo, info: { provider: "p", model: "m" }, run, queue, token: TOKEN })
await web.listen(0)
const port = web.port

await t("listens on 127.0.0.1 only, and the URL carries the token", () => {
  assert.equal(web.url, `http://127.0.0.1:${port}/?t=${TOKEN}`)
})
await t("no token → 401; wrong token → 401", async () => {
  assert.equal((await req(port, "GET", "/state")).status, 401)
  assert.equal((await req(port, "GET", "/state?t=nope")).status, 401)
})
await t("a foreign Host header is refused (DNS rebinding)", async () => {
  assert.equal((await req(port, "GET", `/state?t=${TOKEN}`, { host: "evil.example:80" })).status, 403)
  assert.equal((await req(port, "GET", `/state?t=${TOKEN}`, { host: `localhost:${port}` })).status, 200)
})
await t("a POST needs the header token, and a foreign Origin is refused", async () => {
  assert.equal((await req(port, "POST", `/run?t=${TOKEN}`, { body: { task: "x" } })).status, 401)
  assert.equal((await req(port, "POST", "/run", { headers: { ...H, origin: "https://evil.example" }, body: { task: "x" } })).status, 403)
})
await t("the page is self-contained (no external requests) and embeds the token", async () => {
  const r = await req(port, "GET", `/?t=${TOKEN}`)
  assert.equal(r.status, 200); assert.match(r.headers["content-type"], /text\/html/)
  assert.ok(r.body.includes(JSON.stringify(TOKEN)))
  assert.doesNotMatch(r.body, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!127\.0\.0\.1)/)
  assert.ok(pageHtml({ token: "z" }).includes("prefers-color-scheme:dark"))
})
await t("POST /run starts the task; the plan and state are live; a second run is 409", async () => {
  const r = await req(port, "POST", "/run", { headers: H, body: { task: "change a.txt", mode: "meta" } })
  assert.equal(r.status, 202)
  const st = await until(async () => { const s = (await req(port, "GET", `/state?t=${TOKEN}`)).json; return s.run?.plan?.length ? s : null })
  assert.equal(st.run.task, "change a.txt"); assert.equal(st.run.plan[0].status, "running"); assert.equal(st.run.endedAt, null)
  assert.equal((await req(port, "POST", "/run", { headers: H, body: { task: "again" } })).status, 409)
  assert.deepEqual(runs[0], { task: "change a.txt", mode: "meta" })
})
await t("GET /diff shows changed and new files with their diff", async () => {
  const d = (await req(port, "GET", `/diff?t=${TOKEN}`)).json
  assert.equal(d.git, true)
  assert.deepEqual(d.files.map((f) => [f.status, f.path]).sort(), [["??", "new.txt"], ["M", "a.txt"]])
  assert.match(d.diff, /-one\n\+two/); assert.match(d.diff, /\+fresh/)
})
await t("the run ends with its answer", async () => {
  release()
  const st = await until(async () => { const s = (await req(port, "GET", `/state?t=${TOKEN}`)).json; return s.run?.endedAt ? s : null })
  assert.equal(st.run.status, "COMPLETED"); assert.equal(st.run.answer, "Changed a.txt."); assert.equal(st.run.plan[0].status, "completed")
})
await t("POST /stop aborts a running task", async () => {
  await req(port, "POST", "/run", { headers: H, body: { task: "long one" } })
  await until(async () => (await req(port, "GET", `/state?t=${TOKEN}`)).json.run?.task === "long one")
  assert.equal((await req(port, "POST", "/stop", { headers: H })).status, 200)
  const st = await until(async () => { const s = (await req(port, "GET", `/state?t=${TOKEN}`)).json; return s.run?.endedAt ? s : null })
  assert.equal(st.run.status, "ABORTED")
  assert.equal(st.run.plan[0].status, "stopped", "a node cut off by the stop is frozen, not left running")
  assert.equal((await req(port, "POST", "/stop", { headers: H })).status, 409)
})
await t("SSE /events streams the run's events", async () => {
  const got = []
  const sse = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: `/events?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.on("data", (c) => got.push(String(c))); resolve({ r, res }) })
    r.end()
  })
  await until(() => got.join("").includes("web_hello"))
  await req(port, "POST", "/run", { headers: H, body: { task: "streamed" } })
  await until(() => got.join("").includes("DAG_NODE_STARTED"))
  release()
  await until(() => got.join("").includes("web_run_end"))
  sse.r.destroy()
})
await t("queue: add and run through the page's API", async () => {
  assert.equal((await req(port, "POST", "/queue", { headers: H, body: { task: "queued one", mode: "single" } })).status, 201)
  assert.equal(qItems[0].mode, "single")
  assert.equal((await req(port, "POST", "/queue/run", { headers: H, body: { parallel: 3 } })).status, 202)
  await until(async () => !(await req(port, "GET", `/state?t=${TOKEN}`)).json.queueRunning)
  assert.equal(qItems[0].status, "COMPLETED")
})
await t("bad input is a 400, unknown paths 404", async () => {
  assert.equal((await req(port, "POST", "/run", { headers: H, body: { task: "  " } })).status, 400)
  assert.equal((await req(port, "GET", `/nope?t=${TOKEN}`)).status, 404)
})
await web.close()

await t("forge web is wired in forge.js", () => {
  const src = fs.readFileSync(new URL("../forge.js", import.meta.url), "utf8")
  assert.match(src, /case "web": \{/); assert.match(src, /createWebServer\(\{/)
})

console.log(`\n== web suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
