# forge / Alfa — how a task runs (the "one brain" map)

This file is the map for the "one brain" work (upgrade plan, Phase 4). It says
which module decides what today, what is already unified, and what is left —
with the reason each remaining step is not done yet.

## The one entry point

Every way of starting work goes through `runtask.js`:

| Caller | How |
|---|---|
| `forge agent "task"` | `runTask({ mode: chooseRunMode(...) })` |
| interactive / piped chat | `runTask({ mode: "meta" })` when the controller is chosen; the single loop is still called directly (it needs chat-only options: `extraContext`, `continueFrom`, `plan`) |
| `forge tasks --resume` | `runTask({ resumeTaskId })` — a resume is always the controller |
| `forge eval --mode auto\|meta` | `makeModeRunner` → `runTask` |
| `forge queue run` | each item is a `forge agent` child, so the first row applies; a `--repo` item is a `forge run --repo` child |
| `forge run --repo` | `reporun.js` → `runTask({ mode: "meta" })` inside the clone, delivery through gitship |
| `forge web` | `runTask`, or `runOnRepo` when a repo is given |

`runmode.js` `chooseRunMode` is the only rule for single loop vs controller
(plan mode, resume, `--single`/`--auto`, `FORGE_RUN_MODE`,
`agent.autonomous`, headless, then the task's size). `adaptMetaResult` is the
only adapter from the controller's result to the agent-result shape.

## The two engines

```
runTask
 ├─ single loop   agent.js runAgent
 │                 └─ cognition.js (governor.js, jointroute.js, goal-contract.js,
 │                    advisory: alpha-intelligence, intelligence-*, horizon-*,
 │                    omega, v4, autonomy-level2)
 └─ controller    core.js → meta.js runMeta
                   ├─ plan: dag.js (+ plannerisk, plancritique, replan, classify.synthesizePlan)
                   ├─ workers: agentmanager.js (+ worktree.js), each a runAgent sub-run
                   ├─ models: chain.js (yours) → crewroute.js / modelstrategy.js (measured)
                   ├─ completion: verifyledger.js + completion gate
                   └─ final answer: combine.js (plan, files, acceptance, conflicts)
```

The controller's workers ARE single-loop runs, so the single loop's cognition
already runs inside the controller — the two engines share the per-step brain;
what differs is who owns the task (one loop, or a plan of nodes).

## What is left, and why it is not done yet

1. **Make the single loop a one-node plan of the controller.** `meta.js`
   already has a MICRO fast path (one synthesized node, no model-written plan).
   Routing every task through it would leave one engine. Not done because the
   two paths have different, separately tested contracts (result shape,
   streaming dock, checkpoints, `--result-json`), and the only way to prove the
   switch does not make forge worse is a live-model eval (`forge eval --mode
   single` vs `--mode meta` on the same tasks, `scripts/measure.mjs
   --compare`). This environment had no model access.
2. **One router.** `chain.js` (explicit) → `crewroute.js` (per role, measured)
   → `modelstrategy.js` `selectModel` (per task, measured) → `jointroute.js`
   (depth + model + skill). The chain now wins wherever you set it; folding the
   three measured routers into one score is the next step, gated by the same
   eval.
3. **Advisory layers.** `alpha-intelligence`, `intelligence-*`, `horizon-*`,
   `omega`, `v4`, `autonomy-level2` are advisory (the governor, verifier and
   completion gate stay authoritative). They are already off the boot path
   except `v4.js` and `autonomy-level2.js`. Whether each one earns its place is
   a measurement question: an A/B (`forge eval --ab` style) with the layer off.
   Removing them without that number would be a guess.

## Boot

The installed `forge` command is `forge-boot.js`, which switches on Node's
on-disk compile cache before anything else is compiled (Node >= 22.1). Measured
on a 2-core box: importing the agent 147 ms → 115 ms with the cache warm (the
120 ms budget), `forge --help` 83 → 76 ms. The browser driver is no longer
loaded at boot (`browserpolicy.js` holds the sync rules). `scripts/measure.mjs`
records both cold (`boot.ms`) and cached (`boot.cachedMs`) numbers.
