#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createVerificationEvidence, EVIDENCE_STATUS } from '../verification-evidence.js'
import { createGoalContract } from '../goal-contract.js'
import { calibrationMetrics, appendCalibration } from '../prediction-calibration.js'

let pass=0
function ok(name, fn){ try{fn();pass++;console.log('  ok   '+name)}catch(e){console.log('  FAIL '+name+' '+e.message);process.exitCode=1} }

console.log('== structured verification evidence ==')
ok('requirement binding',()=>{ const e=createVerificationEvidence({taskId:'t'}); assert.equal(e.bindRequirement({requirementId:'R1',text:'tests pass',kind:'test',affectedFiles:['src/a.js']}).ok,true) })
ok('pass evidence covers requirement',()=>{ const e=createVerificationEvidence(); e.bindRequirement({requirementId:'R1',text:'tests pass',kind:'test',affectedFiles:['src/a.js']}); e.record({kind:'test',passed:true,exitCode:0,exitCodeKnown:true,affectedFiles:['src/a.js'],requirementIds:['R1']}); assert.equal(e.verdict({changedFiles:['src/a.js']}).ok,true) })
ok('unrelated evidence does not cover',()=>{ const e=createVerificationEvidence(); e.bindRequirement({requirementId:'R1',text:'auth',kind:'test',affectedFiles:['src/auth.js']}); e.record({kind:'test',passed:true,exitCode:0,exitCodeKnown:true,affectedFiles:['src/parser.js'],requirementIds:['R1']}); assert.equal(e.verdict({changedFiles:['src/auth.js']}).ok,false) })
ok('stale evidence is rejected after mutation',()=>{ const e=createVerificationEvidence(); e.bindRequirement({requirementId:'R1',text:'a',kind:'test',affectedFiles:['src/a.js']}); e.record({kind:'test',passed:true,exitCode:0,exitCodeKnown:true,affectedFiles:['src/a.js'],requirementIds:['R1']}); e.invalidate(['src/a.js']); assert.equal(e.verdict({changedFiles:['src/a.js']}).ok,false); assert.equal(e.records()[0].status,EVIDENCE_STATUS.STALE) })
ok('failed evidence blocks',()=>{ const e=createVerificationEvidence(); e.bindRequirement({requirementId:'R1',text:'a',kind:'test',affectedFiles:['src/a.js']}); e.record({kind:'test',passed:false,exitCode:1,exitCodeKnown:true,affectedFiles:['src/a.js'],requirementIds:['R1']}); assert.equal(e.verdict({changedFiles:['src/a.js']}).status,'FAILED') })

console.log('== semantic goal contract ==')
ok('same goal has no drift',()=>{ const g=createGoalContract('preserve security and run tests'); assert.equal(g.compare('preserve security and run tests').semanticDrift,0) })
ok('dropped constraint is surfaced',()=>{ const g=createGoalContract('must preserve security and run tests'); const r=g.revise('run tests'); assert.ok(r.droppedConstraints.length>0) })
ok('large semantic change is high',()=>{ const g=createGoalContract('refactor parser module safely'); const r=g.compare('deploy a mobile app'); assert.equal(r.level,'HIGH') })

console.log('== prediction calibration ==')
ok('brier and ECE are deterministic',()=>{ const m=calibrationMetrics([{confidence:.9,correct:true},{confidence:.9,correct:false},{confidence:.1,correct:false},{confidence:.1,correct:false}]); assert.equal(m.samples,4); assert.ok(m.brier>0); assert.ok(m.ece>0) })
ok('append calibration is bounded',()=>{ let s=[]; s=appendCalibration(s,{id:'p',confidence:.8,expectedOutcome:'advance'},'advance'); assert.equal(s.length,1); assert.equal(s[0].correct,true) })
console.log(`== v122.2 evidence/goal suite: ${pass} passed ==`)
