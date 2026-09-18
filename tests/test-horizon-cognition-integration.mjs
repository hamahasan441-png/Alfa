import assert from 'node:assert/strict'
import { createCognition } from '../cognition.js'
const c=createCognition({cwd:process.cwd(),objective:'inspect and test the project'})
c.boot()
const before=c.horizonIntelligence
assert.ok(before?.graph?.valid)
const ids=before.checkpoint.nodes.map(n=>n.id)
if(ids.length>=2){
  const r=c.updateHorizon({completed:[ids[0]],evidence:[`verified:${ids[0]}`],budget:{stepsLeft:5,maxParallel:2},attempt:1})
  assert.deepEqual(r.frontier.frontier,[ids[1]])
  assert.equal(r.decision.action,'CONTINUE')
  assert.equal(r.checkpoint.completed.includes(ids[0]),true)
}
console.log('horizon-cognition-integration: PASS')
