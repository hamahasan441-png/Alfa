/**
 * forge — where forge keeps its data, and where it keeps your API keys
 * (zero dependencies, so the boot shim and the shell guard can use it too).
 *
 * EVERYTHING forge writes — memory, chat sessions, run journals, checkpoints,
 * per-project state, caches, downloaded skills and tools — lives in ONE
 * folder:
 *
 *   FORGE_HOME (or FORGE_DATA_DIR)    when you set it
 *   <forge's install folder>/data     otherwise
 *
 * so removing forge's folder removes all of it, and forge leaves nothing in
 * your home directory.
 *
 * The one exception is your provider API keys. They live in a small file
 * OUTSIDE forge's folder, so a reinstall still finds them:
 *
 *   FORGE_KEYS_FILE                                  when you set it
 *   $XDG_CONFIG_HOME/forge/keys.json                 Linux / macOS
 *     (default ~/.config/forge/keys.json)
 *   %APPDATA%\forge\keys.json                        Windows
 *
 * When you point forge somewhere yourself (FORGE_HOME, FORGE_DATA_DIR or
 * FORGE_CONFIG), the keys stay in that config file, as they always did: an
 * explicit location keeps everything together.
 *
 * If forge's install folder cannot be written (a root-owned global npm
 * install), forge falls back to ~/.forge and SAYS so (`forge data status`,
 * and the reason travels with the choice). It never fails to start for it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The folder forge runs from: the clone, or the installed package. */
export const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url))
/** The default data folder: inside forge's own folder. */
export const INSTALL_DATA_DIR = path.join(INSTALL_DIR, "data")

/** Where forge kept everything before (still read by `forge data migrate`). */
export function legacyDataDir(env = process.env) {
  const home = String(env?.HOME || "").trim() || os.homedir()
  return path.join(home, ".forge")
}

function explicitHome(env) {
  const home = String(env?.FORGE_HOME || "").trim()
  if (home) return { dir: home, source: "FORGE_HOME" }
  const data = String(env?.FORGE_DATA_DIR || "").trim()
  if (data) return { dir: data, source: "FORGE_DATA_DIR" }
  return null
}

/** Where data lives, by the rules above, without touching the disk. */
export function resolveDataDir(env = process.env) {
  return explicitHome(env)?.dir ?? INSTALL_DATA_DIR
}

/**
 * The data folder this process will use. An explicit FORGE_HOME is used as
 * given. The install folder is created (0700) and checked for writing; if
 * that fails, the legacy ~/.forge is used and `fallback` says why.
 */
export function chooseDataDir(env = process.env, { installDataDir = INSTALL_DATA_DIR } = {}) {
  const ex = explicitHome(env)
  if (ex) return { dir: ex.dir, source: ex.source, fallback: null }
  try {
    fs.mkdirSync(installDataDir, { recursive: true, mode: 0o700 })
    fs.accessSync(installDataDir, fs.constants.W_OK)
    return { dir: installDataDir, source: "install", fallback: null }
  } catch (e) {
    return { dir: legacyDataDir(env), source: "fallback", fallback: `${installDataDir} is not writable (${e?.code ?? e?.message ?? e})` }
  }
}

/**
 * The provider-keys file, or null when the keys stay in the config file
 * (an explicit FORGE_HOME / FORGE_DATA_DIR / FORGE_CONFIG). Pure.
 */
export function keysFilePath(env = process.env, { platform = process.platform } = {}) {
  const explicit = String(env?.FORGE_KEYS_FILE || "").trim()
  if (explicit) return path.resolve(explicit)
  if (explicitHome(env) || String(env?.FORGE_CONFIG || "").trim()) return null
  const home = String(env?.HOME || "").trim() || os.homedir()
  const base = platform === "win32"
    ? (String(env?.APPDATA || "").trim() || path.join(home, "AppData", "Roaming"))
    : (String(env?.XDG_CONFIG_HOME || "").trim() || path.join(home, ".config"))
  return path.join(base, "forge", "keys.json")
}

// ---- splitting API keys out of a config object ------------------------------

const KEY_FIELD = "apiKey"

/**
 * Every non-empty `apiKey` in a config, by dotted path
 * ("providers.openai.apiKey"). Pure.
 */
export function collectKeys(cfg, prefix = "") {
  const out = {}
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return out
  for (const [k, v] of Object.entries(cfg)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (k === KEY_FIELD && typeof v === "string" && v.trim()) out[p] = v
    else if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, collectKeys(v, p))
  }
  return out
}

/** A deep copy of the config with every `apiKey` value removed. Pure. */
export function withoutKeys(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg
  if (Array.isArray(cfg)) return cfg.map(withoutKeys)
  const out = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (k === KEY_FIELD && typeof v === "string") continue
    out[k] = v && typeof v === "object" ? withoutKeys(v) : v
  }
  return out
}

/** Dotted-path keys back into a nested object (to merge under a config). */
export function keysToTree(keys = {}) {
  const tree = {}
  for (const [p, v] of Object.entries(keys ?? {})) {
    if (typeof v !== "string" || !v) continue
    const parts = p.split(".")
    if (parts.at(-1) !== KEY_FIELD || parts.some((x) => !x || x === "__proto__" || x === "constructor" || x === "prototype")) continue
    let node = tree
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts.at(-1)] = v
  }
  return tree
}

/** Read the keys file: { keys } (empty when absent or unreadable). */
export function readKeysFile(file) {
  if (!file) return { keys: {}, exists: false, error: null }
  let raw
  try { raw = fs.readFileSync(file, "utf8") } catch { return { keys: {}, exists: false, error: null } }
  try {
    const j = JSON.parse(raw)
    const keys = j && typeof j === "object" && j.keys && typeof j.keys === "object" ? j.keys : {}
    return { keys, exists: true, error: null }
  } catch (e) { return { keys: {}, exists: true, error: `not valid JSON: ${e.message}` } }
}

export const KEYS_SCHEMA = "forge.keys/1"

/** The keys file's content for a set of keys. */
export function keysFileBody(keys) {
  return JSON.stringify({ schema: KEYS_SCHEMA, note: "forge provider API keys — kept outside forge's folder so a reinstall keeps them", keys }, null, 2) + "\n"
}

/** The directories an agent must never write into: forge's own state. */
export function forgeStateDirs({ dataDir, keysFile } = {}) {
  return [dataDir, keysFile ? path.dirname(keysFile) : null].filter(Boolean).map((d) => path.resolve(d))
}
