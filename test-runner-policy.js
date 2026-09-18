/**
 * Test-runner resource policy.
 *
 * Keeps the existing Forge process policy intact while giving npm test its own
 * stricter safety envelope. The test runner can be much more process-heavy than
 * a normal agent run because suites create PTYs, mock servers, MCP/LSP stubs and
 * child shells at the same time.
 */
import os from "node:os"

export const TEST_DEFAULT_PER_CHILD_MB = 220
export const TEST_HEADROOM_MB = 700
export const TEST_MAX_CONCURRENCY = 4
export const TEST_ANDROID_MAX_CONCURRENCY = 2

export function testConcurrency({ profile, requested = null, android = false, perChildMB = TEST_DEFAULT_PER_CHILD_MB, headroomMB = TEST_HEADROOM_MB } = {}) {
  const p = profile ?? {
    cores: os.cpus()?.length ?? 1,
    freeMB: 0,
    totalMB: Math.round(os.totalmem() / 1024 / 1024),
    tier: "normal",
  }
  const explicit = Number(requested)
  const byMemory = Math.max(1, Math.floor(Math.max(0, Number(p.freeMB) - headroomMB) / Math.max(1, perChildMB)))
  const byCore = Math.max(1, Number(p.cores || 1))
  let cap = Math.min(byMemory, byCore, TEST_MAX_CONCURRENCY)
  if (p.tier === "low") cap = 1
  if (android) cap = Math.min(cap, TEST_ANDROID_MAX_CONCURRENCY)
  // An explicit value remains useful, but it is now a REQUEST rather than a
  // promise to ignore the safety envelope. CI/desktop users can intentionally
  // bypass this with FORGE_TEST_UNSAFE_CONCURRENCY=1.
  if (Number.isFinite(explicit) && explicit > 0) cap = Math.min(Math.floor(explicit), cap)
  return Math.max(1, cap)
}

export function suiteTimeoutMs({ command = "node", env = process.env } = {}) {
  const explicit = Number(env.FORGE_SUITE_TIMEOUT_MS)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return command === "bash" ? 15 * 60 * 1000 : 120 * 1000
}

export function shouldForceUnsafeConcurrency(env = process.env) {
  return String(env.FORGE_TEST_UNSAFE_CONCURRENCY || "") === "1"
}
