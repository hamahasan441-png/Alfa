#!/usr/bin/env node
// v184 — out of credits, the free model suggested is one OpenRouter lists now.
//
// v175 names a free OpenRouter model to keep going when credits run out. It
// named one fixed id — a model OpenRouter may have retired — even when forge's
// own model cache (filled from OpenRouter's live list by /models, `forge
// models` and the setup wizard) said which free models exist now.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

/** Run `body` in a fresh process whose forge home holds `cache` (provider → entries). */
function inHome(cache, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-freesug-"))
  try {
    const code = `
      const M = await import(${JSON.stringify(path.join(ROOT, "modelcache.js"))})
      const P = await import(${JSON.stringify(path.join(ROOT, "providers.js"))})
      for (const [name, entries] of Object.entries(${JSON.stringify(cache)})) M.writeModelCache(name, entries)
      const OR = { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet" }
      const CFG = { providers: { openrouter: { apiKey: "x", baseUrl: OR.baseUrl } } }
      const out = await (async () => { ${body} })()
      process.stdout.write(JSON.stringify(out))`
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, FORGE_HOME: home }, encoding: "utf8" }))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

const LIVE = [
  { id: "anthropic/claude-sonnet", free: false, context: 200000 },
  { id: "meta-llama/llama-4-scout:free", free: true, context: 128000 },
  { id: "qwen/qwen3-coder:free", free: true, context: 262144 },
]

console.log("== 1. the model cache decides ==")
{
  ok("the cached list's free model is named (biggest context first)", inHome({ openrouter: LIVE }, "return P.liveFreeModel(OR)") === "qwen/qwen3-coder:free")
  ok("chat's suggestion names it", /\/model qwen\/qwen3-coder:free/.test(inHome({ openrouter: LIVE }, "return P.outOfCreditsOptions(CFG, OR, {})")))
  ok("a one-shot run's command names it", /forge agent --model qwen\/qwen3-coder:free "fix it"/.test(inHome({ openrouter: LIVE }, `return P.outOfCreditsOptions(CFG, OR, {}, { oneShot: true, task: "fix it" })`)))
  ok("never the model that just failed", inHome({ openrouter: LIVE }, `return P.liveFreeModel({ ...OR, model: "qwen/qwen3-coder:free" })`) === "meta-llama/llama-4-scout:free")
  ok("a provider named otherwise reads its own cache first", inHome({ myrouter: [{ id: "mistralai/devstral:free", free: true, context: 131072 }], openrouter: LIVE }, `return P.liveFreeModel({ ...OR, name: "myrouter" })`) === "mistralai/devstral:free")
  ok("…and OpenRouter's when it has none", inHome({ openrouter: LIVE }, `return P.liveFreeModel({ ...OR, name: "myrouter" })`) === "qwen/qwen3-coder:free")
  ok("a ':free' id counts even if the cache did not mark it", inHome({ openrouter: [{ id: "google/gemma-3-27b-it:free", context: 96000 }] }, "return P.liveFreeModel(OR)") === "google/gemma-3-27b-it:free")
}

console.log("== 2. no cached free model: the built-in one, as before ==")
{
  ok("no cache at all", inHome({}, "return P.liveFreeModel(OR)") === null && /\/model deepseek\/deepseek-chat-v3-0324:free/.test(inHome({}, "return P.outOfCreditsOptions(CFG, OR, {})")))
  ok("a paid model is never suggested, however big its context", inHome({ openrouter: [{ id: "openai/gpt-5", free: false, context: 400000 }, ...LIVE] }, "return P.liveFreeModel(OR)") === "qwen/qwen3-coder:free")
  ok("a cache with only paid models", inHome({ openrouter: [{ id: "anthropic/claude-sonnet", free: false }] }, "return P.liveFreeModel(OR)") === null)
  ok("already on a free model: nothing to suggest (unchanged)", inHome({ openrouter: LIVE }, `return P.outOfCreditsOptions({ providers: {} }, { ...OR, model: "x/y:free" }, {})`) === "")
}

console.log(`== free-suggestion suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
