import assert from 'node:assert/strict'
import { createCognition } from '../cognition.js'
const c=createCognition({cwd:process.cwd()})
const boot=c.boot({objective:'resume after interruption', klass:'SMALL'})
assert.ok(boot.horizonIntelligence?.recovery)
const r=c.updateHorizon({completed:[],failed:[],evidence:[],budget:{stepsLeft:0},attempt:4})
assert.ok(r.recovery)
assert.ok(['RESUME','REPLAN','INVESTIGATE'].includes(r.recovery.action))
assert.notEqual(r.recovery.action,'STOP')
assert.equal(c.enforce({action:'EXECUTE'}).action,'EXECUTE')
console.log('horizon-recovery-integration: 4/4')
