/**
 * Forge module boundary helpers.
 *
 * Core Forge is ESM (`package.json` has type=module). Skills and third-party
 * integrations may still contain CommonJS entrypoints, so the boundary must
 * be explicit instead of relying on Node's package-type heuristics.
 *
 * Rules:
 *   - .mjs -> native ESM import
 *   - .cjs -> CommonJS via createRequire
 *   - .js  -> native ESM by default (Forge package convention)
 *   - legacy CJS .js -> call loadCjs(file) explicitly
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireFromForge = createRequire(pathToFileURL(path.join(HERE, "module-loader.js")).href)

function asFilePath(specifier) {
  if (specifier instanceof URL) return fileURLToPath(specifier)
  const s = String(specifier)
  return s.startsWith("file:") ? fileURLToPath(s) : path.resolve(s)
}

/** Load a known CommonJS module without calling require() from ESM code. */
export function loadCjs(specifier) {
  const file = asFilePath(specifier)
  const req = createRequire(pathToFileURL(file).href)
  return req(file)
}

/** Load an ESM module through Node's native async loader. */
export async function loadEsm(specifier) {
  const file = asFilePath(specifier)
  return import(pathToFileURL(file).href)
}

function packageTypeFor(file) {
  let dir = path.dirname(file)
  while (true) {
    const pkg = path.join(dir, "package.json")
    try {
      const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"))
      return parsed?.type === "commonjs" ? "commonjs" : "module"
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) return "module"
    dir = parent
  }
}

/**
 * Resolve the runtime format without executing the target.
 * `format` may be `esm`, `cjs`, or `auto`.
 */
export function moduleFormat(specifier, format = "auto") {
  if (format === "esm" || format === "cjs") return format
  const file = asFilePath(specifier)
  if (file.endsWith(".mjs")) return "esm"
  if (file.endsWith(".cjs")) return "cjs"
  return packageTypeFor(file) === "commonjs" ? "cjs" : "esm"
}

/**
 * Unified boundary loader. Legacy .js CJS entrypoints must pass
 * `{ format: "cjs" }`; this prevents accidentally interpreting a CommonJS
 * skill as Forge ESM just because it lives below the main package.
 */
export async function loadModule(specifier, { format = "auto" } = {}) {
  return moduleFormat(specifier, format) === "cjs"
    ? { default: loadCjs(specifier), format: "cjs" }
    : { ...(await loadEsm(specifier)), format: "esm" }
}
