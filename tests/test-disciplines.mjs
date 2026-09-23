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

  // REVIEW ESCAPE 1 — the tenth minor. `Number("4.10")` is 4.1, so a decimal
  // comparison put claude-opus-4-10 BELOW the 4.6 boundary and sent it the
  // rejected shape. Being right about models that do not exist yet is the
  // entire reason this parses instead of matching a table.
  ok("4.10 is newer than 4.6, not older", prov.thinkingParamFor("claude-opus-4-10", 16384).type === "adaptive")
  ok("4.9 is still adaptive", prov.thinkingParamFor("claude-opus-4-9", 16384).type === "adaptive")
  ok("4.5 is still budgeted (the boundary did not move)", prov.thinkingParamFor("claude-opus-4-5", 16384).type === "enabled")
  ok("3.10 would still be budgeted", prov.thinkingParamFor("claude-opus-3-10", 16384).type === "enabled")
  // The exported decimal is for REPORTING and is allowed to be lossy; the
  // boundary must not be computed from it.
  eq("the reported version stays a decimal", prov.anthropicModelVersion("claude-opus-4-10"), 4.1)
}

console.log("== harness: BOTH Anthropic paths resolve thinking the same way ==")
{
  // REVIEW ESCAPE 2 — streamAnthropic was fixed and chatOnceInner was not, so
  // deep mode kept 400ing on the non-streaming path. The original grep that
  // "confirmed one occurrence" had been truncated by `head`.
  const fs = await import("node:fs")
  const src = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  const rawLiterals = [...src.matchAll(/budget_tokens:\s*Math\./g)].length
  eq("the budget literal is constructed in exactly ONE place", rawLiterals, 1)
  const helperUses = [...src.matchAll(/thinkingParamFor\(model,\s*maxTokens\)/g)].length
  ok(`both request builders call the helper (${helperUses} call sites)`, helperUses >= 2)
  // And the one literal must live inside thinkingParamFor, not in a caller.
  const fnAt = src.indexOf("export function thinkingParamFor")
  const litAt = src.search(/budget_tokens:\s*Math\./)
  ok("...and that one literal is inside thinkingParamFor", litAt > fnAt && fnAt !== -1)
}

console.log("== prompt: the cases build a prompt from the REAL config ==")
{
  // REVIEW ESCAPE 3 — `loadConfig(explicitPath)` takes a config FILE path and
  // returns {config, sources, ignored}. Passing `cwd` meant readJson failed
  // on a directory AND the wrapper went to agentSystemPrompt as its config,
  // where every lookup read undefined. The prompt still built, so nothing
  // complained — the cases were measuring a prompt no run would produce.
  const { loadConfig } = await import("../config.js")
  const wrapper = loadConfig()
  ok("loadConfig returns a wrapper, not a config", "config" in wrapper && wrapper.skills === undefined)
  ok("...and the config is inside it", typeof wrapper.config === "object" && wrapper.config.skills !== undefined)
  // Passing a directory is not merely useless, it silently yields defaults.
  const fromDir = loadConfig(process.cwd())
  ok("loadConfig(<a directory>) does not throw, it silently defaults", typeof fromDir?.config === "object")
  // The source must not reintroduce it.
  const fs = await import("node:fs")
  const src = fs.readFileSync(new URL("../disciplines.js", import.meta.url), "utf8")
  ok("disciplines.js never calls loadConfig(cwd)", !/loadConfig\(cwd\)/.test(src))
  ok("disciplines.js unwraps .config", /loadConfig\(\)\.config|\{ config \} = loadConfig\(\)/.test(src))
}

console.log("== the benchmark refuses to report a run that ran nothing ==")
{
  // REVIEW ESCAPE 4 — this is the v133.1 hole reopened by this release's own
  // slice logic. `--lane capability --discipline prompt` selects a lane the
  // slice skips, so nothing ran and the summary read `0/0 score 0%,
  // regressed:false` and exited 0. The flag validation in forge.js checks
  // each flag ALONE; the emptiness is in the intersection.
  const { runSuite } = await import("../benchsuite.js")
  let threw = null
  try { await runSuite({ cwd: process.cwd(), only: ["capability"], discipline: ["prompt"] }) }
  catch (e) { threw = String(e?.message ?? e) }
  ok("an empty lane/discipline intersection throws", threw !== null)
  ok("...and the message names both sides", /capability/.test(threw ?? "") && /prompt/.test(threw ?? ""))
  // Non-vacuity: a selection that DOES intersect must still run normally.
  const good = await runSuite({ cwd: process.cwd(), only: ["discipline"], discipline: ["prompt"] })
  ok("a selection that does intersect still runs", good.total > 0)
}

console.log("== harness: prompt-cache breakpoints are placed once, for both paths ==")
{
  const prov = await import("../providers.js")
  const conversation = () => ({
    model: "m", system: "SYS",
    tools: [{ name: "a" }, { name: "b" }],
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "o" }] },
    ],
  })
  const b = prov.applyAnthropicCaching(conversation())
  ok("the last TOOL is a breakpoint", Boolean(b.tools.at(-1).cache_control))
  ok("...and earlier tools are not", !b.tools[0].cache_control)
  ok("a string system becomes a block array with a breakpoint",
    Array.isArray(b.system) && b.system.at(-1).cache_control?.type === "ephemeral" && b.system[0].text === "SYS")
  ok("the conversation TAIL is a breakpoint", Boolean(b.messages.at(-1).content.at(-1).cache_control))
  // Anthropic allows at most four; three leaves room for a caller's own.
  const count = [
    b.tools.at(-1).cache_control, b.system.at(-1).cache_control,
    b.messages.at(-1).content.at(-1).cache_control,
  ].filter(Boolean).length
  eq("exactly three breakpoints (limit is four)", count, 3)

  // A cache WRITE costs 1.25x. Marking a tail nothing will read is a pure
  // surcharge, so a one-shot call must not get one.
  const oneShot = prov.applyAnthropicCaching({ model: "m", system: "s", tools: [{ name: "a" }], messages: [{ role: "user", content: "hi" }] })
  ok("a one-shot call does NOT mark the tail", typeof oneShot.messages[0].content === "string")
  ok("...but still caches tools and system", Boolean(oneShot.tools.at(-1).cache_control) && Boolean(oneShot.system.at(-1).cache_control))

  // A PLAIN STRING TAIL IS LEFT ALONE. Rewriting it into a block array to
  // carry the mark broke the e2e agent loop on the Anthropic wire: forge's
  // governor turn is identified by `typeof content === "string"`, so the
  // converted turn stopped being recognised and the mock saw the directive
  // instead of the tool result it was meant to answer.
  const strTail = prov.applyAnthropicCaching({ model: "m", messages: [
    { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
  ] })
  eq("a plain string tail keeps its shape", strTail.messages.at(-1).content, "c")

  // ...and the mark lands on the last BLOCK ARRAY instead — in an agent loop
  // that is the tool_result, which is where the bytes are. The governor's
  // short, rewritten-every-step directive would have been a surcharge.
  const govTail = prov.applyAnthropicCaching({ model: "m", messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "BIG OUTPUT" }] },
    { role: "user", content: "(governor) keep going" },
  ] })
  eq("the governor's string turn is untouched", govTail.messages.at(-1).content, "(governor) keep going")
  ok("the tool_result carries the breakpoint instead",
    Boolean(govTail.messages[2].content.at(-1).cache_control))
  ok("...and only one message-level breakpoint exists",
    govTail.messages.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control)).length === 1)

  // Degenerate inputs must not throw — this runs on every request.
  ok("no tools/system/messages is survivable", Boolean(prov.applyAnthropicCaching({ model: "m" })))
  ok("empty arrays are survivable", Boolean(prov.applyAnthropicCaching({ model: "m", tools: [], messages: [], system: "" })))
  ok("a non-object is returned unchanged", prov.applyAnthropicCaching(null) === null)

  // THE STRUCTURAL GUARD. v89's caching reached only streamAnthropic; the
  // agent loop calls chatOnce, so the path that mattered had none. Both
  // builders must go through the one helper, and no builder may hand-roll it.
  const fs = await import("node:fs")
  const src = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  eq("no request builder constructs a cache_control literal inline",
    [...src.matchAll(/cache_control:\s*\{\s*type:\s*"ephemeral"\s*\}/g)].length, 0)
  ok("both builders call applyAnthropicCaching",
    [...src.matchAll(/applyAnthropicCaching\(body\)/g)].length >= 2)
  // ...and specifically the non-streaming one, which is the agent's path.
  const inner = src.slice(src.indexOf("async function chatOnceInner"))
  ok("chatOnceInner — the agent's own path — caches", inner.includes("applyAnthropicCaching(body)"))
}

console.log("== harness: cache accounting is honest, and a dead cache is loud ==")
{
  const prov = await import("../providers.js")
  const n = prov.normalizeAnthropicUsage

  // THE BUG v138 CREATED. `prompt_tokens` came from `input_tokens` alone,
  // which with caching on is only the uncached TAIL — so the better the cache
  // worked, the smaller forge claimed its prompts were.
  const cached = n({ input_tokens: 120, cache_read_input_tokens: 7000, cache_creation_input_tokens: 450, output_tokens: 90 })
  eq("prompt_tokens is the WHOLE input", cached.prompt_tokens, 7570)
  ok("...not the uncached tail", cached.prompt_tokens !== 120)
  eq("the breakdown rides alongside", [cached.cache_read_tokens, cached.cache_write_tokens, cached.uncached_tokens], [7000, 450, 120])
  eq("completion passes through", cached.completion_tokens, 90)

  // A provider that never mentions caching must not be given cache fields —
  // that would read as a 0% hit rate rather than "not applicable".
  const plain = n({ input_tokens: 5000, output_tokens: 9 })
  eq("a non-caching provider keeps its number", plain.prompt_tokens, 5000)
  ok("...and gets no invented cache fields", plain.cache_read_tokens === undefined && plain.cache_write_tokens === undefined)
  // Degenerate input must not throw — this runs on every response.
  ok("missing usage is survivable", n(undefined).prompt_tokens === undefined)
  ok("a non-object is survivable", n("nonsense").prompt_tokens === undefined)

  // THE DIAGNOSTIC. Placing breakpoints is not the same as getting hits, and
  // the failure mode is silent: same answers, no error, full price forever.
  const h = prov.cacheHealth
  eq("no cache fields -> unknown, not a fault", h({ steps: 5, sawCacheFields: false }).state, "unknown")
  eq("step 1 is cold, not broken (it can only write)", h({ steps: 1, written: 7000, sawCacheFields: true }).state, "cold")
  eq("step 2 is still cold", h({ steps: 2, written: 7000, sawCacheFields: true }).state, "cold")
  eq("written-but-never-read is named", h({ steps: 6, written: 42000, sawCacheFields: true }).state, "never-read")
  eq("reads happening -> ok", h({ steps: 6, read: 35000, written: 7000, sawCacheFields: true }).state, "ok")
  // Non-vacuity: "never-read" must not fire on a healthy cache, and "ok" must
  // not fire on a dead one — each alone would be a constant.
  ok("the two verdicts are actually different",
    h({ steps: 6, written: 42000, sawCacheFields: true }).state !== h({ steps: 6, read: 1, written: 42000, sawCacheFields: true }).state)
  const ratio = h({ steps: 6, read: 35000, written: 7000, uncached: 600, sawCacheFields: true }).ratio
  ok("the ratio is a share of total input", ratio > 0.8 && ratio < 0.83)
  ok("every verdict explains itself", ["unknown", "cold", "never-read", "ok"].every((s) =>
    typeof h({ steps: s === "cold" ? 1 : 6, read: s === "ok" ? 5 : 0, written: 10, sawCacheFields: s !== "unknown" }).why === "string"))

  // The agent must actually consume this, or it is a library nobody calls.
  const fs = await import("node:fs")
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("agent.js imports cacheHealth", /import \{[^}]*cacheHealth[^}]*\} from "\.\/providers\.js"/.test(src))
  ok("agent.js accumulates the cache breakdown", src.includes("cache_read_tokens") && src.includes("cacheUsage"))
  ok("agent.js emits a warning when the cache is never read", src.includes("cache_ineffective"))
  ok("...exactly once per run", src.includes("cacheUsage.warned"))
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
