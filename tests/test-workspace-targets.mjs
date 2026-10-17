#!/usr/bin/env node
/**
 * forge knows its workspace: the folder, file, archive, repository or project
 * a task names — not only the directory forge was started in.
 *
 * Measured on main before this change, 13 realistic phrasings: only the two
 * where the file was already in the launch checkout were recognised. Every
 * absolute or ~/ path, folder, ../ path, project .zip, GitHub file link and
 * local project named by name ran in the launch directory, and the model was
 * told nothing but "Working directory: <path>". "audit <github url>" stopped
 * to ask because only change verbs counted as working on a repository.
 *
 * Unit cases run taskpaths.js / sourceresolve.js / workspace.js against a
 * fixture home (HOME overridden). The end-to-end case runs the real agent
 * (runtask.js → agent.js) against a scripted OpenAI-compatible mock over HTTP.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-wst-")))
const H = path.join(TMP, "home")
process.env.HOME = H
process.env.FORGE_HOME = path.join(TMP, "forge-home")
process.env.NO_COLOR = "1"
const BOUND_KEYS = ["FORGE_BOUND_ROOT", "FORGE_BOUND_INFO", "FORGE_BOUND_KIND", "FORGE_SOURCE_LOCK", "FORGE_LAUNCH_CWD"]
const clearBinding = () => { for (const k of BOUND_KEYS) delete process.env[k] }
clearBinding()

// fixture home: a git project, a plain folder, a loose file, a project zip
const APP = path.join(H, "projects", "app")
fs.mkdirSync(path.join(APP, "src"), { recursive: true })
fs.mkdirSync(path.join(H, "site"), { recursive: true })
fs.mkdirSync(path.join(H, "notes"), { recursive: true })
fs.mkdirSync(path.join(H, "Downloads"), { recursive: true })
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })
fs.writeFileSync(path.join(APP, "package.json"), '{"name":"app"}\n')
fs.writeFileSync(path.join(APP, "src", "main.js"), "export const x = 1\n")
fs.writeFileSync(path.join(APP, "README.md"), "# app\n")
const git = (...a) => execFileSync("git", a, { cwd: APP, stdio: "ignore" })
git("init", "-q"); git("checkout", "-q", "-b", "main"); git("remote", "add", "origin", "https://github.com/me/app.git"); git("add", "-A")
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
fs.writeFileSync(path.join(H, "site", "index.html"), "<h1>site</h1>\n")
fs.writeFileSync(path.join(H, "notes", "todo.md"), "- eggs\n")
const { makeStoreZip } = await import("../zipingest.js")
fs.writeFileSync(path.join(H, "Downloads", "proj.zip"), makeStoreZip({ "package.json": '{"name":"zipped"}\n', "index.js": "1\n" }))
// for the review regressions: a second project, a project without git, a
// credential folder, a build archive inside the launch project
const API = path.join(H, "projects", "api")
fs.mkdirSync(API, { recursive: true }); fs.writeFileSync(path.join(API, "package.json"), '{"name":"api"}\n')
const NG = path.join(H, "ng")
fs.mkdirSync(path.join(NG, "src"), { recursive: true }); fs.writeFileSync(path.join(NG, "package.json"), '{"name":"ng"}\n'); fs.writeFileSync(path.join(NG, "src", "a.js"), "1\n")
fs.mkdirSync(path.join(H, ".ssh"), { recursive: true }); fs.writeFileSync(path.join(H, ".ssh", "config"), "Host x\n")
fs.mkdirSync(path.join(APP, "dist"), { recursive: true }); fs.writeFileSync(path.join(APP, "dist", "app.zip"), makeStoreZip({ "a.txt": "a\n" }))

const T = await import("../taskpaths.js")
const S = await import("../sourceresolve.js")
const W = await import("../workspace.js")

console.log("== what the task names, resolved ==")
{
  const L = (task, cwd = H) => T.localTargetsInTask(task, { cwd })
  let r = L(`fix the bug in ${APP}/src/main.js`)
  ok("an absolute file path → its repository, the file as focus", r.action === "target" && r.root === APP && r.kind === "repo" && r.focus.join() === "src/main.js", JSON.stringify(r))
  r = L("in ~/projects/app add a login page")
  ok("a ~/ folder → that repository", r.action === "target" && r.root === APP, JSON.stringify(r))
  r = L("work on the folder ~/site and make the title bigger")
  ok("a plain folder (not git) → that folder", r.action === "target" && r.root === path.join(H, "site") && r.kind === "folder", JSON.stringify(r))
  r = L("edit ~/notes/todo.md and add milk")
  ok("a loose file → its folder, the file as focus", r.action === "target" && r.root === path.join(H, "notes") && r.focus.join() === "todo.md", JSON.stringify(r))
  r = L("change the heading in ../../site/index.html", APP)
  ok("started in a project, a file elsewhere is told, not bound (the project stays the workspace)", r.action === "none" && (r.outsideFiles ?? []).includes(path.join(H, "site", "index.html")), JSON.stringify(r))
  r = L("change the heading in ~/site/index.html")
  ok("started in the home folder, a file elsewhere → its folder", r.action === "target" && r.root === path.join(H, "site"), JSON.stringify(r))
  r = L("open the project at projects/app and run its tests")
  ok("a relative folder path → that repository", r.action === "target" && r.root === APP, JSON.stringify(r))
  r = L("fix the tests in ~/Downloads/proj.zip")
  ok("a project .zip → the archive", r.action === "target" && r.kind === "zip", JSON.stringify(r))
  r = L("create a new project in ~/projects/todo")
  ok("a folder the task asks to create → that folder (to be created)", r.action === "target" && r.kind === "new-dir" && r.create === true && r.root === path.join(H, "projects", "todo"), JSON.stringify(r))
  r = L("fix README.md", APP)
  ok("a file already in the launch checkout → stay, file as focus", r.action === "none" && r.focus.join() === "README.md", JSON.stringify(r))

  // what must NOT move the workspace
  r = L("add a host entry to /etc/hosts", APP)
  ok("a system file is never the workspace (/etc stays unbound)", r.action === "none" && (r.outsideFiles ?? []).includes("/etc/hosts"), JSON.stringify(r))
  ok("a code snippet path that is not on disk is ignored", L('import x from "./utils"', APP).action === "none")
  ok("a URL is not a path", T.pathTokensInTask("see https://github.com/me/app and fix src/a.js").map((x) => x.token).join() === "src/a.js")
  ok("an scp remote is not a local path", T.pathTokensInTask("scp me@host:/x/y here").length === 0)
  r = L("move ~/notes/todo.md into ~/site/")
  ok("places in two different trees → not bound (binding would block the move)", r.action === "spread" && r.places.length === 2, JSON.stringify(r))
  ok("a path that does not exist without create intent is not created", L("look at ~/nowhere/thing").action === "none")
  ok("create intent never targets a system tree", L("create a new folder in /etc/forge-test").action === "none")
  ok("quoted paths may contain spaces", T.pathTokensInTask('edit "~/My Notes/todo.md" now').map((x) => x.token).join() === "~/My Notes/todo.md")

  // a local project by name — only when forge was not started in a project
  r = T.namedProjectInTask("fix my app project", { cwd: H })
  ok("a project named by name, started from ~ → found", r.action === "target" && r.root === APP, JSON.stringify(r))
  ok("…started inside a git project → none", T.namedProjectInTask("fix my app project", { cwd: APP }).action === "none")
  ok("generic words are not project names ('my flutter app')", T.namedProjectInTask("fix my flutter app", { cwd: H }).action === "none")
  fs.mkdirSync(path.join(H, "code", "app"), { recursive: true }); fs.writeFileSync(path.join(H, "code", "app", "package.json"), "{}")
  r = T.namedProjectInTask("fix my app project", { cwd: H })
  ok("two projects by that name → ask, listing both", r.action === "ask" && r.candidates.length === 2, JSON.stringify(r))
  fs.rmSync(path.join(H, "code"), { recursive: true, force: true })
}

console.log("== GitHub links ==")
{
  const p = S.parseRepositoryUrl("https://github.com/me/app/blob/main/src/main.js")
  ok("a link to a file keeps the file", p.kind === "git" && p.slug === "me/app" && p.file === "src/main.js", JSON.stringify(p))
  ok("'audit <repo url>' is working on the repository (it used to stop and ask)", S.repoIntentInTask("audit https://github.com/me/app", { cwd: H }).action === "target")
  ok("'explain <repo url>' too", S.repoIntentInTask("explain https://github.com/me/app", { cwd: H }).action === "target")
  ok("a local folder that looks like owner/name is not a GitHub repository", S.repoIntentInTask("fix projects/app", { cwd: H }).action !== "target")
  clearBinding()
  const b = await S.adoptInvocationSource({ task: "audit https://github.com/me/app/blob/main/src/main.js", cwd: APP, chdir: false })
  ok("a file link to this checkout's repository: reused, with the file as focus", b.ok && b.action === "reuse-workspace" && (b.focus ?? []).join() === "src/main.js", JSON.stringify({ ok: b.ok, action: b.action, focus: b.focus, error: b.error }))
}

console.log("== binding and what the model is told ==")
{
  const run = async (task, cwd = H) => {
    clearBinding()
    const b = await S.adoptInvocationSource({ task, cwd, chdir: false })
    const d = W.workspaceDecision({ cwd: b.localPath ?? cwd, task, bound: b })
    return { b, d, told: W.formatWorkspace(d.workspace), confined: process.env.FORGE_BOUND_ROOT ?? null }
  }
  let r = await run("edit ~/notes/todo.md and add milk")
  ok("a named file binds its folder (writes confined there)", r.b.ok && r.b.action === "target" && r.b.localPath === path.join(H, "notes") && r.confined === path.join(H, "notes"), JSON.stringify(r.b))
  ok("the model is told the workspace, what it is, why, and the focus", /workspace: .*notes — a folder, not a git repository/.test(r.told) && /the task names ~\/notes\/todo\.md/.test(r.told) && /Focus: todo\.md/.test(r.told), r.told)
  r = await run(`fix the bug in ${APP}/src/main.js`)
  ok("a repository is described with its remote and branch", /a git repository \(github\.com\/me\/app\), branch main, node project/.test(r.told), r.told)
  r = await run("fix the tests in ~/Downloads/proj.zip")
  ok("a project .zip is unpacked and its copy is the workspace", r.b.ok && r.b.localKind === "zip" && fs.existsSync(path.join(r.b.localPath, "package.json")) && /unpacked to/.test(r.told), JSON.stringify(r.b))
  r = await run("create a new project in ~/projects/todo")
  ok("a folder the task asks for is created and bound", r.b.ok && fs.existsSync(path.join(H, "projects", "todo")) && /asks for a new project/.test(r.told), r.told)
  r = await run("fix my app project")
  ok("a project found by name is bound and the model is told how it was found", r.b.ok && r.b.localPath === APP && /names the project "app", found at/.test(r.told), r.told)
  r = await run("create a todo app")
  ok("started in the home folder with no place named: not bound, told to make its own folder", r.b.action === "cwd" && !r.confined && /This is the home folder, not a project: put a new project in its own folder/.test(r.told), r.told)
  r = await run("move ~/notes/todo.md into ~/site/")
  ok("two trees: not bound, both places told", r.b.action === "cwd" && !r.confined && /more than one folder/.test(r.told), r.told)
  r = await run("what does this project do?", APP)
  ok("an ordinary run in a project still says what the workspace is", /workspace: .*app — a git repository/.test(r.told) && !r.confined, r.told)
  // the CLI / chat bind first and lock; the run keeps the reason
  clearBinding()
  await S.adoptInvocationSource({ task: "edit ~/notes/todo.md and add milk", cwd: H, chdir: false })
  process.env.FORGE_SOURCE_LOCK = "bound"
  const again = await S.adoptInvocationSource({ task: "edit ~/notes/todo.md and add milk", cwd: path.join(H, "notes"), chdir: false })
  const d2 = W.workspaceDecision({ cwd: path.join(H, "notes"), task: "edit ~/notes/todo.md and add milk", bound: again })
  ok("under the CLI/chat lock the reason and focus survive", again.action === "target" && /Focus: todo\.md/.test(W.formatWorkspace(d2.workspace)), JSON.stringify(again))
  clearBinding()
}

console.log("== what an independent review found (each was a real failure) ==")
{
  const L = (task, cwd) => T.localTargetsInTask(task, { cwd })
  const bindFrom = async (task, cwd) => { clearBinding(); const b = await S.adoptInvocationSource({ task, cwd, chdir: false }); return { b, bound: process.env.FORGE_BOUND_ROOT ?? null } }
  // 1. a path the task only REFERS to must not move the run and lock the project
  let r = await bindFrom("write a README like ../../site/index.html", APP)
  ok("1 'like <path>' from inside a project: not bound, the project stays", r.b.action === "cwd" && !r.bound, JSON.stringify({ a: r.b.action, bound: r.bound }))
  r = await bindFrom("the crash log is in /tmp, fix the crash", APP)
  ok("1 'the log is in /tmp' from inside a project: not bound", r.b.action === "cwd" && !r.bound, JSON.stringify({ a: r.b.action, bound: r.bound }))
  ok("1 'follow the style of ~/site': a reference", L("follow the style of ~/site", H).action === "none")
  r = await bindFrom("in ~/projects/api add a health route", APP)
  ok("1 an explicit 'in <another project>' from inside a project still moves the run", r.b.action === "target" && r.bound === API, JSON.stringify({ a: r.b.action, bound: r.bound }))
  // 2. an ordinary verb is not "create a folder"
  for (const [task, cwd, dir] of [["start the dev server and check ./logs", APP, path.join(APP, "logs")], ["generate output in ./out", APP, path.join(APP, "out")], ["make sure ~/x works", H, path.join(H, "x")]]) {
    r = await bindFrom(task, cwd)
    ok(`2 '${task}': no folder created, not bound`, !fs.existsSync(dir) && !r.bound, JSON.stringify({ a: r.b.action, bound: r.bound }))
  }
  ok("2 'create a folder ./docs' inside a project does not rebind the run", L("create a folder ./docs", APP).action === "none")
  // 3. a project without git is the project, not its src/ folder
  ok("3 started in a non-git project, 'fix src/a.js' stays at the project root", L("fix src/a.js", NG).action === "none")
  r = L("fix ~/ng/src/a.js", H)
  ok("3 from ~, a file in a non-git project → the project root (its manifest), not src/", r.action === "target" && r.root === NG && r.focus.join() === "src/a.js", JSON.stringify(r))
  ok("3 started in a folder of projects, a file in one of them → that project", L("fix app/src/main.js", path.join(H, "projects")).root === APP)
  // 4. the write check for a named folder: reads and git work, writes outside are refused, the process tool too
  {
    const Tl = await import("../tools.js")
    clearBinding()
    // a root outside the temp dir: writes to temp space are allowed by design
    process.env.FORGE_BOUND_ROOT = "/srv/forge-ws-test/notes"; process.env.FORGE_BOUND_KIND = "local"
    const v = (c) => Tl.boundShellVerdict(c, "/srv/forge-ws-test/notes")
    ok("4 reading elsewhere is not refused", v("cat /srv/forge-ws-test/other/README.md") === null && v("ls ../other") === null)
    ok("4 git init / git pull are not refused", v("git init") === null && v("git pull") === null)
    ok("4 a redirect outside is refused", /^BLOCKED: .*writes outside it are refused/.test(v("echo x > /srv/forge-ws-test/esc.txt") ?? ""), v("echo x > /srv/forge-ws-test/esc.txt"))
    ok("4 a file command inside sh -c is refused", /^BLOCKED/.test(v("sh -c 'cp a /srv/forge-ws-test/b'") ?? ""))
    ok("4 a write inside the workspace is not refused", v("echo x > out.txt") === null && v("cp a.txt b.txt") === null && v("mkdir -p sub/dir") === null)
    process.env.FORGE_BOUND_ROOT = path.join(H, "notes")
    const vh = (c) => Tl.boundShellVerdict(c, path.join(H, "notes"))
    ok("4 a home dotfile write is outside the workspace", /^BLOCKED/.test(vh(`echo x >> ${path.join(H, ".bashrc")}`) ?? ""))
    process.env.FORGE_BOUND_ROOT = "/srv/forge-ws-test/notes"
    const ctx = Tl.makeToolContext({ cwd: "/srv/forge-ws-test/notes", root: "/srv/forge-ws-test/notes", assumeYes: true, unrestricted: true, memoryPath: path.join(TMP, "m.json"), todoPath: path.join(TMP, "t.json") })
    const out = String(await Tl.execTool(ctx, "process", { action: "spawn", command: "echo x > /srv/forge-ws-test/esc.txt" }))
    ok("4 a background process that writes outside is refused before it starts", /^BLOCKED/.test(out), out.slice(0, 160))
    Tl.disposeToolManagers?.()
    clearBinding()
  }
  // 5. a token in the remote URL never reaches the model
  {
    const CRED = path.join(H, "cred")
    fs.mkdirSync(CRED, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: CRED }); execFileSync("git", ["remote", "add", "origin", "https://hama:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/me/cred.git"], { cwd: CRED })
    const told = W.formatWorkspace(W.resolveWorkspace({ cwd: CRED, task: "fix it" }))
    ok("5 the remote is shown without its credential", /github\.com\/me\/cred/.test(told) && !/ghp_|hama:/.test(told), told)
    const mine = W.workspaceDecision({ cwd: CRED, task: "fix my github repo" })
    ok("5 …also in the 'my github repo' line", !/ghp_|hama:/.test(mine.line ?? ""), mine.line)
    fs.rmSync(CRED, { recursive: true, force: true })
  }
  // 6. a GitHub link the task only refers to is not the repository to work on
  ok("6 'run our tests the way <url> does' does not make that repository the workspace", S.repoIntentInTask("run our tests the way https://github.com/vitest-dev/vitest does it", { cwd: APP }).action !== "target")
  // 7. the binding does not outlive the task
  {
    await bindFrom("edit ~/notes/todo.md and add milk", H)
    const before = process.env.FORGE_BOUND_ROOT
    await S.adoptInvocationSource({ task: "move ~/notes/todo.md into ~/site/", cwd: H, chdir: false })
    ok("7 a later task over two trees drops the earlier binding", before === path.join(H, "notes") && !process.env.FORGE_BOUND_ROOT, JSON.stringify({ before, after: process.env.FORGE_BOUND_ROOT }))
    const { spawnAgentItem } = await import("../taskqueue.js")
    const probe = path.join(TMP, "env-probe.mjs"), result = path.join(TMP, "env.json")
    fs.writeFileSync(probe, 'import fs from "node:fs"; const i = process.argv.indexOf("--result-json"); fs.writeFileSync(process.argv[i + 1], JSON.stringify(Object.keys(process.env).filter((k) => /^FORGE_(BOUND|SOURCE_LOCK|LAUNCH)/.test(k))))\n')
    await spawnAgentItem({ task: "other task" }, { cwd: TMP, resultFile: result, forgeJs: probe, stdio: "ignore", env: { ...process.env, FORGE_BOUND_ROOT: "/x", FORGE_BOUND_INFO: "{}", FORGE_BOUND_KIND: "local", FORGE_SOURCE_LOCK: "bound", FORGE_LAUNCH_CWD: "/y" } })
    ok("7 a queued task does not inherit the runner's binding", fs.existsSync(result) && fs.readFileSync(result, "utf8") === "[]", fs.existsSync(result) ? fs.readFileSync(result, "utf8") : "no result")
    clearBinding()
  }
  // 8. a credential folder is never the workspace
  ok("8 'edit ~/.ssh/config' is not bound", L("edit ~/.ssh/config", H).action === "none")
  ok("8 'make a new folder ~/.ssh/keys' is not created", L("make a new folder ~/.ssh/keys", H).action === "none")
  // 9. a build archive inside the project is a file, not a project to unpack
  r = await bindFrom("the build writes ./dist/app.zip — make it smaller", APP)
  ok("9 a .zip inside the launch project is not unpacked or bound", r.b.action === "cwd" && !r.bound, JSON.stringify({ a: r.b.action, bound: r.bound }))
  // 10. only 'project / repo / codebase' name a project
  for (const t of ["deploy the api code to production", "clean up the Desktop folder", "take my notes app idea and write a plan"]) ok(`10 '${t}': no project lookup`, T.namedProjectInTask(t, { cwd: H }).action === "none")
  // 11. the remote belongs to the repository root
  ok("11 a subfolder's identity is the repository's remote", W.repositoryIdentityOf(path.join(APP, "src")) === "https://github.com/me/app")
  // 12. a lone ~ is not a path
  r = L("fix it ~ approximately 3 lines", H)
  ok("12 'fix it ~ 3 lines': a lone ~ is not the home folder named", r.action === "none" && !(r.focus ?? []).length, JSON.stringify(r))
  // and: a dotfiles repository at ~ does not swallow every folder under it
  {
    const DOT = path.join(TMP, "dothome")
    fs.mkdirSync(path.join(DOT, "notes"), { recursive: true }); fs.writeFileSync(path.join(DOT, "notes", "todo.md"), "x\n")
    execFileSync("git", ["init", "-q"], { cwd: DOT })
    const d = T.localTargetsInTask("edit ~/notes/todo.md", { cwd: DOT, home: DOT })
    ok("a dotfiles repo at ~: ~/notes/todo.md still → ~/notes", d.action === "target" && d.root === path.join(DOT, "notes"), JSON.stringify(d))
  }
}

console.log("== end to end: the real agent works where the task says ==")
{
  const { runTask } = await import("../runtask.js")
  const { runAgent } = await import("../agent.js")
  let firstSystem = null
  const script = []
  const server = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(b) } catch { }
      if (firstSystem == null) firstSystem = String((body.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const tools = (body.messages ?? []).filter((m) => m.role === "tool").length
      const step = script[tools] ?? { say: "done" }
      const message = step.call
        ? { role: "assistant", content: "", tool_calls: [{ id: `c${tools}`, type: "function", function: { name: step.call, arguments: JSON.stringify(step.args) } }] }
        : { role: "assistant", content: step.say }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const provider = { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "k", model: "mock-1" }
  const prev = process.cwd()
  clearBinding()
  process.chdir(H)
  const results = []
  script.push(
    { call: "write_file", args: { path: "todo.md", content: "- eggs\n- milk\n" } },
    { call: "write_file", args: { path: "../site/hijack.txt", content: "x\n" } },
    { say: "Added milk to todo.md." },
  )
  let out = null, err = null
  try {
    out = await runTask({ task: "edit ~/notes/todo.md and add milk", mode: "single", provider, runAgent, env: {},
      config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } },
      onEvent: (e) => results.push(e), agentOpts: { journal: false } })
  } catch (e) { err = e }
  const cwdAfter = process.cwd()
  process.chdir(prev)
  server.closeAllConnections?.(); server.close()
  ok("the run did not throw", !err, err?.message)
  ok("the model was told its workspace in the system prompt", /\[workspace\] workspace: .*notes/.test(firstSystem ?? "") && /Focus: todo\.md/.test(firstSystem ?? ""), (firstSystem ?? "").split("\n").filter((l) => l.includes("workspace")).join(" | "))
  ok("the prompt says writes outside the workspace are refused (it used to say nothing enforces it)", /6a\. This task's workspace is .*notes\. File writes .* outside it, and shell or background commands that write outside it .* are REFUSED/.test(firstSystem ?? ""))
  ok("the relative write landed in ~/notes/todo.md (not ~/todo.md)", fs.readFileSync(path.join(H, "notes", "todo.md"), "utf8").includes("milk") && !fs.existsSync(path.join(H, "todo.md")))
  ok("a write outside the named folder was refused", !fs.existsSync(path.join(H, "site", "hijack.txt")) && results.some((e) => e.type === "tool_result" && /BLOCKED/.test(String(e.result ?? ""))), JSON.stringify(results.filter((e) => e.type === "tool_result").map((e) => String(e.result).slice(0, 80))))
  ok("the run stays in the workspace for follow-ups", cwdAfter === path.join(H, "notes"), cwdAfter)
  ok("a SOURCE_RESOLVED event says where and why", results.some((e) => e.type === "SOURCE_RESOLVED" && e.localPath === path.join(H, "notes") && /todo\.md/.test(String(e.reason ?? ""))))
  clearBinding()
}

console.log("== the web panel looks for changes where the run worked ==")
{
  const Wc = await import("../webchat.js")
  const WS = path.join(H, "site")
  const statusCalls = []
  const chat = Wc.createWebChat({
    config: {}, cwd: APP, getProvider: () => ({ name: "mock", model: "m" }), stream: async function* () { },
    systemPrompt: async () => "", gitStatus: async (dir) => { statusCalls.push(dir); return new Map(dir === WS ? (statusCalls.filter((d) => d === WS).length > 1 ? [["index.html", " M"]] : []) : []) },
    runAgentTurn: async ({ onWorkspace }) => { await onWorkspace?.(WS, "the task names ~/site"); return { res: { text: "done", taskStatus: "COMPLETED", created: [] }, mode: "single" } },
  })
  const conv = chat.create()
  const reply = await chat.send({ id: conv.id, text: "/agent change the title in ~/site/index.html" }, { onEvent: () => { } })
  ok("the reply names the workspace", reply.workspace === WS, JSON.stringify(reply.workspace))
  ok("changes are looked for in that workspace, before and after", statusCalls.filter((d) => d === WS).length === 2, JSON.stringify(statusCalls))
  ok("a changed file outside the served folder is named in full and not offered as a download", reply.files.length === 1 && reply.files[0].path === path.join(WS, "index.html") && reply.files[0].outside === true, JSON.stringify(reply.files))
  ok("the activity says where the run worked and why", reply.activity.some((a) => /workspace: .*site — the task names ~\/site/.test(a.detail)))
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
console.log(`\n== workspace-targets suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
