#!/usr/bin/env node
// v188 — the free model forge suggests can call tools.
//
// Out of credits, forge suggests a free OpenRouter model from its model cache
// (v184), biggest context first; with no model configured, autoPick starts on
// the first cached free model. An agent run is tool calls. OpenRouter lists
// which models take them (`supported_parameters`), but the cache dropped that
// field, so forge could hand the run a free model that fails at its first
// step. The field is kept now: a model listed without tool support is never
// suggested to rescue a run, goes last wherever free models are ranked, and
// is badged "no tools — chat only" in the model lists.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const LIST = [
  { id: "anthropic/claude-sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools", "tool_choice"] },
  { id: "vendor/big-chat:free", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature", "max_tokens"] },
  { id: "qwen/qwen3-coder:free", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "tool_choice"] },
  { id: "meta-llama/llama-4-scout:free", context_length: 128000, pricing: { prompt: "0", completion: "0" } },
]
const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: LIST })) })
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${srv.address().port}/api/v1`

/** A fresh forge home; returns { home, run(args), eval(body) }. */
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "forge-freetools-"))
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify({ activeProvider: "openrouter", providers: { openrouter: { apiKey: "x", baseUrl: BASE, model: "anthropic/claude-sonnet" } } }))
  const env = { ...process.env, FORGE_HOME: h, HOME: h, NO_COLOR: "1" }
  const exec = (args) => new Promise((resolve) => execFile(process.execPath, args, { env, timeout: 30000 }, (err, stdout, stderr) => resolve(String(stdout) + String(stderr))))
  return {
    dir: h,
    forge: (...a) => exec([path.join(ROOT, "forge.js"), ...a]),
    js: async (body) => JSON.parse(await exec(["--input-type=module", "-e", `
      const P = await import(${JSON.stringify(path.join(ROOT, "providers.js"))})
      const M = await import(${JSON.stringify(path.join(ROOT, "modelcache.js"))})
      const OR = { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet" }
      const CFG = { providers: { openrouter: { apiKey: "x", baseUrl: OR.baseUrl } } }
      process.stdout.write(JSON.stringify(await (async () => { ${body} })()))`])),
  }
}

console.log("== 1. the listing keeps whether a model takes tools ==")
{
  const H = home()
  const r = await H.js(`return await P.listOpenRouterModels({ baseUrl: ${JSON.stringify(BASE)} })`)
  const by = Object.fromEntries(r.all.map((e) => [e.id, e.tools]))
  ok("listed with \"tools\": true", by["qwen/qwen3-coder:free"] === true && by["anthropic/claude-sonnet"] === true, JSON.stringify(by))
  ok("listed without it: false", by["vendor/big-chat:free"] === false)
  ok("not said at all: null (unknown, not \"no\")", by["meta-llama/llama-4-scout:free"] === null)
  ok("the onboarding list ranks the no-tools model last among the free ones", r.free.map((e) => e.id).at(-1) === "vendor/big-chat:free", r.free.map((e) => e.id).join(", "))
  const g = await H.js(`return (await P.listModels({ protocol: "openai", baseUrl: ${JSON.stringify(BASE)}, apiKey: "x" })).entries.find((e) => e.id === "vendor/big-chat:free")`)
  ok("the generic listing (forge models, /models) keeps it too", g?.tools === false, JSON.stringify(g))
  fs.rmSync(H.dir, { recursive: true, force: true })
}

console.log("== 2. `forge models` fills the cache, and forge uses it ==")
{
  const H = home()
  const out = await H.forge("models", "openrouter")
  ok("`forge models openrouter` badges the model that cannot call tools", /vendor\/big-chat:free.*no tools — chat only/.test(out), out)
  ok("…and only that one", (out.match(/no tools/g) ?? []).length === 1, out)
  const cached = JSON.parse(fs.readFileSync(path.join(H.dir, "models-cache.json"), "utf8")).openrouter.entries
  ok("the cache holds the field", cached.find((e) => e.id === "vendor/big-chat:free")?.tools === false && cached.find((e) => e.id === "qwen/qwen3-coder:free")?.tools === true)
  const sug = await H.js("return P.outOfCreditsOptions(CFG, OR, {})")
  ok("out of credits: the suggestion is the free model that takes tools", /\/model qwen\/qwen3-coder:free/.test(sug) && !/big-chat/.test(sug), sug)
  ok("liveFreeModel never returns a model listed without tools", await H.js("return P.liveFreeModel(OR)") === "qwen/qwen3-coder:free")
  ok("…nor falls to it when the tool-capable one just failed (an unknown one is next)", await H.js(`return P.liveFreeModel({ ...OR, model: "qwen/qwen3-coder:free" })`) === "meta-llama/llama-4-scout:free")
  ok("autoPick's pick (the first cached free model) takes tools", (await H.js(`return M.freeFromCache("openrouter")[0].id`)) === "qwen/qwen3-coder:free")
  const free = await H.forge("models", "openrouter", "--free")
  ok("`forge models --free` lists it last, badged", /big-chat:free.*no tools/.test(free.trim().split("\n").filter((l) => /FREE/.test(l)).at(-1) ?? ""), free)
  const json = JSON.parse(await H.forge("models", "openrouter", "--json"))
  ok("`--json` reports tools per model", json.models.find((m) => m.id === "vendor/big-chat:free")?.tools === false && json.models.find((m) => m.id === "meta-llama/llama-4-scout:free")?.tools === null, JSON.stringify(json.models.slice(0, 2)))
  fs.rmSync(H.dir, { recursive: true, force: true })
}

console.log("== 3. what does not change ==")
{
  const H = home()
  const old = [{ id: "anthropic/claude-sonnet", free: false, context: 200000 }, { id: "meta-llama/llama-4-scout:free", free: true, context: 128000 }, { id: "qwen/qwen3-coder:free", free: true, context: 262144 }]
  ok("a cache written before v188 (no field): biggest context first, as before", await H.js(`M.writeModelCache("openrouter", ${JSON.stringify(old)}); return P.liveFreeModel(OR)`) === "qwen/qwen3-coder:free")
  const only = [{ id: "vendor/big-chat:free", free: true, context: 1000000, tools: false }]
  ok("only free models without tools: none is suggested…", await H.js(`M.writeModelCache("openrouter", ${JSON.stringify(only)}); return P.liveFreeModel(OR)`) === null)
  ok("…and the built-in one is named instead", /\/model deepseek\/deepseek-chat-v3-0324:free/.test(await H.js(`M.writeModelCache("openrouter", ${JSON.stringify(only)}); return P.outOfCreditsOptions(CFG, OR, {})`)))
  ok("a no-tools model is still listed and pickable in onboarding (chat works)", (await H.js(`M.writeModelCache("openrouter", ${JSON.stringify(only)}); return M.freeFromCache("openrouter").map((e) => e.id)`)).includes("vendor/big-chat:free"))
  fs.rmSync(H.dir, { recursive: true, force: true })
}

srv.closeAllConnections?.(); srv.close()
console.log(`== free-tools suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
