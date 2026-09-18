import assert from 'node:assert/strict'
import { coordinateHorizon, HORIZON_COORDINATOR_VERSION } from '../horizon-coordinator.js'
const nodes=[{id:'a',priority:2,files:['src/a.js']},{id:'b',priority:1,files:['src/b.js'],dependencies:['a']},{id:'c',priority:1,files:['src/a.js']}]
let r=coordinateHorizon({nodes,agents:['tester','coder'],maxParallel:2})
assert.equal(r.version,HORIZON_COORDINATOR_VERSION); assert.deepEqual(r.waves[0].map(x=>x.nodeId),['a']); assert.equal(r.waves[0][0].agentId,'tester')
r=coordinateHorizon({nodes,completed:['a'],agents:['tester','coder'],maxParallel:2}); assert.ok(r.ready.includes('b')); assert.ok(!r.waves[0].some(x=>x.nodeId==='c' && x.nodeId==='b'))
assert.ok(r.waves[0].length<=2); assert.equal(r.advisory,true)
console.log('horizon-coordinator: 4/4 PASS')
