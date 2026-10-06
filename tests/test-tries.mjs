#!/usr/bin/env node
/**
 * forge agent --tries N: several attempts, the check keeps one (tries.js).
 *
 * Driven through the REAL CLI: each attempt is a real `forge agent` child in
 * its own git worktree, against a mock model that answers per attempt (it
 * reads the attempt's working directory from the system prompt). The task:
 * make add.js add. The check: does add(2, 3) return 5.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 700) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tries-"))
const HOME = path.join(TMP, "home"); fs.mkdirSync(HOME)
process.env.FORGE_HOME = HOME

const T = await import("../tries.js")

// ---- the mock model ---------------------------------------------------------
// plan[attempt] = the add.js body that attempt writes (null: writes nothing)
let plan = {}
const firstCalls = {} // attempt → how many runs started there
const WRONG = "module.exports = (a, b) => a - b\n"
const RIGHT = "module.exports = (a, b) => a + b\n"
const RIGHT_LONG = "// adds two numbers\n// (a longer way to say the same thing)\nmodule.exports = function add(a, b) {\n  const sum = a + b\n  return sum\n}\n"
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    let j = {}
    try { j = JSON.parse(body) } catch { }
    const msgs = j.messages ?? []
    const system = String(msgs.find((m) => m.role === "system")?.content ?? "")
    const agent = /autonomous terminal coding agent/.test(system)
    const hasResult = msgs.some((m) => m.role === "tool")
    const at = /try-(\d+)/.exec(/Working directory: (\S+)/.exec(system)?.[1] ?? "")?.[1] ?? "main"
    let msg = { role: "assistant", content: "DONE" }
    if (agent && !hasResult) {
      firstCalls[at] = (firstCalls[at] ?? 0) + 1
      const content = plan[at] ?? plan.main
      if (content) msg = { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `cat > add.js <<'EOF'\n${content}EOF` }) } }] }
    }
    if (j.stream && !msg.tool_calls) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: "stop" }] })}\n\n`)
      return res.end("data: [DONE]\n\n")
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
      choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
const writeConfig = (agentExtra = {}) => fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({
  activeProvider: "mock",
  providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" } },
  tools: { assumeYes: true },
  agent: { maxSteps: 3, ...agentExtra },
}))
writeConfig()

// ---- a project ----------------------------------------------------------------
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
function project(name, { scripts = null } = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir)
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t")
  fs.writeFileSync(path.join(dir, "add.js"), "module.exports = () => 0\n")
  fs.writeFileSync(path.join(dir, "README.md"), "# probe\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", ...(scripts ? { scripts } : {}) }, null, 1) + "\n")
  fs.writeFileSync(path.join(dir, ".gitignore"), ".forge/\n")
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init")
  return dir
}
const CHECK = `node -e "process.exit(require('./add.js')(2,3)===5?0:1)"`

const run = (cwd, ...args) => new Promise((resolve) => {
  const resultFile = path.join(TMP, `result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", ...args, "--result-json", resultFile], {
    cwd, env: { PATH: process.env.PATH, HOME, FORGE_HOME: HOME, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
  const t = setTimeout(() => child.kill("SIGKILL"), 240000)
  child.on("close", (code) => {
    clearTimeout(t)
    let result = null
    try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")) } catch { }
    resolve({ code, out, result })
  })
})
const summaryOf = (r) => { try { return JSON.parse(fs.readFileSync(r.result.tries.summary, "utf8")) } catch { return null } }
const worktrees = (dir) => git(dir, "worktree", "list").trim().split("\n").length
const reset = (p) => { plan = p; for (const k of Object.keys(firstCalls)) delete firstCalls[k] }

try {
  console.log("== 1. the rules, without a model ==")
  {
    eq("--tries absent is one attempt", T.parseTries(undefined), { n: 1, error: null })
    eq("--tries 3", T.parseTries("3").n, 3)
    ok("--tries 0 is refused", /from 1 to 8/.test(T.parseTries("0").error ?? ""))
    ok("--tries 9 is refused", T.parseTries(9).error != null)
    const A = (n, { check, agent = "COMPLETED", bytes = 10, error = null } = {}) => ({ n, error, agent: { status: agent, exitCode: 0 }, check: check == null ? null : { ok: check }, change: { bytes } })
    eq("with a usable check, the check decides — not the agent", T.attemptPassed(A(1, { check: false, agent: "COMPLETED" }), { checkUsable: true }), false)
    eq("…a passing check wins even when the agent said INCOMPLETE", T.attemptPassed(A(1, { check: true, agent: "INCOMPLETE" }), { checkUsable: true }), true)
    eq("without a usable check, the agent's result decides", T.attemptPassed(A(1, { agent: "COMPLETED" }), { checkUsable: false }), true)
    eq("…but a check that cannot discriminate must still pass", T.attemptPassed(A(1, { agent: "COMPLETED", check: false }), { checkUsable: false }), false)
    eq("an attempt that errored never passes", T.attemptPassed(A(1, { check: true, error: "boom" }), { checkUsable: true }), false)
    eq("the smallest passing change wins", T.pickWinner([A(1, { check: true, bytes: 90 }), A(2, { check: true, bytes: 30 }), A(3, { check: false, bytes: 1 })], { checkUsable: true })?.n, 2)
    eq("…ties go to the earliest", T.pickWinner([A(2, { check: true, bytes: 30 }), A(1, { check: true, bytes: 30 })], { checkUsable: true })?.n, 1)
    eq("no passing attempt, no winner", T.pickWinner([A(1, { check: false })], { checkUsable: true }), null)
  }

  console.log("== 2. one at a time: the first passing attempt wins, the rest never run ==")
  {
    const P = project("seq")
    reset({ 1: WRONG, 2: RIGHT, 3: RIGHT })
    const r = await run(P, "make add.js add its two arguments", "--single", "--tries", "3", "--check", CHECK)
    ok("exit 0: an attempt passed", r.code === 0, r.out.slice(-1500))
    eq("attempt 1 ran once, attempt 2 ran once, attempt 3 never", [firstCalls[1], firstCalls[2], firstCalls[3]], [1, 1, undefined])
    eq("your checkout has the passing change", fs.readFileSync(path.join(P, "add.js"), "utf8"), RIGHT)
    ok("the check passes in your checkout now", (() => { try { execFileSync("/bin/sh", ["-c", CHECK], { cwd: P }); return true } catch { return false } })())
    eq("the result file says COMPLETED, attempt 2 won", [r.result?.status, r.result?.tries?.winner, r.result?.tries?.passed], ["COMPLETED", 2, [2]])
    ok("the report names the winner and what was applied", /2\. WINNER/.test(r.out) && /applied attempt 2 to your checkout: add\.js/.test(r.out), r.out.slice(-800))
    eq("every worktree is gone", worktrees(P), 1)
    const s = summaryOf(r)
    ok("attempt 1's losing change is kept in forge's data folder", s && fs.existsSync(s.attempts[0].change.patchPath) && s.attempts[0].change.patchPath.startsWith(HOME), JSON.stringify(s?.attempts?.[0]?.change))
    ok("…and each attempt's log", s && fs.existsSync(path.join(s.store, "attempt-1.log")))
    ok("the baseline was measured: the check failed before any attempt", s?.baseline?.ok === false && s?.checkUsable === true)
    ok("nothing was written outside the project and forge's data folder", !fs.existsSync(path.join(P, "..", "seq-tries")))
  }

  console.log("== 3. attempts start from your working tree, uncommitted work included ==")
  {
    const P = project("seed")
    fs.writeFileSync(path.join(P, "README.md"), "# probe\nuncommitted line\n")
    fs.writeFileSync(path.join(P, "helper.js"), "module.exports = 1\n")
    reset({ 1: RIGHT })
    const SEEDCHECK = `node -e "require('./helper.js'); process.exit(require('./add.js')(2,3)===5?0:1)"`
    const r = await run(P, "make add.js add", "--single", "--tries", "2", "--check", SEEDCHECK)
    ok("the attempt passed a check that needs your untracked helper.js", r.code === 0 && r.result?.tries?.winner === 1, r.out.slice(-1200))
    const s = summaryOf(r)
    eq("its change is only what IT did — your edits are not counted as its change", s?.attempts?.[0]?.change?.files, ["add.js"])
    eq("your uncommitted edit is still there", fs.readFileSync(path.join(P, "README.md"), "utf8"), "# probe\nuncommitted line\n")
    ok("…your untracked file too, still untracked", fs.existsSync(path.join(P, "helper.js")) && /\?\? helper\.js/.test(git(P, "status", "--porcelain")))
    eq("…and the winner landed on top of them", fs.readFileSync(path.join(P, "add.js"), "utf8"), RIGHT)
    ok("the report says attempts started from your working tree", /uncommitted changes included/.test(r.out))
  }

  console.log("== 4. no attempt passes: your checkout is untouched ==")
  {
    const P = project("none")
    reset({ 1: WRONG, 2: WRONG })
    const r = await run(P, "make add.js add", "--single", "--tries", "2", "--check", CHECK)
    eq("exit 1", r.code, 1)
    eq("add.js unchanged", fs.readFileSync(path.join(P, "add.js"), "utf8"), "module.exports = () => 0\n")
    eq("git status is clean", git(P, "status", "--porcelain").trim(), "")
    eq("the result file says INCOMPLETE: no attempt passed", [r.result?.status, r.result?.reason], ["INCOMPLETE", "no attempt passed"])
    ok("the report says so and where an attempt's change is kept", /no attempt passed — your checkout was not changed/.test(r.out) && /git apply .*attempt-1\.patch/.test(r.out), r.out.slice(-800))
    eq("no worktree left behind", worktrees(P), 1)
  }

  console.log("== 5. --parallel: a round runs at once; the smallest passing change wins ==")
  {
    const P = project("par")
    reset({ 1: WRONG, 2: RIGHT_LONG, 3: RIGHT })
    const t0 = Date.now()
    const r = await run(P, "make add.js add", "--single", "--tries", "3", "--parallel", "3", "--check", CHECK)
    ok("exit 0", r.code === 0, r.out.slice(-1200))
    eq("all three ran", [firstCalls[1], firstCalls[2], firstCalls[3]], [1, 1, 1])
    eq("two passed; the smaller change (attempt 3) won", [r.result?.tries?.passed, r.result?.tries?.winner], [[2, 3], 3])
    eq("your checkout has attempt 3's change", fs.readFileSync(path.join(P, "add.js"), "utf8"), RIGHT)
    ok("the report says three at a time", /3 at a time/.test(r.out))
    console.log(`       (parallel run took ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }
  {
    const P = project("rounds")
    reset({ 1: WRONG, 2: RIGHT, 3: RIGHT, 4: RIGHT })
    const r = await run(P, "make add.js add", "--single", "--tries", "4", "--parallel", "2", "--check", CHECK)
    eq("--parallel 2 of 4: the first round has a pass, so round two never runs", [firstCalls[1], firstCalls[2], firstCalls[3], firstCalls[4]], [1, 1, undefined, undefined])
    eq("…and attempt 2 won", r.result?.tries?.winner, 2)
  }

  console.log("== 6. the check: detected, or unable to decide ==")
  {
    const P = project("detect", { scripts: { test: "node check.js" } })
    fs.writeFileSync(path.join(P, "check.js"), "process.exit(require('./add.js')(2,3)===5?0:1)\n")
    git(P, "add", "-A"); git(P, "commit", "-q", "-m", "check")
    reset({ 1: WRONG, 2: RIGHT })
    const r = await run(P, "make add.js add", "--single", "--tries", "2")
    const s = summaryOf(r)
    ok("with no --check, the project's own tests are the check", s?.checkSource === "detected" && /npm/.test(s?.check ?? ""), JSON.stringify({ check: s?.check, src: s?.checkSource }))
    eq("…and they decided: attempt 1 failed them, attempt 2 passed", r.result?.tries?.winner, 2)
    ok("the report says it used your project's tests", /your project's tests/.test(r.out), r.out.slice(-600))
  }
  {
    const P = project("always")
    reset({ 1: WRONG })
    const r = await run(P, "make add.js add", "--single", "--tries", "2", "--check", "true")
    const s = summaryOf(r)
    ok("a check that passes before any attempt is measured as unable to decide", s?.baseline?.ok === true && s?.checkUsable === false)
    ok("…and the report says the agent's own result decided", /cannot tell attempts apart/.test(r.out), r.out.slice(-600))
  }

  console.log("== 7. refusals and limits ==")
  {
    const NOGIT = path.join(TMP, "nogit"); fs.mkdirSync(NOGIT)
    const r = await run(NOGIT, "make add.js add", "--single", "--tries", "2", "--check", CHECK)
    ok("outside a git repository: exit 2, and it says why", r.code === 2 && /not inside a git repository/.test(r.out), r.out.slice(-400))
    const P = project("limits")
    ok("--tries 9: exit 2", (await run(P, "x", "--tries", "9")).code === 2)
    const par = await run(P, "x", "--tries", "2", "--parallel", "3")
    ok("--parallel above --tries: exit 2", par.code === 2 && /--parallel must be/.test(par.out), par.out.slice(-300))
    const pl = await run(P, "x", "--tries", "2", "--plan")
    ok("--tries with --plan: exit 2", pl.code === 2 && /use one or the other/.test(pl.out), pl.out.slice(-300))
  }
  {
    // agent.tries in the config: the parent tries, each attempt runs ONCE
    writeConfig({ tries: 2 })
    const P = project("cfg")
    reset({ 1: WRONG, 2: WRONG })
    const r = await run(P, "make add.js add", "--single", "--check", CHECK)
    eq("agent.tries: 2 runs two attempts — and no attempt starts tries of its own", [firstCalls[1], firstCalls[2], Object.keys(firstCalls).length], [1, 1, 2])
    ok("…both reported", r.result?.tries?.count === 2, JSON.stringify(r.result?.tries))
    writeConfig()
    reset({ main: RIGHT })
    const P2 = project("one")
    const r1 = await run(P2, "make add.js add", "--single")
    ok("without --tries, a run is a normal run in your checkout", r1.code === 0 && !r1.result?.tries && fs.readFileSync(path.join(P2, "add.js"), "utf8") === RIGHT && firstCalls.main === 1, r1.out.slice(-500))
  }
} finally {
  srv.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== tries suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
