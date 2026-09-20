# forge — TODO (deferred work)

This file is the ONLY place where unfinished ideas, known gaps and deferred
work live. A shipped version must not keep a PLAN file: completed plans are
deleted at release time and their leftovers move here. Do not keep a PLAN
file for work that already shipped — if it shipped, the plan is history; if
it did not ship, it belongs on this list.

Status: **deferred items remain open** — every item below is intentionally not completed / not yet shipped. The seven
runtime/sandbox/search/checkpoint/LSP/tool-creation gaps that lived here
through v94 "fastwise" are CLOSED (v94 "todowise": `tests/test-todowise.mjs`,
81 assertions, suite registered in run-all — an item only moves out of this
file when a test proves the behavior exists, and each one now has exactly
that). The kernel item — isolated worktree execution for DAG nodes — is
CLOSED by v95 "worktreewise" (`tests/test-worktreewise.mjs`, 75 assertions,
9 sections: lifecycle, isolation invariant, conflict honesty, eligibility,
gates, orphan sweep, child-process runner, meta integration, surface-dedup
audit). v96 "unifywise" additionally closed the WIRING ledger — the
computed-then-ignored surfaces, dropped resume state, dead event vocabulary,
unfed ledgers and duplicated implementations found by the five-module deep
audit — each pinned by `tests/test-unifywise.mjs` (72 assertions) and
`tests/test-envfingerprint.mjs` (27 assertions). v98 "shipwise" closed the
v97 leftovers — LSP structured extraction wired into the index path
(langstruct.js, pinned by `tests/test-v98.mjs`), browser visual regression
(visual_diff baselines), artifact verification (observed build outputs as
VTYPE.ARTIFACT ledger evidence), and chunked/async world-model walking
(buildAsync + the 0=unlimited resolver fix). History in the CHANGELOG.

## v137 "five disciplines, measured" — leftovers

- [ ] **Only the prompt discipline has been acted on.** The loop, harness,
      context and graph cases all pass, but they pin invariants that already
      held — they found nothing to fix because nothing was looked for beyond
      what one sitting could measure. The next pass should look for defects in
      those four the way the prompt discipline was looked at: measure first,
      then read the ordering.
- [ ] **The system prompt still has no BUDGET.** v137 made it 6.1x cheaper to
      BUILD (172ms -> 28ms) and removed one duplicated block, but the assembly
      is still an unconditional concatenation: every block that has something
      to say says it, and nothing ranks them or caps the total. On this tree
      that is 9.4k characters, of which the repo map alone is 4k. A budget
      needs a value order, and a value order needs evidence about which blocks
      change the model's behaviour — which forge does not collect yet.
- [ ] **The Anthropic cache breakpoint sits on a block that changes every
      task.** `providers.js` sets `cache_control` on the WHOLE system prompt,
      and calls it "the static prefix" — but roughly 70% of it is task-derived
      (repo map for this query, skills for this task, memory for this task),
      so the cache key changes per task and cross-run reuse is zero. It still
      hits WITHIN a run, which is what v89 measured and why this went unnoticed.
      `prompt-cache-stable-prefix` proves 2665 bytes (~666 tokens) are
      genuinely identical across tasks; splitting `body.system` into a cached
      stable block and an uncached volatile one would make those reusable
      across runs. Not done here because the boundary must come FROM the prompt
      builder (a second string search in providers.js would be a second source
      of truth, §36), and that means threading it through the provider call.

- [ ] **`worldFromCwd`'s cache is per-process and holds ONE entry.** A run that
      alternates between two working directories rebuilds on every call. One
      entry is right for the agent (one cwd per run) and wrong for anything
      that walks several projects; if such a caller appears, this needs to be
      a small keyed map, not a single slot.

## v136 "the terminal, told" — leftovers

- [ ] **Only the window title is wired.** `osc.js` also provides hyperlinks,
      desktop notifications and OSC 133 shell marks, and nothing calls them
      yet. The obvious next users: `file:line` in review findings and stack
      traces (hyperlink), a toast when a long unattended run finishes
      (notify), and prompt marks around each turn (133).
- [ ] **Terminal support is inferred from the environment, not asked.** A
      terminal can be queried for what it supports (DA1 / XTGETTCAP), which is
      exact where `TERM_PROGRAM` sniffing is a guess — at the cost of a
      round-trip on startup and careful timeout handling.

## v135 "which attempt worked" — leftovers

- [ ] **`successfulRepair` is still attributed by WINDOW, not by scope.**
      v135.0.1 made the boundary exact (the recorded `writeIndex`, which is
      immune to batching), but an unrelated file written inside that window is
      still credited. Narrowing it means reusing `verifyledger`'s scope
      machinery rather than guessing.

## v133 "one droppable file" — leftovers

- CLOSED (v133.1): the programme lane was down to ONE open case and it was the
      only MEASURED one, so a fast CI runner closed it and reddened
      `benchsuite` + `v29` on a commit that passed minutes earlier on a slower
      runner. Three deterministic cases were added (`mcp-elicitation`,
      `mcp-http-back-channel`, `run-teaches-on-success`) and the non-vacuity
      check now compares the budget against `BOOT_BASELINE_MS` rather than the
      host's own measurement. `tests/test-benchsuite.mjs` now guards the CLASS
      of bug: not every open case may be a measurement.
- [ ] **The three new open cases are real work, not placeholders.**
      `mcp-elicitation` needs a way to reach the interactive prompt from inside
      a tool call; `mcp-http-back-channel` needs the SSE GET stream;
      `run-teaches-on-success` needs the loop to know WHICH attempt worked.
- CLOSED (v134): `boot-budget` — but not by restructuring `tools.js`. Measuring
      all 47 of agent.js's direct imports showed fourteen of them cost 65-122ms
      ALONE while agent.js totals 134ms: they overlap almost entirely. The
      intersection is seven modules at 61ms, and `netguard.js` was 52ms of it —
      all four of its `node:http/https/net/dns` imports at module scope. Every
      run paid for the HTTP stack; most never open a socket. `netlazy.js` defers
      them. agent.js: 178ms -> 112ms.
- [ ] **Boot is now the 106-module graph, not builtins.** No remaining builtin
      is worth deferring (`node:child_process` 6ms across 19 modules,
      `node:crypto` 12ms across 17). Going below ~100ms needs the entry points
      themselves to stop converging on one shared core.
- [ ] **`boot-budget` flips with the host** (112ms quiet, 121ms loaded, budget
      120). Safe only because v133.1 made the lane's openness structural. If the
      budget is ever tightened, tighten it against a measured floor, not a wish.
- [ ] **The single file does not carry `skills/`** (11.6MB of 15.4MB). That is
      the right default for a tool that fetches and verifies skills at runtime,
      but there is no `--with-skills` build for someone who wants one artifact
      and a slow link.
- [ ] **Nothing prunes old `runtime/<build-id>` trees.** Each build id unpacks
      3.7MB and stays. Bounded by how many distinct builds a user actually
      runs, but unbounded in principle.

## v132 "a run that fails teaches" — leftovers

- CLOSED (v135): a run that COMPLETED the hard way now teaches the next one.
      `provenRepairs()` (lessons.js) derives WHICH attempt worked from evidence
      the loop already kept — the same command red at one step and green at a
      later one, and the files written in between. Recorded as
      `successfulRepair` at confidence 0.7, so it reads as "fix that worked"
      and outranks an unproven next step. 45 assertions in
      `tests/test-run-teaches.mjs`.
- [ ] **A repair is attributed to every file written between red and green.**
      (v135.0.1 narrowed the BOUNDARY to the recorded `writeIndex`, which is
      exact under batching; what remains is the SCOPE question below.)
      Honest about what was OBSERVED, but it over-attributes when the run also
      did unrelated work in that window. Narrowing it needs the loop to know
      which writes the failing check actually covers — verifyledger has the
      scope machinery, and this should reuse it rather than guess.
- [ ] **`compose.js:177` still reads `relevantLessons`, which requires a
      repair.** An unproven "next step" lesson reaches the PROMPT (via
      `lessonsForPrompt`) but not the hard-avoid list, which is the right
      default — an unproven step should not become a prohibition — but it means
      the two readers now disagree about what a lesson is. Worth one shared
      definition rather than two thresholds.
- [ ] **`MCP_IDLE_PING_MS` is a constant, not a measurement.** 30s is a guess
      that errs toward not paying the round-trip. What it should be is a
      function of how often this project's servers actually die.

## v131 "dual era" — leftovers

- [ ] **`elicitation/create` is declared nowhere**, because forge has no user
      prompt on the MCP path. A server that wants a value from the human
      therefore cannot ask for one. Wiring it needs a way to reach the
      interactive surface from inside a tool call (chat.js owns the prompt;
      `agent.js` does not), which is the same plumbing the autonomy lane needs.
- [ ] **HTTP legacy still declares `capabilities: {}`**, deliberately: a legacy
      server may answer a declaration with a server-initiated JSON-RPC request,
      and plain Streamable HTTP POSTs give forge no channel to reply on. Opening
      the SSE GET stream would close this — it is a transport change, not a
      capability change, and it belongs with its own tests.
- [ ] **Sampling is implemented but untested against a live provider.**
      `handleSampling` is gated off by default and the gate is pinned; the
      completion path itself (`providers.chatOnce`) is exercised only by the
      refusal case, because a real one spends tokens.
- [ ] `governor.js:258` advisory STOP — still open from v125. It is a symptom,
      not the cause, and the fix belongs with the autonomy lane (Stage 3).

## v129 "the measuring stick" — CLOSED in v130

- CLOSED (v130): the `bench.js` case `24-reviewer-fixer-planner` failure was
      recorded here as a concurrency flake. It was NOT a flake and not a race.
      `redactSecrets` returned a bare string instead of `{text, found}` when
      security was off, so `codereview.js`'s `secrets.found > 0` was
      `undefined > 0` — false — and the `secret_in_code` finding vanished. The
      fast lane runs `FORGE_SECURITY_MODE=off`, so the case failed
      deterministically there; it looked intermittent only because
      `test-benchsuite` is the one bench-running suite that does not clear that
      variable, and every isolation attempt ran without it. Fixed in
      `secrets.js`, pinned by `tests/test-security-mode.mjs` (14 assertions,
      including both blinded callers).

## v122 "yolowise" — leftovers (completed plan removed, house style)

- CLOSED (v124): the zero-ask delivery key exists. `gitship.commit/push/pr`
      accept `"auto"`, and `yolo.deliverUnattended` promotes the tier the owner
      already enabled (`ask→auto`, `explicit→auto`, `gh→auto`) so a full-control
      run no longer parks in WAITING_FOR_USER mid-delivery. It never promotes
      `"off"` — `gitship.*` still decides WHETHER to ship and still ships off,
      so the OUTWARD act stays an explicit opt-in. Pinned by
      `tests/test-yolo-unlimited.mjs` (30 assertions).
- CLOSED (v124): `forge yolo` now says what the pin restores — "…which means an
      ASK can still PAUSE the run (WAITING_FOR_USER)" — directly under the
      "still enforcing" line, so a screen reading FULL CONTROL names the one way
      it can still stop and wait for a human.
- [ ] `isVerificationGradeBash` is conservative about operands: ANY named path
      outside the project refuses the command, so a read-only worker cannot run
      `pytest -c /etc/pytest.ini` or `tsc -p ../shared/tsconfig.json`. Splitting
      read operands from write operands needs the classifier to distinguish them
      first (it collects `targets` for both).
- CLOSED (v124): autofix no longer gates on a closed table of formatter NAMES.
      The table stays as one way to qualify (format-by-default tools such as
      `black .` name no action), and a command may now also SAY it formats — a
      format-shaped binary name, a `fmt`/`format`/`fix` subcommand, or an
      in-place flag. The guards that carry the safety are kept and tightened:
      shellguard must still rate it "safe", no compound/pipeline, multi-purpose
      tools must name their format subcommand, lint-capable tools must name a
      FIXING action — and programs that run OTHER programs (`bash ./fmt.sh`,
      `npx …`, `make`, `sudo`) are refused outright, because shellguard rates
      several of those "safe" (the danger is the argument, not the verb).
      Two dead branches were fixed on the way: `/\b--fix\b/` never matched
      `--fix` (no word boundary between a space and a `-`), so every
      eslint/ruff/biome/standard command was silently rejected. Pinned by
      `tests/test-autofix-shape.mjs` (64 assertions; 15 fail on the old code).
- CLOSED (v124): `completion.requireEvidence: false` exists (YOLO implies it).
      It waives the covering-check EVIDENCE blocker only, and the verdict then
      reads `COMPLETED_UNVERIFIED` with the waived evidence still attached —
      never a clean COMPLETED. A check that RAN and FAILED, a missing answer and
      a mutation that wrote nothing are facts, not missing evidence, and still
      block. Pinned by `tests/test-yolo-unlimited.mjs`.
- CLOSED (v124): the pairing exists — `forge yolo on --sandbox` sets
      `sandbox.enabled` alongside full control. The two questions stay
      orthogonal: YOLO alone still never arms a jail (the surprise this release
      was removing), and `forge yolo` reports the sandbox state either way.
      Pinned by `tests/test-yolo-unlimited.mjs`.
- [ ] the `block` classification level is computed and reported but honoured by
      nothing (v88 made that permanent). Fine as a label; a future hard-stop
      would need its own key, and it must not be a side effect of `yolo:false`.

## v99 "loopwise" — leftovers (completed plan removed, house style)

- CLOSED (v101, recorded here in v124): layer 2 IS consumed. langadapter
      calls `extractViaTreeSitter` through `treeSitterOr()` at the three points
      where the lexical layer-8 result would otherwise win — tried only AFTER
      the LSP path produces nothing, so a working language server is never
      displaced, and a missing/failing binary returns the prepared lexical
      result with its honest `fallback` reason. Pinned end-to-end by
      `tests/test-v101.mjs` §16 against a stub tree-sitter binary emitting real
      s-expression output (provenance.source === "tree-sitter"; no binary →
      provenance.layer === 8). This entry described the PRE-v101 state and was
      three releases stale — it is corrected rather than deleted because this
      file claims every item in it is genuinely open.
- [ ] docker-image verification goes no deeper than bringUp health +
      artifact existence (image digest/layer checks are not implemented)
- CLOSED (v124): reviewer line numbers are checked, not trusted.
      `addedLineNumbers()` parses the hunk headers of the diff the pass already
      holds, and `verifyFindingLines()` checks every claimed `file:line` against
      the lines that diff actually ADDED. A verified line is kept
      (`lineVerified: true`); an unverifiable one is nulled, preserved as
      `claimedLine`, and marked `lineVerified: false`; with no diff to check
      against it stays `null` rather than claiming either. The FINDING is never
      dropped — a real bug reported at the wrong line is still a real bug, but a
      wrong coordinate reads like fact and sends the reader to unrelated code.
      Pinned by `tests/test-review-lines.mjs` (37 assertions).
- [ ] autofix allowlist is a static table — a project using a formatter
      not in the table falls through to the LLM repair (safe, just slower)
- [ ] skill registry URLs are hints, not verified manifests (a moved
      branch fails the download honestly; no periodic revalidation)
- [ ] the reviewer/verifier/repair passes each pay their own model call —
      no shared session (bounded budgets exist; consolidation is future
      work)

CLOSED in v99: gitship PR creation — `gitship.pr = "gh"` opens real PRs
through the user's OWN gh CLI (passthrough; forge never holds a GitHub
token; consent-gated like push; requires the pushed commit). The v98
blocker ("token sourcing unsolved by policy") was solved by NOT sourcing
a token at all.

## v98 "shipwise" — leftovers (superseded by the v99 list above)

CLOSED by v99: gitship PR creation — `gitship.pr = "gh"` (gh CLI passthrough,
never a forge-held token). The v98 blocker ("token sourcing unsolved by
policy") was solved by NOT sourcing a token at all.


## Open items

The deferred items above are the active open items. They are deliberately
kept here until implemented and covered by tests; this file must not claim
"none" while unchecked items remain.

## Skill forge — leftovers (never shipped, never promoted)

- [ ] Research crawler: a multi-source web research skill was prototyped but
      never met the promotion bar (no recorded behavioral evidence, no fresh
      fingerprint). It stays here until it passes the same gates as a
      learned download.

## Learned skills — policy reminders

- A learned skill never becomes Auto-ACTIVE by itself. Promotion requires
  recorded behavioral evidence plus a fresh fingerprint; being usable is
  not being trusted, and a skill must never be auto-approved just
  because a download succeeded.
- markStaleSkills runs on every world-model fingerprint change; a stale
  skill drops back to candidate until it re-earns evidence.

## Never list (permanent)

- Never ship a skill that fetches arbitrary URLs beyond the netguard
  pinnedFetch policy (Research crawler stays on this list until its fetch
  surface is proven pinned).
- Never make a learned skill Auto-ACTIVE without behavioral evidence.
- Never keep a shipped PLAN file — leftovers live here, history lives in the
  CHANGELOG.
- Never run DAG nodes in a shared tree when they mutate the same files —
  v95 "worktreewise" IS the fix: mutating nodes with pairwise-disjoint
  declared targets execute in per-node git worktrees, the merge back into
  the shared tree is checked-then-applied behind the single-writer barrier,
  and anything ineligible (undeclared targets, overlap, dependencies,
  uncommitted target drift, non-git repo, opt-out) stays serialized exactly
  as before. The rule stands; the fix enforces it.

## Self-audit orphan triage (v124) — evidence, not a backlog dump

`forge selfaudit` reports **66 orphaned capabilities** and **36 dead exports**
across 191 modules (0 islands). The audit's own footer is the rule here:
*"static analysis proves disconnection, never correctness — confirm each lead by
reading the code."* The three highest-signal leads were read, and each says
LEAVE, not wire. Recording the verdicts so they are not re-litigated:

- `router.js:canRunInParallel` (9 test refs, no production caller) — **leave.**
  Production asks the BATCH question (`planExecution`), not the pairwise one:
  `planExecution` applies a risk ceiling and an "earlier write in this batch"
  clash rule that `canRunInParallel` does not, and `canRunInParallel` rejects
  target overlap only when one side is `*`. Routing one through the other would
  change batching behavior, not deduplicate it. It is a sound public primitive
  that the live path has no question for.

- `securefs.js:secureReadFile` — **still leave** (whole-file read would reopen
  the v20 OOM that `readLineRange`'s streaming exists to prevent), but the
  asymmetry it pointed at is **CLOSED (v124)**: `read_file` now opens once via
  `projectOpenRead` → `secureOpenRead` and serves the size, the binary sniff and
  the streamed window from that ONE descriptor. The old path resolved the same
  name four times (existsSync → statSync → openSync for the sniff → openSync
  again inside readLineRange); the gap between the sniff and the stream let a
  swapped file serve binary bytes the sniff had already cleared. Pinned by
  `tests/test-read-toctou.mjs` (23 assertions), which fails on the old code with
  the swapped content reaching the model.

- `v4.js:nextPlanAction` (6 test refs) — **leave.** `meta.js` imports
  `buildV4Plan` purely as a VALIDATION gate (it builds to prove the plan is
  structurally sound, emits `V4_PLAN_VALIDATED`/`REJECTED`, then discards it);
  scheduling is the DAG's job. v4.js states the contract explicitly: "callers
  may adopt each primitive independently."

The pattern generalizes: most of the 66 are legitimately-exported primitives the
live path has no question for. Wiring them to satisfy a counter would duplicate
a responsibility, which `tests/test-v129.mjs` (§36, one implementation per
responsibility) exists to forbid. Triage each lead on its own evidence; a
per-release quota beats a sweep.
