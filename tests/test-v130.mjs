import assert from 'node:assert/strict'
import { selectV4Depth, adaptiveBudget, buildV4Plan, nextPlanAction, rankContextItems, invalidateEvidence } from '../v4.js'

const t = (name, fn) => { try { fn(); console.log(`PASS ${name}`) } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1 } }

t('simple work selects FAST depth', () => assert.equal(selectV4Depth({ klass: 'SMALL', uncertainty: 0.1, impact: 0.1 }), 'FAST'))
t('uncertain medium work selects NORMAL depth', () => assert.equal(selectV4Depth({ klass: 'MEDIUM', uncertainty: 0.45, impact: 0.4 }), 'NORMAL'))
t('high-risk work selects DEEP depth', () => assert.equal(selectV4Depth({ klass: 'LARGE', uncertainty: 0.8, impact: 0.8 }), 'DEEP'))
t('conflicted architectural work selects ORCHESTRATED depth', () => assert.equal(selectV4Depth({ klass: 'ARCHITECTURAL', uncertainty: 0.9, impact: 0.9, conflict: true }), 'ORCHESTRATED'))
t('adaptive budget is bounded and monotonic', () => { const a = adaptiveBudget({ base: 20, complexity: .2 }); const b = adaptiveBudget({ base: 20, complexity: .8 }); assert.ok(a >= 20 && b >= a); assert.ok(b <= 200) })
t('plan creates dependency-aware nodes', () => { const p = buildV4Plan({ objective: 'fix router', steps: [{ id:'inspect' }, { id:'patch', dependsOn:['inspect'] }, { id:'verify', dependsOn:['patch'] }] }); assert.deepEqual(p.nodes.map(n=>n.id), ['inspect','patch','verify']); assert.deepEqual(p.nodes[1].dependsOn,['inspect']) })
t('planner only exposes ready nodes', () => { const p = buildV4Plan({ objective:'x', steps:[{id:'a'},{id:'b',dependsOn:['a']}] }); assert.equal(nextPlanAction(p).id,'a'); p.nodes[0].status='COMPLETED'; assert.equal(nextPlanAction(p).id,'b') })
t('context ranking prefers task-relevant evidence', () => { const r=rankContextItems('router timeout retry', [{id:'a',text:'database migration'},{id:'b',text:'router retry timeout provider'}]); assert.equal(r[0].id,'b') })
t('evidence touching changed files becomes stale', () => { const e=[{id:'E1',files:['a.js'],status:'VERIFIED'},{id:'E2',files:['b.js'],status:'VERIFIED'}]; const out=invalidateEvidence(e,['a.js']); assert.equal(out.find(x=>x.id==='E1').status,'STALE'); assert.equal(out.find(x=>x.id==='E2').status,'VERIFIED') })

import fs from 'node:fs'

t('V4 depth is wired into the live agent path', () => {
  const src = fs.readFileSync(new URL('../agent.js', import.meta.url), 'utf8')
  assert.match(src, /from "\.\/v4\.js"/)
  assert.match(src, /selectV4Depth\(/)
  assert.match(src, /V4_COGNITIVE_DEPTH/)
})
t('V4 plan gate is wired into autonomous planning', () => {
  const src = fs.readFileSync(new URL('../meta.js', import.meta.url), 'utf8')
  assert.match(src, /from "\.\/v4\.js"/)
  assert.match(src, /buildV4Plan\(/)
  assert.match(src, /V4_PLAN_VALIDATED/)
})
t('V4 module is shipped and its regression suite is registered', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const runner = fs.readFileSync(new URL('./run-all.mjs', import.meta.url), 'utf8')
  assert.ok(pkg.files.includes('v4.js'))
  assert.match(runner, /test-v130\.mjs/)
  assert.match(runner, /test-alpha-kernel\.mjs/)
})
