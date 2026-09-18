# Architecture Audit — 122.1.1

Generated from the shipped 122.1.1 tree during the hardening pass.

## Current scale

- JavaScript modules: 178
- Test files: 231

## Largest modules

| Module | Bytes |
|---|---:|
| `meta.js` | 210,676 |
| `forge.js` | 157,051 |
| `chat.js` | 154,173 |
| `tools.js` | 148,094 |
| `agent.js` | 114,740 |
| `mcpcatalog.generated.js` | 66,847 |
| `toolintel.js` | 54,882 |
| `skilldl.js` | 54,619 |
| `render.js` | 53,624 |
| `providers.js` | 52,256 |
| `dag.js` | 52,076 |
| `router.js` | 51,624 |
| `capabilities.js` | 50,496 |
| `evalbench.js` | 46,768 |
| `uistate.js` | 44,748 |

## Phase-2 actions

1. Preserve public exports and runtime behavior while introducing domain boundaries.
2. Extract stable interfaces around cognition, execution, intelligence, state, learning, adapters, and runtime.
3. Move implementation behind those interfaces before deleting or renaming legacy modules.
4. Add import-contract tests so forbidden dependency directions fail CI.
5. Keep security-mode behavior explicit: development/test may opt out of enforcement-heavy adapters; production remains fail-closed.

## Evidence gate

- `test-security-mode.mjs`: explicit development/test OFF and production forced ON.
- `test-v122.mjs`: 158 passed.
- `test-v124.mjs`: 48 passed.
- `test-version-consistency.mjs`: 29 passed.
- `test-security.mjs`: 246 passed.
- `test-ssrf-pinning.mjs`: 166 passed.
- `test-state-concurrency.mjs`: 40/40 updates preserved.
- Full `npm test` was not claimed green: the repository-wide run exceeded the execution window; a concurrent run also exposed an existing runner-level contention issue. The failing runner result is retained as evidence rather than hidden.
