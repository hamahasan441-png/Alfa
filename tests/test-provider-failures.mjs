#!/usr/bin/env node
// v177 — a provider failure is labelled for what it is.
//
// forge labels every failed tool result for the model: "[forge] failure=… •
// recovery: …". A delegated sub-agent whose provider failed — out of credits,
// rate limited, key refused, context too long — came back to its parent as
// failure=UNKNOWN with a generic plan ("inspect_first"), though the message
// said exactly what happened, and each case needs a different reaction.
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
const D = await import("../diagnose.js")
const F = D.FAILURE

console.log("== 1. provider failures, as forge's provider layer words them ==")
{
  const cases = [
    ["ERROR: sub-agent failed: provider HTTP 402: This request would exceed your available credits.", F.PROVIDER_CREDITS],
    ["ERROR: sub-agent failed: provider HTTP 402 — out of credits on openrouter (113 output tokens affordable)", F.PROVIDER_CREDITS],
    ["ERROR: sub-agent failed: insufficient balance", F.PROVIDER_CREDITS],
    ["ERROR: sub-agent failed: provider HTTP 402: account suspended", F.PROVIDER_CREDITS],
    ["ERROR: sub-agent failed: provider HTTP 429: 您已达到总请求数限制：1分钟内最多请求10次", F.PROVIDER_RATE_LIMIT],
    ["ERROR: sub-agent failed: provider HTTP 429: Rate limit reached for requests", F.PROVIDER_RATE_LIMIT],
    ["ERROR: sub-agent failed: provider HTTP 401: Incorrect API key provided", F.PROVIDER_AUTH],
    ["ERROR: sub-agent failed: provider HTTP 403: forbidden", F.PROVIDER_AUTH],
    ["ERROR: sub-agent failed: provider HTTP 400: This model's maximum context length is 131072 tokens", F.PROVIDER_CONTEXT],
    ["ERROR: sub-agent failed: context_length_exceeded", F.PROVIDER_CONTEXT],
  ]
  for (const [text, want] of cases) {
    const got = D.classifyFailure(text, { tool: "delegate" }).code
    ok(`${want}: ${text.slice(24, 90)}`, got === want, got)
  }
  const first = (code) => cases.find(([, want]) => want === code)[0]
  ok("a rate limit is transient; out of credits is not", D.classifyFailure(first(F.PROVIDER_RATE_LIMIT), {}).transient === true && D.classifyFailure(first(F.PROVIDER_CREDITS), {}).transient === false)
}

console.log("== 2. nothing else is mistaken for one ==")
{
  const not = [
    ["1 test failed\n[exit code: 1]", { tool: "bash", args: { command: "npm test" } }, F.TEST_FAILURE],
    ["ERROR: file fixtures/429.json not found", {}, F.NOT_FOUND],
    ["ERROR: EACCES: permission denied, open '/etc/x'", {}, F.PERMISSION_DENIED],
    ["ERROR: fetch failed (ECONNREFUSED)", {}, F.NETWORK_FAILURE],
  ]
  for (const text of ["ERROR: 402 passing, 3 failed", "ERROR: expected status 429, got 200", "ERROR: HTTP 401 from the app under test"]) {
    const got = D.classifyFailure(text, {}).code
    ok(`a number in a test log is not a provider failure: ${text.slice(7, 60)}`, !String(got).startsWith("PROVIDER_"), got)
  }
  for (const [text, meta, want] of not) {
    const got = D.classifyFailure(text, meta).code
    ok(`still ${want}: ${text.split("\n")[0].slice(0, 60)}`, got === want, got)
  }
}

console.log("== 3. each gets the reaction it needs ==")
{
  const credits = D.recoveryPlan(F.PROVIDER_CREDITS, { idempotent: true })
  ok("out of credits: tell the person first — never retry", credits.strategies[0].action === D.STRATEGY.ESCALATE && !credits.strategies.some((x) => x.action === D.STRATEGY.RETRY), credits.summary)
  ok("…and finish with what is already known", credits.strategies.some((x) => x.action === D.STRATEGY.REDUCE_SCOPE))
  const rate = D.recoveryPlan(F.PROVIDER_RATE_LIMIT, { idempotent: true })
  ok("rate limited: wait and retry once, then make fewer calls", rate.strategies[0].action === D.STRATEGY.RETRY && rate.strategies[1].action === D.STRATEGY.REDUCE_SCOPE && rate.maxAttempts === 2, rate.summary)
  ok("…but never a retry after an attempt already failed", !D.recoveryPlan(F.PROVIDER_RATE_LIMIT, { idempotent: true, attempts: 1 }).strategies.some((x) => x.action === D.STRATEGY.RETRY))
  const auth = D.recoveryPlan(F.PROVIDER_AUTH, {})
  ok("key refused: the person fixes it; no retry", auth.summary === "escalate → abort", auth.summary)
  const ctx = D.recoveryPlan(F.PROVIDER_CONTEXT, {})
  ok("context too long: narrow the subtask", ctx.strategies[0].action === D.STRATEGY.REDUCE_SCOPE)
  const line = D.formatDiagnosis(D.diagnose("ERROR: sub-agent failed: provider HTTP 402: This request would exceed your available credits.", { tool: "delegate" }))
  ok("the label the model reads names it", /^\[forge\] failure=PROVIDER_CREDITS • recovery: escalate/.test(line), line)
}

console.log("== 4. escalation: a person decides billing and keys — unless full control is on ==")
{
  ok("out of credits asks the person", D.shouldEscalate({ code: F.PROVIDER_CREDITS }).escalate === true)
  ok("a refused key asks the person", D.shouldEscalate({ code: F.PROVIDER_AUTH }).escalate === true)
  ok("full control (YOLO) never pauses the run", D.shouldEscalate({ code: F.PROVIDER_CREDITS, autoApprove: true }).escalate === false)
}

/** A parent run that delegates; the sub-agent's request gets `status`. */
async function delegated(status, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-provfail-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "README.md"), "# probe\n")
  let result = ""
  const isSub = (j) => (j.messages ?? []).some((m) => m.role === "user" && String(m.content ?? "").includes("SUBTASK-MARK"))
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
      if (isSub(j)) return send(status, { error: { code: status, message } })
      const tool = (j.messages ?? []).find((m) => m.role === "tool")
      if (tool) { result = String(tool.content ?? ""); return send(200, { id: "c", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }
      send(200, { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "d1", type: "function", function: { name: "delegate", arguments: JSON.stringify({ task: "SUBTASK-MARK: read README.md", role: "researcher" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "4", "--", "summarise the project"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "stub-key", NO_COLOR: "1" }, stdio: "ignore" })
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 60000); child.once("exit", () => { clearTimeout(t); r() }) })
  srv.closeAllConnections?.(); await new Promise((r) => srv.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
  return result
}

console.log("== 5. a real run: the parent reads the sub-agent's failure correctly ==")
{
  const r402 = await delegated(402, "This request would exceed your available credits.")
  ok("a sub-agent out of credits: the parent reads failure=PROVIDER_CREDITS, recovery escalate", /failure=PROVIDER_CREDITS • recovery: escalate/.test(r402), r402.slice(0, 300))
  const r401 = await delegated(401, "Incorrect API key provided")
  ok("a sub-agent whose key is refused: failure=PROVIDER_AUTH", /failure=PROVIDER_AUTH/.test(r401), r401.slice(0, 300))
}

console.log(`== provider-failures suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
