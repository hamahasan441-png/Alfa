import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createCognition } from '../cognition.js'

const src=fs.readFileSync(new URL('../agent.js',import.meta.url),'utf8')
assert.match(src,/cognition\.updateHorizon\(/)
assert.match(src,/HORIZON_RISK_UPDATED/)
assert.match(src,/changedFiles: writesSoFar/)
assert.match(src,/commandChecks\.slice\(-32\)/)

const c=createCognition({cwd:process.cwd(),objective:'fix parser and run tests'})
c.boot()
const before=c.horizonIntelligence
assert.ok(before?.checkpoint?.nodes?.length>=1)
assert.ok(before.checkpoint.nodes.some(n=>Array.isArray(n.files)))
const r=c.updateHorizon({changedFiles:['cognition.js'],tests:[{id:'npm test',passed:false}],historicalFailures:[],budget:{stepsLeft:3}})
assert.ok(r?.risk && Array.isArray(r.risk.verification))
assert.equal(r.version,'1.0.0')
console.log('horizon-live-wiring: 7/7 PASS')
