#!/usr/bin/env node
// v196 — `/plan go` gives the run the plan's steps as its checklist.
//
// `/plan go` handed the run the approved plan as one block of text; its steps
// never became the run's todo list, so nothing tracked which were done and a
// run could skip one and still finish. Now the steps seed the todo list, the
// run is told to tick them off, and the chat says how many got done.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planlist-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const TB = await import("../taskbrief.js")
const T = await import("../tools.js")

console.log("== 1. the plan's steps ==")
{
  const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  eq("numbered steps", TB.planSteps("Plan:\n1. Create convert.js\n2. Add a sample\n3. Verify it\nEND OF PLAN"), ["Create convert.js", "Add a sample", "Verify it"])
  eq("\"1)\", \"Step 1:\" and \"- [ ]\" too", TB.planSteps("1) one step\nStep 2: two step\n- [ ] three step"), ["one step", "two step", "three step"])
  eq("an indented sub-step belongs to its step", TB.planSteps("1. Parse input\n   1. read the header\n   2. split rows\n2. Write output"), ["Parse input", "Write output"])
  eq("nothing under a questions heading", TB.planSteps("1. Build it\n2. Test it\n\nOpen questions:\n1. Which delimiter?\n2. Keep empty rows?"), ["Build it", "Test it"])
  eq("…a heading that is not about questions keeps counting", TB.planSteps("## Setup\n1. Install\n## Work\n2. Build"), ["Install", "Build"])
  eq("nothing after END OF PLAN", TB.planSteps("1. Do a\nEND OF PLAN\n2. Not a step"), ["Do a"])
  eq("nothing inside a code block", TB.planSteps("1. Run it\n```\n2. not a step\n```\n2. Check it"), ["Run it", "Check it"])
  eq("markdown bold and a trailing colon are dropped", TB.planSteps("1. **Create** the parser:"), ["Create the parser"])
  ok("at most 30", TB.planSteps(Array.from({ length: 40 }, (_, i) => `${i + 1}. step number ${i + 1}`).join("\n")).length === 30)
  eq("prose with no steps: none", TB.planSteps("Just write the converter and test it."), [])
}

console.log("== 2. a question in prose needs no \"?\" ==")
{
  const qs = (p) => TB.planQuestions(p)
  ok("\"I need to know …\" is asked", qs("1. Build the converter\n\nI need to know which delimiter the input uses.\nEND OF PLAN").some((q) => /which delimiter/.test(q)))
  ok("\"Please confirm …\" and \"Let me know …\" too", qs("Please confirm the output folder.\nLet me know whether empty rows stay.").length === 2)
  ok("a numbered step that says \"let me know\" is a step, not a question", qs("1. Let me know how it goes after the build").length === 0)
  ok("a plain sentence is not a question", qs("I will build the converter first.").length === 0)
  ok("\"?\" questions still count (v183)", qs("Which delimiter does the input use?").length === 1)
}

console.log("== 3. the run is told ==")
{
  const with3 = TB.approvedTask({ objective: "convert CSV", plan: "1. a\n2. b\n3. c", checklist: 3 })
  ok("with a checklist: the run is told its todo list holds the steps, and to tick them off", /Your todo list already holds these 3 steps/.test(with3) && /action=update/.test(with3))
  ok("without one: nothing added (as before)", !/todo list/.test(TB.approvedTask({ objective: "x", plan: "do it" })))
}

console.log("== 4. the todo list: seeded, ticked, counted ==")
{
  const p = path.join(process.env.FORGE_HOME, "todo-a.json")
  const since = Date.now()
  const items = T.seedTodo(p, ["Create convert.js", "Add a sample", "Verify it"])
  ok("seeded in the todo tool's own format", items.length === 3 && JSON.parse(fs.readFileSync(p, "utf8")).items[0].status === "todo")
  const ctx = T.makeToolContext({ cwd: process.env.FORGE_HOME, root: process.env.FORGE_HOME, todoPath: p, skillsDir: null }).ctx
  const listed = String(await T.execTool(ctx, "todo", { action: "list" }))
  ok("the todo tool reads it", /\[ \] 1\. Create convert\.js/.test(listed), listed)
  await T.execTool(ctx, "todo", { action: "update", id: 1, status: "done" })
  const prog = T.planProgress(p, { since })
  ok("ticking a step off is counted", prog?.done === 1 && prog.total === 3 && prog.open.join("|") === "Add a sample|Verify it", JSON.stringify(prog))
  ok("a list seeded before this run is not this run's plan", T.planProgress(p, { since: Date.now() + 1000 }) === null)
  await T.execTool(ctx, "todo", { action: "set", items: [{ content: "something else" }] })
  ok("a list the model replaced with its own is not the plan any more", T.planProgress(p, { since }) === null)
  ok("no steps: nothing written", T.seedTodo(path.join(process.env.FORGE_HOME, "todo-b.json"), []).length === 0 && !fs.existsSync(path.join(process.env.FORGE_HOME, "todo-b.json")))
}

console.log("== 5. a real chat: /plan, /plan go ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planlist-chat-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  let runPrompt = "", ran = 0
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const j = JSON.parse(b || "{}")
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const isPlan = /PLAN MODE/.test(system)
      const all = JSON.stringify(j.messages ?? [])
      const isRun = !isPlan && /THE PLAN THE USER APPROVED/.test(all)
      let msg
      if (isPlan) msg = { role: "assistant", content: "1. Create convert.js that streams rows\n2. Add a sample CSV file\n3. Verify convert.js on the sample\nEND OF PLAN" }
      else if (isRun && !(j.messages ?? []).some((m) => m.role === "tool")) {
        ran++; runPrompt = all
        msg = { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "todo", arguments: JSON.stringify({ action: "update", id: 1, status: "done" }) } }] }
      } else msg = { role: "assistant", content: "Step 1 is done; the rest is for later." }
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const delta = msg.tool_calls ? { tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) } : { content: msg.content }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 4 }, skills: { enabled: false } }))
  let out = ""
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
    child.stdin.write("I need a CSV to JSON converter\n/plan\n/plan go\n/exit\n"); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 90000)
    child.once("exit", () => { clearTimeout(t); resolve() })
  })
  srv.closeAllConnections?.(); srv.close()
  let todo = null
  try { todo = JSON.parse(fs.readFileSync(path.join(home, "todo.json"), "utf8")) } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  ok("the run started, and said its steps are on the todo list", ran >= 1 && /starting the approved plan — 3 steps on the todo list/.test(out), out.slice(-600))
  ok("the run's prompt tells it to tick them off", /Your todo list already holds these 3 steps/.test(runPrompt))
  ok("the todo list holds the plan's steps, step 1 ticked off by the run", todo?.origin === "plan" && todo.items.length === 3 && todo.items[0].status === "done" && todo.items[2].content === "Verify convert.js on the sample", JSON.stringify(todo))
  ok("the chat says how far it got, and what is left", /plan: 1 of 3 steps done — not done: Add a sample CSV file; Verify convert\.js on the sample/.test(out), out.slice(-400))
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== plan-checklist suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
