#!/usr/bin/env node
import assert from "node:assert/strict"
const { securityMode, securityEnabled } = await import("../security-mode.js")
const { redactSecrets } = await import("../secrets.js")
const { fenceEnabled } = await import("../contentfence.js")

const offEnv = { NODE_ENV: "development", FORGE_SECURITY_MODE: "off" }
process.env.NODE_ENV = offEnv.NODE_ENV
process.env.FORGE_SECURITY_MODE = offEnv.FORGE_SECURITY_MODE
assert.equal(securityMode({}, offEnv).mode, "off")
assert.equal(securityEnabled({}, offEnv), false)
// v130: redactSecrets ALWAYS returns { text, found }. It used to return a bare
// string when security was off — and this file pinned that, while asserting
// `.text` for the on-case twelve lines below. That inconsistency was the bug:
// codereview.js and childenv.js both read `.found`, got undefined, and silently
// stopped detecting secrets whenever security was off.
// Off means the redaction is not APPLIED. The count is still true.
{
  const off = redactSecrets("token sk-abcdef0123456789")
  assert.equal(typeof off, "object")
  assert.equal(off.text, "token sk-abcdef0123456789")   // nothing was redacted
  assert.equal(off.found, 1)                            // but it was still seen
}
assert.equal(fenceEnabled({}, offEnv), false)

const prodEnv = { NODE_ENV: "production", FORGE_SECURITY_MODE: "off" }
process.env.NODE_ENV = prodEnv.NODE_ENV
process.env.FORGE_SECURITY_MODE = prodEnv.FORGE_SECURITY_MODE
assert.equal(securityMode({}, prodEnv).mode, "on")
assert.equal(securityEnabled({}, prodEnv), true)
{
  const on = redactSecrets("token sk-abcdef0123456789")
  assert.match(on.text, /redacted|\*\*\*/i)             // redaction applied
  assert.equal(on.found, 1)                             // same count, both modes
}
assert.equal(fenceEnabled({}, prodEnv), true)

// v130 — the two callers that went blind. Both read `.found`; both got
// `undefined` when security was off, and `undefined > 0` is false, so neither
// threw and neither reported. This is the regression test for the DEFECT, not
// just for the return shape.
{
  process.env.NODE_ENV = "development"
  process.env.FORGE_SECURITY_MODE = "off"
  const { deterministicFindings } = await import("../codereview.js")
  const det = deterministicFindings({
    files: [{
      file: "a.js", lang: "javascript", added: 30, removed: 2, diagCount: 0,
      diff: "+const K = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccc'\n",
    }],
    totalAdded: 30, totalRemoved: 2, diagnostics: [], ledgerFailures: [],
  })
  assert.ok(det.some((f) => f.id === "secret_in_code" && f.severity === "blocker"),
    "code review must flag a committed secret even with security off")

  const { childEnv } = await import("../childenv.js")
  const env = childEnv({}, { HARMLESS: "just a value", SOMEVAR: "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccc" })
  assert.equal(env.HARMLESS, "just a value", "an ordinary value still reaches the child")
  assert.equal(env.SOMEVAR, undefined, "a secret-SHAPED value must not reach a helper process")

  // and the developer's explicit declaration is still honoured — this must not
  // become a restriction the owner cannot override
  const declared = childEnv({ SOMEVAR: "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccc" }, {})
  assert.equal(typeof declared.SOMEVAR, "string", "a DECLARED variable is always passed through")
}

console.log("== security mode: secret detection survives security-off ==")

console.log("== security mode: 14 passed, 0 failed ==")
