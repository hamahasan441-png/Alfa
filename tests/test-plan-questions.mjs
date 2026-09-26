#!/usr/bin/env node
// v183 — /plan asks the plan's questions, however the model headed them.
//
// v164's /plan asks what only the person can decide before a plan starts —
// but read questions only under a "Questions for you:" heading. A plan that
// wrote "Open questions:", "Clarifications needed", "Before I start, I need
// to know:" — or simply asked in a sentence — got "start this plan now?", and
// its questions were shown in the plan and never asked.
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
const Q = (plan) => T.planQuestions(plan)
const J = (x) => JSON.stringify(x)

console.log("== 1. the headings models use ==")
{
  const body = "\n- Should empty rows be kept?\n- Which delimiter?\nEND OF PLAN"
  for (const h of ["Open questions:", "Questions:", "## Questions", "**Outstanding questions:**", "Clarifications needed:", "### Clarification required", "Decisions needed from you:", "Input needed:", "To confirm:", "Things to clarify:", "Assumptions to confirm:", "Before I start, I need to know:", "Before I begin, please confirm:", "I need from you:", "Questions to clarify:", "Questions for you:", "**Questions for the user:**"]) {
    ok(`"${h}"`, J(Q(`1. Create convert.js\n2. Verify it\n\n${h}${body}`)) === J(["Should empty rows be kept?", "Which delimiter?"]), J(Q(`1. x\n${h}${body}`)))
  }
  ok("a heading that only starts like one is not one (\"## Questions about the design\": its plain bullets are not asked)", Q("1. x\n## Questions about the design\n- the cache layer\n- the parser").length === 0)
  ok("…nor one that only ends like one (\"## Answers to earlier questions\")", Q("1. x\n## Answers to earlier questions\n- the cache layer\n- the parser").length === 0)
  ok("'none' under a heading is no question", Q("Open questions:\n- None\nEND OF PLAN").length === 0)
  ok("the list still ends at the next heading", Q("Open questions:\n- A?\n## Risks\n- not a question").length === 1)
}

console.log("== 2. no heading: the questions the model asked in its own words ==")
{
  ok("a question in a sentence is asked", J(Q("1. Create convert.js\n2. Verify it\n\nShould empty rows be kept or dropped?\nEND OF PLAN")) === J(["Should empty rows be kept or dropped?"]))
  ok("…as bullets too", J(Q("1. Create convert.js\n\n- Which delimiter does the input use?\n- Is the file UTF-8?")) === J(["Which delimiter does the input use?", "Is the file UTF-8?"]))
  ok("a numbered step that happens to ask is a step, not a question", Q("1. Is the parser broken?\n2. Fix it\nEND OF PLAN").length === 0)
  ok("a step with '?' in the middle is not a question", Q("1. Is the parser broken? Check it.\nEND OF PLAN").length === 0)
  ok("nothing inside a code block", Q("1. Add a guard\n```js\nconst ok = x ? y : z // why?\n```\nEND OF PLAN").length === 0)
  ok("nothing after END OF PLAN", Q("1. do it\nEND OF PLAN\nAnything else?").length === 0)
  ok("at most five", Q(Array.from({ length: 9 }, (_, i) => `Question number ${i}?`).join("\n")).length === 5)
  ok("a plan with no questions has none", Q("1. Create convert.js\n2. Verify with a sample file\nEND OF PLAN").length === 0)
}

/** A model: the plan asks `questions` the first time, and none once answered. */
function model(firstPlan) {
  const st = { plans: [], runs: 0 }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const text = (j.messages ?? []).map((m) => String(typeof m.content === "string" ? m.content : "")).join("\n")
      const system = String((j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const isPlan = /PLAN MODE/.test(system)
      if (isPlan) st.plans.push(text)
      else if (/autonomous terminal coding agent/.test(system)) st.runs++
      const reply = isPlan ? (st.plans.length === 1 ? firstPlan : "1. Create convert.js dropping empty rows\n2. Verify with a sample file\nEND OF PLAN") : "Noted."
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}
function setup(m) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planq-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-planq-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 2 }, skills: { enabled: false } }))
  return { home, work }
}
const cleanup = (env) => { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.work, { recursive: true, force: true }) }

console.log("== 3. a real chat: a question asked in prose is asked ==")
{
  const m = await model("1. Create convert.js that streams rows\n2. Verify with a sample file\n\nShould empty rows be kept or dropped?\nEND OF PLAN")
  const env = setup(m)
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: env.work, env: { PATH: process.env.PATH, HOME: env.home, FORGE_HOME: env.home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
    let o = ""
    child.stdout.on("data", (d) => { o += d }); child.stderr.on("data", (d) => { o += d })
    child.stdin.write("I need a CSV to JSON converter\n/plan\n/exit\n"); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(o) }, 60000)
    child.on("exit", () => { clearTimeout(t); resolve(o) })
  })
  ok("the chat asks it before starting", /the plan needs you to decide:\s+1\. Should empty rows be kept or dropped\?/.test(out), out.slice(-400))
  ok("…instead of \"start this plan now?\"", !/start this plan now/.test(out))
  await m.stop(); cleanup(env)
}

console.log("== 4. the full-screen UI: \"Open questions:\" asked, answered, the plan made again ==")
{
  const m = await model("1. Create convert.js that streams rows\n2. Verify with a sample file\n\nOpen questions:\n- Should empty rows be kept or dropped?\nEND OF PLAN")
  const env = setup(m)
  const out = await new Promise((resolve) => {
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: env.work, env: { ...process.env, FORGE_HOME: env.home, HOME: env.home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
    let o = ""
    const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    child.stdout.on("data", (d) => { o += clean(d) })
    const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(o) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(o) }
    const settle = async () => { for (let last = -1; last !== o.length;) { last = o.length; await new Promise((r) => setTimeout(r, 500)) } }
    ;(async () => {
      await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
      for (const [line, waitFor] of [["I need a CSV to JSON converter", /Noted/], ["/plan", /your answer/], ["drop them", /start this plan now/], ["n", /plan kept/]]) { child.stdin.write(`${line}\r`); if (waitFor) await until(waitFor); await settle() }
      child.stdin.write("/exit\r")
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(o) }, 8000)
      child.on("exit", () => { clearTimeout(t); resolve(o) })
    })()
  })
  const flat = out.replace(/\s+/g, " ")
  ok("the plan's question is asked", /the plan needs you to decide: 1\. Should empty rows be kept or dropped\?/.test(flat), flat.slice(-600))
  ok("…the answer goes into the next plan", m.st.plans.length === 2 && /drop them/.test(m.st.plans[1]), `${m.st.plans.length} plan request(s)`)
  ok("…and once nothing is left to ask, the plan is offered", /start this plan now/.test(flat))
  await m.stop(); cleanup(env)
}

console.log(`== plan-questions suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
