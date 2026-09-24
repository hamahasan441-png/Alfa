#!/usr/bin/env node
// v166 — /retry continues a stopped run instead of starting it over.
//
// v165 made /retry re-run the task that failed — from the start. A run that
// ran out of credits at step 12 then paid again for steps 1-11 (the reads,
// the test runs, the model's own output) with the credits just topped up.
// Now the run's conversation — its tool calls and their real results — is
// kept when it stops, and /retry hands it back with a note saying where it
// stopped, so the model continues instead of redoing.
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

const A = await import("../agent.js")
const P = await import("../providers.js")
const SPENT = "This request would exceed your available credits."

console.log("== 1. what is kept from a stopped run ==")
{
  const call = (id, name = "bash") => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] })
  const res = (id, text) => ({ role: "tool", tool_call_id: id, content: text })
  const kept = A.continuationMessages([
    { role: "system", content: "SYS" },
    { role: "user", content: "the task" },
    call("a"), res("a", "A-OUT"),
    call("b"), res("b", "B-OUT"),
    call("c"), // stopped between the call and its result
  ])
  ok("the system turn is dropped (the new run builds its own)", !kept.some((m) => m.role === "system"))
  ok("answered tool calls are kept with their results", kept.filter((m) => m.role === "tool").map((m) => m.content).join(",") === "A-OUT,B-OUT")
  ok("a tool call left without its result is dropped", !kept.some((m) => m.tool_calls?.[0]?.id === "c"), JSON.stringify(kept.map((m) => m.role)))
  const two = A.continuationMessages([{ role: "user", content: "t" }, { role: "assistant", content: "", tool_calls: [{ id: "x" }, { id: "y" }] }, res("x", "X"), { role: "user", content: "later" }])
  ok("…and so is one with only some of its results, and everything after it", two.length === 1 && two[0].content === "t", JSON.stringify(two))
  ok("a result whose call is not above it is dropped", A.continuationMessages([{ role: "user", content: "t" }, res("z", "Z")]).length === 1)
  const note = A.resumeNote({ steps: 12, reason: "provider HTTP 402 — out of credits on seekai\nmore" })
  ok("the note says it continues, after how many steps, and why it stopped", /CONTINUES an earlier attempt/.test(note) && /after 12 step\(s\)/.test(note) && /out of credits on seekai/.test(note) && !/more/.test(note))
  ok("…and not to repeat what is above", /Do not repeat work whose result is already above/.test(note))
}

/**
 * A model that works one step per request: the first request of a run gets a
 * bash call that appends to count.txt (so a repeat is visible on disk); once
 * a tool result is in the conversation it answers. While `spent`, any request
 * that already carries a tool result gets the 402 — the run stops after
 * doing real work.
 */
function model({ anthropic = false } = {}) {
  const state = { spent: true, calls: [] }
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const text = JSON.stringify(j.messages ?? [])
      const system = typeof j.system === "string" ? j.system : JSON.stringify(j.system ?? (j.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const agent = /autonomous terminal coding agent/.test(system)
      const hasResult = anthropic ? /"tool_result"/.test(text) : /"role":"tool"/.test(text)
      state.calls.push({ agent, hasResult, text, spentAt: state.spent })
      if (agent && hasResult && state.spent) {
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 402, message: SPENT } }))
      }
      if (anthropic) {
        // the wire must pair every tool_use with its tool_result, or the API rejects it
        const uses = [...text.matchAll(/"type":"tool_use","id":"([^"]+)"/g)].map((m) => m[1])
        const results = [...text.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1])
        state.paired = uses.every((id) => results.includes(id))
      }
      const doTool = agent && !hasResult
      const body = anthropic
        ? { id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 1, output_tokens: 1 },
          ...(doTool ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo RAN >> count.txt; echo STEP-ONE-OUTPUT" } }] }
            : { stop_reason: "end_turn", content: [{ type: "text", text: agent ? "DONE-AFTER-RESUME" : "CHAT-REPLY" }] }) }
        : { id: "c", choices: [{ message: doTool
          ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo RAN >> count.txt; echo STEP-ONE-OUTPUT" }) } }] }
          : { role: "assistant", content: agent ? "DONE-AFTER-RESUME" : "CHAT-REPLY" }, finish_reason: doTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      if (j.stream && !anthropic) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: body.choices[0].message.content }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ state, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}

async function runPair({ anthropic }) {
  const m = await model({ anthropic })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-"))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: anthropic ? "anthropic" : "openai", baseUrl: m.url, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const provider = P.buildProvider(cfg, "stub")
  let err = null
  try { await A.runAgent({ config: cfg, provider, task: "count once", onEvent: () => {} }) } catch (e) { err = e }
  const before = m.state.calls.length
  m.state.spent = false // topped up
  const events = []
  let r = null
  try { r = await A.runAgent({ config: cfg, provider, task: "count once", continueFrom: { ...err?.continuation, reason: err?.message }, onEvent: (e) => events.push(e) }) } catch (e) { r = { error: e } }
  const lines = fs.existsSync(path.join(work, "count.txt")) ? fs.readFileSync(path.join(work, "count.txt"), "utf8").trim().split("\n") : []
  process.chdir(prev)
  await m.stop()
  fs.rmSync(work, { recursive: true, force: true })
  return { err, r, events, calls: m.state.calls.slice(before), lines, paired: m.state.paired }
}

console.log("== 2. runAgent: stop, then continue ==")
for (const anthropic of [false, true]) {
  const wire = anthropic ? "anthropic wire" : "openai wire"
  const { err, r, events, calls, lines, paired } = await runPair({ anthropic })
  ok(`${wire}: the run did real work, then stopped on the spent balance`, err?.status === 402 && Array.isArray(err?.continuation?.messages), String(err?.message))
  ok(`${wire}: the conversation rides on the error, not in its serialized form`, !Object.keys(err ?? {}).includes("continuation") && !JSON.stringify(err ?? {}).includes("STEP-ONE-OUTPUT"))
  ok(`${wire}: the continued run's FIRST request carries the earlier tool result`, /STEP-ONE-OUTPUT/.test(calls[0]?.text ?? ""), (calls[0]?.text ?? "").slice(0, 300))
  ok(`${wire}: …and the note saying where it stopped`, /CONTINUES an earlier attempt/.test(calls[0]?.text ?? "") && /out of credits/.test(calls[0]?.text ?? ""))
  ok(`${wire}: it finished without repeating the step`, r?.text && /DONE-AFTER-RESUME/.test(r.text) && calls.length === 1, `${calls.length} model call(s); ${String(r?.text ?? r?.error?.message).slice(0, 120)}`)
  ok(`${wire}: the command ran once, not twice`, lines.length === 1, `count.txt has ${lines.length} line(s)`)
  ok(`${wire}: it says it is continuing`, events.some((e) => e.type === "info" && /continuing the stopped run — 1 earlier tool result/.test(e.text)))
  if (anthropic) ok("anthropic wire: every tool_use is paired with its tool_result", paired === true)
}

console.log("== 3. a run stopped by its step budget also leaves its conversation ==")
{
  const m = await model()
  m.state.spent = false
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-budget-"))
  const prev = process.cwd()
  process.chdir(work)
  // a model that never stops calling tools: always "no result yet" is faked by a fresh id
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 1 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "count once", maxStepsOverride: 1, onEvent: () => {} })
  process.chdir(prev)
  await m.stop()
  fs.rmSync(work, { recursive: true, force: true })
  if (r.status === "COMPLETED") ok("a completed run leaves nothing to continue", r.continuation === undefined)
  else {
    ok("an incomplete run leaves its conversation", Array.isArray(r.continuation?.messages) && r.continuation.messages.length > 1, r.status)
    ok("…not in the serialized result", !JSON.stringify(r).includes("\"continuation\""))
  }
}

console.log("== 3b. Ctrl+C in the middle of a tool also leaves the conversation ==")
{
  let n = 0
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      n++
      const cmd = n === 1 ? "echo STEP-ONE-OUTPUT" : n === 2 ? "sleep 20" : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: cmd ? { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] } : { role: "assistant", content: "done" }, finish_reason: cmd ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-abort-"))
  const prev = process.cwd()
  process.chdir(work)
  const cfg = { providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }
  const ctl = new AbortController()
  const timer = setInterval(() => { if (n >= 2) { clearInterval(timer); setTimeout(() => ctl.abort(), 400) } }, 20)
  let err = null, r = null
  try { r = await A.runAgent({ config: cfg, provider: P.buildProvider(cfg, "stub"), task: "two steps", signal: ctl.signal, onEvent: () => {} }) } catch (e) { err = e }
  clearInterval(timer)
  process.chdir(prev)
  await new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) })
  fs.rmSync(work, { recursive: true, force: true })
  const cont = err?.continuation ?? r?.continuation
  const kept = A.continuationMessages(cont?.messages ?? [])
  ok("a run interrupted during a tool still leaves its conversation", Array.isArray(cont?.messages), `threw ${err?.name ?? "nothing"}; status ${r?.status}`)
  ok("…with the finished step's result in it", kept.some((m) => m.role === "tool" && /STEP-ONE-OUTPUT/.test(m.content)), JSON.stringify(kept.map((m) => m.role)))
}

console.log("== 4. in a real terminal: fail on credits, top up, /retry continues ==")
{
  const m = await model()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: m.url, apiKey: "k", model: "stub-model" } }, agent: { maxSteps: 6 }, skills: { enabled: false }, tools: { assumeYes: true } }))
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: work, env: { ...process.env, FORGE_HOME: home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
  child.stdout.on("data", (d) => { out += clean(d) })
  const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(out) }
  const settle = async () => { for (let last = -1; last !== out.length;) { last = out.length; await new Promise((r) => setTimeout(r, 500)) } }
  await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
  child.stdin.write("/agent count once\r")
  const failed = await until(/TASK FAILED/)
  await settle()
  m.state.spent = false // the person tops up
  const before = m.state.calls.length
  child.stdin.write("/retry\r")
  const said = await until(/continuing from step \d+, not from the start/)
  for (const t0 = Date.now(); !m.state.calls.slice(before).some((c) => c.agent) && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 50))
  await settle()
  child.stdin.write("/exit\r")
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 8000); child.on("exit", () => { clearTimeout(t); r() }) })
  await m.stop()
  const after = m.state.calls.slice(before).filter((c) => c.agent)
  const lines = fs.existsSync(path.join(work, "count.txt")) ? fs.readFileSync(path.join(work, "count.txt"), "utf8").trim().split("\n") : []
  ok("the run did one step and failed on credits", failed && lines.length >= 1, out.slice(-400))
  ok("/retry says it continues, not starts over", said, out.slice(-400))
  ok("the retried run's first request carries the earlier result", /STEP-ONE-OUTPUT/.test(after[0]?.text ?? ""), `${after.length} agent call(s)`)
  ok("…and the step was not run again", lines.length === 1, `count.txt has ${lines.length} line(s)`)
  ok("…and it finished", /DONE-AFTER-RESUME/.test(out), out.slice(-300))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n== retry-resumes suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
