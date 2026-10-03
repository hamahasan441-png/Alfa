#!/usr/bin/env node
/**
 * forge — boot shim (Phase 4). The installed `forge` command runs this file.
 *
 * Measured: most of forge's start-up time is Node compiling ~2 MB of source
 * (agent.js pulls in 114 modules). Node >= 22.1 can keep compiled code in an
 * on-disk cache; with it warm, importing the agent drops from ~160 ms to
 * ~120 ms on a 2-core box. The cache must be switched on BEFORE forge.js and
 * its imports are compiled, which is why this shim exists and is tiny.
 *
 * - Cache lives in <FORGE_HOME or ~/.forge>/compile-cache (forge's own data
 *   root). Node checks every entry against the source, so an edited file is
 *   simply recompiled — the cache can never run stale code.
 * - FORGE_COMPILE_CACHE=0 turns it off; an explicit NODE_COMPILE_CACHE wins.
 * - On Node < 22.1 (no enableCompileCache) this is a plain pass-through.
 */
import module from "node:module"
import os from "node:os"
import path from "node:path"

if (process.env.FORGE_COMPILE_CACHE !== "0" && !process.env.NODE_COMPILE_CACHE && typeof module.enableCompileCache === "function") {
  const root = String(process.env.FORGE_HOME || process.env.FORGE_DATA_DIR || "").trim() || path.join(os.homedir(), ".forge")
  try { module.enableCompileCache(path.join(root, "compile-cache")) } catch { /* a cache is an optimisation, never a reason to fail */ }
}
globalThis.__FORGE_ENTRY__ = true
await import("./forge.js")
