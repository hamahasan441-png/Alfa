/**
 * Phase 4 — one entry point (runtask.js), the boot shim (forge-boot.js) and
 * the browser boot split (browserpolicy.js). Zero network, isolated HOME.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-onebrain-"))
process.env.FORGE_HOME = HOME
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, "..")
const { runTask, adaptMetaResult, makeModeRunner } = await import("../runtask.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const metaResult = { status: "COMPLETED", text: "done", segments: 2, repairs: 1, toolCalls: 5, taskId: "t1", filesChanged: ["a.js"], verification: { ok: true }, task: { run_id: "r1", resource_usage: { tokens_in: 9, tokens_out: 3 } } }
const fakeCore = (calls) => (opts) => ({ run: async (task, runOpts) => { calls.push({ opts, task, runOpts }); return metaResult } })
const fakeAgent = (calls) => async (o) => { calls.push(o); return { status: "COMPLETED", text: "loop", steps: 1, toolLog: [] } }

await t("adaptMetaResult maps the controller onto the agent-result shape", () => {
  const r = adaptMetaResult(metaResult)
  assert.equal(r.text, "done"); assert.equal(r.taskStatus, "COMPLETED"); assert.equal(r.steps, 2)
  assert.equal(r.wrote, true); assert.equal(r.runId, "r1"); assert.equal(r.toolCallsTotal, 5)
  assert.deepEqual(r.toolLog, []); assert.equal(r.runMode, "meta"); assert.equal(r.usage.promptTokens, 9)
  assert.equal("status" in r, false) // renderers read taskStatus for controller runs; status stays the loop's field
  assert.equal(adaptMetaResult({ status: "WAITING" }).waiting, true)
  assert.equal(adaptMetaResult({ status: "FAILED" }).text, "Task failed.")
})
await t("runTask: chooser picks the controller for a big task", async () => {
  const cc = [], ac = []
  const out = await runTask({ task: "refactor the auth module across files", config: {}, provider: { name: "p" }, runAgent: fakeAgent(ac), createForgeCore: fakeCore(cc), env: {} })
  assert.equal(out.mode, "meta"); assert.equal(cc.length, 1); assert.equal(ac.length, 0)
  assert.equal(out.meta, metaResult); assert.equal(out.res.taskStatus, "COMPLETED")
})
await t("runTask: chooser picks the single loop for a small task", async () => {
  const cc = [], ac = []
  const out = await runTask({ task: "fix typo in README", config: {}, provider: { name: "p" }, runAgent: fakeAgent(ac), createForgeCore: fakeCore(cc), env: {} })
  assert.equal(out.mode, "single"); assert.equal(ac.length, 1); assert.equal(cc.length, 0)
  assert.equal(out.res.text, "loop"); assert.equal(out.meta, null)
})
await t("runTask: an explicit mode skips the chooser; options reach the engine", async () => {
  const cc = []
  await runTask({ task: "fix typo", mode: "meta", config: {}, provider: { name: "p" }, createForgeCore: fakeCore(cc), deep: true, coreOpts: { conversationId: "c1" } })
  assert.equal(cc[0].runOpts.deep, true); assert.equal(cc[0].runOpts.conversationId, "c1")
  const ac = []
  await runTask({ task: "refactor everything across files", mode: "single", config: {}, provider: { name: "p" }, runAgent: fakeAgent(ac), agentOpts: { extraContext: "x" } })
  assert.equal(ac[0].extraContext, "x")
})
await t("runTask: a resume always runs the controller with its task id", async () => {
  const cc = []
  await runTask({ task: "fix typo", resumeTaskId: "t9", config: { agent: { autonomous: false } }, provider: {}, createForgeCore: fakeCore(cc) })
  assert.equal(cc[0].runOpts.resumeTaskId, "t9")
})
await t("runTask: a missing engine is a clear error", async () => {
  await assert.rejects(runTask({ task: "x", mode: "meta" }), /no createForgeCore/)
  await assert.rejects(runTask({ task: "x", mode: "single" }), /no runAgent/)
})
await t("makeModeRunner (eval) goes through runTask and reports status", async () => {
  const cc = []
  const run = makeModeRunner({ runAgent: fakeAgent([]), mode: "meta", createForgeCore: fakeCore(cc) })
  const r = await run({ task: "x", config: {}, provider: {} })
  assert.equal(r.status, "COMPLETED"); assert.equal(r.runMode, "meta"); assert.equal(r.trace, null); assert.equal(cc.length, 1)
})
await t("forge agent, chat and tasks --resume all call runTask", () => {
  const forge = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
  const chat = fs.readFileSync(path.join(ROOT, "chat.js"), "utf8")
  assert.match(forge, /await runTask\(\{ task, config: cfg, provider: p, runAgent, createForgeCore, mode: runMode\.mode,/)
  assert.match(forge, /await runTask\(\{ task: rec\.objective, config: cfg, provider: p, createForgeCore, resumeTaskId: rec\.task_id,/)
  assert.match(chat, /await runTask\(\{ task, config, provider: p, createForgeCore, mode: "meta", resumeTaskId,/)
  // no second copy of the controller adapter is left behind
  assert.doesNotMatch(chat, /text: m\.text \|\| `Task \$\{m\.status\.toLowerCase\(\)\}\.`/)
  assert.doesNotMatch(forge, /const core = createForgeCore\(/)
})
await t("browser policy is importable without the driver, and browser.js re-exports it", async () => {
  const pol = await import("../browserpolicy.js")
  const br = await import("../browser.js")
  for (const k of ["ACTIONS", "VERIFY_ACTIONS", "PAGE_MUTATING", "isPageMutating", "isVerifyAction", "browserMutatesFilesystem"]) assert.equal(br[k], pol[k], k)
  assert.equal(pol.browserMutatesFilesystem({ action: "screenshot", path: "a.png" }), true)
  assert.equal(pol.isPageMutating("click"), true); assert.equal(pol.isVerifyAction("snapshot"), true)
})
await t("the agent no longer loads browser.js at boot", async () => {
  const { bootModuleCount } = await import("../scripts/measure.mjs")
  const graph = new Set()
  const walk = (f) => {
    if (graph.has(f)) return; graph.add(f)
    const src = fs.readFileSync(path.join(ROOT, f), "utf8")
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']\.\/([^"']+\.js)["']/gms)) walk(m[1])
  }
  walk("agent.js")
  assert.ok(!graph.has("browser.js")); assert.ok(graph.has("browserpolicy.js"))
  assert.ok(bootModuleCount("agent.js") <= 114)
})
await t("forge-boot.js: runs the CLI and fills the compile cache under FORGE_HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-"))
  const env = { ...process.env, FORGE_HOME: home }
  delete env.NODE_COMPILE_CACHE; delete env.FORGE_COMPILE_CACHE
  const out = execFileSync(process.execPath, [path.join(ROOT, "forge-boot.js"), "--version"], { env, encoding: "utf8" })
  assert.match(out, /^forge v\d+\.\d+\.\d+/)
  const node = Number(process.versions.node.split(".")[0]), minor = Number(process.versions.node.split(".")[1])
  if (node > 22 || (node === 22 && minor >= 1)) assert.ok(fs.existsSync(path.join(home, "compile-cache")) && fs.readdirSync(path.join(home, "compile-cache")).length > 0)
})
await t("forge-boot.js: FORGE_COMPILE_CACHE=0 turns the cache off", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-off-"))
  const env = { ...process.env, FORGE_HOME: home, FORGE_COMPILE_CACHE: "0" }
  delete env.NODE_COMPILE_CACHE
  execFileSync(process.execPath, [path.join(ROOT, "forge-boot.js"), "--version"], { env, encoding: "utf8" })
  assert.equal(fs.existsSync(path.join(home, "compile-cache")), false)
})
await t("the installed bin is the boot shim, and it ships", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  assert.equal(pkg.bin.forge, "./forge-boot.js")
  assert.ok(pkg.files.includes("forge-boot.js") && pkg.files.includes("forge.js") && pkg.files.includes("runtask.js") && pkg.files.includes("browserpolicy.js"))
})
await t("importing forge.js still does not launch the CLI", () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(path.join(ROOT, "forge.js"))}); console.log("imported")`], { env: { ...process.env, FORGE_HOME: HOME }, encoding: "utf8" })
  assert.equal(out.trim(), "imported")
})

console.log(`\n== onebrain suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
