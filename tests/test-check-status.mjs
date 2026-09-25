#!/usr/bin/env node
// v191 — a check's own status, whatever follows it.
//
// `npm test; echo "exit=$?"` and `npm test || true` end with the LAST
// command's status, 0 — so forge recorded a passing check and counted every
// write before it as verified, while the model's own output said exit=1. And
// `npm test && git push` failing at the push was recorded as a failing check
// though the tests passed. Each check in a longer command now reports its
// own status on a tagged stderr line that forge reads and strips.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync, spawnSync } from "node:child_process"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const C = await import("../checkcmd.js")
const T = await import("../tools.js")
const A = await import("../agent.js")
const P = await import("../providers.js")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-checkstatus-"))
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js", "test:ok": "node ok.js", lint: "node lint.js" } }))
fs.writeFileSync(path.join(work, "t.js"), "console.log('1 test failed'); console.error('stack line'); process.exit(1)\n")
fs.writeFileSync(path.join(work, "ok.js"), "console.log('all passed')\n")
fs.writeFileSync(path.join(work, "lint.js"), "console.log('lint clean')\n")
const shells = ["dash", "bash"].filter((x) => { try { execFileSync(x, ["-c", "true"]); return true } catch { return false } })
const sh = (shell, c) => { const r = spawnSync(shell, ["-c", c], { cwd: work, encoding: "utf8" }); return { out: r.stdout, err: r.stderr, code: r.status } }

console.log("== 1. which commands are marked ==")
{
  const r = (c) => C.rewriteChecks(c, { nonce: "n1" })
  ok("`npm test; echo` marks the check", r('npm test; echo "exit=$?"')?.marked === 1)
  ok("`npm test || true` marks it", r("npm test || true")?.marked === 1)
  ok("two checks, two marks", r("npm run lint && npm test; echo done")?.marked === 2)
  ok("a piped check in a chain: its pipeline and its mark", (() => { const x = r("npm test 2>&1 | tail -3; echo done"); return x?.pipelines === 1 && x?.marked === 1 })())
  ok("a lone check needs no mark (its status is the command's)", r("npm test") === null && r("  npm test  ") === null)
  ok("a lone piped check: only the pipeline (v190), no mark", (() => { const x = C.rewriteChecks("npm test | grep x > out", { nonce: "n1" }); return x?.pipelines === 1 && x?.marked === 0 })())
  ok("commands with no check are left alone", r("echo a; echo b") === null && r("ls || true") === null)
  for (const c of ["(npm test); echo x", "if npm test; then echo y; fi", "npm test & echo x", "echo $(npm test); echo x"]) ok(`left as typed: ${c}`, r(c) === null)
  ok("without a nonce nothing is marked (v190's rewriteCheckPipelines is unchanged)", C.rewriteCheckPipelines('npm test; echo "exit=$?"') === null)
  // what the shell writes: the check's stderr, then forge's "\n<mark>=<n>\n"
  ok("the tagged lines are read in order and stripped exactly", (() => { const x = C.checkStatusLines("warn\n\n__FORGE_CHECK_n1=1\nmore\n\n__FORGE_CHECK_n1=0\n", "__FORGE_CHECK_n1"); return JSON.stringify(x.statuses) === "[1,0]" && x.stderr === "warn\nmore\n" })())
  ok("…after stderr with no final newline too", (() => { const x = C.checkStatusLines("partial\n__FORGE_CHECK_n1=2\n", "__FORGE_CHECK_n1"); return JSON.stringify(x.statuses) === "[2]" && x.stderr === "partial" })())
  ok("…another run's mark is not read", C.checkStatusLines("\n__FORGE_CHECK_other=1\n", "__FORGE_CHECK_n1").statuses.length === 0)
}

console.log(`== 2. in the shell (${shells.join(", ")}): the same output and status, plus the check's own ==`)
for (const shell of shells) {
  for (const [c, own] of [['npm test; echo "exit=$?"', [1]], ["npm test || true", [1]], ["npm run test:ok && false", [0]], ["false && npm test || echo rescued", []], ["npm run lint && npm test; echo done", [0, 1]], ["npm test 2>&1 | tail -1; echo done", [1]]]) {
    const x = C.rewriteChecks(c, { nonce: "n2" })
    const got = sh(shell, x.command), orig = sh(shell, c)
    const read = C.checkStatusLines(got.err, x.mark)
    ok(`${shell}: \`${c}\` — same stdout and status as typed`, got.out === orig.out && got.code === orig.code, `${JSON.stringify(got.out)} ${got.code} vs ${JSON.stringify(orig.out)} ${orig.code}`)
    ok(`${shell}: …the checks' own statuses ${JSON.stringify(own)}, and stderr as typed once stripped`, JSON.stringify(read.statuses) === JSON.stringify(own) && read.stderr === orig.err, `${JSON.stringify(read.statuses)} ${JSON.stringify(read.stderr)} vs ${JSON.stringify(orig.err)}`)
  }
}

console.log("== 3. the bash tool ==")
{
  const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 60 }
  const run = async (command) => String(await T.execTool(ctx, "bash", { command }))
  const r = await run('npm test; echo "exit=$?"')
  ok("`npm test; echo \"exit=$?\"`: [check exit code: 1]", /\[check exit code: 1\]/.test(r) && /the check in this command failed \(exit 1\)/.test(r), r)
  ok("…the command's own output is intact (exit=1 printed, stderr shown)", /exit=1/.test(r) && /stack line/.test(r), r)
  ok("…and forge's tag never reaches the model", !/__FORGE_CHECK_/.test(r), r)
  const t = await run("npm test || true")
  ok("`npm test || true`: [check exit code: 1]", /\[check exit code: 1\]/.test(t), t)
  const pushFail = await run("npm run test:ok && false")
  ok("tests pass, what follows fails: [check exit code: 0], and the command's exit 1", /\[exit code: 1\]/.test(pushFail) && /\[check exit code: 0\]/.test(pushFail) && /the check in this command passed/.test(pushFail), pushFail)
  const two = await run("npm run lint && npm test; echo done")
  ok("two checks, the second fails: [check exit code: 1] (any failing check fails the command's checks)", /\[check exit code: 1\]/.test(two), two)
  const same = await run("npm run test:ok; echo done")
  ok("check and command agree: nothing added", !/check exit code/.test(same) && !/\[forge\]/.test(same), same)
  const lone = await run("npm test")
  ok("a lone check is unchanged: its exit code, no check line", /\[exit code: 1\]/.test(lone) && !/check exit code/.test(lone), lone)
  const plain = await run("echo a; false || echo b")
  ok("a command with no check runs as typed, nothing added", /a\nb/.test(plain) && !/check exit code/.test(plain), plain)
}

console.log("== 4. the check forge records ==")
async function recorded(command, script = "node t.js") {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "forge-checkstatus-agent-"))
  fs.writeFileSync(path.join(w, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: script } }))
  fs.writeFileSync(path.join(w, "t.js"), "console.log('1 failed'); process.exit(1)\n")
  fs.writeFileSync(path.join(w, "ok.js"), "console.log('ok')\n")
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const x = 1\n" }) }
        : n === 2 ? { name: "bash", arguments: JSON.stringify({ command }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Done." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(w)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "add feature.js and run the tests", onEvent: () => {} }) } catch (e) { r = { error: e } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(w, { recursive: true, force: true })
  return { chk: (r?.commandChecks ?? []).find((c) => /npm test/.test(c.command)), v: r?.verification }
}
{
  for (const cmd of ['npm test; echo "exit=$?"', "npm test || true"]) {
    const { chk, v } = await recorded(cmd)
    ok(`\`${cmd}\` with failing tests: recorded FAILING (exit 1)`, chk?.passed === false && chk?.exitCode === 1, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode }))
    ok("…and the write before it UNVERIFIED", v?.checksPassing === 0 && v?.unverified?.some((f) => /feature\.js$/.test(f)), JSON.stringify(v))
  }
  const { chk } = await recorded("npm test && false", "node ok.js")
  ok("`npm test && <something that fails>` with passing tests: recorded PASSING", chk?.passed === true && chk?.exitCode === 0, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode }))
}

fs.rmSync(work, { recursive: true, force: true })
console.log(`== check-status suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
