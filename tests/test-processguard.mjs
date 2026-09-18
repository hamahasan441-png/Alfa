import assert from 'node:assert/strict'
import {shutdownPlan,classifyExit} from '../processguard.js'
assert.deepEqual(shutdownPlan({reason:'timeout'}).signals,['SIGTERM','SIGKILL'])
assert.deepEqual(shutdownPlan({reason:'external-kill'}).signals,['SIGKILL'])
assert.equal(classifyExit({timedOut:true}).kind,'TIMEOUT')
assert.equal(classifyExit({cancelled:true}).kind,'CANCELLED')
assert.equal(classifyExit({signal:'SIGKILL'}).kind,'KILLED')
assert.equal(classifyExit({code:0}).kind,'SUCCESS')
assert.equal(classifyExit({code:1}).kind,'EXIT_FAILURE')
console.log('processguard: 7/7 PASS')
