#!/usr/bin/env node
/**
 * forge v158 — a repair is recorded when it is proven, not when the run ends.
 *
 * v135 recorded "fix that worked" in the end-of-run block, and only for a run
 * that ended COMPLETED. Measured with a real headless run at v157: `npm test`
 * red → `node setup.js` → green, then the run spun out its step budget and
 * ended INCOMPLETE with 0 lessons. A run stopped by a signal (a harness
 * timeout's SIGTERM, `docker stop`) or killed outright never reached that
 * block at all. Now the lesson is written the moment the check goes green.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

/**
 * One headless run following `script`. `kill` = a signal to send once a
 * lesson is on disk (the fix is proven) while the run is still going.
 */
async function run(script, { maxSteps = 8, kill = null, pkg = null, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-proven-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify(pkg ?? { name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), `const fs = require("fs")\nif (!fs.existsSync("config.json")) { console.error("config.json is missing"); process.exit(1) }\n`)
  fs.writeFileSync(path.join(work, "setup.js"), `require("fs").writeFileSync("config.json", "{}")\n`)
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(work, f), t)
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      const n = (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "tool_result") : []).length
      const cmd = script[n]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
        ...(cmd ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: "bash", input: { command: cmd } }] } : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const rj = path.join(dir, "r.json")
  const lessonsFile = () => { try { const pd = path.join(home, ".forge", "projects"); return path.join(pd, fs.readdirSync(pd)[0], "lessons.json") } catch { return null } }
  const lessons = () => { try { return JSON.parse(fs.readFileSync(lessonsFile(), "utf8")) } catch { return [] } }
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
    "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", String(maxSteps), "--result-json", rj, "--", "make npm test pass"],
    { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })))
  let killedWhileRunning = null
  if (kill) {
    const end = Date.now() + 25000
    while (Date.now() < end && !lessons().length) await sleep(50)
    let status = null
    try { status = JSON.parse(fs.readFileSync(rj, "utf8")).status } catch { /* not written yet */ }
    killedWhileRunning = status === "RUNNING"
    child.kill(kill)
  }
  const t = setTimeout(() => child.kill("SIGKILL"), 30000)
  const exit = await exited
  clearTimeout(t)
  let status = null
  try { status = JSON.parse(fs.readFileSync(rj, "utf8")).status } catch { /* none */ }
  const out = { exit, status, lessons: lessons(), killedWhileRunning }
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}
const repairText = (l) => String(l?.successful_repair ?? "")

console.log("== a run that runs out of budget keeps what it proved ==")
{
  // After the fix, the run spins on one command: unproductive, so v99's
  // budget extension does not rescue it and it ends on its step budget.
  const r = await run(["npm test", "node setup.js", "npm test", "ls", "ls", "ls", "ls", "ls", "ls", "ls"], { maxSteps: 4 })
  ok("the run did not complete", r.status && r.status !== "COMPLETED", String(r.status))
  eq("…and the repair it proved is recorded", r.lessons.map(repairText), ["ran `node setup.js` — after which `npm test` passed"])
}

console.log("== a run stopped by a signal keeps it too ==")
for (const sig of ["SIGTERM", "SIGKILL"]) {
  // the run proves the fix, then starts something long; the harness stops it
  const r = await run(["npm test", "node setup.js", "npm test", "sleep 20"], { kill: sig })
  ok(`${sig}: the fix was proven while the run was still RUNNING`, r.killedWhileRunning === true, String(r.killedWhileRunning))
  ok(`${sig}: the run was stopped by it`, r.exit.signal === sig || r.exit.code === 143, JSON.stringify(r.exit))
  eq(`${sig}: the lesson survives`, r.lessons.map(repairText), ["ran `node setup.js` — after which `npm test` passed"])
}
{
  const r = await run(["npm test", "node setup.js", "npm test", "sleep 20"], { kill: "SIGTERM" })
  eq("SIGTERM still gets forge's final ABORTED record (v151), alongside the lesson", [r.status, r.lessons.length], ["ABORTED", 1])
}

console.log("== once per check per run ==")
{
  // The same check goes red → green twice in one run. The first proof is the
  // lesson; the second must not add another or bump it through dedup.
  const r = await run(["npm test", "node setup.js", "npm test", "rm config.json", "npm test", "node setup.js", "npm test"])
  eq("one lesson", r.lessons.length, 1)
  eq("…not credited again by its own run", [r.lessons[0]?.confidence, r.lessons[0]?.successCount ?? 0], [0.7, 0])
}

console.log("== each check that went red then green ==")
const TWO_CHECKS = {
  pkg: { name: "w", version: "1.0.0", scripts: { test: "node check.js", lint: "node lint.js" } },
  files: {
    "lint.js": `if (!require("fs").existsSync("lint.ok")) { console.error("lint config missing"); process.exit(1) }\n`,
    "fixlint.js": `require("fs").writeFileSync("lint.ok", "")\n`,
  },
}
{
  const r = await run(["npm test", "node setup.js", "npm test", "npm run lint", "node fixlint.js", "npm run lint"], TWO_CHECKS)
  eq("two lessons, one per check", r.lessons.map(repairText).sort(), [
    "ran `node fixlint.js` — after which `npm run lint` passed",
    "ran `node setup.js` — after which `npm test` passed",
  ])
}
{
  // Both checks fail before either fix: `node setup.js` also ran between
  // lint's failure and its pass, and nothing says it did not help lint. The
  // rule (v156) credits everything in between rather than guess — pinned so
  // the over-credit is a known, deliberate limit, not a surprise.
  const r = await run(["npm test", "npm run lint", "node setup.js", "npm test", "node fixlint.js", "npm run lint"], TWO_CHECKS)
  eq("interleaved: each check credits everything that ran since ITS failure", r.lessons.map(repairText).sort(), [
    "ran `node setup.js` — after which `npm test` passed",
    "ran `node setup.js`, `node fixlint.js` — after which `npm run lint` passed",
  ])
}

console.log(`\n== lesson-when-proven suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
