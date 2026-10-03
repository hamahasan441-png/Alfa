/**
 * taskqueue.js — line tasks up, run them one after another.
 * Zero network: the item runner is a fake that writes the agent's result
 * file, plus one real child-process run against `forge version`-free stubs.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-queue-"))
process.env.FORGE_HOME = path.join(tmp, "home")
const Q = await import("../taskqueue.js")
const here = path.dirname(fileURLToPath(import.meta.url))

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
let fileN = 0
const fresh = () => path.join(tmp, `q${++fileN}`, "queue.json")
// a fake agent: writes the result file the real `forge agent --result-json` writes
const fakeRunner = (statusOf, seen = []) => async (item, { resultFile }) => {
  seen.push(item)
  const status = statusOf(item)
  if (status === null) return { exitCode: 1 } // crashed: no result file
  fs.writeFileSync(resultFile, JSON.stringify({ status, reason: status === "INCOMPLETE" ? "budget" : null, exitCode: 0, elapsedMs: 1200, steps: 3, toolCalls: 2, wrote: true }))
  return { exitCode: 0 }
}

await t("add keeps order, positions and modes", () => {
  const file = fresh()
  const a = Q.addItem("first task", { file })
  const b = Q.addItem("second task", { file, mode: "single" })
  assert.equal(a.position, 1); assert.equal(b.position, 2)
  const q = Q.readQueue({ file })
  assert.deepEqual(q.items.map((i) => [i.task, i.status, i.mode]), [["first task", "PENDING", "auto"], ["second task", "PENDING", "single"]])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

await t("add refuses an empty task and an unknown mode", () => {
  const file = fresh()
  assert.throws(() => Q.addItem("   ", { file }), /needs a task/)
  assert.throws(() => Q.addItem("x", { file, mode: "turbo" }), /unknown mode/)
})

await t("run goes oldest first, one at a time, and records each result", async () => {
  const file = fresh()
  Q.addItem("one", { file }); Q.addItem("two", { file, mode: "meta" }); Q.addItem("three", { file })
  const seen = []
  let running = 0, maxRunning = 0
  const runner = async (item, ctx) => {
    running++; maxRunning = Math.max(maxRunning, running)
    await new Promise((r) => setTimeout(r, 5))
    const r = await fakeRunner(() => "COMPLETED", seen)(item, ctx)
    running--
    return r
  }
  const res = await Q.runQueue({ file, runItem: runner })
  assert.deepEqual(seen.map((i) => i.task), ["one", "two", "three"])
  assert.equal(seen[1].mode, "meta")
  assert.equal(maxRunning, 1)
  assert.equal(res.ran.length, 3); assert.equal(res.stopped, null)
  const q = Q.readQueue({ file })
  assert.ok(q.items.every((i) => i.status === "COMPLETED" && i.result.steps === 3 && i.finished_at))
  assert.equal(q.runner, null)
})

await t("agent statuses are kept as-is; a missing result file is FAILED", async () => {
  const file = fresh()
  Q.addItem("ok", { file }); Q.addItem("partial", { file }); Q.addItem("crash", { file }); Q.addItem("asks", { file })
  const res = await Q.runQueue({ file, runItem: fakeRunner((i) => ({ ok: "COMPLETED", partial: "INCOMPLETE", crash: null, asks: "WAITING" })[i.task]) })
  assert.deepEqual(res.ran.map((i) => i.status), ["COMPLETED", "INCOMPLETE", "FAILED", "WAITING"])
  assert.equal(res.ran[1].result.reason, "budget")
  assert.match(res.ran[2].result.error, /no result file/)
})

await t("--stop-on-fail stops after the first item that did not complete", async () => {
  const file = fresh()
  Q.addItem("a", { file }); Q.addItem("b", { file }); Q.addItem("c", { file })
  const res = await Q.runQueue({ file, stopOnFail: true, runItem: fakeRunner((i) => (i.task === "b" ? "INCOMPLETE" : "COMPLETED")) })
  assert.deepEqual(res.ran.map((i) => i.task), ["a", "b"])
  assert.match(res.stopped, /INCOMPLETE/)
  assert.equal(Q.readQueue({ file }).items[2].status, "PENDING")
})

await t("COMPLETED_UNVERIFIED does not trip --stop-on-fail", async () => {
  const file = fresh()
  Q.addItem("a", { file }); Q.addItem("b", { file })
  const res = await Q.runQueue({ file, stopOnFail: true, runItem: fakeRunner(() => "COMPLETED_UNVERIFIED") })
  assert.equal(res.ran.length, 2)
})

await t("--max limits how many run", async () => {
  const file = fresh()
  for (const x of ["a", "b", "c"]) Q.addItem(x, { file })
  const res = await Q.runQueue({ file, max: 2, runItem: fakeRunner(() => "COMPLETED") })
  assert.equal(res.ran.length, 2)
  assert.equal(Q.readQueue({ file }).items[2].status, "PENDING")
})

await t("an item added while the runner works is picked up", async () => {
  const file = fresh()
  Q.addItem("first", { file })
  const seen = []
  const runner = async (item, ctx) => {
    if (item.task === "first") Q.addItem("added mid-run", { file })
    return fakeRunner(() => "COMPLETED", seen)(item, ctx)
  }
  await Q.runQueue({ file, runItem: runner })
  assert.deepEqual(seen.map((i) => i.task), ["first", "added mid-run"])
})

await t("an aborted item stops the run", async () => {
  const file = fresh()
  Q.addItem("a", { file }); Q.addItem("b", { file })
  const res = await Q.runQueue({ file, runItem: fakeRunner(() => "ABORTED") })
  assert.equal(res.ran.length, 1); assert.equal(res.stopped, "aborted")
  assert.equal(Q.readQueue({ file }).items[1].status, "PENDING")
})

await t("a second runner is refused while the first is alive", async () => {
  const file = fresh()
  Q.addItem("a", { file })
  fs.writeFileSync(file, JSON.stringify({ ...Q.readQueue({ file }), runner: { pid: 999999, started_at: Date.now() } }))
  const res = await Q.runQueue({ file, alive: (pid) => pid === 999999 || pid === process.pid, runItem: fakeRunner(() => "COMPLETED") })
  assert.match(res.refused, /another queue runner/)
  assert.equal(Q.readQueue({ file }).items[0].status, "PENDING")
})

await t("RUNNING with a dead runner becomes INTERRUPTED, never re-run silently", async () => {
  const file = fresh()
  Q.addItem("half done", { file }); Q.addItem("next", { file })
  const q = Q.readQueue({ file })
  q.items[0].status = "RUNNING"; q.items[0].runner_pid = 424242; q.runner = { pid: 424242 }
  fs.writeFileSync(file, JSON.stringify(q))
  const seen = []
  const res = await Q.runQueue({ file, alive: (pid) => pid === process.pid, runItem: fakeRunner(() => "COMPLETED", seen) })
  assert.deepEqual(seen.map((i) => i.task), ["next"])
  const after = Q.readQueue({ file })
  assert.equal(after.items[0].status, "INTERRUPTED")
  assert.match(after.items[0].note, /retry/)
  assert.equal(res.ran.length, 1)
})

await t("retry, remove, clear", () => {
  const file = fresh()
  Q.addItem("a", { file }); Q.addItem("b", { file }); Q.addItem("c", { file })
  const q = Q.readQueue({ file })
  q.items[0].status = "FAILED"; q.items[1].status = "COMPLETED"
  fs.writeFileSync(file, JSON.stringify(q))
  assert.equal(Q.retryItem("3", { file }).ok, false) // still pending
  const r = Q.retryItem("1", { file })
  assert.equal(r.ok, true); assert.equal(Q.readQueue({ file }).items[0].status, "PENDING")
  const id = Q.readQueue({ file }).items[2].id
  assert.equal(Q.removeItem(id.slice(0, 4), { file }).ok, true)
  assert.equal(Q.removeItem("9", { file }).ok, false)
  assert.equal(Q.clearQueue({ file }).removed, 1) // the COMPLETED one
  assert.deepEqual(Q.readQueue({ file }).items.map((i) => i.task), ["a"])
  assert.equal(Q.clearQueue({ file, all: true }).removed, 1)
  assert.equal(Q.readQueue({ file }).items.length, 0)
})

await t("a running item cannot be removed", () => {
  const file = fresh()
  Q.addItem("a", { file })
  const q = Q.readQueue({ file }); q.items[0].status = "RUNNING"; fs.writeFileSync(file, JSON.stringify(q))
  assert.equal(Q.removeItem("1", { file }).ok, false)
  assert.equal(Q.clearQueue({ file, all: true }).removed, 0)
})

await t("the default runner passes mode flags and --result-json to forge agent", async () => {
  // a stand-in forge.js that records its argv into the result file
  const stub = path.join(tmp, "stub-forge.js")
  fs.writeFileSync(stub, `const a = process.argv.slice(2); const f = a[a.indexOf("--result-json") + 1]; require("fs").writeFileSync(f, JSON.stringify({ status: "COMPLETED", reason: a.join(" ") }))`)
  const resultFile = path.join(tmp, "r.json")
  const ex = await Q.spawnAgentItem({ task: "do it", mode: "single" }, { forgeJs: stub, resultFile, stdio: "ignore" })
  assert.equal(ex.exitCode, 0)
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).reason, `agent --single --result-json ${resultFile} do it`)
  await Q.spawnAgentItem({ task: "big", mode: "meta" }, { forgeJs: stub, resultFile, stdio: "ignore" })
  assert.match(JSON.parse(fs.readFileSync(resultFile, "utf8")).reason, /^agent --auto /)
  await Q.spawnAgentItem({ task: "x", mode: "auto" }, { forgeJs: stub, resultFile, stdio: "ignore" })
  assert.match(JSON.parse(fs.readFileSync(resultFile, "utf8")).reason, /^agent --result-json /)
})

await t("forge.js wires the queue command", () => {
  const src = fs.readFileSync(path.join(here, "..", "forge.js"), "utf8")
  assert.match(src, /case "queue": \{/)
  assert.match(src, /import\("\.\/taskqueue\.js"\)/)
  assert.match(src, /"stop-on-fail"/)
  assert.match(src, /forge queue add "task"/)
})

console.log(`\n== taskqueue suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
