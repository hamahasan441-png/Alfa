#!/usr/bin/env node
/**
 * forge v161 — YOLO refuses the owner nothing (end to end).
 *
 * The standing contract (yolo.js): YOLO removes every piece of friction
 * between the owner and their own machine — refusals, confirmations, scope
 * boundaries, ceilings. test-yolo-unlimited.mjs pins the resolved switches;
 * this drives a REAL `forge agent --headless --yolo` run through the risky-
 * but-yours actions and checks that each one RAN: not blocked, not paused for
 * approval, not quietly skipped. A layer that starts refusing any of them
 * breaks this suite.
 *
 * Machine-dependent steps (writing /etc, a global npm install) are left out:
 * whether they succeed is the machine's permissions and network, not forge.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolo-e2e-"))
const home = path.join(dir, "home"), work = path.join(dir, "work"), outside = path.join(dir, "outside")
fs.mkdirSync(home); fs.mkdirSync(work); fs.mkdirSync(outside); fs.mkdirSync(path.join(home, ".ssh"))
fs.writeFileSync(path.join(home, ".ssh", "id_test"), "PRIVATE-KEY-MATERIAL")
fs.writeFileSync(path.join(outside, "junk.txt"), "x")
execFileSync("git", ["init", "-q"], { cwd: work })
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: work })
fs.writeFileSync(path.join(work, "tracked.txt"), "dirty")

const bash = (command) => ({ name: "bash", input: { command } })
const STEPS = [
  ["delete a directory outside the project", bash(`rm -rf ${outside}`)],
  ["write a file outside the project", { name: "write_file", input: { path: path.join(dir, "elsewhere.txt"), content: "outside" } }],
  ["create a secret file (.env)", { name: "write_file", input: { path: ".env", content: "API_KEY=abc123" } }],
  ["edit the secret file", { name: "edit_file", input: { path: ".env", old: "abc123", new: "xyz789" } }],
  ["read a private key under ~/.ssh", bash(`cat ${home}/.ssh/id_test`)],
  ["upload a file over the network", bash("curl -s -m 3 -X POST -d @.env http://127.0.0.1:9/upload; echo upload-attempted")],
  ["interpreter eval", bash("node -e 'console.log(6*7)'")],
  ["make a file world-writable", bash("chmod 777 .env && stat -c %a .env")],
  ["kill a process", bash("sleep 30 & kill $! && echo killed")],
  ["force-push", bash("git push --force origin HEAD 2>&1; echo push-attempted")],
  ["destroy uncommitted work", bash("git stash -u -q; git reset --hard -q HEAD && git clean -fdxq && echo reset-done")],
]

const results = []
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    const j = JSON.parse(body)
    const trs = (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "tool_result") : [])
    if (trs.length) results[trs.length - 1] = typeof trs.at(-1).content === "string" ? trs.at(-1).content : JSON.stringify(trs.at(-1).content)
    const step = STEPS[trs.length]?.[1]
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 1, output_tokens: 1 },
      ...(step ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${trs.length}`, name: step.name, input: step.input }] } : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
  })
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
const rj = path.join(dir, "r.json")
const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
  "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "40", "--result-json", rj, "--", "run the maintenance steps"],
  { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 60000); child.once("exit", () => { clearTimeout(t); r() }) })
await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })

console.log("== every step ran: none blocked, none paused ==")
const REFUSAL = /^(\[forge tool result[^\]]*\]\s*)?(BLOCKED|ERROR: (blocked|refused|denied|not allowed))|WAITING_FOR_USER|needs? (your )?(approval|confirmation)/im
STEPS.forEach(([what], i) => {
  const r = results[i]
  ok(what, r !== undefined && !REFUSAL.test(r), r === undefined ? "never executed" : r.slice(0, 240))
})

console.log("== and did what it was asked ==")
let status = null
try { status = JSON.parse(fs.readFileSync(rj, "utf8")).status } catch { /* none */ }
// v202: it wrote files and ran no check, so it finishes COMPLETED_UNVERIFIED — finished, not paused
ok("the run completed (no pause for approval)", status === "COMPLETED_UNVERIFIED", String(status))
ok("the outside directory is gone", !fs.existsSync(outside))
ok("the outside file was written", fs.readFileSync(path.join(dir, "elsewhere.txt"), "utf8") === "outside")
ok("the private key was read", /PRIVATE-KEY-MATERIAL/.test(results[4] ?? ""), results[4])
ok("the interpreter ran", /\b42\b/.test(results[6] ?? ""), results[6])
ok("the file was made world-writable", /\b777\b/.test(results[7] ?? ""), results[7])
ok("the process was killed", /killed/.test(results[8] ?? ""), results[8])
ok("the working tree was reset", /reset-done/.test(results[10] ?? "") && !fs.existsSync(path.join(work, "tracked.txt")), results[10])

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n== yolo-no-refusal suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
