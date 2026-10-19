#!/usr/bin/env node
/**
 * forge knows WHAT KIND of workspace a task has — a folder, a file, a GitHub
 * repository, an archive, a project found by name, a new project, forge
 * itself, or no folder at all — and says so in one line; and under full
 * control a workspace the task named is where it works, not a wall.
 *
 * Measured on the code before this change (13 phrasings, scripted model):
 *   - "what is a closure?", "write a haiku", "generate a uuid" from the home
 *     folder were told "this is the home folder, not a project: put a new
 *     project in its own folder";
 *   - "improve forge's retry logic", "fix your own bug in agent.js",
 *     "upgrade yourself" from ~ stayed in ~ — never forge's own source;
 *   - "improve your own retry logic" inside forge's source was warned "this is
 *     probably NOT where the user's project lives";
 *   - with YOLO on (the default: "nothing is refused"), a write outside a
 *     named workspace was refused, and `forge yolo` did not list it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-wskinds-")))
const H = path.join(TMP, "home")
process.env.HOME = H
process.env.FORGE_HOME = path.join(TMP, "forge-home")
process.env.NO_COLOR = "1"
const BOUND = ["FORGE_BOUND_ROOT", "FORGE_BOUND_INFO", "FORGE_BOUND_KIND", "FORGE_SOURCE_LOCK", "FORGE_LAUNCH_CWD", "FORGE_YOLO", "FORGE_PROJECT_BOUNDARY"]
const clear = () => { for (const k of BOUND) delete process.env[k] }
clear()
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })
const APP = path.join(H, "projects", "app")
fs.mkdirSync(path.join(APP, "src"), { recursive: true })
fs.writeFileSync(path.join(APP, "package.json"), '{"name":"app"}\n')
execFileSync("git", ["init", "-q"], { cwd: APP })
fs.mkdirSync(path.join(H, "notes"), { recursive: true })
fs.writeFileSync(path.join(H, "notes", "todo.md"), "- eggs\n")
fs.mkdirSync(path.join(H, "site"), { recursive: true })

const T = await import("../taskpaths.js")
const S = await import("../sourceresolve.js")
const W = await import("../workspace.js")
const FORGE = W.forgeRuntimeRoot()

console.log("== a task about forge itself ==")
{
  const self = (t, cwd = H) => W.taskTargetsForge(t, { cwd })
  for (const t of ["improve forge's retry logic", "fix your own bug in agent.js", "upgrade yourself", "improve yourself", "improve your own source code", "improve alfa", "alfa's web panel is slow, fix it", "audit the forge codebase"]) ok(`about forge: "${t}"`, self(t), t)
  for (const t of ["fix your own bug", "review your own code", "write your own parser for the config", "forge a plan for the migration", "make yourself a coffee", "fix the bug in src/agent.js"]) ok(`not about forge: "${t}"`, !self(t, APP), t)
  ok("inside forge's own tree, 'improve your own retry logic' is forge", self("improve your own retry logic", FORGE))
  // started inside some other project, only what cannot be about that project
  const strict = (t) => W.taskTargetsForge(t, { cwd: APP, strict: true })
  ok("in a game project, 'fix the forge recipe in src/game.js' is the game's forge", !strict("fix the forge recipe in src/game.js") && !strict("improve the forge's heat value"))
  ok("…'upgrade yourself' and 'improve forge's own source' still are forge", strict("upgrade yourself") && strict("improve the forge source code") && strict("improve alfa"))
}

console.log("== a task that needs no folder ==")
{
  for (const t of ["what is a closure in javascript?", "write a haiku about rain", "generate a uuid for me", "explain how git rebase works", "translate hello to kurdish", "Why is the sky blue?"]) ok(`no files: "${t}"`, T.taskNeedsNoFiles(t), t)
  for (const t of ["create a todo app", "write a python script that prints primes", "make me a website for my cafe", "what does this project do?", "edit ~/notes/todo.md", "how do I add a page to my app?", "fix https://github.com/me/app"]) ok(`needs a place: "${t}"`, !T.taskNeedsNoFiles(t), t)
}

console.log("== what the model is told, kind by kind ==")
{
  const told = async (task, cwd = H) => {
    clear()
    const b = await S.adoptInvocationSource({ task, cwd, chdir: false })
    const d = W.workspaceDecision({ cwd: b.localPath ?? cwd, task, bound: b })
    return { b, d, text: W.formatWorkspace(d.workspace) }
  }
  const cases = [
    ["what is a closure in javascript?", H, /kind: task only/, /needs no project folder/],
    ["create a todo app", H, /kind: home folder — no project/, /put a new project in its own folder/],
    ["edit ~/notes/todo.md and add milk", H, /kind: file — the folder it is in/, /Focus: todo\.md/],
    ["work on the folder ~/site and add a page", H, /kind: folder the task names/, /The workspace is .*site/],
    ["fix my app project", H, /kind: project found by name/, /found at .*projects\/app/],
    ["create a new project in ~/projects/todo", H, /kind: new project folder/, /was created and is the workspace/],
    ["improve forge's retry logic", H, /kind: forge itself/, /forge's own source tree/],
    ["upgrade yourself", APP, /kind: forge itself/, /forge's own source tree/],
    ["add a login page", APP, /kind: project where forge was started/, /a git repository/],
    ["fix your own bug", APP, /kind: project where forge was started/, /projects\/app/],
    ["fix the forge recipe in src/game.js", APP, /kind: project where forge was started/, /projects\/app/],
    ["move ~/notes/todo.md into ~/site/", H, /kind: several places the task names/, /more than one folder/],
  ]
  for (const [task, cwd, kindRe, lineRe] of cases) {
    const r = await told(task, cwd)
    ok(`"${task}" → ${String(kindRe).slice(1, -1).replace("kind: ", "")}`, kindRe.test(r.text) && lineRe.test(r.text), r.text.replace(new RegExp(TMP, "g"), "…"))
  }
  const r = await told("improve forge's retry logic", H)
  ok("a task about forge from ~ moves into forge's own source", r.b.ok && r.b.localKind === "self" && r.b.localPath === fs.realpathSync(FORGE) && process.env.FORGE_BOUND_ROOT === r.b.localPath, JSON.stringify({ kind: r.b.localKind, path: r.b.localPath }))
  const r2 = await told("review forge's retry logic and put the report in ~/notes", H)
  ok("…unless the task names another place to work", r2.b.localKind !== "self" && r2.b.localPath === path.join(H, "notes"), JSON.stringify({ kind: r2.b.localKind, path: r2.b.localPath }))
  // a GitHub repository the run bound (#150) — the decision from its record
  const gh = W.workspaceDecision({ cwd: APP, task: "fix the README in https://github.com/me/other", bound: { ok: true, action: "target", localPath: path.join(TMP, "clone"), previousCwd: H, canonical: "me/other" } })
  ok("a GitHub repository the task names is said as such", gh.workspaceKind === "GitHub repository me/other", gh.workspaceKind)
  clear()
}

console.log("== under full control a named workspace is where to work, not a wall ==")
{
  const { boundWorkspaceEnforced, yoloState, formatYolo } = await import("../yolo.js")
  const { defaultConfig } = await import("../config.js")
  const cfg = defaultConfig()
  ok("shipped defaults (YOLO on): a named workspace is advisory", boundWorkspaceEnforced(cfg, yoloState(cfg, {}), {}) === false)
  ok("FORGE_YOLO=0 (forge --safe): enforced", boundWorkspaceEnforced(cfg, yoloState(cfg, { FORGE_YOLO: "0" }), { FORGE_YOLO: "0" }) === true)
  ok("tools.projectBoundary pinned: enforced, YOLO or not", boundWorkspaceEnforced({ ...cfg, tools: { ...cfg.tools, projectBoundary: true } }, null, {}) === true)
  ok("forge yolo lists it (on)", /named workspace: where the run works, not a wall/.test(formatYolo(yoloState(cfg, {}))))
  ok("forge yolo lists it (off)", /named workspace: ENFORCED/.test(formatYolo(yoloState(cfg, { FORGE_YOLO: "0" }))))

  // the real agent, both ways
  const { runTask } = await import("../runtask.js")
  const { runAgent } = await import("../agent.js")
  const run = async ({ env = {} } = {}) => {
    clear()
    Object.assign(process.env, env)
    let sys = null
    const script = [
      { call: "write_file", args: { path: "todo.md", content: "- eggs\n- milk\n" } },
      { call: "write_file", args: { path: "../site/also.txt", content: "x\n" } },
      { say: "Added milk." },
    ]
    const srv = http.createServer((req, res) => {
      let b = ""
      req.on("data", (c) => { b += c })
      req.on("end", () => {
        let body = {}; try { body = JSON.parse(b) } catch { }
        if (sys == null) sys = String((body.messages ?? []).find((m) => m.role === "system")?.content ?? "")
        const n = (body.messages ?? []).filter((m) => m.role === "tool").length
        const st = script[n] ?? { say: "done" }
        const message = st.call ? { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: st.call, arguments: JSON.stringify(st.args) } }] } : { role: "assistant", content: st.say }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      })
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    fs.rmSync(path.join(H, "site", "also.txt"), { force: true })
    fs.writeFileSync(path.join(H, "notes", "todo.md"), "- eggs\n")
    const prev = process.cwd()
    process.chdir(H)
    const events = []
    let out = null, err = null
    try {
      out = await runTask({ task: "edit ~/notes/todo.md and add milk", mode: "single", provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "k", model: "m" }, runAgent, env: {}, config: { ...cfg, agent: { ...cfg.agent, verifyNudge: false, modelStrategy: false } }, onEvent: (e) => events.push(e), agentOpts: { journal: false } })
    } catch (e) { err = e }
    process.chdir(prev)
    srv.closeAllConnections?.(); srv.close()
    const results = events.filter((e) => e.type === "tool_result").map((e) => String(e.result ?? ""))
    return { out, err, sys: sys ?? "", results, landed: fs.existsSync(path.join(H, "site", "also.txt")), milk: fs.readFileSync(path.join(H, "notes", "todo.md"), "utf8").includes("milk") }
  }
  const a = await run()
  ok("YOLO (the default): the run works in ~/notes", a.milk && !a.err, a.err?.message)
  ok("…a write elsewhere is not refused", a.landed && !a.results.some((r) => /BLOCKED/.test(r)), a.results.join(" | ").slice(0, 300))
  ok("…and is listed in the result as an outside write", (a.out?.res?.outsideWrites ?? []).some((f) => /site\/also\.txt$/.test(f)), JSON.stringify(a.out?.res?.outsideWrites))
  ok("…the prompt says where to work and that nothing is refused", /6a\. This task's workspace is .*notes: work there/.test(a.sys) && /nothing outside it is refused/.test(a.sys) && /\[workspace\] kind: file — the folder it is in/.test(a.sys), a.sys.split("\n").filter((l) => /6a|kind:/.test(l)).join(" | "))
  const b = await run({ env: { FORGE_YOLO: "0" } })
  ok("forge --safe (FORGE_YOLO=0): the write elsewhere is refused", !b.landed && b.results.some((r) => /BLOCKED/.test(r)), b.results.join(" | ").slice(0, 300))
  ok("…and the prompt says so", /6a\. This task's workspace is .*notes\. File writes .* are REFUSED/.test(b.sys), b.sys.split("\n").filter((l) => /6a/.test(l)).join(" | "))
  clear()
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
console.log(`\n== workspace-kinds suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
