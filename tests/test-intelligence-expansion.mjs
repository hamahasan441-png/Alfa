#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyzeRepository, adaptivePlan, failureIntelligence, adversarialReview, composeStrategy, saveExpansionSnapshot } from "../intelligence-expansion.js"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-intel-"))
fs.mkdirSync(path.join(root, "src"), { recursive: true })
fs.writeFileSync(path.join(root, "src", "api.js"), 'export function saveUser(user) { return db.insert(user) }\nimport { db } from "./db.js"\n')
fs.writeFileSync(path.join(root, "src", "db.js"), 'export const db = { insert(x) { return x } }\n')
fs.writeFileSync(path.join(root, "src", "api.test.js"), 'import { saveUser } from "./api.js"\ntest("saveUser", () => saveUser({id:1}))\n')

const repo = analyzeRepository(root, "saveUser api")
assert.ok(Array.isArray(repo.matches))
assert.ok(repo.matches.some(x => x.path.endsWith("api.js")))
assert.ok(Array.isArray(repo.impact))

const plan = adaptivePlan({ objective: "implement saveUser API", repo })
assert.equal(plan.plan.at(0).readOnly, true)
assert.equal(plan.plan.at(-1).role, "tester")
assert.equal(plan.plan.at(-1).readOnly, true)
assert.equal(plan.critique.findings.some(f => f.id === "no_verification_step"), false)

const fi = failureIntelligence("ERROR: command timed out", { tool: "bash", idempotent: true }, [{ code: "TIMEOUT" }])
assert.equal(fi.diagnosis.code, "TIMEOUT")
assert.equal(fi.repeated, true)
assert.ok(fi.strategy.strategies.length > 0)

const review = adversarialReview({ objective: "implement saveUser", report: "implemented saveUser", toolCalls: 3, evidenceCount: 0, verification: "passed", ok: true })
assert.equal(review.ok, false)
assert.ok(review.findings.length > 0)

const composed = composeStrategy({ cwd: root, objective: "saveUser", repo, candidates: [{id:"inspect", text:"inspect api"},{id:"unrelated", text:"format docs"}] })
assert.equal(composed.candidates[0].id, "inspect")
const snap = saveExpansionSnapshot(root, { repo, plan })
assert.ok(snap && fs.existsSync(snap))

console.log("intelligence-expansion: 7/7 passed")
