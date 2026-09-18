# Forge 122.1.0 — release verification

This is an additive alpha-core upgrade over 122.0.1. Existing agent behavior and the
V4 cognitive architecture are preserved; no existing subsystem is intentionally
rewritten or removed. The new learning policy is bounded and advisory to the
existing governor/verification/completion authorities.

## Verified in this environment

- `node tests/test-v122.mjs` — PASS
- `node tests/test-v123.mjs` — PASS
- `node tests/test-v124.mjs` — PASS
- `node tests/test-v125.mjs` — PASS
- `node tests/test-v126.mjs` — PASS
- `node tests/test-v127.mjs` — PASS
- `node tests/test-v128.mjs` — PASS
- `node tests/test-v129.mjs` — PASS
- `node tests/test-v130.mjs` — PASS
- `node tests/test-v131.mjs` — PASS
- `node tests/test-v132.mjs` — PASS
- `node tests/test-v133.mjs` — PASS
- `node tests/test-v134.mjs` — PASS
- `node tests/test-v135.mjs` — PASS
- `node tests/test-v136.mjs` — PASS
- `node tests/test-v137.mjs` — PASS
- `node tests/test-v138.mjs` — PASS
- `node tests/test-v139.mjs` — 3/3 PASS
- `node tests/test-v140.mjs` — 8/8 PASS (outcome learning + live cognition wiring)
- `node tests/test-v61.mjs` — 26/26 PASS
- `node tests/test-v94a.mjs` — 49/49 PASS
- `node tests/test-omega.mjs` — 92/92 PASS
- `node tests/test-infinity.mjs` — 83/83 PASS
- `node tests/test-plannerisk.mjs` — 64/64 PASS
- `node tests/test-deepwise.mjs` — 62/62 PASS
- `node tests/test-autonomy.mjs` — 127/127 PASS
- `node tests/test-resource-leaks.mjs` — 16/16 PASS
- `node tests/test-checkpoint-restore.mjs` — 31/31 PASS
- `node tests/test-crash-resume.mjs` — 19/19 PASS
- `node tests/test-version-consistency.mjs` — 29/29 PASS
- `node tests/test-worker-timeout-cleanup.mjs` — 50/50 PASS
- `node tests/test-v104.mjs` — 42/42 PASS
- `node tests/test-package.mjs` — PASS
- `node tests/test-cognition.mjs` — PASS
- `node tests/test-meta.mjs` — PASS
- `node tests/test-autonomy.mjs` — PASS
- `node tests/test-verifier-readonly.mjs` — PASS
- `node tests/test-skillwise.mjs` — PASS
- `node tests/test-skills.mjs` — PASS
- `node tests/test-mcp.mjs` — PASS
- `node tests/test-repomap.mjs` — PASS
- `node tests/test-plans.mjs` — PASS
- `node tests/test-worktreewise.mjs` — PASS
- `node tests/test-unifywise.mjs` — PASS
- JS/MJS syntax audit — 421 files, 0 syntax errors
- `npm pack --dry-run` — PASS, package version `122.1.0`
- release ZIP integrity (`unzip -t`) — PASS

## Important limitation

The complete `npm test` runner was attempted but was not allowed to finish to a
final summary in this environment because the historical suite is long-running.
A bounded per-suite timeout was added to the runner so future hangs fail with an
explicit timeout instead of holding the whole run open. Therefore this release
record does **not** claim a full-suite green result. The targeted regression sets
listed below are the evidence actually observed.

One historical browser suite (`test-v31.mjs`) still depends on public HTTPS/DNS
being available; in this environment its two public-network assertions failed.
That is an environment-dependent test limitation, not evidence that the new
outcome-learning code failed.

## Changes in 122.1.0

1. Added `outcome-model.js`: bounded, same-project strategy outcome learning with a five-sample minimum and meaningful-advantage gate.
2. Wired the outcome model into the live cognition strategy path as an advisory refinement; the governor, verification and completion authorities remain unchanged.
3. Cognitive learning records now retain causal attribution from the existing Ω causal engine.
4. Added `tests/test-v140.mjs` covering persistence, evidence thresholds, live cognition wiring and causal attribution.
5. Added `outcome-model.js` to the shipped package manifest.
6. Current version metadata/tests are synchronized to `122.1.0`.
7. The test runner now bounds child-suite lifetime and reports explicit timeout failures instead of hanging indefinitely.

No existing source subsystem was removed or rewritten as part of this upgrade.

## Alpha integration hardening (current working release)

The following additions were verified against this 122.1.0 Alpha Intelligence release:

- `node tests/test-alpha-core.mjs` — 12/12 PASS
- `node tests/test-alpha-benchmark.mjs` — 8/8 PASS
- `node tests/test-intelligence-benchmark.mjs` — 10/10 PASS
- `node tests/test-alpha-kernel.mjs` — 14/14 assertions PASS + live wiring PASS
- `node tests/test-v140.mjs` — 8/8 PASS
- `node tests/test-v138.mjs` — 5/5 PASS
- `node tests/test-v137.mjs` — 4/4 PASS
- `node tests/test-autonomy.mjs` — 127/127 PASS
- `node tests/test-v129.mjs` — 42/42 PASS
- `node tests/test-version-consistency.mjs` — 29/29 PASS
- `node tests/test-package.mjs` — 6/6 PASS
- `node tests/test-path-hygiene.mjs` — 10/10 PASS
- recursive JS/MJS syntax audit — 176/176 PASS, 0 syntax errors
- `npm pack --dry-run --json` — PASS; 1309 package files, 4,376,455 bytes; `intelligence-benchmark.js` present
- `unzip -t` on the release ZIP — PASS
- `forge intelligence --json` — real execution produced a 10-case deterministic integration report: 60 state transitions, 20 evidence nodes, 10 learning samples, 20 measured strategy samples, goal-drift detected, stuck detection verified

The full `FORGE_FAST=1 FORGE_TEST_CONCURRENCY=1 npm test` runner was also started. It reached the `config` suite without reporting a suite failure before the external execution timeout ended the run. This is **not** recorded as a full-suite PASS.

The intelligence benchmark is deliberately provider-free. Its report explicitly says it does not measure live-model coding success. Real provider capability remains measured through `forge eval` and must be run against an actual configured provider before making live-model claims.
