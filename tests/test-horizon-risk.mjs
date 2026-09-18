#!/usr/bin/env node
import assert from 'node:assert/strict'
import { scoreHorizonRisk } from '../horizon-risk.js'

const nodes=[
  {id:'safe',objective:'docs update',files:['README.md']},
  {id:'hot',objective:'fix outcome model',files:['outcome-model.js'],tests:['outcome-test']},
]
let r=scoreHorizonRisk({nodes,changedFiles:['outcome-model.js'],historicalFailures:[{file:'outcome-model.js'}],tests:[{id:'outcome-test',passed:false}]})
assert.equal(r.nodes.length,2)
assert.equal(r.nodes[0].level,'LOW')
assert.equal(r.nodes[1].level,'HIGH')
assert.deepEqual(r.verification,['hot'])
assert.equal(r.requiresEscalation,true)
r=scoreHorizonRisk({nodes:[{id:'x',objective:'new parser',files:['parser.js']}],changedFiles:[],historicalFailures:[],tests:[]})
assert.equal(r.nodes[0].score,0)
assert.equal(r.requiresEscalation,false)
console.log('horizon-risk: 6/6 PASS')
