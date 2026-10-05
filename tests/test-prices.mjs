#!/usr/bin/env node
/**
 * forge — the price table (prices.js): cost per task for Phase 0, from
 * prices the user wrote down, and null with a reason whenever the numbers
 * cannot support a cost. No network, no model.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const P = await import("../prices.js")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prices-"))
const write = (name, obj) => {
  const f = path.join(TMP, name)
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj))
  return f
}

const FULL = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, asOf: "2026-10-01", source: "https://example.test/pricing" }
const PLAIN = { input: 2, output: 8, asOf: "2026-10-01" }

try {
  console.log("== loading the table ==")
  {
    const t = P.loadPrices({ file: path.join(TMP, "missing.json") })
    eq("a missing file is an empty table, not an error", [t.exists, t.entries.size, t.errors.length], [false, 0, 0])
    const bad = P.loadPrices({ file: write("bad.json", "{ not json") })
    ok("broken JSON is an empty table plus the error", bad.entries.size === 0 && /not valid JSON/.test(bad.errors[0] ?? ""), bad.errors)
    const mixed = P.loadPrices({ file: write("mixed.json", {
      schema: P.PRICES_SCHEMA,
      models: {
        "anthropic/full": FULL,
        "openai/plain": PLAIN,
        "x/nodate": { input: 1, output: 1 },
        "x/negative": { input: -1, output: 1, asOf: "2026-10-01" },
        "x/textrate": { input: "3", output: 1, asOf: "2026-10-01" },
        "x/badcache": { input: 1, output: 1, cacheRead: "cheap", asOf: "2026-10-01" },
        "x/baddate": { input: 1, output: 1, asOf: "October" },
      },
    }) })
    eq("good entries load", [...mixed.entries.keys()].sort(), ["anthropic/full", "openai/plain"])
    eq("each bad entry drops only itself, with a reason", mixed.errors.length, 5)
    ok("…an entry with no date is refused (a price with no date cannot go stale)", mixed.errors.some((e) => /x\/nodate: "asOf"/.test(e)), mixed.errors)
    ok("…a rate given as text is refused, not coerced", mixed.errors.some((e) => /x\/textrate: "input"/.test(e)))
    eq("left-out cache rates are null", [mixed.entries.get("openai/plain").cacheRead, mixed.entries.get("openai/plain").cacheWrite], [null, null])
    const env = P.loadPrices({ env: { FORGE_PRICES: write("env.json", { models: { m: PLAIN } }) } })
    eq("FORGE_PRICES names the file", env.entries.size, 1)
    ok("the default lives in forge's data dir", P.pricesPath({}).endsWith(path.join(".forge", "prices.json")) || P.pricesPath({}).endsWith("prices.json"))
  }

  const table = P.loadPrices({ file: write("t.json", { models: { "anthropic/claude-x": FULL, "gpt-y": PLAIN, "ollama/llama-z": { input: 0, output: 0, asOf: "2026-10-01" } } }) })

  console.log("== finding a model's price: exact names only ==")
  {
    eq("provider + model", P.findPrice(table, { provider: "anthropic", model: "claude-x" })?.key, "anthropic/claude-x")
    eq("a Harbor-style provider/model id", P.findPrice(table, { model: "anthropic/claude-x" })?.key, "anthropic/claude-x")
    eq("a model listed without its provider", P.findPrice(table, { provider: "openai", model: "gpt-y" })?.key, "gpt-y")
    eq("…or reached through a provider prefix", P.findPrice(table, { model: "openai/gpt-y" })?.key, "gpt-y")
    eq("a near-miss is a different price, not a match", P.findPrice(table, { provider: "anthropic", model: "claude-x-mini" }), null)
    eq("another provider's model of the same name does not match", P.findPrice(table, { provider: "openrouter", model: "claude-x" }), null)
    eq("no model, no price", P.findPrice(table, { provider: "anthropic" }), null)
    eq("an empty table finds nothing", P.findPrice(P.loadPrices({ file: path.join(TMP, "none.json") }), { model: "gpt-y" }), null)
  }

  console.log("== usage × price ==")
  {
    const full = table.entries.get("anthropic/claude-x")
    const plain = table.entries.get("gpt-y")
    // forge's input is ALL input: 1,000,000 = 600k fresh + 300k read + 100k write
    const u = { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 300_000, cacheWriteTokens: 100_000, estimated: false }
    // 0.6M×$3 + 0.3M×$0.30 + 0.1M×$3.75 + 0.2M×$15 = 1.8 + 0.09 + 0.375 + 3
    eq("fresh, read, write and output each at their own rate", P.priceUsage(u, full), { usd: 5.265, why: null })
    eq("no cache reported and no cache rates: all input is fresh", P.priceUsage({ inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: null, cacheWriteTokens: null }, plain), { usd: 1.8, why: null })
    eq("reads unknown but the model has a read rate → unknown", P.priceUsage({ ...u, cacheReadTokens: null }, full).usd, null)
    eq("writes unknown but the model has a write surcharge → unknown", P.priceUsage({ ...u, cacheWriteTokens: null }, full).usd, null)
    eq("writes unknown and no surcharge (OpenAI protocol) → priced", P.priceUsage({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null }, plain).usd, 0.002)
    ok("reads happened with no read rate → unknown, with why", /no cache-read rate/.test(P.priceUsage({ ...u, cacheWriteTokens: 0 }, plain).why ?? ""))
    ok("writes happened with no write rate → unknown, with why", /no cache-write rate/.test(P.priceUsage({ ...u, cacheReadTokens: 0 }, plain).why ?? ""))
    ok("estimated counts are not priced", /estimated/.test(P.priceUsage({ ...u, estimated: true }, full).why ?? ""))
    ok("cache larger than input is refused, not a negative cost", /exceed/.test(P.priceUsage({ ...u, inputTokens: 1000 }, full).why ?? ""))
    ok("no price says so", /no price/.test(P.priceUsage(u, null).why ?? ""))
    ok("no usage says so", P.priceUsage(null, full).usd === null && P.priceUsage({ inputTokens: null, outputTokens: 1 }, full).usd === null)
    eq("a free local model costs exactly 0", P.priceUsage({ inputTokens: 9999, outputTokens: 9999 }, table.entries.get("ollama/llama-z")).usd, 0)
  }

  console.log("== forge prices ==")
  {
    const now = Date.parse("2026-10-04")
    const txt = P.formatPrices(table, { now })
    ok("lists every model with its date", ["anthropic/claude-x", "gpt-y", "ollama/llama-z"].every((k) => txt.includes(k)) && txt.includes("2026-10-01"), txt)
    ok("nothing stale at 3 days", !/STALE/.test(txt))
    ok("an entry past the stale age is marked", /STALE \(\d+ days\)/.test(P.formatPrices(table, { now: Date.parse("2027-03-01") })))
    const empty = P.formatPrices(P.loadPrices({ file: path.join(TMP, "none.json") }))
    ok("with no table it says costs are unknown and shows the format", /every cost is reported as unknown/.test(empty) && empty.includes(P.PRICES_SCHEMA))
    const cli = (args, env) => spawnSync(process.execPath, [path.join(ROOT, "forge.js"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: TMP, FORGE_HOME: path.join(TMP, ".forge"), ...env } })
    const shown = cli(["prices"], { FORGE_PRICES: path.join(TMP, "t.json") })
    eq("forge prices exits 0", shown.status, 0)
    ok("…and prints the table", shown.stdout.includes("anthropic/claude-x"), shown.stdout + shown.stderr)
    const js = cli(["prices", "--json"], { FORGE_PRICES: path.join(TMP, "t.json") })
    ok("--json is JSON with the models", (() => { try { return JSON.parse(js.stdout).models["gpt-y"].output === 8 } catch { return false } })(), js.stdout.slice(0, 200))
    eq("a table with a bad entry exits 1", cli(["prices"], { FORGE_PRICES: path.join(TMP, "mixed.json") }).status, 1)
  }

  console.log("== the result file and the Terminal-Bench report use it ==")
  {
    const src = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
    ok("writeAgentResult prices a run only when its cost is still unknown", /if \(out\.costUsd == null\) Object\.assign\(out, agentCost\(out\)\)/.test(src))
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
    ok("prices.js ships in the package", pkg.files.includes("prices.js"))
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== prices: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
