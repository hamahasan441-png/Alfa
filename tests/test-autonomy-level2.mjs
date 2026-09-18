#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decomposeTask, compressContext, counterfactualStrategies, resourceSchedule, impactAwareVerification, buildLevel2Brief } from "../autonomy-level2.js"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-l2-"))
fs.mkdirSync(path.join(root, "src"), { recursive: true })
fs.writeFileSync(path.join(root, "src", "a.js"), 'import { b } from "./b.js"; export const a=b\n')
fs.writeFileSync(path.join(root, "src", "b.js"), 'export const b=1\n')
fs.writeFileSync(path.join(root, "src", "a.test.js"), 'import {a} from "./a.js"; test("a",()=>a)\n')

const d = decomposeTask("inspect the API; update implementation; run tests")
assert.equal(d.nodes.length, 3)
assert.deepEqual(d.nodes[1].dependencies, ["l2-1"])
const c = compressContext("goal\nrandom\nTEST verification evidence\nrandom2", { maxChars: 24 })
assert.equal(c.truncated, true)
assert.match(c.text, /TEST|verification|evidence/i)
assert.equal(counterfactualStrategies({ risk: "high" }).candidates.length, 5)
const s = resourceSchedule({ roles: ["researcher", "tester", "coder"], maxParallel: 2 })
assert.deepEqual(s.serialized, ["coder"])
assert.equal(s.singleWriter, true)
const v = impactAwareVerification({ cwd: root, files: [path.join(root, "src", "a.js")], risk: "low" })
assert.ok(v.blast.radius >= 1)
const brief = buildLevel2Brief({ cwd: root, objective: "update api and tests", files: [path.join(root, "src", "a.js")], context: "verification evidence" })
assert.equal(brief.version, "1.0.0")
assert.equal(brief.schedule.singleWriter, true)
console.log("autonomy-level2: 6/6 passed")
