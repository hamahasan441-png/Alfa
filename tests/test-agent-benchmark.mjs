import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEvalTask, summarize, EVAL_TASKS } from '../evalbench.js'

const task = EVAL_TASKS.find(t => t.id === 'off-by-one')
assert.ok(task)

let calls = 0
const honest = async () => {
  calls++
  fs.writeFileSync(path.join(process.cwd(), 'sum.js'), task.solution['sum.js'])
  return { status: 'COMPLETED', usage: {}, trace: { phases: [] }, steps: 1 }
}
const r = await runEvalTask(task, { runAgent: honest, provider: { name: 'contract', model: 'test' } })
assert.equal(r.solved, true)
assert.equal(r.falseCompletion, false)
assert.equal(calls, 1)

const lying = async () => ({ status: 'COMPLETED', usage: {}, trace: { phases: [] }, steps: 1 })
const bad = await runEvalTask(task, { runAgent: lying, provider: { name: 'contract', model: 'test' } })
assert.equal(bad.solved, false)
assert.equal(bad.falseCompletion, true)

const silent = async () => ({ status: 'INCOMPLETE', usage: {}, trace: { phases: [] }, steps: 1 })
const silentResult = await runEvalTask(task, { runAgent: silent, provider: { name: 'contract', model: 'test' } })
assert.equal(silentResult.silentSuccess, false)
assert.equal(silentResult.solved, false)

const summary = summarize([r, bad])
assert.equal(summary.tasks, 2)
assert.equal(summary.solved, 1)
assert.equal(summary.falseCompletions, 1)
console.log('agent-benchmark contract 10/10 PASS')
