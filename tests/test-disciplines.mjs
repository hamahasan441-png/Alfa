/**
 * tests/test-disciplines.mjs — the five-discipline axis (v137)
 *
 * WHAT THIS SUITE IS FOR
 *
 * `disciplines.js` sits in a GUARD lane: a red case fails the build. That
 * makes the dangerous failure mode not "a case is wrong" but "a case cannot
 * be wrong" — a probe that passes whatever the code does is furniture, and it
 * is furniture that actively lies, because the lane reports 100%.
 *
 * So the bulk of this suite is NON-VACUITY: for each case, construct the
 * broken world it claims to detect and assert that it says so. Two of the
 * twelve were caught by exactly this during development —
 * `loop-effort-scales-with-task` called `resolveEffort` with an options
 * object when the signature is positional (so both branches returned the
 * default and the case "passed" proving nothing), and
 * `graph-invalidation-is-transitive` asserted only that the graph changed,
 * which is true of a graph that was never completed in the first place.
 */
import assert from "node:assert/strict"

let passed = 0, failed = 0
const ok = (name, cond) => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }
const eq = (name, a, b) => {
  try { assert.deepEqual(a, b); passed++; console.log(`  ok   ${name}`) }
  catch { failed++; console.log(`  FAIL ${name} (got ${JSON.stringify(a)})  — want ${JSON.stringify(b)}`) }
}

const D = await import("../disciplines.js")

console.log("== the axis is well-formed ==")
{
  eq("five disciplines, named once", [...D.DISCIPLINES].sort(), ["context", "graph", "harness", "loop", "prompt"])
  ok("every case declares a known discipline", D.DISCIPLINE_CASES.every((c) => D.DISCIPLINES.includes(c.discipline)))
  ok("every case declares how it is checked", D.DISCIPLINE_CASES.every((c) => ["exercised", "surface", "measured"].includes(c.how)))
  ok("every case declares why it exists", D.DISCIPLINE_CASES.every((c) => typeof c.why === "string" && c.why.length > 20))
  ok("every case id is unique", new Set(D.DISCIPLINE_CASES.map((c) => c.id)).size === D.DISCIPLINE_CASES.length)
  // Each of the five must actually be represented, or the axis has a hole
  // that reads as "nothing to report" rather than "nothing was measured".
  for (const d of D.DISCIPLINES) {
    ok(`discipline "${d}" has at least one case`, D.DISCIPLINE_CASES.some((c) => c.discipline === d))
  }
  // A guard lane of surface checks would be a grep wearing a benchmark's
  // clothes. Most of these must actually run the behaviour.
  const exercised = D.DISCIPLINE_CASES.filter((c) => c.how === "exercised").length
  ok(`most cases are exercised, not surface (${exercised}/${D.DISCIPLINE_CASES.length})`, exercised >= D.DISCIPLINE_CASES.length - 2)
}

console.log("== the lane runs green on this tree ==")
{
  const r = await D.runDisciplines()
  const bad = r.results.filter((x) => !x.ok)
  ok(`all ${r.results.length} cases pass`, bad.length === 0)
  for (const b of bad) console.log(`       ${b.id}: ${b.note}`)
  ok("every result carries its discipline", r.results.every((x) => D.DISCIPLINES.includes(x.discipline)))
  ok("every result carries a note", r.results.every((x) => typeof x.note === "string" && x.note.length > 0))
}

console.log("== slicing by discipline selects, and only selects ==")
{
  for (const d of D.DISCIPLINES) {
    const r = await D.runDisciplines({ only: d })
    ok(`--discipline ${d} runs only ${d}`, r.results.length > 0 && r.results.every((x) => x.discipline === d))
  }
  const multi = await D.runDisciplines({ only: ["prompt", "graph"] })
  ok("an array selects the union", multi.results.every((x) => ["prompt", "graph"].includes(x.discipline)) && multi.results.length > 2)
}

// ── NON-VACUITY ────────────────────────────────────────────────────────────
// Each block below builds the world the case claims to reject and asserts the
// case's own predicate on it. These call the exported helpers rather than the
// case bodies where a helper exists, because a case body reads the real repo
// and cannot be handed a broken one.

console.log("== prompt: the duplicate-skill-block probe can actually fail ==")
{
  const twice = [
    "You are forge",
    "",
    "SKILLS FOR THIS TASK (2) — call load_skill(name) before using one:",
    "- forge-test: run the suite",
    "",
    "SKILLS (call load_skill before using): forge-test, tdd",
  ].join("\n")
  const once = twice.split("\n").slice(0, 4).join("\n")
  eq("two blocks are counted as two", D.skillNamingLines(twice).length, 2)
  eq("one block is counted as one", D.skillNamingLines(once).length, 1)
  eq("no block is counted as none", D.skillNamingLines("You are forge\n\nRULES:\n1. think"), [])
  // Must not be fooled by prose that merely mentions skills — a case that
  // counted those would be red on every prompt regardless of duplication.
  eq("prose mentioning skills is not a naming block",
    D.skillNamingLines("Use load_skill to load skills. The skills directory holds skills.").length, 0)
}

console.log("== prompt: the cache-prefix probe can actually fail ==")
{
  const good = "You are forge\nRULES:\n1. think\n\nTOOLS — all available, use them automatically:\n- todo\n\nTASK-SPECIFIC BLOCK"
  const pre = D.stablePrefix(good)
  ok("a prefix is found and stops before the task-specific block", pre !== null && !pre.includes("TASK-SPECIFIC"))
  ok("the prefix includes the TOOLS block itself", pre.includes("TOOLS — all available"))
  eq("a prompt with no TOOLS block reports no prefix", D.stablePrefix("You are forge\nRULES:"), null)
  // The property under test: two prompts that differ only AFTER the marker
  // share a prefix; two that differ before it do not.
  const other = good.replace("TASK-SPECIFIC BLOCK", "A DIFFERENT TASK BLOCK")
  ok("differing only after TOOLS keeps the prefix identical", D.stablePrefix(good) === D.stablePrefix(other))
  const leaked = good.replace("You are forge", "You are forge, working on task XYZ")
  ok("task text above TOOLS breaks the prefix", D.stablePrefix(good) !== D.stablePrefix(leaked))
}

console.log("== prompt: the build budget is a real budget, not a stopwatch ==")
{
  // v133 learned this on boot-budget: a budget compared against the CURRENT
  // host's measurement always passes on a fast machine and proves nothing.
  // The budget must sit below the recorded baseline, which is a constant.
  ok("the budget is below the v136 baseline", D.PROMPT_BUILD_BUDGET_MS < D.PROMPT_BUILD_BASELINE_MS)
  ok("the baseline is the real v136 measurement", D.PROMPT_BUILD_BASELINE_MS === 172)
  // Headroom: tight enough to catch the regression, loose enough that a
  // loaded runner does not redden a guard lane.
  ok("the budget leaves room above the measured floor", D.PROMPT_BUILD_BUDGET_MS >= 60)
}

console.log("== loop: the effort probe is asserted on the adaptive profile ==")
{
  const { resolveEffort, classifyTaskComplexity } = await import("../agent.js")
  // The bug this pins: calling resolveEffort with an OPTIONS OBJECT hits the
  // `default` branch for every input, so both sides come back {deep:false}
  // and "effort scales" passes on a function that never adapted.
  const wrong = resolveEffort({ task: "anything" })
  eq("an options object falls to the default profile", wrong.why, "profile=balanced")
  ok("...and so cannot distinguish trivial from critical",
    resolveEffort({ task: "x" }).deep === resolveEffort({ task: "y" }).deep)
  // The correct, positional call DOES distinguish them.
  ok("auto adapts to a trivial task", resolveEffort("auto", "fix a typo in the README").deep === false)
  ok("auto adapts to a critical task", resolveEffort("auto", "refactor the authentication layer across every service and migrate the schema").deep === true)
  ok("fixed profiles stay fixed", resolveEffort("fast", "refactor everything").deep === false && resolveEffort("deep", "typo").deep === true)
  ok("the two fixtures really are different complexities",
    classifyTaskComplexity("fix a typo in the README") !== classifyTaskComplexity("refactor the authentication layer across every service and migrate the schema"))
}

console.log("== harness: the schema probe rejects the schemas it claims to ==")
{
  // Re-implements the case's predicate over HAND-BROKEN defs, because the
  // case itself reads the real TOOL_DEFS and they are (correctly) valid.
  const judge = (defs) => {
    const bad = []
    for (const t of defs) {
      const f = t?.function
      if (!f?.name) { bad.push("unnamed"); continue }
      if (t.type !== "function") { bad.push(f.name); continue }
      if (!f.description || typeof f.description !== "string") { bad.push(f.name); continue }
      const p = f.parameters
      if (!p || p.type !== "object" || !p.properties || typeof p.properties !== "object") { bad.push(f.name); continue }
      const undeclared = (p.required ?? []).filter((k) => !Object.hasOwn(p.properties, k))
      if (undeclared.length) bad.push(f.name)
    }
    return bad
  }
  const good = { type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } }
  eq("a valid schema is accepted", judge([good]), [])
  eq("a required key with no property is caught",
    judge([{ ...good, function: { ...good.function, parameters: { type: "object", properties: {}, required: ["a"] } } }]), ["t"])
  eq("a missing description is caught", judge([{ ...good, function: { ...good.function, description: "" } }]), ["t"])
  eq("a non-object parameters is caught", judge([{ ...good, function: { ...good.function, parameters: { type: "string" } } }]), ["t"])
  eq("a missing name is caught", judge([{ type: "function", function: {} }]), ["unnamed"])
}

console.log("== harness: extended thinking is shaped per model, not per habit ==")
{
  const prov = await import("../providers.js")
  // Version parsing — both naming schemes Anthropic has used.
  eq("current naming, major only", prov.anthropicModelVersion("claude-opus-5"), 5)
  eq("current naming, major.minor", prov.anthropicModelVersion("claude-opus-4-8"), 4.8)
  eq("fable parses too", prov.anthropicModelVersion("claude-fable-5-1"), 5.1)
  eq("dotted minor parses", prov.anthropicModelVersion("claude-sonnet-4.6"), 4.6)
  eq("OLD naming put the version first", prov.anthropicModelVersion("claude-3-5-sonnet-latest"), 3.5)
  eq("an unparseable id is null", prov.anthropicModelVersion("gpt-4o"), null)

  // The split itself. 4.6 is the boundary and is INCLUSIVE of adaptive.
  eq("the boundary is 4.6", prov.ADAPTIVE_THINKING_MIN_VERSION, 4.6)
  ok("4.6 takes adaptive", prov.thinkingParamFor("claude-sonnet-4-6", 16384).type === "adaptive")
  ok("4.5 takes a budget", prov.thinkingParamFor("claude-haiku-4-5", 16384).type === "enabled")

  // The regression that motivated this: forge's OWN defaults.
  for (const m of ["claude-sonnet-5", "claude-opus-4-8"]) {
    const t = prov.thinkingParamFor(m, 16384)
    ok(`${m} (a forge default) does NOT send budget_tokens`, t.type === "adaptive" && t.budget_tokens === undefined)
  }
  // Non-vacuity: the function must not simply return adaptive for everything,
  // or "4.7+ is fixed" would be true of a function that broke every old model.
  const oldOne = prov.thinkingParamFor("claude-opus-4-1", 16384)
  ok("pre-4.6 still gets a real budget", oldOne.type === "enabled" && oldOne.budget_tokens >= 1024)
  ok("...and the budget leaves room for the answer", oldOne.budget_tokens <= 8000)
  // An unknown id prefers the form every currently-served model accepts.
  ok("an unknown model gets adaptive", prov.thinkingParamFor("claude-something-new", 16384).type === "adaptive")
}

console.log("== context: the compaction guard admits and refuses the right shapes ==")
{
  const { guardCompaction } = await import("../compaction.js")
  const before = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "out" },
  ]
  const orphaned = before.filter((m) => m.role !== "tool")
  const g1 = guardCompaction(before, orphaned)
  ok("an orphaned tool call is refused", g1.refused === true)
  ok("...and the ORIGINAL is handed back, not the broken one", g1.messages === before)
  const shrunk = before.map((m) => m.role === "tool" ? { ...m, content: "…" } : m)
  const g2 = guardCompaction(before, shrunk)
  ok("a well-formed shrink is accepted", g2.refused === false && g2.messages === shrunk)
  // The guard must not refuse everything — that would be a disabled feature
  // that still reports as enabled.
  ok("the guard is not simply always-refusing", g1.refused !== g2.refused)
}

console.log("== context: compaction fires on pressure and only on pressure ==")
{
  const { compactHistory } = await import("../compaction.js")
  const mk = (n) => {
    const m = [{ role: "system", content: "s" }, { role: "user", content: "u" }]
    for (let i = 0; i < n; i++) {
      m.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] })
      m.push({ role: "tool", tool_call_id: `c${i}`, content: "output line ".repeat(50) })
    }
    return m
  }
  // Both halves are needed for the pair to mean anything: a compactor that
  // never fires passes the first, one that always fires passes the second.
  const small = await compactHistory(mk(20), { window: 128000 })
  ok("a history well inside the window is left alone", small.changed === false)
  const big = await compactHistory(mk(400), { window: 128000 })
  ok("a history over the fold threshold IS compacted", big.changed === true)
  ok("...and says which stage did it", typeof big.stats?.stage === "string" && big.stats.stage !== "none")
  // Whatever it did must still be sendable — the guard's job, checked end to end.
  const { historyIsWellFormed } = await import("../compaction.js")
  ok("the compacted history is still well-formed", historyIsWellFormed(big.messages))
  ok("...and is actually shorter", big.messages.length < mk(400).length)
}

console.log("== graph: the world cache is a cache, and it invalidates ==")
{
  const { worldFromCwd, clearWorldCache } = await import("../memgraph.js")
  clearWorldCache()
  const a = worldFromCwd(process.cwd())
  ok("a second call reuses the first world", worldFromCwd(process.cwd()) === a)
  clearWorldCache()
  ok("clearWorldCache forces a rebuild", worldFromCwd(process.cwd()) !== a)
  ok("...and the rebuilt world says the same thing",
    Object.keys(worldFromCwd(process.cwd()).writes).length === Object.keys(a.writes).length)
}

console.log("== graph: transitive invalidation is asserted on a COMPLETED chain ==")
{
  const dag = await import("../dag.js")
  const mk = () => dag.buildDAG([
    { id: "a", objective: "a", dependencies: [] },
    { id: "b", objective: "b", dependencies: ["a"] },
    { id: "c", objective: "c", dependencies: ["b"] },
  ])
  // The vacuity this pins: on a FRESH graph, c is already not-completed, so
  // "c is not completed after invalidating a" is true without any
  // invalidation happening at all.
  const fresh = mk()
  ok("on a fresh graph c is already not completed (so the naive assertion is vacuous)",
    fresh.nodes.get("c").status !== dag.NODE_STATUS.COMPLETED)

  const g = mk()
  for (const id of ["a", "b", "c"]) {
    g.nodes.get(id).status = dag.NODE_STATUS.READY
    dag.markRunning(g, id)
    dag.markExecutionSucceeded(g, id)
    dag.markCompleted(g, id, null, { requireVerification: false })
  }
  ok("the chain really did reach all-completed",
    [...g.nodes.values()].every((n) => n.status === dag.NODE_STATUS.COMPLETED))
  dag.invalidateNodes(g, ["a"], { reason: "test" })
  ok("the direct dependent is invalidated", g.nodes.get("b").status !== dag.NODE_STATUS.COMPLETED)
  ok("the GRANDCHILD is invalidated too (transitive)", g.nodes.get("c").status !== dag.NODE_STATUS.COMPLETED)
}

console.log("== graph: a cycle is refused rather than silently un-edged ==")
{
  const dag = await import("../dag.js")
  let threw = null
  try {
    dag.buildDAG([
      { id: "a", objective: "a", dependencies: ["c"] },
      { id: "b", objective: "b", dependencies: ["a"] },
      { id: "c", objective: "c", dependencies: ["b"] },
    ])
  } catch (e) { threw = String(e?.message ?? e) }
  ok("a 3-node cycle throws", threw !== null)
  ok("...and says it is a cycle", /cycle/i.test(threw ?? ""))
  // Non-vacuity: the same shape WITHOUT the back-edge must build fine, or
  // "throws" would just mean buildDAG is broken.
  let acyclicOk = true
  try {
    dag.buildDAG([
      { id: "a", objective: "a", dependencies: [] },
      { id: "b", objective: "b", dependencies: ["a"] },
      { id: "c", objective: "c", dependencies: ["b"] },
    ])
  } catch { acyclicOk = false }
  ok("the same chain without the back-edge builds", acyclicOk)
}

console.log("== the lane is wired into the suite as a GUARD ==")
{
  const { GUARD_LANES, LANE } = await import("../benchsuite.js")
  ok("discipline is a lane", LANE.DISCIPLINE === "discipline")
  ok("discipline guards the exit code", GUARD_LANES.has(LANE.DISCIPLINE))
  ok("programme still does not", !GUARD_LANES.has(LANE.PROGRAMME))
  // The axis must actually span lanes, or it is just a lane with a new name.
  const { PROGRAMME_CASES } = await import("../benchsuite.js")
  const tagged = PROGRAMME_CASES.filter((c) => c.discipline)
  ok(`programme cases carry discipline tags (${tagged.length})`, tagged.length >= 10)
  ok("every programme tag is a known discipline", tagged.every((c) => D.DISCIPLINES.includes(c.discipline)))
}

console.log(`== disciplines suite: ${passed} passed, ${failed} failed ==`)
process.exit(failed ? 1 : 0)
