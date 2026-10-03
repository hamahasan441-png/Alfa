/**
 * forge — model chain (Phase 2, zero dependencies)
 *
 * Arena's Agent Mode delegates each step to "the model chain": a list of
 * models, tried in order, so one failing model does not fail the step.
 * forge already routed workers by role (crewroute.js), but only
 * automatically — you could not say which model plans, which one codes and
 * which one reviews. The chain is that setting, in ~/.forge/config.json:
 *
 *   "chain": {
 *     "planner":  "anthropic/claude-sonnet-5",   // the orchestrator itself
 *     "worker":   "deepseek/deepseek-chat",      // read-only workers
 *     "coder":    "zai/glm-5.2",                 // writers (falls back to worker)
 *     "reviewer": "openai/gpt-5.6-luna",         // reviewer / security roles
 *     "fallback": ["groq/llama-3.3-70b-versatile"]
 *   }
 *
 * Rules:
 *  - A spec is "provider/model"; the provider part is up to the FIRST slash,
 *    so "openrouter/openai/gpt-4o" is provider openrouter, model openai/gpt-4o.
 *  - A role's specs are its slot, then every fallback, in order, de-duplicated.
 *  - Listing a model in your chain IS your consent to send that step there,
 *    so the chain moves between providers without `failover: true`. That is
 *    why `chain` is a privileged section: a repository's forge.config.json can
 *    never set it (config.js PRIVILEGED_SECTIONS).
 *  - A step moves to the next spec only on a PROVIDER failure (credits, auth,
 *    rate limit, model unavailable, transport, transient, malformed). A
 *    context overflow, or the task itself failing, is not the model's fault
 *    and is returned as-is.
 *  - No chain configured → nothing changes; the crew router decides as before.
 */
import { classifyProviderFailure, PROVIDER_FAILURE } from "./diagnose.js"

export const CHAIN_SLOTS = Object.freeze(["planner", "worker", "coder", "reviewer"])

const ROLE_SLOT = {
  planner: "planner", architect: "planner",
  coder: "coder", integrator: "coder", build_engineer: "coder", language_specialist: "coder",
  debugger: "coder", performance_engineer: "coder", runtime_specialist: "coder",
  reviewer: "reviewer", security: "reviewer",
}

/** The chain slot a crew role uses. Unknown and read-only roles are workers. */
export function slotForRole(role) {
  const r = String(role ?? "").toLowerCase()
  if (CHAIN_SLOTS.includes(r)) return r
  if (ROLE_SLOT[r]) return ROLE_SLOT[r]
  if (/review|audit|security/.test(r)) return "reviewer"
  if (/code|fix|patch|write|refactor|debug|integrat/.test(r)) return "coder"
  if (/plan|architect/.test(r)) return "planner"
  return "worker"
}

/** "provider/model" → { provider, model }, or null when it is not one. */
export function parseSpec(raw) {
  const s = String(raw ?? "").trim()
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return null
  return { provider: s.slice(0, i), model: s.slice(i + 1) }
}

export const specLabel = (s) => (s ? `${s.provider}/${s.model}` : "")

/** Is any chain slot or fallback configured? */
export function hasChain(config) {
  const c = config?.chain
  if (!c || typeof c !== "object") return false
  return CHAIN_SLOTS.some((k) => parseSpec(c[k])) || (Array.isArray(c.fallback) && c.fallback.some((f) => parseSpec(f)))
}

/** Problems with the chain setting, for `forge chain` and doctor. */
export function validateChain(config) {
  const c = config?.chain
  const problems = []
  if (c == null) return problems
  if (typeof c !== "object" || Array.isArray(c)) return ["chain must be an object"]
  for (const [k, v] of Object.entries(c)) {
    if (k === "fallback") {
      if (!Array.isArray(v)) { problems.push("chain.fallback must be a list of provider/model"); continue }
      v.forEach((f, i) => { if (!parseSpec(f)) problems.push(`chain.fallback[${i}] "${f}" is not provider/model`) })
    } else if (!CHAIN_SLOTS.includes(k)) problems.push(`chain.${k} is not a slot (use ${CHAIN_SLOTS.join(", ")}, fallback)`)
    else if (v != null && v !== "" && !parseSpec(v)) problems.push(`chain.${k} "${v}" is not provider/model`)
  }
  return problems
}

/**
 * Ordered specs for a role or slot: its slot (coder → worker when unset),
 * then the fallbacks. When the slot is unset and `primary` (the provider the
 * run would use anyway) is given, it goes first, so a fallback-only chain
 * means "this model, then these". Empty when no chain applies.
 */
export function chainSpecs(config, roleOrSlot, { primary = null } = {}) {
  if (!hasChain(config)) return []
  const c = config.chain
  const slot = slotForRole(roleOrSlot)
  const own = parseSpec(c[slot])
  const first = own ?? (slot === "coder" ? parseSpec(c.worker) : null)
  const out = []
  const push = (s, from, prov = null) => { if (s && !out.some((o) => o.provider === s.provider && o.model === s.model)) out.push({ ...s, slot: from, ...(prov ? { prov } : {}) }) }
  if (first) push(first, own ? slot : "worker")
  else if (primary?.name && primary?.model) push({ provider: primary.name, model: primary.model }, "active", primary)
  else return [] // no slot and nothing to put before the fallbacks: the chain does not cover this role
  for (const f of Array.isArray(c.fallback) ? c.fallback : []) push(parseSpec(f), "fallback")
  // a lone "active" entry is no chain at all
  if (out.length === 1 && out[0].slot === "active") return []
  return out
}

/** A runnable provider for one spec: buildProvider + the spec's model. */
export function providerForSpec(config, spec, build) {
  if (spec.prov) return { provider: spec.prov, why: null }
  const p = build(config, spec.provider)
  if (!p) return { provider: null, why: `provider "${spec.provider}" is not usable — unknown, or no API key (forge config set providers.${spec.provider}.apiKey <KEY>)` }
  return { provider: { ...p, model: spec.model }, why: null }
}

/** Should a step move to the next spec after this error / result? */
export function isChainWorthy(errOrResult) {
  if (!errOrResult) return false
  const looksLikeResult = typeof errOrResult === "object" && "status" in errOrResult && !(errOrResult instanceof Error)
  if (looksLikeResult) {
    if (errOrResult.status !== "ERROR") return false
    errOrResult = errOrResult.error ?? errOrResult.text ?? ""
  }
  const f = classifyProviderFailure(errOrResult)
  return Boolean(f) && f.class !== PROVIDER_FAILURE.CONTEXT_OVERFLOW
}

/**
 * Run one step along the chain.
 * @param {object}   o
 * @param {object}   o.config
 * @param {string}   o.role      crew role or slot
 * @param {Function} o.run       async (provider, spec) → result (may throw)
 * @param {Function} o.build     buildProvider(config, name)
 * @param {Function} [o.onSwitch] ({ from, to, why }) — a step moved on
 * @returns {Promise<{ result, used: object|null, tried: object[], chained: boolean }>}
 *          chained=false means no chain applies (the caller runs as before).
 */
export async function runOnChain({ config, role, run, build, onSwitch = null, primary = null } = {}) {
  const specs = chainSpecs(config, role, { primary })
  if (!specs.length) return { result: null, used: null, tried: [], chained: false }
  const tried = []
  let lastErr = null, lastResult = null
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const { provider, why } = providerForSpec(config, spec, build)
    if (!provider) { tried.push({ spec: specLabel(spec), skipped: why }); continue }
    try {
      const result = await run(provider, spec)
      if (isChainWorthy(result) && i < specs.length - 1) {
        lastResult = result
        tried.push({ spec: specLabel(spec), failed: String(result.error ?? "provider error").slice(0, 160) })
        onSwitch?.({ from: specLabel(spec), to: specLabel(specs[i + 1]), why: String(result.error ?? "").slice(0, 160) })
        continue
      }
      tried.push({ spec: specLabel(spec), ok: true })
      return { result, used: spec, tried, chained: true }
    } catch (e) {
      if (e?.name === "AbortError") throw e
      if (!isChainWorthy(e)) throw e // the task's own failure, not the model's
      lastErr = e
      tried.push({ spec: specLabel(spec), failed: String(e?.message ?? e).slice(0, 160) })
      if (i < specs.length - 1) onSwitch?.({ from: specLabel(spec), to: specLabel(specs[i + 1]), why: String(e?.message ?? e).slice(0, 160) })
    }
  }
  if (lastResult) return { result: lastResult, used: null, tried, chained: true }
  const e = lastErr ?? new Error(`no model in the chain for "${role}" is usable: ${tried.map((t) => `${t.spec} (${t.skipped ?? t.failed})`).join("; ")}`)
  e.chainTried = tried
  throw e
}

/** One row per slot for `forge chain`: which spec, and whether it is usable. */
export function describeChain(config, build) {
  return CHAIN_SLOTS.map((slot) => {
    const specs = chainSpecs(config, slot)
    return {
      slot,
      specs: specs.map((s) => {
        const { provider, why } = providerForSpec(config, s, build)
        return { spec: specLabel(s), from: s.slot, usable: Boolean(provider), why }
      }),
    }
  })
}
