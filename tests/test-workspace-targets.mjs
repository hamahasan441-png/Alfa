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
const clearBinding = () => { delete process.env.FORGE_BOUND_ROOT; delete process.env.FORGE_BOUND_INFO; delete process.env.FORGE_SOURCE_LOCK }
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
  ok("a ../ path outside the launch checkout → that folder", r.action === "target" && r.root === path.join(H, "site"), JSON.stringify(r))
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
  ok("the prompt says writes outside the workspace are refused (it used to say nothing enforces it)", /6a\. This task's workspace is .*notes\. Writes and shell redirects outside it are REFUSED/.test(firstSystem ?? ""))
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
