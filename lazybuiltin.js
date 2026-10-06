/**
 * forge — Node built-ins loaded on first use, synchronously.
 *
 * WHY (measured at 178.x, best-of-11, fresh process): importing agent.js
 * took ~152 ms against a 24 ms bare node, over the 120 ms boot budget. A CPU
 * profile put the time in compiling forge's source and in loading built-ins.
 * Five built-ins were imported at module scope by ~40 files on that path:
 *
 *     node:child_process   14 ms   (it also pulls in net, dgram and stream)
 *     node:crypto          13.5 ms
 *     node:zlib            10 ms
 *     node:module           3 ms
 *     together            ~25 ms
 *
 * and an ordinary run uses most of them only when it hashes a file, spawns a
 * command or reads an archive — later, or never. v134 (netlazy.js) did the
 * same for the network stack, but with an async loader; these are called from
 * synchronous code all over, so this loader is synchronous:
 * `process.getBuiltinModule` (Node >= 20.16 / 22.3) returns a built-in on the
 * spot. On an older Node, the built-ins are imported up front, as before —
 * nothing breaks there; it is just not faster.
 *
 * Two shapes cover every import forge had:
 *
 *   import crypto from "node:crypto"        →  const crypto = lazyBuiltin("crypto")
 *   import { spawn } from "node:child_process"  →  const spawn = lazyExport("child_process", "spawn")
 *
 * lazyBuiltin is a stand-in object whose first property access loads the
 * module; lazyExport is a stand-in function that loads it on the first call
 * (and keeps execFile's util.promisify form). This module imports nothing on
 * a current Node, so importing it is free.
 */

const LAZY = typeof process.getBuiltinModule === "function"
// older Node: no synchronous loader, so load them now (the old behaviour)
const EAGER = LAZY ? null : {
  fs: await import("node:fs"),
  crypto: await import("node:crypto"),
  child_process: await import("node:child_process"),
  zlib: await import("node:zlib"),
  module: await import("node:module"),
  string_decoder: await import("node:string_decoder"),
  util: await import("node:util"),
}
const cache = new Map()

/** The built-in module `name` ("crypto", "child_process", …), loaded now. */
export function loadBuiltin(name) {
  let m = cache.get(name)
  if (m) return m
  if (LAZY) m = process.getBuiltinModule(`node:${name}`)
  else {
    const ns = EAGER[name]
    if (!ns) throw new Error(`lazybuiltin: "${name}" is not preloaded for Node ${process.version}`)
    m = ns.default ?? ns
  }
  cache.set(name, m)
  return m
}

/** True once the module has been loaded (for tests and the boot benchmark). */
export function builtinLoaded(name) { return cache.has(name) }

/** A stand-in for a default import: the module loads on first property access. */
export function lazyBuiltin(name) {
  const real = () => loadBuiltin(name)
  return new Proxy(Object.create(null), {
    get: (_, k) => real()[k],
    // a write goes to the real module, never to the stand-in
    set: (_, k, v) => { real()[k] = v; return true },
    has: (_, k) => k in real(),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_, k) => {
      const d = Object.getOwnPropertyDescriptor(real(), k)
      return d ? { ...d, configurable: true } : undefined
    },
  })
}

const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom")

/** A stand-in for a named function import: the module loads on the first call. */
export function lazyExport(name, key) {
  const fn = function (...args) {
    const f = loadBuiltin(name)[key]
    // `new Stand-in()` builds the REAL class (its prototype, its methods); a
    // subclass of the stand-in keeps its own new.target
    if (new.target) return Reflect.construct(f, args, new.target === fn ? f : new.target)
    return f.apply(this, args)
  }
  Object.defineProperty(fn, "name", { value: key })
  // `x instanceof Stand-in` asks the real class
  Object.defineProperty(fn, Symbol.hasInstance, { value: (x) => { const f = loadBuiltin(name)[key]; return typeof f === "function" && x instanceof f } })
  // util.promisify(execFile) resolves { stdout, stderr } only through this
  Object.defineProperty(fn, PROMISIFY_CUSTOM, { get: () => loadBuiltin(name)[key]?.[PROMISIFY_CUSTOM], configurable: true })
  return fn
}
