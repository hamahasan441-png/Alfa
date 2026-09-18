import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "v3-preservation-manifest.json"), "utf8"))

const missing = manifest.protectedFiles.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
assert.deepEqual(missing, [], `baseline files missing: ${missing.slice(0, 20).join(", ")}`)

assert.ok(fs.existsSync(path.join(ROOT, "core.js")), "core.js must remain: it is an original orchestration surface")
assert.ok(fs.existsSync(path.join(ROOT, "package.json")), "package.json must remain")
console.log(`v3-preservation: ${manifest.protectedFiles.length} baseline files preserved; export compatibility is covered by test-v129.mjs`)
