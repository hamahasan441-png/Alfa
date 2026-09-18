# Forge 122.5.0 — Intelligence Expansion Evidence

## Scope
Built on the 122.4.0 release archive. This release adds deterministic intelligence services and wires them into the cognitive path:

- semantic repository targeting and bounded impact tracing
- adaptive inspect → impact → implement → repair → verify planning
- diagnosis-led failure intelligence and recovery selection
- adversarial completion review over report/evidence/verification
- strategy composition using repository evidence and measured outcome history
- bounded persisted intelligence snapshot

Security implementation was not changed in this stage. Existing security controls remain preserved; development/test security mode remains the existing opt-out behavior and production remains fail-closed.

## New evidence

`tests/test-intelligence-expansion.mjs`: **7/7 passed**.

The test proves:
1. semantic repository matching finds the relevant source file;
2. impact analysis returns bounded graph results;
3. adaptive planning starts read-only and ends in verification;
4. plan critique detects no missing verification for the generated plan;
5. failure intelligence classifies timeout and marks repeated failures;
6. adversarial review rejects a success claim with no evidence;
7. strategy composition and snapshot persistence work.

## Baseline caveat
A complete `node tests/run-all.mjs` was attempted before the change but did not finish within 180 seconds. During that attempt the existing `state-concurrency` suite exited with code 1. Therefore this release does **not** claim the full suite is green.

## Verification after change
Targeted tests and syntax checks were run for the new code and key regression/security suites. The following passed: intelligence expansion 7/7; cognition 51/51; close outcome 2/2; plans 18/18; failover 46/46; memory pipeline 39/39; repo map 25/25; checkpoint integrity 37/37; checkpoint restore 31/31; verification scope 32/32; verification staleness 33/33; node verification gate 42/42; final risk recalculation 44/44; verifier read-only 52/52; invalid plan 42/42; state concurrency 40/40; security 246/246; security mode 6/6; SSRF pinning 166/166; FS TOCTOU 83/83.

Two long-running checks did not finish in the available execution window: the full fast-lane `tests/run-all.mjs` run exceeded 300 seconds, and plugin-isolation exceeded 120 seconds. These are reported as NOT VERIFIED, not as passes.

Release archive SHA-256: `a782be753862a02a93ab57264f4af34279eec408d1fe04105e8f1c1a5c410160`.

## Security preservation
The release process compares the security-critical modules from 122.4.0 against 122.5.0 byte-for-byte before publication. No security module is intentionally modified by this release.
