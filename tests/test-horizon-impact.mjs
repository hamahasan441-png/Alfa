import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { impactFromChangedFiles } from '../intelligence-expansion.js'
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forge-impact-'))
fs.writeFileSync(path.join(cwd,'a.js'),'export const a=1\n')
fs.writeFileSync(path.join(cwd,'b.js'),"import {a} from './a.js'; export const b=a\n")
const r=impactFromChangedFiles(cwd,['a.js'])
assert.deepEqual(r.changed,['a.js'])
assert.ok(r.impact.some(x=>x.path==='b.js'),'changed file should expose dependent impact')
const empty=impactFromChangedFiles(cwd,[])
assert.deepEqual(empty.impact,[])
console.log('horizon-impact: 3/3 PASS')
