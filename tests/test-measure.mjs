/**
 * Phase 1 — measurement: eval --mode routing and the measure script's math.
 * Zero network.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeModeRunner, RUN_MODE } from "../runmode.js"
import { compareMeasures, bootModuleCount } from "../scripts/measure.mjs"
import { summarize } from "../evalbench.js"

const here = path.dirname(fileURLToPath(import.meta.url))
let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}

const fakeAgent = async () => ({ status: "COMPLETED", steps: 4, usage: { promptTokens: 10, completionTokens: 5, toolCalls: 2 } })
const fakeCore = (calls) => ({ config, provider }) => ({
  run: async (task) => { calls.push({ task, config, provider }); return { status: "COMPLETED", segments: 3, toolCalls: 7, text: "done", task: { resource_usage: { tokens_in: 100, tokens_out: 40, tool_calls: 7 } } } },
})

await t("single mode is runAgent itself (earlier evals stay comparable)", () => {
  assert.equal(makeModeRunner({ runAgent: fakeAgent, mode: "single" }), fakeAgent)
})
await t("unknown mode is refused", () => {
  assert.throws(() => makeModeRunner({ runAgent: fakeAgent, mode: "turbo" }), /unknown eval mode/)
})
await t("meta mode runs every task through the orchestrator and maps its result", async () => {
  const calls = []
  const run = makeModeRunner({ runAgent: fakeAgent, mode: "meta", createForgeCore: fakeCore(calls) })
  const r = await run({ task: "fix typo", config: {}, provider: { name: "p" } })
  assert.equal(calls.length, 1)
  assert.equal(r.runMode, RUN_MODE.META); assert.equal(r.status, "COMPLETED"); assert.equal(r.steps, 3)
  assert.deepEqual(r.usage, { promptTokens: 100, completionTokens: 40, toolCalls: 7 })
})
await t("auto mode routes by task size, ignoring a config that forces single", async () => {
  const calls = []
  const run = makeModeRunner({ runAgent: fakeAgent, mode: "auto", createForgeCore: fakeCore(calls) })
  const small = await run({ task: "fix typo in README", config: { agent: { autonomous: false } } })
  assert.equal(small.runMode, RUN_MODE.SINGLE); assert.equal(calls.length, 0)
  const big = await run({ task: "refactor the auth module across files", config: { agent: { autonomous: false } } })
  assert.equal(big.runMode, RUN_MODE.META); assert.equal(calls.length, 1)
})
await t("eval summary counts orchestrated tasks", () => {
  const base = { solved: true, falseCompletion: false, errored: false, silentSuccess: false, ms: 1, tokensIn: 0, tokensOut: 0, modelCalls: 0, toolCalls: 0 }
  const s = summarize([{ ...base, id: "a", runMode: "meta" }, { ...base, id: "b", runMode: "single" }])
  assert.equal(s.orchestrated, 1)
})
await t("compare flags regressions and tolerates boot noise", () => {
  const a = { suite: { passed: 80, total: 82 }, boot: { ms: 146 }, eval: { solved: 20, falseCompletions: 1, errored: 0 } }
  const same = compareMeasures(a, { suite: { passed: 80, total: 82 }, boot: { ms: 160 }, eval: { solved: 20, falseCompletions: 1, errored: 0 } })
  assert.deepEqual(same.worse, []) // 160 is within 15% of 146
  const bad = compareMeasures(a, { suite: { passed: 79, total: 82 }, boot: { ms: 200 }, eval: { solved: 18, falseCompletions: 2, errored: 0 } })
  assert.deepEqual(bad.worse.sort(), ["boot ms", "eval false completions", "eval solved", "suite passed"])
  const better = compareMeasures(a, { suite: { passed: 82, total: 82 }, boot: { ms: 110 }, eval: { solved: 24, falseCompletions: 0, errored: 0 } })
  assert.deepEqual(better.worse, [])
})
await t("compare skips numbers neither side has", () => {
  const c = compareMeasures({ suite: { passed: 1, total: 1 } }, { suite: { passed: 1, total: 1 } })
  assert.ok(!c.rows.some((r) => r.name.startsWith("eval")))
})
await t("boot module graph walks static imports only", () => {
  const dir = fs.mkdtempSync(path.join(path.dirname(here), ".measure-test-"))
  try {
    fs.writeFileSync(path.join(dir, "a.js"), 'import { x } from "./b.js"\nexport { y } from "./c.js"\nconst z = await import("./lazy.js")\n')
    fs.writeFileSync(path.join(dir, "b.js"), 'import "./c.js"\n')
    fs.writeFileSync(path.join(dir, "c.js"), "export const y = 1\n")
    fs.writeFileSync(path.join(dir, "lazy.js"), "export const z = 1\n")
    assert.equal(bootModuleCount("a.js", dir), 3)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await t("the committed baseline exists and has the offline numbers", () => {
  const b = JSON.parse(fs.readFileSync(path.join(here, "..", "measure", "baseline-178.0.0.json"), "utf8"))
  assert.ok(b.suite.total > 0 && b.boot.ms > 0 && b.modules.bootGraph > 0)
})
await t("forge.js passes --mode to eval", () => {
  const src = fs.readFileSync(path.join(here, "..", "forge.js"), "utf8")
  assert.match(src, /makeModeRunner\(\{ runAgent: rawRunAgent, mode: evalMode, createForgeCore \}\)/)
})

console.log(`\n== measure suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
