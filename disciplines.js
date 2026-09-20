/**
 * forge — the five engineering disciplines, measured (v137, zero dependencies)
 *
 * WHY THIS IS A SECOND AXIS AND NOT FIVE MORE LANES
 *
 * `benchsuite.js` lanes describe MATURITY: capability (decision quality forge
 * has now), programme (what it cannot do yet), speed (wall time), autonomy
 * (did it finish the job). "Prompt" and "graph" are not maturities — they are
 * SUBJECTS. Modelling them as lanes would have crossed the two axes and made
 * `GUARD_LANES` incoherent: is a failing prompt case a regression or a
 * roadmap item? It depends entirely on which case.
 *
 * So discipline is a tag, orthogonal to lane. A programme case can be tagged
 * `prompt` (room above the benchmark, in prompt engineering); a discipline
 * case is tagged `prompt` AND sits in a guard lane (an invariant that holds
 * today and must keep holding). `forge bench --discipline prompt` slices
 * across both, which is the question an engineer actually asks.
 *
 * WHAT BELONGS HERE
 *
 * Invariants that hold NOW, exercised against the real modules, fast and
 * deterministic enough to run on every `forge bench`. A case here fails only
 * if forge regressed — which is why this lane guards the exit code. Anything
 * forge cannot do yet belongs in PROGRAMME_CASES with a discipline tag, not
 * here: a lane that is allowed to be red teaches CI to ignore it.
 *
 * Every case is EXERCISED except where its note says otherwise. A grep is not
 * a benchmark; where a case can only read source, it says SURFACE and the
 * report shows it.
 */

export const DISCIPLINE = Object.freeze({
  PROMPT: "prompt",     // what the model is told, and what it costs to say it
  LOOP: "loop",         // how the run advances, extends and stops
  HARNESS: "harness",   // the tool layer's contract with the model
  CONTEXT: "context",   // what survives when history will not fit
  GRAPH: "graph",       // the DAG, the world model and their invalidation
})

export const DISCIPLINES = Object.freeze(Object.values(DISCIPLINE))

/**
 * Warm system-prompt build budget, in milliseconds.
 *
 * Measured at v136 on this tree (672 indexed files, best-of-5, warm): 172ms,
 * of which `relevantMemory` was 71ms and `relevantLearnings` 65ms — both of
 * them building a full repository graph, independently, to filter a memory
 * pool that on a fresh checkout has zero entries. After v137 (memgraph
 * memoizes the world per index revision; livePool/liveLearnings read what
 * they filter before building the filter) the same measurement is 28ms.
 *
 * The budget is set at 90ms: comfortably above the 28ms floor so an ordinary
 * loaded CI runner does not redden the lane, and far enough below the 172ms
 * baseline that a regression to the old behaviour cannot hide under it.
 */
export const PROMPT_BUILD_BUDGET_MS = 90

/** What the warm build cost when this case was written. See benchsuite's
 *  BOOT_BASELINE_MS for why a baseline is a constant and not a stopwatch:
 *  a budget checked against the CURRENT host's number is vacuous. */
export const PROMPT_BUILD_BASELINE_MS = 172

const ok = (pass, note = "") => ({ pass: Boolean(pass), note: String(note || "") })

/** Best-of-N wall time for a synchronous thunk. Best, never mean — a shared
 *  runner's spikes say nothing about the code (see measureBootMs). */
function bestOf(fn, runs = 5) {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now()
    fn()
    best = Math.min(best, Date.now() - t0)
  }
  return best
}

/**
 * Lines that NAME the skills available for this task.
 *
 * Deliberately matches the heading shape rather than the word "skill"
 * anywhere: rule text and tool descriptions mention skills constantly, and a
 * case that counted those would be noise. Two headings here means the prompt
 * is telling the model its skill list twice — which is what v136 did, from
 * two independent selections that could disagree.
 */
export function skillNamingLines(prompt) {
  return String(prompt ?? "").split("\n").filter((l) => /^SKILLS\b|^SKILLS FOR THIS TASK\b/.test(l.trim()))
}

/**
 * The part of the prompt that does not depend on the task.
 *
 * A provider prompt cache hits on a byte-identical PREFIX, so everything
 * task-independent has to come before the first task-specific byte or the
 * cache never engages. This returns the prefix up to and including the TOOLS
 * block, which is the last section that should be identical for every task.
 */
export function stablePrefix(prompt) {
  const s = String(prompt ?? "")
  const marker = "\nTOOLS — all available"
  const at = s.indexOf(marker)
  if (at === -1) return null
  const end = s.indexOf("\n\n", at + marker.length)
  return end === -1 ? s : s.slice(0, end)
}

async function buildPrompt(task) {
  const { agentSystemPrompt } = await import("./agent.js")
  const { loadConfig } = await import("./config.js")
  const cwd = process.cwd()
  return agentSystemPrompt({
    cwd, task, config: loadConfig(cwd),
    skillsDir: null, skillsEnabled: true, repoMap: true,
  })
}

export const DISCIPLINE_CASES = [
  // ── prompt ────────────────────────────────────────────────────────────────
  {
    id: "prompt-names-skills-once",
    name: "the prompt names its skills exactly once",
    discipline: DISCIPLINE.PROMPT, how: "exercised",
    why: "v136 named them twice, from two independent selections — so the model could be handed two disagreeing skill lists and no way to tell which was authoritative",
    async check() {
      const p = await buildPrompt("fix the failing MCP dual-era test and verify the boot budget")
      const lines = skillNamingLines(p)
      return ok(lines.length <= 1,
        `${lines.length} skill-naming block(s)${lines.length > 1 ? ": " + lines.map((l) => l.slice(0, 40)).join(" | ") : ""}`)
    },
  },
  {
    id: "prompt-cache-stable-prefix",
    name: "two different tasks share a byte-identical prompt prefix",
    discipline: DISCIPLINE.PROMPT, how: "exercised",
    why: "a provider prompt cache hits on a prefix; if anything task-specific lands before the TOOLS block, every run pays full price for the whole system prompt",
    async check() {
      const a = stablePrefix(await buildPrompt("add a retry to the HTTP client"))
      const b = stablePrefix(await buildPrompt("rename the CSS variables in the theme file"))
      if (!a || !b) return ok(false, "could not locate the TOOLS block — prefix shape changed")
      return ok(a === b, a === b ? `${a.length} bytes cacheable` : "prefix differs between tasks — task text leaked above TOOLS")
    },
  },
  {
    id: "prompt-build-budget",
    name: "the system prompt builds inside its warm budget",
    discipline: DISCIPLINE.PROMPT, how: "measured",
    why: "this is paid once per run before the first model call; at v136 it was 172ms, dominated by two independent full-repo graph builds",
    async check() {
      const { agentSystemPrompt } = await import("./agent.js")
      const { loadConfig } = await import("./config.js")
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const task = "fix the failing MCP dual-era test and verify the boot budget"
      const build = () => agentSystemPrompt({ cwd, task, config, skillsDir: null, skillsEnabled: true, repoMap: true })
      build() // warm: the first call pays module import, which boot already paid
      const ms = bestOf(build, 5)
      return ok(ms <= PROMPT_BUILD_BUDGET_MS, `${ms}ms (budget ${PROMPT_BUILD_BUDGET_MS}ms, was ${PROMPT_BUILD_BASELINE_MS}ms at v136)`)
    },
  },

  // ── loop ──────────────────────────────────────────────────────────────────
  {
    id: "loop-recognises-verification",
    name: "the loop can tell a verification command from a read",
    discipline: DISCIPLINE.LOOP, how: "exercised",
    why: "step-budget extension is gated on the run being PRODUCTIVE; if a plain `ls` counted as verification, a spinning run would extend itself forever",
    async check() {
      const { looksLikeCheck } = await import("./agent.js")
      const checks = ["npm test", "pytest -q", "cargo build", "go test ./..."]
      const reads = ["ls", "cat README.md", "git status", "pwd"]
      const goodChecks = checks.filter((c) => looksLikeCheck(c))
      const goodReads = reads.filter((c) => !looksLikeCheck(c))
      return ok(goodChecks.length === checks.length && goodReads.length === reads.length,
        `checks ${goodChecks.length}/${checks.length}, reads-not-checks ${goodReads.length}/${reads.length}`)
    },
  },
  {
    id: "loop-effort-scales-with-task",
    name: "harder tasks resolve to more effort, not the same effort",
    discipline: DISCIPLINE.LOOP, how: "exercised",
    why: "a loop that spends the same budget on `fix a typo` and `refactor the auth layer` is not adaptive, it is just slow on one and short on the other",
    async check() {
      const { classifyTaskComplexity, resolveEffort } = await import("./agent.js")
      const TRIVIAL = "fix a typo in the README"
      const HARD = "refactor the authentication layer across every service and migrate the schema"
      // `resolveEffort` is (profile, task, opts) — positional. Writing it as
      // an options object returns the `default` branch for EVERY input, which
      // is `{deep:false}` both times: the case would then have "passed" while
      // proving nothing. Asserted on the profile that is supposed to adapt.
      const eTrivial = resolveEffort("auto", TRIVIAL)
      const eHard = resolveEffort("auto", HARD)
      const classified = classifyTaskComplexity(TRIVIAL) !== classifyTaskComplexity(HARD)
      // Non-vacuity: `fast` and `deep` must NOT adapt, or "auto adapts" says
      // nothing about auto.
      const fixed = resolveEffort("fast", HARD).deep === false && resolveEffort("deep", TRIVIAL).deep === true
      return ok(classified && eTrivial.deep === false && eHard.deep === true && fixed,
        `auto: trivial→${eTrivial.deep ? "deep" : "standard"}, hard→${eHard.deep ? "deep" : "standard"}; fixed profiles stay fixed=${fixed}`)
    },
  },

  // ── harness ───────────────────────────────────────────────────────────────
  {
    id: "harness-tool-schemas-valid",
    name: "every tool definition is a well-formed function schema",
    discipline: DISCIPLINE.HARNESS, how: "exercised",
    why: "a malformed schema is rejected by the provider at the first call of a run, so it fails as far as possible from the edit that caused it",
    async check() {
      const { TOOL_DEFS } = await import("./tools.js")
      const bad = []
      for (const t of TOOL_DEFS) {
        const f = t?.function
        if (!f?.name) { bad.push("(unnamed)"); continue }
        if (t.type !== "function") { bad.push(`${f.name}: type!=function`); continue }
        if (!f.description || typeof f.description !== "string") { bad.push(`${f.name}: no description`); continue }
        const p = f.parameters
        if (!p || p.type !== "object" || !p.properties || typeof p.properties !== "object") { bad.push(`${f.name}: bad parameters`); continue }
        // `required` may only name properties the schema actually declares —
        // a required key with no property is the classic silent schema bug.
        const undeclared = (p.required ?? []).filter((k) => !Object.hasOwn(p.properties, k))
        if (undeclared.length) bad.push(`${f.name}: required names undeclared ${undeclared.join(",")}`)
      }
      return ok(bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${TOOL_DEFS.length} tool schemas valid`)
    },
  },
  {
    id: "harness-tool-names-unique",
    name: "no two tools answer to the same name",
    discipline: DISCIPLINE.HARNESS, how: "exercised",
    why: "duplicate names make dispatch order decide behaviour — the model calls one thing and a different one runs",
    async check() {
      const { TOOL_DEFS } = await import("./tools.js")
      const names = TOOL_DEFS.map((t) => t?.function?.name).filter(Boolean)
      const dupes = names.filter((n, i) => names.indexOf(n) !== i)
      return ok(dupes.length === 0, dupes.length ? `duplicated: ${[...new Set(dupes)].join(", ")}` : `${names.length} unique names`)
    },
  },

  // ── context ───────────────────────────────────────────────────────────────
  {
    id: "context-compaction-refuses-to-orphan",
    name: "compaction never hands back a history with unanswered tool calls",
    discipline: DISCIPLINE.CONTEXT, how: "exercised",
    why: "an orphaned tool_use id is a hard 400 from the provider — a compaction that saves tokens by breaking the history has made the run unrecoverable, not smaller",
    async check() {
      const { guardCompaction, historyIsWellFormed } = await import("./compaction.js")
      const before = [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "out" },
      ]
      // An "after" that dropped the tool RESULT but kept the call — exactly
      // what an over-eager window trim produces.
      const after = before.filter((m) => m.role !== "tool")
      if (!historyIsWellFormed(before)) return ok(false, "fixture is not well-formed — case cannot prove anything")
      const g = guardCompaction(before, after)
      return ok(g.refused === true && g.messages === before,
        g.refused ? "refused and kept the original" : "ACCEPTED an orphaned tool call")
    },
  },
  {
    id: "context-compaction-admits-good-work",
    name: "a compaction that keeps the history well-formed is accepted",
    discipline: DISCIPLINE.CONTEXT, how: "exercised",
    why: "the guard above is only safe if it is not also refusing valid compactions — a guard that refuses everything is a disabled feature that still looks enabled",
    async check() {
      const { guardCompaction } = await import("./compaction.js")
      const before = [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a very long output ".repeat(200) },
      ]
      // Shrinking the RESULT keeps every id paired — the legitimate shape.
      const after = before.map((m) => m.role === "tool" ? { ...m, content: "…trimmed…" } : m)
      const g = guardCompaction(before, after)
      return ok(g.refused === false && g.messages === after, g.refused ? `refused a valid compaction: ${g.reason}` : "accepted")
    },
  },

  // ── graph ─────────────────────────────────────────────────────────────────
  {
    id: "graph-world-built-once-per-index",
    name: "the world model is built once per index revision, not once per caller",
    discipline: DISCIPLINE.GRAPH, how: "exercised",
    why: "three call sites rebuilt the same 672-file graph every run (compose, relevantMemory, relevantLearnings) at 64ms each — the same answer, computed three times",
    async check() {
      const { worldFromCwd, clearWorldCache } = await import("./memgraph.js")
      clearWorldCache()
      const a = worldFromCwd(process.cwd())
      const b = worldFromCwd(process.cwd())
      if (a !== b) return ok(false, "two calls produced two worlds — not memoized")
      clearWorldCache()
      const c = worldFromCwd(process.cwd())
      return ok(c !== a && Object.keys(c.writes).length === Object.keys(a.writes).length,
        `memoized, and clearWorldCache() rebuilds (${Object.keys(a.writes).length} writes)`)
    },
  },
  {
    id: "graph-rejects-cycles",
    name: "a cyclic plan is refused, not silently un-edged",
    discipline: DISCIPLINE.GRAPH, how: "exercised",
    why: "dropping an edge to break a cycle produces a plan that runs in an order nobody chose — the cycle is a planning bug and has to surface as one",
    async check() {
      const { buildDAG, topoSort } = await import("./dag.js")
      const cyclic = [
        { id: "a", objective: "a", dependencies: ["c"] },
        { id: "b", objective: "b", dependencies: ["a"] },
        { id: "c", objective: "c", dependencies: ["b"] },
      ]
      let threw = false
      try {
        const g = buildDAG(cyclic)
        topoSort(g.nodes ?? g)
      } catch (e) { threw = /cycle/i.test(String(e?.message ?? e)) }
      return ok(threw, threw ? "cycle surfaced as an error" : "a 3-node cycle sorted without complaint")
    },
  },
  {
    id: "graph-invalidation-is-transitive",
    name: "invalidating a node invalidates what depends on it, transitively",
    discipline: DISCIPLINE.GRAPH, how: "exercised",
    why: "a direct-dependents-only sweep leaves grandchildren marked complete on evidence that no longer exists — verified work that was never verified",
    async check() {
      const dag = await import("./dag.js")
      const g = dag.buildDAG([
        { id: "a", objective: "a", dependencies: [] },
        { id: "b", objective: "b", dependencies: ["a"] },
        { id: "c", objective: "c", dependencies: ["b"] },
      ])
      // Drive all three to COMPLETED first. Without this the chain sits at
      // pending/blocked and "c is not completed" is true before the call as
      // well as after — the case would pass on a graph that never invalidated
      // anything. `c` is a GRANDCHILD of `a`: one hop is not the property
      // under test.
      for (const id of ["a", "b", "c"]) {
        g.nodes.get(id).status = dag.NODE_STATUS.READY
        dag.markRunning(g, id)
        dag.markExecutionSucceeded(g, id)
        dag.markCompleted(g, id, null, { requireVerification: false })
      }
      const allDone = [...g.nodes.values()].every((n) => n.status === dag.NODE_STATUS.COMPLETED)
      if (!allDone) return ok(false, "fixture could not reach all-completed — case cannot prove anything")
      dag.invalidateNodes(g, ["a"], { reason: "discipline probe" })
      const status = (id) => g.nodes.get(id).status
      const done = dag.NODE_STATUS.COMPLETED
      return ok(status("b") !== done && status("c") !== done,
        `a=${status("a")} b=${status("b")} c=${status("c")} (c is a grandchild)`)
    },
  },
]

/** Run every discipline case. Shape matches benchsuite's other lane runners. */
export async function runDisciplines({ only = null } = {}) {
  const want = (d) => !only || (Array.isArray(only) ? only.includes(d) : only === d)
  const cases = DISCIPLINE_CASES.filter((c) => want(c.discipline))
  const results = []
  for (const c of cases) {
    let r
    try { r = await c.check() } catch (e) { r = ok(false, `threw: ${String(e?.message ?? e).slice(0, 120)}`) }
    results.push({ id: c.id, name: c.name, discipline: c.discipline, how: c.how, why: c.why, ok: r.pass, note: r.note })
  }
  return { ran: true, results }
}
