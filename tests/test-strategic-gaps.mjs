#!/usr/bin/env node
/**
 * Strategic Core gap closure — three gaps found by reading the live path
 * (not filenames), each closed inside the module that already owns it:
 *
 *   A. a thrashing run no longer earns more step budget      (agent.js)
 *   B. replans remember this run's failed approaches and
 *      contradicted assumptions                               (understanding.js,
 *                                                              replan.js, meta.js)
 *   C. command prohibitions in the task ("don't push") are
 *      refused at the tool boundary                           (goal-contract.js,
 *                                                              agent.js)
 *
 * A and C run the REAL runAgent loop against a scripted mock provider; B
 * drives the real understanding record and the real replan prompt builder.
 * Zero network beyond 127.0.0.1.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${String(detail).slice(0, 400)}` : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-strategic-"))
process.env.FORGE_HOME = HOME
const A = await import("../agent.js")
const P = await import("../providers.js")

/**
 * A scripted model: `script(done)` gets the number of tool results so far and
 * returns the next tool call ({ name, args }) or null for a final answer.
 */
async function runScripted({ script, task, maxSteps = 6, setup = () => {} }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-strategic-work-"))
  setup(work)
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const done = (j.messages ?? []).filter((m) => m.role === "tool").length
      const call = script(done)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: `t${done}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: "assistant", content: "Done." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps }, skills: { enabled: false }, tools: { assumeYes: true } }
  const events = []
  let r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task, onEvent: (e) => events.push(e), journal: false }) } catch (e) { r = { error: e } }
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  return { r, events, work }
}

const pkg = (testScript) => (work) => fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: testScript } }))

console.log("== A0. a refusal is not a check run ==")
{
  const R = A.refusedBeforeRun
  ok("BLOCKED with no status → refused", R("BLOCKED: bash already failed 2× with identical arguments (TEST_FAILURE)"))
  ok("ERROR with no status → refused", R("ERROR: write tools are disabled"))
  ok("a command that ran and failed is not a refusal", !R("> t@1.0.0 test\nError: boom\n[exit code: 1]"))
  ok("a spawn failure carries its status and is not a refusal", !R("ERROR: spawn npm ENOENT\n[exit code: 127]"))
  ok("a command that ran and passed (no marker) is not a refusal", !R("PASS  all 12 tests"))
  ok("a timeout is not a refusal", !R("ERROR: command timed out after 120s"))
  ok("a check whose status the shell could not report is not a refusal", !R("ERROR: x\n[forge] check status unknown"))
}

console.log("== A. a thrashing run earns no more budget ==")
{
  // edit app.js, run the tests, edit again, run again… the check never passes
  const thrash = await runScripted({
    task: "make the tests pass",
    setup: pkg("node -e \"process.exit(1)\""),
    script: (done) => (done % 2 === 0
      ? { name: "write_file", args: { path: "app.js", content: `export const v = ${done}\n` } }
      : { name: "bash", args: { command: "npm test" } }),
  })
  const { r, events } = thrash
  const fails = (r?.commandChecks ?? []).filter((c) => /npm test/.test(c.command) && c.passed === false).length
  ok("the same check failed 3 times across edits (a rerun after an edit is allowed)", fails >= 3, `fails=${fails} status=${r?.status} err=${r?.error?.message ?? ""}`)
  ok("no refused rerun is recorded as a passing check", (r?.commandChecks ?? []).every((c) => c.passed === false), JSON.stringify((r?.commandChecks ?? []).map((c) => c.passed)))
  eq("no step-budget extension was granted", r?.stepExtensions, 0)
  ok("it stopped at the budget it was given", r?.steps === 6, `steps=${r?.steps}`)
  const refused = events.find((e) => e.type === "step_budget_not_extended")
  ok("the refusal says why: thrashing, on which check", refused?.reason === "thrashing" && /npm test/.test(refused?.command ?? "") && refused?.fails >= 3, JSON.stringify(refused ?? null))

  // control: the same shape, but the check passes on the third try → the
  // writes are progress, and the extension is granted as before
  const ctl = await runScripted({
    task: "make the tests pass",
    setup: pkg("node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('= 4') ? 0 : 1)\""),
    script: (done) => (done >= 9 ? null : done % 2 === 0
      ? { name: "write_file", args: { path: "app.js", content: `export const v = ${done}\n` } }
      : { name: "bash", args: { command: "npm test" } }),
  })
  const passed = (ctl.r?.commandChecks ?? []).some((c) => /npm test/.test(c.command) && c.passed)
  ok("control: the check passed once the right edit landed", passed, JSON.stringify((ctl.r?.commandChecks ?? []).map((c) => c.passed)))
  ok("control: a run making real progress still gets its extension", ctl.r?.stepExtensions >= 1, `extensions=${ctl.r?.stepExtensions} steps=${ctl.r?.steps}`)
  ok("control: no thrashing refusal", !ctl.events.some((e) => e.type === "step_budget_not_extended"))
}

console.log("== B. replans remember this task's failures ==")
{
  const U = await import("../understanding.js")
  const { replanPrompt } = await import("../replan.js")
  const { replanMemory } = await import("../meta.js")
  const u = U.deriveUnderstanding("Fix the CSV parser in parse.js so quoted commas work; do not change api.js")
  const cog = { understanding: () => u }

  // replan #1 replaces a plan whose n2 failed and whose n3 never ran
  const plan1 = [
    { id: "n2", objective: "patch the parser with a regex split", status: "failed", error: "tests still red: quoted comma split" },
    { id: "n3", objective: "update the README", status: "pending" },
  ]
  const p1 = replanPrompt({ objective: "fix csv", reason: "tests failed", failed: plan1, ...replanMemory(cog) })
  ok("a step that ran and failed is listed as FAILED", /THESE STEPS FAILED[\s\S]*n2: patch the parser with a regex split — tests still red/.test(p1), p1)
  ok("a step that never ran is NOT called failed", !/THESE STEPS FAILED[\s\S]*n3:/.test(p1.split("NOT STARTED")[0]) && /NOT STARTED[\s\S]*n3: update the README/.test(p1), p1)
  ok("nothing rejected yet on the first replan", !/ALREADY TRIED/.test(p1))

  // the controller emits PLAN_REPLAN_STARTED with the failed steps; the ONE
  // understanding observes it (cognition.observeEvent → understanding.observe)
  U.observe(u, { type: "PLAN_REPLAN_STARTED", failedSteps: [{ id: "n2", objective: plan1[0].objective, error: plan1[0].error }] })
  U.observe(u, { type: "PLAN_REPLAN_STARTED", failedSteps: [{ id: "n2", objective: plan1[0].objective, error: plan1[0].error }] })
  eq("the failed approach is recorded once as rejected, with why", u.rejected.map((r) => [r.text, r.why]), [[plan1[0].objective, plan1[0].error]])

  // replan #2 replaces a NEW plan (n2 is gone from it) — before this change
  // the regex approach was invisible to it
  const plan2 = [{ id: "m1", objective: "rewrite the tokenizer as a state machine", status: "failed", error: "timeout" }]
  const p2 = replanPrompt({ objective: "fix csv", reason: "stuck", failed: plan2, ...replanMemory(cog) })
  ok("the second replan still sees what the first plan tried", /ALREADY TRIED IN THIS TASK AND REJECTED[\s\S]*patch the parser with a regex split — tests still red/.test(p2), p2)

  // §11: a check that fails and touches an assumption contradicts it
  const it = { id: "a1", kind: "requirement", type: U.UTYPE.ASSUMED, text: "the parser module is parse.js", subject: "parse.js", confidence: 0.5, evidence: [], source: "test" }
  u.items.push(it)
  U.observe(u, { type: "command_check", command: "node --test parse.test.js", passed: false, tail: "Error: Cannot find module './parse.js'" })
  eq("the failing check contradicted the assumption", it.type, U.UTYPE.CONTRADICTED)
  const p3 = replanPrompt({ objective: "fix csv", reason: "stuck", failed: [], ...replanMemory(cog) })
  ok("the replan is told which assumption the evidence contradicted", /ASSUMPTIONS THE EVIDENCE CONTRADICTED[\s\S]*the parser module is parse\.js — `node --test parse\.test\.js` failed/.test(p3), p3)
  eq("no understanding → empty memory, never a throw", replanMemory(null), { rejected: [], contradicted: [] })
  eq("…and a throwing one too", replanMemory({ understanding: () => { throw new Error("x") } }), { rejected: [], contradicted: [] })
}

console.log("== C. forbidden commands are refused at the tool ==")
{
  const G = await import("../goal-contract.js")
  const cases = [
    ["Fix the bug. Do not push.", "git push origin main", true],
    ["Fix the bug. Do not push.", "git status", false],
    ["Fix it, but don't push to main until I review", "git -C repo push", true],
    ["Add push notifications; do not change api.js", "git push", false],
    ["Never commit secrets.", "git commit -m x", false],
    ["Don't commit the .env file.", "git commit -am x", false],
    ["Make the change without committing.", "git add . && git commit -m wip", true],
    ["Do not publish to npm.", "npm publish --tag next", true],
    ["Do not publish to npm.", "npm test", false],
    ["Don't add new dependencies.", "npm install lodash", true],
    ["Don't add new dependencies.", "npm install", false],
    ["Don't add new dependencies.", "npm ci", false],
    ["Don't add new dependencies.", "npm i -D vitest", true],
    ["Do not install new packages.", "pip install -r requirements.txt", false],
    ["Do not install new packages.", "pip install requests", true],
    ["Do not install new packages.", "pip install -e .", false],
    ["Never run `make deploy` here.", "make deploy", true],
    ["Never run `make deploy` here.", "make deploy-docs", false],
    ["Never run `make deploy` here.", "make build && make deploy", true],
    ["Run the tests and fix the parser.", "git push", false],
    ["Push the fix when tests pass.", "git push", false],
    // semantic classes: "do not deploy", "don't touch the database"
    ["Fix the login bug. Do not deploy.", "kubectl apply -f k8s/", true],
    ["Fix the login bug. Do not deploy.", "terraform plan", false],
    ["Fix the login bug. Do not deploy.", "terraform apply -auto-approve", true],
    ["Fix the login bug. Do not deploy.", "vercel --prod", true],
    ["Fix the login bug. Do not deploy.", "vercel dev", false],
    ["Fix the login bug. Do not deploy.", "npm run deploy", true],
    ["Fix the login bug. Do not deploy.", "npm run build", false],
    ["Fix the login bug. Do not deploy.", "git push heroku main", true],
    ["Fix the login bug. Do not deploy.", "docker build -t app .", false],
    ["Fix the login bug. Do not deploy.", "docker push registry/app:1", true],
    ["Fix the login bug. Do not deploy.", "gcloud run deploy api", true],
    ["Fix the deployment docs.", "kubectl apply -f x", false],
    ["Update the deployment script but do not deploy it.", "./deploy.sh", true],
    ["Add an index. Do not touch the production database.", "npx prisma migrate deploy", true],
    ["Add an index. Do not touch the production database.", "npx prisma generate", false],
    ["Add an index. Do not touch the production database.", "psql $DATABASE_URL -c \"DROP TABLE users\"", true],
    ["Add an index. Do not touch the production database.", "psql -c \"select count(*) from users\"", false],
    ["Write the migration but don't run migrations.", "rails db:migrate", true],
    ["Write the migration but don't run migrations.", "rails generate migration AddIndex", false],
    ["Do not modify user data.", "python manage.py flush --noinput", true],
    ["Do not modify user data.", "python manage.py test", false],
    ["Speed up the database queries.", "rails db:migrate", false],
  ]
  const wrong = cases.filter(([o, c, want]) => Boolean(G.commandBreaksProhibition(G.prohibitedCommands(o), c)) !== want).map(([o, c]) => `${o} | ${c}`)
  eq(`the rules match exactly what they should (${cases.length} cases, incl. content-only and positive phrasings)`, wrong, [])
  eq("several prohibitions in one request", G.prohibitedCommands("Fix it. Do not push, and do not publish. Never run `rm -rf build`.").map((r) => r.id), ["push", "publish", "cmd:rm -rf build"])

  const pushScript = (done) => (done === 0 ? { name: "bash", args: { command: "git push origin main" } } : null)
  const blocked = await runScripted({ task: "Fix the typo in README.md. Do not push.", script: pushScript })
  const res = (blocked.r?.toolLog ?? []).find((t) => t.name === "bash")
  ok("the forbidden push was refused, not run", /^BLOCKED: the task says not to push to a remote/.test(String(res?.result ?? "")), String(res?.result ?? blocked.r?.error?.message ?? "").slice(0, 200))
  ok("…and the refusal is an observable event naming the rule", blocked.events.some((e) => e.type === "TOOL_BLOCKED" && e.prohibition === "push"))

  // a controller worker: its own task is one step of the plan; the user's
  // "do not push" lives in the understanding it adopted from the controller
  const U = await import("../understanding.js")
  const shared = U.deriveUnderstanding("Rename the helper in util.js and update callers. Do not push.")
  const workerTask = "Step 3: finish up and sync the branch"
  ok("the worker's own step text carries no prohibition", G.prohibitedCommands(workerTask).length === 0)
  const prevRun = A.runAgent
  const work2 = await (async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-strategic-work-"))
    const srv = http.createServer((req, res2) => { let b = ""; req.on("data", (c) => { b += c }); req.on("end", () => { const j = JSON.parse(b); const done = j.messages.filter((m) => m.role === "tool").length; const call = done === 0 ? { name: "bash", arguments: JSON.stringify({ command: "git push" }) } : null; res2.writeHead(200, { "content-type": "application/json" }); res2.end(JSON.stringify({ id: "c", choices: [{ message: call ? { role: "assistant", content: "", tool_calls: [{ id: "t0", type: "function", function: call }] } : { role: "assistant", content: "Done." }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) }) })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    const prev = process.cwd(); process.chdir(workdir)
    const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 4 }, skills: { enabled: false }, tools: { assumeYes: true } }
    const ev = []
    let r = null
    try { r = await prevRun({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: workerTask, understanding: shared, onEvent: (e) => ev.push(e), journal: false }) } catch (e) { r = { error: e } }
    process.chdir(prev); await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
    return { r, ev }
  })()
  const wres = (work2.r?.toolLog ?? []).find((t) => t.name === "bash")
  ok("a worker inherits the user's prohibition through the shared understanding", /^BLOCKED: the task says not to push/.test(String(wres?.result ?? "")), String(wres?.result ?? work2.r?.error?.message ?? "").slice(0, 200))

  const free = await runScripted({ task: "Show me the repo status.", script: (done) => (done === 0 ? { name: "bash", args: { command: "git status" } } : null) })
  const fres = (free.r?.toolLog ?? []).find((t) => t.name === "bash")
  ok("with no prohibition, the command runs as before", fres && !/^BLOCKED: the task says not to/.test(String(fres.result)), String(fres?.result ?? "").slice(0, 160))
}

console.log(`\n== strategic-gaps suite: ${PASS} passed, ${FAIL} failed ==`)
fs.rmSync(HOME, { recursive: true, force: true })
process.exit(FAIL ? 1 : 0)
