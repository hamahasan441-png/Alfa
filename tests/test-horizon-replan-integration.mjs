import assert from 'node:assert/strict'
import { createCognition } from '../cognition.js'
const c=createCognition({cwd:process.cwd()})
c.boot('improve horizon planning')
const before=c.horizonIntelligence
const ids=before.checkpoint.nodes.map(n=>n.id)
const r=c.updateHorizon({failed:[ids[0]],changedFiles:['cognition.js'],historicalFailures:[{file:'cognition.js'}],tests:[{id:'t',passed:false}],budget:{stepsLeft:5,maxParallel:2}})
assert.equal(r.decision.action,'REPLAN')
assert.ok(r.liveImpact)
assert.ok(Array.isArray(r.liveImpact.impact))
assert.ok(r.replanned && Array.isArray(r.replanned.plan))
assert.equal(c.lastAuth,null)
console.log('horizon-replan-integration: 5/5 PASS')
