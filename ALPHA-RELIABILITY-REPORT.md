# Forge 122.1.0 — Alpha Intelligence Reliability Upgrade

Base: `forge-v4-release-122.1.0-alpha-intelligence-v2.zip`

## Implemented

- Added an external `supervisor.js` parent for long-running Forge runs.
- Added bounded restart/backoff after abnormal Forge termination.
- Added project-local `.forge/supervisor-state.json` state evidence.
- Added resource-pressure degradation and Android-aware worker reduction.
- Added `forge supervise ...` CLI wiring, including `--` argument passthrough.
- Added a dedicated test-runner resource policy so `npm test` treats concurrency as a bounded request instead of an unconditional override.
- Raised the runner's headroom wait to 60s and reserved 700MB for the test-runner/OS on the normal path.
- Preserved the existing `profile.js` production spawn policy and existing governor/verification/completion authority.
- Added regression coverage for supervisor, test policy, CLI wiring, packaging, and existing terminal SIGKILL recovery.

## Verified in this environment

- `test-supervisor.mjs`: 8/8 PASS
- `test-alpha-core.mjs`: 12/12 PASS
- `test-alpha-benchmark.mjs`: 8/8 PASS
- `test-intelligence-benchmark.mjs`: 10/10 PASS
- `test-alpha-kernel.mjs`: 14/14 + live wiring PASS
- `test-v140.mjs`: 8/8 PASS
- `test-v138.mjs`: 5/5 PASS
- `test-v137.mjs`: 4/4 PASS
- `test-v100.mjs`: 304/304 PASS
- `test-package.mjs`: 6/6 PASS
- `test-path-hygiene.mjs`: 10/10 PASS
- `test-version-consistency.mjs`: 29/29 PASS
- Root JavaScript syntax audit: 177/177 PASS
- `forge supervise -- version --json`: PASS
- `forge intelligence --json`: PASS (10 deterministic cases, goal drift + stuck detection exercised)

## Not claimed

A complete `npm test` run was attempted with both sequential and adaptive concurrency, but did not finish within the available execution window. Therefore this artifact does **not** claim a full-suite green result.
