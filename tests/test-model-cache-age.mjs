#!/usr/bin/env node
// v195 — a model list is as old as the last `/models`; chat refreshes a stale one.
//
// The out-of-credits suggestion (v184/v188), autoPick and SmartStart read the
// model cache, and nothing refreshed it: a list from months ago still named
// models the provider had retired. Chat's own `/models` did not even write it.
// Now: a cache older than a week (or from before v188, with no tool-support
// field) is fetched again quietly when chat starts; `/models` writes it; and
// tool support is read from more providers than OpenRouter.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execFile, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const DAY = 24 * 3600 * 1000

/** Run `body` with MC (modelcache.js) and P (providers.js) in a fresh forge home. */
function inHome(home, body) {
  const code = `
    const MC = await import(${JSON.stringify(path.join(ROOT, "modelcache.js"))})
    const P = await import(${JSON.stringify(path.join(ROOT, "providers.js"))})
    const out = await (async () => { ${body} })()
    process.stdout.write(JSON.stringify(out ?? null))`
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, FORGE_HOME: home }, encoding: "utf8" }))
}
/** The same, without blocking this process — for calls that reach the in-process stub. */
function inHomeAsync(home, body) {
  const code = `
    const P = await import(${JSON.stringify(path.join(ROOT, "providers.js"))})
    const out = await (async () => { ${body} })()
    process.stdout.write(JSON.stringify(out ?? null))`
  return new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, FORGE_HOME: home }, encoding: "utf8" }, (e, so) => e ? reject(e) : resolve(JSON.parse(so))))
}
const newHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcage-"))
const writeCache = (home, provider, entries, ageMs) => fs.writeFileSync(path.join(home, "models-cache.json"), JSON.stringify({ [provider]: { entries, ts: Date.now() - ageMs } }))

console.log("== 1. how old is the list, and is it stale? ==")
{
  const h = newHome()
  ok("no cache: no age, and not stale (nothing to refresh)", JSON.stringify(inHome(h, `return [MC.modelCacheAge("openrouter"), MC.modelCacheStale("openrouter")]`)) === "[null,false]")
  writeCache(h, "openrouter", [{ id: "a:free", free: true, tools: true }], 2 * DAY)
  const [age, stale] = inHome(h, `return [MC.modelCacheAge("openrouter"), MC.modelCacheStale("openrouter")]`)
  ok("a 2-day-old list: its age, and not stale", age > 1.9 * DAY && age < 2.1 * DAY && stale === false, `${age} ${stale}`)
  writeCache(h, "openrouter", [{ id: "a:free", free: true, tools: true }], 8 * DAY)
  ok("an 8-day-old list is stale (a week is the limit)", inHome(h, `return MC.modelCacheStale("openrouter")`) === true && inHome(h, `return MC.MODEL_CACHE_MAX_AGE_MS`) === 7 * DAY)
  writeCache(h, "openrouter", [{ id: "a:free", free: true, context: 1000 }], 1 * DAY)
  ok("a fresh list written before v188 (no `tools` on any entry) is stale too", inHome(h, `return MC.modelCacheStale("openrouter")`) === true)
  writeCache(h, "openrouter", [{ id: "a:free", free: true, tools: null }], 1 * DAY)
  ok("…one that says tools: null (the provider did not say) is not", inHome(h, `return MC.modelCacheStale("openrouter")`) === false)
  fs.rmSync(h, { recursive: true, force: true })
}

console.log("== 2. which models take tools — beyond OpenRouter ==")
{
  const h = newHome()
  const r = inHome(h, `return [
    P.modelTakesTools({ supported_parameters: ["tools"] }), P.modelTakesTools({ supported_parameters: ["temperature"] }),
    P.modelTakesTools({ capabilities: { function_calling: true } }), P.modelTakesTools({ capabilities: { tools: false } }),
    P.modelTakesTools({ supports_tools: true }), P.modelTakesTools({ tool_call: false }),
    P.modelTakesTools({ id: "x" }), P.modelTakesTools(null)]`)
  ok("OpenRouter's supported_parameters (v188)", r[0] === true && r[1] === false, JSON.stringify(r))
  ok("capabilities.function_calling / capabilities.tools", r[2] === true && r[3] === false)
  ok("flat flags (supports_tools, tool_call)", r[4] === true && r[5] === false)
  ok("nothing said: null (unknown, not \"no\")", r[6] === null && r[7] === null)
  fs.rmSync(h, { recursive: true, force: true })
}

/** A stub provider: GET /models lists `models`; chat completions answer "hi". */
function stub(models) {
  const seen = { models: 0, chat: 0 }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      if (req.method === "GET" && /\/models/.test(req.url)) {
        seen.models++
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ data: models }))
      }
      seen.chat++
      let j = {}
      try { j = JSON.parse(b) } catch { /* answered anyway */ }
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }))
    })
  })
  return { srv, seen, start: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))) }
}
const LIVE = [
  { id: "qwen/qwen3-coder:free", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  { id: "vendor/new-model:free", context_length: 131072, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
]
async function chat(home, base, input, env = {}) {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: base, apiKey: "k", model: "m" } }, skills: { enabled: false } }))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcage-work-"))
  let out = ""
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
    child.stdin.write(input); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 60000)
    child.once("exit", () => { clearTimeout(t); resolve() })
  })
  fs.rmSync(work, { recursive: true, force: true })
  return out
}
const cached = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, "models-cache.json"), "utf8")).stub ?? null } catch { return null } }

console.log("== 3. chat refreshes a stale list when it starts ==")
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  writeCache(h, "stub", [{ id: "old/retired:free", free: true, tools: true }], 30 * DAY)
  const out = await chat(h, base, "hello\n/exit\n")
  const c = cached(h)
  ok("the stale list was fetched again (GET /models at start)", s.seen.models === 1, JSON.stringify(s.seen))
  ok("…and the cache now holds the live list, dated now", c?.entries?.some((e) => e.id === "vendor/new-model:free") && !c.entries.some((e) => e.id === "old/retired:free") && Date.now() - c.ts < 60000, JSON.stringify(c)?.slice(0, 200))
  ok("…quietly: nothing about it on screen, and the turn was answered", !/fetching models|models-cache/i.test(out) && /hi/.test(out), out.slice(-200))
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  writeCache(h, "stub", [{ id: "kept/model:free", free: true, tools: true }], 1 * DAY)
  await chat(h, base, "hello\n/exit\n")
  ok("a fresh list is left alone (no GET /models)", s.seen.models === 0 && cached(h)?.entries?.[0]?.id === "kept/model:free", JSON.stringify(s.seen))
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  writeCache(h, "stub", [{ id: "old/retired:free", free: true, tools: true }], 30 * DAY)
  await chat(h, base, "hello\n/exit\n", { FORGE_NO_MODEL_REFRESH: "1" })
  ok("FORGE_NO_MODEL_REFRESH=1 turns it off", s.seen.models === 0 && cached(h)?.entries?.[0]?.id === "old/retired:free")
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  await chat(h, base, "hello\n/exit\n")
  ok("no list at all: nothing is fetched at start (first fetch is `/models`' job)", s.seen.models === 0 && cached(h) === null)
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}

console.log("== 4. chat's `/models` writes the list ==")
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  const out = await chat(h, base, "/models\n/exit\n")
  const c = cached(h)
  ok("`/models` listed the live models", /vendor\/new-model:free/.test(out), out.slice(-300))
  ok("…and wrote them to the cache, with tool support", c?.entries?.find((e) => e.id === "vendor/new-model:free")?.tools === true, JSON.stringify(c)?.slice(0, 200))
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}

console.log("== 5. refreshModelCache ==")
{
  const s = stub(LIVE); const base = await s.start()
  const h = newHome()
  writeCache(h, "stub", [{ id: "old/retired:free", free: true, tools: true }], 30 * DAY)
  const good = await inHomeAsync(h, `return await P.refreshModelCache({ name: "stub", protocol: "openai", baseUrl: ${JSON.stringify(base)}, apiKey: "k" })`)
  ok("it fetches and writes the live list", good.refreshed === true && good.count === 2 && cached(h)?.entries?.length === 2, JSON.stringify(good))
  writeCache(h, "stub", [{ id: "old/retired:free", free: true, tools: true }], 30 * DAY)
  const bad = await inHomeAsync(h, `return await P.refreshModelCache({ name: "stub", protocol: "openai", baseUrl: "http://127.0.0.1:9", apiKey: "k" })`)
  ok("unreachable: no throw, refreshed false, the old list kept", bad.refreshed === false && !!bad.warning && cached(h)?.entries?.[0]?.id === "old/retired:free", JSON.stringify(bad))
  s.srv.close(); fs.rmSync(h, { recursive: true, force: true })
}

console.log(`== model-cache-age suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
