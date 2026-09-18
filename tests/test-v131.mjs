#!/usr/bin/env node
/** Phase 1 — ESM/CJS boundary contract (test-first). */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const FORGE = path.resolve(ROOT, "..")
let pass = 0
function ok(name, cond, detail = "") {
  if (!cond) { console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; return }
  pass++; console.log(`PASS ${name}`)
}

// 1) The boundary helper must exist and be ESM-loadable.
let loader
try { loader = await import("../module-loader.js") } catch (e) {
  ok("module-loader is loadable", false, e?.message ?? e)
}
ok("module-loader exports loadModule", typeof loader?.loadModule === "function")
ok("module-loader exports loadCjs", typeof loader?.loadCjs === "function")

// 2) A real CommonJS module must load correctly even though Forge itself is
// type=module. This reproduces the exact skill/script boundary that currently
// breaks for skills/pdf and skills/pptx .js helpers.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v131-"))
try {
  const cjs = path.join(tmp, "fixture.js")
  fs.writeFileSync(cjs, "module.exports = { kind: 'cjs', answer: 42 }\n")
  const loaded = loader?.loadCjs ? loader.loadCjs(cjs) : null
  ok("CJS fixture loads through explicit CJS boundary", loaded?.kind === "cjs" && loaded?.answer === 42)

  // 3) ESM remains ESM: the generic loader must not route .mjs through the CJS
  // bridge.
  const esm = path.join(tmp, "fixture.mjs")
  fs.writeFileSync(esm, "export default { kind: 'esm', answer: 43 }\n")
  const em = loader?.loadModule ? await loader.loadModule(esm) : null
  ok("ESM fixture loads through native dynamic import", em?.default?.kind === "esm" && em?.default?.answer === 43)

  // 3b) Legacy .js CommonJS is explicit and isolated at the skill boundary.
  const legacy = path.join(tmp, "legacy.js")
  fs.writeFileSync(legacy, "module.exports = { kind: 'legacy-cjs', answer: 44 }\n")
  const lm = loader?.loadModule ? await loader.loadModule(legacy, { format: "cjs" }) : null
  ok("legacy .js loads through explicit CJS format", lm?.format === "cjs" && lm?.default?.kind === "legacy-cjs")

  // 3c) Real bundled CJS skill trees declare their module boundary locally.
  for (const [dir, files] of [["skills/pdf/scripts", ["html2poster.js", "cover_validate.js", "html2pdf-next.js"]], ["skills/pptx", ["html2pptx1.js", "batch_html2pptx.js"]]]) {
    const pkg = path.join(FORGE, dir, "package.json")
    const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"))
    ok(`${dir} declares CommonJS boundary`, parsed.type === "commonjs")
    for (const f of files) {
      const target = path.join(FORGE, dir, f)
      const format = loader?.moduleFormat ? loader.moduleFormat(target) : null
      ok(`${dir}/${f} resolves as CJS`, format === "cjs")
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 4) Core runtime entrypoints stay ESM and contain no executable require().
for (const file of ["runtime.js", "forge.js", "agent.js", "meta.js", "worknode.mjs"]) {
  const src = fs.readFileSync(path.join(FORGE, file), "utf8")
  const executableRequire = /(^|[^\w$])require\s*\(/m.test(src.replace(/\/\/.*$/gm, ""))
  ok(`${file} has no executable require()`, !executableRequire)
}

console.log(`\nPhase 1 boundary tests: ${pass} passed`)
