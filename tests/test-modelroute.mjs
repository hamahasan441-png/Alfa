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
    // audit F3: a model you chose with --model / --provider / /model is
    // pinned, and pinned is your lock (rank 2): measured routing used to
    // replace it here. Explicit configuration stays authoritative.
    const pin = R.routeRun({ config: cfg(), provider: { ...MINI, pinned: "--model" }, task: HEAVY, klass: "LARGE", env })
    ok("pinned (--model): the heavy task stays on the model you chose — nothing moved, nothing announced", at(pin.provider) === "alpha/gpt-4o-mini" && pin.events.length === 0 && /lock: you chose alpha\/gpt-4o-mini \(--model\)/.test(pin.trace.join("\n")), JSON.stringify(pin.events) + " " + pin.trace.join(" | "))
    const m = R.routeRun({ config: cfg(), provider: MINI, task: HEAVY, klass: "LARGE", env })
    eq("measured (a provider nobody pinned): the heavy task moves to the stronger model at the same provider", at(m.provider), "alpha/gpt-4o")
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
    const pinnedCtl = R.routeController({ config: cfg(), provider: { ...BIG, pinned: "--model" }, task: LIGHT, env })
    ok("pinned (--model): the orchestrator keeps the model you chose — nothing announced", at(pinnedCtl.provider) === "alpha/gpt-4o" && !pinnedCtl.switched && pinnedCtl.selected === null && /lock:/.test(pinnedCtl.trace.join("\n")), JSON.stringify({ sel: pinnedCtl.selected, trace: pinnedCtl.trace }))
    const same = R.routeController({ config: cfg(), provider: BIG, task: LIGHT, env })
    ok("measured-best at the SAME provider (not pinned): announced AND used (it used to be announced only)", same.selected?.model === "gpt-4o-mini" && at(same.provider) === "alpha/gpt-4o-mini" && same.switched, JSON.stringify({ sel: same.selected, prov: at(same.provider) }))
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

  console.log("== audit F2: FORGE_LOCK_MODEL is read one way ==")
  {
    for (const v of ["1", "true", "TRUE", "yes", " Yes "]) ok(`FORGE_LOCK_MODEL=${JSON.stringify(v)} locks`, R.lockModelEnv({ FORGE_LOCK_MODEL: v }) === true)
    for (const v of ["0", "false", "", "no", undefined]) ok(`FORGE_LOCK_MODEL=${JSON.stringify(v)} does not lock`, R.lockModelEnv({ FORGE_LOCK_MODEL: v }) === false)
    // gpt-4o solved SMALL 4/4 (recorded above): the joint route wants it
    const t = R.routeRun({ config: cfg(), provider: MINI, task: LIGHT, klass: "SMALL", env: { FORGE_LOCK_MODEL: "true" } })
    ok("FORGE_LOCK_MODEL=true locks the joint route too (it used to lock measured only)", t.provider === MINI && t.events.length === 0, JSON.stringify(t.events) + " " + t.trace.join(" | "))
    const z = R.routeRun({ config: cfg(), provider: MINI, task: LIGHT, klass: "SMALL", env: { FORGE_LOCK_MODEL: "0" } })
    ok("FORGE_LOCK_MODEL=0 is not a lock (it used to lock the measured step)", at(z.provider) === "alpha/gpt-4o" && !/lock/.test(z.trace.join("\n")), z.trace.join(" | "))
    ok("locked(): one helper, every reason", R.locked(cfg(), { FORGE_LOCK_MODEL: "1" }) && R.locked(cfg({ agent: { modelStrategy: false } }), {}) && R.locked(cfg(), {}, { name: "a", model: "m", pinned: "/model" }) && R.locked(cfg(), {}, MINI) === null)
  }

  console.log("== audit F1: the lock holds in every router ==")
  {
    const lockEnv = { FORGE_LOCK_MODEL: "1" }
    const c = R.routeController({ config: cfg(), provider: BIG, task: LIGHT, env: lockEnv })
    ok("routeController + FORGE_LOCK_MODEL=1: kept (it moved to gpt-4o-mini)", c.provider === BIG && !c.switched && c.selected === null, JSON.stringify({ p: at(c.provider), t: c.trace }))
    const chainLocked = R.routeController({ config: cfg({ providers: { alpha, beta }, chain: { planner: "beta/o3" } }), provider: BIG, task: LIGHT, env: lockEnv })
    ok("…but your chain (rank 1) still outranks the lock", at(chainLocked.provider) === "beta/o3", at(chainLocked.provider))
    const build = async (c2, name) => (name === "beta" ? { name: "beta", protocol: "openai", baseUrl: beta.baseUrl, apiKey: "k", model: "o3" } : null)
    const role = await R.routeRole({ config: cfg(), provider: MINI, role: "coder", task: HEAVY, build, env: lockEnv })
    ok("routeRole + FORGE_LOCK_MODEL=1: the role stays on the active model (it moved to gpt-4o)", role.provider === MINI && role.routed === null && /lock:/.test(role.trace.join("\n")), JSON.stringify(role.routed) + " " + role.trace.join(" | "))
    const roleOff = await R.routeRole({ config: cfg({ agent: { modelStrategy: false } }), provider: MINI, role: "coder", task: HEAVY, build, env })
    ok("routeRole + agent.modelStrategy: false: stays (it moved to gpt-4o)", roleOff.provider === MINI && roleOff.routed === null, JSON.stringify(roleOff.routed))
    const rolePinned = await R.routeRole({ config: cfg(), provider: { ...MINI, pinned: "--model" }, role: "coder", task: HEAVY, build, env })
    ok("routeRole + a pinned provider: stays", at(rolePinned.provider) === "alpha/gpt-4o-mini" && rolePinned.routed === null, JSON.stringify(rolePinned.routed))
    const roleFree = await R.routeRole({ config: cfg(), provider: MINI, role: "coder", task: HEAVY, build, env })
    ok("routeRole, nothing locked or pinned: still routed as before", at(roleFree.provider) === "alpha/gpt-4o" && roleFree.routed?.class === "coding", JSON.stringify(roleFree.routed))
    // the reconsider that WOULD move (resource ask → fast class): the baseline first
    const ask = { task: LIGHT, failures: 2, failureKind: "reasoning", preferredClass: "fast_reasoning" }
    const free = R.routeReconsider({ config: cfg(), provider: BIG, ...ask, env })
    ok("routeReconsider, nothing locked: still moves as before (baseline)", free && `${free.provider}/${free.model}` === "alpha/gpt-4o-mini", JSON.stringify(free))
    eq("routeReconsider + FORGE_LOCK_MODEL=1: no move", R.routeReconsider({ config: cfg(), provider: BIG, ...ask, env: lockEnv }), null)
    eq("routeReconsider + a pinned provider: no move", R.routeReconsider({ config: cfg(), provider: { ...BIG, pinned: "/model" }, ...ask, env }), null)
    eq("routeReconsider + chain.planner: no move (it overrode your planner mid-run)", R.routeReconsider({ config: cfg({ chain: { planner: "alpha/gpt-4o" } }), provider: BIG, ...ask, env }), null)
  }

  console.log("== audit F8: a deep run keeps its reasoning model ==")
  {
    const W8 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-deep-"))
    try {
      for (let i = 0; i < 3; i++) recordRoute({ cwd: W8, klass: "LARGE", depth: "L1", model: "gpt-4o-mini", ok: true })
      const deep = R.routeRun({ config: cfg(), provider: BIG, task: HEAVY, klass: "LARGE", deep: true, cwd: W8, env })
      ok("joint never moves a deep run to a model without reasoning (it moved to gpt-4o-mini)", at(deep.provider) === "alpha/gpt-4o" && !deep.events.some((e) => e.type === "JOINT_ROUTE"), deep.trace.join(" | "))
      const shallow = R.routeRun({ config: cfg(), provider: BIG, task: HEAVY, klass: "LARGE", cwd: W8, env })
      ok("…a run that is not deep still takes the joint route (baseline)", at(shallow.provider) === "alpha/gpt-4o-mini" && shallow.events.some((e) => e.type === "JOINT_ROUTE"), shallow.trace.join(" | "))
    } finally { fs.rmSync(W8, { recursive: true, force: true }) }
    const dctl = R.routeController({ config: cfg(), provider: BIG, task: LIGHT, deep: true, env })
    ok("routeController deep: true requires reasoning (it chose gpt-4o-mini)", at(dctl.provider) === "alpha/gpt-4o" && dctl.selection?.decision?.model !== "gpt-4o-mini", JSON.stringify({ p: at(dctl.provider), sel: dctl.selected }))
    const meta = await import("../meta.js")
    const events = [], used = []
    const runAgent = async (o) => { used.push(at(o.provider)); return o.planOnly ? { text: "1. do it", toolRecords: [], commandChecks: [], toolLog: [] } : { text: "All done, complete and verified.", budgetHit: false, steps: 1, toolRecords: [], commandChecks: [], toolLog: [] } }
    await meta.runMeta({ config: cfg(), provider: BIG, task: LIGHT, runAgent, deep: true, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
    ok("runMeta deep: true passes deep to the controller — no run on gpt-4o-mini", used.length > 0 && !used.includes("alpha/gpt-4o-mini") && !events.some((e) => e.type === "MODEL_SELECTED" && e.model === "gpt-4o-mini"), used.join(", "))
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
    // audit F3: --model is an explicit choice — the router keeps it
    const pinned = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "route", LIGHT, "--model", "gpt-4o", "--json"], { cwd: WORK, encoding: "utf8", env: { PATH: process.env.PATH, HOME: H, FORGE_HOME: H, NO_COLOR: "1" } })
    let pj = null
    try { pj = JSON.parse(pinned.stdout) } catch { }
    ok("forge route --model gpt-4o: the orchestrator and every role keep gpt-4o (it was moved to gpt-4o-mini)", pj?.orchestrator?.model === "alpha/gpt-4o" && pj?.single?.model === "alpha/gpt-4o" && pj.roles.every((x) => x.model === "gpt-4o"), JSON.stringify(pj).slice(0, 400) + pinned.stderr.slice(0, 200))
    // audit F9: the preview gets the inputs the run gets (--deep, the tier)
    const dp = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "route", LIGHT, "--deep", "--json"], { cwd: WORK, encoding: "utf8", env: { PATH: process.env.PATH, HOME: H, FORGE_HOME: H, NO_COLOR: "1" } })
    let dj = null
    try { dj = JSON.parse(dp.stdout) } catch { }
    ok("forge route --deep: previews the deep run (reasoning model, deep flag shown) — it ignored --deep", dj?.deep?.orchestrator === true && dj?.deep?.single === true && dj?.orchestrator?.model === "alpha/gpt-4o" && "tier" in (dj ?? {}), JSON.stringify(dj).slice(0, 400) + dp.stderr.slice(0, 200))
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
