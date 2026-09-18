/** Forge V4 Phase 2 — newline-delimited JSON-RPC over a Python child stdin/stdout. */
import { spawn } from "node:child_process"

export function jsonRpcRequest(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method: String(method), params: params && typeof params === "object" ? params : {} }
}

export function parseJsonRpcLine(line) {
  const text = String(line ?? "").trim()
  if (!text) return null
  let msg
  try { msg = JSON.parse(text) } catch { return { ok: false, error: "invalid JSON-RPC line", raw: text.slice(0, 400) } }
  if (!msg || msg.jsonrpc !== "2.0") return { ok: false, error: "invalid JSON-RPC version", raw: text.slice(0, 400) }
  if (msg.id === undefined && msg.method) return { ok: true, kind: "notification", message: msg }
  if (msg.error) return { ok: true, kind: "error", message: msg }
  return { ok: true, kind: "response", message: msg }
}

export function runPythonJsonRpc({ python, script, cwd, env = process.env, request, timeoutMs = 120000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!python || !script) return reject(new Error("python and script are required"))
    const child = spawn(python, ["-u", script], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = "", buffer = "", settled = false
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch {}
      finish(new Error(`python JSON-RPC timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.("abort", onAbort)
      if (err) reject(err); else resolve(value)
    }
    const onAbort = () => { try { child.kill("SIGTERM") } catch {}; finish(new Error("python JSON-RPC cancelled")) }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener?.("abort", onAbort, { once: true })
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        const parsed = parseJsonRpcLine(line)
        if (parsed) {
          if (!Array.isArray(stdout)) stdout = []
          stdout.push(parsed)
        }
      }
    })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (e) => finish(e))
    child.on("close", (code, sig) => {
      if (settled) return
      if (buffer.trim()) {
        const parsed = parseJsonRpcLine(buffer)
        if (parsed) {
          if (!Array.isArray(stdout)) stdout = []
          stdout.push(parsed)
        }
      }
      const messages = Array.isArray(stdout) ? stdout : []
      const response = messages.find((m) => m.kind === "response" || m.kind === "error")?.message ?? null
      if (code !== 0 && !response) return finish(new Error(`python exited with code ${code}${sig ? ` (${sig})` : ""}: ${stderr.trim().slice(0, 400)}`))
      finish(null, { ok: !messages.some((m) => m.kind === "error") && code === 0, code, signal: sig, response, messages, stderr: stderr.trim() })
    })
    try { child.stdin.write(JSON.stringify(request) + "\n"); child.stdin.end() } catch (e) { finish(e) }
  })
}
