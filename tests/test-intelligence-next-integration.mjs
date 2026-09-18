import assert from 'node:assert/strict'
import { createCognition } from '../cognition.js'
const c=createCognition({cwd:process.cwd(),objective:'implement feature and verify it'})
const s=c.boot()
assert.equal(s.intelligenceNext.version,'1.0.0')
assert.ok(s.intelligenceNext.meta)
assert.ok(Array.isArray(s.intelligenceNext.horizon.frontier))
assert.equal(s.intelligenceNext.testProposals.executable,false)
assert.equal(s.intelligenceNext.strategy.selected,null)
assert.equal(s.intelligenceNext.agents.singleWriter,true)
assert.ok(s.events.some(e=>e.type==='NEXT_INTELLIGENCE_READY'))
console.log('intelligence-next integration: 7/7 PASS')
