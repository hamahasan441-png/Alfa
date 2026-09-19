/**
 * Forge V4 retry policy.
 *
 * This module is deliberately deterministic and side-effect free except for
 * the controller's in-memory state. It governs repair/retry attempts; provider
 * transport retries remain owned by providers.js.
 *
 * Rules:
 *  - every attempt belongs to a node + strategy fingerprint;
 *  - a failed strategy is not admitted again unchanged;
 *  - total failures are bounded by maxRetries;
 *  - backoff is exponential and capped;
 *  - success closes the circuit and clears the failure streak for that node;
 *  - history is bounded so the controller cannot become a memory leak.
 */
import crypto from "node:crypto"

export const RETRY_STATE = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN" })

function clean(value, max = 600) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max)
}

export function fingerprintStrategy({ nodeId = null, reason = "", strategy = "", experiment = "", command = "" } = {}) {
  const material = [nodeId, reason, strategy, experiment, command].map((v) => clean(v, 500)).join("\n")
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16)
}

/** A backoff wait that Ctrl+C can interrupt (v124).
 *
 *  Both retry loops on the hot path slept with a bare
 *  `new Promise((r) => setTimeout(r, wait))`, which ignores the abort signal
 *  that is in scope two lines above it. The request itself was abortable; the
 *  WAIT BETWEEN requests was not, so a cancel landing during a backoff sat
 *  there until the timer expired. Measured against a local server answering
 *  429 with `Retry-After: 5`: abort at 300ms, loop exited at 8047ms. The agent
 *  loop's own backoff is clamped at 60s, so its worst case is a minute of a
 *  cancelled run still holding the terminal.
 *
 *  Resolves on whichever comes first, removes its listener either way (a retry
 *  loop must not leak one per attempt), and never throws — the caller decides
 *  what an abort means, which for both callers is "stop retrying".
 */
export function sleepAbortable(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0)
  if (!signal) return new Promise((r) => setTimeout(r, wait))
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      try { signal.removeEventListener("abort", done) } catch {}
      resolve()
    }
    const timer = setTimeout(done, wait)
    try { signal.addEventListener("abort", done, { once: true }) } catch { /* not an AbortSignal */ }
  })
}

export function backoffDelay(failureIndex = 0, { baseMs = 1000, maxMs = 30000 } = {}) {
  const base = Math.max(0, Number(baseMs) || 0)
  const cap = Math.max(base, Number(maxMs) || base)
  const index = Math.max(0, Math.floor(Number(failureIndex) || 0))
  return Math.min(cap, base * (2 ** index))
}

export function createRetryController({ maxRetries = 3, baseMs = 1000, maxBackoffMs = 30000, maxHistory = 32, snapshot = null } = {}) {
  const limit = Math.max(0, Math.floor(Number(maxRetries) || 0))
  const historyLimit = Math.max(1, Math.floor(Number(maxHistory) || 1))
  const nodes = new Map()
  const history = []

  // Crash/resume: restore only bounded controller state produced by snapshot().
  // Invalid/foreign state is ignored rather than becoming executable policy.
  if (snapshot && typeof snapshot === "object") {
    try {
      for (const item of Array.isArray(snapshot.nodes) ? snapshot.nodes.slice(-historyLimit) : []) {
        const key = clean(item?.nodeId || "task", 200)
        nodes.set(key, {
          failures: Math.max(0, Math.floor(Number(item?.failures) || 0)),
          lastStrategy: item?.lastStrategy ? String(item.lastStrategy).slice(0, 64) : null,
          failedStrategies: new Set(Array.isArray(item?.failedStrategies) ? item.failedStrategies.map(String).slice(0, 64) : []),
          state: item?.state === RETRY_STATE.OPEN ? RETRY_STATE.OPEN : RETRY_STATE.CLOSED,
          successCount: Math.max(0, Math.floor(Number(item?.successCount) || 0)),
          lastAdmitted: item?.lastAdmitted ? String(item.lastAdmitted).slice(0, 64) : null,
        })
      }
      for (const item of Array.isArray(snapshot.history) ? snapshot.history.slice(-historyLimit) : []) {
        if (item && typeof item === "object") history.push({ ...item })
      }
    } catch {
      nodes.clear(); history.length = 0
    }
  }

  function nodeKey(nodeId) { return clean(nodeId || "task", 200) }
  function stateFor(nodeId) {
    const key = nodeKey(nodeId)
    if (!nodes.has(key)) nodes.set(key, { failures: 0, lastStrategy: null, failedStrategies: new Set(), state: RETRY_STATE.CLOSED, successCount: 0, lastAdmitted: null })
    return nodes.get(key)
  }
  function pushHistory(item) {
    history.push({ at: Date.now(), ...item })
    while (history.length > historyLimit) history.shift()
  }

  return {
    admit({ nodeId = null, strategy = "", reason = "", experiment = "", command = "" } = {}) {
      const key = nodeKey(nodeId)
      const s = stateFor(key)
      const fp = fingerprintStrategy({ nodeId: key, reason, strategy, experiment, command })
      if (s.failures >= limit) {
        s.state = RETRY_STATE.OPEN
        const result = { allowed: false, state: RETRY_STATE.OPEN, reason: "retry budget exhausted", fingerprint: fp, failures: s.failures, maxRetries: limit, backoffMs: 0 }
        pushHistory({ type: "ADMIT_REJECTED", nodeId: key, ...result })
        return result
      }
      if (s.failedStrategies.has(fp)) {
        s.state = RETRY_STATE.OPEN
        const result = { allowed: false, state: RETRY_STATE.OPEN, reason: "strategy already failed; choose a different strategy", fingerprint: fp, failures: s.failures, maxRetries: limit, backoffMs: 0 }
        pushHistory({ type: "ADMIT_REJECTED", nodeId: key, ...result })
        return result
      }
      const delay = s.failures > 0 ? backoffDelay(s.failures - 1, { baseMs, maxMs: maxBackoffMs }) : 0
      s.state = RETRY_STATE.CLOSED
      s.lastAdmitted = fp
      const result = { allowed: true, state: RETRY_STATE.CLOSED, reason: "admitted", fingerprint: fp, failures: s.failures, maxRetries: limit, backoffMs: delay }
      pushHistory({ type: "ADMIT", nodeId: key, ...result })
      return result
    },

    record({ nodeId = null, strategy = "", reason = "", experiment = "", command = "", fingerprint = null, ok = false } = {}) {
      const key = nodeKey(nodeId)
      const s = stateFor(key)
      const fp = fingerprint || s.lastAdmitted || fingerprintStrategy({ nodeId: key, reason, strategy, experiment, command })
      if (ok) {
        s.lastStrategy = fp
        s.state = RETRY_STATE.CLOSED
        s.successCount += 1
        s.failures = 0
        s.failedStrategies.clear()
        s.lastAdmitted = null
        pushHistory({ type: "SUCCESS", nodeId: key, fingerprint: fp, failures: 0 })
        return { state: RETRY_STATE.CLOSED, failures: 0, fingerprint: fp }
      }
      s.failures += 1
      s.lastStrategy = fp
      s.failedStrategies.add(fp)
      s.state = s.failures >= limit ? RETRY_STATE.OPEN : RETRY_STATE.CLOSED
      const result = { state: s.state, failures: s.failures, maxRetries: limit, fingerprint: fp }
      pushHistory({ type: "FAILURE", nodeId: key, ...result })
      return result
    },

    snapshot() {
      return {
        version: 1,
        nodes: [...nodes.entries()].map(([nodeId, s]) => ({ nodeId, failures: s.failures, lastStrategy: s.lastStrategy, lastAdmitted: s.lastAdmitted, failedStrategies: [...s.failedStrategies], state: s.state, successCount: s.successCount })),
        history: history.slice(),
      }
    },
  }
}
