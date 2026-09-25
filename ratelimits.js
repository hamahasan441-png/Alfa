/**
 * forge — rate limits a provider has stated, remembered across runs (v169).
 *
 * v167 paces requests once a 429 names its limit ("1分钟内最多请求10次"),
 * but only in the process that saw it: every new `forge` run met the limit
 * again and waited out a window (20s for a per-minute limit) before it knew
 * the pace — on a provider that had already said what it allows.
 *
 * Stored per provider base URL AND account (a hash of the API key, never the
 * key itself): two keys on one gateway can have different plans. An entry
 * expires after a day, so a plan that was upgraded is re-learned, at the cost
 * of at most one 429 a day. Never throws — a broken cache must not break a run.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { writeStateFile } from "./securefs.js"
import { DEFAULT_DIR } from "./config.js"

export const RATE_LIMITS_PATH = path.join(DEFAULT_DIR, "ratelimits.json")
export const RATE_LIMIT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 64

/** The account a limit belongs to: base URL plus a short hash of the key. */
export function rateLimitKey(baseUrl, apiKey) {
  const base = String(baseUrl ?? "").replace(/\/$/, "")
  const who = apiKey ? crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 12) : "anon"
  return `${base}#${who}`
}

function readAll(file = RATE_LIMITS_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    return j && typeof j === "object" && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

/** The stored limit for an account, or null when none is fresh. */
export function storedRateLimit(key, { now = Date.now(), file = RATE_LIMITS_PATH } = {}) {
  const e = readAll(file)[key]
  if (!e || !Number.isFinite(e.perMinute) || e.perMinute <= 0) return null
  if (!Number.isFinite(e.at) || now - e.at > RATE_LIMIT_TTL_MS || e.at > now + 60000) return null
  return { perMinute: e.perMinute, at: e.at }
}

/** Remember what a provider said it allows. */
export function storeRateLimit(key, perMinute, { now = Date.now(), file = RATE_LIMITS_PATH } = {}) {
  try {
    if (!key || !Number.isFinite(perMinute) || perMinute <= 0) return
    const all = readAll(file)
    all[key] = { perMinute, at: now }
    // bounded: the oldest entries go first
    const keep = Object.entries(all).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MAX_ENTRIES)
    writeStateFile(file, JSON.stringify(Object.fromEntries(keep), null, 2) + "\n")
  } catch { /* the cache is best-effort */ }
}

/** v182: forget a stored limit — the provider no longer limits at that level. */
export function forgetRateLimit(key, { file = RATE_LIMITS_PATH } = {}) {
  try {
    const all = readAll(file)
    if (!(key in all)) return
    delete all[key]
    writeStateFile(file, JSON.stringify(all, null, 2) + "\n")
  } catch { /* the cache is best-effort */ }
}
