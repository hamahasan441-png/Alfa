/**
 * forge — a Node built-in loaded on first use, synchronously (v179).
 *
 * node:zlib costs ~9ms to load, and every agent run paid it at boot for code
 * that compresses a checkpoint backup or inflates a downloaded archive — work
 * most runs never do. netlazy.js defers the network stack, but its loads are
 * async; these call sites are synchronous (gzipSync, inflateRawSync), so this
 * loads the built-in with require, which is synchronous for built-ins on every
 * Node forge supports. Call sites keep their shape: `zlib.gzipSync(...)`.
 */
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export function lazyBuiltin(name) {
  let mod = null
  return new Proxy({}, {
    get(_, key) {
      mod ??= require(name)
      const v = mod[key]
      return typeof v === "function" ? v.bind(mod) : v
    },
    has(_, key) { mod ??= require(name); return key in mod },
  })
}
