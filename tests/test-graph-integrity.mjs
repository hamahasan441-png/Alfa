#!/usr/bin/env node
/**
 * forge — the code graph has to describe the repository it was built from (v126).
 *
 * Four defects, each one silently making the graph smaller than the truth, and
 * every consumer downstream reasoning from the shortfall as if it were fact.
 * All four were found by measurement against this repository, which is the
 * fixture: forge indexes itself, so "what does the graph say?" and "what is
 * actually in the tree?" can be compared directly.
 *
 *   1. lang.js isTestFile() recognised `foo.test.js` and `test_foo.py` and
 *      little else. This repo's 267 suites are all `tests/test-<name>.mjs`
 *      and it answered false for EVERY one. The cross-graph carried 0 TEST
 *      edges and testsForFiles() — which tells the agent which tests cover
 *      what it changed — returned [] for every input it was ever given.
 *      v125 built the verification hint on top of that empty list.
 *
 *   2. impact.js had a SECOND, different answer to the same question
 *      (TEST_HINT), which did know about a `tests/` directory. Two
 *      implementations, disagreeing, and the graph used the broken one.
 *
 *   3. every import extractor capped at 20 per file. agent.js has 48 static
 *      imports, so 28 edges were dropped — including ./completion.js, which
 *      is why consumersOf("completion.js") named bench/evolve/meta and not
 *      the module that most depends on it.
 *
 *   4. the walk stopped at 400 files and reported stats indistinguishable
 *      from a complete index. forge has 660 indexable files, so 260 were
 *      invisible, and impactRadius answered `unknown: false` — "no
 *      importers" — about files whose importers were never scanned.
 *
 * Plus a quadratic blast in dag.invalidateNodes(): the cascade re-enqueued a
 * node once per path reaching it, so the `blocked` list it returns (emitted
 * verbatim as `blockedNodes`) counted 28,680 nodes where 239 were blocked.
 *
 * These assertions are comparisons against the tree, not fixtures. If someone
 * lowers a cap or narrows the matcher again, the numbers move and this fails.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-graph-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const { isTestFile, MAX_IMPORTS_PER_FILE, MAX_SYMBOLS_PER_FILE } = await import("../lang.js")
const { buildCrossGraph, DEFAULT_MAX_FILES } = await import("../repomap.js")
const { testsForFiles, consumersOf } = await import("../xlang.js")
const { impactRadius } = await import("../impact.js")
const dag = await import("../dag.js")

console.log("== 1. isTestFile recognises how projects actually name tests ==")
{
  // true: every convention the graph has to see
  const TESTS = [
    "tests/test-governor-answer.mjs",   // this repo — 267 of these, all missed
    "tests/helper.mjs",                 // a tests/ directory is a tests/ directory
    "test/test_foo.py", "test/foo_test.go", "tests/unit/thing_test.js",
    "src/foo.test.js", "src/foo.spec.ts", "__tests__/a.js", "spec/a_spec.rb",
    "testing/x.js", "MyTest.java", "MyTests.java", "conftest.py", "foo_test.ts",
  ]
  // false: the traps a looser regex would fall into — a source file wrongly
  // called a test disappears from the importer graph, which is worse
  const NOT = [
    "src/index.js", "agent.js", "latest.js", "contest.js",
    "src/latest/foo.js", "protest/a.js", "lib/attest.js", "src/spectrum.js",
    "GIT.java", "", null, undefined,
  ]
  const missedT = TESTS.filter((f) => !isTestFile(f))
  const missedF = NOT.filter((f) => isTestFile(f))
  eq(`every test convention is recognised (${TESTS.length} probes)`, missedT, [])
  eq(`and no source file is mistaken for one (${NOT.length} probes)`, missedF, [])
  ok("windows separators are handled", isTestFile("tests\\test-a.mjs"))
}

console.log("== 2. one answer to 'is this a test', not two (§36) ==")
{
  const src = fs.readFileSync(path.join(ROOT, "impact.js"), "utf8")
  ok("impact.js no longer carries its own regex", !/const TEST_HINT = \/\(\?:/.test(src))
  ok("…it defers to the indexer's isTestFile", /import \{ isTestFile \} from "\.\/lang\.js"/.test(src))
}

console.log("== 3. this repository's own suites are in its own graph ==")
{
  const g = buildCrossGraph(ROOT)
  const paths = g.files.map((n) => n.path)
  const onDisk = [
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")),
    ...fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".mjs")).map((f) => "tests/" + f),
  ]
  const missing = onDisk.filter((f) => !paths.includes(f))
  eq(`no source file is missing from the graph (${onDisk.length} on disk)`, missing.length, 0)
  if (missing.length) console.log(`       e.g. ${missing.slice(0, 6).join(", ")}`)

  const testNodes = g.files.filter((n) => n.isTest)
  ok(`the suites are marked as tests (${testNodes.length}, was 0)`, testNodes.length > 200, String(testNodes.length))
  const testEdges = g.edges.filter((e) => e.kind === "TEST")
  ok(`and the graph carries TEST edges (${testEdges.length}, was 0)`, testEdges.length > 0, String(testEdges.length))
  ok("the walk reports whether it was truncated", typeof g.stats?.truncated === "boolean", JSON.stringify(g.stats))
  ok("…and on this repo it was not", g.stats.truncated === false, JSON.stringify(g.stats))
}

console.log("== 4. a big module's edges are not silently dropped ==")
{
  const g = buildCrossGraph(ROOT)
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  const realImports = (agentSrc.match(/^import /gm) || []).length
  const node = g.files.find((n) => n.path === "agent.js")
  ok(`agent.js has more than the old cap of 20 imports (${realImports})`, realImports > 20)
  ok(`…and the graph extracted them all (${node?.imports?.length})`,
    (node?.imports?.length ?? 0) >= realImports - 2, `${node?.imports?.length} vs ${realImports}`)
  ok("the per-file import cap is above any hand-written module", MAX_IMPORTS_PER_FILE >= 200)
  ok("…and symbols have their own named cap, not the import one", MAX_SYMBOLS_PER_FILE >= 200)

  ok("the agent.js → completion.js edge exists",
    g.edges.some((e) => e.from === "agent.js" && e.to === "completion.js" && e.kind === "IMPORT"))
}

console.log("== 5. the derived answers agree with the tree ==")
{
  const g = buildCrossGraph(ROOT)
  // ground truth by grep: who statically imports completion.js?
  const truth = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")).filter((f) => {
    try { return /from "\.\/completion\.js"/.test(fs.readFileSync(path.join(ROOT, f), "utf8")) } catch { return false }
  }).sort()
  const got = consumersOf([path.join(ROOT, "completion.js")], g, { cwd: ROOT }).sort()
  ok(`consumersOf finds every real importer (${truth.length}: ${truth.join(", ")})`,
    truth.every((f) => got.includes(f)), `missing ${truth.filter((f) => !got.includes(f)).join(", ")}`)

  const tests = testsForFiles([path.join(ROOT, "governor.js")], g, { cwd: ROOT })
  ok(`testsForFiles returns real suites for a core module (${tests.length}, was 0)`, tests.length > 0, JSON.stringify(tests))
  ok("…and they are paths that exist", tests.every((t) => fs.existsSync(path.join(ROOT, t))), JSON.stringify(tests.slice(0, 3)))

  // chat.js imports agent.js — this was missing before the cap was raised
  const blast = impactRadius({ files: [path.join(ROOT, "agent.js")], graph: g, cwd: ROOT })
  ok("impactRadius sees chat.js importing agent.js", blast.importers.includes("chat.js"), JSON.stringify(blast.importers))
  ok("…and the blast carries tests now", (blast.tests || []).length > 0)
}

console.log("== 6. a truncated walk is never reported as certainty ==")
{
  // force truncation: the same repo, a cap below its size
  const small = buildCrossGraph(ROOT, { maxFiles: 50 })
  ok("a capped walk says it was truncated", small.stats.truncated === true, JSON.stringify(small.stats))
  const blast = impactRadius({ files: [path.join(ROOT, "config.js")], graph: small, cwd: ROOT })
  // may fall through to the string-scan when the tiny graph connects nothing;
  // what must never happen is a confident "no importers" from a partial graph
  if (blast.graph) {
    ok("a blast from a truncated graph is UNKNOWN, not a census", blast.unknown === true, JSON.stringify({ unknown: blast.unknown, truncated: blast.truncated }))
  } else {
    ok("a truncated graph was not used to claim certainty", true)
  }
  const full = buildCrossGraph(ROOT)
  const fullBlast = impactRadius({ files: [path.join(ROOT, "config.js")], graph: full, cwd: ROOT })
  ok("…while a complete walk still answers with confidence", fullBlast.unknown === false, JSON.stringify(fullBlast.unknown))
  ok(`the default walk budget covers this repo (${DEFAULT_MAX_FILES} >= 660)`, DEFAULT_MAX_FILES >= 660)
}

console.log("== 7. the invalidation cascade reports what it did, once ==")
{
  const dense = (N) => {
    const defs = []
    for (let i = 0; i < N; i++) defs.push({ id: `n${i}`, description: "d", dependencies: Array.from({ length: i }, (_, j) => `n${j}`) })
    return dag.buildDAG(defs)
  }
  for (const N of [60, 120, 240]) {
    const g = dense(N)
    const t0 = Date.now()
    const r = dag.invalidateNodes(g, ["n0"])
    const ms = Date.now() - t0
    const uniq = new Set(r.blocked).size
    eq(`dense N=${N}: blocked is reported once per node`, r.blocked.length, uniq)
    eq(`dense N=${N}: and it is every downstream node`, uniq, N - 1)
    ok(`dense N=${N}: in linear time (${ms}ms, was up to 627ms)`, ms < 200, `${ms}ms`)
  }
  // the cascade must still REACH everything down a chain
  const chain = dag.buildDAG(Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, description: "d", dependencies: i ? [`n${i - 1}`] : [] })))
  const r = dag.invalidateNodes(chain, ["n0"])
  eq("a 200-long chain still cascades all the way down", r.blocked.length, 199)
  ok("…and every one of them is BLOCKED in the graph",
    r.blocked.every((id) => chain.nodes.get(id).status === dag.NODE_STATUS.BLOCKED))

  // completed downstream work is still invalidated, not merely blocked
  const g2 = dag.buildDAG([
    { id: "a", description: "a" },
    { id: "b", description: "b", dependencies: ["a"] },
    { id: "c", description: "c", dependencies: ["b"] },
  ])
  for (const id of ["a", "b", "c"]) g2.nodes.get(id).status = dag.NODE_STATUS.COMPLETED
  const r2 = dag.invalidateNodes(g2, ["a"], { reason: "ground truth changed" })
  ok("completed downstream nodes are invalidated, not skipped",
    g2.nodes.get("b").status === dag.NODE_STATUS.INVALIDATED && g2.nodes.get("c").status === dag.NODE_STATUS.INVALIDATED,
    JSON.stringify([g2.nodes.get("b").status, g2.nodes.get("c").status]))
  eq("…and each is listed once", r2.invalidated.length, new Set(r2.invalidated).size)
}

console.log("== the graph still refuses what it always refused ==")
{
  let threw = false
  try { dag.buildDAG([{ id: "a", description: "a", dependencies: ["b"] }, { id: "b", description: "b", dependencies: ["a"] }]) } catch { threw = true }
  ok("a cycle is still rejected", threw)
  threw = false
  try { dag.buildDAG([{ id: "a", description: "a", dependencies: ["nope"] }]) } catch { threw = true }
  ok("a dangling dependency is still rejected", threw)
  eq("hostile serialized data still yields null", dag.deserializeDAG({ nodes: [{ id: "a", description: "a", dependencies: ["zz"] }] }), null)
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== graph-integrity suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
