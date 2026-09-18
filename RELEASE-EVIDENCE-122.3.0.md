# Forge 122.3.0 — Release Evidence

## Scope
Outcome Learning v2 and live cognition learning-path correction only.

Security implementation was not modified in this phase. Security files were hash-checked after the change.

## Changes
- `outcome-model.js`: v2 conservative strategy learning.
  - bounded recent outcome history (max 16 per strategy)
  - Wilson 95% lower confidence bound
  - recent evidence blended conservatively with the confidence bound
  - existing sample threshold and minimum score-gap retained
  - repair/replan churn penalty retained
  - learned outcomes remain advisory and cannot manufacture completion or bypass governor authority
- `cognition.js`: fixed close-path ordering so `finalGate` is computed before strategy/reasoning/outcome persistence.
  - This removes a TDZ failure that could silently skip meta-ledger writes.
- `tests/test-v140.mjs`: added v2 persistence/conservatism checks.
- `tests/test-outcome-close.mjs`: added live-path regression test for final outcome persistence.
- `package.json`: version 122.3.0.

## Targeted test evidence
- v140 alpha-core: **8 passed / 0 failed**
- outcome-close regression: **2 passed / 0 failed**
- v101 instrument suite: **225 passed / 0 failed**
- state concurrency: **40/40 updates preserved**
- version consistency: **29 passed / 0 failed**

## Full-suite status
`npm test` was started with a 180-second timeout but did not complete within that window. Therefore this release does **not** claim a green full-suite result.

The partial full-suite log reached the normal test-runner sequence through `autonomy` before timeout; no full-suite pass count is inferred from that partial run.

## Security integrity
The following hashes match the previous security-integrity record for the security modules that were protected in the prior release:

- `shellguard.js`  `0f6324b3fd18987db2245413032ca6bf111c0b92017e5a4dcb6f6969ff13427f`
- `netguard.js`    `a0f570bd8fb9cfadfeddc140f93d964461b455b5d8741838b6a3340c509dfad7`
- `secrets.js`     `9c6a2b0ede0e6623ae1e6b59e7fb6304dc59447a776d30af7866cb0507fce288`
- `securefs.js`    `f1fc049386de39b277d628b9f9fb5738756b56584975f0808ec94ef36b2cefd7`

`contentfence.js` was not edited in this phase either; its current hash is recorded in `SECURITY-INTEGRITY-122.3.0.sha256`.

## Preservation
No files were intentionally removed. Existing APIs, governor authority, verification gates, checkpointing, routing, memory, tools, skills, and security modules remain in the tree. The only behavioral changes in this phase are bounded outcome-learning refinement and the close-path persistence fix described above.
