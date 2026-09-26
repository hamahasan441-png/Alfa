/**
 * forge — Node's on-disk compile cache for forge's own modules (v179).
 *
 * Nearly all of an agent run's boot is Node compiling forge's ~100 modules
 * (measured: 137ms of 157ms in node's module loader, the code itself barely
 * registers). Node 22 can keep the compiled code on disk
 * (module.enableCompileCache); a later boot reads it instead of compiling
 * again. The first run after an install or upgrade fills it.
 *
 * One helper, used by forge.js at startup and by `forge bench` to measure
 * boot the way forge boots. It must run BEFORE the modules it should cover
 * are loaded: forge.js loads the agent, chat and tool graphs lazily, after
 * this call. Older Node without the API, a read-only home, or
 * FORGE_NO_COMPILE_CACHE=1: nothing happens — it only ever makes boot faster.
 */
import module from "node:module"
import path from "node:path"
import fs from "node:fs"

/**
 * Enable the cache in `<root>/<version>`. Node never prunes a compile cache,
 * and every upgrade changes forge's sources — so the entries of any OTHER
 * version under `root` are removed (the cost of a forgotten folder is what
 * v174 just cleaned up in ~/.forge/projects; this one must not become it).
 */
export function enableBootCache({ root, version } = {}) {
  if (process.env.FORGE_NO_COMPILE_CACHE === "1" || !root || typeof module.enableCompileCache !== "function") return null
  const tag = String(version ?? "current").replace(/[^\w.-]/g, "_")
  const dir = path.join(path.resolve(root), tag)
  try {
    for (const e of fs.readdirSync(root)) if (e !== tag && /^[\w.-]+$/.test(e)) fs.rmSync(path.join(root, e), { recursive: true, force: true })
  } catch { /* no cache yet, or not removable — never a reason to fail */ }
  try {
    const r = module.enableCompileCache(dir)
    return r?.directory ?? null
  } catch { return null } // a cache must never stop forge from starting
}
