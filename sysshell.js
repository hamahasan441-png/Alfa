/**
 * forge — resolved shell path (v94 knowwise: Termux/NetHunter readiness)
 *
 * Every shell forge used to spawn was hardcoded "/bin/sh", which does not
 * exist on Termux (prefix /data/data/com.termux/files/usr). On such systems
 * EVERY model bash call, background process, and typed `!` line ENOENTed.
 * One resolver, every spawn site:
 *
 *   1. FORGE_SHELL env — explicit override, returned verbatim (owner knows)
 *   2. /bin/sh — every normal Linux/CI/NetHunter-proot (unchanged default)
 *   3. $PREFIX/bin/sh — Termux
 *   4. $SHELL — last absolute fallback
 *   5. "sh" — PATH-resolved last resort
 *
 * Zero imports beyond node builtins (leaf module: importable from sandbox,
 * tools, runtime, chat, forge without cycles). Never throws.
 */
import { loadBuiltin } from "./lazybuiltin.js"
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
import path from "node:path"

function exists(p) {
  try { return typeof p === "string" && p.length > 0 && fs.existsSync(p) } catch { return false }
}

/**
 * Pure selection logic (unit-testable without touching the real fs):
 *   1. env.FORGE_SHELL — explicit override, verbatim (owner knows best)
 *   2. /bin/sh — every normal Linux/CI/NetHunter-proot (unchanged default)
 *   3. env.PREFIX + /bin/sh — Termux
 *   4. env.SHELL — last absolute fallback
 *   5. "sh" — PATH-resolved last resort
 */
export function pickShell(env, existsFn = exists) {
  const forced = env?.FORGE_SHELL
  if (forced) return forced
  if (existsFn("/bin/sh")) return "/bin/sh"
  const prefix = env?.PREFIX
  if (prefix && existsFn(path.join(prefix, "bin", "sh"))) return path.join(prefix, "bin", "sh")
  if (env?.SHELL && existsFn(env.SHELL)) return env.SHELL
  return "sh"
}

export function resolveShell() {
  return pickShell(process.env, exists)
}

/**
 * V5 — bash, when there is one. Only for reading a pipeline's per-stage
 * exit codes (PIPESTATUS) — the command itself still runs in the resolved
 * shell. null on a system without bash (dash-only, busybox), where the
 * caller must say the check's own status is unknown instead of guessing.
 */
export function pickBash(env, existsFn = exists) {
  for (const p of ["/bin/bash", "/usr/bin/bash", env?.PREFIX ? path.join(env.PREFIX, "bin", "bash") : null]) {
    if (p && existsFn(p)) return p
  }
  return null
}

export function resolveBash() {
  return pickBash(process.env, exists)
}
