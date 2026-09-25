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

/**
 * v185 — YOLO SHOWS SECRETS AS THEY ARE.
 *
 * The owner's call: YOLO is the developer's mode — nothing refused, nothing
 * hidden — until the release. Secret redaction hid values from them, from the
 * model and in transcripts; worse, its high-entropy rule took model ids
 * (deepseek-ai/DeepSeek-V4-Flash-0731) for keys, so an agent fixing a
 * provider could not read the model list it was fixing.
 *
 * Most redaction sites have no config to hand (redact() is called from
 * everywhere), so forge.js — and chat's /yolo — tell the process once. With
 * YOLO on, secrets are not redacted, unless NODE_ENV=production (always
 * redacts — the release safety net) or security was asked for explicitly
 * (FORGE_SECURITY_MODE=on / tools.securityMode "on" keeps redaction in YOLO).
 * The injection fence and socket pinning are separate and unchanged: they
 * neither hide nor refuse anything.
 */
let yoloShowsSecrets = false

export function setYoloSecrets({ yolo = false, config = {}, env = process.env } = {}) {
  yoloShowsSecrets = yolo === true && securityMode(config, env).requested !== "on"
  return yoloShowsSecrets
}

/** Is secret redaction applied right now? */
export function redactionEnabled(env = process.env) {
  const m = securityMode({}, env)
  if (m.mode !== "on") return false
  if (m.source === "production" || m.source === "explicit") return true
  return !yoloShowsSecrets
}
