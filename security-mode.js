/**
 * Forge security execution mode.
 *
 * Development/test may explicitly disable enforcement-heavy security adapters
 * for local iteration. Production always resolves to ON, regardless of config
 * or environment, so an accidental production launch cannot inherit a local
 * "off" setting.
 */
const TRUTHY = new Set(["1", "true", "on", "yes"])
const FALSY = new Set(["0", "false", "off", "no"])

function parse(value) {
  if (value === undefined || value === null || value === "") return null
  const s = String(value).trim().toLowerCase()
  if (s === "on" || TRUTHY.has(s)) return "on"
  if (s === "off" || FALSY.has(s)) return "off"
  if (s === "auto") return "auto"
  return null
}

/** Resolve security mode. Production is fail-closed to ON. */
export function securityMode(config = {}, env = process.env) {
  const runtime = String(env?.NODE_ENV || "").trim().toLowerCase()
  const requested = parse(env?.FORGE_SECURITY_MODE) ?? parse(config?.tools?.securityMode) ?? "auto"
  if (runtime === "production") return { mode: "on", enforced: true, requested, source: "production" }
  if (requested === "off") return { mode: "off", enforced: false, requested, source: env?.FORGE_SECURITY_MODE ? "env FORGE_SECURITY_MODE" : "tools.securityMode" }
  return { mode: "on", enforced: true, requested, source: requested === "on" ? "explicit" : "default" }
}

export function securityEnabled(config = {}, env = process.env) {
  return securityMode(config, env).mode === "on"
}
