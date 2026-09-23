#!/usr/bin/env node
/**
 * forge v146 — the cache that silently isn't there.
 *
 * Two ways a `cache_control` breakpoint does nothing at all, both recorded in
 * Anthropic's own documentation, neither producing an error:
 *
 *   THE LOOKBACK. "Each breakpoint walks backward at most 20 positions to find
 *   a prior cache entry." Past that it finds nothing and misses. A run of
 *   consecutive `tool_use` blocks counts as ONE position, and so does a run of
 *   consecutive `tool_result` blocks — so many PARALLEL tool calls are cheap,
 *   and sequential DEPTH is what pushes the previous entry out of range. A long
 *   sequential tool loop is exactly forge's shape.
 *
 *   THE MINIMUM. Below a model-dependent floor nothing caches at all: 512
 *   tokens on the newest models, 4096 on Opus 4.6 and Haiku 4.5. Not
 *   monotonic across generations, so a prompt that caches on Opus 5 silently
 *   will not on Opus 4.6.
 *
 * Both fail the same way — full price on every step, forever, with no signal —
 * and they need opposite responses. The first is a real invalidation to fix;
 * the second means there was never an entry to invalidate. Telling them apart
 * is why `cacheHealth` learned a new state.
 *
 * What this suite must NOT do is assert that markers are placed. v138 already
 * pins that, and it would pass on code that places them where the lookback
 * cannot reach.
 */
import fs from "node:fs"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const P = await import("../providers.js")
const {
  cachePositions, cacheMinimumFor, applyAnthropicCaching, cacheHealth,
  CACHE_LOOKBACK_POSITIONS, CACHE_STRIDE_POSITIONS, CACHE_MINIMUM_DEFAULT, MAX_CACHE_BREAKPOINTS,
} = P

/** Every breakpoint in a body, as "where.type" labels. */
const marks = (body) => {
  const out = []
  ;(body.tools ?? []).forEach((t, i) => { if (t?.cache_control) out.push(`tools[${i}]`) })
  ;(Array.isArray(body.system) ? body.system : []).forEach((b, i) => { if (b?.cache_control) out.push(`system[${i}]`) })
  ;(body.messages ?? []).forEach((m, i) => {
    if (!Array.isArray(m?.content)) return
    m.content.forEach((b, j) => { if (b?.cache_control) out.push(`msg${i}.${j}:${b.type}`) })
  })
  return out
}
/** A conversation of `depth` SEQUENTIAL tool round-trips. */
const sequentialLoop = (depth) => {
  const msgs = [{ role: "user", content: "start" }]
  for (let i = 0; i < depth; i++) {
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: {} }] })
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "out" }] })
  }
  return msgs
}
const bodyFor = (messages) => ({
  model: "claude-opus-5", system: "S".repeat(8000),
  tools: [{ name: "a" }, { name: "b" }],
  messages: JSON.parse(JSON.stringify(messages)),
})

console.log("== positions are counted the way the lookback counts them ==")
{
  eq("the window is Anthropic's 20", CACHE_LOOKBACK_POSITIONS, 20)
  ok("the stride leaves room under it", CACHE_STRIDE_POSITIONS < CACHE_LOOKBACK_POSITIONS)

  eq("nothing is nothing", cachePositions([]), 0)
  eq("a string message is one position", cachePositions([{ role: "user", content: "hi" }]), 1)
  eq("two text blocks are two positions",
    cachePositions([{ role: "user", content: [{ type: "text" }, { type: "text" }] }]), 2)

  // The rule that makes forge's normal shape safe.
  const parallel = [{ role: "assistant", content: Array.from({ length: 40 }, (_, i) => ({ type: "tool_use", id: `p${i}` })) }]
  eq("forty PARALLEL tool_use blocks are ONE position", cachePositions(parallel), 1)
  const results = [{ role: "user", content: Array.from({ length: 40 }, (_, i) => ({ type: "tool_result", tool_use_id: `p${i}` })) }]
  eq("…and forty tool_results are one more", cachePositions([...parallel, ...results]), 2)

  // A run ends when the type changes, so these do NOT collapse together.
  eq("tool_use then tool_result is two, not one",
    cachePositions([{ role: "user", content: [{ type: "tool_use" }, { type: "tool_result" }] }]), 2)
  eq("a run broken by text is three",
    cachePositions([{ role: "user", content: [{ type: "tool_use" }, { type: "text" }, { type: "tool_use" }] }]), 3)
  // Runs do not span messages either — each message's blocks are their own.
  eq("a tool_use run continues across messages only if adjacent",
    cachePositions([
      { role: "assistant", content: [{ type: "tool_use" }] },
      { role: "assistant", content: [{ type: "tool_use" }] },
    ]), 1)

  // Sequential depth, which is what actually threatens the window.
  eq("ten sequential round-trips are 21 positions", cachePositions(sequentialLoop(10)), 21)
  ok("…which is already past the window", cachePositions(sequentialLoop(10)) > CACHE_LOOKBACK_POSITIONS)
}

console.log("== a long sequential loop gets a bridge back into range ==")
{
  const deep = bodyFor(sequentialLoop(14))
  const before = cachePositions(deep.messages)
  ok("the conversation is past the lookback", before > CACHE_LOOKBACK_POSITIONS, `${before} positions`)
  applyAnthropicCaching(deep, { model: "claude-opus-5" })
  const m = marks(deep)
  ok("tools are still cached", m.some((x) => x.startsWith("tools")), JSON.stringify(m))
  ok("system is still cached", m.some((x) => x.startsWith("system")), JSON.stringify(m))
  const msgMarks = m.filter((x) => x.startsWith("msg"))
  eq("there are TWO message breakpoints now — the tail and a bridge", msgMarks.length, 2)
  ok("never more than Anthropic's four in total", m.length <= MAX_CACHE_BREAKPOINTS, JSON.stringify(m))

  // The bridge has to be reachable: the distance from the end to it must be
  // inside the window, or it is decoration.
  const idx = deep.messages.findIndex((x) => Array.isArray(x.content) && x.content.some((b) => b?.cache_control))
  const fromBridgeToEnd = cachePositions(deep.messages.slice(idx))
  ok(`the bridge is within the window of the end (${fromBridgeToEnd} positions)`,
    fromBridgeToEnd <= CACHE_LOOKBACK_POSITIONS, `${fromBridgeToEnd} > ${CACHE_LOOKBACK_POSITIONS}`)
  ok("…and far enough back to be worth a slot", fromBridgeToEnd >= CACHE_STRIDE_POSITIONS - 1)
}

console.log("== a PARALLEL-heavy turn does not spend a slot on a bridge it doesn't need ==")
{
  // 40 calls and 40 results — visually enormous, three positions. Spending a
  // breakpoint here would take one from somewhere that needs it.
  const wide = bodyFor([
    { role: "user", content: "go" },
    { role: "assistant", content: Array.from({ length: 40 }, (_, i) => ({ type: "tool_use", id: `p${i}` })) },
    { role: "user", content: Array.from({ length: 40 }, (_, i) => ({ type: "tool_result", tool_use_id: `p${i}` })) },
  ])
  applyAnthropicCaching(wide, { model: "claude-opus-5" })
  const msgMarks = marks(wide).filter((x) => x.startsWith("msg"))
  eq("one message breakpoint — the tail, and no bridge", msgMarks.length, 1)

  const short = bodyFor(sequentialLoop(3))
  applyAnthropicCaching(short, { model: "claude-opus-5" })
  eq("a short conversation gets no bridge either", marks(short).filter((x) => x.startsWith("msg")).length, 1)
}

console.log("== the budget is never exceeded, however long the turn ==")
{
  for (const depth of [1, 5, 10, 14, 30, 60]) {
    const b = bodyFor(sequentialLoop(depth))
    applyAnthropicCaching(b, { model: "claude-opus-5" })
    const n = marks(b).length
    ok(`depth ${depth}: ${n} breakpoints`, n <= MAX_CACHE_BREAKPOINTS, JSON.stringify(marks(b)))
  }
  // A caller that already spent the budget gets nothing added, not a fifth —
  // and a fifth is not a warning, it fails the whole request.
  const full = bodyFor(sequentialLoop(14))
  full.tools[1].cache_control = { type: "ephemeral" }
  full.system = [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }]
  full.messages[1].content[0].cache_control = { type: "ephemeral" }
  full.messages[3].content[0].cache_control = { type: "ephemeral" }
  eq("the fixture starts exactly at the limit", marks(full).length, MAX_CACHE_BREAKPOINTS)
  applyAnthropicCaching(full, { model: "claude-opus-5" })
  eq("…and nothing is added to it", marks(full).length, MAX_CACHE_BREAKPOINTS)
}

console.log("== the per-model minimum, which is not monotonic ==")
{
  eq("Opus 5", cacheMinimumFor("claude-opus-5"), 512)
  eq("Fable 5.1", cacheMinimumFor("claude-fable-5-1"), 512)
  eq("Mythos 5", cacheMinimumFor("claude-mythos-5"), 512)
  eq("Opus 4.8", cacheMinimumFor("claude-opus-4-8"), 1024)
  eq("Sonnet 5", cacheMinimumFor("claude-sonnet-5"), 1024)
  eq("Sonnet 4.6", cacheMinimumFor("claude-sonnet-4-6"), 1024)
  eq("Opus 4.7", cacheMinimumFor("claude-opus-4-7"), 2048)
  eq("Haiku 3.5", cacheMinimumFor("claude-haiku-3-5"), 2048)
  eq("Opus 4.6", cacheMinimumFor("claude-opus-4-6"), 4096)
  eq("Opus 4.5", cacheMinimumFor("claude-opus-4-5"), 4096)
  eq("Haiku 4.5", cacheMinimumFor("claude-haiku-4-5"), 4096)

  // The trap, stated as a test: NEWER is not always lower.
  ok("Opus 4.6 demands MORE than Opus 5, three generations later",
    cacheMinimumFor("claude-opus-4-6") > cacheMinimumFor("claude-opus-5"))
  ok("…and more than Opus 4.7", cacheMinimumFor("claude-opus-4-6") > cacheMinimumFor("claude-opus-4-7"))

  // Family patterns must not swallow the exceptions.
  ok("opus-4-6 is not matched by the opus-5 rule", cacheMinimumFor("claude-opus-4-6") !== 512)
  // Honest about what these assertions can and cannot catch: the 4096 models
  // share their value with the default, so removing their rule leaves the
  // answer unchanged and no assertion here would notice. That is acceptable
  // precisely because 4096 IS the safe fall-through — a lost rule costs
  // nothing. The rules that matter are the ones BELOW the default, and those
  // are distinguishable: dropping Opus 4.7's or Opus 5's rule changes the
  // answer and fails above. (Verified by mutation, not assumed.)
  eq("an unknown model gets the WORST case, not the best", cacheMinimumFor("who-knows"), CACHE_MINIMUM_DEFAULT)
  ok("every rule below the default is distinguishable from it",
    [["claude-opus-5", 512], ["claude-opus-4-8", 1024], ["claude-opus-4-7", 2048]]
      .every(([m, v]) => cacheMinimumFor(m) === v && v !== CACHE_MINIMUM_DEFAULT))
  eq("…and so does no model at all", cacheMinimumFor(undefined), 4096)
  ok("the default IS the worst case forge knows of", CACHE_MINIMUM_DEFAULT === 4096)
}

console.log("== marking still happens below the minimum, on purpose ==")
{
  // The first cut of v146 SKIPPED marking under the minimum and v89's suite
  // caught it. Marking below the minimum is free — the API ignores it — while
  // skipping rests on a bytes/4 estimate that UNDERSTATES tokens for code,
  // JSON and CJK. An underestimate would drop a marker from a prompt that
  // would have cached, silently costing money: the exact failure this release
  // exists to remove.
  const tiny = { model: "claude-opus-4-6", system: "s", tools: [{ name: "a" }], messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "yo" }] },
  ] }
  applyAnthropicCaching(tiny, { model: "claude-opus-4-6" })
  ok("a tiny prompt on a 4096-minimum model is still marked", marks(tiny).length > 0, JSON.stringify(marks(tiny)))
  ok("no estimate is recorded on the body", tiny._cacheSkipped === undefined)
  const src = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  ok("and nothing in the builder returns early on a size estimate",
    !/approxTokens\s*<\s*min/.test(src))
}

console.log("== cacheHealth can tell 'never created' from 'never read' ==")
{
  // Identical counters, opposite advice. Without the model there is no way to
  // distinguish them, which is why it is now an input.
  const never = cacheHealth({ steps: 5, read: 0, written: 9000, uncached: 100, sawCacheFields: true, model: "claude-opus-5" })
  eq("tokens written and none read is an invalidation", never.state, "never-read")
  ok("…and it says to look for the invalidator", /invalidat/.test(never.why))

  const small = cacheHealth({ steps: 5, read: 0, written: 0, uncached: 300, sawCacheFields: true, model: "claude-opus-4-6" })
  eq("nothing written on a small prompt is 'too-small'", small.state, "too-small")
  ok("…and it says there is nothing to hunt", /no invalidator to hunt/.test(small.why), small.why)
  ok("…and that no entry ever existed", /never created|no entry was ever created/.test(small.why), small.why)
  ok("…naming the model and its floor", /claude-opus-4-6/.test(small.why) && /4096/.test(small.why), small.why)

  // The same counters on a model whose floor is below the prompt are NOT
  // explained away — that really is a cold or broken cache.
  const big = cacheHealth({ steps: 5, read: 0, written: 0, uncached: 9000, sawCacheFields: true, model: "claude-opus-4-6" })
  ok("a prompt ABOVE the floor is not excused", big.state !== "too-small", JSON.stringify(big))

  // Unchanged states.
  eq("reads are still ok", cacheHealth({ steps: 5, read: 8000, written: 0, uncached: 100, sawCacheFields: true }).state, "ok")
  eq("two steps are still cold", cacheHealth({ steps: 2, read: 0, written: 5000, uncached: 0, sawCacheFields: true }).state, "cold")
  eq("no cache fields is still unknown", cacheHealth({ steps: 9, sawCacheFields: false }).state, "unknown")
  eq("without a model the new state cannot fire",
    cacheHealth({ steps: 5, read: 0, written: 0, uncached: 300, sawCacheFields: true }).state, "cold")
}

console.log(`\n== cache-positions suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
