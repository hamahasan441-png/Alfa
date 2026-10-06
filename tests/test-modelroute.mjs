#!/usr/bin/env node
/**
 * forge — the one model router (modelroute.js).
 *
 * Every decision about which model runs goes through one module, in one
 * order: chain > lock > inherited > measured > joint > active, with failover
 * consent for another provider. This suite pins that order layer by layer,
 * and the three cases where forge used to say one model and run another.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_LOCK_MODEL
delete process.env.FORGE_FAILOVER
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-work-"))
process.chdir(WORK)
const R = await import("../modelroute.js")
const { recordRoute } = await import("../jointroute.js")

const alpha = { protocol: "openai", baseUrl: "https://alpha.example/v1", apiKey: "k", model: "gpt-4o-mini", models: ["gpt-4o"] }
const beta = { protocol: "openai", baseUrl: "https://beta.example/v1", apiKey: "k", model: "o3" }
const cfg = (extra = {}) => ({ providers: { alpha }, tools: {}, ...extra, agent: { autonomous: true, ...(extra.agent ?? {}) } })
const MINI = { name: "alpha", protocol: "openai", baseUrl: alpha.baseUrl, apiKey: "k", model: "gpt-4o-mini" }
const BIG = { ...MINI, model: "gpt-4o" }
const HEAVY = "design a new distributed consensus algorithm and prove it correct"
const LIGHT = "rename the variable x to count in util.js"
const env = {}
const at = (p) => `${p?.name}/${p?.model}`

try {
  console.log("== the order is written down ==")
  eq("chain > lock > inherited > measured > joint > active", R.ROUTE_ORDER, ["chain", "lock", "inherited", "measured", "joint", "active"])

  console.log("== a run of the agent loop ==")
  {
    const ro = R.routeRun({ config: cfg(), provider: MINI, task: HEAVY, klass: "LARGE", readonly: true, env })
    ok("read-only: nothing is chosen, nothing announced", ro.provider === MINI && ro.events.length === 0 && /read-only/.test(ro.trace.join("\n")))
    const m = R.routeRun({ config: cfg(), provider: MINI, task: HEAVY, klass: "LARGE", env })
    eq("measured: the heavy task moves to the stronger model at the same provider", at(m.provider), "alpha/gpt-4o")
    ok("…and announces exactly that", m.events.some((e) => e.type === "MODEL_SELECTED" && e.model === "gpt-4o"), JSON.stringify(m.events))
    ok("…with a trace that says why", /measured: alpha\/gpt-4o-mini → alpha\/gpt-4o/.test(m.trace.join("\n")), m.trace.join(" | "))
    const lock = R.routeRun({ config: cfg(), provider: MINI, task: HEAVY, klass: "LARGE", env: { FORGE_LOCK_MODEL: "1" } })
    ok("FORGE_LOCK_MODEL=1: the caller's model, untouched", lock.provider === MINI && lock.events.length === 0)
    const micro = R.routeRun({ config: cfg(), provider: MINI, task: "fix teh typo", klass: "MICRO", env })
    eq("MICRO keeps the caller's model", at(micro.provider), "alpha/gpt-4o-mini")
  }

  // measured history: gpt-4o solved SMALL tasks 4 of 4 times
  for (let i = 0; i < 4; i++) recordRoute({ cwd: WORK, klass: "SMALL", model: "gpt-4o", ok: true })
  {
    const j = R.routeRun({ config: cfg({ agent: { modelStrategy: false } }), provider: MINI, task: LIGHT, klass: "SMALL", env })
    ok("agent.modelStrategy: false turns the joint route off too (it used to switch anyway)", j.provider === MINI && !j.events.some((e) => e.type === "JOINT_ROUTE"), JSON.stringify(j.events))
    const inh = R.routeRun({ config: cfg(), provider: MINI, task: LIGHT, klass: "SMALL", routedBy: "controller", env })
    ok("a run the controller routed keeps that model — the joint route no longer moves it", inh.provider === MINI && inh.events.length === 1 && inh.events[0].type === "MODEL_INHERITED", JSON.stringify(inh.events))
    const free = R.routeRun({ config: cfg(), provider: MINI, task: LIGHT, klass: "SMALL", env })
    ok("on an ordinary run the joint route still works", at(free.provider) === "alpha/gpt-4o" && free.events.some((e) => e.type === "JOINT_ROUTE" || (e.type === "MODEL_SELECTED" && e.model === "gpt-4o")), JSON.stringify(free.events) + " " + free.trace.join(" | "))
  }

  console.log("== the orchestrator's own model ==")
  {
    const chain = R.routeController({ config: cfg({ providers: { alpha, beta }, chain: { planner: "beta/o3" } }), provider: MINI, task: HEAVY })
    ok("chain.planner wins over everything measured", at(chain.provider) === "beta/o3" && chain.switched && chain.selected.reason === "chain.planner (your model chain)", JSON.stringify(chain.selected))
    // the controller's lane puts a light task on the fast, cheap model
    const same = R.routeController({ config: cfg(), provider: BIG, task: LIGHT })
    ok("measured-best at the SAME provider: announced AND used (it used to be announced only)", same.selected?.model === "gpt-4o-mini" && at(same.provider) === "alpha/gpt-4o-mini" && same.switched, JSON.stringify({ sel: same.selected, prov: at(same.provider) }))
    eq("…and the task record says the same model", same.note.slice(0, 2), ["alpha", "gpt-4o-mini"])
    const off = R.routeController({ config: cfg({ agent: { modelStrategy: false } }), provider: MINI, task: HEAVY })
    ok("agent.modelStrategy: false: the active model, nothing announced", off.provider === MINI && off.selected === null && off.note[2] === "active provider")
  }
  {
    // a measured-best model at ANOTHER provider: consent decides, and an
    // unbuildable provider is reported, never announced as running
    const two = { providers: { alpha: { ...alpha, model: "gpt-4o", models: [] }, beta: { ...beta, model: "gpt-4o-mini" } }, tools: {}, agent: { autonomous: true } }
    const dec = R.routeController({ config: two, provider: BIG, task: LIGHT })
    eq("(the measured-best here is at the other provider)", `${dec.selection?.decision?.provider}/${dec.selection?.decision?.model}`, "beta/gpt-4o-mini")
    ok("another provider without failover consent: kept, and it says so", dec.provider === BIG && /needs failover consent/.test(dec.selected?.reason ?? ""), JSON.stringify(dec.selected))
    const noBuild = R.routeController({ config: { ...two, failover: true }, provider: BIG, task: LIGHT, build: () => null })
    ok("with consent but the provider cannot be built: kept, and it says so (not announced as running)", noBuild.provider === BIG && noBuild.selected?.model === "gpt-4o" && /could not be built/.test(noBuild.selected?.reason ?? ""), JSON.stringify(noBuild.selected))
    const moved = R.routeController({ config: { ...two, failover: true }, provider: BIG, task: LIGHT })
    ok("with consent: moved, and announced as what runs", at(moved.provider) === "beta/gpt-4o-mini" && moved.selected?.model === "gpt-4o-mini", JSON.stringify(moved.selected))
  }

  console.log("== a worker role ==")
  {
    const build = async (c, name) => (name === "beta" ? { name: "beta", protocol: "openai", baseUrl: beta.baseUrl, apiKey: "k", model: "o3" } : null)
    const chained = await R.routeRole({ config: cfg({ chain: { coder: "alpha/gpt-4o" } }), provider: MINI, role: "coder", task: HEAVY, build })
    ok("a role your chain covers is left to the chain", chained.chained && chained.provider === MINI && chained.routed === null)
    const coder = await R.routeRole({ config: cfg(), provider: MINI, role: "coder", task: HEAVY, build })
    ok("the coder's measured model at the SAME provider is used (it used to be ignored)", at(coder.provider) === "alpha/gpt-4o" && coder.routed?.class === "coding", JSON.stringify(coder.routed) + " " + coder.trace.join(" | "))
    const offRole = await R.routeRole({ config: cfg({ agent: { crewRouting: false } }), provider: MINI, role: "coder", task: HEAVY, build })
    ok("agent.crewRouting: false: unchanged", offRole.provider === MINI && offRole.routed === null)
  }

  console.log("== mid-run reconsider ==")
  {
    eq("not model-attributed and no resource ask: nothing", R.routeReconsider({ config: cfg(), provider: MINI, task: HEAVY, failures: 0, failureKind: null, preferredClass: undefined }) ?? null, R.routeReconsider({ config: cfg(), provider: MINI, task: HEAVY }) ?? null)
    const d = R.routeReconsider({ config: cfg(), provider: { name: "alpha", model: "gpt-4o" }, task: HEAVY, failures: 2, failureKind: "model_failure" })
    ok("two model failures: a different model, never the failing one", d === null || (d.model !== "gpt-4o" || d.provider !== "alpha"), JSON.stringify(d))
  }

  console.log("== through the real controller: the model announced is the model that runs ==")
  {
    const meta = await import("../meta.js")
    const events = [], used = []
    const runAgent = async (o) => {
      used.push(at(o.provider))
      return o.planOnly ? { text: "1. do it", toolRecords: [], commandChecks: [], toolLog: [] } : { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] }
    }
    await meta.runMeta({ config: cfg(), provider: BIG, task: LIGHT, runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
    const sel = events.find((e) => e.type === "MODEL_SELECTED")
    ok("the controller announced gpt-4o-mini", sel?.model === "gpt-4o-mini", JSON.stringify(sel))
    ok("…and every run used it (before: announced gpt-4o-mini, ran gpt-4o)", used.length > 0 && used.every((u) => u === "alpha/gpt-4o-mini"), used.join(", "))
  }

  console.log("== forge route: the decision, asked without running anything ==")
  {
    const { spawnSync } = await import("node:child_process")
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const H = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-cli-"))
    fs.writeFileSync(path.join(H, "config.json"), JSON.stringify({ activeProvider: "alpha", providers: { alpha: { ...alpha, model: "gpt-4o", models: ["gpt-4o-mini"] } }, tools: {} }))
    const r = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "route", LIGHT, "--json"], { cwd: WORK, encoding: "utf8", env: { PATH: process.env.PATH, HOME: H, FORGE_HOME: H, NO_COLOR: "1" } })
    let j = null
    try { j = JSON.parse(r.stdout) } catch { }
    ok("forge route --json exits 0 with the decision", r.status === 0 && j?.start === "alpha/gpt-4o", r.stdout.slice(0, 300) + r.stderr.slice(0, 300))
    ok("…the single loop, the orchestrator and every worker role, each with why", j?.single?.trace?.length > 0 && j?.orchestrator?.model === "alpha/gpt-4o-mini" && j?.roles?.length === 5 && j.roles.every((x) => x.trace.length > 0), JSON.stringify(j).slice(0, 400))
    ok("…and nothing ran: no task, no session written", !fs.existsSync(path.join(H, "tasks")) && !fs.existsSync(path.join(H, "sessions")))
    const none = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "route"], { cwd: WORK, encoding: "utf8", env: { PATH: process.env.PATH, HOME: H, FORGE_HOME: H, NO_COLOR: "1" } })
    ok("with no task it says how to use it", none.status === 1 && /usage: forge route/.test(none.stderr + none.stdout))
    fs.rmSync(H, { recursive: true, force: true })
  }

  console.log("== the router is the only place that decides ==")
  {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
    const agent = read("agent.js"), meta = read("meta.js")
    ok("agent.js routes through routeRun, and no longer calls the scorers itself", /routeRun\(/.test(agent) && !/applyModelChoice\(/.test(agent) && !/scoreRoute\(/.test(agent))
    ok("meta.js routes through routeController / routeRole / routeReconsider, not the scorers", /routeController\(/.test(meta) && /routeRole\(/.test(meta) && /routeReconsider\(/.test(meta) && !/selectModel\(/.test(meta) && !/reconsiderModel\(/.test(meta) && !/preferredClassFor\(/.test(meta))
  }
} finally {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n== modelroute suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
