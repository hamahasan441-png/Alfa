#!/usr/bin/env node
/** v139 release-hardening: worker grace is configurable and the orphan path is bounded. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v139-"))
process.env.FORGE_HOME = HOME
const { createAgentManager, WORKER_STATUS } = await import("../agentmanager.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== cancellation grace is configurable ==")
{
  const started = Date.now()
  const m = createAgentManager({
    maxWorkers: 1,
    defaultTimeoutMs: 40,
    cancellationGraceMs: 80,
    runner: async () => { await new Promise((r) => setTimeout(r, 500)); return "late" },
  })
  const rec = m.spawn({ role: "researcher", task: "stubborn", nodeId: "n1" })
  await rec.promise
  const elapsed = Date.now() - started
  ok("worker becomes orphaned after the configured grace", rec.status === WORKER_STATUS.ORPHANED)
  ok("orphan remains counted as live", m.stats().live === 1)
  ok("test does not wait for the production 5s default", elapsed < 1000)
  await new Promise((r) => setTimeout(r, 550))
}

console.log(`\n== v139 release-hardening suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
