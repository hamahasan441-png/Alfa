# Forge 122.2.0 — Release Evidence

## Scope
This release starts from `122.1.1-ai-architecture-hardening` and adds three additive engineering controls plus live cognitive-state wiring:

1. Structured Verification Evidence Engine (`verification-evidence.js`)
   - requirement-to-evidence binding
   - provenance (task/run/epoch)
   - affected-file scope
   - stale evidence invalidation after mutation
   - explicit FAILED / INCOMPLETE / VERIFIED verdicts
   - coverage reporting; unrelated evidence does not satisfy a requirement
2. Semantic Goal/Constraint Contract (`goal-contract.js`)
   - deterministic semantic drift measurement
   - explicit detection of dropped `must` / `without` / `preserve` / `never` / security/test constraints
   - versioned original/current intent history
3. Prediction calibration metrics (`prediction-calibration.js`)
   - Brier score
   - Expected Calibration Error (ECE)
   - bounded persisted calibration samples
4. `cognition.js` integration
   - goal contract is updated on changed instructions
   - dropped constraints emit explicit events/gaps
   - verification evidence and calibration are checkpointed in the cognitive snapshot
   - completion is additionally blocked when bound required evidence is incomplete
5. Test runner includes the new regression suites.

## Preservation / security
The following security-critical files were byte-identical before and after the change:

- `shellguard.js` SHA-256 `0f6324b3fd18987db2245413032ca6bf111c0b92017e5a4dcb6f6969ff13427f`
- `netguard.js` SHA-256 `a0f570bd8fb9cfadfeddc140f93d964461b455b5d8741838b6a3340c509dfad7`
- `secrets.js` SHA-256 `9c6a2b0ede0e6623ae1e6b59e7fb6304dc59447a776d30af7866cb0507fce288`
- `securefs.js` SHA-256 `f1fc049386de39b277d628b9f9fb5738756b56584975f0808ec94ef36b2cefd7`

A recursive comparison against the 122.1.1 release shows only these existing files changed:
`CHANGELOG.md`, `package.json`, `cognition.js`, `tests/run-all.mjs`.
New files are the three engines and their two tests. No other prior source/test files changed.

Production security mode remains fail-closed ON; development/test OFF remains an explicit mode in the existing `security-mode.js` design.

## Tests actually executed
- `test-v1222-evidence-goal.mjs`: **10 passed**
- `test-v1222-cognition-integration.mjs`: **1 passed**
- `test-security-mode.mjs`: **6 passed, 0 failed**
- `test-security.mjs`: **246 passed, 0 failed**
- `test-state-writes.mjs`: **36 passed, 0 failed**
- `test-state-concurrency.mjs`: **40/40 updates preserved** when run independently
- `test-checkpoint-integrity.mjs`: **37 passed, 0 failed**
- `test-checkpoint-restore.mjs`: **31 passed, 0 failed**
- `test-v138.mjs`: **6/6 PASS**
- `test-v140.mjs`: **8 passed, 0 failed**
- `test-intelligence-benchmark.mjs`: **10/10 PASS**
- `test-alpha-benchmark.mjs`: **8/8 PASS**
- `test-v103.mjs`: **114 passed, 0 failed**
- `test-v104.mjs`: **114 passed, 0 failed**
- `test-verification-scope.mjs`: included in the existing suite and previously passing; no source changes to `verifyledger.js` in this release
- `test-fs-toctou.mjs`: **83 passed, 0 failed**
- `test-ssrf-pinning.mjs`: passed in the targeted hardening run
- `test-hardening-v21.mjs`: **162 passed, 0 failed**
- `test-version-consistency.mjs`: **29 passed, 0 failed**

## Full-suite honesty
A full `npm test` was started. It did **not** finish within the execution window: the parallel runner reported a `state-concurrency` child failure under concurrent suite load, while the same test passes independently with 40/40 updates preserved; the overall run then timed out. Therefore this release is **not** marked as a full-suite-green release. Targeted regression/security/benchmark evidence above is the evidence for the changes made here.

## Version
`package.json` version: **122.2.0**.
