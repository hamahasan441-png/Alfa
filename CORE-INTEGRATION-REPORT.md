# Forge 122.1.0 — Core Integration Pass

## Scope
Additive wiring correction only. Existing governor, planner, verification, completion, Alpha Intelligence, memory, recovery, tools, skills, MCP, supervisor, and terminal systems remain intact.

## Corrected lifecycle

`PREDICT -> EXECUTE -> OBSERVE -> VERIFY`

for a successful covering check, and:

`PREDICT -> EXECUTE -> OBSERVE -> DIAGNOSE -> REPAIR/REPLAN`

for an observed command failure.

## Fix
The live cognitive state previously attempted `VERIFY -> OBSERVE` after a covering check. `VERIFY` intentionally does not allow that transition, so the lifecycle could remain stuck in `VERIFY`. The observation is now recorded first; only then is `VERIFY` entered for a covering check.

Failed command observations now explicitly enter `DIAGNOSE`, giving repair/replan a truthful lifecycle state.

## Evidence
- `node --check cognition.js` — PASS
- `node --check tests/test-alpha-kernel.mjs` — PASS
- `node tests/test-alpha-kernel.mjs` — PASS
- `node tests/test-v137.mjs` — PASS (4/4)
- `node tests/test-v138.mjs` — PASS (5/5)
- `node tests/test-v140.mjs` — PASS (8/8)
- `node tests/test-alpha-core.mjs` — PASS (12/12)
- `node tests/test-alpha-benchmark.mjs` — PASS (8/8)
- `node tests/test-intelligence-benchmark.mjs` — PASS (10/10)
- `node tests/test-v100.mjs` — PASS (304/304)

The full `npm test` suite was not claimed as complete in this pass.
