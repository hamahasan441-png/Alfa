/**
 * forge — the price table (zero dependencies)
 *
 * Phase 0 of the upgrade plan needs cost per task next to solved rate, and
 * until now every cost forge reported was null: forge carried no prices and
 * would not guess one. This module keeps that rule and adds the one honest
 * source a cost can come from — prices YOU wrote down, with the date you
 * read them.
 *
 *   ~/.forge/prices.json          (or FORGE_PRICES=<file>)
 *   {
 *     "schema": "forge.prices/1",
 *     "models": {
 *       "<provider>/<model-id>": {
 *         "input": <usd>, "output": <usd>, "cacheRead": <usd>, "cacheWrite": <usd>,
 *         "asOf": "YYYY-MM-DD", "source": "<the pricing page you read>"
 *       }
 *     }
 *   }
 *
 * Prices are US dollars per ONE MILLION tokens. `input` and `output` and
 * `asOf` are required; an entry without a date is refused, because a price
 * with no date cannot say it went stale.
 *
 * No built-in prices ship. A table inside forge would be a guess the day the
 * provider changes it, and nothing in a run would notice.
 *
 * What a cost needs, and when it stays null:
 *  - forge's `inputTokens` is ALL input (fresh + cache read + cache write);
 *    the cache fields say how it splits. Fresh = input − read − write.
 *  - cache reads not reported (null) → only priced when the entry has no
 *    `cacheRead` rate, i.e. you said the model has no read discount;
 *  - cache writes not reported (null) → only priced when the entry has no
 *    `cacheWrite` rate (the OpenAI protocol bills no write surcharge);
 *  - reads or writes > 0 with no rate for them → null;
 *  - estimated token counts → null (an estimate times a price is a guess).
 *  Every null carries a reason, so "unknown" always says why.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DIR } from "./config.js"

export const PRICES_SCHEMA = "forge.prices/1"
/** A price older than this is shown as stale by `forge prices`. */
export const STALE_DAYS = 90

export function pricesPath(env = process.env) {
  const f = String(env?.FORGE_PRICES || "").trim()
  return f || path.join(DEFAULT_DIR, "prices.json")
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"]
const isRate = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** One entry → a clean entry, or a reason it was refused. Pure. */
export function validateEntry(key, e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return { error: `${key}: not an object` }
  for (const k of ["input", "output"]) {
    if (!isRate(e[k])) return { error: `${key}: "${k}" must be a number ≥ 0 (USD per 1M tokens)` }
  }
  for (const k of ["cacheRead", "cacheWrite"]) {
    if (e[k] !== undefined && e[k] !== null && !isRate(e[k])) return { error: `${key}: "${k}" must be a number ≥ 0 or left out` }
  }
  if (typeof e.asOf !== "string" || !ISO_DAY.test(e.asOf) || Number.isNaN(Date.parse(e.asOf))) {
    return { error: `${key}: "asOf" must be the date you read the price, YYYY-MM-DD` }
  }
  const entry = { key, asOf: e.asOf, source: typeof e.source === "string" ? e.source : null }
  for (const k of RATE_KEYS) entry[k] = isRate(e[k]) ? e[k] : null
  return { entry }
}

/**
 * Read the table. Never throws: a missing file is an empty table, a broken
 * one is an empty table plus the error, and one bad entry drops only itself.
 */
export function loadPrices({ file, env = process.env } = {}) {
  const p = file || pricesPath(env)
  const out = { path: p, exists: false, entries: new Map(), errors: [] }
  let raw
  try { raw = fs.readFileSync(p, "utf8") } catch { return out }
  out.exists = true
  let j
  try { j = JSON.parse(raw) } catch (e) { out.errors.push(`not valid JSON: ${e.message}`); return out }
  if (!j || typeof j !== "object" || Array.isArray(j)) { out.errors.push("expected an object"); return out }
  if (j.schema !== undefined && j.schema !== PRICES_SCHEMA) out.errors.push(`schema "${j.schema}" is not ${PRICES_SCHEMA}; read anyway`)
  const models = j.models
  if (!models || typeof models !== "object" || Array.isArray(models)) { out.errors.push('no "models" object'); return out }
  for (const [key, e] of Object.entries(models)) {
    const v = validateEntry(key, e)
    if (v.error) out.errors.push(v.error)
    else out.entries.set(key, v.entry)
  }
  return out
}

/**
 * Exact lookup only — `provider/model`, then the model id as written, then
 * the model id with a `provider/` prefix stripped. No fuzzy matching: a
 * near-miss (a dated snapshot, a "-mini") is a different price.
 */
export function findPrice(table, { provider, model } = {}) {
  const m = String(model ?? "").trim()
  if (!table?.entries?.size || !m) return null
  const p = String(provider ?? "").trim()
  const keys = []
  if (p && !m.startsWith(`${p}/`)) keys.push(`${p}/${m}`)
  keys.push(m)
  const slash = m.indexOf("/")
  if (slash > 0) keys.push(m.slice(slash + 1))
  for (const k of keys) {
    const hit = table.entries.get(k)
    if (hit) return hit
  }
  return null
}

const count = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

/**
 * Usage × price → { usd, why }. `usd` is null whenever the numbers cannot
 * support a cost, and `why` then says what was missing. Pure.
 */
export function priceUsage(usage, price) {
  if (!price) return { usd: null, why: "no price for this model" }
  if (!usage || typeof usage !== "object") return { usd: null, why: "no token counts" }
  if (usage.estimated) return { usd: null, why: "token counts are estimated" }
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  if (input == null || output == null || Number.isNaN(input) || Number.isNaN(output) || input < 0 || output < 0) {
    return { usd: null, why: "no token counts" }
  }
  let read = count(usage.cacheReadTokens)
  let write = count(usage.cacheWriteTokens)
  if (Number.isNaN(read) || Number.isNaN(write)) return { usd: null, why: "cache counts are not numbers" }
  if (read == null) {
    if (price.cacheRead != null) return { usd: null, why: "cache reads were not reported, and the price has a cache-read rate" }
    read = 0
  }
  if (write == null) {
    if (price.cacheWrite != null) return { usd: null, why: "cache writes were not reported, and the price has a cache-write rate" }
    write = 0
  }
  if (read > 0 && price.cacheRead == null) return { usd: null, why: "cache reads happened, and the price has no cache-read rate" }
  if (write > 0 && price.cacheWrite == null) return { usd: null, why: "cache writes happened, and the price has no cache-write rate" }
  const fresh = input - read - write
  if (fresh < 0) return { usd: null, why: "cache counts exceed total input" }
  const usd = (fresh * price.input + read * (price.cacheRead ?? 0) + write * (price.cacheWrite ?? 0) + output * price.output) / 1e6
  return { usd: Math.round(usd * 1e6) / 1e6, why: null }
}

/** Whole days since the entry's asOf date. */
export function ageDays(entry, now = Date.now()) {
  const t = Date.parse(entry?.asOf ?? "")
  return Number.isNaN(t) ? null : Math.floor((now - t) / 864e5)
}

/** `forge prices` — the table as it will be used, stale entries marked. */
export function formatPrices(table, { now = Date.now() } = {}) {
  const out = [`price table  ${table.path}${table.exists ? "" : "  (not created yet)"}`]
  for (const e of table.errors) out.push(`  ! ${e}`)
  if (!table.entries.size) {
    out.push("")
    out.push("No prices yet, so every cost is reported as unknown. Add the models you run, in USD per 1M tokens:")
    out.push("")
    out.push(JSON.stringify({ schema: PRICES_SCHEMA, models: { "provider/model-id": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, asOf: "YYYY-MM-DD", source: "pricing page URL" } } }, null, 2))
    out.push("")
    out.push("Leave out cacheRead / cacheWrite when the model has no cache discount or write surcharge.")
    return out.join("\n")
  }
  const fmt = (v) => (v == null ? "—" : `$${v}`)
  const w = Math.max(5, ...[...table.entries.keys()].map((k) => k.length))
  out.push("")
  out.push(`  ${"model".padEnd(w)}  input   output  c.read  c.write  as of`)
  for (const e of [...table.entries.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const age = ageDays(e, now)
    const stale = age != null && age > STALE_DAYS ? `  STALE (${age} days) — check the source` : ""
    out.push(`  ${e.key.padEnd(w)}  ${fmt(e.input).padEnd(6)}  ${fmt(e.output).padEnd(6)}  ${fmt(e.cacheRead).padEnd(6)}  ${fmt(e.cacheWrite).padEnd(7)}  ${e.asOf}${stale}`)
  }
  out.push("")
  out.push("USD per 1M tokens. A model not listed here is reported with cost unknown.")
  return out.join("\n")
}
