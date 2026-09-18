# Forge 123.6.0 — Integration Audit & Wiring Repair

## Scope

Full-repository audit of the 123.6.0 release drop, with additive repairs only.
The governor, planner, verification, completion, Alpha/Horizon intelligence,
memory, recovery, tools, skills, MCP, supervisor and terminal systems are
unchanged in behavior; the one runtime change (a cognitive-state transition)
is a strict *addition* to the allowed set. No security-critical implementation
changed.

## Method

`node tests/run-all.mjs` (the canonical "is the build green?" runner) was run in
the CI fast lane (`FORGE_FAST=1 FORGE_SECURITY_MODE=off`). The initial run had
**86 failing suites**. Each failure was root-caused and repaired; the final run
is **243/243 suites green**, and the production-security contract job
(`NODE_ENV=production node tests/test-security-mode.mjs`) passes.

## Findings and repairs

### 1. Stale release-gate version pins (~69 suites)

The version was bumped to `123.6.0` (package.json, CHANGELOG, README) but the
per-suite release-gate assertions still pinned `122.1.0` / `^122\.`. Refreshed
every pin to `123.6.0`, plus the v94a README-claim regex.

### 2. Security-behavior suites vs. the CI off-lane

CI runs the fast lane with `FORGE_SECURITY_MODE=off` so ordinary engineering
work is not gated by enforcement-heavy adapters. Suites that assert the *secured*
contract (secret redaction, content fence defaults, SSRF pinning, hardening,
private-MCP opt-in gating, and the decision benches that exercise the review/
fence path) were reading that ambient value and seeing OFF-mode behavior as a
false failure. Each such suite now neutralizes the ambient override at setup
(`delete process.env.FORGE_SECURITY_MODE`) so it asserts forge's default
security-on contract. Net effect: the security controls stay **tested** in CI
rather than skipped, and production (which fails closed to ON) is unchanged.

### 3. Island modules — `forge selfaudit` (v105)

Six modules had no importer. Repairs:
- **Wired into the CLI**: `agent-benchmark.js` → `forge agent-bench`
  (live-provider harness; honest `NOT_RUN`/exit 2 with no provider) and
  `alpha-benchmark.js` → `forge alpha-bench` (deterministic orchestration
  benchmark). Both keep their standalone `node <file>.js` main guard.
- **Declared deliberate entry points** (in both `forge.js` and the v105 audit):
  `module-loader.js`, `python-ipc.js`, `processguard.js`,
  `test-runner-policy.js`. These are independently-adoptable V4 primitives / the
  npm-test resource policy (already consumed by `tests/run-all.mjs`), each a
  standalone unit rather than accidental dead code. Wiring them into a path that
  already has an implementation would have duplicated a responsibility, which the
  §36 "one implementation per responsibility" invariant (v129) forbids. The
  audit still flags any *future* accidental island.

### 4. Duplicate export names (v129)

Three deliberate domain-scoped homonyms were added to the sanctioned allowlist
(each used in a distinct module, never co-imported):
`consolidateMemory` (memory tiers vs. advisory episode grouping),
`adaptivePlan` (per-file language plan vs. cognitive plan skeleton),
`adversarialReview` (worker review vs. self-review + adversarial pass).

### 5. Cognitive-state lifecycle repair (v3-persistence)

After a failed observation the phase is `DIAGNOSE`, but the transition table
forbade `DIAGNOSE → INSPECT`, so the governor's legitimate "re-inspect before
repair" decision could not be reflected in the phase — violating the contract
"governor decisions must be reflected in the V3 phase state, not merely emitted
as text." Added `DIAGNOSE → INSPECT` to the allowed set.

### 6. Path hygiene

- Registered three orphaned test suites in `tests/run-all.mjs` so they actually
  run: `intelligence-next-integration`, `horizon-risk-integration`,
  `outcome-close`.
- Added a dedicated GitHub CLI test suite (`tests/test-github-cli.mjs`, 63
  checks) covering `github.js` deterministically through an injected `gh` spawn:
  `ghAvailable` auth-state classification, exact read-only argv for every READ
  action, safe-id validation / shell-injection refusal, honest gh-failure paths
  (non-zero exit, ENOENT, thrown spawn), `status` auth probe, evidence-fact
  derivation (CI failure, numbered refs, bounds), bounded preview + spawn
  timeout/maxBuffer, `formatGithub` rendering, and `actionForTask` /
  `githubImpliedByTask` routing.
- Hardened the relative-import scanner to blank comments and single-quoted /
  template-literal string contents before scanning, so import-shaped substrings
  inside fixture source (written via `fs.writeFileSync`) are not mistaken for
  real imports.

### 7. Stale implementation-detail assertions

`v89` (concurrency), `v120` (read-to-EOF pagination) and `v121` (stable strategy
key) asserted specific function names / fixed file sizes that had been
refactored. Rewrote each to check the *behavior* (machine-derived concurrency;
following the pagination chain to EOF regardless of file length; the
`key || id` stable key computed and recorded) so they no longer break on benign
refactors or file growth.

### 8. Packaging hygiene

Added a root `.gitignore` for runtime `.forge/` state, `node_modules/`, and
editor/OS cruft.

## Evidence

- `node tests/run-all.mjs` (FORGE_FAST=1, FORGE_SECURITY_MODE=off) — **243/243 suites pass**
- `NODE_ENV=production node tests/test-security-mode.mjs` — PASS (production forces security ON)
- `node agent-benchmark.js` — exit 2 (`NOT_RUN`, no provider), which CI accepts
- `node tests/coverage-symbols.mjs` — PASS
- `node --check` — clean across all root modules, tests and scripts
