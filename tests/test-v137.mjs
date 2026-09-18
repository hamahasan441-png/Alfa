import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cognitionSrc = fs.readFileSync(new URL('../cognition.js', import.meta.url), 'utf8')
const agentSrc = fs.readFileSync(new URL('../agent.js', import.meta.url), 'utf8')
const metaSrc = fs.readFileSync(new URL('../meta.js', import.meta.url), 'utf8')

let passed = 0
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++ }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 }
}

test('cognition has a real user-task boot path on both live controllers', () => {
  assert.match(agentSrc, /cognition\s*=\s*createCognition\([\s\S]*?cognition\.boot\(task\)/)
  assert.match(metaSrc, /const cognition = createCognition\([\s\S]*?cognition\.boot\(state\.objective\)/)
})

test('boot freezes the original user intent and records task creation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v137-'))
  const { createCognition } = await import('../cognition.js')
  const c = createCognition({ cwd: dir, objective: 'fix the login test' })
  c.boot('fix the login test')
  const snap = c.snapshot()
  assert.equal(snap.contract.originalIntent, 'fix the login test')
  assert.equal(snap.contract.currentIntent, 'fix the login test')
  assert.ok(c.events.some((e) => e.type === 'USER_INTENT_CREATED'))
  assert.ok(c.events.some((e) => e.type === 'TASK_CREATED'))
})

test('meta finalizes and persists the cognitive state instead of leaving it mid-run', () => {
  assert.match(metaSrc, /cognition\.close\(/)
  assert.match(metaSrc, /cognition\.persist\(\)/)
})

test('ambiguous user task becomes a real decision input, not a silent guess', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v137-'))
  const { createCognition } = await import('../cognition.js')
  const c = createCognition({ cwd: dir, objective: 'change it' })
  c.boot('change it')
  const snap = c.snapshot()
  assert.ok((snap.contract.unknowns ?? []).length >= 1)
  assert.ok(c.events.some((e) => e.type === 'USER_INTENT_CREATED'))
})

console.log(`v137 user-task wiring: ${passed}/4 PASS`)
if (passed !== 4) process.exitCode = 1
