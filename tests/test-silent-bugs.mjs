#!/usr/bin/env node
// v171 — the audit's silent bugs (findings 4, 5, 6, 8, 9), and a guard.
//
// Found with ESLint's bug rules over all 202 modules, then confirmed by probe:
//   4. chat.js read `unrestricted` out of scope → a ReferenceError the
//      "best-effort" catch swallowed: user tool plugins NEVER loaded in chat.
//   5. terminal.js `o.th.muted` (no `o`) → the command palette threw on every
//      redraw once it had more rows than space (a tall dock, a short terminal).
//   6. meta.js emitted { type: "DECISION_REQUIRED", …, type: d.type } → the
//      duplicate key overwrote the type; the core never entered WAIT_FOR_USER.
//   8. `forge config set` saved a typo'd key silently; it then did nothing.
//   9. worktree.js removed its temp file with an out-of-scope `tmp`.
// The guard: the same ESLint rules run over the sources — an undefined name
// can never again silently switch a feature off.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const INHERITED_HOME = process.env.FORGE_HOME ?? null // what run-all gave this suite
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-silent-"))
process.env.FORGE_HOME = HOME
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

console.log("== 4. user tool plugins load in chat ==")
{
  fs.mkdirSync(path.join(HOME, "tools"), { recursive: true })
  fs.writeFileSync(path.join(HOME, "tools", "hello.mjs"), `export default { name: "hello_tool", description: "says hi", parameters: { type: "object", properties: {} }, readOnly: true, async run() { return "hi" } }\n`)
  const { loadChatPlugins } = await import("../chat.js")
  const { PLUGIN_ISOLATION_AVAILABLE } = await import("../plugins.js")
  const r = await loadChatPlugins({ tools: { plugins: true, mcp: false } }, { startedAt: Date.now() + 1000 })
  ok("the plugin loader actually ran (it threw a ReferenceError before)", r.pluginHost !== null, JSON.stringify(r.errors))
  if (PLUGIN_ISOLATION_AVAILABLE) ok("…and the user's plugin is offered in chat", r.plugins.some((p) => p.name === "hello_tool"), JSON.stringify(r.plugins.map((p) => p.name)))
  else ok("…and without isolation it says why instead of loading it", r.errors.length > 0 || r.plugins.length === 0)
  try { r.pluginHost?.close?.() } catch { /* workers already gone */ }
}

console.log("== 5. the command palette renders when it overflows ==")
{
  const { createTerminal } = await import("../terminal.js")
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {}
  const output = new EventEmitter(); output.isTTY = true; output.columns = 60; output.rows = 12
  let written = ""
  output.write = (c) => { written += c; return true }
  const term = createTerminal({ input, output, forceTTY: true })
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `/cmd${i}`, hint: "x" }))
  term.start({ prompt: "forge > ", onSubmit: () => {}, onEOF: () => {}, paletteItems: () => items, onPaletteSelect: () => {} })
  term.setDock(() => Array.from({ length: 8 }, (_, i) => `dock line ${i}`))
  let threw = null
  try { term.openPalette(items); term._renderNow() } catch (e) { threw = e }
  try { term.stop?.() } catch { /* test teardown */ }
  ok("a palette taller than the space renders (it threw 'o is not defined')", threw === null, String(threw))
  ok("…and says how many more rows there are", /\d+ more/.test(written))
}

console.log("== 8. a setting forge does not read is said ==")
{
  const { configKeyWarning } = await import("../config.js")
  ok("a typo in a known section, with the fix", /"retry\.conectMs" is not a setting forge reads — did you mean "retry\.connectMs"\?/.test(configKeyWarning("retry.conectMs") ?? ""), configKeyWarning("retry.conectMs"))
  ok("a typo'd section, with the fix", /did you mean "retry\.connectMs"/.test(configKeyWarning("retyr.connectMs") ?? ""), configKeyWarning("retyr.connectMs"))
  for (const k of ["retry.connectMs", "failover", "ui.dock", "agent.verifyNudge", "providers.seekai.model", "tools.pluginGrants.jira.network", "mcp.servers.x.command", "agent.maxSteps"]) {
    ok(`a real key is not flagged: ${k}`, configKeyWarning(k) === null, configKeyWarning(k))
  }
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfgset-"))
  const out = execFileSync(process.execPath, [path.join(ROOT, "forge.js"), "config", "set", "retry.conectMs", "60000"], { env: { ...process.env, FORGE_HOME: h2, NO_COLOR: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  ok("`forge config set` says so (and still saves it)", /did you mean "retry\.connectMs"/.test(out) && JSON.parse(fs.readFileSync(path.join(h2, "config.json"), "utf8")).retry.conectMs === 60000, out)
  fs.rmSync(h2, { recursive: true, force: true })
}

console.log("== 10. the test runner isolates each suite ==")
{
  const src = fs.readFileSync(path.join(HERE, "run-all.mjs"), "utf8")
  ok("run-all gives every suite its own FORGE_HOME", /env: \{ \.\.\.process\.env, FORGE_HOME: suiteHome/.test(src) && /fs\.rmSync\(suiteHome/.test(src))
  if (process.env.FORGE_TEST_SUITE_HOME) ok("…and this suite was given one (not the real ~/.forge)", INHERITED_HOME === process.env.FORGE_TEST_SUITE_HOME && !INHERITED_HOME.startsWith(path.join(os.homedir(), ".forge")), String(INHERITED_HOME))
}

console.log("== the guard: ESLint's bug rules over every module ==")
{
  let eslint = null
  try { eslint = execFileSync("sh", ["-c", "command -v eslint"], { encoding: "utf8" }).trim() } catch { /* not installed */ }
  if (!eslint) {
    console.log("  skip no eslint on PATH — the guard runs where it is installed")
  } else {
    const nodeGlobals = "process Buffer console setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal fetch Headers Request Response FormData Blob File structuredClone queueMicrotask performance globalThis global crypto WebSocket EventTarget Event CustomEvent MessageChannel MessagePort BroadcastChannel atob btoa navigator DOMException ReadableStream WritableStream TransformStream CompressionStream DecompressionStream"
    const cfg = path.join(HOME, "eslint.guard.mjs")
    fs.writeFileSync(cfg, `const node = Object.fromEntries(${JSON.stringify(nodeGlobals)}.split(" ").map((k) => [k, "readonly"]))
export default [{ files: ["**/*.js"], languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: node }, linterOptions: { reportUnusedDisableDirectives: "off" },
  rules: { "no-undef": "error", "no-dupe-keys": "error", "no-unreachable": "error", "no-self-assign": "error", "no-cond-assign": ["error", "except-parens"], "use-isnan": "error", "valid-typeof": "error", "no-unsafe-finally": "error", "getter-return": "error", "no-dupe-else-if": "error", "no-import-assign": "error", "no-const-assign": "error", "no-func-assign": "error", "no-unsafe-negation": "error", "no-dupe-class-members": "error", "no-duplicate-case": "error", "no-sparse-arrays": "error", "no-unsafe-optional-chaining": "error", "no-constant-binary-expression": "error", "no-self-compare": "error", "no-unmodified-loop-condition": "error", "no-async-promise-executor": "error", "no-setter-return": "error" } }]\n`)
    let json = "[]"
    try { json = execFileSync(eslint, ["-c", cfg, "-f", "json", "*.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) } catch (e) { json = e.stdout || "[]" }
    const findings = JSON.parse(json).flatMap((f) => f.messages.map((m) => `${path.basename(f.filePath)}:${m.line} [${m.ruleId}] ${m.message}`))
    ok(`no undefined names, duplicate keys or other bug shapes in ${JSON.parse(json).length} modules`, findings.length === 0 && JSON.parse(json).length > 150, findings.slice(0, 8).join(" | "))
  }
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== silent-bugs suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
