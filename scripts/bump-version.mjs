#!/usr/bin/env node
/**
 * forge — release version bump.
 *
 * The version lives in ONE place: package.json (version.js reads it at run
 * time). Until the Phase 2 clean-up, ~70 suites also PINNED the expected
 * version as a "release gate", and this script existed mainly to rewrite
 * those pins. The pins only ever checked themselves, and they broke twice:
 * 69 suites red when a bump missed them (122.1.0 → 123.6.0), and 48 red when
 * an unanchored rewrite turned every `127.0.0.1` into `128.0.0.1` (v128).
 * The pins are gone; tests read VERSION, and test-version-consistency fails
 * if a suite pins the version again. A bump is now one field.
 *
 * Usage:
 *   node scripts/bump-version.mjs 179.0.0
 *   node scripts/bump-version.mjs 179.0.0 --dry-run
 *
 * It does NOT write a CHANGELOG entry or README line — those are authoring
 * decisions. test-version-consistency checks that the top CHANGELOG heading
 * carries the new version, so `npm test` says what is left.
 *
 * Zero dependencies, stdlib only.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function die(msg) {
  console.error(`bump-version: ${msg}`)
  process.exit(1)
}

/** Escape a literal for use inside a RegExp source. */
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const next = args.find((a) => !a.startsWith("-"))
  if (!next) die("usage: node scripts/bump-version.mjs <version> [--dry-run]")
  if (!SEMVER.test(next)) die(`"${next}" is not a bare semver (expected N.N.N)`)

  const pkgPath = path.join(ROOT, "package.json")
  let pkgRaw
  try { pkgRaw = fs.readFileSync(pkgPath, "utf8") } catch { return die("package.json is unreadable") }
  const pkg = JSON.parse(pkgRaw)
  const current = String(pkg.version || "")
  if (!SEMVER.test(current)) die(`package.json version "${current}" is not a bare semver`)
  if (current === next) die(`package.json is already ${next} — nothing to do`)

  if (!dryRun) {
    const bumped = pkgRaw.replace(
      new RegExp(`("version"\\s*:\\s*")${rxEscape(current)}(")`),
      (_m, a, b) => `${a}${next}${b}`,
    )
    if (bumped === pkgRaw) die("could not rewrite the version field in package.json")
    fs.writeFileSync(pkgPath, bumped)
  }

  const verb = dryRun ? "would bump" : "bumped"
  console.log(`${verb} ${current} → ${next}`)
  console.log(`  package.json           ${dryRun ? "(unchanged, dry run)" : "updated"}`)
  if (!dryRun) {
    console.log("\nnext: a CHANGELOG.md heading for the new version + the README line, then `npm test`.")
  }
}

main()
