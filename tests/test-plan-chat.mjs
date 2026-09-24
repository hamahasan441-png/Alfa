#!/usr/bin/env node
// v164 — plan from the conversation, then start it.
//
// "Make a plan with my chat — what I need — then start." Before v164:
//   - `/plan` with no task was an error ("usage: /plan <task>"), and
//     `/plan <task>` planned that one line: the conversation stayed behind;
//   - plan mode dropped extraContext, so a plan could not be given it anyway;
//   - after the person approved a plan, the run started from the bare task
//     again, so the approved plan was thrown away and the run planned anew.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const T = await import("../taskbrief.js")

const CONVO = [
  { role: "user", content: "I need a CLI that converts CSV to JSON in convert.js" },
  { role: "assistant", content: "Sure. Should it stream large files, or is loading them whole fine?" },
  { role: "user", content: "it must stream, the files are huge" },
  { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "t1", content: "SECRET-TOOL-OUTPUT" },
  { role: "user", content: "AUTO-COMPACTED earlier turns" },
  { role: "user", content: "and it must support a --pretty flag" },
]

console.log("== 1. the planning brief is the conversation ==")
{
  const b = T.planningBrief({ messages: CONVO })
  ok("the objective is the goal the conversation stated", /CSV to JSON/.test(b.objective) && !b.underspecified, b.objective)
  ok("what was required reaches the planner", /REQUIRED:.*--pretty/.test(b.context) && /stream/.test(b.context), b.context)
  ok("the conversation itself reaches the planner, forge's replies included", /USER: I need a CLI/.test(b.context) && /FORGE: Sure\. Should it stream/.test(b.context))
  ok("…labelled: the user's words are the requirements, forge's are suggestions", /USER's words are the requirements/.test(b.context))
  ok("the conversation reads oldest first", b.context.indexOf("USER: I need a CLI") < b.context.indexOf("FORGE: Sure") && b.context.indexOf("FORGE: Sure") < b.context.indexOf("USER: and it must support a --pretty flag"))
  ok("tool traffic and compaction markers are left out", !/SECRET-TOOL-OUTPUT/.test(b.context) && !/AUTO-COMPACTED/.test(b.context))
  ok("the summary counts what was carried", /turn\(s\)/.test(b.summary) && /the goal/.test(b.summary) && /requirement/.test(b.summary), b.summary)

  const typed = T.planningBrief({ line: "add a --delimiter option", messages: CONVO })
  ok("`/plan <task>` plans that task…", typed.objective === "add a --delimiter option")
  ok("…with the goal stated earlier as context", /THE GOAL STATED EARLIER.*CSV to JSON/.test(typed.context))

  const empty = T.planningBrief({ messages: [] })
  ok("an empty conversation has nothing to plan, and says so", empty.underspecified === true && empty.objective === null)

  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn-${i} ${"x".repeat(900)}` }))
  const t = T.conversationTranscript(long, { maxChars: 5000 })
  ok("a long conversation keeps its most recent turns", /turn-39/.test(t.text) && !/turn-0 /.test(t.text) && t.text.length <= 5100 && t.turns === 40, `kept ${t.kept}, ${t.text.length} chars`)
}

console.log("== 2. questions only the person can answer ==")
{
  ok("a 'Questions for you:' list is read", JSON.stringify(T.planQuestions("1. do x\n\nQuestions for you:\n- Which Node version?\n2) Output to stdout or a file?\nEND OF PLAN")) === JSON.stringify(["Which Node version?", "Output to stdout or a file?"]))
  ok("…as a markdown heading, bold, or 'for the user'", T.planQuestions("## Questions for you\n1. A?\n").length === 1 && T.planQuestions("**Questions for the user:**\n- B?").length === 1)
  ok("'none' is no question", T.planQuestions("Questions for you:\n- None\nEND OF PLAN").length === 0)
  ok("a plan without the heading has none, even with '?' in its steps", T.planQuestions("1. Is the parser broken? Check it.\nEND OF PLAN").length === 0)
  ok("the list ends at END OF PLAN or the next heading", T.planQuestions("Questions for you:\n- A?\n## Risks\n- not a question").length === 1)
  ok("…even a heading right after it: the next section's bullets are not questions", T.planQuestions("Questions for you:\n\n## Risks\n- not a question").length === 0)
}

console.log("== 3. the approved plan is what runs ==")
{
  const facts = T.planningBrief({ messages: CONVO }).facts
  const task = T.approvedTask({ objective: "I need a CLI that converts CSV to JSON", plan: "1. write convert.js\n2. add --pretty\nEND OF PLAN", facts })
  ok("the run gets the plan verbatim", /THE PLAN THE USER APPROVED/.test(task) && /1\. write convert\.js\n2\. add --pretty/.test(task))
  ok("…the objective first", task.startsWith("I need a CLI that converts CSV to JSON"))
  ok("…what the conversation settled", /WHAT THE CONVERSATION SETTLED:\nREQUIRED:.*--pretty/.test(task))
  ok("…and not the plan pass's END OF PLAN marker", !/END OF PLAN/.test(task))
}

// ── a stub model, and a real `forge chat` ───────────────────────────────────
function stubModel() {
  const calls = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const text = (j.messages ?? []).map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`).join("\n")
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      // the /plan pass is the one given the conversation; the task controller
      // also plans internally, in plan mode, and that is part of the run
      const kind = /PLAN MODE/.test(system) && /THE CONVERSATION THIS PLAN IS FOR/.test(text) ? "plan"
        : /autonomous terminal coding agent/.test(system) ? "agent" : "chat"
      calls.push({ kind, text, system })
      let reply = "Noted."
      if (kind === "plan") {
        // asks where the output goes until the conversation has said so
        reply = /stdout/i.test(text)
          ? "1. Create convert.js streaming rows with a CSV parser (PLAN-MARK-7731)\n2. Add --pretty\n3. Verify with node convert.js sample.csv\nEND OF PLAN"
          : "1. Create convert.js (PLAN-MARK-0000)\n\nQuestions for you:\n- Should the JSON go to stdout or to a file?\nEND OF PLAN"
      } else if (kind === "agent") reply = "Done — convert.js follows the approved plan."
      if (j.stream) { // chat streams its answers
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", object: "chat.completion", created: 1, model: "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, calls, port: srv.address().port })))
}

function forgeHome(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planchat-home-"))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "mock",
    providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "mock-1" } },
    tools: { assumeYes: true }, agent: { autonomous: true, maxSteps: 2, maxSegments: 1 },
  }))
  return home
}

console.log("== 4. piped chat: talk, /plan, /plan go ==")
{
  const m = await stubModel()
  const home = forgeHome(m.port)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planchat-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  const input = [
    "I need a CLI that converts CSV to JSON in convert.js",
    "it must stream, the files are huge, and print to stdout",
    "/plan go",
    "/plan",
    "/plan go",
    "/exit", "",
  ].join("\n")
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { ...process.env, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => { out += d })
  child.stderr.on("data", (d) => { out += d })
  child.stdin.write(input); child.stdin.end()
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout") }, 120000); child.on("exit", (c) => { clearTimeout(t); r(c) }) })
  await new Promise((r) => { m.srv.closeAllConnections?.(); m.srv.close(r) })

  ok("the session ran", code === 0, out.slice(-400))
  ok("`/plan go` before any plan says there is none", /no plan to start/.test(out))
  const plans = m.calls.filter((c) => c.kind === "plan")
  const passes = (out.match(/planning from this conversation:/g) ?? []).length
  ok("`/plan` with no task planned (it used to be a usage error)", passes === 1 && plans.length > 0 && !/usage: \/plan/.test(out), `${passes} plan passes`)
  ok("the plan pass was given the conversation", /CSV to JSON/.test(plans[0]?.text) && /must stream/.test(plans[0]?.text) && /USER: I need a CLI/.test(plans[0]?.text), plans[0]?.text?.slice(0, 600))
  ok("…and told to ask what only the person can decide", /Questions for you:/.test(plans[0]?.system ?? ""))
  ok("chat says what it planned from", /planning from this conversation: .*turn\(s\)/.test(out), out.slice(-800))
  ok("with no one to ask, it says how to start", /start it with \/plan go/.test(out))
  const runs = m.calls.filter((c) => c.kind === "agent")
  ok("`/plan go` started a run", runs.length > 0, `${runs.length} agent calls`)
  ok("EVERY prompt of that run carries the approved plan — this is the bug", runs.length > 0 && runs.every((c) => /PLAN-MARK-7731/.test(c.text) && /THE PLAN THE USER APPROVED/.test(c.text)), `${runs.filter((c) => /PLAN-MARK-7731/.test(c.text)).length}/${runs.length}`)
  ok("…and what the conversation settled", runs.every((c) => /must stream/.test(c.text)))
  const plansDir = path.join(work, ".forge", "plans")
  const saved = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).map((f) => fs.readFileSync(path.join(plansDir, f), "utf8")) : []
  ok("the plan is saved where `forge plan apply` finds it", saved.length === 1 && /# Plan: I need a CLI/.test(saved[0]) && /PLAN-MARK-7731/.test(saved[0]) && /must stream/.test(saved[0]), `${saved.length} saved`)
  ok("…and chat says where", /saved \.forge\/plans\/.+\.md — forge plan apply /.test(out))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}

async function terminalFlow(plainUI) {
  const m = await stubModel()
  const home = forgeHome(m.port)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planchat-tty-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  // `script` gives forge a pseudo-terminal: a human is there, so it asks
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: work, env: { ...process.env, FORGE_HOME: home, NO_COLOR: "1", ...(plainUI ? { FORGE_UI: "plain", TERM: "dumb" } : { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }) }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
  child.stdout.on("data", (d) => { out += clean(d) })
  child.stderr.on("data", (d) => { out += clean(d) })
  const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)) ; return re.test(out) }
  const say = (s) => child.stdin.write(`${s}\r`)
  const script = async () => {
    await until(/forge/i)
    await new Promise((r) => setTimeout(r, 800))
    say("I need a CLI that converts CSV to JSON in convert.js")
    await until(/Noted\./)
    say("/plan")
    if (!(await until(/your answer/))) return "no question prompt"
    say("stdout please")
    if (!(await until(/start this plan now\?/))) return "no start prompt"
    say("")
    if (!(await until(/approved plan/))) return "no start"
    // the run's result prints differently per UI; what matters is that the
    // run reached the model — then let the output settle
    for (const t0 = Date.now(); !m.calls.some((c) => c.kind === "agent") && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 50))
    for (let last = -1; last !== out.length;) { last = out.length; await new Promise((r) => setTimeout(r, 600)) }
    say("/exit")
    return "ok"
  }
  const flow = await Promise.race([script(), new Promise((r) => setTimeout(() => r("timeout"), 100000))])
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 10000); child.on("exit", () => { clearTimeout(t); r() }) })
  await new Promise((r) => { m.srv.closeAllConnections?.(); m.srv.close(r) })
  const plans = m.calls.filter((c) => c.kind === "plan")
  const runs = m.calls.filter((c) => c.kind === "agent")
  const tag = plainUI ? "plain terminal" : "full-screen terminal"
  ok(`${tag}: the flow ran to the end`, flow === "ok", `${flow}; ${out.slice(-700)}`)
  ok(`${tag}: the plan's question was put to the person`, /Should the JSON go to stdout or to a file\?/.test(out))
  const passes = (out.match(/planning from this conversation:/g) ?? []).length
  ok(`${tag}: the answer joined the conversation and the plan was made again`, passes === 2 && plans.some((c) => /USER: stdout please/.test(c.text)), `${passes} plan passes`)
  ok(`${tag}: …and was not also sent to the chat as a new message`, !m.calls.some((c) => c.kind === "chat" && /\[user\] stdout please\s*$/.test(c.text)))
  ok(`${tag}: Enter started the re-made plan, not the first one`, runs.length > 0 && runs.every((c) => /PLAN-MARK-7731/.test(c.text) && !/PLAN-MARK-0000/.test(c.text)), `${runs.length} agent calls`)
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}


console.log("== 5. a real terminal: the plan asks, the answer re-plans, Enter starts ==")
await terminalFlow(true)
await terminalFlow(false)

console.log(`\n== plan-chat suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
