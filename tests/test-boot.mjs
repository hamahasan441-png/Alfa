#!/usr/bin/env node
// v179 — an agent run boots faster.
//
// Nearly all of a boot was Node loading and compiling forge's modules (137ms
// of 157ms measured in node's module loader). Two things change: subsystems
// most runs never use load on first use instead of at boot, and forge.js
// turns on Node's on-disk compile cache, kept per version.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-home-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

/** The static import graph from a module: files and node: built-ins. */
function staticGraph(entry) {
  const seen = new Set(), builtins = new Set()
  const re = /^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm
  const walk = (f) => {
    if (seen.has(f)) return
    seen.add(f)
    for (const m of fs.readFileSync(f, "utf8").matchAll(re)) {
      const spec = m[1] ?? m[2]
      if (spec.startsWith("node:")) builtins.add(spec)
      else if (spec.startsWith("./")) walk(path.join(path.dirname(f), spec))
    }
  }
  walk(path.join(ROOT, entry))
  return { files: new Set([...seen].map((f) => path.basename(f))), builtins }
}

console.log("== 1. what an agent run no longer loads at boot ==")
{
  const g = staticGraph("agent.js")
  for (const m of ["browser.js", "mcp.js", "codesearch.js", "worldmodel.js", "engmemory.js"]) ok(`${m} is not in the agent's boot graph`, !g.files.has(m))
  ok("node:zlib is not loaded at boot", !g.builtins.has("node:zlib"), [...g.builtins].join(","))
  ok("node:util is not loaded at boot", !g.builtins.has("node:util"), [...g.builtins].join(","))
  ok("the small pieces every run asks for are (browser policy, MCP config)", g.files.has("browserpolicy.js") && g.files.has("mcpconfig.js"))
}

console.log("== 2. one implementation: the re-exports are the same functions ==")
{
  const [B, BP, M, MC] = await Promise.all([import("../browser.js"), import("../browserpolicy.js"), import("../mcp.js"), import("../mcpconfig.js")])
  ok("browser.js re-exports browserpolicy.js", B.isVerifyAction === BP.isVerifyAction && B.browserMutatesFilesystem === BP.browserMutatesFilesystem && B.ACTIONS === BP.ACTIONS)
  ok("mcp.js re-exports mcpconfig.js", M.configuredServers === MC.configuredServers && M.parseMcpToolName === MC.parseMcpToolName && M.cachedInventoryTools === MC.cachedInventoryTools)
  ok("configuredServers still filters disabled and empty servers", MC.configuredServers({ mcp: { servers: { a: { command: "x" }, b: { command: "y", disabled: true }, c: {} } } }).map(([n]) => n).join() === "a")
}

console.log("== 3. the deferred tools still work, loaded on first use ==")
{
  const T = await import("../tools.js")
  ok("the browser driver is not loaded before the browser tool runs", T.browserLoaded() === false)
  const { createMockDriver } = await T.loadBrowser()
  const ctx = T.makeToolContext({ cwd: ROOT, root: ROOT, skillsDir: null }).ctx
  const r = await T.execTool({ ...ctx, _browserDriver: createMockDriver(), browser: true }, "browser", { action: "status" })
  ok("the browser tool runs through the lazily loaded driver", typeof r === "string" && !r.startsWith("ERROR"), String(r).slice(0, 160))
  ok("…and says it is loaded (so a run closes its session)", T.browserLoaded() === true)
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-proj-"))
  fs.writeFileSync(path.join(proj, "cache.js"), "export function warmCompileCache(dir) { return dir }\n")
  const pctx = T.makeToolContext({ cwd: proj, root: proj, skillsDir: null }).ctx
  const ss = String(await T.execTool(pctx, "semantic_search", { query: "warm compile cache", path: "." }))
  ok("semantic_search runs through the lazily loaded search", !/^ERROR|unknown tool/i.test(ss) && /cache\.js/.test(ss), ss.slice(0, 160))
  const kg = String(await T.execTool(pctx, "kg_query", { query: "warmCompileCache" }))
  ok("kg_query runs through the lazily loaded world model and engineering memory", !/^ERROR|unknown tool/i.test(kg) && !/world model unavailable/.test(kg), kg.slice(0, 160))
  const cc = String(await T.execTool(pctx, "code_context", { query: "warm compile cache" }))
  ok("code_context runs through both", !/^ERROR|unknown tool/i.test(cc), cc.slice(0, 160))
  fs.rmSync(proj, { recursive: true, force: true })
  await T.disposeToolManagers?.()
}

console.log("== 4. a built-in on first use, and execFile without node:util ==")
{
  const { lazyBuiltin } = await import("../lazybuiltin.js")
  const z = lazyBuiltin("node:zlib")
  const round = z.gunzipSync(z.gzipSync(Buffer.from("forge boot"))).toString()
  ok("a lazily loaded zlib compresses and inflates", round === "forge boot")
  ok("…feature checks still work through it", typeof z.inflateRawSync === "function" && ("gzipSync" in z))
  const { execFileP } = await import("../sourceresolve.js")
  const good = await execFileP(process.execPath, ["-e", "process.stdout.write('hi')"], {})
  ok("execFileP resolves { stdout, stderr } like promisify(execFile)", good.stdout === "hi" && good.stderr === "")
  let bad = null
  try { await execFileP(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], {}) } catch (e) { bad = e }
  ok("…and rejects with the error carrying stdout/stderr", bad?.code === 3 && bad?.stderr === "boom")
}

console.log("== 5. the compile cache: per version, pruned, opt-out ==")
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-cc-"))
  fs.mkdirSync(path.join(root, "170.0.0")); fs.writeFileSync(path.join(root, "170.0.0", "stale"), "x")
  const run = (env = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { enableBootCache } from ${JSON.stringify(path.join(ROOT, "bootcache.js"))}; console.log(enableBootCache({ root: ${JSON.stringify(root)}, version: "192.0.0" }))`], { encoding: "utf8", env: { ...process.env, ...env } })
  const hasApi = typeof (await import("node:module")).default.enableCompileCache === "function"
  const r = run()
  if (hasApi) {
    ok("the cache is kept under <root>/<version>", r.stdout.trim() === path.join(root, "192.0.0") && fs.existsSync(path.join(root, "192.0.0")), r.stdout + r.stderr)
    ok("another version's cache is removed (Node never prunes it)", !fs.existsSync(path.join(root, "170.0.0")))
  } else ok("older Node without the API: nothing happens", r.stdout.trim() === "null")
  const off = run({ FORGE_NO_COMPILE_CACHE: "1" })
  ok("FORGE_NO_COMPILE_CACHE=1 turns it off", off.stdout.trim() === "null")
  fs.rmSync(root, { recursive: true, force: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-boot-cli-"))
  const v = execFileSync(process.execPath, [path.join(ROOT, "forge.js"), "--version"], { encoding: "utf8", env: { ...process.env, FORGE_HOME: home } })
  const version = /forge v([\w.-]+)/.exec(v)?.[1]
  ok("forge enables it at startup, for its own version", !hasApi || fs.existsSync(path.join(home, "cache", "compile", version)), `${v.trim()} → ${fs.existsSync(path.join(home, "cache", "compile")) ? fs.readdirSync(path.join(home, "cache", "compile")).join(",") : "no cache dir"}`)
  fs.rmSync(home, { recursive: true, force: true })
}

console.log("== 6. boot, measured the way forge boots ==")
{
  const { measureBootMs, BOOT_BUDGET_MS } = await import("../benchsuite.js")
  const cached = await measureBootMs({ runs: 5 })
  const cold = await measureBootMs({ runs: 5, compileCache: false })
  console.log(`  · boot: ${cached.ms}ms with the compile cache, ${cold.ms}ms without (budget ${BOOT_BUDGET_MS}ms)`)
  ok("both measurements ran", Number.isFinite(cached.ms) && Number.isFinite(cold.ms))
  ok("the cache does not make boot slower", cached.ms <= cold.ms + 10, `${cached.ms} vs ${cold.ms}`)
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== boot suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
