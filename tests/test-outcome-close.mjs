#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-close-"))
process.env.FORGE_HOME = HOME
const { createCognition } = await import("../cognition.js")
const { loadOutcomeModel } = await import("../outcome-model.js")
let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-close-proj-"))
const c = createCognition({ cwd, objective: "implement a small function" })
c.noteStrategies([{ id: "S", key: "stable-strategy", text: "stable", reversible: true, cost: 0.1, confidence: 0.8 }])
const result = c.close({ wrote: 0, unverified: [] })
const model = loadOutcomeModel(cwd)
const row = model.byKlass?.SMALL?.["stable-strategy"]
ok("close computes final gate before outcome recording", Boolean(result && row))
console.log(JSON.stringify({result,row,keys:Object.keys(model.byKlass||{})})); ok("close records the actual final outcome", row?.samples === 1)
console.log(`\n== close outcome regression: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
