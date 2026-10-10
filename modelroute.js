/**
 * forge — which model runs this? (one router)
 *
 * Before this module the answer was spread over five places that each held
 * a piece of the rule: agent.js (measured choice, then the joint route),
 * meta.js (the orchestrator's own model, each worker role's model, the
 * mid-run reconsider), chain.js, crewroute.js, modelstrategy.js and
 * jointroute.js. This module is now the only place that DECIDES. The scorers
 * stay where their data is — they are inputs, not routers:
 *
 *   modelstrategy.selectModel   measured success per model and task class
 *   jointroute.scoreRoute       a cheaper (depth, model, skill) combo that did
 *                               as well, from measured history
 *   crewroute.preferredClassFor which capability class a worker role wants
 *   chain.chainSpecs            the models YOU assigned (chain.<slot>)
 *
 * THE ORDER, highest first — every decision below follows it:
 *
 *   1. your chain        chain.planner / chain.<role>: your explicit choice
 *   2. your lock         a provider/model you chose explicitly (--model,
 *                        --provider, /model: provider.pinned),
 *                        FORGE_LOCK_MODEL, agent.modelStrategy: false
 *   3. inherited         a sub-run the orchestrator already routed keeps
 *                        that model (one routing decision per task)
 *   4. measured          the measured-best model for this task / role
 *   5. joint             a cheaper combination that measured as well
 *   6. active            the provider/model you started with
 *
 * And one consent rule over all of it: moving the conversation to ANOTHER
 * provider needs failover consent (failover: true / FORGE_FAILOVER=1).
 *
 * Every function returns what it decided AND why, as `trace` lines — the
 * same lines `forge route` prints — and leaves side effects (events, task
 * records, rebuilding a manager) to the caller.
 */
import { applyModelChoice, selectModel, reconsiderModel, resolveLane, mayRouteAcrossProviders } from "./modelstrategy.js"
import { preferredClassFor } from "./crewroute.js"
import { scoreRoute } from "./jointroute.js"
import { chainSpecs, providerForSpec, specLabel } from "./chain.js"
import { buildProvider } from "./providers.js"
import { lookupRegistry } from "./modelregistry.js"

export const ROUTE_ORDER = Object.freeze(["chain", "lock", "inherited", "measured", "joint", "active"])

const label = (p) => (p ? `${p.name ?? "?"}/${p.model ?? "?"}` : "?")

// ---- rank 2: your lock -----------------------------------------------------------

/**
 * FORGE_LOCK_MODEL, read ONE way everywhere. "1" / "true" / "yes" (any case)
 * lock; "0", "false", "" and anything else do not. It used to be read two
 * ways in one function — `=== "1"` for one check and `Boolean(...)` for the
 * next — so "true" locked the measured choice but not the joint route, and
 * "0" counted as locked.
 */
export function lockModelEnv(env = process.env) {
  const v = String(env?.FORGE_LOCK_MODEL ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

/**
 * Rank 2 of ROUTE_ORDER — why the model must not be changed, or null.
 *   - the provider was chosen explicitly (`provider.pinned`: "--model",
 *     "--provider", "/model", …) — your explicit choice stays authoritative
 *   - FORGE_LOCK_MODEL is on
 *   - agent.modelStrategy: false
 * Every router asks this one helper. Failover is NOT routing: it still moves a
 * failing run, under the failover consent rule alone.
 */
export function locked(config, env = process.env, provider = null) {
  if (provider?.pinned) return `you chose ${label(provider)} (${provider.pinned})`
  if (lockModelEnv(env)) return "FORGE_LOCK_MODEL is on"
  if (config?.agent?.modelStrategy === false) return "agent.modelStrategy: false"
  return null
}

/** A deep run needs a model the registry says can reason. An unknown model is
 *  not rejected — no entry is no claim (same rule as selectModel/failover). */
function lacksReasoning(model) {
  const reg = lookupRegistry(model)
  return Boolean(reg?.capabilities) && !reg.capabilities.includes("reasoning")
}

// ---- a run of the agent loop ---------------------------------------------------

/**
 * The model one agent-loop run uses.
 *
 * @returns {{ provider, events: object[], trace: string[] }}  events are what
 *   agent.js emits (it adds its own identity fields), in order.
 */
export function routeRun({ config, provider, task = "", klass = "", deep = false, readonly = false, routedBy = null, env = process.env, cwd = process.cwd(), build = buildProvider, onError = null } = {}) {
  let p = provider
  const events = []
  const trace = []
  const lock = locked(config, env, p)
  if (routedBy) {
    events.push({ type: "MODEL_INHERITED", routedBy: String(routedBy), provider: p?.name ?? null, model: p?.model ?? null })
    trace.push(`inherited: ${label(p)} — routed by ${routedBy}`)
  }
  if (readonly) trace.push("measured: skipped — read-only run")
  else if (routedBy) trace.push("measured: skipped — the caller already routed this run")
  else if (lock) trace.push(`measured: off — lock: ${lock}`)
  else {
    try {
      const choice = applyModelChoice({ config, provider: p, task, klass, lock: false, deep: deep === true })
      if (choice.switched && choice.provider) {
        events.push({
          type: "MODEL_SELECTED",
          from: label(p), to: label(choice.provider),
          provider: choice.provider.name, model: choice.provider.model,
          reason: choice.why, why: choice.why,
          confidence: choice.selection?.decision?.confidence ?? null,
        })
        trace.push(`measured: ${label(p)} → ${label(choice.provider)} — ${choice.why}`)
        p = choice.provider
      } else {
        if (choice.selection?.decision) {
          events.push({
            type: "MODEL_SELECTED",
            from: label(p), to: label(p),
            provider: p.name, model: p.model,
            reason: choice.why, why: choice.why,
            confidence: choice.selection.decision.confidence,
            switched: false,
          })
        }
        trace.push(`measured: kept ${label(p)} — ${choice.why}`)
      }
    } catch (e) { onError?.("model strategy", e); trace.push(`measured: error — ${e?.message ?? e}`) }
  }
  // The joint route is a model choice like the measured one, under the same
  // rules. It used to skip neither of these: a sub-run the orchestrator had
  // routed could still be moved (so the model it tracked outcomes for was not
  // the one that ran), and agent.modelStrategy: false did not stop it.
  if (readonly) trace.push("joint: skipped — read-only run")
  else if (routedBy) trace.push("joint: skipped — the caller already routed this run")
  else if (lock) trace.push(`joint: off — lock: ${lock}`)
  else if (klass === "MICRO") trace.push("joint: skipped — MICRO keeps the caller's model")
  else {
    try {
      const joint = scoreRoute({ cwd, klass, task, model: p.model, lockModel: false })
      // A deep run keeps the reasoning requirement the measured step enforces
      // (selectModel's requireCapabilities): the joint route used to undo it,
      // moving a --deep run onto a fast, non-reasoning model.
      if (deep === true && joint.model && joint.model !== p.model && joint.source === "joint" && lacksReasoning(joint.model)) {
        trace.push(`joint: wanted ${joint.model}, but a deep run needs a reasoning model — kept ${label(p)}`)
      } else if (joint.model && joint.model !== p.model && joint.source === "joint") {
        const specs = config?.providers || {}
        const crossOk = mayRouteAcrossProviders(config)
        let moved = false
        for (const name of Object.keys(specs)) {
          if (name !== p.name && !crossOk) continue
          const spec = specs[name] || {}
          const models = [spec.model, ...(spec.models || [])].filter(Boolean)
          if (!models.includes(joint.model)) continue
          const built = build(config, name)
          if (!built) continue
          events.push({ type: "JOINT_ROUTE", from: label(p), to: `${name}/${joint.model}`, depth: joint.depth, why: joint.why })
          trace.push(`joint: ${label(p)} → ${name}/${joint.model} — ${joint.why}`)
          p = { ...built, model: joint.model }
          moved = true
          break
        }
        if (!moved) trace.push(`joint: wanted ${joint.model}, but no configured provider${crossOk ? "" : " you allowed (failover consent)"} offers it`)
      } else trace.push(`joint: no cheaper combination measured${joint.why ? ` — ${joint.why}` : ""}`)
    } catch (e) { onError?.("joint route", e); trace.push(`joint: error — ${e?.message ?? e}`) }
  }
  trace.push(`→ ${label(p)}`)
  return { provider: p, events, trace }
}

// ---- the orchestrator's own model ------------------------------------------------

/**
 * The orchestrator's model for a task.
 *
 * @returns {{ provider, switched: boolean, selected: object|null, note: [name, model, why],
 *   notices: string[], capabilities, lane, selection, trace: string[] }}
 *   `selected` is the MODEL_SELECTED event body (null: none is emitted);
 *   `note` is what the task record says ran.
 */
export function routeController({ config, provider, task = "", resources = null, deep = false, env = process.env, build = buildProvider } = {}) {
  const trace = []
  const notices = []
  // deep: true is the person's --deep; anything else leaves the lane to the
  // task's own complexity, as before
  const lane = deep === true ? resolveLane({ task, resources, deep: true }) : resolveLane({ task, resources })
  const sel = selectModel(config, { task, provider, latencyBudgetMs: lane.latencyBudgetMs, costBias: lane.costBias, requireCapabilities: deep === true ? ["reasoning"] : [] })
  const capabilities = sel?.capabilities ?? null
  const crossBlocked = Boolean(sel?.decision) && sel.decision.provider !== provider?.name && !mayRouteAcrossProviders(config)
  const strategyOn = config?.agent?.modelStrategy !== false

  let chainPlanner = null
  try {
    const specs = chainSpecs(config, "planner").filter((s) => s.slot === "planner")
    if (specs.length) {
      const { provider: pp, why } = providerForSpec(config, specs[0], build)
      if (pp) chainPlanner = { prov: pp, label: specLabel(specs[0]) }
      else notices.push(`chain.planner ${specLabel(specs[0])} not used — ${why}`)
    }
  } catch { chainPlanner = null }

  if (chainPlanner) {
    trace.push(`chain: chain.planner ${chainPlanner.label}`)
    return {
      provider: chainPlanner.prov, switched: true, capabilities, lane, notices, trace, selection: sel,
      selected: { model: chainPlanner.prov.model, provider: chainPlanner.prov.name, reason: "chain.planner (your model chain)", confidence: 1, capabilities },
      note: [chainPlanner.prov.name, chainPlanner.prov.model, "chain.planner"],
    }
  }
  // rank 2: your lock — the active provider, nothing announced, nothing moved
  const lock = locked(config, env, provider)
  if (lock) {
    trace.push(`lock: kept ${label(provider)} — ${lock}`)
    return { provider, switched: false, capabilities, lane, notices, trace, selection: sel, selected: null, note: [provider?.name ?? "?", provider?.model ?? "?", "active provider"] }
  }
  if (crossBlocked && strategyOn) {
    const why = `kept the active provider — measured-best ${sel.decision.provider}/${sel.decision.model} needs failover consent to route to`
    trace.push(`measured: ${why}`)
    return {
      provider, switched: false, capabilities, lane, notices, trace, selection: sel,
      selected: { model: provider?.model ?? null, provider: provider?.name ?? null, reason: why, confidence: sel.decision.confidence, capabilities: sel.decision.capabilities },
      note: [provider?.name ?? "?", provider?.model ?? "?", "active provider (cross-provider routing needs failover consent)"],
    }
  }
  if (sel?.decision && strategyOn) {
    const d = sel.decision
    // What is announced is what runs. A measured-best model at the SAME
    // provider used to be announced (MODEL_SELECTED, the task record) while
    // the run stayed on the old model: only another provider was ever built.
    let prov = null
    if (d.provider === provider?.name) prov = d.model === provider?.model ? provider : { ...provider, model: d.model }
    else {
      try { const np = build(config, d.provider); if (np && np.model) prov = { ...np, model: d.model } } catch { }
    }
    if (!prov) {
      const why = `kept the active provider — measured-best ${d.provider}/${d.model} could not be built`
      trace.push(`measured: ${why}`)
      return {
        provider, switched: false, capabilities, lane, notices, trace, selection: sel,
        selected: { model: provider?.model ?? null, provider: provider?.name ?? null, reason: why, confidence: d.confidence, capabilities: d.capabilities },
        note: [provider?.name ?? "?", provider?.model ?? "?", "active provider (measured-best unavailable)"],
      }
    }
    trace.push(`measured: ${d.provider}/${d.model} — ${d.reason}`)
    return {
      provider: prov, switched: prov !== provider, capabilities, lane, notices, trace, selection: sel,
      selected: { model: d.model, provider: d.provider, reason: d.reason, confidence: d.confidence, capabilities: d.capabilities },
      note: [d.provider, d.model, d.reason],
    }
  }
  trace.push(`active: ${label(provider)}${strategyOn ? "" : " (agent.modelStrategy: false)"}`)
  return { provider, switched: false, capabilities, lane, notices, trace, selection: sel, selected: null, note: [provider?.name ?? "?", provider?.model ?? "?", "active provider"] }
}

// ---- a worker role --------------------------------------------------------------

/**
 * The model a worker ROLE runs on, before its chain (if any) takes over.
 * A role your chain covers is decided by the chain at run time; this
 * returns the provider the chain starts from.
 *
 * @param build  async (config, name) → provider | null  (the caller caches)
 * @returns {Promise<{ provider, routed: {provider, model, class}|null, chained: boolean, trace: string[] }>}
 */
export async function routeRole({ config, provider, role, task = "", build, env = process.env } = {}) {
  const trace = []
  let chained = false
  try { chained = chainSpecs(config, role).some((x) => x.slot !== "fallback") } catch { chained = false }
  if (chained) { trace.push(`chain: chain.${role} covers this role`); return { provider, routed: null, chained, trace } }
  const lock = locked(config, env, provider)
  if (lock) { trace.push(`lock: ${role} stays on ${label(provider)} — ${lock}`); return { provider, routed: null, chained, trace } }
  if (config?.agent?.crewRouting === false) { trace.push("measured: off (agent.crewRouting: false)"); return { provider, routed: null, chained, trace } }
  try {
    const cls = preferredClassFor(role)
    const rsel = selectModel(config, { task, preferredClass: cls })
    const d = rsel?.decision
    // Same provider, another model: free (v110). It used to be ignored — a
    // role was only ever routed across providers, with failover consent.
    if (d?.provider && d.provider === provider?.name && d.model && d.model !== provider?.model) {
      trace.push(`measured: ${role} wants ${cls} → ${d.provider}/${d.model}`)
      return { provider: { ...provider, model: d.model }, routed: { provider: d.provider, model: d.model, class: cls }, chained, trace }
    }
    if (d?.provider && d.provider !== provider?.name && mayRouteAcrossProviders(config)) {
      const p = await build(config, d.provider)
      if (p) {
        trace.push(`measured: ${role} wants ${cls} → ${d.provider}/${d.model}`)
        return { provider: { ...p, model: d.model }, routed: { provider: d.provider, model: d.model, class: cls }, chained, trace }
      }
    }
    trace.push(`measured: ${role} (${cls}) stays on ${label(provider)}`)
  } catch { trace.push(`measured: error — stays on ${label(provider)}`) }
  return { provider, routed: null, chained, trace }
}

// ---- mid-run reconsider -----------------------------------------------------------

/**
 * Whether the orchestrator should move to another model mid-run (repeated
 * model-attributed failures, or the device asking for a faster model).
 * @returns the decision ({ provider, model, reason, confidence }) or null.
 */
export function routeReconsider({ config, provider, task = "", failures = 0, failureKind = null, preferredClass = null, env = process.env } = {}) {
  // rank 1 and 2 hold mid-run too: a planner your chain names, or a locked /
  // explicitly chosen model, is never swapped by a reconsider
  try { if (chainSpecs(config, "planner").some((s) => s.slot === "planner")) return null } catch { /* no chain */ }
  if (locked(config, env, provider)) return null
  const decision = reconsiderModel(config, {
    task, provider: { name: provider?.name, model: provider?.model },
    failures, failureKind, resourceLimits: { preferredClass: preferredClass ?? "fast_reasoning" },
  })
  if (!decision) return null
  if (decision.provider === provider?.name && decision.model === provider?.model) return null
  if (decision.provider !== provider?.name && !mayRouteAcrossProviders(config)) return null
  return decision
}
