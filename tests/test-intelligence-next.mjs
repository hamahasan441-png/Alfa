import assert from 'node:assert/strict'
import {metaReason,longHorizonPlan,regressionRisk,generateTests,edgeCases,selectStrategy,memoryConsolidate,multiAgentSchedule,benchmarkMatrix} from '../intelligence-next.js'
const m=metaReason({objective:'fix bug',failures:['error'],constraints:['must pass tests']}); assert.equal(m.mode,'investigate')
const h=longHorizonPlan({nodes:[{id:'a'},{id:'b',deps:['a']}]}); assert.deepEqual(h.frontier,['a']);
assert.equal(regressionRisk({changedFiles:['src/a.js'],historicalFailures:['src/a.js']}).level,'LOW')
assert.equal(generateTests({requirements:['must reject invalid input']}).tests.length,1)
assert.ok(edgeCases({constraints:['permission']}).cases.includes('unauthorized input'))
assert.equal(selectStrategy({candidates:[{id:'x',strategy:'test',confidence:1}],evidence:['test']}).selected,null)
assert.equal(memoryConsolidate({episodes:[{key:'x',v:1},{key:'x',v:2}]}).episodes.length,1)
assert.deepEqual(multiAgentSchedule({agents:['a','b'],dependencies:[{from:'a',to:'b'}]}).ready,['a'])
assert.ok(benchmarkMatrix().categories.includes('real-agent-e2e'))
console.log('intelligence-next: 9/9 PASS')
