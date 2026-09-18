#!/usr/bin/env node
/** v140 alpha-core: measured strategy outcome model + causal attribution. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v140-"))
process.env.FORGE_HOME = HOME
const { recordStrategyOutcome, recommendStrategyOutcome, loadOutcomeModel } = await import("../outcome-model.js")
const { createLearningLoop } = await import("../learning-loop.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== thin evidence never overrides the default ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v140-proj-"))
  for (let i = 0; i < 4; i++) recordStrategyOutcome({ cwd, klass: "MEDIUM", key: "measured-good", ok: true })
  ok("recommendation is absent below the minimum evidence threshold", recommendStrategyOutcome({ cwd, klass: "MEDIUM", candidates: [{ key: "measured-good" }, { key: "other" }] }) === null)
}

console.log("\n== measured outcomes can change a future strategy ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v140-proj-"))
  for (let i = 0; i < 6; i++) recordStrategyOutcome({ cwd, klass: "MEDIUM", key: "measured-good", ok: true })
  for (let i = 0; i < 6; i++) recordStrategyOutcome({ cwd, klass: "MEDIUM", key: "measured-bad", ok: false })
  const r = recommendStrategyOutcome({ cwd, klass: "MEDIUM", candidates: [{ key: "measured-bad" }, { key: "measured-good" }] })
  ok("learned strategy is selected from real outcomes", r?.key === "measured-good")
  ok("recommendation reports evidence count", r?.samples === 6)
  ok("persisted model contains the measured row", loadOutcomeModel(cwd).byKlass.MEDIUM["measured-good"].ok === 6)
}

console.log("\n== learning loop preserves causal attribution ==")
{
  const loop = createLearningLoop()
  const r = loop.record({
    action: "repair",
    observation: { causal: { layer: "ROOT", node: { id: "C7", description: "wrong dependency" } } },
    attribution: { causeId: "C7", layer: "ROOT", confidence: 0.9 },
    outcome: "complete",
    error: 0,
  })
  ok("record keeps attribution", r.attribution?.causeId === "C7")
  ok("snapshot keeps attribution", loop.snapshot().records[0]?.attribution?.layer === "ROOT")
}


console.log("\n== live cognition path consumes measured strategy outcomes ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v140-live-"))
  for (let i = 0; i < 6; i++) recordStrategyOutcome({ cwd, klass: "LARGE", key: "learned-path", ok: true })
  for (let i = 0; i < 6; i++) recordStrategyOutcome({ cwd, klass: "LARGE", key: "default-path", ok: false })
  const { createCognition } = await import("../cognition.js")
  const cognition = createCognition({ cwd, objective: "refactor authentication module" })
  const ranked = cognition.noteStrategies([
    { id: "D", key: "default-path", text: "default", reversible: true, cost: 0.2, confidence: 0.8 },
    { id: "L", key: "learned-path", text: "learned", reversible: true, cost: 0.2, confidence: 0.5 },
  ])
  ok("live cognition promotes the measured strategy", ranked[0]?.key === "learned-path")
  ok("live cognition emits the learning event", cognition.events.some((e) => e.type === "LEARNED_STRATEGY_SELECTED"))
}

console.log(`\n== v140 alpha-core suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)

console.log("\n== outcome v2 is conservative and keeps recent evidence ==")
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v140-v2-"))
  for (let i = 0; i < 5; i++) recordStrategyOutcome({ cwd, klass: "SMALL", key: "mostly-good", ok: i < 4 })
  const row = loadOutcomeModel(cwd).byKlass.SMALL["mostly-good"]
  ok("recent outcome history is bounded and persisted", Array.isArray(row.recent) && row.recent.length === 5)
  const r = recommendStrategyOutcome({ cwd, klass: "SMALL", candidates: [{ key: "mostly-good" }, { key: "unknown" }] })
  ok("recommendation exposes conservative confidence bound", Number.isFinite(r?.confidenceBound) && r.confidenceBound < r.rate)
}
