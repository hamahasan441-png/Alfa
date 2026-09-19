#!/usr/bin/env node
/**
 * forge — `maxSteps` has to bound the run it is asked to bound (v124).
 *
 * A productive run is allowed to extend past its step budget: that is v99's
 * deliberate design, and it is right — a healthy long run should not die one
 * step short. What was wrong is that the extension was bounded only by the
 * ABSOLUTE hard cap (1000 steps), never by what the caller actually asked for,
 * and the increment carries a floor of 32. So a small budget was not a budget:
 *
 *     maxSteps: 4  →  4, 36, 68, … 1000     (32 extensions)
 *
 * Measured with a mock model that writes a DIFFERENT file every turn — the
 * shape that always looks productive, so every extension is granted:
 *
 *     maxSteps: 4  → 517 model calls
 *     maxSteps: 8  → 521 model calls
 *     maxSteps: 16 → 529 model calls
 *
 * Nearly identical, because `maxSteps` was not the thing stopping them —
 * `maxToolCallsHardCap` (500) was. Someone who sets `maxSteps: 4` to cap spend
 * on an untrusted task got ~500 model calls.
 *
 * The ceiling now scales with the request (13x, still clamped to the hard cap),
 * chosen so the DEFAULT is bit-identical: 80 × 13 = 1040 → clamped to 1000,
 * exactly as before. This suite asserts both halves — that a small budget is
 * now honoured, and that the default was not quietly tightened.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-loopbudget-"))
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 200) : ""}`) }
}

const { runAgent } = await import("../agent.js")
const { AGENT_BUDGETS } = await import("../config.js")

const toolCall = (id, name, args) => ({
  role: "assistant", content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
})

/** Drive the REAL agent loop against a scripted model. Returns call count. */
async function drive(script, agentCfg = {}, timeoutMs = 90000) {
  let calls = 0
  const server = http.createServer((req, res) => {
    if (!req.url.includes("chat/completions")) { res.writeHead(404).end(); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      calls++
      const message = script(calls)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-loopbudget-run-"))
  const prev = process.cwd()
  let result = null, timedOut = false
  try {
    process.chdir(dir)
    result = await Promise.race([
      runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, verifyNudge: false, ...agentCfg } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
        task: "do the thing", journal: false,
      }),
      new Promise((r) => setTimeout(() => { timedOut = true; r(null) }, timeoutMs)),
    ])
  } catch { /* an exhausted run may throw; the call count is what we assert */ }
  finally { process.chdir(prev); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  return { calls, result, timedOut }
}

// the adversarial shape: every turn writes a NEW file, so the productivity
// judgment ("wroteRecently") is satisfied forever and every extension is granted
const alwaysProductive = (n) => toolCall(`t${n}`, "write_file", { path: `f${n}.txt`, content: `v${n}\n` })

console.log("== a small budget is a budget again ==")
{
  for (const [maxSteps, ceiling] of [[4, 52], [8, 104]]) {
    const { calls, timedOut } = await drive(alwaysProductive, { maxSteps })
    ok(`maxSteps:${maxSteps} does not run away (${calls} model calls, was ~5${maxSteps === 4 ? "17" : "21"})`,
      !timedOut && calls <= ceiling + 4, `${calls} calls`)
    ok(`…and it is bounded by the request, not the hard cap (<= ${ceiling}+slack, cap is ${AGENT_BUDGETS.maxStepsHardCap})`,
      calls < AGENT_BUDGETS.maxStepsHardCap / 2, `${calls}`)
  }
  // the ceiling must scale: a bigger request gets proportionally more room
  const small = await drive(alwaysProductive, { maxSteps: 4 })
  const bigger = await drive(alwaysProductive, { maxSteps: 16 })
  ok(`a 4x bigger budget buys proportionally more room (${small.calls} → ${bigger.calls})`,
    bigger.calls > small.calls * 2, `${small.calls} vs ${bigger.calls}`)
}

console.log("== the DEFAULT budget is not tightened (the whole point of the factor) ==")
{
  // pure arithmetic — running 1000 model calls in a suite would be absurd
  const F = 13
  const ceil = (init) => Math.min(AGENT_BUDGETS.maxStepsHardCap, Math.max(init, init * F))
  ok(`the default maxSteps (${AGENT_BUDGETS.maxSteps}) still reaches the hard cap exactly`,
    ceil(AGENT_BUDGETS.maxSteps) === AGENT_BUDGETS.maxStepsHardCap,
    `${ceil(AGENT_BUDGETS.maxSteps)} vs ${AGENT_BUDGETS.maxStepsHardCap}`)
  ok("…and so does anything larger", ceil(200) === AGENT_BUDGETS.maxStepsHardCap)
  ok("a small budget does NOT reach the hard cap", ceil(4) < AGENT_BUDGETS.maxStepsHardCap, String(ceil(4)))
  ok("the ceiling is monotonic in the request",
    ceil(4) < ceil(8) && ceil(8) < ceil(16) && ceil(16) <= ceil(80))
  ok("the ceiling is never below the request itself (a budget is never shrunk)",
    [1, 2, 4, 8, 80, 999, 5000].every((i) => ceil(i) >= Math.min(i, AGENT_BUDGETS.maxStepsHardCap)))
}

console.log("== the loop still terminates under every adversarial shape ==")
{
  // none of these should need the timeout to stop them
  const shapes = [
    ["always empty content", () => ({ role: "assistant", content: "" })],
    ["the SAME tool call forever (a spin)", () => toolCall(`t${Math.random()}`, "glob_files", { pattern: "*.js" })],
    ["alternating empty / tool call", (n) => (n % 2 ? { role: "assistant", content: "" } : toolCall(`t${n}`, "glob_files", { pattern: "*.js" }))],
    ["tool calls with empty content forever", (n) => toolCall(`t${n}`, "glob_files", { pattern: "*.js" })],
  ]
  for (const [label, script] of shapes) {
    const { calls, timedOut } = await drive(script, { maxSteps: 8 }, 45000)
    ok(`${label}: terminates on its own (${calls} calls)`, !timedOut, timedOut ? "TIMED OUT" : "")
    ok(`${label}: and stays near the budget`, calls <= 120, `${calls} calls`)
  }
}

console.log("== the extension rule is wired the way it is described ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("a ceiling is computed from the requested budget", /const extensionCeiling = Math\.min\(AGENT_BUDGETS\.maxStepsHardCap/.test(src))
  ok("…and the gate uses it, not the bare hard cap", /if \(maxSteps >= extensionCeiling\) return null/.test(src))
  ok("…and the step extension is clamped to it", /maxSteps \+ Math\.max\(maxStepsInitial, 32\), extensionCeiling\)/.test(src))
  ok("the tool-call budget gets the same treatment", /toolCallCeiling/.test(src) && /maxToolCalls \+ Math\.max\(maxStepsInitial, 32\), toolCallCeiling\)/.test(src))
  // note: the obvious `[^,]+` version of this cannot match, because the
  // increment itself contains a comma — it passed against the old code
  ok("no extension path still clamps to the bare step hard cap",
    !/maxSteps \+ Math\.max\(maxStepsInitial, 32\), AGENT_BUDGETS\.maxStepsHardCap\)/.test(src))
  ok("…nor the tool-call one",
    !/maxToolCalls \+ Math\.max\(maxStepsInitial, 32\), AGENT_BUDGETS\.maxToolCallsHardCap\)/.test(src))
}

console.log(`\n== loop-budget suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
