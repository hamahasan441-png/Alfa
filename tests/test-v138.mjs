import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v138-home-'))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v138-work-'))
process.env.FORGE_HOME = HOME
process.chdir(WORK)

const { runMeta } = await import('../meta.js')
const { cognitionPath } = await import('../cognition.js')

let passed = 0
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++ }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 }
}

const events = []
let calls = 0
const runAgent = async (o) => {
  if (o.planOnly) return {
    text: '1. inspect auth\n2. patch auth\n3. verify auth',
    toolRecords: [], commandChecks: [], toolLog: [],
  }
  calls++
  if (calls === 2) return {
    text: 'patched auth', budgetHit: false, steps: 2,
    toolRecords: [{ tool: 'edit_file', files_changed: ['src/parser.js'] }],
    commandChecks: [{ command: 'npx vitest run src/parser.test.js', exitCode: 1, passed: false, tail: '1 failed' }],
    toolLog: [],
  }
  return {
    text: 'patched auth and verified', budgetHit: false, steps: 2,
    toolRecords: [{ tool: 'read_file', files: ['src/parser.js'], result: 'observed failing parser line' }],
    commandChecks: [
      { command: 'node --check src/parser.js', exitCode: 0, passed: true, tail: 'ok' },
      { command: 'npx vitest run src/parser.test.js', exitCode: 0, passed: true, tail: '1 passed' },
      { command: 'npm test', exitCode: 0, passed: true, tail: 'suite passed' },
      { command: 'npm run build', exitCode: 0, passed: true, tail: 'build passed' },
      { command: 'npm audit --omit=dev', exitCode: 0, passed: true, tail: 'audit clean' },
    ],
    toolLog: [],
  }
}

const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }
const result = await runMeta({
  config: cfg,
  provider: { name: 'mock', model: 'mock-e2e' },
  task: 'fix the parser bug and verify it',
  runAgent,
  signal: new AbortController().signal,
  onEvent: (e) => events.push(e),
})

test('real meta lifecycle reaches COMPLETED after a failed first attempt and repair', () => {
  assert.equal(result.status, 'COMPLETED')
  assert.ok(result.repairs >= 1)
})

test('user intent is booted on the live meta path', () => {
  assert.ok(events.some((e) => e.type === 'COGNITION_BOOTED' && e.intent === 'fix the parser bug and verify it'))
})

test('failure and recovery remain observable', () => {
  assert.ok(events.some((e) => e.type === 'VERIFICATION_FAILED'))
  assert.ok(events.some((e) => e.type === 'REPAIR_STARTED'))
  assert.ok(events.some((e) => e.type === 'VERIFICATION_PASSED'))
})

test('selected experiment reaches the live repair path with observed evidence', () => {
  const selected = events.find((e) => e.type === 'EXPERIMENT_SELECTED')
  assert.ok(selected, 'experiment was not selected')
  const executed = events.find((e) => e.type === 'EXPERIMENT_EXECUTED')
  assert.ok(executed, 'selected experiment was not executed')
  assert.equal(executed.id, selected.id)
  assert.equal(typeof executed.ok, 'boolean')
  assert.ok((typeof executed.command === 'string' && executed.command.length > 0) || (typeof executed.tool === 'string' && executed.tool.length > 0))
})

test('cognitive state is terminal and durably persisted', () => {
  const file = cognitionPath(WORK)
  assert.ok(fs.existsSync(file), 'cognition.json missing')
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(snap.cognitiveState.phase, 'COMPLETE')
  assert.equal(snap.contract.originalIntent, 'fix the parser bug and verify it')
  assert.ok(Array.isArray(snap.events) && snap.events.some((e) => e.type === 'TASK_COMPLETED'))
})

test('final event reports the canonical task result', () => {
  const finished = events.findLast((e) => e.type === 'TASK_FINISHED')
  assert.equal(finished?.status, 'COMPLETED')
})

console.log(`v138 end-to-end user task: ${passed}/6 PASS`)
if (passed !== 6) process.exitCode = 1
