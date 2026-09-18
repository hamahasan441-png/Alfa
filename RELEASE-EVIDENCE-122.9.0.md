# Forge 122.9.0 — Release Evidence

## Baseline
- Built from the verified 122.8.0 artifact.
- No baseline files were deleted: 0 missing.
- Added files: `horizon-intelligence.js`, `tests/test-horizon-intelligence.mjs`.
- Existing subsystems were retained; the new horizon layer is advisory/deterministic and does not execute tools or bypass authority.

## Implementation
- Deterministic horizon DAG validation (missing dependency + cycle detection).
- Adaptive dependency-safe execution frontier with bounded parallelism.
- Evidence/failure/budget-aware horizon decision (`CONTINUE`, `REPLAN`, `VERIFY`, `INVESTIGATE`, `CHECKPOINT`).
- Bounded, serializable checkpoint state for resume.
- Integrated into the cognitive boot snapshot and brief as an additive intelligence surface.
- Version metadata updated to 122.9.0.

## Targeted verification
- `test-horizon-intelligence.mjs`: **8/8 PASS**
- `test-intelligence-next.mjs`: **9/9 PASS**
- `test-intelligence-advanced.mjs`: **6/6 PASS**
- `test-intelligence-next-integration.mjs`: **7/7 PASS**
- `test-cognition.mjs`: **51/51 PASS**
- `test-state-concurrency.mjs`: **40/40 PASS** (standalone)
- `test-processguard.mjs`: **7/7 PASS**
- `test-security-mode.mjs`: **6/6 PASS**
- `test-security.mjs`: **246/246 PASS**
- `test-checkpoint-integrity.mjs`: PASS (all assertions completed)
- `test-checkpoint-restore.mjs`: **31/31 PASS**
- `test-node-verification-gate.mjs`: **42/42 PASS**
- `test-final-risk-recalculation.mjs`: **44/44 PASS**
- `test-verifier-readonly.mjs`: **52/52 PASS**
- `test-version-consistency.mjs`: **29/29 PASS**
- `test-package.mjs`: **6/6 PASS**
- Syntax checks for changed JS files: PASS.

## Preservation/security verification
Security-critical files were hashed before and after the change and produced identical hashes:
- `security-mode.js`: `7e1fda31dbafb30df79fbb3357829f5e25e19da1bb376a964e840144f93eb69f`
- `shellguard.js`: `0f6324b3fd18987db2245413032ca6bf111c0b92017e5a4dcb6f6969ff13427f`
- `netguard.js`: `a0f570bd8fb9cfadfeddc140f93d964461b455b5d8741838b6a3340c509dfad7`
- `secrets.js`: `9c6a2b0ede0e6623ae1e6b59e7fb6304dc59447a776d30af7866cb0507fce288`
- `securefs.js`: `f1fc049386de39b277d628b9f9fb5738756b56584975f0808ec94ef36b2cefd7`
- `contentfence.js`: `9b90dea0e21164af37892220c8c989c47f127f27aa2933ac91cedfdfe5ed6e63`

Security mode behavior remains: development/test can opt out; production remains fail-closed.

## Full-suite status
`FORGE_FAST=1 FORGE_TEST_CONCURRENCY=1 node tests/run-all.mjs` was attempted but did not finish within the execution window. During the attempt, the existing `state-concurrency` suite produced an intermittent child-writer exit-1; its standalone rerun passed 40/40. Therefore **the full suite is NOT VERIFIED GREEN** for this release.

## Live benchmark
No fabricated live-model score was produced. A real provider is required for live-agent benchmarking.
