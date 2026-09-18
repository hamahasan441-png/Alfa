import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-horizon-agent-live-'))
fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(dir, 'b.js'), "import { a } from './a.js'; export const b = a\n")

let turn = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    turn++
    const msg = turn === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: path.join(dir, 'a.js'), content: 'export const a = 2\n' }) } }] }
      : { role: 'assistant', content: 'live horizon wiring verified', tool_calls: [] }
    const payload = JSON.stringify({ id: 'horizon-live', object: 'chat.completion', created: Date.now(), model: 'mock-1', choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(payload)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const { runAgent } = await import('../agent.js')
const events = []
const previousCwd = process.cwd()
process.chdir(dir)
try {
  const result = await runAgent({
    config: {
      providers: {},
      tools: { assumeYes: true, mcp: false, plugins: false, lsp: false, browser: false },
      agent: { autonomous: false, maxSteps: 6, verifyNudge: false, review: 'off', continuity: false },
      skills: { enabled: false },
      mcp: { maxTools: 0 },
    },
    provider: { name: 'mock', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'mock-1' },
    task: 'update a.js and verify the dependency impact',
    journal: false,
    onEvent: (e) => events.push(e),
  })
  assert.notEqual(result.status, 'FAILED', JSON.stringify(result.error ?? {}))
  assert.equal(result.softFailures?.total ?? 0, 0, JSON.stringify(result.softFailures ?? {}))
  assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'export const a = 2\n')
  const horizon = events.filter((e) => e.type === 'HORIZON_RISK_UPDATED').at(-1)
  assert.ok(horizon, 'live agent must emit a Horizon update after tool processing')
  assert.ok(horizon.impact.includes('b.js'), `expected dependency impact b.js, got ${JSON.stringify(horizon.impact)}`)
  assert.equal(horizon.replanned, false)
  assert.ok(Number.isInteger(horizon.wave))
} finally {
  process.chdir(previousCwd)
  server.close()
}

console.log('horizon-agent-live-integration: 5/5 PASS')
