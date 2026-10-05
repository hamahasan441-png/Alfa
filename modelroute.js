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
 *   2. your lock         FORGE_LOCK_MODEL, agent.modelStrategy: false
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

export const ROUTE_ORDER = Object.freeze(["chain", "lock", "inherited", "measured", "joint", "active"])

const label = (p) => (p ? `${p.name ?? "?"}/${p.model ?? "?"}` : "?")

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
  if (routedBy) {
    events.push({ type: "MODEL_INHERITED", routedBy: String(routedBy), provider: p?.name ?? null, model: p?.model ?? null })
    trace.push(`inherited: ${label(p)} — routed by ${routedBy}`)
  }
  if (readonly) trace.push("measured: skipped — read-only run")
  else if (routedBy) trace.push("measured: skipped — the caller already routed this run")
  else if (config?.agent?.modelStrategy === false) trace.push("measured: off (agent.modelStrategy: false)")
  else if (env?.FORGE_LOCK_MODEL === "1") trace.push("measured: off (FORGE_LOCK_MODEL=1)")
  else {
    try {
      const choice = applyModelChoice({ config, provider: p, task, klass, lock: Boolean(env?.FORGE_LOCK_MODEL), deep: deep === true })
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
  if (readonly) trace.push("joint: skipped — read-only run")
  else if (klass === "MICRO") trace.push("joint: skipped — MICRO keeps the caller's model")
  else if (env?.FORGE_LOCK_MODEL === "1") trace.push("joint: off (FORGE_LOCK_MODEL=1)")
  else {
    try {
      const joint = scoreRoute({ cwd, klass, task, model: p.model, lockModel: false })
      if (joint.model && joint.model !== p.model && joint.source === "joint") {
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
export function routeController({ config, provider, task = "", resources = null, build = buildProvider } = {}) {
  const trace = []
  const notices = []
  const lane = resolveLane({ task, resources })
  const sel = selectModel(config, { task, provider, latencyBudgetMs: lane.latencyBudgetMs, costBias: lane.costBias })
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
    let prov = provider
    let switched = false
    if (d.provider !== provider?.name) {
      try {
        const np = build(config, d.provider)
        if (np && np.model) { prov = { ...np, model: d.model }; switched = true }
      } catch { }
    }
    trace.push(`measured: ${d.provider}/${d.model} — ${d.reason}`)
    return {
      provider: prov, switched, capabilities, lane, notices, trace, selection: sel,
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
export async function routeRole({ config, provider, role, task = "", build } = {}) {
  const trace = []
  let chained = false
  try { chained = chainSpecs(config, role).some((x) => x.slot !== "fallback") } catch { chained = false }
  if (chained) { trace.push(`chain: chain.${role} covers this role`); return { provider, routed: null, chained, trace } }
  if (config?.agent?.crewRouting === false) { trace.push("measured: off (agent.crewRouting: false)"); return { provider, routed: null, chained, trace } }
  try {
    const cls = preferredClassFor(role)
    const rsel = selectModel(config, { task, preferredClass: cls })
    const d = rsel?.decision
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
export function routeReconsider({ config, provider, task = "", failures = 0, failureKind = null, preferredClass = null } = {}) {
  const decision = reconsiderModel(config, {
    task, provider: { name: provider?.name, model: provider?.model },
    failures, failureKind, resourceLimits: { preferredClass: preferredClass ?? "fast_reasoning" },
  })
  if (!decision) return null
  if (decision.provider === provider?.name && decision.model === provider?.model) return null
  if (decision.provider !== provider?.name && !mayRouteAcrossProviders(config)) return null
  return decision
}
