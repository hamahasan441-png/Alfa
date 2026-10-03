#!/usr/bin/env node
/**
 * Phase 1 — measure Alfa/forge, so every later phase can prove it helped.
 *
 *   node scripts/measure.mjs [--label NAME] [--eval FILE.json] [--out DIR]
 *   node scripts/measure.mjs --compare OLD.json NEW.json
 *
 * Offline numbers (no model, no network), always collected:
 *   suite      `forge bench --json`: passed/total per lane (capability,
 *              discipline, programme) and the not-yet case ids
 *   boot       fastest of 5 fresh-process imports of agent.js (ms)
 *   startup    `forge --help` cold start p50 (ms), from `forge perf`
 *   modules    root .js modules, and how many agent.js loads at boot
 *
 * Live-model numbers, when you pass --eval: the JSON from
 *   forge eval --json [--mode single|meta|auto] > eval.json
 * (solved, false completions, errored, tokens, time, orchestrated tasks).
 * The eval needs a provider key, so it is run by you and handed in here —
 * this script never calls a model.
 *
 * Writes measure/<label>.json (default label: the package version).
 * --compare prints old → new for every number, and exits 1 when the new
 * one is worse on: suite passed, eval solved, false completions, boot ms
 * (by more than 15%).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined }

function run(args, { timeoutMs = 600000, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }))
  })
}

/** Fastest of 5 agent.js imports with a warm compile cache (null on Node < 22.1). */
async function cachedBootMs(tmpHome, runs = 5) {
  const dir = path.join(tmpHome, "compile-cache")
  const code = `import m from "node:module"; if (typeof m.enableCompileCache !== "function") process.exit(3); m.enableCompileCache(${JSON.stringify(dir)}); await import(${JSON.stringify(path.join(ROOT, "agent.js"))})`
  const once = () => new Promise((resolve) => {
    const t0 = Date.now()
    execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, timeout: 60000 }, (err) => resolve(err ? (err.code === 3 ? "unsupported" : null) : Date.now() - t0))
  })
  const warm = await once()
  if (warm === "unsupported" || warm === null) return null
  let best = Infinity
  for (let i = 0; i < runs; i++) { const ms = await once(); if (typeof ms === "number") best = Math.min(best, ms) }
  return Number.isFinite(best) ? best : null
}

/** Static import graph from a root module: how many local modules load at boot. */
export function bootModuleCount(entry = "agent.js", root = ROOT) {
  const seen = new Set()
  const walk = (f) => {
    if (seen.has(f)) return
    seen.add(f)
    let src = ""
    try { src = fs.readFileSync(path.join(root, f), "utf8") } catch { return }
    // static imports only: `import … from "./x.js"` / `export … from "./x.js"`
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']\.\/([^"']+\.js)["']/gms)) walk(m[1])
    for (const m of src.matchAll(/^\s*import\s+["']\.\/([^"']+\.js)["']/gm)) walk(m[1])
  }
  walk(entry)
  return seen.size
}

async function collect(label) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "forge-measure-"))
  const env = { FORGE_HOME: path.join(tmpHome, "home"), FORGE_CONFIG: path.join(tmpHome, "config.json") }
  fs.writeFileSync(env.FORGE_CONFIG, "{}\n")
  const out = { v: 1, label, forge: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, node: process.version, at: new Date().toISOString(), machine: { cores: os.cpus().length, totalMB: Math.round(os.totalmem() / 1048576) } }

  const bench = await run(["forge.js", "bench", "--json"], { env, timeoutMs: 900000 })
  try {
    const j = JSON.parse(bench.stdout)
    const lanes = {}
    for (const [k, v] of Object.entries(j.lanes ?? {})) if (v?.ran) lanes[k] = { passed: v.passed, total: v.total }
    out.suite = { passed: j.passed, total: j.total, lanes, notYet: (j.results ?? []).filter((r) => r.ok === false).map((r) => r.id) }
  } catch { out.suite = { error: (bench.stderr || bench.stdout).slice(-300) } }

  const { measureBootMs } = await import(path.join(ROOT, "benchsuite.js"))
  const boot = await measureBootMs({ runs: 5 })
  out.boot = { ms: boot.ms, error: boot.error }
  // Phase 4: the same import with Node's compile cache warm — what the
  // installed `forge` (forge-boot.js) gets after its first run.
  out.boot.cachedMs = await cachedBootMs(tmpHome)

  const perf = await run(["forge.js", "perf", "--only", "startup", "--json"], { env, timeoutMs: 300000 })
  try {
    const j = JSON.parse(perf.stdout)
    const c = (j.cases ?? []).find((x) => x.id === "startup-help")
    out.startup = { helpP50ms: c?.p50 ?? null }
  } catch { out.startup = { error: (perf.stderr || perf.stdout).slice(-300) } }

  out.modules = { root: fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")).length, bootGraph: bootModuleCount("agent.js") }

  const evalFile = flag("eval")
  if (typeof evalFile === "string") {
    const e = JSON.parse(fs.readFileSync(path.resolve(evalFile), "utf8"))
    out.eval = { tasks: e.tasks, solved: e.solved, solveRate: e.solveRate, falseCompletions: e.falseCompletions, errored: e.errored, silentSuccesses: e.silentSuccesses, orchestrated: e.orchestrated ?? 0, tokensIn: e.tokensIn, tokensOut: e.tokensOut, medianMs: e.medianMs, totalMs: e.totalMs, models: e.models ?? [] }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true })
  return out
}

/** old → new rows; `worse` when the change goes the wrong way. */
export function compareMeasures(a, b) {
  const rows = []
  const row = (name, x, y, higherIsBetter, tolerance = 0) => {
    if (x == null && y == null) return
    let worse = false
    if (typeof x === "number" && typeof y === "number") worse = higherIsBetter ? y < x : y > x * (1 + tolerance)
    rows.push({ name, old: x ?? null, new: y ?? null, worse })
  }
  row("suite passed", a.suite?.passed, b.suite?.passed, true)
  row("suite total", a.suite?.total, b.suite?.total, true)
  row("boot ms", a.boot?.ms, b.boot?.ms, false, 0.15)
  row("boot ms (compile cache)", a.boot?.cachedMs, b.boot?.cachedMs, false, 0.15)
  row("startup p50 ms", a.startup?.helpP50ms, b.startup?.helpP50ms, false, 0.15)
  row("root modules", a.modules?.root, b.modules?.root, false, Infinity)
  row("boot module graph", a.modules?.bootGraph, b.modules?.bootGraph, false, Infinity)
  row("eval solved", a.eval?.solved, b.eval?.solved, true)
  row("eval false completions", a.eval?.falseCompletions, b.eval?.falseCompletions, false)
  row("eval errored", a.eval?.errored, b.eval?.errored, false)
  row("eval tokens in", a.eval?.tokensIn, b.eval?.tokensIn, false, Infinity)
  row("eval median ms", a.eval?.medianMs, b.eval?.medianMs, false, Infinity)
  return { rows, worse: rows.filter((r) => r.worse).map((r) => r.name) }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (flag("compare") !== undefined) {
    const i = argv.indexOf("--compare")
    const [fa, fb] = [argv[i + 1], argv[i + 2]]
    if (!fa || !fb) { console.error("usage: node scripts/measure.mjs --compare OLD.json NEW.json"); process.exit(2) }
    const a = JSON.parse(fs.readFileSync(fa, "utf8")), b = JSON.parse(fs.readFileSync(fb, "utf8"))
    const c = compareMeasures(a, b)
    console.log(`measure: ${a.label} (${a.forge}) → ${b.label} (${b.forge})`)
    for (const r of c.rows) console.log(`  ${r.worse ? "WORSE" : "     "} ${r.name.padEnd(24)} ${String(r.old).padStart(8)} → ${String(r.new).padStart(8)}`)
    if (c.worse.length) { console.log(`\nworse: ${c.worse.join(", ")}`); process.exit(1) }
    process.exit(0)
  }
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
  const label = typeof flag("label") === "string" ? flag("label") : pkgVersion
  const outDir = path.resolve(typeof flag("out") === "string" ? flag("out") : path.join(ROOT, "measure"))
  const m = await collect(label)
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${label}.json`)
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n")
  console.log(`suite ${m.suite?.passed}/${m.suite?.total} • boot ${m.boot?.ms}ms (cached ${m.boot?.cachedMs ?? "n/a"}ms) • startup ${m.startup?.helpP50ms}ms • modules ${m.modules.root} (boot graph ${m.modules.bootGraph})${m.eval ? ` • eval ${m.eval.solved}/${m.eval.tasks} solved, ${m.eval.falseCompletions} false` : " • eval: not given (--eval FILE)"}`)
  console.log(`→ ${path.relative(process.cwd(), file)}`)
}
