import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createCognition } from '../cognition.js'
const src=fs.readFileSync(new URL('../cognition.js',import.meta.url),'utf8')
assert.match(src,/coordinateHorizon\(/); assert.match(src,/HORIZON_COORDINATOR_VERSION/)
const c=createCognition({cwd:process.cwd(),objective:'coordinate parser changes'})
c.boot(); const h=c.horizonIntelligence
assert.ok(h?.coordinator?.advisory===true); assert.ok(Array.isArray(h.coordinator.waves))
const r=c.updateHorizon({completed:[],failed:[],budget:{stepsLeft:5}})
assert.ok(r?.coordinator?.version==='1.0.0'); assert.ok(Array.isArray(r.coordinator.waves)); assert.equal(r.coordinator.advisory,true)
console.log('horizon-coordinator-integration: 5/5 PASS')
