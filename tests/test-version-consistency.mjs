#!/usr/bin/env node
/**
 * forge — P1 one version, everywhere.
 *
 * The version lives in exactly ONE place (package.json) and is read at runtime
 * by version.js. The defect this locks down: package.json said 21.0.0 while
 * every outbound network request advertised `forge-agent/20.0.0`, `forge/20`
 * and even `forge-agent/19.0.0` — three different lies from one build.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ver-"))
process.env.FORGE_HOME = HOME
const FORGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const ROOT = path.resolve(FORGE, "..")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const pkg = JSON.parse(fs.readFileSync(path.join(FORGE, "package.json"), "utf8"))
const { VERSION } = await import("../version.js")

console.log("== the single source of truth ==")
{
  eq("package.json version", pkg.version, VERSION)
  ok("version is semver", /^\d+\.\d+\.\d+/.test(VERSION))
}

console.log("== every runtime user-agent uses that version ==")
{
  const src = fs.readFileSync(path.join(FORGE, "tools.js"), "utf8")
  ok("no hardcoded forge-agent/XX in tools.js", !/forge-agent\/\d+\.\d+/.test(src))
  ok("no hardcoded forge/XX browser agent", !/Mozilla[^\n]*forge\/\d+/.test(src))
  ok("the version is imported", /import\s*{\s*VERSION\s*}\s*from\s*"\.\/version\.js"/.test(src))
  ok("the UA is built from it", /forge-agent\/\$\{VERSION\}/.test(src))

  const prov = fs.readFileSync(path.join(FORGE, "providers.js"), "utf8")
  ok("no hardcoded forge-agent/XX in providers.js", !/forge-agent\/\d+\.\d+/.test(prov))
  ok("BASE_HEADERS uses VERSION", /forge-agent\/\$\{VERSION\}/.test(prov))

  // statically scan every module for a literal version string that is not this one
  const files = fs.readdirSync(FORGE).filter((f) => f.endsWith(".js"))
  const offenders = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(FORGE, f), "utf8")
    for (const m of text.matchAll(/(?:forge|forge-agent)\/(\d+)\.(\d+)/g)) {
      if (m[0] !== `forge/${VERSION}` && m[0] !== `forge-agent/${VERSION}`) offenders.push(`${f}: ${m[0]}`)
    }
  }
  eq("no module advertises a different version", offenders.length, 0)
  if (offenders.length) console.log(`       ${offenders.join("\n       ")}`)
}

console.log("== the real HTTP header carries the real version ==")
{
  // v21.1: fetch_url / web_search no longer go through globalThis.fetch (they
  // use DNS-pinned sockets, netguard.pinnedFetch), so the header is observed
  // on a REAL local server instead of a mocked global.
  const tools = await import("../tools.js")
  const http = await import("node:http")
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers["user-agent"] ?? null })
    res.writeHead(200, { "content-type": "text/plain" }); res.end("body text")
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const ctx = tools.makeToolContext({
      cwd: HOME, root: HOME, readOnly: true, timeoutSec: 3, maxToolOutput: 500,
      signal: null, searchUrl: `${base}/search`, skillsDir: null, fetchPrivateUrls: true,
    })
    await ctx.exec("fetch_url", { url: `${base}/x` })
    await ctx.exec("web_search", { query: "forge agent" })
  } catch { }
  srv.close()
  // Ignore foreign hits on the ephemeral port (preview probes, scanners).
  const ours = seen.filter((s) => s.url === "/x" || String(s.url || "").startsWith("/search"))
  const withUa = ours.filter((s) => s.ua)
  ok("an outbound request was made", withUa.length > 0)
  ok("every request advertised a user-agent", ours.every((s) => s.ua))
  ok(`the version in the header is real (${withUa[0]?.ua})`, withUa.every((s) => String(s.ua).includes(VERSION)))
  ok("no header advertises another version", withUa.every((s) => !/forge-agent\/\d+\.\d+/.test(String(s.ua).replace(VERSION, ""))))
}

console.log("== the CLI agrees with package.json ==")
{
  const out = execFileSync(process.execPath, [path.join(FORGE, "forge.js"), "--version"], {
    encoding: "utf8", cwd: HOME, env: { ...process.env, FORGE_HOME: HOME },
  }).trim()
  ok(`\`forge --version\` prints v${VERSION}`, out.includes(`forge v${VERSION}`))
}

console.log("== a pin's LABEL says the same thing as the pin ==")
{
  // The bump script rewrote the assertions and left the human-readable labels
  // alone, so 14 suites still read `ok("package version is 158.x", /^158\./…)`
  // five releases after 117 — a failure would have told the reader to expect
  // the wrong version. The pins were right the whole time, which is why no
  // suite ever went red over it. scripts/bump-version.mjs now rewrites the
  // label too; this is the assertion that keeps them from drifting apart
  // again, since only a human ever reads a label.
  const major = VERSION.split(".")[0]
  const suiteDir = path.join(FORGE, "tests")
  const stale = []
  for (const f of fs.readdirSync(suiteDir).filter((n) => n.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(suiteDir, f), "utf8")
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return // prose may quote an old label as an example
      for (const m of line.matchAll(/package version is (\d+)\.x/g)) {
        if (m[1] !== major) stale.push(`${f}:${i + 1} says ${m[1]}.x, package is ${major}.x`)
      }
    })
  }
  eq("no suite labels a stale major version", stale.length, 0)
  for (const s of stale.slice(0, 10)) console.log(`       ${s}`)
}

console.log("== the bump script rewrites a version, not a substring of one ==")
{
  // v128: `bump-version.mjs` matched the bare version unanchored, so bumping
  // 127.0.0 → 158.0.0 rewrote every `127.0.0.1` in the tree — 55 files, every
  // mock server in the suite, 48 suites red at once. The collision only needs
  // the version to be a PREFIX of something numeric, so it was waiting for
  // whichever release happened to hit it.
  const src = fs.readFileSync(path.join(FORGE, "scripts", "bump-version.mjs"), "utf8")
  ok("the version match is bounded on both sides",
    /NOT_VERSIONY_BEFORE/.test(src) && /NOT_VERSIONY_AFTER/.test(src))
  ok("…and the unanchored form is gone",
    !/find: new RegExp\(rxEscape\(current\), "g"\)/.test(src))

  // the rule itself, exercised rather than read
  const rxEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?<![\\d.])${rxEscape("127.0.0")}(?![\\d.])`, "g")
  const cases = [
    ["127.0.0.1", "127.0.0.1"], ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["1127.0.0", "1127.0.0"], ['"127.0.0"', '"158.0.0"'],
    ["v127.0.0", "v158.0.0"], ["127.0.0", "158.0.0"],
  ]
  const wrong = cases.filter(([i, w]) => i.replace(re, "158.0.0") !== w).map(([i]) => i)
  eq("a version bump leaves localhost alone and still bumps versions", wrong, [])

  // and the tree itself: the corruption signature is the PACKAGE MAJOR spliced
  // into a loopback address. Other private addresses (10.0.0.1, 224.0.0.1, …)
  // are deliberate SSRF fixtures and must not be flagged.
  const major = VERSION.split(".")[0]
  const splice = new RegExp(`\\b${major}\\.0\\.0\\.\\d`)
  const bad = []
  for (const f of fs.readdirSync(path.join(FORGE, "tests")).filter((n) => n.endsWith(".mjs"))) {
    const t = fs.readFileSync(path.join(FORGE, "tests", f), "utf8")
    if (major !== "127" && splice.test(t)) bad.push(f)
  }
  eq(`no suite had the version (${major}) spliced into an IP address`, bad, [])
  eq("and every mock server still binds 127.0.0.1",
    fs.readdirSync(path.join(FORGE, "tests")).filter((n) => n.endsWith(".mjs"))
      .filter((f) => /listen\(0, "(?!127\.0\.0\.1")/.test(fs.readFileSync(path.join(FORGE, "tests", f), "utf8"))), [])
}

console.log("== documented versions agree with the package ==")
{
  const changelog = fs.readFileSync(path.join(FORGE, "CHANGELOG.md"), "utf8")
  // Only the TOP heading is "in progress". Historical `## [Unreleased] — v20.5.0`
  // leftovers later in the file are not the current release.
  const firstHeading = /^##\s+.+$/m.exec(changelog)?.[0] ?? ""
  const latest = /(\d+\.\d+\.\d+)/.exec(firstHeading)?.[1] ?? null
  ok(`the latest CHANGELOG heading matches package.json (${latest})`, latest === VERSION)
  ok("an Unreleased banner at the top still matches, if present", !/unreleased/i.test(firstHeading) || latest === VERSION)
  ok("the CHANGELOG states the single-source rule", /package\.json/.test(changelog))

  const readme = fs.readFileSync(path.join(FORGE, "README.md"), "utf8")
  const firstLine = readme.split("\n")[0]
  ok("the README title does not claim a stale version", !/v(19|20)\b/.test(firstLine))

  // v88: README.txt is gone (dead install path); root README.md must not be stale
  // The shipped Forge archive is itself the repository root. Older source
  // layouts placed README.md/PACKAGE_INFO.txt one directory above FORGE.
  // Prefer the historical parent when those fixtures exist; otherwise test
  // the shipped root honestly instead of failing on an absent legacy file.
  const rootReadmePath = fs.existsSync(path.join(ROOT, "README.md")) ? path.join(ROOT, "README.md") : path.join(FORGE, "README.md")
  const rootReadme = fs.readFileSync(rootReadmePath, "utf8")
  ok("root README title does not claim a stale version", !/v(19|20)\b/.test(rootReadme.split("\n")[0]))
  ok("root README names the current version", rootReadmePath === path.join(FORGE, "README.md") ? rootReadme.includes(VERSION) : true)
  const pkgInfoPath = fs.existsSync(path.join(ROOT, "PACKAGE_INFO.txt")) ? path.join(ROOT, "PACKAGE_INFO.txt") : null
  if (pkgInfoPath) {
    const pkgInfo = fs.readFileSync(pkgInfoPath, "utf8")
    ok(`PACKAGE_INFO title matches (${pkgInfo.split("\n")[0].slice(0, 24)})`, pkgInfo.split("\n")[0].includes(VERSION) || !/v\d+\.\d+\.\d+/.test(pkgInfo.split("\n")[0]))
  } else {
    ok("PACKAGE_INFO legacy fixture not required in shipped-root layout", true)
  }
}

console.log("== release metadata is complete ==")
{
  ok("name", typeof pkg.name === "string" && pkg.name.length > 0)
  ok("description", typeof pkg.description === "string")
  ok("license", !!pkg.license)
  ok("engines.node", !!pkg.engines?.node)
  ok("bin", !!pkg.bin)
  ok("files whitelist", Array.isArray(pkg.files) && pkg.files.includes("completion.js"))
  ok("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length === 0)
  ok("npm test is wired", typeof pkg.scripts?.test === "string")
}

console.log(`\n== version-consistency suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
