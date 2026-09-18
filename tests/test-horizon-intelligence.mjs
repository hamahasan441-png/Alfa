import assert from 'node:assert/strict'
import {validateHorizonGraph,adaptiveFrontier,horizonDecision,checkpointHorizon,advanceHorizon} from '../horizon-intelligence.js'
const good=validateHorizonGraph({nodes:[{id:'a'},{id:'b',deps:['a']},{id:'c',deps:['b']}]}); assert.equal(good.valid,true)
const missing=validateHorizonGraph({nodes:[{id:'a',deps:['x']}]}); assert.equal(missing.valid,false)
const cycle=validateHorizonGraph({nodes:[{id:'a',deps:['b']},{id:'b',deps:['a']}]}); assert.equal(cycle.valid,false)
const f=adaptiveFrontier({nodes:[{id:'a',priority:1},{id:'b',deps:['a'],priority:9}],completed:[]}); assert.deepEqual(f.frontier,['a'])
const f2=adaptiveFrontier({nodes:[{id:'a'},{id:'b',deps:['a']}],completed:['a']}); assert.deepEqual(f2.frontier,['b'])
assert.equal(horizonDecision({frontier:['a'],evidence:['ok']}).action,'CONTINUE')
assert.equal(horizonDecision({frontier:[],evidence:['ok']}).action,'VERIFY')
assert.equal(horizonDecision({frontier:['a'],budget:{stepsLeft:0}}).action,'CHECKPOINT')
const cp=checkpointHorizon({nodes:[{id:'a'}],completed:['a'],attempt:2}); assert.equal(cp.resumable,true); assert.equal(cp.attempt,2)
const adv=advanceHorizon({nodes:[{id:'a'},{id:'b',deps:['a']}],completed:['a'],evidence:['test:a'],budget:{stepsLeft:5,maxParallel:2,objective:'x'}}); assert.deepEqual(adv.frontier.frontier,['b']); assert.equal(adv.decision.action,'CONTINUE')
console.log('horizon-intelligence: 10/10 PASS')

