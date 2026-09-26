#!/usr/bin/env node
// v193 — a pipe that ends in `head` returns when head has its lines.
//
// In the shell `npm test 2>&1 | head -3` returns at once for a watch-mode
// test: head exits after three lines and the check dies at its next write.
// forge took such pipes over (v168 `| head -N`, v189 `| … | head`) and ran
// the check to its end — which never came: the call sat out its whole
// timeout and came back "timed out". A pipe whose last stage is `head` is
// now the shell's, with v190's rewrite carrying the check's own status.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const C = await import("../checkcmd.js")
const T = await import("../tools.js")
const A = await import("../agent.js")
const P = await import("../providers.js")

console.log("== 1. which pipes end in head ==")
{
  const e = (c) => C.endsInHead(C.splitOutputFilter(c)?.filter)
  ok("`| head -3`", e("npm test 2>&1 | head -3"))
  ok("`| head -n 5` and a bare `| head`", e("npm test | head -n 5") && e("npm test | grep x | head"))
  ok("`| grep … | head -2` (v189 stages)", e("npm test 2>&1 | grep --line-buffered tick | head -2"))
  ok("…a `head` in the middle is not the end", !e("npm test | head -5 | grep x"))
  ok("`| tail -5`, `| tee log`, `| grep x` do not", !e("npm test | tail -5") && !e("npm test | tee a.log") && !e("npm test | grep x"))
  ok("`| headless-thing` is not head", !e("npm test | headless-thing"))
  ok("nothing at all", C.endsInHead(null) === false)
  ok("how many lines head keeps", C.headLines("npm test | head -3") === 3 && C.headLines("npm test | head -n 7") === 7 && C.headLines("npm test | head") === 10 && C.headLines("npm test | tail -3") === null)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-headcloses-"))
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node loop.js", "test:short": "node short.js", "test:long": "node long.js", "test:ok": "node ok.js" } }))
fs.writeFileSync(path.join(work, "loop.js"), "let i = 0; setInterval(() => console.log('tick ' + i++), 5)\n")
fs.writeFileSync(path.join(work, "short.js"), "console.log('1 test failed'); process.exit(1)\n")
fs.writeFileSync(path.join(work, "long.js"), "for (let i = 0; i < 5000; i++) console.log('line ' + i)\n")
fs.writeFileSync(path.join(work, "ok.js"), "console.log('all passed')\n")
const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 20 }
const run = async (command) => { const t = Date.now(); const r = String(await T.execTool(ctx, "bash", { command })); return { r, ms: Date.now() - t } }
const shell = (c) => { try { return execFileSync("sh", ["-c", c], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }) } catch (e) { return String(e.stdout ?? "") } }

console.log("== 2. a check that never ends: back when head has its lines ==")
{
  const a = await run("npm test 2>&1 | head -3")
  ok(`\`npm test 2>&1 | head -3\` returns at once (${a.ms}ms), not at its 20s timeout`, a.ms < 5000 && !/timed out/.test(a.r), a.r)
  ok("…with the shell's three lines", a.r.startsWith(shell("npm test 2>&1 | head -3").trimEnd()), JSON.stringify(a.r.slice(0, 120)))
  ok("…the check's own status, and a note that head cut it short", /\[exit code: [1-9]\d*\]/.test(a.r) && /`\| head` closed the pipe once it had its lines/.test(a.r), a.r)
  const g = await run("npm test 2>&1 | grep --line-buffered tick | head -2")
  ok(`\`| grep … | head -2\` returns at once too (${g.ms}ms)`, g.ms < 5000 && /^tick 0\ntick 1\n/.test(g.r) && !/tick 2\b/.test(g.r), g.r)
  const chain = await run("npm test 2>&1 | head -3 && echo NEXT")
  ok(`a chain after it: fast (${chain.ms}ms), and it stops — the check did not pass`, chain.ms < 5000 && !/NEXT/.test(chain.r), chain.r)
}

console.log("== 3. checks that end ==")
{
  const s = await run("npm run test:short 2>&1 | head -20")
  ok("a failing check shorter than head: its exit code 1 and all its lines", /\[exit code: 1\]/.test(s.r) && /1 test failed/.test(s.r), s.r)
  ok("…and it was not cut short, so the note says so plainly (no head note)", !/closed the pipe/.test(s.r) && /pipeline reported the check's own exit code/.test(s.r), s.r)
  const o = await run("npm run test:ok 2>&1 | head -5")
  ok("a passing check: its lines, no exit code, no note", /all passed/.test(o.r) && !/exit code/.test(o.r) && !/\[forge\]/.test(o.r), o.r)
  // npm prints a 4-line banner (blank, "> w@1.0.0 test:long", "> node long.js", blank)
  const l = await run("npm run test:long 2>&1 | head -7")
  ok(`a long passing check cut by head behaves as in the shell (${l.ms}ms): the first lines`, l.r.startsWith(shell("npm run test:long 2>&1 | head -7").trimEnd()) && /line 0\nline 1\nline 2/.test(l.r) && l.ms < 5000, l.r.slice(0, 200))
  const t = await run("npm run test:short 2>&1 | tail -1")
  ok("`| tail` is still forge's (v168): the check's exit code 1", /\[exit code: 1\]/.test(t.r) && /the check ran without its "\| tail -1"/.test(t.r), t.r)
}

console.log("== 4. the check forge records ==")
{
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "forge-headcloses-agent-"))
  fs.writeFileSync(path.join(w, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node loop.js" } }))
  fs.writeFileSync(path.join(w, "loop.js"), "let i = 0; setInterval(() => console.log('tick ' + i++), 5)\n")
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "bash", arguments: JSON.stringify({ command: "npm test 2>&1 | head -3", timeout_sec: 20 }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Watched." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(w)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 4 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const t0 = Date.now()
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "run the tests in watch mode and show the first lines", onEvent: () => {} }) } catch (e) { r = { error: e } }
  const took = Date.now() - t0
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(w, { recursive: true, force: true })
  const chk = (r?.commandChecks ?? []).find((c) => /npm test/.test(c.command))
  ok(`the run did not wait out the timeout (${took}ms)`, took < 15000)
  ok("the check is recorded as not passed and NOT timed out — it was cut short, as in the shell", chk && chk.passed === false && chk.timedOut === false, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode, timedOut: chk.timedOut }))
}

fs.rmSync(work, { recursive: true, force: true })
console.log(`== head-closes suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
