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
assert.equal(redactSecrets("token sk-abcdef0123456789"), "token sk-abcdef0123456789")
assert.equal(fenceEnabled({}, offEnv), false)

const prodEnv = { NODE_ENV: "production", FORGE_SECURITY_MODE: "off" }
process.env.NODE_ENV = prodEnv.NODE_ENV
process.env.FORGE_SECURITY_MODE = prodEnv.FORGE_SECURITY_MODE
assert.equal(securityMode({}, prodEnv).mode, "on")
assert.equal(securityEnabled({}, prodEnv), true)
assert.match(redactSecrets("token sk-abcdef0123456789").text, /redacted|\*\*\*/i)
assert.equal(fenceEnabled({}, prodEnv), true)

console.log("== security mode: 6 passed, 0 failed ==")
