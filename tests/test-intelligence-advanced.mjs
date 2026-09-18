import assert from 'node:assert/strict'
import {repositoryIntelligence,hypothesisExperiment,regressionSuite,synthesizeTestCases,consolidateMemory,multiAgentWaves} from '../intelligence-advanced.js'
const r=repositoryIntelligence({files:['src/a.js','src/b.js'],imports:[{from:'src/b.js',to:'src/a.js'}],objective:'src/a.js'})
assert.equal(r.edges.length,1); assert.ok(r.affected.includes('src/a.js'))
assert.equal(hypothesisExperiment({hypothesis:'x',expected:'pass',observations:['pass']}).decision,'CONTINUE')
assert.ok(regressionSuite({changedFiles:['src/a.js'],tests:[{id:'t',files:['src/a.js']},{id:'z',files:['x.js']}]}).selected.includes('t'))
assert.ok(synthesizeTestCases({requirements:['must reject'],edgeCases:['empty']}).cases.length===1)
assert.equal(consolidateMemory({episodes:[{key:'x',outcome:'PASS'},{key:'x',outcome:'FAIL'}]}).items[0].contradictions,true)
assert.deepEqual(multiAgentWaves({agents:['a','b','c'],dependencies:[{from:'a',to:'b'},{from:'b',to:'c'}]}).waves,[['a'],['b'],['c']])
console.log('intelligence-advanced: 6/6 PASS')
