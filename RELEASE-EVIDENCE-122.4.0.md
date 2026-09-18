# Forge 122.4.0 — Release Evidence

Date: 2026-09-18

## Scope

This release continues from **122.3.0** and implements the next roadmap stage:

- honest live-agent benchmark wrapper over the existing hidden-test eval harness;
- benchmark contract regression tests;
- CI/release gate workflow;
- version metadata updated to 122.4.0.

**Security implementation was not changed in this phase.** Development/test mode uses `FORGE_SECURITY_MODE=off`. Production remains fail-closed; the existing security-mode contract test was run with `NODE_ENV=production` and `FORGE_SECURITY_MODE=off`.

## New benchmark behavior

`agent-benchmark.js` calls the existing `evalbench.js` hidden-test harness. It reports `NOT_RUN` when no usable live provider exists instead of fabricating a score. A real provider run reports `MEASURED` and uses hidden verification as the solve verdict.

Current environment had no usable live provider, so the live benchmark result was:

- status: `NOT_RUN`
- tasks available: 27
- exit code: 2 (setup unavailable, not a benchmark pass)

## Tests run and passed

- agent-benchmark contract: **10/10**
- intelligence benchmark: **10/10**
- verification/goal/calibration: **10/10**
- cognition integration: **1/1**
- alpha core: **12/12**
- alpha benchmark: **8/8**
- supervisor: **8/8**
- state writes: **36/36**
- state concurrency: **40/40**
- checkpoint integrity: **37/37**
- checkpoint restore: **31/31**
- v138 E2E: **6/6**
- v140: **8/8**
- v103: **114/114**
- filesystem TOCTOU: **83/83**
- security mode contract: **6/6**
- version consistency: **29/29**
- `npm pack --dry-run`: package metadata/version valid and `agent-benchmark.js` included.

## Full-suite status

A complete `npm test` run was attempted. It did not finish within the available execution window, so this release **does not claim a full-suite green result**.

The development/test runner intentionally omits enforcement-heavy suites when `FORGE_SECURITY_MODE=off`; those suites would otherwise assert redaction/fencing behavior that is deliberately disabled in this mode. The production security-mode contract remains separately tested.

## Preservation audit

Compared byte-for-byte against the 122.3.0 release archive:

- missing files: **0**
- changed existing files: **5**
  - `CHANGELOG.md`
  - `README.md`
  - `package.json`
  - `tests/run-all.mjs`
  - `tests/test-version-consistency.mjs`
- new files: **3**
  - `.github/workflows/ci.yml`
  - `agent-benchmark.js`
  - `tests/test-agent-benchmark.mjs`

Security files were byte-identical to 122.3.0:

- `shellguard.js`
- `netguard.js`
- `secrets.js`
- `securefs.js`
- `contentfence.js`
- `security-mode.js`

No existing security file was modified.
