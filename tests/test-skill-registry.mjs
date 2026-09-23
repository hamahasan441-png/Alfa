#!/usr/bin/env node
/**
 * forge v147 — the curated skill list, actually checked.
 *
 * `skillregistry.js` shipped at v99 with a caveat in its header:
 *
 *   "URLs are hints, not promises — a moved branch fails the download
 *    honestly."
 *
 * Nobody ever looked. Checking them found **seven of ten already 404** —
 * `forge skill recommend` was mostly handing out links that fail at download
 * time, which is not honest failure, it is a broken feature with an excuse
 * attached.
 *
 * So this suite has two halves, and the split matters:
 *
 *   OFFLINE (always) — shape, uniqueness, and the invariants that keep the
 *   list from rotting in ways a reader could have caught: no duplicate repo,
 *   no duplicate URL, every live example dated, no dead URL left where
 *   something might recommend it.
 *
 *   NETWORK (FORGE_NET_TESTS=1) — actually fetch every live URL. Opt-in,
 *   because a suite that goes red when GitHub has a bad minute is a suite
 *   people learn to ignore, and an ignored suite is how this list died the
 *   first time.
 */
import fs from "node:fs"

let PASS = 0, FAIL = 0, SKIP = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const skip = (name, why) => { SKIP++; console.log(`  skip ${name} — ${why}`) }

const R = await import("../skillregistry.js")
const { SKILL_REPOS, REGISTRY_CHECKED, registryUrls, verifyRegistry, recommendRepos } = R

const RAW = "https://raw.githubusercontent.com/"

console.log("== shape ==")
{
  ok("the list is frozen", Object.isFrozen(SKILL_REPOS))
  ok("it is not empty", SKILL_REPOS.length >= 4)
  ok("there is a date on the whole thing", /^\d{4}-\d{2}-\d{2}$/.test(REGISTRY_CHECKED), REGISTRY_CHECKED)
  for (const r of SKILL_REPOS) {
    ok(`${r.repo}: owner/name`, /^[\w.-]+\/[\w.-]+$/.test(r.repo), r.repo)
    ok(`${r.repo}: has a description`, typeof r.desc === "string" && r.desc.length > 20)
    ok(`${r.repo}: says something about licensing`, typeof r.license === "string" && r.license.length > 0)
    ok(`${r.repo}: examples is an array`, Array.isArray(r.examples))
  }
}

console.log("== no duplicates — the thing the request asked for ==")
{
  const repos = SKILL_REPOS.map((r) => r.repo)
  eq("every repo appears once", repos.length - new Set(repos.map((x) => x.toLowerCase())).size, 0)
  const urls = registryUrls().map((u) => u.url)
  eq("every live URL appears once", urls.length - new Set(urls).size, 0)
  // Within one repo, two entries with the same NAME would render as a
  // duplicate recommendation even with different URLs.
  for (const r of SKILL_REPOS) {
    const names = r.examples.map((e) => e.name.toLowerCase())
    eq(`${r.repo}: example names are unique`, names.length - new Set(names).size, 0)
  }
  // A URL must not be listed as both live and stale — that is the state the
  // v147 check found and the one this file exists to prevent recurring.
  const stale = SKILL_REPOS.flatMap((r) => (r.stale ?? []).map((e) => e.url))
  const both = stale.filter((u) => urls.includes(u))
  eq("nothing is both live and stale", both, [])
}

console.log("== every live URL is a raw SKILL.md, and dated ==")
{
  const live = registryUrls()
  ok("there are live URLs at all", live.length >= 10, `${live.length}`)
  for (const u of live) {
    ok(`${u.repo}/${u.name}: raw.githubusercontent`, u.url.startsWith(RAW), u.url)
    ok(`${u.repo}/${u.name}: ends in SKILL.md`, u.url.endsWith("/SKILL.md"), u.url)
    ok(`${u.repo}/${u.name}: carries a checked date`, /^\d{4}-\d{2}-\d{2}$/.test(u.checked ?? ""), String(u.checked))
    // The path must name the repo it claims to come from, or the entry is
    // pointing somewhere its description does not admit to.
    ok(`${u.repo}/${u.name}: the URL is under that repo`, u.url.startsWith(`${RAW}${u.repo}/`), u.url)
  }
}

console.log("== what could not be verified is recorded, not deleted ==")
{
  // anthropics/skills 404'd on every listed URL and had merely MOVED. That is
  // the reason a repo whose guessed paths all miss is not deleted on the
  // strength of the guess — and the reason the dead URLs are kept somewhere a
  // future check can start from.
  const withStale = SKILL_REPOS.filter((r) => (r.stale ?? []).length > 0)
  ok("some entries carry stale URLs", withStale.length >= 2, `${withStale.length}`)
  for (const r of withStale) {
    for (const e of r.stale) {
      ok(`${r.repo}/${e.name}: the stale URL says why`, typeof e.note === "string" && e.note.length > 10, e.note)
      ok(`${r.repo}/${e.name}: and when`, /^\d{4}-\d{2}-\d{2}$/.test(e.checked ?? ""), String(e.checked))
    }
  }
  // A repo with nothing live must have nothing live — not a token entry kept
  // to satisfy a counter. (The old v99 pin required >= 2 examples each, which
  // is what would have forced exactly that.)
  const empty = SKILL_REPOS.filter((r) => r.examples.length === 0)
  ok("a repo with no working URL is allowed to have none", empty.every((r) => (r.stale ?? []).length > 0),
    JSON.stringify(empty.map((r) => r.repo)))
}

console.log("== the cloud entry ==")
{
  const tf = SKILL_REPOS.find((r) => r.repo === "LukasNiessen/terrashark")
  ok("terrashark is listed", !!tf)
  ok("…as infrastructure-as-code", /terraform|opentofu|infrastructure/i.test(tf?.desc ?? ""), tf?.desc)
  ok("…naming the clouds it covers", /aws/i.test(tf?.desc ?? "") && /azure/i.test(tf?.desc ?? "") && /gcp/i.test(tf?.desc ?? ""), tf?.desc)
  // Verified detail that a guess would have got wrong: the SKILL.md is at the
  // repository ROOT, not under skills/.
  eq("its SKILL.md is at the repo root", tf?.examples?.[0]?.url, `${RAW}LukasNiessen/terrashark/main/SKILL.md`)

  // And it is reachable by the surface a user actually types.
  const hits = recommendRepos("terraform").map((x) => x.repo)
  ok("`skill recommend terraform` finds it", hits.includes("LukasNiessen/terrashark"), JSON.stringify(hits))
  const infra = recommendRepos("infrastructure").map((x) => x.repo)
  ok("…and so does `infrastructure`", infra.includes("LukasNiessen/terrashark"), JSON.stringify(infra))
}

console.log("== recommend never offers a dead link ==")
{
  // The actual user-facing contract: whatever `forge skill recommend` returns
  // must be downloadable. A stale URL leaking into a recommendation is the
  // exact failure v147 found.
  const staleUrls = new Set(SKILL_REPOS.flatMap((r) => (r.stale ?? []).map((e) => e.url)))
  for (const q of ["", "terraform", "debugging", "document", "test", "aws", "skill"]) {
    const offered = recommendRepos(q).flatMap((r) => r.examples.map((e) => e.url))
    ok(`recommend(${JSON.stringify(q)}) offers no stale URL`, !offered.some((u) => staleUrls.has(u)), JSON.stringify(offered.filter((u) => staleUrls.has(u))))
    ok(`recommend(${JSON.stringify(q)}) offers only raw SKILL.md`, offered.every((u) => u.startsWith(RAW) && u.endsWith("/SKILL.md")))
  }
  eq("an empty query still returns every repo", recommendRepos("").length, SKILL_REPOS.length)
}

console.log("== the module still does no network on the CLI path ==")
{
  const src = fs.readFileSync(new URL("../skillregistry.js", import.meta.url), "utf8")
  // verifyRegistry is the one exception and it imports lazily, so printing a
  // list never loads the network stack.
  ok("netguard is imported lazily, inside verifyRegistry only",
    /await import\("\.\/netguard\.js"\)/.test(src) && !/^import .*netguard/m.test(src))
  ok("no raw global fetch", !/[^.\w]fetch\(/.test(src.replace(/pinnedFetch\(/g, "PF(")))
  // Match the CALL, not the word: the module header explains why netguard is
  // lazy, and a pin a comment can trip is one that gets weakened the first
  // time someone documents the thing it guards.
  const beforeVerify = src.slice(0, src.indexOf("export async function verifyRegistry"))
  ok("nothing before verifyRegistry calls out",
    !/pinnedFetch\(/.test(beforeVerify) && !/import\("\.\/netguard\.js"\)/.test(beforeVerify))
}

console.log("== the network check (opt-in) ==")
if (process.env.FORGE_NET_TESTS === "1") {
  const { ok: allOk, results } = await verifyRegistry()
  for (const r of results) ok(`${r.repo}/${r.name} → ${r.status}`, r.ok, r.url)
  ok(`all ${results.length} live URLs resolve`, allOk)
} else {
  skip("every live URL returns 200", "set FORGE_NET_TESTS=1 (a suite that reddens on a GitHub blip gets ignored)")
}

console.log(`\n== skill-registry suite: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==`)
process.exit(FAIL ? 1 : 0)
