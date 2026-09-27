#!/usr/bin/env node
/**
 * forge — v173 comparewise: `forge eval --compare`.
 *
 * forge against other models on the SAME hidden-test tasks. Pinned here with a
 * stub agent (no live model): each "model" either writes the known solution or
 * does nothing, so the expected ranking is known in advance. What is asserted
 * is honesty, not a verdict about any real model:
 *   - the hidden test decides, never the agent's claim;
 *   - a model that claims done on failing work is counted as a false completion;
 *   - a contender that never reached its model is NOT_RUN, not ranked last;
 *   - a gap inside the noise margin is TOO CLOSE TO CALL;
 *   - the model is locked during the run and the lock is restored after.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compare-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { EVAL_TASKS, parseCompareSpecs, compareMargin, runCompare, formatCompareReport } = await import("../evalbench.js")

const tasks = EVAL_TASKS.slice(0, 4)
const byPrompt = new Map(tasks.map((t) => [t.prompt, t]))
const solve = (t) => { for (const [rel, c] of Object.entries(t.solution)) { fs.mkdirSync(path.dirname(rel) || ".", { recursive: true }); fs.writeFileSync(rel, String(c)) } }

// behaviour per model: how many of the tasks it solves, and whether it lies
const BEHAVIOUR = {
  "stub/strong": { solves: 4, lies: false },
  "stub/weak": { solves: 1, lies: true },
  "stub/close": { solves: 3, lies: false },
}
let lockSeen = []
const runAgent = async ({ provider, task }) => {
  lockSeen.push(process.env.FORGE_LOCK_MODEL)
  const b = BEHAVIOUR[`${provider.name}/${provider.model}`]
  if (!b) throw new Error("HTTP 401 invalid key")
  const t = byPrompt.get(task)
  const idx = tasks.indexOf(t)
  if (idx < b.solves) { solve(t); return { status: "COMPLETED", usage: { promptTokens: 100, completionTokens: 10, toolCalls: 2 } } }
  return { status: b.lies ? "COMPLETED" : "INCOMPLETE", usage: { promptTokens: 50, completionTokens: 5, toolCalls: 1 } }
}
const prov = (label) => { const [name, model] = label.split("/"); return { name, model } }

console.log("== 1. parsing contenders ==")
{
  eq("provider/model", parseCompareSpecs("openai/gpt-4o"), [{ provider: "openai", model: "gpt-4o" }])
  eq("splits at the first slash only", parseCompareSpecs("openrouter/openai/gpt-4o"), [{ provider: "openrouter", model: "openai/gpt-4o" }])
  eq("comma list, spaces, duplicates dropped", parseCompareSpecs(" a/x , b/y,a/x "), [{ provider: "a", model: "x" }, { provider: "b", model: "y" }])
  let threw = false
  try { parseCompareSpecs("gpt-4o") } catch { threw = true }
  ok("a bare model with no provider is refused, not guessed", threw)
  threw = false
  try { parseCompareSpecs("openai/") } catch { threw = true }
  ok("an empty model is refused", threw)
  eq("margin is at least one task", compareMargin(4), 1)
  eq("margin is 10% of a larger set", compareMargin(30), 3)
}

console.log("== 2. ranking by the hidden test ==")
{
  const prevLock = process.env.FORGE_LOCK_MODEL
  lockSeen = []
  const cmp = await runCompare({
    tasks, runAgent,
    contenders: [
      { label: "stub/weak", self: true, provider: prov("stub/weak") },
      { label: "stub/strong", provider: prov("stub/strong") },
      { label: "nokey/x", notRun: "no API key for nokey" },
      { label: "stub/broken", provider: prov("stub/broken") },
    ],
  })
  eq("strongest first, weakest last; unreachable ones not ranked", cmp.ranking, ["stub/strong", "stub/weak"])
  eq("leader", cmp.leader, "stub/strong")
  ok("a 3-task gap on 4 tasks is not too close to call", cmp.tooClose === false)
  const weak = cmp.entries.find((e) => e.label === "stub/weak")
  eq("the weak model's false claims are counted", weak.summary.falseCompletions, 3)
  eq("forge's own model knows its place", cmp.self, { label: "stub/weak", rank: 2, of: 2 })
  const broken = cmp.entries.find((e) => e.label === "stub/broken")
  ok("a contender whose every run errored is NOT_RUN", Boolean(broken.notRun), JSON.stringify(broken.notRun))
  ok("a contender with no key is NOT_RUN", Boolean(cmp.entries.find((e) => e.label === "nokey/x").notRun))
  ok("the model was locked for every run", lockSeen.length > 0 && lockSeen.every((v) => v === "1"), JSON.stringify(lockSeen))
  eq("the lock is restored afterwards", process.env.FORGE_LOCK_MODEL, prevLock)

  const text = formatCompareReport(cmp)
  ok("report names the leader", /LEADER on this set: stub\/strong/.test(text), text)
  ok("report states forge's place", /placed 2 of 2/.test(text), text)
  ok("report shows NOT_RUN instead of a score", /nokey\/x\s+NOT_RUN/.test(text), text)
  ok("report names the false completions", /FALSE COMPLETIONS .*stub\/weak 3/.test(text), text)
}

console.log("== 3. a small gap is reported as noise ==")
{
  const cmp = await runCompare({
    tasks, runAgent,
    contenders: [
      { label: "stub/close", self: true, provider: prov("stub/close") },
      { label: "stub/strong", provider: prov("stub/strong") },
    ],
  })
  eq("still ordered", cmp.ranking, ["stub/strong", "stub/close"])
  ok("a one-task gap on four tasks is too close to call", cmp.tooClose === true)
  ok("…and the report says so instead of naming a winner", /TOO CLOSE TO CALL/.test(formatCompareReport(cmp)) && !/LEADER/.test(formatCompareReport(cmp)))
}

console.log("== 4. nothing reached a model ==")
{
  const cmp = await runCompare({ tasks, runAgent, contenders: [{ label: "a/b", notRun: "no key" }, { label: "c/d", notRun: "no key" }] })
  eq("empty ranking", cmp.ranking, [])
  ok("report says there is no comparison", /no comparison to report/.test(formatCompareReport(cmp)))
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
