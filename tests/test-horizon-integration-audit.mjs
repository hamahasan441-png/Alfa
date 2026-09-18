import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { impactFromChangedFiles } from '../intelligence-expansion.js'
import { createCognition } from '../cognition.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-horizon-audit-'))
fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(dir, 'b.js'), "import { a } from './a.js'; export const b = a\n")

// Regression: live agent ledgers use absolute paths; impact must resolve them
// against the supplied repository root before querying the relative graph.
const absImpact = impactFromChangedFiles(dir, [path.join(dir, 'a.js')])
assert.deepEqual(absImpact.changed, ['a.js'])
assert.ok(absImpact.impact.some((x) => x.path === 'b.js'))

const c = createCognition({ cwd: dir, objective: 'repair a.js and verify it' })
c.boot()
const first = c.horizonIntelligence
const firstIds = first.checkpoint.nodes.map((n) => n.id)
assert.ok(firstIds.length >= 1)
const failedId = firstIds[0]
const r = c.updateHorizon({
  failed: [failedId],
  changedFiles: [path.join(dir, 'a.js')],
  historicalFailures: [{ file: path.join(dir, 'a.js'), message: 'failed check' }],
  tests: [{ id: 'npm test', passed: false }],
  budget: { stepsLeft: 5, maxParallel: 2 },
  attempt: 2,
})
assert.equal(r.replanned?.plan?.length > 0, true)
assert.equal(r.checkpoint.nodes.length, r.replanned.plan.length)
assert.ok(r.liveImpact.impact.some((x) => x.path === 'b.js'))
assert.ok(Array.isArray(r.coordinator.waves))
assert.ok(r.recovery)

const agentSrc = fs.readFileSync(new URL('../agent.js', import.meta.url), 'utf8')
const updatePos = agentSrc.indexOf('cognition.updateHorizon({')
const journalPos = agentSrc.indexOf('writesSoFar.push(fp); writeSteps.push(steps)')
assert.ok(updatePos > journalPos, 'Horizon observation must occur after current tool writes are journaled')

console.log('horizon-integration-audit: 7/7 PASS')
