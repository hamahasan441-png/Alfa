import assert from 'node:assert/strict'
import { planHorizonRecovery, HORIZON_RECOVERY_VERSION } from '../horizon-recovery.js'
const nodes=[{id:'a',dependencies:[]},{id:'b',dependencies:['a']},{id:'c',dependencies:['b']}]
let r=planHorizonRecovery({nodes,completed:['a'],reason:'BUDGET'})
assert.equal(HORIZON_RECOVERY_VERSION,'1.0.0'); assert.equal(r.action,'RESUME'); assert.deepEqual(r.resume,['b']); assert.equal(r.checkpointRequired,true)
r=planHorizonRecovery({nodes,completed:['a'],failed:['b'],reason:'FAILURE'})
assert.equal(r.action,'REPLAN'); assert.deepEqual(r.blocked,['c'])
r=planHorizonRecovery({nodes,completed:['a'],evidence:[{status:'STALE'}]})
assert.equal(r.action,'REPLAN'); assert.equal(r.staleEvidence,1)
r=planHorizonRecovery({nodes,completed:['a','b','c']})
assert.equal(r.action,'INVESTIGATE')
console.log('horizon-recovery: 4/4')
