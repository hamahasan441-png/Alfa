#!/usr/bin/env node
/**
 * forge supervisor — a deliberately small external parent for long-running Forge runs.
 *
 * SIGKILL cannot be caught by Forge itself. This process therefore owns the child,
 * watches its exit status, applies bounded restart/backoff, and leaves the existing
 * checkpoint/recovery system authoritative. It never claims that a restart means a
 * task succeeded.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resourceProfile, isAndroid, readAvailableMB } from "./profile.js"
import { withStateFileLock } from "./securefs.js"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const FORGE = path.join(ROOT, "forge.js")
const MAX_RESTARTS = Math.max(0, Number(process.env.FORGE_SUPERVISOR_MAX_RESTARTS || 3))
const BASE_BACKOFF_MS = Math.max(250, Number(process.env.FORGE_SUPERVISOR_BACKOFF_MS || 1500))
const MIN_FREE_MB = Math.max(256, Number(process.env.FORGE_SUPERVISOR_MIN_FREE_MB || 700))

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function statePath(cwd) {
  return path.join(cwd, ".forge", "supervisor-state.json")
}
function writeState(cwd, state) {
  const file = statePath(cwd)
  withStateFileLock(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
      fs.renameSync(tmp, file)
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  })
}
function classifyExit(result) {
  if (result.signal === "SIGKILL" || result.signal === "SIGTERM" || result.signal === "SIGHUP") return result.signal
  if (result.code == null) return "UNKNOWN"
  return result.code === 0 ? "EXIT_0" : `EXIT_${result.code}`
}
function forgeArgs(argv) {
  if (!argv.length) return ["agent", "--help"]
  if (argv[0] === "--") return argv.slice(1)
  return argv
}

export function supervisorPolicy({ restarts = 0, profile = resourceProfile(), availableMB = readAvailableMB() } = {}) {
  const pressure = Number(availableMB) < MIN_FREE_MB
  const android = isAndroid()
  const delay = BASE_BACKOFF_MS * Math.min(8, 2 ** Math.min(restarts, 3))
  return {
    pressure,
    android,
    availableMB: Number(availableMB),
    cores: profile.cores,
    delayMs: delay,
    maxRestarts: MAX_RESTARTS,
    nextConcurrency: pressure || android ? 1 : Math.max(1, Math.min(2, profile.cores - 1)),
  }
}

export async function supervise(argv, { cwd = process.cwd(), env = process.env, spawnFn = spawn, waitForRecovery = sleep } = {}) {
  const args = forgeArgs(argv)
  let restarts = 0
  let last = null
  const startedAt = Date.now()
  while (true) {
    const profile = resourceProfile()
    const policy = supervisorPolicy({ restarts, profile })
    if (policy.pressure) await waitForRecovery(policy.delayMs)

    const childEnv = {
      ...env,
      FORGE_SUPERVISED: "1",
      FORGE_RESTART_COUNT: String(restarts),
      FORGE_RESOURCE_CONCURRENCY: String(policy.nextConcurrency),
    }
    writeState(cwd, {
      version: 1,
      pid: process.pid,
      childPid: null,
      status: "starting",
      restarts,
      command: [process.execPath, FORGE, ...args],
      updatedAt: new Date().toISOString(),
      resource: policy,
    })

    const child = spawnFn(process.execPath, [FORGE, ...args], {
      cwd,
      env: childEnv,
      stdio: "inherit",
      windowsHide: false,
    })
    writeState(cwd, {
      version: 1,
      pid: process.pid,
      childPid: child.pid ?? null,
      status: "running",
      restarts,
      command: [process.execPath, FORGE, ...args],
      updatedAt: new Date().toISOString(),
      resource: policy,
    })

    last = await new Promise(resolve => {
      child.once("error", error => resolve({ code: null, signal: null, error: String(error?.message || error) }))
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    const reason = classifyExit(last)
    writeState(cwd, {
      version: 1,
      pid: process.pid,
      childPid: child.pid ?? null,
      status: "exited",
      restarts,
      reason,
      code: last.code,
      signal: last.signal,
      command: [process.execPath, FORGE, ...args],
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      resource: policy,
    })

    if (last.code === 0) return { ok: true, restarts, reason }
    if (restarts >= MAX_RESTARTS) return { ok: false, restarts, reason, exhausted: true }
    restarts++
    const next = supervisorPolicy({ restarts, profile: resourceProfile() })
    await waitForRecovery(next.delayMs)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await supervise(process.argv.slice(2))
  if (result.exhausted) console.error(`forge supervisor: restart budget exhausted after ${result.restarts} restart(s); last=${result.reason}`)
  else if (result.restarts) console.error(`forge supervisor: recovered after ${result.restarts} restart(s); final=${result.reason}`)
  process.exit(result.ok ? 0 : 1)
}
