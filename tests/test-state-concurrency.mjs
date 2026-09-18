#!/usr/bin/env node
/** Regression: atomic rename alone is not enough for read-modify-write state. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-state-concurrency-home-"))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-state-concurrency-proj-"))
const helper = path.join(cwd, "writer.mjs")
const outcomeModel = fileURLToPath(new URL("../outcome-model.js", import.meta.url))
fs.writeFileSync(helper, `
  import { recordStrategyOutcome } from ${JSON.stringify(outcomeModel)}
  const cwd = process.argv[2]
  const n = Number(process.argv[3])
  for (let i = 0; i < n; i++) recordStrategyOutcome({ cwd, klass: "MEDIUM", key: "concurrent", ok: true })
`)

function runWriter() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, cwd, "10"], {
      cwd,
      env: { ...process.env, FORGE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (d) => { stderr += d })
    child.once("error", reject)
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`writer exited ${code ?? signal}: ${stderr.slice(0, 2000)}`)))
  })
}

await Promise.all(Array.from({ length: 4 }, runWriter))
process.env.FORGE_HOME = HOME
const { loadOutcomeModel } = await import("../outcome-model.js")
const row = loadOutcomeModel(cwd).byKlass.MEDIUM?.concurrent
if (row?.samples !== 40 || row?.ok !== 40 || row?.failed !== 0) {
  console.error("FAIL concurrent state update was lost", row)
  process.exit(1)
}
console.log("state-concurrency: 40/40 updates preserved")

