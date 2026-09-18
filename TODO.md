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
