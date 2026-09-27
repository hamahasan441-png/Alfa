# Forge V5 — integration audit

Written at v208. It closes the V5 authority work (v202–v208, PRs #85–#91).
Every link below was checked by reading the code and grepping for its call
site. Each link names the file and function, and the check that exercises
it. A link marked **not exercised** is wired, but no suite or bench case runs
it end to end; that is stated, not assumed.

## The authorities

| Concern | Authority | V5 change |
|---|---|---|
| Policy / YOLO | `yolo.js` `yoloState()` | v202: `approveAll` is the one answer to "run without asking?"; `toolintel.js` and `chat.js` read it |
| Completion | `completion.js` (`canCompleteFastPath`, `canCompleteTask`, `isFinished`) | v202: `COMPLETED_UNVERIFIED` is a real final status |
| Recovery | `recovery.js` + `runlog.js` + `taskstate.js` | v203: `recoveryCandidates`; `claimRecovery` / `claimRun` under the state-file lock |
| Review | `review.js` (`normalizeFindings`, `reviewDecision`) | v204: one contract with a basis (OBSERVED / INFERRED / RECOMMENDED); only an OBSERVED blocker blocks |
| Evidence | `verifyledger.js` + `runtimesession.js` | v205: docker image evidence; model and routing epoch on each record |
| Routing | `modelstrategy.js` + `providers.js` failover | v205: every run records the model that ran and each switch |
| Learning | `lessons.js` | v206: failed attempts recorded concretely and flagged on repeat |
| Request size | `tooldefer.js` + `compaction.js` | v207: deferred tool schemas; early observation masking |
| Structure | `treesitter.js` + `langadapter.js` → `codereview.js` | v208: code review is told which declarations a change touched |

## Per path: CLI → controller → governor → executor → evidence → verifier → review → completion

### Normal agent — `forge agent "task"`
| Link | Where | Checked by |
|---|---|---|
| CLI | `forge.js` agent case → `runAgent` (direct), or `core.run` → `runMeta` with `--auto` | e2e `tests/e2e-forge.sh`; bench `request-sends-core-tools-only` |
| Controller | `agent.js` `runAgent` loop | full suite (`test-agent-*`) |
| Governor | `governor.js` `maskToolDefs(tools.defs, …)` and `enforceToolCall` in `agent.js` | `test-v122` |
| Executor | `toolintel.js` `createToolIntel` → `tools.js` `execTool`; v207: `load_tools` handled in `agent.js` `execOffered` | bench `deferred-tool-loads-on-request` |
| Evidence | `commandChecks` (with `artifact`, `model`, `routingEpoch`); `completion.js` `unverifiedWrites` | bench `docker-evidence-has-digest`, `result-names-the-model-that-ran` |
| Verifier | none on the direct path (checks are the model's own commands) | — |
| Review | `review.js` `reviewRun` → `normalizeFindings("checklist")` → `reviewDecision` (gates only with `agent.review: "enforce"`) | bench `review-in-result-file` |
| Completion | `completion.js` `canCompleteFastPath`; `COMPLETED_UNVERIFIED` for uncovered writes | bench `unverified-write-is-not-completed` |

### Chat agent mode
| Link | Where | Checked by |
|---|---|---|
| CLI / controller | `chat.js` dispatch → `runAgent` (chat.js ~1891); the rest of the chain is the normal agent's | `test-chat-*` suites |
| Policy | `chat.js` `runShellLine` confirm: `yoloState(config).approveAll` | grep only: the confirm needs a TTY (**not exercised**; TODO v202) |
| Recovery | `chat.js` `startupRecovery` → `recovery.js` `recoveryCandidates`; [R] → `claimRecovery` / `claimRun` | bench `recovery-offered-once`, `recovery-claimed-once`; the prompt itself needs a TTY (**not exercised**; TODO v203) |

### Resume — `forge tasks --resume`
| Link | Where | Checked by |
|---|---|---|
| CLI | `forge.js` → `taskstate.js` `claimRecovery`, then `core.run(rec.objective, { resumeTaskId })` | bench `recovery-claimed-once` (the claim) |
| Controller | `meta.js` `runMeta` reconciles the DAG and ledger from the task record first | `test-crash-resume` (chat's `/retry` continuation is `test-retry-resumes`) |
| Completion | `meta.js` `attemptCompletion` → `completion.js` `canCompleteTask` | `test-whole-dag-completion` |

### Supervised restart
| Link | Where | Checked by |
|---|---|---|
| Supervisor | `supervisor.js` re-spawns with `FORGE_SUPERVISED=1`, `FORGE_RESTART_COUNT` | `test-supervisor` |
| CLI | `forge.js` `supervisedResumeTarget`: the newest interrupted run with the same task, claimed once | bench `supervised-restart-continues` (direct path) |
| Controller | direct: `runAgent` with `resumeTaskText` as extra context; `--auto`: `core.run(…, { resumeTaskId })` | direct: bench above; `--auto` restart: **not exercised** (TODO v203) |

### DAG (autonomous meta controller)
| Link | Where | Checked by |
|---|---|---|
| Controller | `meta.js` `runMeta`; `dagLib.scheduleBatch` dispatches read-only nodes | `test-meta`, `test-dag-conflicts` |
| Governor | each segment is a `runAgent` run (the normal agent's governor); cognition carries `governorEnforce` | `test-v122` |
| Evidence | `ledger.recordCommand` per segment check (v205: `artifact`, `model`, `routingEpoch` passed through) | `test-v98`, `test-meta` |
| Verifier | `meta.js` `requestVerification` (a read-only verifier run) when evidence is thin for the final risk | reached by the `test-v99` §7 stub (verifier branch), not asserted on its own |
| Review | the checklist (`omega.review`) → `review: ` actions; code review (`runCodeReview`) → `codereview: ` actions, re-derived at every attempt (v204); v208: changed functions in the reviewer's facts | bench `code-review-blocker-reaches-gate`, `inferred-finding-never-blocks`, `review-knows-the-changed-function` |
| Completion | `attemptCompletion` → `canCompleteTask` (DAG complete, workers settled, evidence for the final risk, no pending required action) | `test-whole-dag-completion`; bench `code-review-blocker-reaches-gate` |
| Delivery | `gitship.js` `maybeShip`, only after a passing gate; never force-push; opt-in via user-level config | `test-v98`, `test-v99` §8 |

### Crew (DAG workers by role)
| Link | Where | Checked by |
|---|---|---|
| Routing | `crewroute.js` `createCrewRouter`; `crewRouter.record` per worker outcome (with `job.model`) | `test-fastwise`, `test-unifywise`, `test-v121` |
| Review | `selfreview.js` `reviewWorkerResult` → v204 `normalizeFindings("selfreview")`: INFERRED, never blocking | the meta suites reach it; not asserted to land in `review` (**TODO v204**) |

### YOLO
| Link | Where | Checked by |
|---|---|---|
| Policy | `yolo.js` `yoloState`, read by `agent.js`, `chat.js`, `forge.js`, `meta.js` and `toolintel.js` | bench `yolo-means-no-asking`; `test-yolo-no-refusal`, `test-yolo-unlimited`, `test-yolo-secrets` |
| Discipline kept | evidence, completion honesty (`COMPLETED_UNVERIFIED`), the review contract and checkpoints stay on under YOLO; netguard, the injection fence and run limits are unchanged | the bench cases above run with `--yolo` |

## Checked and found sound (no change)

- **Git:** `gitship` ships only after meta's passing gate; there is no
  force-push (the one `--force` is a local `git worktree remove`); `gitship`
  is a privileged, user-level-only config section.
- **Skills:** a download is never active by itself. `activateVerifiedDownload`
  requires VERIFIED, and `indexVerifiedSkills` offers only VERIFIED or ACTIVE
  downloads with fresh evidence.
- **Version:** `version.js` reads `package.json` once, and
  `scripts/bump-version.mjs` updates the pins.
- **Project config:** the `PRIVILEGED_*` denylist covers every privilege key.

## What V5 did not settle

These carry over in `TODO.md`:
- the TTY-only chat prompts, which are read from the source rather than
  exercised;
- the `--auto` supervised restart, which isn't exercised end to end;
- no bench case covers meta routing;
- file edits aren't remembered as failed attempts;
- the system prompt (~1.8k tokens) wasn't reduced;
- plugins aren't deferred;
- the prompt-cache cost of a tool load or a masking batch wasn't measured;
- `nudge-names-the-failed-check` stays the open bench case.
