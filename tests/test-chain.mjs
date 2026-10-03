/**
 * Phase 2 — model chain (chain.js), its meta wiring and `forge chain`.
 * Zero network, isolated HOME.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chain-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chain-work-"))
process.chdir(WORK)
const here = path.dirname(fileURLToPath(import.meta.url))
const C = await import("../chain.js")
const { sanitizeProjectConfig } = await import("../config.js")

let n = 0
const t = async (name, fn) => {
  try { await fn(); n++; console.log(`  ok   ${name}`) }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 }
}
const providers = {
  a: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "ka", model: "a-default" },
  b: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "kb", model: "b-default" },
  c: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "kc", model: "c-default" },
}
const build = (cfg, name) => {
  const c = cfg.providers?.[name]
  return c && c.apiKey ? { name, protocol: "openai", baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model } : null
}
const providerError = (status, msg) => Object.assign(new Error(`provider HTTP ${status}: ${msg}`), { name: "ProviderError", status })

await t("parseSpec splits at the first slash", () => {
  assert.deepEqual(C.parseSpec("openrouter/openai/gpt-4o"), { provider: "openrouter", model: "openai/gpt-4o" })
  assert.equal(C.parseSpec("nope"), null); assert.equal(C.parseSpec("/x"), null); assert.equal(C.parseSpec("x/"), null)
})
await t("roles map onto slots", () => {
  assert.equal(C.slotForRole("planner"), "planner"); assert.equal(C.slotForRole("architect"), "planner")
  assert.equal(C.slotForRole("coder"), "coder"); assert.equal(C.slotForRole("debugger"), "coder")
  assert.equal(C.slotForRole("reviewer"), "reviewer"); assert.equal(C.slotForRole("security"), "reviewer")
  assert.equal(C.slotForRole("researcher"), "worker"); assert.equal(C.slotForRole("explorer"), "worker"); assert.equal(C.slotForRole("tester"), "worker")
})
await t("no chain → nothing applies", () => {
  assert.equal(C.hasChain({}), false)
  assert.deepEqual(C.chainSpecs({}, "coder"), [])
  assert.deepEqual(C.chainSpecs({ chain: {} }, "coder", { primary: { name: "a", model: "m" } }), [])
})
await t("slot first, then fallbacks, de-duplicated; coder falls back to worker", () => {
  const cfg = { chain: { worker: "a/w", reviewer: "b/r", fallback: ["c/f", "a/w"] } }
  assert.deepEqual(C.chainSpecs(cfg, "coder").map((s) => [`${s.provider}/${s.model}`, s.slot]), [["a/w", "worker"], ["c/f", "fallback"]])
  assert.deepEqual(C.chainSpecs(cfg, "reviewer").map((s) => s.slot), ["reviewer", "fallback", "fallback"])
})
await t("fallback-only chain: the run's own model first, then the fallbacks", () => {
  const cfg = { chain: { fallback: ["c/f"] } }
  const prim = { name: "a", model: "live" }
  const specs = C.chainSpecs(cfg, "researcher", { primary: prim })
  assert.deepEqual(specs.map((s) => [s.provider, s.model, s.slot]), [["a", "live", "active"], ["c", "f", "fallback"]])
  assert.equal(specs[0].prov, prim)
  assert.deepEqual(C.chainSpecs(cfg, "researcher"), []) // no primary → nothing to put first
})
await t("validateChain reports bad entries", () => {
  assert.deepEqual(C.validateChain({}), [])
  const p = C.validateChain({ chain: { planner: "x", boss: "a/b", fallback: ["ok/m", "bad"] } })
  assert.equal(p.length, 3)
  assert.deepEqual(C.validateChain({ chain: { fallback: "a/b" } }), ["chain.fallback must be a list of provider/model"])
})
await t("runOnChain moves on a provider failure (thrown)", async () => {
  const cfg = { providers, chain: { coder: "a/m1", fallback: ["b/m2"] } }
  const seen = [], switches = []
  const r = await C.runOnChain({ config: cfg, role: "coder", build, onSwitch: (s) => switches.push(s), run: async (p) => { seen.push(`${p.name}/${p.model}`); if (p.name === "a") throw providerError(429, "rate limit"); return { status: "COMPLETED", text: "ok" } } })
  assert.deepEqual(seen, ["a/m1", "b/m2"])
  assert.equal(r.used.provider, "b"); assert.equal(r.result.status, "COMPLETED")
  assert.equal(switches.length, 1); assert.match(switches[0].why, /429/)
})
await t("runOnChain moves on a provider failure (ERROR result)", async () => {
  const cfg = { providers, chain: { worker: "a/m1", fallback: ["b/m2"] } }
  const r = await C.runOnChain({ config: cfg, role: "researcher", build, run: async (p) => (p.name === "a" ? { status: "ERROR", error: "provider HTTP 402: out of credits on a" } : { status: "COMPLETED" }) })
  assert.equal(r.used.provider, "b")
})
await t("the task's own failure is not the model's: no switch", async () => {
  const cfg = { providers, chain: { coder: "a/m1", fallback: ["b/m2"] } }
  const seen = []
  await assert.rejects(C.runOnChain({ config: cfg, role: "coder", build, run: async (p) => { seen.push(p.name); throw new Error("tests failed: 3 assertions") } }), /tests failed/)
  assert.deepEqual(seen, ["a"])
  const inc = await C.runOnChain({ config: cfg, role: "coder", build, run: async () => ({ status: "INCOMPLETE", text: "budget" }) })
  assert.equal(inc.used.provider, "a")
})
await t("a context overflow does not move along the chain", async () => {
  const cfg = { providers, chain: { coder: "a/m1", fallback: ["b/m2"] } }
  const e = Object.assign(new Error("provider HTTP 400: maximum context length exceeded"), { name: "ProviderError", status: 400, contextOverflow: true })
  await assert.rejects(C.runOnChain({ config: cfg, role: "coder", build, run: async () => { throw e } }), /context/)
})
await t("an unusable spec is skipped; all failing → error lists every try", async () => {
  const cfg = { providers, chain: { coder: "nokey/m0", fallback: ["a/m1", "b/m2"] } }
  const seen = []
  await assert.rejects(
    C.runOnChain({ config: cfg, role: "coder", build, run: async (p) => { seen.push(p.name); throw providerError(503, "overloaded") } }),
    (e) => /overloaded/.test(e.message) && e.chainTried?.length === 3 && /not usable/.test(e.chainTried[0].skipped),
  )
  assert.deepEqual(seen, ["a", "b"])
})
await t("last spec's ERROR result is returned, not swallowed", async () => {
  const cfg = { providers, chain: { coder: "a/m1" } }
  const r = await C.runOnChain({ config: cfg, role: "coder", build, run: async () => ({ status: "ERROR", error: "provider HTTP 500: boom" }) })
  assert.equal(r.result.status, "ERROR")
})
await t("an abort is never retried on another model", async () => {
  const cfg = { providers, chain: { coder: "a/m1", fallback: ["b/m2"] } }
  const seen = []
  await assert.rejects(C.runOnChain({ config: cfg, role: "coder", build, run: async (p) => { seen.push(p.name); throw Object.assign(new Error("aborted"), { name: "AbortError" }) } }), /aborted/)
  assert.deepEqual(seen, ["a"])
})
await t("a repository's forge.config.json cannot set the chain", () => {
  const { cfg, dropped } = sanitizeProjectConfig({ chain: { planner: "evil/m" }, agent: { maxSteps: 5 } })
  assert.ok(!("chain" in cfg)); assert.ok(dropped.includes("chain"))
})
await t("describeChain says which specs are usable", () => {
  const rows = C.describeChain({ providers, chain: { planner: "a/big", fallback: ["nokey/x"] } }, build)
  const planner = rows.find((r) => r.slot === "planner")
  assert.deepEqual(planner.specs.map((s) => [s.spec, s.usable]), [["a/big", true], ["nokey/x", false]])
})
await t("meta: chain.planner becomes the orchestrator's model", async () => {
  const meta = await import("../meta.js")
  const events = [], used = []
  const runAgent = async (o) => { used.push(`${o.provider?.name}/${o.provider?.model}`); return o.planOnly ? { text: "1. do it", toolRecords: [], commandChecks: [], toolLog: [] } : { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] } }
  const cfg = { providers: { plannerprov: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "small" } }, chain: { planner: "plannerprov/big-model" }, agent: { autonomous: true, modelStrategy: false }, tools: {} }
  await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "explain the readme", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  const sel = events.find((e) => e.type === "MODEL_SELECTED")
  assert.equal(sel?.reason, "chain.planner (your model chain)")
  assert.ok(used.length && used.every((u) => u === "plannerprov/big-model"), `runs used ${used.join(", ")}`)
})
await t("meta: no chain → the run's provider, as before", async () => {
  const meta = await import("../meta.js")
  const used = []
  const runAgent = async (o) => { used.push(`${o.provider?.name}/${o.provider?.model}`); return { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] } }
  await meta.runMeta({ config: { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }, provider: { name: "x", model: "m" }, task: "explain the readme", runAgent, signal: new AbortController().signal })
  assert.ok(used.length && used.every((u) => u === "x/m"))
})
await t("meta wires the chain into worker runs", () => {
  const src = fs.readFileSync(path.join(here, "..", "meta.js"), "utf8")
  assert.match(src, /runOnChain\(\{\s*config, role, build: buildProvider, primary: roleProv,/)
  assert.match(src, /chain\.planner \(your model chain\)/)
})
await t("forge chain set / show / unset / clear (CLI)", () => {
  const cfgFile = path.join(HOME, "cli-config.json")
  fs.writeFileSync(cfgFile, JSON.stringify({ providers: { a: providers.a } }))
  const env = { ...process.env, FORGE_CONFIG: cfgFile, FORGE_HOME: path.join(HOME, "cli-home"), NO_COLOR: "1" }
  const forge = (...args) => execFileSync(process.execPath, [path.join(here, "..", "forge.js"), ...args], { env, cwd: WORK, encoding: "utf8" })
  assert.match(forge("chain"), /no model chain set/)
  forge("chain", "set", "planner", "a/big")
  forge("chain", "set", "fallback", "nokey/x,a/small")
  const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"))
  assert.deepEqual(saved.chain, { planner: "a/big", fallback: ["nokey/x", "a/small"] })
  const shown = forge("chain")
  assert.match(shown, /planner\s+a\/big/); assert.match(shown, /nokey\/x: provider "nokey" is not usable/)
  const j = JSON.parse(forge("chain", "--json"))
  assert.equal(j.configured, true)
  assert.throws(() => forge("chain", "set", "boss", "a/b"))
  forge("chain", "unset", "planner")
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).chain, { fallback: ["nokey/x", "a/small"] })
  forge("chain", "clear")
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).chain, {})
})

console.log(`\n== chain suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
