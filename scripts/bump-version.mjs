#!/usr/bin/env node
/**
 * forge — release version bump, in ONE command.
 *
 * Why this exists: the version lives in package.json (version.js reads it),
 * but ~70 suites additionally PIN the expected version as a release gate
 * ("did I remember to bump everything together?"). Bumping package.json by
 * hand therefore reddens every one of those suites at once — which is exactly
 * what happened between 122.1.0 and 123.6.0, where 69 suites failed on a pin
 * the release never refreshed.
 *
 * This script makes the bump atomic: package.json and every pin shape move
 * together, or nothing moves. It rewrites the three shapes the suites use:
 *
 *   "123.6.0"        exact string   (eq(..., pkg.version, "123.6.0"))
 *   /^123\.          major regex    (/^123\./.test(VERSION))
 *   123\.6\.0        escaped regex  (/123\.6\.0/.test(readme))
 *
 * Usage:
 *   node scripts/bump-version.mjs 124.0.0
 *   node scripts/bump-version.mjs 124.0.0 --dry-run
 *
 * It does NOT write a CHANGELOG entry or tag a release — those are authoring
 * decisions, not mechanical edits. Run the suite afterwards; the pins are the
 * gate that proves the bump is complete.
 *
 * Zero dependencies, stdlib only.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const TESTS = path.join(ROOT, "tests")

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function die(msg) {
  console.error(`bump-version: ${msg}`)
  process.exit(1)
}

/** Escape a literal for use inside a RegExp source. */
const rxEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** The `123\.6\.0` shape a test embeds inside a regex literal. */
const dotEscaped = (v) => v.replace(/\./g, "\\.")

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

  const curMajor = current.split(".")[0]
  const nextMajor = next.split(".")[0]

  // The three pin shapes, longest/most-specific first so a rewrite of one
  // cannot corrupt another (the escaped form contains the major form).
  const edits = [
    { what: "escaped regex", find: new RegExp(rxEscape(dotEscaped(current)), "g"), put: dotEscaped(next) },
    { what: "exact string", find: new RegExp(rxEscape(current), "g"), put: next },
    { what: "major regex", find: new RegExp(`\\^${rxEscape(curMajor)}\\\\\\.`, "g"), put: `^${nextMajor}\\.` },
  ]

  const changed = []
  let pins = 0
  let files = []
  try { files = fs.readdirSync(TESTS).filter((f) => f.endsWith(".mjs")) } catch { die("tests/ is unreadable") }

  for (const f of files) {
    const abs = path.join(TESTS, f)
    let src
    try { src = fs.readFileSync(abs, "utf8") } catch { continue }
    let out = src
    let hits = 0
    for (const e of edits) {
      out = out.replace(e.find, () => { hits++; return e.put })
    }
    if (hits && out !== src) {
      pins += hits
      changed.push({ file: path.join("tests", f), hits })
      if (!dryRun) fs.writeFileSync(abs, out)
    }
  }

  // package.json last: if a test write failed we would rather leave the
  // manifest on the old version than claim a bump that did not land.
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
  console.log(`  ${changed.length} test file(s), ${pins} pin(s) ${dryRun ? "would be" : ""} rewritten`)
  for (const c of changed.slice(0, 12)) console.log(`    ${c.file} (${c.hits})`)
  if (changed.length > 12) console.log(`    … and ${changed.length - 12} more`)
  if (!dryRun) {
    console.log("\nnext: update CHANGELOG.md + README, then run `npm test` — the pins are the gate.")
  }
}

main()
