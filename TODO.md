# forge — TODO (deferred work)

This file is the ONLY place where unfinished ideas, known gaps and deferred
work live. A shipped version must not keep a PLAN file: completed plans are
deleted at release time and their leftovers move here. Do not keep a PLAN
file for work that already shipped — if it shipped, the plan is history; if
it did not ship, it belongs on this list.

Status: **deferred items remain open** — every item below is intentionally not completed / not yet shipped. The seven
runtime/sandbox/search/checkpoint/LSP/tool-creation gaps that lived here
through v94 "fastwise" are CLOSED (v94 "todowise": `tests/test-todowise.mjs`,
81 assertions, suite registered in run-all — an item only moves out of this
file when a test proves the behavior exists, and each one now has exactly
that). The kernel item — isolated worktree execution for DAG nodes — is
CLOSED by v95 "worktreewise" (`tests/test-worktreewise.mjs`, 75 assertions,
9 sections: lifecycle, isolation invariant, conflict honesty, eligibility,
gates, orphan sweep, child-process runner, meta integration, surface-dedup
audit). v96 "unifywise" additionally closed the WIRING ledger — the
computed-then-ignored surfaces, dropped resume state, dead event vocabulary,
unfed ledgers and duplicated implementations found by the five-module deep
audit — each pinned by `tests/test-unifywise.mjs` (72 assertions) and
`tests/test-envfingerprint.mjs` (27 assertions). v98 "shipwise" closed the
v97 leftovers — LSP structured extraction wired into the index path
(langstruct.js, pinned by `tests/test-v98.mjs`), browser visual regression
(visual_diff baselines), artifact verification (observed build outputs as
VTYPE.ARTIFACT ledger evidence), and chunked/async world-model walking
(buildAsync + the 0=unlimited resolver fix). History in the CHANGELOG.

## v196 "/plan that the run follows" — leftovers

- [ ] **No new open case this release.** The open programme case is
      `nudge-names-the-failed-check` (v194); a chat-continuity case for v197
      (two stopped runs in one session) is still to be written.
- [ ] **A step is done when the model says so** (the `todo` tool). Nothing
      checks a step's evidence before it is ticked.
- [ ] **A plan written as prose paragraphs** ("First … Then … Finally …")
      has no steps, so no checklist is seeded.
- [ ] **The todo list is one per machine** (`~/.forge/todo.json`), so a plan
      started in one project replaces another project's list.

## v195 "fresh model lists" — leftovers

- [ ] **`nudge-names-the-failed-check` (v194) is still open** — left for a
      fresh session.
- [ ] **Only chat refreshes a stale list.** `forge agent` one-shot runs and
      the setup wizard read the cache as it is.
- [ ] **A refresh that fails is silent** and the old list stays; the next
      chat tries again.

## v194 "prompt engineering: said once, plainly" — leftovers

- [ ] **The open programme case is `nudge-names-the-failed-check`** — the
      first open case in the PROMPT discipline. A model that ran `npm test`,
      saw it fail and answered "all tests pass" is told "you changed files
      but never ran a check" — false, and silent on the check it ran and
      what it printed. Shown passable by naming the failed check, its exit
      code and its failing line instead; next.
- [ ] **A repeated start of ONE word is kept** ("the the" can be real), so
      a continuation that repeats just the last word still shows it twice.
- [ ] **A continuation is held back for up to ~32 words** before it
      appears, so the first words of the rest arrive in one piece.
- [ ] **The prompt's other blocks** (steer, compose, engine) were not
      reviewed line by line in this release; the three new guard cases
      cover what they check (numbering, JSON, repeats), not wording.

## v193 "a pipe that ends in head returns when head has its lines" — leftovers

- [ ] **A check piped into `| head` is cut short, as in the shell.** One
      that prints more than head keeps no longer runs to its end: its
      result is the one it had when the pipe closed (often 1, EPIPE). The
      note says so and suggests `| tail`. v168 ran it to the end and
      reported its real result — and hung on a check that never ends.
- [ ] **A `head` in the middle of the stages** (`| head -50 | grep x`) is
      still taken over (v189): the stages run after the check ends.

## v192 "the last check failed, and the card says so" — leftovers

- [ ] **The run still ends COMPLETED, exit 0**, when its last check failed:
      the card says it now, and the result file has `lastCheck`. Whether a
      failing final check should fail the run is still a policy question
      (v168).
- [ ] **Only the LAST check is named.** A failing check followed by a
      passing one of a different command (`npm test` fails, `npm run lint`
      passes) is not named.

## v191 "a check's own status, whatever follows it" — leftovers

- [ ] **A check inside `( … )`, `{ … }`, `if` or a loop** is not marked
      (the command is left exactly as typed), so its status can still be
      hidden by what follows.
- [ ] **A command that redirects stderr for the rest of the shell**
      (`exec 2>/dev/null; npm test; …`) swallows the status line; forge then
      records the command's status, as before.
- [ ] **Several checks in one command are one recorded check**: it fails if
      any of them failed.

## v190 "a failing piped check stops the chain" — leftovers

- [ ] **A pipeline inside `( … )`, `{ … }`, `if`, `for`, `while` or `case`**
      is left exactly as typed, so it still reports its last stage.
- [ ] **A check cut short by `| head -1` reports SIGPIPE (141)** inside a
      chain, as `pipefail` would. The tests did not finish, so what follows
      its `&&` does not run.

## v189 "a check keeps its exit code through any filter" — leftovers

- [ ] **The stages run after the check, not beside it.** A check that
      prints forever into `| head -1` is no longer cut short by the pipe
      closing; it runs to its timeout. The output is the same.
- [ ] **A stage's own failure is shown, not its exit code.** A bad regex
      prints grep's message under the check's output; the exit code is the
      check's.

## v188 "a free model that can call tools" — leftovers

- [ ] **Only OpenRouter says which models take tools** (v195 also reads
      `capabilities.function_calling`/`tools` and `supports_tools`). Other providers'
      lists carry no such field, so their free models rank as before
      (unknown counts as able).
- [ ] **A cache written before v188 has no `tools` field** until the next
      `forge models` / `/models` refreshes it.
- [ ] **The onboarding picker's "no tools" badge** is display only and is
      not covered by a test (the picker needs a terminal).

## v187 "a note stays with its project" — leftovers

- [ ] **Notes already in global memory stay there.** A note about one
      project saved before v187 is still read by every project until it is
      forgotten (`forge memory forget <n>`, or the model's `forget`, which
      now looks in global memory when the project has no match).
- [ ] **Which tier a note belongs in is the model's call.** A note about
      the user saved without `scope: "global"` stays with the project it was
      written in. The tool description asks for global only for what is
      true of the user in every project.

## v186 "model names are not secrets" — leftovers

- [ ] **A secret made of words passes when nothing names it.**
      "correct-horse-battery-staple-orange" with no `password=` in front of
      it looks like an identifier, and by shape alone it is one.

## v185 "YOLO shows secrets as they are" — leftovers

- [ ] **Before the release: decide YOLO's default.** YOLO ships on, so this
      build redacts nothing unless YOLO is turned off or NODE_ENV=production.
- [ ] **Secrets written during YOLO stay written.** Sessions, memory and run
      logs saved while YOLO was on hold values as they were; turning YOLO off
      redacts what is written after, not what is already on disk.

## v184 "a live free model suggested" — leftovers
- [ ] **A stale cache is still preferred to the built-in id** (chat refreshes
      a week-old one since v195). The cache is
      as old as the last `/models`.

## v183 "/plan asks every plan's questions" — leftovers

- [ ] **A question in prose must end the line with "?".** "I need to know
      whether empty rows stay." is not asked.

## v182 "raised rate limits noticed" — leftovers

- [ ] **A probe that draws a 429 pays that 429's wait.** For a per-minute
      limit that's a window of up to 20s, once per process per account.
- [ ] **Probing is per process.** A new run starts again from the stored
      (possibly raised) pace.
- [ ] **`boot-budget` sits at its budget on this machine** (117–126ms
      against 120ms, v179 measuring the same today), so it passes or fails
      with machine load. More headroom means splitting core modules (see
      v179's leftovers).

## v181 "the result file carries the checks" — leftovers

- [ ] **The autonomous controller (`--auto`) reports only its verdict** in
      `checks`, not the individual commands its segments ran.

## v180 "provider errors shown whole" — leftovers

- [ ] **The reported seekai 400 itself is not diagnosed.** Its full message
      is now visible; what it said decides whether forge can recover (for
      example, if it is a token limit, ask for fewer output tokens).

## v179 "faster boot" — leftovers

- [ ] **forge.js's own static imports aren't covered by the compile cache.**
      They load before the cache is turned on. The lazily loaded agent, chat
      and tool graphs, the bulk, are covered.
- [ ] **What's left of boot is the graph every run needs.** 107 modules, with
      crypto and child_process among the built-ins. Further gains mean
      splitting core modules, not deferring them.

## v178 "`/plan go` after a restart" — leftovers

- [ ] **Sessions saved before v178 carry no waiting plan.** Their plan is in
      the history and in `.forge/plans/` (`forge plan apply <slug>` runs it),
      but `/plan go` can't see it.

## v177 "provider failures named" — leftovers

- [ ] **A rate-limited sub-agent's "retry once"** is advice to the model;
      nothing waits out the limit before the retry. (The provider layer
      already paces the parent's own requests, v167/v169.)

## v176 "a dropped answer is finished" — leftovers

- [ ] **The agent's own non-streamed requests** can't be dropped this way:
      a JSON body that is cut off fails to parse and is retried. Only chat
      streams.
- [ ] **A continued answer can repeat a word or two** where the pieces meet,
      if the model doesn't follow "do not repeat". The pieces are joined as
      given. (Fixed in v194: the note quotes where it stopped, and a
      repeated run of 2+ words is trimmed.)

## v175 "`retry` means /retry" — leftovers


## v174 "state for deleted projects is cleaned up" — leftovers

- [ ] **A folder older than v174 is pruned only if its `index.json` proves
      its directory.** 1,172 of 5,549 folders in one home prove nothing and
      are kept. They stop growing now that every folder records its root.
- [ ] **A project whose parent directory was also deleted is kept.** The
      "parent still exists" guard, which protects unmounted drives, can't
      tell that apart from a deleted tree.

## v173 "/retry after a restart" — leftovers

- [ ] **A saved stopped run is trimmed from the oldest turns.** A run that
      needed a very early tool result gets it again by re-reading, not from
      the saved conversation.
- [ ] **Only the latest stopped run is kept per session.** Stopping a second
      run replaces the first.

## v172 "audit round 2, and tee" — leftovers


## v171 "nothing switched off in silence" — leftovers

- [ ] **The ESLint guard needs ESLint on the PATH.** Without it the guard is
      skipped, and says so. forge itself has no runtime dependencies.

## v170 "what the provider actually said" — leftovers

- [ ] **A cut-off answer that turns into a tool call** loses its partial text
      from the final answer. The text stays in the conversation.

## v169 "remember what the provider allows" — leftovers


## v168 "one check, however it is typed" — leftovers

- [ ] **A run can end COMPLETED after its last check failed.** The card now
      reports those writes as unverified, but the completion gate gives an
      unverified write one "verify" nudge, not a block. Whether a failing
      final check should block completion is a policy question.
- [ ] **Only `| tail -N` / `| head -N` are taken over.** A check piped through
      `grep`, `tee` or several stages still reports the last stage's code.
      (`| tee` since v172; any plain chain of filters since v189; a piped
      check inside a longer command carries its own status since v190.)
- [ ] **Normalisation is a fixed list.** `yarn test` vs `yarn run test` and
      the npm aliases are known; other runners' aliases are not.

## v167 "wait out the limit" — leftovers

- [ ] **Only stated limits are paced.** A 429 that names no count still
      waits out a per-minute window, but later requests are not spaced.

## v166 "pick up where it stopped" — leftovers

- [ ] **Continuing is for runs started from chat.** Piped sessions and
      `forge agent` go through the task controller, whose resume is
      `forge tasks --resume` (DAG, ledger and checkpoints). `/retry` there
      still starts the task again.
- [ ] **The kept conversation lives in memory**, so it is gone when chat
      exits. The files a run changed stay on disk, and a new session's
      /retry starts over.

## v165 "out of credits, said plainly" — leftovers

- [ ] **Failover needs a provider you have tested** (`forge provider test`).
      An env key alone is not consent to send the conversation elsewhere,
      so with one provider a spent balance still stops the run.

## v164 "plan it with me, then start" — leftovers

- [ ] **The plan is not a checklist the run ticks off** (fixed in v196:
      the steps seed the todo list). The run gets the
      approved plan as text and is told to follow it and say why before
      departing from a step. Nothing checks step by step that it did.

## v163 "what the balance covers" — leftovers

- [ ] **The cap only goes down.** Topping up mid-session does not raise it
      again. A new session starts with no cap.
- [ ] **Only the "can only afford N" wording is read.** A gateway that words
      its 402 differently gets the plain billing hint and no retry.
- [ ] **Deep mode on the Anthropic wire** reserves a thinking budget inside
      `max_tokens`. A cap under about 2048 leaves the model little room to
      answer after thinking.

## v162 "the other way to talk" — leftovers

- [ ] **The transport is found again for every connection.** A server that
      refused `initialize` once is asked again on every new connection
      (one extra POST).
- [ ] **A call in flight when the SSE stream ends fails.** It is not re-sent,
      because a tool may already have run. The next call reconnects.
- [ ] **`websocket` servers are still skipped** by `--mcp-config`. No MCP
      spec revision defines that transport.

## v161 "yours to keep, yours to drop" — leftovers

- [ ] **`forget` of a rule needs the person's words quoted exactly**, the same
      way minting one does. "You can use npm again" doesn't name the rule, so
      the model has to quote it ("forget the rule '…'"), or the person runs
      `forge memory forget <n>`.

## v160 "your words, and only yours" — leftovers

- [ ] **A rule quoted from a task is only as good as the task.** If the
      person pastes untrusted text into their own request, a quote from it
      is "their words". That's deliberate: forge can't tell their
      intentions from their paste.

## v159 "what you told it to remember" — leftovers
- [ ] **Rules are only what `forge memory add` wrote.** A line typed into
      memory.md by hand has no provenance and is not a rule. Neither is an
      entry written by a forge older than provenance.

## v158 "kept when proven" — leftovers
- [ ] **A lesson credits everything between its check's failure and pass.**
      When two checks fail before either is fixed, the second check's lesson
      also credits the first check's fix. The rule doesn't guess which command
      helped; pinned in `test-lesson-when-proven.mjs`.
- [ ] **v157's judgement still happens at the end of the run.** A run
      stopped by a signal records the lessons it proved (v158) but does not
      judge the lessons it re-applied.

## v157 "a fix that stopped working says so" — leftovers
- [ ] **A lesson's judgement is per run, not per re-application.** Re-applying
      it twice in one run, once failing and once passing, counts only the
      last check after the latest re-application.
- [ ] **Unproven lessons (blocked runs' next steps) are never judged.**
      Their `solution` is free text, with no check or repair to match.

## v156 "what a command fixed" — leftovers
- [ ] **Credited commands are matched by their exact text.** Re-running
      `npm i` for a lesson that says `npm install` is not recognised as the
      same repair. Opened in v162 as `lesson-repair-respelled`.
- [ ] **A state-changing command is judged by its verbs.** An interpreter
      running a script (`node x.js`, `python y.py`) always counts as a
      possible repair, even when the script only reads.

## v155 "knowledge that outlives the next edit" — leftovers

- [ ] **Lessons are never credited or blamed for being used.** Measured and
      opened in v156 as `lesson-tried-and-failed`.
- [ ] **`lessonsForPlan` (meta.js) now includes stale lessons**, labelled, as
      advisory text. `ineffectiveStrategies` and compose.js still take fresh
      lessons only. If a planner ever turns advisory text into a constraint,
      that split has to move with it.

## v154 "the task's own servers" — leftovers

- [ ] **The result file does not list the run's MCP servers.** A skipped
      `--mcp-config` entry is reported on stderr, which Harbor keeps in
      `forge.txt`, but `forge tbench report` cannot show it.
- [ ] **`--mcp-config` takes one file.** Other agents accept several and
      merge them; nothing has needed that yet.

## v153 "the cache the other protocol reported" — leftovers

- [ ] **The agent's own model call on the OpenAI protocol is not streamed.**
      Both usage sites now read the cache; only the non-streamed one is what a
      headless run exercises end to end — the streamed one is tested directly.

## v152 "a session ended, not abandoned" — leftovers

- [ ] **Interactive chat does not wait for the DELETE.** `closeChatPlugins`
      is synchronous. The request still goes out when chat exits normally
      (the pending request keeps the process alive), but not if chat is
      killed right after.
- [ ] **A DELETE is not retried.** One attempt, bounded at 2s. A server that
      misses it keeps the session until its own timeout, as before v152.

## v151 "what a timed-out task spent" — leftovers

- [ ] **The adapter's cancellation path is tested only where Harbor is
      installed.** The stop command itself runs in CI (core tests); the
      `except CancelledError` around it needs Harbor's base classes.
- [ ] **Only Harbor's docker environment was run.** Daytona, Modal, and the
      rest cancel differently; the stop command is POSIX so it should hold,
      but none was tried.
- [ ] **RUNNING is rewritten on every usage and tool event.** Cheap for a
      small JSON file, but not measured on a very long run.
- [ ] **Single "slower" verdicts flip between identical runs.** Seen inside
      `forge bench` at v150, v151 and v152, and at v152 in two back-to-back
      direct `forge perf --compare` runs on unchanged code: the first read
      15/15 unchanged, the second flagged `startup-status` (+23ms) and
      `repomap-warm` (+5.9ms). So v151's guess — the lane running after the
      heavy lanes — is wrong: direct runs flip too. The calibrated band is
      too narrow for those two cases on this host. Measure their own
      run-to-run spread over many runs before widening anything; a verdict
      that flips on unchanged code cannot be the gate it is used as.
- [ ] **A lost channel keeps its declaration.** After the reconnect attempts
      run out, the session still declares roots/sampling. Legacy MCP cannot
      narrow a declaration mid-session, and starting a new session just to
      declare `{}` would discard server state over a network failure, so forge
      reports the loss (`backChannel: "lost"`, an `mcp_back_channel` event)
      instead. Revisit if a server is found that sends requests into the
      void.
- [ ] **Nothing shows `backChannel` to the user.** The events exist; neither
      `forge mcp` nor the agent console renders them yet.

## v149 "Terminal-Bench" — leftovers

- [ ] **No real score yet.** Everything short of a real model was run (Harbor +
      Docker + real Terminal-Bench 2.0 images, stub model). The first real
      number needs a key: `forge tbench` prints the command. Start with
      `--include-task-name fix-git` before paying for 89 tasks.
- [ ] **The nvm install path is untested here.** `node_install=nvm` is Harbor's
      own helper (as its pi/opencode agents use), but containers in the build
      sandbox sit behind a TLS proxy they do not trust, so it never ran. The
      default `upload` path is tested with no network in the task.
- [ ] **forge's per-tool timeout was not tuned for benchmark tasks.** Some
      Terminal-Bench tasks compile for minutes; forge's bash timeout was
      chosen for interactive use. Measure on real tasks before changing it.
- [ ] **`forge tbench report` is not a bench lane.** It reports a Harbor job;
      it does not feed `forge bench`'s score. That is deliberate for now (an
      external, paid measurement should not move a local gate), but it means
      the number lives in two places.
- [ ] **Cost is always null.** forge has no price table. Harbor's own
      LiteLLM-based agents can price a run; forge would need a maintained
      table to do the same honestly.

## v148 "the benchmark was measuring the hardware" — leftovers

- [ ] **`boot-budget` is still a raw stopwatch.** It compares `import("./agent.js")`
      wall time to a fixed 120ms, which is the exact disease v148 cured in the
      speed lane: on a slower host it fails for the host. It could be restated
      by the spawn probe, but `BOOT_BASELINE_MS` (178ms) was recorded with no
      calibration beside it, so there is nothing honest to restate it BY until
      a calibrated boot baseline is recorded.
- [ ] **The yardstick assignments are judgements.** `repomap-first` and
      `semantic-first` time work inside a fresh child and are restated by
      `spawn` on the argument that module load dominates; `compose-context`
      is mixed cpu and io and uses `cpu`. Each row prints its factor so a wrong
      one is visible, but none was validated case by case.
- [ ] **Sensitivity dropped.** Smallest reliably-caught regression moved from
      ~+10–15% to ~+15–25% (io walks ~+40%). More reps per probe would tighten
      the speed error; measure the cost before paying it.
- [ ] **`forge perf --compare` still exits 1 on an uncalibrated baseline.** The
      bench lane skips it; the explicit tool prints raw rows with a note and
      keeps its exit code. Deliberate for now (it is the tool, not the gate),
      but it is a second answer to one question.

## v140 "the wiring" — leftovers

- [ ] **OSC 133 shell marks are still unwired.** `markPrompt`,
      `markCommandStart` and `markCommandDone` have no caller. They need hooks
      in the REPL prompt lifecycle (chat.js) rather than a single call site,
      and they only benefit terminals with shell integration enabled — so they
      were left rather than half-wired into a path that would emit them at the
      wrong moments.
- [ ] **`fileLink` is wired at ONE site.** The unverified-files line is the
      most useful place, but review findings, stack traces and the tool log
      all print `file:line` and none of them link yet.
- [ ] **`RUNTIME_KEEP` is 2, chosen not measured.** Enough for a rollback and
      an in-flight older process; nothing establishes that two is the right
      number rather than one or five.

## v139 "proof the cache is working" — leftovers

- CLOSED (v140): **`cache_ineffective` now reaches a human.** `agentEventPrinter`
      renders it and `chat.js` routes it EXPLICITLY rather than through the
      `default` branch, which dedups by event type and would have swallowed a
      second provider's warning. The event is
      emitted and the run log carries it, but neither `chat.js` nor
      `agentview.js` renders it, so the diagnostic is currently only visible
      to something reading events.
- [ ] **Health is judged per RUN, not across runs.** A prefix that is
      invalidated between runs (rather than between steps) still reads as
      healthy, because each run starts its own counters.
- [ ] **OpenAI-protocol cache WRITES are unknowable, not zero.** v153 reads the
      cache reads those providers report (`prompt_tokens_details.cached_tokens`,
      DeepSeek's `prompt_cache_hit_tokens`); they report no writes, so
      `cacheHealth` says "unread" rather than guessing why nothing was read,
      and the result file's `cacheWriteTokens` is null. Other compatible
      providers may use yet other field names; only these two were verified.

## v138 "the prefix nobody cached" — leftovers

- [ ] (v139 added `cacheHealth`, which reads `cache_read_input_tokens`; what
      remains here is the *reporting*, not the reading.) **Nothing verifies the
      cache is actually HIT.** The breakpoints are
      placed and their placement is pinned, but `usage.cache_read_input_tokens`
      is never read, so a silent invalidator upstream (a timestamp entering the
      system prompt, a tool list that reorders) would cost full price on every
      step with no signal. The provider response carries the number; forge
      throws it away.
- CLOSED (v146): `cachePositions()` is the count forge did not keep, and it
      counts the way the lookback does — a run of consecutive `tool_use` blocks
      is ONE position, and so is a run of consecutive `tool_result` blocks.
      That detail was missing from this entry and it inverts the risk: forge's
      PARALLEL tool calls were never the problem (forty of them are one
      position), and sequential depth always was. Past the window,
      `applyAnthropicCaching` plants a bridge marker ~15 positions back, within
      the budget the tail and the stable prefix leave it. 61 assertions in
      `tests/test-cache-positions.mjs`.
- [ ] **The bridge is ONE marker, because that is what the budget affords.**
      Tools, the stable system block and the tail take three of four; the
      bridge takes the fourth. A turn that grows by more than 20 positions
      *between* the bridge and the next request still misses — the documented
      fix is a marker every ~15 positions, which needs more slots than exist.
      The real answer is probably to stop marking `tools` separately once a
      conversation is long (the system marker already covers tools, which
      render before it), freeing a slot for a second bridge. That is a
      behaviour change to v89's placement and wants its own measurement.
- [ ] **Only the Anthropic protocol caches.** The OpenAI-protocol path has its
      own caching semantics and gets none of this.

## v137 "five disciplines, measured" — leftovers

- [ ] **Only the prompt discipline has been acted on.** The loop, harness,
      context and graph cases all pass, but they pin invariants that already
      held — they found nothing to fix because nothing was looked for beyond
      what one sitting could measure. The next pass should look for defects in
      those four the way the prompt discipline was looked at: measure first,
      then read the ordering.
- CLOSED (v137.promptbudget): the system prompt has a BUDGET. `promptbudget.js`
      ranks blocks (always / prefer / droppable) and caps the total by task
      class (MICRO 3600 … ARCHITECTURAL 11000). Always-blocks are never dropped
      even if they exceed the cap. Wired through `agentSystemPrompt` /
      `agentSystemPromptParts`.
- CLOSED (v137.promptbudget): the Anthropic cache breakpoint is the stable
      prefix the prompt builder already computed. `agentSystemPromptParts`
      returns `{stable, volatile}`; `applyAnthropicSystem` in `providers.js`
      caches only `systemStable` and sends `systemVolatile` uncached. No
      second TOOLS-marker search in the provider — the split comes FROM the
      prompt builder.

- [ ] **`worldFromCwd`'s cache is per-process and holds ONE entry.** A run that
      alternates between two working directories rebuilds on every call. One
      entry is right for the agent (one cwd per run) and wrong for anything
      that walks several projects; if such a caller appears, this needs to be
      a small keyed map, not a single slot.

## v136 "the terminal, told" — leftovers

- CLOSED (v140): **`osc.js` has real callers.** `fileLink` makes the unverified
      changed-file list clickable; `notify` sends a desktop toast for a run
      long enough that nobody watched it finish (30s, a named constant), and
      it is wrapped so a toast can never affect a run's outcome. OSC 133
      shell marks remain unwired — see below. `osc.js` also provides hyperlinks,
      desktop notifications and OSC 133 shell marks, and nothing calls them
      yet. The obvious next users: `file:line` in review findings and stack
      traces (hyperlink), a toast when a long unattended run finishes
      (notify), and prompt marks around each turn (133).
- [ ] **Terminal support is inferred from the environment, not asked.** A
      terminal can be queried for what it supports (DA1 / XTGETTCAP), which is
      exact where `TERM_PROGRAM` sniffing is a guess — at the cost of a
      round-trip on startup and careful timeout handling.

## v135 "which attempt worked" — leftovers

- [ ] **`successfulRepair` is still attributed by WINDOW, not by scope.**
      v135.0.1 made the boundary exact (the recorded `writeIndex`, which is
      immune to batching), but an unrelated file written inside that window is
      still credited. Narrowing it means reusing `verifyledger`'s scope
      machinery rather than guessing.

## v133 "one droppable file" — leftovers

- CLOSED (v133.1): the programme lane was down to ONE open case and it was the
      only MEASURED one, so a fast CI runner closed it and reddened
      `benchsuite` + `v29` on a commit that passed minutes earlier on a slower
      runner. Three deterministic cases were added (`mcp-elicitation`,
      `mcp-http-back-channel`, `run-teaches-on-success`) and the non-vacuity
      check now compares the budget against `BOOT_BASELINE_MS` rather than the
      host's own measurement. `tests/test-benchsuite.mjs` now guards the CLASS
      of bug: not every open case may be a measurement.
- [ ] **The three new open cases are real work, not placeholders.**
      `mcp-elicitation` needs a way to reach the interactive prompt from inside
      a tool call; `mcp-http-back-channel` needs the SSE GET stream;
      `run-teaches-on-success` needs the loop to know WHICH attempt worked.
- CLOSED (v134): `boot-budget` — but not by restructuring `tools.js`. Measuring
      all 47 of agent.js's direct imports showed fourteen of them cost 65-122ms
      ALONE while agent.js totals 134ms: they overlap almost entirely. The
      intersection is seven modules at 61ms, and `netguard.js` was 52ms of it —
      all four of its `node:http/https/net/dns` imports at module scope. Every
      run paid for the HTTP stack; most never open a socket. `netlazy.js` defers
      them. agent.js: 178ms -> 112ms.
- [ ] **Boot is now the 106-module graph, not builtins.** No remaining builtin
      is worth deferring (`node:child_process` 6ms across 19 modules,
      `node:crypto` 12ms across 17). Going below ~100ms needs the entry points
      themselves to stop converging on one shared core.
- [ ] **`boot-budget` flips with the host** (112ms quiet, 121ms loaded, budget
      120). Safe only because v133.1 made the lane's openness structural. If the
      budget is ever tightened, tighten it against a measured floor, not a wish.
- [ ] **The single file does not carry `skills/`** (11.6MB of 15.4MB). That is
      the right default for a tool that fetches and verifies skills at runtime,
      but there is no `--with-skills` build for someone who wants one artifact
      and a slow link.
- CLOSED (v140): **superseded runtime trees are pruned.** The launcher keeps
      the two newest COMPLETE trees, never touches the one in use, and never
      touches a tree without a `.complete` marker (another process may be
      mid-write). Best-effort and fully swallowed: a housekeeping sweep must
      not stop the CLI it is cleaning up after. Each build id unpacks
      3.7MB and stays. Bounded by how many distinct builds a user actually
      runs, but unbounded in principle.

## v132 "a run that fails teaches" — leftovers

- CLOSED (v135): a run that COMPLETED the hard way now teaches the next one.
      `provenRepairs()` (lessons.js) derives WHICH attempt worked from evidence
      the loop already kept — the same command red at one step and green at a
      later one, and the files written in between. Recorded as
      `successfulRepair` at confidence 0.7, so it reads as "fix that worked"
      and outranks an unproven next step. 45 assertions in
      `tests/test-run-teaches.mjs`.
- [ ] **A repair is attributed to every file written between red and green.**
      (v135.0.1 narrowed the BOUNDARY to the recorded `writeIndex`, which is
      exact under batching; what remains is the SCOPE question below.)
      Honest about what was OBSERVED, but it over-attributes when the run also
      did unrelated work in that window. Narrowing it needs the loop to know
      which writes the failing check actually covers — verifyledger has the
      scope machinery, and this should reuse it rather than guess.
- CLOSED (v141): the two readers now share one definition. `lessons.js` owns
      `LESSON_PROVEN_MIN` (0.5) with `LESSON_TIER` — retired / advisory /
      proven — and `lessonMayConstrain()`, which is the whole criterion:
      proven confidence, a recorded repair, files to check it against.
      `evolve.js` re-exports it as `HARD_AVOID_MIN` so the number has one
      home and every existing caller still works, and `compose.js:indexKnow`
      asks by name instead of re-deriving it. The BEHAVIOUR is unchanged and
      that is the point: an advisory lesson still informs the prompt and still
      cannot constrain. 44 assertions in `tests/test-lesson-tiers.mjs`,
      including a differential against the v140 selection and two mutants that
      prove it is not furniture.
- [ ] **`MCP_IDLE_PING_MS` is a constant, not a measurement.** 30s is a guess
      that errs toward not paying the round-trip. What it should be is a
      function of how often this project's servers actually die.

## v131 "dual era" — leftovers

- CLOSED (v142): the plumbing this asked for is `ask.js` — ONE way to ask a
      human, installed by whichever surface owns the terminal (chat.js,
      agentview.js) and reachable from inside a tool call. `elicitation/create`
      is answered on it, in FORM mode, and the capability is declared only when
      `canAsk()` is true: an unattended run still declares nothing, because a
      server is entitled to ask for what a client declares. 52 assertions in
      `tests/test-mcp-elicitation.mjs`, every one driven through a real stub
      server. URL mode stays undeclared — see below.
- CLOSED (v144): `openurl.js` implements every one of those MUSTs and the
      capability is gated on `canOpenBrowser()`, so a headless run declares
      `form` alone and a desktop one declares both. It never fetches — the
      suite proves that against a real server that would have noticed — and
      the hand-off is a detached spawn with every stdio stream ignored,
      because "the client must not be able to inspect the page or the user's
      inputs" is met by having no pipe rather than by promising not to look.
      `osc.js:safeUrl` was NOT reused: it answers what a terminal may be told
      (file:, mailto: included), which is a wider question than what forge may
      ask an operating system to launch. 67 assertions in
      `tests/test-openurl.mjs`, 69 in `tests/test-mcp-elicitation.mjs`.
- CLOSED (v143): the SSE GET stream is open, and the declaration FOLLOWS it —
      a server whose GET is refused (405) still gets the honest `{}`. The
      blocker was one layer down: `pinnedFetch` buffers the whole response and
      resolves on `end`, which is right for a JSON-RPC POST and useless for a
      channel meant to stay open, so netguard gained a streaming mode with
      every pin intact. `serveServerRequest` is now a function rather than a
      stdio method, so both transports answer the same set. 44 assertions in
      `tests/test-mcp-http-stream.mjs`, against a real HTTP server on the
      loopback.
- [ ] **Sampling is implemented but untested against a live provider.**
      `handleSampling` is gated off by default and the gate is pinned; the
      completion path itself (`providers.chatOnce`) is exercised only by the
      refusal case, because a real one spends tokens.
- [ ] `governor.js:258` advisory STOP — still open from v125. It is a symptom,
      not the cause, and the fix belongs with the autonomy lane (Stage 3).

## v129 "the measuring stick" — CLOSED in v130

- CLOSED (v130): the `bench.js` case `24-reviewer-fixer-planner` failure was
      recorded here as a concurrency flake. It was NOT a flake and not a race.
      `redactSecrets` returned a bare string instead of `{text, found}` when
      security was off, so `codereview.js`'s `secrets.found > 0` was
      `undefined > 0` — false — and the `secret_in_code` finding vanished. The
      fast lane runs `FORGE_SECURITY_MODE=off`, so the case failed
      deterministically there; it looked intermittent only because
      `test-benchsuite` is the one bench-running suite that does not clear that
      variable, and every isolation attempt ran without it. Fixed in
      `secrets.js`, pinned by `tests/test-security-mode.mjs` (14 assertions,
      including both blinded callers).

## v122 "yolowise" — leftovers (completed plan removed, house style)

- CLOSED (v124): the zero-ask delivery key exists. `gitship.commit/push/pr`
      accept `"auto"`, and `yolo.deliverUnattended` promotes the tier the owner
      already enabled (`ask→auto`, `explicit→auto`, `gh→auto`) so a full-control
      run no longer parks in WAITING_FOR_USER mid-delivery. It never promotes
      `"off"` — `gitship.*` still decides WHETHER to ship and still ships off,
      so the OUTWARD act stays an explicit opt-in. Pinned by
      `tests/test-yolo-unlimited.mjs` (30 assertions).
- CLOSED (v124): `forge yolo` now says what the pin restores — "…which means an
      ASK can still PAUSE the run (WAITING_FOR_USER)" — directly under the
      "still enforcing" line, so a screen reading FULL CONTROL names the one way
      it can still stop and wait for a human.
- [ ] `isVerificationGradeBash` is conservative about operands: ANY named path
      outside the project refuses the command, so a read-only worker cannot run
      `pytest -c /etc/pytest.ini` or `tsc -p ../shared/tsconfig.json`. Splitting
      read operands from write operands needs the classifier to distinguish them
      first (it collects `targets` for both).
- CLOSED (v124): autofix no longer gates on a closed table of formatter NAMES.
      The table stays as one way to qualify (format-by-default tools such as
      `black .` name no action), and a command may now also SAY it formats — a
      format-shaped binary name, a `fmt`/`format`/`fix` subcommand, or an
      in-place flag. The guards that carry the safety are kept and tightened:
      shellguard must still rate it "safe", no compound/pipeline, multi-purpose
      tools must name their format subcommand, lint-capable tools must name a
      FIXING action — and programs that run OTHER programs (`bash ./fmt.sh`,
      `npx …`, `make`, `sudo`) are refused outright, because shellguard rates
      several of those "safe" (the danger is the argument, not the verb).
      Two dead branches were fixed on the way: `/\b--fix\b/` never matched
      `--fix` (no word boundary between a space and a `-`), so every
      eslint/ruff/biome/standard command was silently rejected. Pinned by
      `tests/test-autofix-shape.mjs` (64 assertions; 15 fail on the old code).
- CLOSED (v124): `completion.requireEvidence: false` exists (YOLO implies it).
      It waives the covering-check EVIDENCE blocker only, and the verdict then
      reads `COMPLETED_UNVERIFIED` with the waived evidence still attached —
      never a clean COMPLETED. A check that RAN and FAILED, a missing answer and
      a mutation that wrote nothing are facts, not missing evidence, and still
      block. Pinned by `tests/test-yolo-unlimited.mjs`.
- CLOSED (v124): the pairing exists — `forge yolo on --sandbox` sets
      `sandbox.enabled` alongside full control. The two questions stay
      orthogonal: YOLO alone still never arms a jail (the surprise this release
      was removing), and `forge yolo` reports the sandbox state either way.
      Pinned by `tests/test-yolo-unlimited.mjs`.
- [ ] the `block` classification level is computed and reported but honoured by
      nothing (v88 made that permanent). Fine as a label; a future hard-stop
      would need its own key, and it must not be a side effect of `yolo:false`.

## v99 "loopwise" — leftovers (completed plan removed, house style)

- CLOSED (v101, recorded here in v124): layer 2 IS consumed. langadapter
      calls `extractViaTreeSitter` through `treeSitterOr()` at the three points
      where the lexical layer-8 result would otherwise win — tried only AFTER
      the LSP path produces nothing, so a working language server is never
      displaced, and a missing/failing binary returns the prepared lexical
      result with its honest `fallback` reason. Pinned end-to-end by
      `tests/test-v101.mjs` §16 against a stub tree-sitter binary emitting real
      s-expression output (provenance.source === "tree-sitter"; no binary →
      provenance.layer === 8). This entry described the PRE-v101 state and was
      three releases stale — it is corrected rather than deleted because this
      file claims every item in it is genuinely open.
- [ ] docker-image verification goes no deeper than bringUp health +
      artifact existence (image digest/layer checks are not implemented)
- CLOSED (v124): reviewer line numbers are checked, not trusted.
      `addedLineNumbers()` parses the hunk headers of the diff the pass already
      holds, and `verifyFindingLines()` checks every claimed `file:line` against
      the lines that diff actually ADDED. A verified line is kept
      (`lineVerified: true`); an unverifiable one is nulled, preserved as
      `claimedLine`, and marked `lineVerified: false`; with no diff to check
      against it stays `null` rather than claiming either. The FINDING is never
      dropped — a real bug reported at the wrong line is still a real bug, but a
      wrong coordinate reads like fact and sends the reader to unrelated code.
      Pinned by `tests/test-review-lines.mjs` (37 assertions).
- [ ] autofix allowlist is a static table — a project using a formatter
      not in the table falls through to the LLM repair (safe, just slower)
- CLOSED (v147): they are checked now, and checking them found SEVEN OF TEN
      already 404 — `forge skill recommend` was mostly handing out links that
      fail at download time. `anthropics/skills` had moved
      (`document-skills/` → `skills/`) and its new paths verify;
      `obra/superpowers` was fine and gained three more; `LukasNiessen/terrashark`
      was added as the cloud/IaC entry. Every live URL carries the date it
      last returned 200, `verifyRegistry()` re-checks them through
      `pinnedFetch`, and `tests/test-skill-registry.mjs` runs that under
      FORGE_NET_TESTS=1 — opt-in, because a suite that reddens on a GitHub
      blip is a suite people learn to ignore, which is how this list died the
      first time.
- [ ] **Two repos could not be resolved and were NOT deleted.**
      `Egonex-AI/Understand-Anything` and `zai-org/GLM-Skills` 404 on every
      path tried (`skills/`, bare, `Skills/`, on `main` and `master`), but a
      failed guess is not proof a repo is gone — `anthropics/skills` 404'd the
      same way and had merely moved. Their dead URLs sit in `stale` with what
      was tried. Resolving them needs a repo listing, which this environment's
      proxy does not allow (github.com HTML and the unscoped API are both 403;
      only raw.githubusercontent.com answers).
- [ ] **The registry is checked on demand, not on a schedule.** Nothing
      re-runs `verifyRegistry()` between releases, so the next rot is found
      the next time someone looks. A release-time hook is the obvious fix and
      wants to not become a network dependency of the release.
- [ ] the reviewer/verifier/repair passes each pay their own model call —
      no shared session (bounded budgets exist; consolidation is future
      work)

CLOSED in v99: gitship PR creation — `gitship.pr = "gh"` opens real PRs
through the user's OWN gh CLI (passthrough; forge never holds a GitHub
token; consent-gated like push; requires the pushed commit). The v98
blocker ("token sourcing unsolved by policy") was solved by NOT sourcing
a token at all.

## v98 "shipwise" — leftovers (superseded by the v99 list above)

CLOSED by v99: gitship PR creation — `gitship.pr = "gh"` (gh CLI passthrough,
never a forge-held token). The v98 blocker ("token sourcing unsolved by
policy") was solved by NOT sourcing a token at all.


## Open items

The deferred items above are the active open items. They are deliberately
kept here until implemented and covered by tests; this file must not claim
"none" while unchecked items remain.

## Skill forge — leftovers (never shipped, never promoted)

- [ ] Research crawler: a multi-source web research skill was prototyped but
      never met the promotion bar (no recorded behavioral evidence, no fresh
      fingerprint). It stays here until it passes the same gates as a
      learned download.

## Learned skills — policy reminders

- A learned skill never becomes Auto-ACTIVE by itself. Promotion requires
  recorded behavioral evidence plus a fresh fingerprint; being usable is
  not being trusted, and a skill must never be auto-approved just
  because a download succeeded.
- markStaleSkills runs on every world-model fingerprint change; a stale
  skill drops back to candidate until it re-earns evidence.

## Never list (permanent)

- Never ship a skill that fetches arbitrary URLs beyond the netguard
  pinnedFetch policy (Research crawler stays on this list until its fetch
  surface is proven pinned).
- Never make a learned skill Auto-ACTIVE without behavioral evidence.
- Never keep a shipped PLAN file — leftovers live here, history lives in the
  CHANGELOG.
- Never run DAG nodes in a shared tree when they mutate the same files —
  v95 "worktreewise" IS the fix: mutating nodes with pairwise-disjoint
  declared targets execute in per-node git worktrees, the merge back into
  the shared tree is checked-then-applied behind the single-writer barrier,
  and anything ineligible (undeclared targets, overlap, dependencies,
  uncommitted target drift, non-git repo, opt-out) stays serialized exactly
  as before. The rule stands; the fix enforces it.

## Self-audit orphan triage (v124) — evidence, not a backlog dump

`forge selfaudit` reports **66 orphaned capabilities** and **36 dead exports**
across 191 modules (0 islands). The audit's own footer is the rule here:
*"static analysis proves disconnection, never correctness — confirm each lead by
reading the code."* The three highest-signal leads were read, and each says
LEAVE, not wire. Recording the verdicts so they are not re-litigated:

- `router.js:canRunInParallel` (9 test refs, no production caller) — **leave.**
  Production asks the BATCH question (`planExecution`), not the pairwise one:
  `planExecution` applies a risk ceiling and an "earlier write in this batch"
  clash rule that `canRunInParallel` does not, and `canRunInParallel` rejects
  target overlap only when one side is `*`. Routing one through the other would
  change batching behavior, not deduplicate it. It is a sound public primitive
  that the live path has no question for.

- `securefs.js:secureReadFile` — **still leave** (whole-file read would reopen
  the v20 OOM that `readLineRange`'s streaming exists to prevent), but the
  asymmetry it pointed at is **CLOSED (v124)**: `read_file` now opens once via
  `projectOpenRead` → `secureOpenRead` and serves the size, the binary sniff and
  the streamed window from that ONE descriptor. The old path resolved the same
  name four times (existsSync → statSync → openSync for the sniff → openSync
  again inside readLineRange); the gap between the sniff and the stream let a
  swapped file serve binary bytes the sniff had already cleared. Pinned by
  `tests/test-read-toctou.mjs` (23 assertions), which fails on the old code with
  the swapped content reaching the model.

- `v4.js:nextPlanAction` (6 test refs) — **leave.** `meta.js` imports
  `buildV4Plan` purely as a VALIDATION gate (it builds to prove the plan is
  structurally sound, emits `V4_PLAN_VALIDATED`/`REJECTED`, then discards it);
  scheduling is the DAG's job. v4.js states the contract explicitly: "callers
  may adopt each primitive independently."

The pattern generalizes: most of the 66 are legitimately-exported primitives the
live path has no question for. Wiring them to satisfy a counter would duplicate
a responsibility, which `tests/test-v129.mjs` (§36, one implementation per
responsibility) exists to forbid. Triage each lead on its own evidence; a
per-release quota beats a sweep.
