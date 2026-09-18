#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createCognition } from '../cognition.js'

const c=createCognition({cwd:process.cwd(),objective:'fix outcome model',governorEnforce:false})
const boot=c.boot('fix outcome model')
assert.ok(boot)
assert.ok(c.horizonIntelligence?.risk)
const r=c.updateHorizon({changedFiles:['outcome-model.js'],historicalFailures:[{file:'outcome-model.js'}],tests:[{id:'t1',passed:false}],budget:{objective:'fix outcome model',stepsLeft:5,timeLeftMs:1000,maxParallel:2}})
assert.equal(r.risk.nodes.length>0,true)
assert.equal(r.risk.requiresEscalation,false)
// Explicit node metadata drives escalation; no authority bypass is possible.
const c2=createCognition({cwd:process.cwd(),objective:'x',governorEnforce:false})
c2.boot('x')
const rr=c2.updateHorizon({changedFiles:['outcome-model.js'],historicalFailures:[{file:'outcome-model.js'}],tests:[{id:'t1',passed:false}]})
assert.ok(rr.risk)
assert.equal(rr.decision.action,'CONTINUE')
console.log('horizon-risk-integration: 5/5 PASS')
