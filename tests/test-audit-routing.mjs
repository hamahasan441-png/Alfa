#!/usr/bin/env node
/**
 * forge — routing audit regressions (model and provider routing).
 *
 * The router (modelroute.js) is pinned by test-modelroute.mjs. This suite
 * covers what happens AROUND it, in the agent loop and the displays:
 *   F3  an explicit choice (--model / --provider / /model) is marked pinned
 *   F4  a route switch is visible (TUI, web chat, CLI printer), persisted, and
 *       in the run's routing record
 *   F5  the failover chain is built from the provider that actually runs, and
 *       includes the one you started on
 *   F6  a conversation with images never fails over to a model that cannot
 *       read them
 *   F7  the joint ledger credits the model that ran, not a model it scored
 * Local HTTP servers stand in for providers. Zero external network.
 */
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-routing-"))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_LOCK_MODEL
delete process.env.FORGE_FAILOVER
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-routing-work-"))
process.chdir(WORK)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}

const { buildProvider, providerCompatible, nextCompatibleFallback } = await import("../providers.js")
const { runAgent, agentEventPrinter } = await import("../agent.js")
const { recordRoute, loadJoint } = await import("../jointroute.js")
const U = await import("../uistate.js")
const W = await import("../webchat.js")

function listen(handler) {
  const srv = http.createServer(handler)
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv)))
}
const answer = (content) => JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
const answering = (text) => listen((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(answer(text)) })
})
// 401: failover-worthy and not retryable — fails fast
const bad = await listen((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"invalid api key (mock)"}}') })
const alphaSrv = await answering("ANSWER-FROM-ALPHA")
const noVisSrv = await answering("ANSWER-FROM-NOVISION")
const visSrv = await answering("ANSWER-FROM-VISION")
const base = (s) => `http://127.0.0.1:${s.address().port}/v1`
// 503: a temporary outage — retryable
const down = await listen((req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":{"message":"overloaded (mock)"}}') })
const servers = [bad, alphaSrv, noVisSrv, visSrv, down]

try {
  console.log("== F3: an explicit choice is marked pinned ==")
  {
    const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
    const forge = src("forge.js"), chat = src("chat.js")
    ok("forge.js resolveProvider marks --model / --provider as pinned", /f\.model \? "--model" : f\.provider \? "--provider"/.test(forge) && /\.\.\.\(pinned \? \{ pinned \} : \{\}\)/.test(forge))
    ok("chat.js /model and /provider mark the provider pinned", /p\.pinned = "\/model"/.test(chat) && /p\.pinned = "\/provider"/.test(chat))
    // and the pin reaches a real run: a pinned run is never routed
    const W3 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-pin-"))
    const prev = process.cwd()
    try {
      process.chdir(W3)
      for (let i = 0; i < 4; i++) recordRoute({ cwd: W3, klass: "SMALL", model: "gpt-4o-mini", ok: true })
      const config = { providers: { alpha: { protocol: "openai", baseUrl: base(alphaSrv), apiKey: "k", model: "gpt-4o", models: ["gpt-4o-mini"] } }, agent: { maxSteps: 3, timeoutSec: 5 }, skills: { enabled: false } }
      const ev1 = [], ev2 = []
      const pinned = { ...buildProvider(config, "alpha"), pinned: "--model" }
      // baseline first: a finished run records its own outcome, which would
      // otherwise tilt the history this baseline relies on
      await runAgent({ config, provider: buildProvider(config, "alpha"), task: "fix the off-by-one bug in the pagination helper", onEvent: (e) => ev2.push(e), journal: false })
      ok("a run NOT pinned is routed (baseline)", ev2.some((e) => e.type === "JOINT_ROUTE" || (e.type === "MODEL_SELECTED" && e.switched !== false)), JSON.stringify(ev2.filter((e) => /MODEL|JOINT/.test(e.type))))
      await runAgent({ config, provider: pinned, task: "fix the off-by-one bug in the pagination helper", onEvent: (e) => ev1.push(e), journal: false })
      ok("…the same run with a pinned provider (--model): no MODEL_SELECTED switch, no JOINT_ROUTE", !ev1.some((e) => e.type === "JOINT_ROUTE" || (e.type === "MODEL_SELECTED" && e.switched !== false)), JSON.stringify(ev1.filter((e) => /MODEL|JOINT/.test(e.type))))
    } finally { process.chdir(prev); fs.rmSync(W3, { recursive: true, force: true }) }
  }

  console.log("== F4: a route switch is visible and recorded ==")
  {
    const joint = { type: "JOINT_ROUTE", from: "alpha/gpt-4o", to: "alpha/gpt-4o-mini", depth: "L2", why: "measured combo" }
    const sel = { type: "MODEL_SELECTED", from: "alpha/gpt-4o", to: "alpha/gpt-4o-mini", provider: "alpha", model: "gpt-4o-mini", reason: "fast + cheap", confidence: "high" }
    const dispatched = []
    U.bridgeAgentEvent({ dispatch: (x) => dispatched.push(x), getState: () => U.initialState() }, joint)
    ok("TUI: JOINT_ROUTE becomes a notice and moves the dock's model", dispatched.some((x) => x.type === "NOTICE" && /gpt-4o-mini/.test(x.text)) && dispatched.some((x) => x.type === "PROVIDER_CHANGED" && x.provider === "alpha" && x.model === "gpt-4o-mini"), JSON.stringify(dispatched))
    const slashed = []
    U.bridgeAgentEvent({ dispatch: (x) => slashed.push(x), getState: () => U.initialState() }, { ...joint, to: "openrouter/meta-llama/llama-3" })
    ok("…a model id with a slash survives", slashed.some((x) => x.type === "PROVIDER_CHANGED" && x.provider === "openrouter" && x.model === "meta-llama/llama-3"), JSON.stringify(slashed))
    const a = W.activityOf(joint)
    ok("web chat: JOINT_ROUTE is a line on the page", a && a.kind === "info" && /alpha\/gpt-4o → alpha\/gpt-4o-mini/.test(a.detail), JSON.stringify(a))
    const printed = []
    const orig = console.log
    console.log = (...x) => printed.push(x.join(" "))
    try { const pr = agentEventPrinter(); pr(joint); pr(sel); pr({ ...sel, switched: false, from: "alpha/gpt-4o-mini" }) } finally { console.log = orig }
    ok("CLI printer: JOINT_ROUTE and a switching MODEL_SELECTED each print one line", printed.length === 2 && /model route: alpha\/gpt-4o → alpha\/gpt-4o-mini/.test(printed[0]) && /alpha\/gpt-4o → alpha\/gpt-4o-mini/.test(printed[1]), JSON.stringify(printed))
    const core = fs.readFileSync(path.join(ROOT, "core.js"), "utf8").match(/PERSISTED_EVENT_RE = \/(.*)\/\n/)?.[1]
    ok("core.js persists JOINT_ROUTE and MODEL_SELECTED", core && new RegExp(core).test("JOINT_ROUTE") && new RegExp(core).test("MODEL_SELECTED"), core)
  }

  console.log("== F5: failover after a cross-provider route ==")
  {
    // you start on alpha/gpt-4o; history routes SMALL tasks to beta's
    // deepseek-chat (failover consent is on); beta then fails
    const W5 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-f5-"))
    const prev = process.cwd()
    try {
      process.chdir(W5)
      for (let i = 0; i < 4; i++) recordRoute({ cwd: W5, klass: "SMALL", model: "deepseek-chat", ok: true })
      const config = {
        failover: true,
        providers: {
          alpha: { protocol: "openai", baseUrl: base(alphaSrv), apiKey: "k1", model: "gpt-4o" },
          beta: { protocol: "openai", baseUrl: base(bad), apiKey: "k2", model: "deepseek-chat" },
        },
        agent: { maxSteps: 4, timeoutSec: 5 },
        skills: { enabled: false },
      }
      const events = []
      let r = null, err = null
      try { r = await runAgent({ config, provider: buildProvider(config, "alpha"), task: "fix the off-by-one bug in the pagination helper", onEvent: (e) => events.push(e), journal: false }) } catch (e) { err = e }
      const routed = events.find((e) => e.type === "JOINT_ROUTE" || (e.type === "MODEL_SELECTED" && e.switched !== false && e.provider === "beta"))
      ok("(the run was routed to beta first)", Boolean(routed), JSON.stringify(events.filter((e) => /MODEL|JOINT/.test(e.type))))
      const fo = events.filter((e) => e.type === "failover")
      ok("beta fails → failover goes to alpha, the provider you started on (it went back to beta)", fo.length >= 1 && /^alpha\//.test(fo[0].to), JSON.stringify(fo) + " " + (err?.message ?? ""))
      ok("…and the run is answered by alpha", /ANSWER-FROM-ALPHA/.test(r?.text ?? ""), (r?.text ?? err?.message ?? "").slice(0, 200))
      // F4: the route switch is in the run's routing record, before the failover
      const rec = r?.routing ?? []
      ok("F4: the routing record holds the route switch AND the failover, in order", rec.length >= 2 && rec[0].class === "route" && /^beta\//.test(rec[0].to) && rec[0].outcome.startsWith("failed") && /^alpha\//.test(rec[1].to), JSON.stringify(rec))
    } finally { process.chdir(prev); fs.rmSync(W5, { recursive: true, force: true }) }
  }

  console.log("== review: running out of failover keeps an outage retryable ==")
  {
    // the only fallback cannot read the conversation's image, so failover has
    // nowhere to go. A 503 is still a temporary outage: marking it
    // non-retryable made the controller give up at once with failover ON,
    // while the same outage with failover OFF got repair attempts.
    const mk = (startUrl) => ({
      failover: true,
      retry: { attempts: 1, backoffMs: 5 },
      providers: {
        start: { protocol: "openai", baseUrl: startUrl, apiKey: "k0", model: "gpt-4o" },
        novis: { protocol: "openai", baseUrl: base(noVisSrv), apiKey: "k1", model: "deepseek-chat" },
      },
      agent: { maxSteps: 3, timeoutSec: 5 },
      skills: { enabled: false },
    })
    const continueFrom = { task: "describe the screenshot", steps: 1, messages: [
      { role: "user", content: [{ type: "text", text: "what is in this screenshot?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
      { role: "assistant", content: "Let me look." },
    ] }
    const run = async (url) => { const config = mk(url); try { await runAgent({ config, provider: { ...buildProvider(config, "start"), pinned: "--model" }, task: "describe the screenshot", continueFrom, journal: false }); return null } catch (e) { return e } }
    const e503 = await run(base(down))
    ok("503 + no usable fallback → the error stays retryable", e503 && /failover stopped/.test(e503.message) && e503.retryable === true, `${e503?.message} retryable=${e503?.retryable}`)
    const e401 = await run(base(bad))
    ok("401 + no usable fallback → still not retryable", e401 && /failover stopped/.test(e401.message) && e401.retryable === false, `${e401?.message} retryable=${e401?.retryable}`)
  }

  console.log("== F6: images need a vision-capable failover target ==")
  {
    const novis = { name: "novis", protocol: "openai", baseUrl: base(noVisSrv), model: "deepseek-chat" }
    const vis = { name: "vis", protocol: "openai", baseUrl: base(visSrv), model: "gpt-4o-mini" }
    ok("providerCompatible: no images → a non-vision model is fine", providerCompatible(novis, { promptTokens: 100, tools: true }).ok === true)
    const c = providerCompatible(novis, { promptTokens: 100, tools: true, vision: true })
    ok("providerCompatible: images → a non-vision model is rejected with a reason", c.ok === false && /cannot read images/.test(c.reason), JSON.stringify(c))
    const pick = nextCompatibleFallback([novis, vis], 0, { promptTokens: 100, tools: true, vision: true })
    ok("nextCompatibleFallback skips it and takes the vision model", pick.next?.name === "vis" && pick.skipped[0]?.name === "novis", JSON.stringify(pick))
    // the real loop: a conversation that carries an image, then the provider fails
    const config = {
      failover: true,
      providers: {
        start: { protocol: "openai", baseUrl: base(bad), apiKey: "k0", model: "gpt-4o" },
        novis: { protocol: "openai", baseUrl: base(noVisSrv), apiKey: "k1", model: "deepseek-chat" },
        vis: { protocol: "openai", baseUrl: base(visSrv), apiKey: "k2", model: "gpt-4o-mini" },
      },
      agent: { maxSteps: 4, timeoutSec: 5 },
      skills: { enabled: false },
    }
    const continueFrom = {
      task: "describe the screenshot",
      steps: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: "what is in this screenshot?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
        { role: "assistant", content: "Let me look at it." },
      ],
    }
    const events = []
    let r = null, err = null
    // pinned: the start provider is your choice, so routing does not move it
    // away before the failure; failover still applies (consent is on)
    try { r = await runAgent({ config, provider: { ...buildProvider(config, "start"), pinned: "--model" }, task: "describe the screenshot", continueFrom, onEvent: (e) => events.push(e), journal: false }) } catch (e) { err = e }
    const skipped = events.filter((e) => e.type === "failover_skipped")
    ok("runAgent: the non-vision fallback is skipped with a reason (it was taken)", skipped.some((e) => /^novis\//.test(e.to) && /cannot read images/.test(e.reason)), JSON.stringify(skipped) + " " + JSON.stringify(events.filter((e) => e.type === "failover")))
    ok("…and the vision-capable one answers", /ANSWER-FROM-VISION/.test(r?.text ?? ""), (r?.text ?? err?.message ?? "").slice(0, 200))
    const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
    ok("on failover the vision context is refreshed to the model that runs", /p = next\n[\s\S]{0,300}tools\.ctx\.visionProvider = \{ protocol: p\.protocol, model: p\.model/.test(agentSrc))
  }

  console.log("== F7: the joint ledger credits the model that ran ==")
  {
    const { createCognition } = await import("../cognition.js")
    const W7 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-f7-"))
    try {
      for (const k of ["SMALL", "MEDIUM", "LARGE", "ARCHITECTURAL"]) for (let i = 0; i < 4; i++) recordRoute({ cwd: W7, klass: k, model: "never-ran-model", ok: true })
      const cog = createCognition({ cwd: W7, objective: "add input validation to the signup handler in api/users.js and update its tests" })
      cog.next({ steps: 1, writes: 0, inspected: true, hasPlan: true, failed: false, model: "ran-model" })
      cog.close({})
      const rows = Object.values(loadJoint(W7).byKlass).flatMap((row) => Object.values(row))
      const never = rows.filter((x) => x.model === "never-ran-model")
      ok("a model that never ran gets no new sample (it was credited)", never.length > 0 && never.every((x) => x.samples === 4), JSON.stringify(never))
      ok("the model that ran is credited", rows.some((x) => x.model === "ran-model" && x.samples === 1), JSON.stringify(rows.map((x) => [x.model, x.samples])))
    } finally { fs.rmSync(W7, { recursive: true, force: true }) }
    const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
    ok("agent.js passes the running model to cognition.next()", /cognition\.next\(\{[\s\S]{0,400}model: p\?\.model/.test(agentSrc))
  }
} finally {
  for (const s of servers) s.close()
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.rmSync(WORK, { recursive: true, force: true })
}

console.log(`\n== audit-routing suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
