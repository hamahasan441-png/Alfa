# Release evidence — v129.0.0 "the measuring stick"

Stage 0 of the upgrade programme. This release adds **no capability**. It adds
the instrument that every later stage will be judged by, and writes down the
line to beat.

## Why

"Beat your own benchmark" needs one benchmark. forge had five, each answering a
different question, none combining:

| harness | question | state |
|---|---|---|
| `bench.js` | is the decision quality right? | **24/24, 100%** — pinned there by `tests/test-v29.mjs` |
| `perfbench.js` | how fast are the tools? | timings vs a saved baseline |
| `evalbench.js` | was the task actually solved? | needs a live provider |
| `agent-benchmark.js` | (wraps `evalbench`) | `NOT_RUN` without one |
| `intelligence-benchmark.js` | deterministic integration | its own score |

A benchmark already at 100% is a thermometer stuck at one reading. `bench.js`
is a **regression guard** and is deliberately frozen — so it can never be the
growth target.

`benchsuite.js` composes the existing harnesses (§36 — not a sixth) and adds a
`programme` lane holding capabilities forge does **not** have yet.

## The baseline (v128.0.0, this tree)

```
FORGE-SUITE v128.0.0  39/49  score 79.6%
  capability   24/24   100%     <- guard, frozen
  programme     0/10     0%     <- the room above the benchmark
  speed        15/15   100%     <- vs a locally saved perf baseline
  autonomy    SKIPPED           <- no live provider
```

Without a saved perf baseline (the CI case) the suite reads **24/34, 70.6%**.

### Boot cost, measured

A first pass at this ran `time node forge.js --version` once and read **1.0s**.
Both halves were wrong: a single run is mostly cold cache and shell overhead,
and `--version` short-circuits long before the agent loads. Best-of-7, spawned:

| path | best-of-7 |
|---|---|
| bare node process | 28ms |
| `forge --version` | 81ms |
| **`import agent.js`** | **178ms** |
| `import chat.js` | 205ms |

So startup is not 1.0s and never was. What is real is **~150ms of eager module
loading** before an agent run can do anything — 48/56/33 top-level imports in
`agent.js`/`chat.js`/`tools.js` against 17/76/4 lazy ones. The `boot-budget`
case targets **120ms** and fails today at ~180-210ms.

### Test lanes

| lane | result |
|---|---|
| fast lane (`FORGE_FAST=1 FORGE_SECURITY_MODE=off`) | **259/259 suites** (twice) |
| security-enforcement lane | **494/494 assertions** |

## The ten open programme cases

Every one verified absent by measurement, not assumed. `mcp.js` greps for
`sampling`, `roots`, `ping`, `progressToken`, `notifications/cancelled`,
`logging/setLevel` all return **zero**, and its `initialize` sends
`capabilities: {}` under the comment *"a minimal client: we consume tools,
advertise nothing"*.

| case | today |
|---|---|
| `mcp-protocol-current` | `PROTOCOL_VERSION=2024-11-05`, want ≥ 2025-03-26 |
| `mcp-capabilities-declared` | no `clientCapabilities()` |
| `mcp-cancel` | no `cancelCall()` |
| `mcp-progress` | no `onProgress()` |
| `mcp-sampling` | no `handleSampling()` |
| `mcp-roots` | no `listRoots()` |
| `mcp-ping` | no `pingServer()` |
| `tool-result-summary` | `context.js` has no `summarizeToolResult()` |
| `single-file-build` | `scripts/build-single-file.mjs` missing |
| `boot-budget` | ~180-210ms against a 120ms budget |

## Rules this instrument enforces on itself

- **A failing programme case is not a broken build.** Those cases fail by
  design until the capability ships. Only the guard lanes (capability, speed)
  set the exit code — otherwise CI would be red forever and stop being read.
- **A lane that cannot run is SKIPPED**, never passed and never failed, and is
  excluded from the denominator.
- **Every case declares how strongly it is checked** — `exercised`, `measured`
  or `surface`. A surface check is weaker evidence and says so rather than
  being quietly counted as equal.
- **A budget that cannot fail is not a budget.** `tests/test-benchsuite.mjs`
  asserts the boot budget is strictly BELOW today's measured cost.

## Known open issue found while building this

**`bench.js` case `24-reviewer-fixer-planner` is flaky under test concurrency.**
It failed its `toolCalls` check (the slot holding its `custom()` predicate)
during a 4-way `run-all`, taking the capability lane to 23/24. It does **not**
reproduce:

- 12 consecutive in-process `runBench()` calls — clean
- the same, under 6 spinning CPU hogs — clean
- 8 consecutive `forge bench --cases` subprocesses — clean
- 5 consecutive `runSuite()` calls in one process — clean
- every sub-assertion of the case, run standalone from both the repo root and
  `tests/` — all pass

So it needs genuine cross-suite concurrency to appear. Not introduced by this
release; recorded rather than absorbed, because a flaky regression guard is
worse than no guard. Tracked in `TODO.md`.

`tests/test-benchsuite.mjs` deliberately does **not** re-assert that the
capability lane is 100% — that is `test-v29`'s job, and duplicating it made
this suite fail for reasons unrelated to what it tests. This suite owns the
composition: how lanes combine, skip and classify.
