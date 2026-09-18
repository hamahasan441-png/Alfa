/** Forge V4 Phase 2 — Python runtime isolation + structured IPC. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v132-'))
const skillsDir = path.join(ROOT, 'skills')
const skillDir = path.join(skillsDir, 'demo')
fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo\n')
fs.writeFileSync(path.join(skillDir, 'requirements.txt'), '# intentionally empty for the integration test\n')
fs.writeFileSync(path.join(skillDir, 'scripts', 'hello.py'), 'print("hello-from-skill")\n')
fs.writeFileSync(path.join(skillDir, 'scripts', 'rpc.py'), `import json, sys\nfor line in sys.stdin:\n    req=json.loads(line)\n    print(json.dumps({"jsonrpc":"2.0","id":req.get("id"),"result":{"echo":req.get("params",{})}}), flush=True)\n`)

const { findPython, detectPythonSkill, venvDir, venvPython, ensureSkillVenv, rewritePythonSkillCommand } = await import('../python-runtime.js')
const { runPythonJsonRpc, parseJsonRpcLine } = await import('../python-ipc.js')

const py = findPython()
assert.ok(py, 'Python 3 is required for Phase 2 runtime tests')

const detected = detectPythonSkill({ scriptPath: path.join(skillDir, 'scripts', 'hello.py'), skillsDir })
assert.equal(detected.python, true)
assert.equal(detected.name, 'demo')
assert.equal(path.basename(detected.requirements), 'requirements.txt')

const env = ensureSkillVenv({ root: ROOT, skillName: 'demo', requirements: detected.requirements, install: false })
assert.equal(env.ok, true)
assert.equal(fs.existsSync(venvDir({ root: ROOT, skillName: 'demo' })), true)
assert.equal(fs.existsSync(venvPython(env.dir)), true)

const rewritten = rewritePythonSkillCommand(`python3 ${path.join(skillDir, 'scripts', 'hello.py')}`, {
  cwd: ROOT,
  skillsDir,
  projectRoot: ROOT,
  install: false,
})
assert.equal(rewritten.changed, true)
assert.match(rewritten.command, /\.forge[\\/]venvs[\\/]demo/)

const rpc = await runPythonJsonRpc({
  python: env.python,
  script: path.join(skillDir, 'scripts', 'rpc.py'),
  cwd: skillDir,
  request: { jsonrpc: '2.0', id: 7, method: 'echo', params: { ok: true } },
})
assert.equal(rpc.ok, true)
assert.equal(rpc.response.id, 7)
assert.deepEqual(rpc.response.result.echo, { ok: true })
assert.equal(parseJsonRpcLine(JSON.stringify(rpc.response)).kind, 'response')

// Live tool integration: a direct Python skill command is transparently routed
// to the skill-local interpreter, while the existing bash policy remains in charge.
const { makeToolContext } = await import('../tools.js')
const tc = makeToolContext({ cwd: ROOT, root: ROOT, skillsDir, timeoutSec: 20, maxToolOutput: 4000, unrestricted: true })
const output = await tc.exec('bash', { command: `python3 ${path.join(skillDir, 'scripts', 'hello.py')}` })
assert.match(output, /hello-from-skill/)
assert.equal(fs.existsSync(env.python), true)

console.log('PASS python detection + requirements discovery')
console.log('PASS isolated .forge/venvs/<skill> provisioning')
console.log('PASS direct Python skill command routing')
console.log('PASS JSON-RPC child protocol')
console.log('PASS live tools.js integration')
console.log('v132: 5/5')
