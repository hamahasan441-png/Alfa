#!/usr/bin/env node
/**
 * forge — provenance has to survive being stored, and staleness has to fire (v127).
 *
 * The evidence layer answers two questions: "what supports this claim?" and
 * "is what I remember still true?". Both were answered wrongly, and both
 * failures were silent — the graph reported a clean structure and the memory
 * reported a fresh fact.
 *
 *   1. EVICTION LEFT DANGLING EDGES. Dropping a node past `maxNodes` deleted
 *      the node and kept its edges. `related()` then returned edges to ids the
 *      graph no longer held and `snapshot()` serialized them — but `restore()`
 *      checks both endpoints, so it dropped exactly those. Snapshot → restore
 *      was not a round trip. cognition.js persists that snapshot and reloads
 *      it on resume, so a resumed run lost provenance the live run had.
 *      Measured on a 10-node graph pushed 6 past its cap: 9 edges, 6 dangling,
 *      3 surviving the round trip. The first to go are the PREDICTION →
 *      ACTION `predicts` links, which is what drift detection reads.
 *
 *   2. EVICTION WAS FIFO OVER A MAP, so re-recording an existing id kept its
 *      original slot. Both real callers re-use stable ids
 *      (recordVerificationEvent with `verificationId`, cognition with
 *      `pred.id`), so the record being actively updated was the first evicted.
 *
 *   3. PATHS WERE COMPARED AS EXACT STRINGS, in two places that did not agree
 *      with each other or with their own inputs. `worldFromCwd()` keys writes
 *      relative; a live run's writes arrive absolute from tool arguments; and
 *      `filesCited()` — in the same subsystem — emits `./governor.js`. So a
 *      remembered claim about a file that had since changed was served as
 *      current truth whenever the two spellings differed.
 *
 *   4. recordVerificationEvent(graph, null) THREW. `event = {}` only defaults
 *      `undefined`, and the caller wraps it in a try/catch, so the record was
 *      silently dropped rather than skipped.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prov-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const { createEvidenceGraph, recordVerificationEvent } = await import("../evidence-graph.js")
const { isStale, samePath, KIND } = await import("../evidence.js")
const { entryIsStale, filesCited } = await import("../memgraph.js")

// An absolute path built at runtime: test-path-hygiene forbids a machine
// specific one as a literal, and the point here is only that it IS absolute.
const ABS_DIR = path.join(path.sep, "w", "proj")
const ABS_AGENT = path.join(ABS_DIR, "agent.js")

console.log("== 1. eviction does not leave edges behind ==")
{
  const g = createEvidenceGraph({ maxNodes: 10, maxEdges: 100 })
  const ids = []
  for (let i = 0; i < 10; i++) ids.push(g.addNode("CLAIM", { i }, { files: [`f${i}.js`] }))
  for (let i = 1; i < 10; i++) g.link(ids[i - 1], ids[i], "predicts")
  for (let i = 10; i < 16; i++) g.addNode("CLAIM", { i }, { files: [`f${i}.js`] })

  const snap = g.snapshot()
  const live = new Set(snap.nodes.map((n) => n.id))
  const dangling = snap.edges.filter((e) => !live.has(e.from) || !live.has(e.to))
  eq("no edge points at an evicted node (was 6)", dangling.length, 0)
  eq("related() reports nothing for an evicted node", g.related(ids[0]).length, 0)

  const g2 = createEvidenceGraph({ maxNodes: 10, maxEdges: 100 })
  g2.restore(snap)
  const round = g2.snapshot()
  eq("snapshot → restore keeps every edge (was 9 → 3)", round.edges.length, snap.edges.length)
  ok("…and the round trip is byte-stable, which is what resume depends on",
    JSON.stringify(round.edges) === JSON.stringify(snap.edges))
  eq("…and every node too", round.nodes.length, snap.nodes.length)
}

console.log("== 2. the node you keep updating is not the first one dropped ==")
{
  const g = createEvidenceGraph({ maxNodes: 5 })
  for (let i = 0; i < 5; i++) g.addNode("V", { i }, { id: `v${i}` })
  for (let k = 0; k < 3; k++) g.addNode("V", { k }, { id: "v0" })   // v0 is the live one
  g.addNode("V", { n: "new" }, { id: "v9" })
  const ids = g.snapshot().nodes.map((n) => n.id)
  ok("a refreshed node survives (it was evicted despite being newest)", ids.includes("v0"), JSON.stringify(ids))
  ok("…and the genuinely oldest went instead", !ids.includes("v1"), JSON.stringify(ids))
  eq("the cap is still honoured", ids.length, 5)

  // refreshing must not duplicate, and must not cost its edges
  const g2 = createEvidenceGraph({ maxNodes: 5 })
  g2.addNode("A", {}, { id: "a" }); g2.addNode("B", {}, { id: "b" })
  g2.link("a", "b", "supports")
  g2.addNode("A", { updated: true }, { id: "a" })
  eq("re-recording an id does not duplicate it", g2.snapshot().nodes.filter((n) => n.id === "a").length, 1)
  eq("…and keeps the edges it already had", g2.related("a").length, 1)
  eq("…and the update is visible", g2.snapshot().nodes.find((n) => n.id === "a").value.updated, true)
}

console.log("== 3. one path rule, and it is the right one (§36) ==")
{
  const SAME = [["agent.js", ABS_AGENT], ["./agent.js", "agent.js"],
    ["src\\a.js", "src/a.js"], ["a/b/c.js", "c.js"], ["x.js", "x.js"]]
  const DIFF = [["agent.js", "notagent.js"], ["agent.js", "vendor/notagent.js"],
    ["a/b.js", "c/b.js"], ["agent.js", ""], ["", ""], ["agent.js", null]]
  eq("paths that name one file compare equal", SAME.filter(([a, b]) => !samePath(a, b)), [])
  eq("paths that name different files do not", DIFF.filter(([a, b]) => samePath(a, b)), [])

  const graphSrc = fs.readFileSync(new URL("../evidence-graph.js", import.meta.url), "utf8")
  ok("evidence-graph imports the rule rather than copying it",
    /import \{ samePath \} from "\.\/evidence\.js"/.test(graphSrc) && !/function samePath/.test(graphSrc))
}

console.log("== 4. a fact about a changed file is stale, whichever spelling was recorded ==")
{
  const F = (f, w) => isStale({ kind: KIND.FACT, files: [f], asOf: 1000 }, w)
  ok("relative fact vs relative write", F("agent.js", { "agent.js": 2000 }))
  ok("relative fact vs ABSOLUTE write (was false)", F("agent.js", { [ABS_AGENT]: 2000 }))
  ok("relative fact vs ./-prefixed write (was false)", F("agent.js", { "./agent.js": 2000 }))
  ok("absolute fact vs relative write (was false)", F(ABS_AGENT, { "agent.js": 2000 }))
  ok("windows-separated fact vs posix write (was false)", F("src\\a.js", { "src/a.js": 2000 }))

  // and the other direction must not have been traded away
  ok("a write to a DIFFERENT file does not stale it", !F("agent.js", { "vendor/notagent.js": 2000 }))
  ok("…nor a same-basename file in another directory", !F("a/b.js", { "c/b.js": 2000 }))
  ok("a write OLDER than the fact does not stale it", !F("agent.js", { "agent.js": 500 }))
  ok("no writes at all is not stale", !F("agent.js", {}))
  ok("an UNKNOWN claim is never stale", !isStale({ kind: KIND.UNKNOWN, files: ["agent.js"], asOf: 1 }, { "agent.js": 9 }))
  ok("a claim already marked STALE stays stale", isStale({ kind: KIND.STALE }, {}))
  ok("provenance.file counts as a cited file",
    isStale({ kind: KIND.FACT, files: [], asOf: 1000, provenance: { file: ABS_AGENT } }, { "agent.js": 2000 }))

  // the memory path end to end: filesCited emits `./governor.js`, which is
  // exactly the spelling that used to match nothing
  ok("filesCited still extracts a ./-prefixed path", filesCited("see ./governor.js").includes("./governor.js"))
  ok("…and a fact citing it goes stale on a plain write",
    entryIsStale({ text: "see ./governor.js", asOf: 1000 }, { writes: { "governor.js": 2000 } }))
  ok("a memory fact citing agent.js is stale against an absolute write",
    entryIsStale({ text: "agent.js owns the backoff", asOf: 1000 }, { writes: { [ABS_AGENT]: 2000 } }))
  ok("…and is NOT stale when nothing it cites changed",
    !entryIsStale({ text: "agent.js owns the backoff", asOf: 1000 }, { writes: { "unrelated.js": 2000 } }))
}

console.log("== the fuzzy match stays cheap (it runs per memory entry) ==")
{
  const writes = {}
  for (let i = 0; i < 700; i++) writes[`dir${i % 9}/file${i}.js`] = 2000
  const t0 = Date.now()
  let n = 0
  for (let i = 0; i < 500; i++) if (isStale({ kind: KIND.FACT, files: [`dir${i % 9}/file${i}.js`], asOf: 1000 }, writes)) n++
  const ms = Date.now() - t0
  eq("every one of them is correctly stale", n, 500)
  ok(`500 lookups over a 700-key writes map stay fast (${ms}ms)`, ms < 250, `${ms}ms`)
}

console.log("== 5. a null event is skipped, not thrown ==")
{
  const g = createEvidenceGraph()
  let threw = false
  let id = null
  try { id = recordVerificationEvent(g, null) } catch { threw = true }
  ok("recordVerificationEvent(graph, null) does not throw", !threw)
  ok("…and still records something rather than vanishing", !!id)
  ok("recordVerificationEvent(null, event) is still a no-op", recordVerificationEvent(null, { type: "x" }) === null)
  for (const bad of [undefined, 0, "", [], "nope"]) {
    let t2 = false
    try { recordVerificationEvent(g, bad) } catch { t2 = true }
    ok(`recordVerificationEvent(graph, ${JSON.stringify(bad)}) does not throw`, !t2)
  }
  // a passing event is still recorded as passing
  const pid = recordVerificationEvent(g, { type: "VERIFICATION_PASSED", command: "npm test", exitCode: 0, verificationId: "v-1" })
  const node = g.snapshot().nodes.find((n) => n.id === "v-1")
  eq("a passing verification keeps its id and status", [pid, node?.status], ["v-1", "VERIFIED"])
  const fid = recordVerificationEvent(g, { type: "VERIFICATION_FAILED", command: "npm test", exitCode: 1, verificationId: "v-2" })
  eq("and a failing one is not laundered into a pass", g.snapshot().nodes.find((n) => n.id === fid)?.status, "FAILED")
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== evidence-provenance suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
