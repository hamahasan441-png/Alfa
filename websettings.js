/**
 * forge — the web page's settings (used by web.js).
 *
 * Reads and writes the SAME config the terminal uses (`forge config set` goes
 * through setPath + saveConfig too), so a change made in the page is a change
 * to forge: API keys land in the keys file outside forge's folder
 * (datadir.js), everything else in config.json.
 *
 * An API key is never sent back to the page — only whether one is set and its
 * last four characters.
 */
import { CATALOG, getCatalog, buildProvider, listModels } from "./providers.js"
import { saveConfig, setPath } from "./config.js"
import { WEB_MODES } from "./webchat.js"

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/

/**
 * @param config       the live config object (changed in place)
 * @param providerRef  { get(): provider, set(provider) }
 * @param save         (config) → void   (saveConfig; injectable for tests)
 */
export function createWebSettings({ config, providerRef, save = saveConfig, version = null } = {}) {
  const hint = (k) => (k ? `…${String(k).slice(-4)}` : null)

  function get() {
    const p = providerRef.get()
    const names = new Set([...Object.keys(config.providers ?? {}), ...(p?.name ? [p.name] : [])])
    const providers = [...names].map((name) => {
      const c = config.providers?.[name] ?? {}
      const cat = getCatalog(name)
      const envKey = cat?.envKey && process.env[cat.envKey] ? cat.envKey : null
      return {
        name, label: cat?.label ?? name,
        model: c.model ?? cat?.models?.[0] ?? null,
        models: [...new Set([c.model, ...(c.models ?? []), ...(cat?.models ?? [])].filter(Boolean))],
        baseUrl: c.baseUrl ?? cat?.baseUrl ?? null, protocol: c.protocol ?? cat?.protocol ?? "openai",
        hasKey: Boolean(c.apiKey || envKey || name === "ollama"), keyHint: hint(c.apiKey), keyFromEnv: envKey,
        usable: Boolean(buildProvider(config, name)), keyUrl: cat?.keyUrl ?? null,
      }
    })
    return {
      version,
      active: { provider: p?.name ?? null, model: p?.model ?? null },
      providers,
      catalog: CATALOG.map((c) => ({ name: c.name, label: c.label, models: c.models ?? [], keyUrl: c.keyUrl ?? null, needsKey: c.needsKey !== false })),
      web: { defaultMode: WEB_MODES.includes(config.web?.defaultMode) ? config.web.defaultMode : "auto", deep: config.web?.deep === true },
      failover: config.failover === true,
      tries: Number(config.agent?.tries) || 1,
    }
  }

  const KEY_OK = (k) => k.length >= 8 && k.length <= 400 && !/\s/.test(k)

  /**
   * Apply a change. Returns { ok, settings } or { ok: false, error }.
   * Every part is checked on a copy first; nothing changes — not the live
   * config, not the file, not the provider in use — unless all of it is valid.
   */
  function set(body = {}) {
    const next = {
      providers: structuredClone(config.providers ?? {}),
      web: { ...(config.web ?? {}) },
      agent: { ...(config.agent ?? {}) },
      activeProvider: config.activeProvider,
      failover: config.failover,
    }
    const touched = []
    let built = null
    if (body.apiKey) {
      const name = String(body.apiKey.provider ?? "")
      const key = String(body.apiKey.key ?? "").trim()
      if (!NAME.test(name)) return { ok: false, error: "bad provider name" }
      if (!getCatalog(name) && !next.providers[name]) return { ok: false, error: `unknown provider "${name}" — add it first` }
      if (key && !KEY_OK(key)) return { ok: false, error: "that does not look like an API key" }
      setPath(next, `providers.${name}.apiKey`, key || undefined)
      touched.push("apiKey")
    }
    if (body.addProvider) {
      const a = body.addProvider
      const name = String(a.name ?? "").trim().toLowerCase()
      if (!NAME.test(name)) return { ok: false, error: "provider names are lowercase letters, digits, - and _" }
      const cat = getCatalog(name)
      if (!cat && !/^https?:\/\/[^\s]+$/.test(String(a.baseUrl ?? ""))) return { ok: false, error: "a custom provider needs its base URL (https://…/v1)" }
      const key = a.key ? String(a.key).trim() : ""
      if (key && !KEY_OK(key)) return { ok: false, error: "that does not look like an API key" }
      next.providers[name] = { ...(next.providers[name] ?? {}), ...(cat ? {} : { baseUrl: String(a.baseUrl), protocol: a.protocol === "anthropic" ? "anthropic" : "openai" }), ...(a.model ? { model: String(a.model).slice(0, 200) } : {}) }
      if (key) next.providers[name].apiKey = key
      touched.push("addProvider")
    }
    if (body.removeProvider) {
      const name = String(body.removeProvider)
      if (name === providerRef.get()?.name) return { ok: false, error: "switch to another provider before removing this one" }
      if (next.providers[name]) { delete next.providers[name]; touched.push("removeProvider") }
    }
    if (body.activeProvider || body.model) {
      const name = String(body.activeProvider ?? providerRef.get()?.name ?? "")
      const model = body.model != null ? String(body.model).trim().slice(0, 200) : null
      if (!NAME.test(name)) return { ok: false, error: "bad provider name" }
      const had = Boolean(next.providers[name])
      next.providers[name] ??= {}
      if (model) next.providers[name].model = model
      built = buildProvider({ ...config, providers: next.providers }, name)
      if (!built) {
        return { ok: false, error: `${name} is not usable yet — it needs an API key${getCatalog(name) || had ? "" : " and a base URL"}` }
      }
      next.activeProvider = name
      touched.push("active")
    }
    if (body.web) {
      if (body.web.defaultMode != null) {
        if (!WEB_MODES.includes(body.web.defaultMode)) return { ok: false, error: `mode must be one of ${WEB_MODES.join(", ")}` }
        next.web.defaultMode = body.web.defaultMode
      }
      if (body.web.deep != null) next.web.deep = body.web.deep === true
      touched.push("web")
    }
    if (body.failover != null) { next.failover = body.failover === true; touched.push("failover") }
    if (body.tries != null) {
      const n = Number(body.tries)
      if (!Number.isInteger(n) || n < 1 || n > 8) return { ok: false, error: "attempts must be a whole number from 1 to 8" }
      if (n === 1) delete next.agent.tries
      else next.agent.tries = n
      touched.push("tries")
    }
    if (!touched.length) return { ok: false, error: "nothing to change" }

    // all valid: commit to the live config (in place — others hold it), then save
    const replaceIn = (target, src) => { for (const k of Object.keys(target)) if (!(k in src)) delete target[k]; Object.assign(target, src) }
    config.providers ??= {}
    replaceIn(config.providers, next.providers)
    if (touched.includes("web")) { config.web ??= {}; replaceIn(config.web, next.web) }
    if (touched.includes("tries")) { config.agent ??= {}; replaceIn(config.agent, next.agent) }
    if (touched.includes("active")) config.activeProvider = next.activeProvider
    if (touched.includes("failover")) config.failover = next.failover
    save(config)
    // the provider in use: the new one, or the same one with its new key/model
    if (built) providerRef.set(built)
    else {
      const cur = providerRef.get()
      if (cur?.name) { const re = buildProvider(config, cur.name); if (re) providerRef.set({ ...re, model: config.providers?.[cur.name]?.model ?? re.model }) }
    }
    return { ok: true, settings: get() }
  }

  /** The provider's own model list (a network call to the provider). */
  async function models(name) {
    const c = config.providers?.[name] ?? {}
    const cat = getCatalog(name)
    const built = buildProvider(config, name)
    try {
      const list = await listModels({ protocol: built?.protocol ?? cat?.protocol ?? "openai", baseUrl: built?.baseUrl ?? c.baseUrl ?? cat?.baseUrl, apiKey: built?.apiKey ?? "", catalog: cat, extraModels: c.models ?? [] })
      const ids = (Array.isArray(list) ? list : list?.models ?? []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean)
      // listModels falls back to the catalog instead of throwing: say so
      const live = Array.isArray(list) ? true : list?.live !== false
      return { ok: live, models: [...new Set(ids)].slice(0, 400), ...(live ? {} : { error: String(list?.warning ?? list?.error ?? "could not reach the provider — showing the known models").slice(0, 200) }) }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200), models: [...new Set([c.model, ...(c.models ?? []), ...(cat?.models ?? [])].filter(Boolean))] }
    }
  }

  return { get, set, models }
}
