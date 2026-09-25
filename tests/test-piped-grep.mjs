#!/usr/bin/env node
// v189 — a check piped through any filter keeps its own exit code.
//
// v168/v172 took over `| tail`, `| head` and `| tee`. A model filtering noise
// — `npm test 2>&1 | grep -v "^npm warn"` — still got grep's exit code: the
// tests failed, grep matched a line, the run saw success and forge recorded a
// passing check, which counts every write before it as verified. The shell is
// dash (no PIPESTATUS, no pipefail). forge now runs the check and feeds its
// output to the same stages, exactly as typed.
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

console.log("== 1. which pipes are run as stages ==")
{
  const f = (c) => C.splitOutputFilter(c)
  ok("`| grep -v \"…\"`", JSON.stringify(f('npm test 2>&1 | grep -v "^npm warn"')) === JSON.stringify({ base: "npm test 2>&1", filter: { kind: "pipe", stages: 'grep -v "^npm warn"', n: 0 }, merged: true }))
  ok("a `|` inside quotes belongs to its stage", f('npm test | grep -E "fail|pass" | head -3')?.filter.stages === 'grep -E "fail|pass" | head -3')
  ok("single quotes too", f("pytest | grep -E 'FAILED|ERROR'")?.filter.stages === "grep -E 'FAILED|ERROR'")
  ok("a `cd … &&` before the check is kept with it", f("cd app && npm test 2>&1 | sort | uniq -c")?.base === "cd app && npm test 2>&1")
  ok("`| grep x | tee log` — several stages, tee among them", f("npm test | grep x | tee log")?.filter.stages === "grep x | tee log")
  ok("a lone `| tail -N`, `| head -N`, `| tee FILE` keep their own handling", f("npm test | tail -5")?.filter.kind === "tail" && f("npm test | head -2")?.filter.kind === "head" && f("npm test | tee a.log")?.filter.kind === "tee")
  for (const c of ["npm test | grep x || true", "npm test | grep x > out.txt", "npm test | grep x; echo done", "npm test | grep x && echo ok", "npm test | grep $(whoami)", "npm test | grep `id`", "npm test | grep x &", "npm test | grep \"unclosed", "cat log | grep x", "grep FAIL log | sort", "npm test"]) {
    ok(`left to the shell, as typed: ${c}`, f(c) === null, JSON.stringify(f(c)))
  }
  ok("a `;` inside quotes is part of the pattern, not a chain", f('npm test | grep "a;b"')?.filter.stages === 'grep "a;b"')
  ok("normalizing: `npm test 2>&1 | grep -v x` is `npm test`", C.normalizeCommand("npm test 2>&1 | grep -v x") === "npm test")
}

console.log("== 2. the bash tool: the shell's lines, the check's exit code ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pipegrep-"))
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js", "test:good": "node good.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), "console.log('npm warn deprecated thing'); for (let i = 0; i < 5; i++) console.log(`ok ${i}`); console.log('not ok 5 - adds'); console.error('1 test failed'); process.exit(1)\n")
  fs.writeFileSync(path.join(work, "good.js"), "console.log('npm warn deprecated thing'); console.log('all 6 passed')\n")
  const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 60 }
  const run = async (command) => String(await T.execTool(ctx, "bash", { command }))
  const shell = (command) => { try { return execFileSync("sh", ["-c", command], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } catch (e) { return e.stdout } }
  const body = (r) => r.split("\n[forge]")[0].replace(/\n\[exit code: \d+\][\s\S]*$/, "")

  for (const c of ['npm test 2>&1 | grep -v "^npm warn"', 'npm test 2>&1 | grep -E "not ok|failed" | head -1', "npm test 2>&1 | sort | uniq -c | sort -rn | head -2", "npm test 2>&1 | grep -c ok"]) {
    const r = await run(c)
    ok(`\`${c}\`: the tests' exit code 1`, /\[exit code: 1\]/.test(r), r)
    ok("…exactly the lines the shell shows", body(r).trimEnd() === shell(c).trimEnd(), `${JSON.stringify(body(r))} vs ${JSON.stringify(shell(c))}`)
  }
  const r = await run('npm test 2>&1 | grep -v "^npm warn"')
  ok("the note names the stages and why the code differs", /the check ran first and its output went through "\| grep -v/.test(r) && /exit code is the check's own/.test(r), r)
  const unmerged = await run('npm test | grep -v "^npm warn"')
  ok("without 2>&1 the check's stderr is still shown, as on a terminal", /1 test failed/.test(unmerged) && /\[exit code: 1\]/.test(unmerged), unmerged)
  const none = await run("npm test 2>&1 | grep NOTHING-MATCHES")
  ok("a stage that matches nothing: empty output, still the tests' exit code (not grep's 1 by chance)", /\[exit code: 1\]/.test(none) && !/ok 0/.test(none), none)
  const good = await run('npm run test:good 2>&1 | grep -v "^npm warn"')
  ok("a passing check is unchanged: its lines, no exit code, no note", /all 6 passed/.test(good) && !/npm warn/.test(good) && !/exit code/.test(good) && !/\[forge\]/.test(good), good)
  const goodMiss = await run("npm run test:good 2>&1 | grep NOTHING")
  ok("…and a passing check whose grep matches nothing is still a pass (the shell said 1)", !/exit code/.test(goodMiss), goodMiss)
  const badRe = await run('npm test 2>&1 | grep -E "("')
  ok("a stage that errors (a bad regex): its message is shown, and the tests' exit code", /\[exit code: 1\]/.test(badRe) && /Unmatched|parenthes/i.test(badRe), badRe)
  const plain = await run("cat t.js | grep -c console")
  ok("a command that is not a check runs exactly as typed", !/exit code/.test(plain) && /^\d/.test(plain.trim()), plain)
  await run("npm test 2>&1 | grep ok | tee kept.log")
  ok("a tee among the stages writes its file, as the shell's would", fs.readFileSync(path.join(work, "kept.log"), "utf8") === shell("npm test 2>&1 | grep ok"), fs.existsSync(path.join(work, "kept.log")) ? fs.readFileSync(path.join(work, "kept.log"), "utf8") : "no file")
  fs.writeFileSync(path.join(work, "big.js"), "console.log('THE-FIRST-LINE'); const l = 'x'.repeat(99) + '\\n'; for (let i = 0; i < 60000; i++) process.stdout.write(l); console.log('THE-LAST-LINE'); process.exitCode = 2\n")
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node big.js" } }))
  const big = await run("npm test 2>&1 | grep -v x")
  ok("a 6MB check log through grep is not killed as an overflow — its first line and its last", /THE-FIRST-LINE/.test(big) && /THE-LAST-LINE/.test(big) && /\[exit code: 2\]/.test(big) && !/exceeded/.test(big), big.slice(-200))
  const head = await run("npm test 2>&1 | head -1 | grep x")
  ok("an early-closing stage (head) does not break the run", /\[exit code: 2\]/.test(head), head.slice(0, 200))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log("== 3. the check forge records: failing, and the write before it unverified ==")
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pipegrep-agent-"))
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(work, "t.js"), "console.log('npm warn x'); console.log('1 failed'); process.exit(1)\n")
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const x = 1\n" }) }
        : n === 2 ? { name: "bash", arguments: JSON.stringify({ command: 'npm test 2>&1 | grep -v "^npm warn"' }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Done — tests pass." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "add feature.js and run the tests", onEvent: () => {} }) } catch (e) { r = { error: e } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(work, { recursive: true, force: true })
  const chk = (r?.commandChecks ?? []).find((c) => /npm test/.test(c.command))
  ok("the grep-filtered check is recorded as FAILING", chk && chk.passed === false && chk.exitCode === 1, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode }))
  ok("…so the write before it is reported UNVERIFIED", r?.verification?.checksPassing === 0 && r?.verification?.unverified?.some((f) => /feature\.js$/.test(f)), JSON.stringify(r?.verification))
}

console.log(`== piped-grep suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
