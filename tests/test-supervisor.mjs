import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { supervisorPolicy, supervise } from "../supervisor.js"
import { testConcurrency, suiteTimeoutMs } from "../test-runner-policy.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
let pass = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 } }

t("test concurrency is capped on Android", () => assert.equal(testConcurrency({ profile: { cores: 8, freeMB: 9000, tier: "high" }, requested: 8, android: true }), 2))
t("test concurrency falls to one under memory pressure", () => assert.equal(testConcurrency({ profile: { cores: 8, freeMB: 500, tier: "normal" }, requested: 4, android: false }), 1))
t("test timeout has a bounded default", () => assert.equal(suiteTimeoutMs({ command: "node", env: {} }), 120000))
t("bash integration keeps a longer bounded timeout", () => assert.equal(suiteTimeoutMs({ command: "bash", env: {} }), 900000))
t("supervisor degrades resources under pressure", () => assert.equal(supervisorPolicy({ availableMB: 500, profile: { cores: 8 } }).nextConcurrency, 1))
t("supervisor uses bounded exponential backoff", () => assert.equal(supervisorPolicy({ restarts: 3, availableMB: 500, profile: { cores: 8 } }).delayMs, 12000))

t("supervisor restarts a nonzero child and stops on success", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-supervisor-"))
  let calls = 0
  const spawnFn = () => {
    calls++
    const handlers = {}
    return {
      pid: 100 + calls,
      once(name, fn) { handlers[name] = fn; if (name === "close") setImmediate(() => fn(calls === 1 ? 137 : 0, calls === 1 ? "SIGKILL" : null)) },
    }
  }
  const result = await supervise(["agent", "demo"], { cwd, spawnFn, waitForRecovery: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.restarts, 1)
  const state = JSON.parse(fs.readFileSync(path.join(cwd, ".forge", "supervisor-state.json"), "utf8"))
  assert.equal(state.reason, "EXIT_0")
  assert.equal(state.restarts, 1)
})

t("supervisor source is shipped and CLI-wired", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.ok(pkg.files.includes("supervisor.js"))
  assert.ok(pkg.files.includes("test-runner-policy.js"))
  const cli = fs.readFileSync(path.join(root, "forge.js"), "utf8")
  assert.match(cli, /case "supervise"/)
  assert.match(cli, /import\("\.\/supervisor\.js"\)/)
  assert.match(cli, /a === "--"/)
})

console.log(`supervisor suite: ${pass} passed`)
