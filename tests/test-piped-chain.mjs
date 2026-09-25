#!/usr/bin/env node
// v190 — a failing piped check stops the chain after it.
//
// `npm test 2>&1 | tail -5 && git commit -m "tests pass"`: the shell gives a
// pipeline its last stage's status, so the commit ran when the tests failed.
// v168/v189 took over a piped check only when nothing followed it, and the
// shell is dash (no pipefail). Every top-level pipeline whose first stage is
// a check now carries the check's status; the rest runs as typed.
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pipechain-"))
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js", "test:ok": "node ok.js" } }))
fs.writeFileSync(path.join(work, "t.js"), "console.log('ok 1'); console.log('not ok 2'); console.error('1 test failed'); process.exit(1)\n")
fs.writeFileSync(path.join(work, "ok.js"), "console.log('ok 1'); console.log('ok 2')\n")
const sh = (shell, c) => { try { return { out: execFileSync(shell, ["-c", c], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 } } catch (e) { return { out: String(e.stdout ?? ""), code: e.status } } }
const shells = ["dash", "bash", "sh"].filter((x) => { try { execFileSync(x, ["-c", "true"]); return true } catch { return false } })

console.log("== 1. which commands are rewritten ==")
{
  for (const c of ["npm test 2>&1 | tail -5 && git commit -m x", "npm test | grep x > out.txt", "cd app && npm test 2>&1 | tail -3 && echo ok", "npm test | tail -1; npm run lint | tail -1", "npm test 2>&1 | tail -1 || echo rescue", "VAR=1 npm test | tail -1 && echo x", 'npm test | grep -E "a|b" && echo "x | y"']) {
    ok(`rewritten: ${c}`, typeof C.rewriteCheckPipelines(c) === "string")
  }
  for (const c of ["npm test && git commit -m x", "cat log | grep x && echo y", "(npm test | tail -1) && echo x", "{ npm test | tail -1; } && echo x", "if true; then npm test | tail -1; fi", "for f in a; do npm test | tail -1; done", "for f in a b; do npm run lint; npm test | tail -1; done", "while true; do npm test | tail -1; break; done", "npm test | tail -1 & echo x", "npm test | grep $(whoami) && echo x", "npm test | grep `id` && echo x", "npm test <<EOF | tail -1\nx\nEOF", "npm test | grep \"unclosed && echo x", "! npm test | tail -1", "npm test"]) {
    ok(`left as typed: ${JSON.stringify(c)}`, C.rewriteCheckPipelines(c) === null, C.rewriteCheckPipelines(c))
  }
  ok("only the pipeline that starts with a check is rewritten", (() => { const r = C.rewriteCheckPipelines("cat a | grep x && npm test | tail -1"); return r.startsWith("cat a | grep x && ") && /\{ npm test; \}/.test(r) })())
  ok("a `2>&1` or `>&2` is a redirection, not a background job", typeof C.rewriteCheckPipelines("npm test 2>&1 | tail -1 >&2 && echo x") === "string")
}

console.log(`== 2. in the shell (${shells.join(", ")}): the check's status, the same output ==`)
for (const shell of shells) {
  const cases = [
    ["npm test 2>&1 | tail -1 && echo COMMITTED", 1, "1 test failed\n"],
    ["npm run test:ok 2>&1 | tail -1 && echo COMMITTED", 0, "ok 2\nCOMMITTED\n"],
    ["npm test 2>&1 | tail -1 || echo RESCUE", 0, "1 test failed\nRESCUE\n"],
    ["npm test 2>&1 | grep -c ok > count.txt && echo COMMITTED; echo file:; cat count.txt", 0, "file:\n2\n"],
    ["cd . && npm test 2>&1 | grep not | tail -1 && echo COMMITTED", 1, "not ok 2\n"],
    ["npm run test:ok 2>&1 | grep NOTHING && echo FOUND; echo after", 0, "FOUND\nafter\n"],
  ]
  for (const [c, code, out] of cases) {
    const r = sh(shell, C.rewriteCheckPipelines(c))
    ok(`${shell}: \`${c}\` → exit ${code}`, r.code === code && r.out.replace(/\n?> w@1\.0\.0 test\S*\n> node \S+\n\n/g, "").replace(/^\n+/, "") === out, `${r.code} ${JSON.stringify(r.out)}`)
  }
  const q = sh(shell, C.rewriteCheckPipelines(`npm run test:ok | grep -E "ok 1|nope" && echo 'a | b'`))
  ok(`${shell}: quotes, and a \`|\` inside them, are kept`, q.code === 0 && /ok 1\na \| b\n$/.test(q.out), JSON.stringify(q.out))
}
ok("…and the grep-matches-nothing case shows why: the check passed, so the chain goes on (the shell would have said grep's 1)", sh("sh", "npm run test:ok 2>&1 | grep NOTHING && echo FOUND; echo after").out.trim() === "after")

console.log("== 3. the bash tool ==")
{
  execFileSync("git", ["init", "-q"], { cwd: work })
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", ...a], { cwd: work, encoding: "utf8" })
  g("add", "-A"); g("commit", "-qm", "base")
  fs.writeFileSync(path.join(work, "feature.js"), "export const broken = true\n"); g("add", "-A")
  const ctx = { cwd: work, root: work, assumeYes: true, timeoutSec: 60 }
  const run = async (command) => String(await T.execTool(ctx, "bash", { command }))
  const r = await run('npm test 2>&1 | tail -5 && git -c user.name=t -c user.email=t@x commit -qm "tests pass"')
  ok("failing tests, `| tail -5 && git commit`: no commit", g("rev-list", "--count", "HEAD").trim() === "1", g("log", "--oneline"))
  ok("…the tests' exit code 1, and a note saying why", /\[exit code: 1\]/.test(r) && /pipeline reported the check's own exit code/.test(r), r)
  ok("…the tail's lines are shown", /not ok 2/.test(r), r)
  ok("…and the command shown is the one typed, not forge's rewrite", !/__forge_s/.test(r) && !/>&3/.test(r), r)
  const good = await run('npm run test:ok 2>&1 | tail -1 && git -c user.name=t -c user.email=t@x commit -qm "tests pass"')
  ok("passing tests: the commit is made, no exit code, no note", g("rev-list", "--count", "HEAD").trim() === "2" && !/exit code/.test(good) && !/\[forge\]/.test(good), good)
  const plain = await run("cat t.js | grep -c console && echo matched")
  ok("a pipeline that is not a check runs exactly as typed", /matched/.test(plain), plain)
}

console.log("== 4. the check forge records ==")
{
  const w2 = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pipechain-agent-"))
  fs.writeFileSync(path.join(w2, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node t.js" } }))
  fs.writeFileSync(path.join(w2, "t.js"), "console.log('1 failed'); process.exit(1)\n")
  let n = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      n++
      const call = n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const x = 1\n" }) }
        : n === 2 ? { name: "bash", arguments: JSON.stringify({ command: "npm test 2>&1 | tail -5 && echo ALL-GOOD" }) } : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: call }] } : { role: "assistant", content: "Done." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(w2)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "add feature.js and run the tests", onEvent: () => {} }) } catch (e) { r = { error: e } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(w2, { recursive: true, force: true })
  const chk = (r?.commandChecks ?? []).find((c) => /npm test/.test(c.command))
  ok("`npm test 2>&1 | tail -5 && echo ALL-GOOD` is recorded as a FAILING check", chk && chk.passed === false && chk.exitCode === 1, JSON.stringify(chk && { passed: chk.passed, exitCode: chk.exitCode }))
  ok("…so the write before it is UNVERIFIED", r?.verification?.checksPassing === 0 && r?.verification?.unverified?.some((f) => /feature\.js$/.test(f)), JSON.stringify(r?.verification))
}

fs.rmSync(work, { recursive: true, force: true })
console.log(`== piped-chain suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
