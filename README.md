# forge

## Development security mode (122.1.1)

For local development and tests only, `FORGE_SECURITY_MODE=off` (or `tools.securityMode: "off"`) disables enforcement-heavy security adapters such as content fencing, secret redaction, and URL policy. `NODE_ENV=production` always forces security back on. Secure filesystem write mechanics remain enabled because they are correctness/concurrency primitives, not permission gates.


Standalone terminal AI agent. CLI only. Zero-dependency Node.js. Talks
straight to providers.

**Version 203.0.0 — recovery that happens once (current release).**

- **One offer per interrupted run.** Chat no longer asks about the same
  interrupted run twice: once as a task and again as its journal entry.
- **One resume per interrupted run.** Chat, `forge tasks --resume` and a
  supervised restart each claim a run under its lock before resuming it. A
  second process is told the run is taken.
- **A supervised restart continues.** When the supervisor restarts a crashed
  `forge agent`, it continues the interrupted run where it stopped instead of
  doing the task again from step one.

**Version 202.0.0 — one policy, one completion verdict.**

The first release of the V5 authority work: every decision comes from the
one place that owns it.

- **YOLO means no asking, everywhere.** YOLO switched on by `FORGE_YOLO=1` or
  `tools.yolo` now stops a failing tool from handing the decision back to
  you, and stops chat from asking y/N. Before, these read only the older
  `autoApprove` switch.
- **COMPLETED means proven.** A run that changed files but never checked them
  now ends `COMPLETED_UNVERIFIED`, with the unchecked files listed. Before, it
  reported `COMPLETED`. The work is done, the exit code is still 0, and
  nothing blocks. Evals and `forge tbench report` still count an unproven
  finish on a failing task as a false completion, so relabelling can't make
  a score look better.

**Version 201.0.0 — every model call streams.**

- **Slow answers are no longer cut off at 8 seconds.** A non-streamed request
  had only the 8-second connect timeout until the server sent its first
  headers. Some servers send nothing until the whole answer is ready, so a
  slow answer failed as "provider did not respond". These calls now stream,
  so headers come first and the answer can take as long as it keeps coming:
  - the agent on Anthropic-protocol providers;
  - history compaction;
  - MCP servers' requests for a completion.
- A stream that ends early, or goes silent, is retried, and half a tool call
  never runs. A provider that won't stream still works.

**Version 200.0.0 — MCP reach.**

- **Give a run several MCP config files:** `--mcp-config a.json b.json`, or
  the flag more than once. They are merged in order. When two files name the
  same server, the later file wins and forge says so. Before, only the last
  file was used, and nothing said the others were dropped.
- **The result file lists the run's MCP servers**: what each one offered,
  why a server offered nothing, and the entries skipped before the run
  started. `forge tbench report` shows them on each trial's line.
- **A read-only tool call survives a dropped connection.** If an SSE stream
  ends while a tool is running, a tool its server marks read-only or
  idempotent is asked again once. Any other tool is not repeated. The error
  says it may or may not have run, so the model checks before trying again.

**Version 199.0.0 — streams that carry the tools, and never hang.**

- **Chat can use its tools on OpenAI-protocol providers.** When chat
  streamed, which is the default, the request never included the tool
  definitions. On OpenRouter and most other providers, chat's model had no
  tools at all, even though the start screen said they were on.
- **The agent streams its model calls.** An answer no longer has to arrive
  whole within 180 seconds. A slow model writing a long file keeps going
  while it keeps sending, instead of being cut off and asked for the same
  thing again. Providers that don't stream still work.
- **A stream that goes silent mid-answer is stopped and retried** after two
  minutes, instead of waiting forever.
- **A lighter start.** The 100-server MCP catalog is loaded only when a task
  needs a recommendation from it, which takes about 5ms off the median agent
  start. Gap recommendations now actually find MCP servers; before, the
  search almost never matched.

**Version 198.0.0 — a professional terminal UI.**

- **Real colours on modern terminals.** A bug kept every terminal at 16
  colours, and forge's refined palette was never used. Truecolor and
  256-colour terminals now get it. Everything draws from one palette, with a
  violet brand accent.
- **A cleaner start screen.** Chat opens with a short aligned block: your
  project and git branch, the model, and what is on. It replaces a long line
  of settings.
- **Calmer headers and one card shape.** The status header reads
  `forge · agent · run de12 · ● EXECUTING 33%`. COMPLETED, TASK FAILED and
  FINISHED WITH FAILING CHECKS share one layout: a title, a rule, and aligned
  rows. The rows name the files changed and the checks that ran.
- **`forge --help` is grouped** into sections (get started, chat, agent,
  control, memory, skills, providers, diagnostics, environment, flags), with
  aligned columns.

**Version 197.0.0 — lessons and memory that stay accurate.**

- **A fix forge learned is judged every time it is tried again.** If a run
  tries it, the check still fails, and a later try passes, the lesson is
  blamed for the first try and credited for the second. Before, only the
  last try counted, so a fix that failed first was trusted as much as one
  that worked straight away.
- **`forge memory move <n>`** moves a note into this project's memory. Use
  it for a note about one project that was saved to global memory before
  v187. With `--project`, it moves a project note to global memory. The note
  keeps where it came from, and a note already there is not written twice.

**Version 196.0.0 — /plan that the run follows.**

- **`/plan go` turns your approved plan into the run's checklist.** Each
  step goes on the todo list, the run ticks steps off as it finishes them,
  and chat tells you at the end how many were done and which are left.
- **A plan's questions are asked even without a question mark**, such as
  "I need to know which database you use."

**Version 195.0.0 — fresh model lists.**

- **forge keeps its list of your provider's models up to date.** When chat
  starts and the saved list is more than a week old, it is fetched again
  quietly. The free-model suggestions stop naming models your provider has
  retired.
- **Chat's `/models` now saves the list it shows**, and tool support is
  read from more providers than OpenRouter.

**Version 194.0.0 — prompt engineering: said once, plainly.**

- **When a chat answer is cut off and continued, the pieces join without
  repeated words.** forge tells the model exactly where the answer stopped
  and trims any words it repeats anyway.
- **The agent's instructions are cleaner.** The rules are numbered 1 to 9,
  the dated "think step by step" is gone, the plan summary is written in
  words instead of raw JSON, and nothing is said twice.

**Version 193.0.0 — a pipe that ends in head returns when head has its lines.**

- **A watch-mode or never-ending test piped into `| head` returns at
  once**, as it does in a normal shell. It used to wait out the whole
  command timeout and come back "timed out".

**Version 192.0.0 — the last check failed, and the card says so.**

- **When the run's last test or build check failed, the result card names
  it**, for example "last check: `npm test` failed (exit 1)". This happens
  even when the answer above it says the tests pass. In chat and the
  terminal the headline reads FINISHED WITH FAILING CHECKS.

**Version 191.0.0 — a check's own status, whatever follows it.**

- **`npm test; echo "exit=$?"` and `npm test || true` are recorded as the
  tests' result.** forge used to record them as passing checks, and count
  your changes as verified, because the command as a whole exited 0.

**Version 190.0.0 — a failing piped check stops the chain.**

- **`npm test 2>&1 | tail -5 && git commit …` no longer commits when the
  tests fail.** A pipeline that starts with a check now carries the check's
  own status, so what follows its `&&` runs only if the check passed.

**Version 189.0.0 — a check keeps its exit code through any filter.**

- **Failing tests piped through `grep` (or `sort`, `uniq`, several stages)
  are no longer taken for passing.** forge runs the check, feeds its output
  to the same filters and reports the check's own exit code.

**Version 188.0.0 — a free model that can call tools.**

- **Out of credits, forge suggests a free model that can run the agent.**
  OpenRouter lists which models take tool calls; one that doesn't is never
  suggested to continue a run, goes last in the free lists, and is marked
  "no tools — chat only" in `forge models`, the start-up picker and setup.

**Version 187.0.0 — a note stays with its project.**

- **The agent's memory notes stay with the project they were written in.**
  A note about one repo is no longer read by every other project. The
  user's own preferences and standing rules are still global. A memory read
  shows this project's notes and the global ones, each labelled.

**Version 186.0.0 — model names are not secrets.**

- **With YOLO off, model names and branch names are no longer hidden** as if
  they were keys, so `deepseek-ai/DeepSeek-V4-Flash-0731` stays readable.
  Real keys are still redacted.

**Version 185.0.0 — YOLO shows secrets as they are.**

- **In YOLO mode forge hides nothing.** Keys, tokens and model names appear
  as they are, in tool output, chat, sessions and logs. YOLO is on by
  default, so this is the default. To redact again, turn YOLO off
  (`forge yolo off`) or run `forge config set tools.securityMode on`;
  `NODE_ENV=production` always redacts.

**Version 184.0.0 — a live free model suggested.**

- **Out of credits on OpenRouter, forge suggests a free model OpenRouter
  lists now,** taken from its saved copy of the live model list, instead of
  one fixed name that may no longer exist.

**Version 183.0.0 — /plan asks every plan's questions.**

- **`/plan` asks what the plan needs you to decide,** whether the model
  wrote "Open questions:", "Clarifications needed", "Before I start…" or
  just asked in a sentence. It used to ask only questions under "Questions
  for you:".

**Version 182.0.0 — raised rate limits noticed.**

- **If your provider raises your rate limit, forge speeds up with it.**
  After a streak of successful requests it tries going faster, and stops
  spacing requests once the provider no longer limits them. If the limit
  really didn't change, that costs one refused request, once.

**Version 181.0.0 — the result file carries the checks.**

- **`forge agent --result-json` now records the checks a run ran:** how many
  passed, the last one's command, exit code and output, and the changed
  files no passing check covers. A harness no longer has to trust the
  model's "all tests pass".

**Version 180.0.0 — provider errors shown whole.**

- **When a provider fails, you see its whole message.** An error wrapped by
  a gateway is unwrapped to the provider's own reason, and the failure card
  wraps long reasons instead of cutting them off.
- **A one-shot `forge agent` run out of credits prints the command to run
  next,** for example `forge agent --provider backup "…"`, instead of a chat
  command.

**Version 179.0.0 — faster boot.**

- **forge starts faster.** It keeps Node's compiled code on disk between runs
  (per version, cleaned up on upgrade), and no longer loads the browser, MCP
  client and search engines until a run actually uses them. An agent run's
  boot went from 157ms to about 115ms here.

**Version 178.0.0 — `/plan go` after a restart.**

- **A plan waiting to start survives quitting.** Make a plan with `/plan`,
  close forge, come back with `forge chat --continue`: forge says a plan is
  waiting, and `/plan go` starts it.

**Version 177.0.0 — provider failures named.**

- **When a helper sub-agent runs out of credits, hits a rate limit or has
  its key refused, the main agent is told which.** It then reacts to fit:
  it stops and tells you about credits or the key, and slows down for a
  rate limit, instead of guessing at an "unknown" failure.

**Version 176.0.0 — a dropped answer is finished.**

- **A chat answer cut off by a dropped connection is completed.** forge
  notices the stream ended early, asks for the rest and joins it, so what
  you see and what's saved is the whole answer. If it can't get the rest,
  it says so.
- **A half-received tool call is never run.** forge asks again instead.

**Version 175.0.0 — `retry` means /retry.**

- **Typing `retry` (or `continue`, `try again`) after a run stopped continues
  it** from where it stopped. It used to start a new task called "retry" and
  repeat every step.
- **Out of credits? forge names what you can do now:** a free OpenRouter
  model to switch to, or another provider you've set up. Then `/retry` picks
  up where the run stopped.

**Version 174.0.0 — state for deleted projects is cleaned up.**

- **forge no longer keeps state forever for directories you've deleted.**
  Once a project directory has been gone for 30 days, its folder under
  `~/.forge/projects` is removed. This runs at most once a day and takes
  at most 150ms.
- It removes a folder only when it can prove which directory it belonged
  to. A project on an unplugged drive is kept.
- `forge doctor --prune` shows what would go; `--prune --yes` removes it
  now.

**Version 173.0.0 — /retry after a restart.**

- **A run that stopped can be continued after you quit.** Credits ran out,
  you closed forge, topped up and ran `forge chat --continue`: forge says a
  run stopped there, and `/retry` continues it from the step it reached
  instead of starting over.
- The stopped run is saved the moment it stops, so it survives a closed
  terminal too. It's trimmed so a session file stays small.

**Version 172.0.0 — audit round 2, and tee.**

- **A failing test piped through `| tee log.txt` no longer looks like a
  pass.** forge writes the file itself and keeps the real exit code.
- **An MCP server with a badly named tool** (spaces, or a name that's too
  long) no longer makes the provider reject every request.
- **An MCP server that fails to start says why,** for example "GITHUB_TOKEN
  is missing".

Round 2 of the audit also checked sub-agent failures, MCP hangs and errors,
and how forge's saved state grows over many runs. Those held up.

**Version 171.0.0 — nothing switched off in silence.**

The second half of the audit:
- **Your own tool plugins (`~/.forge/tools`) now load in chat.** A hidden
  error meant they never did.
- **The command palette no longer breaks** when it's taller than the screen.
- **The task controller's questions reach you.**
- **`forge config set` warns about a key forge doesn't read,** and suggests
  the one you meant.

A new guard runs ESLint's bug rules over every module, so this class of
silent failure can't come back.

**Version 170.0.0 — what the provider actually said.**

forge now reads what an OpenAI-compatible gateway actually sends:
- **An error with HTTP 200, or inside a stream,** is shown and handled:
  retried when the provider is busy, "out of credits" when it is. Before,
  it read as an empty answer, or an empty chat reply.
- **A reply cut off by the output-token limit** is continued, and a
  half-written tool call is explained instead of run.
- **A gateway's "502 Bad Gateway" page** is retried.

**Version 169.0.0 — remember what the provider allows.**

When a provider has told forge its rate limit ("at most 10 requests per
minute"), the next run remembers it and paces itself from the first
request, instead of hitting the limit and waiting 20 seconds first. It's
kept per provider and account (never the API key itself), expires after a
day, and the run says why it's slower.

**Version 168.0.0 — one check, however it is typed.**

A failing test run piped through `| tail -20` no longer counts as a pass.
The shell reports the last stage's exit code, so forge recorded a passing
check and treated the changes before it as verified. forge now runs the
check itself and applies the tail/head to its output: the same lines, and
the real exit code. Lessons also recognise a command typed differently
(`node ./setup.js`, `npm run test`, a `cd <project> &&` prefix), so a
remembered fix that stopped working loses standing however it is re-run.

**Version 167.0.0 — wait out the limit.**

A provider's rate limit ("at most N requests per minute") no longer ends a
long run. Before, forge allowed three retries for the whole run and waited
only 2–6 seconds, inside the same minute. Now the budget refills after
every success, a per-minute limit is waited out (20s, 40s, 60s), and once
the provider names its limit, forge paces its requests to fit. The notice
says it is the rate limit and how long forge will wait.

**Version 166.0.0 — pick up where it stopped.**

When an agent run stops partway (out of credits, a provider error, Ctrl+C,
the step budget), `/retry` now continues it from where it stopped instead of
starting over. The model gets its earlier tool results back and is told not
to repeat them, so you don't pay again for the steps it already did.

**Version 165.0.0 — out of credits, said plainly.**

When a provider's balance runs out, forge says so first: "out of credits on
seekai; top up (link), then /retry". The failure card's Next says the same, and `/retry` now re-runs the task
that failed; before, it re-sent your last chat message instead.
With failover on, the run moves to another provider you have tested. The
built-in playbooks the prompt suggests (`focused_verify`, `pr_notes`, …) now
have real steps that `load_skill` returns; before, loading one was an error.

**Version 164.0.0 — plan it with me, then start.**

Tell forge what you need in chat, over as many turns as it takes, then type
`/plan`. It plans from the whole conversation: your goal, requirements,
constraints and corrections, and what forge suggested and you agreed to.
Questions only you can answer are asked first, and your answers re-plan.
Press Enter and the work starts from the plan you approved. Before this, an
approved plan was dropped and the run planned again from scratch. Each plan is also saved to
`.forge/plans/`, so `forge plan apply` can run it later. `/plan go`,
`/plan show` and `/plan drop` manage the latest plan. It works in the
full-screen UI, on a plain terminal and in agent mode.

**Version 163.0.0 — what the balance covers.**

A provider that reserves credit for the whole output ceiling no longer stops
a run. On a gateway like OpenRouter or SeekAI, a modest balance refused every
request: "402 … requires more credits, or fewer max_tokens … can only afford
N", because forge asked for the model's full ceiling. forge now asks for what
the account can pay for, retries, keeps that cap, and tells you so. When
there is too little left to work with, it says to top up. `/details` now
shows the whole error, not the first row.

**Version 162.0.0 — the other way to talk.**

forge now speaks MCP's HTTP+SSE transport (2024-11-05), which is Harbor's
default. It follows the spec's fallback: POST `initialize`, and on
400/404/405 open the SSE stream and use the endpoint it names. So
`--mcp-config` `type: "sse"` servers load, and a Harbor task's SSE sidecar
works. Tested through real Harbor + Docker: the new `forge-smoke-mcp-sse`
task scores 1 with v162 and 0 with v161. A quiet channel is no longer
dropped when one request's timeout passes, on either transport.

**Version 161.0.0 — yours to keep, yours to drop.**

The model can no longer erase your rules. The memory tool's `replace` still
replaces every note it manages, but writes your rules back after them.
Measured: a file talked the model into `memory replace ""`, and a
`forge memory add` rule was gone. A new `forget` action removes one note, or
one of your rules when your own request names it. Nothing you ask is refused,
in YOLO or out of it. A new end-to-end suite drives a real `--yolo` run
through 11 risky-but-yours actions (deleting and writing outside the project,
secrets, `~/.ssh`, uploads, `node -e`, `chmod 777`, `kill`, force-push,
`git reset --hard`). It checks every one ran, and fails if YOLO ever starts
refusing one.

**Version 160.0.0 — your words, and only yours.**

A rule you state inside a task ("from now on: always use pnpm, never npm or
yarn") now reaches every later run, marked "(stated in a task)". The memory
tool records it as a rule only when its text is quoted word for word from
your own request. Text the model read in a file, a web page or a tool result
can't become a standing instruction. Tested: a file asked the model to plant
a `curl … | sh` "rule", and it was kept as an ordinary note, which never
reached the next run. The next open case: the model can still erase your
rules with the memory tool's `replace`.

**Version 159.0.0 — what you told it to remember.**

A rule saved with `forge memory add "…" [--project]` now reaches every run,
in its own "USER RULES" section framed as an instruction. Before, memory
reached a prompt only when the task shared its words: "never npm" was absent
for "add lodash as a dependency", the task it was written for. Rules come
project first, are bounded (what doesn't fit is counted), never go stale,
and aren't repeated. The model's own notes stay relevance-ranked. The next
open case: a rule stated *inside a task* ("from now on always use pnpm"),
which the model records as its own note and later runs don't see.

**Version 158.0.0 — kept when proven.**

A repair is now recorded the moment its check goes green, not when the run
ends. Before, only a run that ended COMPLETED recorded one. A run that proved
a fix and then ran out of budget, was stopped by a harness timeout's SIGTERM,
or was killed outright lost it. Measured with real headless runs: all three
now keep the lesson. The next open case is about what the user tells forge:
a rule saved with `forge memory add` ("never npm") reaches a run only when
the task happens to share its words.

**Version 157.0.0 — a fix that stopped working says so.**

A lesson whose repair is tried again is now judged by its own check. If a run
re-applies it (writes its files or runs its commands) and the check still
fails afterwards, the lesson loses standing. If it passes, the lesson gains.
Measured with real headless runs: a lesson that failed when re-applied stayed
at full confidence and was still offered as "fix that worked". Now it drops
from 0.7 to 0.55, retires after repeated failures, and the prompt shows its
record ("since: worked 0×, failed 1×"). The next open case: a repair a run
proved is thrown away when the run ends before completing.

**Version 156.0.0 — what a command fixed.**

A check fixed by *running* something now teaches the next run. An install, a
setup or codegen step, or a migration used to record nothing, because only
files written between the red and green check were credited. Measured with
real headless runs: `npm test` red, `node setup.js`, green recorded 0 lessons.
Now the lesson reads "ran `node setup.js` — after which `npm test` passed". It
credits only commands that could change state and that succeeded, between
the last failure and the pass. The next open case: a lesson that was tried
and did not work keeps its full confidence.

**Version 155.0.0 — knowledge that outlives the next edit.**

A fix one run proved ("`npm test` went red, `lib.js` changed, green") now
reaches later runs even after `lib.js` is edited again. Measured with real
headless runs, it used to vanish on any edit to that file, including the same
bug coming back. A lesson whose files changed since is now shown after current
knowledge, labelled "check it still applies", and it never constrains a plan.
Every lesson now reaches the model through one renderer, so an unproven next
step no longer reads like a fix. A lesson records the command's real error
instead of forge's own hints, with a project-relative path. The next open case
is a check that a *command* fixed, which still teaches nothing.

**Version 154.0.0 — the task's own servers.**

`forge agent --mcp-config FILE` gives one run its MCP servers from a
`.mcp.json` (`{"mcpServers": {...}}`, with `${VAR}` expansion) without touching
your saved config. The Terminal-Bench adapter now passes each Harbor task's
`mcp_servers` through this way. Through real Harbor, a task that ships its own
MCP server scores 1, and 0 when the servers are dropped. The next open case is
the old HTTP+SSE transport, which is Harbor's default for a server given only
a url.

**Version 153.0.0 — the cache the other protocol reported.**

OpenAI, DeepSeek and OpenRouter runs now report their cache reads
(`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`), which forge
used to drop. Writes are marked unknown rather than zero, because these
providers do not report them, so `cacheHealth` no longer applies Anthropic-only
diagnoses to them. The next open case is letting a harness hand one run its MCP
servers, which Harbor tasks can require.

**Version 152.0.0 — a session ended, not abandoned.**

Closing an HTTP MCP client now ends its session on the server with the DELETE
the spec asks for. It is bounded, best effort, sent once, and awaited by the
agent run, so servers stop holding forge's sessions until their own timeout.
Picking the next gap also turned up a TODO note that was simply wrong:
OpenAI-protocol providers do report cached tokens, and forge ignores them.
That is the new open case.

**Version 151.0.0 — what a timed-out task spent.**

Measured through the real Harbor: a Terminal-Bench task that hit its agent
timeout was reported with no tokens at all, and forge kept working through the
verifier phase, because Harbor cancels from outside the container and forge got
no signal. Now the result file is kept current during the run (written
atomically), SIGTERM/SIGHUP/SIGINT write a final `ABORTED` record, and the
Harbor adapter stops forge inside the container when the timeout fires. The
same timeout now reports `ABORTED`, 10 steps reported of 10 run, with the tokens
spent.

**Version 150.0.0 — a back-channel that survives its server.**

When an MCP server ends forge's stream from the server side, forge now opens it
again: it resumes from the last event id, never sooner than the server's
`retry:`, backs off, and reports the channel lost after about a minute. After a
server restart, the 404 that used to fail every call until forge was restarted
now starts a new session, as the spec requires. The benchmark's new open case
is the next gap: a headless run killed by a harness leaves no result file.

**Version 149.0.0 — Terminal-Bench.**

forge runs on Terminal-Bench through Harbor, its official harness, and is scored
by each task's own tests (`forge tbench` prints the command;
`forge tbench report <job>` reads the result, including false completions:
forge said done, the tests said no). The adapter (`integrations/harbor`) was
run through the real Harbor 0.23.0 in Docker on real Terminal-Bench 2.0 images
with a stub model. No score is claimed until a real model runs it. forge gained
the headless contract a harness needs: `forge agent --headless` never prompts,
requires an explicit `--provider` and `--model` (a stray `GITHUB_TOKEN` must not
choose the model being scored), and writes `--result-json`.

**Version 148.0.0 — the benchmark was measuring the hardware.**

`forge bench` at v147 reported six speed regressions and exited 1; none was
real. Timing v128's own code beside v147's on one host showed them
indistinguishable, while v128's baseline had been recorded on a ~1.3× faster
host with the same cores and RAM — which is all `sameMachine` compared. Each
perf run now also times three workloads that contain no forge code (a bare
node process, a fixed CPU loop, a cached read walk), interleaved with the
cases, and restates the baseline in this host's units before any verdict,
printing the factor. Contention is detected rather than normalized — it is not
a property of the host, and both attempts to normalize it produced false
verdicts — so a loaded run says "inconclusive" instead of guessing. On real
runs: 23 false verdicts across nine raw comparisons became 0, and a real +40%
regression on a slower host is still caught.

**Version 147.0.0 — seven of ten were already dead.**

The curated skill registry shipped at v99 saying "URLs are hints, not
promises — a moved branch fails the download honestly". Checking found seven
of its ten links already 404, so `forge skill recommend` was mostly handing
out downloads that fail. `anthropics/skills` had simply moved
(`document-skills/` → `skills/`) and now lists thirteen verified skills;
`obra/superpowers` gained three more; `LukasNiessen/terrashark` joins as the
cloud/IaC entry (Terraform/OpenTofu across AWS, Azure and GCP — its SKILL.md
is at the repo root, verified, not guessed). Every live URL carries the date
it last returned 200, `verifyRegistry()` re-checks them through `pinnedFetch`,
and the suite runs that under `FORGE_NET_TESTS=1`. Two repos that could not be
resolved were recorded rather than deleted — a failed path guess is not proof
a repo is gone, which is exactly what `anthropics/skills` demonstrated.

**Version 146.0.0 — the cache that silently isn't there.**

Two ways a `cache_control` breakpoint does nothing, neither of which raises an
error. A breakpoint walks back at most 20 positions to find the previous cache
entry, and a long *sequential* tool loop — forge's shape — pushes it out of
range; `cachePositions()` counts the way the lookback does (a run of
consecutive `tool_use` blocks is one position, which is why parallel calls were
never the risk) and plants a bridge marker when a conversation is past the
window. And below a model-dependent floor — 512 tokens on the newest models,
4096 on Opus 4.6 and Haiku 4.5, *not* monotonic — nothing caches at all;
`cacheHealth` now reports that as `too-small` rather than as a cache being
invalidated, because the two look identical in the counters and the advice is
opposite.

**Version 145.0.0 — SeekAI.**

A twenty-third provider: SeekAI, an OpenAI-compatible relay at
`https://seekai.cc/v1` (`SEEKAI_API_KEY`). Verified against the endpoint
rather than transcribed from the request — `/v1/models` and
`/v1/chat/completions` both answer 401 `new_api_error` without a key, a dummy
`Authorization: Bearer` is read as a token, and the site serves New API — so
it is `protocol: "openai"` for a stated reason. `listModels()` returns the
live list once the key is set; the catalog models are fallbacks.

**Version 144.0.0 — somewhere forge will never look.**

An MCP server can send a forge user to a URL, which the specification makes
the *only* way it can ask for a credential — form mode MUST NOT carry
passwords, API keys or payment details. `openurl.js` implements the client
MUSTs that come with it: never pre-fetch, never open without explicit
consent, show the full URL and its domain, warn when the domain is Punycode
(shown as `xn--`, because decoding it for readability would render the spoof),
and hand it to the OS with every stdio stream ignored — no pipe, rather than
a promise not to look. Declared only when there is a browser to hand off to.
Programme lane 14/16 → 15/17.

**Version 143.0.0 — the pinned stream.**

A hosted MCP server can ask forge for things now, and the blocker was not in
`mcp.js`: `pinnedFetch` accumulates the whole response and resolves on `end`,
which is right for a JSON-RPC POST and useless for a channel meant to stay
open. `netguard.js` gained a streaming mode — the same request path with the
accumulator removed, so every pin is unchanged — and the MCP back-channel is
built on it. The declaration follows the channel: a server that answers the
GET with 405 still gets `capabilities: {}`. `serveServerRequest` is now one
function rather than a stdio method, so both transports answer the same set.
Programme lane 13/15 → 14/16.

**Version 142.0.0 — one way to ask.**

"Ask the user something" was implemented five times, and three of those built
a readline on whatever stdin happened to be — on a pipe, a hang rather than a
fallback. `ask.js` states it once: a question with no human to answer it
returns `null` immediately. The interactive surface installs itself with
`setAsker`, which is what finally lets code inside a tool call reach a human —
the plumbing TODO.md had recorded as missing since v131. On it, forge now
answers an MCP server's `elicitation/create` in form mode, declaring the
capability only when someone is actually reachable. Untrusted questions go
through `askUntrusted`, which sanitizes and names the source. The benchmark’s
programme lane goes 12/15 → 13/15.

**Version 141.0.0 — one definition of a proven lesson.**

A lesson's confidence had two floors and only one of them was named after its
subject: `LESSON_RETIRE_BELOW` (0.15, "keep it at all") in `lessons.js`, and
`HARD_AVOID_MIN` (0.5, "trust it enough to constrain") among the `SKILL_*`
constants in `evolve.js` — which `compose.js` imported from there to filter
lessons, then re-derived the rest of the criterion inline. `lessons.js` now
owns `LESSON_PROVEN_MIN`, `LESSON_TIER` (retired / advisory / proven) and
`lessonMayConstrain()`; `evolve.js` re-exports the number under its old name.
Behaviour is unchanged by design — an advisory lesson still informs the prompt
and still cannot become a prohibition — and `tests/test-lesson-tiers.mjs`
(44 assertions) proves it with a differential against the v140 selection.

**Version 140.0.0 — the wiring.**

The 122.1.0 release preserves the additive V4 integration work from 122.0.0 and adds release hardening: adaptive
cognitive depth/budget, explicit ESM/CJS boundaries, isolated Python skill
runtime + JSON-RPC IPC, verification→bus→evidence→replan/hypothesis wiring,
bounded repair retry/backoff/circuit state, durable retry recovery, and the
end-to-end user-task cognitive boot/finalization path, and bounded same-project outcome learning that can refine future strategy selection only after sufficient measured evidence; causal attribution is retained in the cognitive learning record.

**Version 99.0.0 — "loopwise" (the agency release: the stop fix, the
reviewer, the fixer, the planner gate, the reach surfaces).**

**v99 "loopwise"** — the upgrade that makes the agent KEEP GOING, CHECK
ITS OWN WORK, and FIX IT WITH EVIDENCE. No engine rewritten; every change
strengthens an existing loop. **THE STOP FIX (P1)** — the direct one-shot
agent no longer halts dead at its step budget (the "agent stops after
~25 steps" experience): while a run is PRODUCTIVE (fresh successful
writes, passing verification checks, or diverse tool use — and NO
signature loop, no error streak) its step AND tool-call budgets
auto-extend in bounded increments up to the same hard caps (1000 steps /
500 calls), each extension visible as a `step_budget_extended` event with
its evidence; a stalled run stops exactly as before — INCOMPLETE +
checkpoint + resume, budget exhaustion still never completes (§5 law);
segment callers (meta) are untouched, and the meta-side segment table
doubles its bases (MEDIUM 22→40, ARCHITECTURAL 40→88, cap 64→128) so a
healthy run is no longer interrupted every ~25 steps. **THE REVIEWER
(P2)** — codereview.js: after a clean segment that mutated files, ONE
bounded read-only review of the ACTUAL change (working diff vs HEAD, the
gate's LSP diagnostics reused, failing ledger evidence, secret + smell
scan of ADDED lines): deterministic findings stand on their own, a
reviewer agent pass adds strict-JSON findings (parsed honestly — garbage
reports never invent issues), blockers become required actions that block
completion and drive repair, `CODE_REVIEW_*` events persist, review cost
is bounded per task (`review.maxPerTask`, default 4) — and the v94 latent
deadlock is fixed (required actions were add-only until whole-gate
success; recurring prefixes are now re-derived on every completion
attempt). **THE FIXER (P2)** — repairSegment receives a structured DEFECT
REPORT (live LSP diagnostics on the changed files, the most recent
failing verification records, the read-only verifier's own defect text —
requestVerification now returns its report instead of discarding it), and
a deterministic autofix fast path (autofix.js): a lint/format-shaped
failure gets the project's OWN formatter ONCE — allowlisted to direct
formatter invocations, shellguard-classified safe, 90s bound — with the
result recorded as ledger evidence; only if that fails (or the failure is
not mechanical) does the LLM repair run. **THE PLANNER (P2)** —
plancritique.js: the quality gate the planner lacked — coverage against
the objective's own terms, blob/granularity sanity, verification-step
presence for mutating plans, read-only balance; when majors exist, ONE
bounded revision pass that is adopted ONLY if it re-validates (with the
same structural repair the original gets) AND beats the original score;
`PLAN_CRITIQUE` / `PLAN_REVISED` / `PLAN_REVISION_REJECTED` events.
**REACH (P4)** — a curated MCP catalog (mcpcatalog.js: 100 ranked,
GitHub-backed servers from a vendored official-registry snapshot, including
GitHub's maintained server and ECC email/calendar/contacts — searchable with
`forge mcp catalog`, installed one at a time, credentials referenced from the
environment, and the privileged mcp section written only through the sanctioned
config path), a skill
registry (skillregistry.js: the best GitHub skill repos with ready
raw SKILL.md URLs + `forge skill search` local search + `forge skill
recommend` with stemmed matching), and 4 new bundled skills (code-reviewer,
perf-tuning, api-design, data-migration — 106 bundled total). **DELIVERY**
— `gitship.pr = "gh"` opens REAL pull requests through the user's OWN gh
CLI (passthrough: forge never holds a GitHub token; consent-gated like
push; requires the commit pushed; the PR body IS the PR-ready artifact).
FORGE-BENCH grows to 24/24. 164 existing suites stayed green plus the 1
new one (v99: 95 assertions, 9 sections) — 165 total.

**v98 "shipwise"** — closes the six deficits the competitive gap analysis
(Forge vs Claude Code / Devin / Cursor / Codex / OpenHands) called
existential, plus the v97 TODO leftovers, with no engine rewritten:
**tier-3 structured extraction is finally WIRED** (langstruct.js — one
session-cached LSP pass per server enriches the shared index with
`symbolDetails` + provenance `{layer, source}`; honest per-file fallbacks;
JSON gets a genuine layer-1 native parse; INDEX_VERSION bumps once so
lexical-era caches can never masquerade as structured; enriched records
SURVIVE world rebuilds through the extractOne cacheHit law); **verified
git delivery** (gitship.js — kernel policy, never a tool: after the
9-check completion gate says ok the run's verified files are committed
with forge trailers, explicit pathspec only, foreign dirty files named
and never staged, branch "auto" BOOKMARKS forge/<task> without touching
the checkout, push is explicit+consent and force never, PR-ready text
rendered from gate/ledger data — all OFF by default and a checked-in
project config can never enable it); **prompt-injection defense**
(contentfence.js — every tool result rides a constant attribution fence
with an ADVISORY injection-marker scan; the data-not-instructions rule
is in BOTH system prompts; user-only kill switch); **world model at
scale** (0=unlimited finally reachable — the resolver bug; batched index
writes; walk reuse; buildAsync chunked walking with in-flight sharing;
persistedRecords reads the last recorded truth, fixing the CONTRACT_DRIFT
before-capture bug); **artifact evidence** (observed build outputs become
VTYPE.ARTIFACT ledger records, adapter-gated, never invented — and the
declared runtimeValidation flag is finally ENFORCED at critical risk);
**browser visual regression** (`visual_diff` baselines: snapshot text
diff + screenshot hash, evidence-phrased verdicts, full-page capture).
FORGE-BENCH grows to 22/22. 162 existing suites stayed green plus the 2
new ones (gitship 39 + v98 95 assertions) — 164 total.

**v97 "unifiedwise"** — the FORGE ∞ FINAL UNIFIED ENGINEERING INTELLIGENCE
UPGRADE, implemented in the directive's phase order. What was missing was
not more intelligence — it was ONE connected system: **local-first source
resolution** (sourceresolve.js — the §4 ladder: explicit file → folder →
local ZIP → URL → git → workspace; a local archive NEVER loses to a git
remote; ZIPs are inspected, safely extracted and operated on as local
projects; `forge source` + `--source`); **ChatGPT-like session continuity**
(raw per-turn transcripts that compaction can never destroy, deterministic
user-message classification, and AUTOMATIC rehydration — `forge chat` in a
directory with a recent session picks it back up without `--continue`);
**the world-model ceiling removed** (configurable budget, prioritized
indexing, lazy expansion — a locate() miss auto-expands; a huge repo takes
longer, never becomes invisible); **competing hypotheses** (every hard
failure gets a belief distribution, not one guess); **predictions that
cover tests and effort**; **one capability ladder** (native → skill → MCP
→ created tool, honest gaps, `forge caps`); **contract-drift evidence**
(removed routes/tables and orphaned consumers detected after mutations);
**the runtime `up` lifecycle** (launch → wait-ready-by-probe → verdict);
**browser console/network error capture** (`errors` action — a rendering
page with errors is NOT verified); **task replay** (`forge replay` — the
recorded goal→state→action→decision→evidence timeline from the real
ledgers); and FORGE-BENCH at 20/20 with the four missing long-horizon
categories (runtime failure, model switch, session rehydration, ZIP
source). 160 existing fast suites stayed green, plus the 2 new suites (sourceresolve 38 + v97 109 assertions) — 162 total.

**v96 "unifywise"** — the inspection-first upgrade. Five parallel deep
audits of all ~140 modules produced one verdict: v95 already IMPLEMENTED
nearly everything the architecture promised — what it lacked was WIRING.
Intelligence was computed and then ignored; subsystems held state the loop
never read; two copies of one truth drifted apart. v96 reconnects every
disconnected wire, adds the one genuinely missing layer, and pins it all
with the new `tests/test-unifywise.mjs` (72 assertions, 19 sections) and
`tests/test-envfingerprint.mjs` (27 assertions, 7 sections) — 160/160 fast
suites green. Nothing was rewritten; every fix is a repair of an existing
system. The reconnected wires: **engmemory** retrieval's task/conversation
relevance bonuses (+0.4/+0.15) actually fire now (candidates carried no
taskId/conversationId — dead ranking factors); **TTY task-resume goes
through the controller** (the interactive "resume via controller" path
silently dropped resumeTaskId and re-ran the objective as a single-shot
agent — now the persisted DAG/ledger state is reconciled, the honest way);
**the Core lifecycle map speaks meta's real event vocabulary** (four dead
entries — TASK_CREATED/VERIFY_PASSED/REPAIR_COMPLETED/TASK_RESUMED that
meta never emitted — replaced by real mappings, plus meta now emits
TASK_RESUMED after recovery and REPAIR_COMPLETED after a repair, and
COLLECT_EVIDENCE/CONTINUE map from PREDICTION_SETTLED/REALITY_DELTA/
SEGMENT_COMPLETED: every phase is recordable from real traffic);
**empirics and skill-variant outcomes have production writers** (both
ledgers stayed empty in real runs — compose's MODELS line and variant
rates read nothing); **the §24 information-gain experiments ride segment-1
context** (the code comment claimed "the planner prompt carries it" — it
never did; the planner prompt is built before assessment runs); **the
taskmodel origin-tag ledger is fed from the plan** (only seedFromObjective
ever ran, so the adversarial no-assumption-as-requirement check always saw
an empty list — plan nodes speaking in assumptions are now tagged
ASSUMPTION and can never be promoted to REQUIREMENT); **the completion
gate checks REQUIREMENT COVERAGE** (every ingested requirement must be
addressed by a completed node, changed file or verification evidence —
unaddressed requirements block COMPLETED through the existing
required-actions path, no second gate); **the structured §30 handoff
reaches the reassigned worker's context** (it was ledgered onto
successor.handoff and then read by nobody — the failed-approaches list
now travels with the successor); **episode stage recorders receive the Ω
kernel's data** (hypotheses, experiments, verifications, failed
approaches were test-only surface; the durable "never repeat what failed"
story is real now, and episodes persist atomically via securefs like every
other store); **runMany maxParallel is a real per-batch concurrency gate**
(was accepted and ignored); **conflict resolution consults the world
model** (the §31 step was disabled with world:()=>null — now an honest
existence-claim check, behavioral claims still escalate to a
discriminating experiment); **MCP servers connect LAZILY** from a
per-spec inventory cache (~/.forge/cache/mcp-tools.json, TTL 24h, keyed by
name+command so configs never collide): a cold cache behaves exactly like
the old eager path, a warm cache defers the server spawn to the first
tool call, and a vanished tool is an honest error that drops the stale
entry; **LSP autostart servers feed verification diagnostics** on the
default language path (typescript-language-server/pyright/gopls/
rust-analyzer on PATH now produce SYNTAX evidence with zero user config —
the pinned default contract "no user servers → no evidence" is kept for
callers that do not opt in); **one risk ladder**: dag.js accepts "trivial"
(plannerisk/verifyledger already ranked it — a trivial node was silently
coerced to "low", inflating its verification ladder); **external SIGTERM
is KILLED, not TIMEOUT** (only runCommand's own ETIMEDOUT is a timeout);
and the dead code is gone (meta's unused reportConflict import, agent.js's
`void fs`, strategy's duplicated formatStrategy, the chat/agent hardShrink
twins now live once in compaction.js, forge.js's download twins unified).
The NEW layer: **envfingerprint.js (§50)** — the environment fingerprint
and drift engine (process facts free, toolchain presence stat-only,
versions TTL-memoized; per-project env.json through securefs; drift is
ADVISORY: an ENVIRONMENT_DRIFT event with per-signal engineering impact
notes — node major changed → native modules may be ABI-incompatible;
docker gone → runtime verification strategies limited — never a gate
decision; FORGE_ENVFP=0 off-switch). Also new: **core.nextBestAction()**
— the §24 surface as a read-only introspection over the decision
authorities that already exist (pending human decision > terminal
next_action > live phase > idle), exposed in status() for the TUI; NOT a
second decider. And the context engine reports budgetOverflow honestly
when a single section alone exceeds the whole budget.



**v95 "worktreewise"** — the last open KERNEL item of the TODO ledger,
implemented, wired and proven (`tests/test-worktreewise.mjs`, 75 assertions,
9 sections): **mutating DAG nodes with pairwise-disjoint declared targets
now execute in parallel, each inside its own detached git worktree** —
`git worktree add --detach` under `.forge/worktrees/`, a child process
(`worknode.mjs`) whose cwd IS the worktree (agent.js binds everything to
process.cwd(), so one child per node is the only race-free parallelism —
and its writes can only land in its own tree). Parallel segments can never
see each other's partial writes. The **merge back** into the shared tree is
`git apply` CHECKED-then-applied (plain --check, 3-way --check, then apply)
behind a serialized single-writer barrier after the main agent settles — a
conflicting patch never half-applies, the conflicting files are named, the
node honestly FAILS and the worktree is kept for inspection. Ineligible
nodes (undeclared targets, overlap with the current node, dependencies —
a HEAD checkout cannot see merged-but-uncommitted dependency output —
uncommitted drift on the declared targets, non-git repo, no commits,
`FORGE_WORKTREE=0` / `worktree.enabled:false`) stay serialized exactly as
before: worktrees are the FIX for the never-list rule, not a license to
break it. Crashed runs leave orphaned worktrees that the next task start
sweeps (registry + pid evidence, crash-resume pattern). New events:
WORKTREE_MODE/CREATED/MERGED/CONFLICT/FAILED/REMOVED/UNAVAILABLE/ORPHAN_
SWEPT. The version bump also caught a v94 latent bug: searchproviders.js
carried a LOCAL `VERSION = "94.0.0"` that shadowed the single source of
truth — its user-agent advertised a stale version on every search; it now
imports version.js like everyone else. 158/158 fast suites green
(worktreewise: 75 assertions, real git, real child processes, scripted mock
provider).

**Version 94.0.0 — "gapwise" (gap fix / integration patch).

**v94 follow-ons (masterwise + tokenwise)** — no version bump, no rewrite,
same architecture: the **Engineering Intelligence Core** (adaptive search
providers with honest failure, an execution controller that can never mistake
a step budget for completion, the layered engineering memory with provenance,
the predictive risk-aware planner); the **TokenRouter** provider — one
OpenAI-compatible `/v1` key over 300+ upstream models (`TOKENROUTER_API_KEY`);
and the bundled **understand-anything** skills pack (codebase → knowledge
graph: analyze, chat, dashboard, diff, domain, explain, figma, knowledge,
onboard — the graph feeds project memory retrieval on later tasks). **toolwise**
follow-on: three new read-only, deterministic tools — `kg_query` (project
knowledge graph: dependents, blast radius, tests, .ua graph), `plan_whatif`
(simulate plan changes through the predictive risk engine before committing),
`code_context` (semantic hits + structural wiring in one call). 30 tools,
89 bundled skills at that point, 155/155 suites green. **skillwise**
follow-on: the **obra/superpowers** engineering-process pack bundled as
first-party skills (MIT, github.com/obra/superpowers) — brainstorming,
TDD, systematic-debugging, verification-before-completion, plan writing &
execution, code review requesting/receiving, subagent-driven development,
parallel dispatch, git worktrees, skill authoring: 13 of 14 upstream skills
byte-identical (upstream `writing-plans` not re-bundled — forge ships its own
adapted one; the 5 platform-seam skills carry appended forge execution notes
over a byte-identical upstream prefix). 102 bundled skills, 34 first-party
catalog skills, 156/156 suites green at that point. The **knowwise**
follow-on made the project itself a living knowledge source: the first task
in any project auto-writes a deterministic FLOOR knowledge graph
(`.ua/knowledge-graph.json` from the world-model extractors — no LLM, no
network; real understand-anything graphs are never touched; rebuilds only on
fingerprint drift) that feeds memory retrieval and `kg_query` from run one;
every successful file edit now carries a bounded blast-radius prediction
(radius · importers · tests — one advisory line, additive record field +
event, `FORGE_BLAST_RADIUS=0` disables); and shell resolution is
Termux/NetHunter-ready (`FORGE_SHELL` > /bin/sh > $PREFIX/bin/sh > $SHELL),
so every bash call, background process, and typed `!` command works on
Android out of the box. 157/157 suites green at that point.

**v94 "deepwise"** — judgment before action, all deterministic, zero model
calls, zero network: plan **competition + adoption** (the original plan now
competes against its reshaped variants on expected verified progress; when a
variant wins by a real margin at equal-or-better risk and success, the
planner ADOPTS it — the inspect/verify guard node becomes real executed DAG
work, predictions re-stamped, live risk restarted at the adopted estimate;
shapes that drop declared dependencies are advised but never auto-adopted);
a **pre-mutation self-critique** (one deterministic checklist before every
file mutation — secret paths, edit targets that do not exist, same-file edit
thrash, and hub files read straight from the knowwise floor graph; one
advisory line + event, never blocks, `FORGE_CRITIQUE=0` disables); and the
reality→risk loop closed for experiments (repair outcomes move LIVE risk).
158/158 suites green.

**v94 "fastwise"** — same intelligence, less wasted work, all offline
(zero model calls, zero network — Termux-friendly bounded reads, tiny
caches, unref'd timers): a **freshness layer** (fastwise.js) — ONE shared
TTL + file-fingerprint memo utility (the house `${mtimeMs}:${size}`
signature and injectable-clock conventions generalized, drift always
beats the TTL so a stale value can never be served); **likely-next
prefetch** — an idle, deferred, unref'd warm pass (beside the knowwise
KG bootstrap) that persists the world-model snapshot once per freshness
window so later plans/answers pay only a stat-only drift walk, and warms
the semantic chunk cache with ONE bounded offline BM25 pass
(`FORGE_INDEX=0` skips it entirely — never fakes, never writes), guided
by a prediction of the files the task will touch next (plan frontier +
knowwise knowledge-graph hubs, read through engmemory's ONE KG parser);
an **execution lane** resolver (resolveLane in modelstrategy) —
fast/balanced/deep from signals forge already has (task complexity +
device tier from the resource manager), feeding the EXISTING selection
opts (tight latency budget + cost bias for light tasks, no artificial
budget for deep work, cost bias on low-resource devices) — no new
decision path; and a **performance fix with a freshness contract** —
modelstrategy stopped re-reading model-performance.json on every call
(~24 sync reads per selection before; now an mtime+size memo that
re-reads the moment the file changes, never serves stale, forgets on
clear/corruption). `FORGE_FASTWISE=0` turns the warm layer off. This
phase also ships a **dedup audit suite**: tool names, capabilities,
catalog names AND aliases, all 102 bundled skills (frontmatter names,
content hashes, case-insensitive dirs, nested-skill shadowing) are
pinned unique — duplication cannot silently return. 159/159 suites
green.

**v94 "todowise"** — the TODO ledger emptied with proof, one strengthening
patch per repo-declared gap, all offline (zero model calls, zero network): a
**protocol-aware health probe** (runtimesession) — HTTP stays primary, but
when the HTTP exchange fails a REAL TCP connect separates "nothing
listening" (NOT healthy) from "listener confirmed, no HTTP response" (ok at
tcp level with an honest "no HTTP probe available" evidence line — a
TCP/WebSocket service is no longer falsely NOT healthy; the §11 claim gate
and the tool rendering are level-aware); an **evidence-based process-group
kill walk** (runtime) — when `kill(-pgid)` is refused, the members are
enumerated from /proc or a bounded `ps` parse and signaled individually
(`signalGroup`/`groupMembersEvidence`, kill evidence recorded per entry —
the old fallback signaled only the leader and orphaned grandchildren); a
**bwrap kernel re-probe** (sandbox) — the first observed bwrap startup
failure re-probes the overflowuid/overflowgid verdict on the spot
(`reprobeKernelSupport`, counted so tests prove it); a **working-tree drift
phase at restore** (checkpoint) — write tools now seal a post-write hash
(`sealEdited`), and restore classifies every file (clean / forge-owned /
external / unattributed / missing): externally-modified files are KEPT with
status `DRIFT`, never silently clobbered, unattributed changes revert with
a reported drift note, and the legacy `forge undo` path gets the same
protection; a **persistent semantic index** (codesearch) — chunk docs
survive the process under ~/.forge/projects/&lt;hash&gt;,
fingerprint-validated per file (drift always beats the index, deleted files
are dropped, corruption rebuilds, FORGE_INDEX=0 opts out; a fresh process
adopts unchanged files and re-chunks only what drifted); **multi-step
scripted tool probes** (toolcreate) — `probeSteps: [{args, expectOk?,
expectContains?, label?}]` at design time or verify time run a real
sequence in ONE child process (state survives across steps — login → act
finally testable), every step judged on its observed output, a failed step
aborts; and an **LSP auto-start table** (lsp) — first-party specs for
ts/js, python (pyright|pylsp), go, rust used ONLY when the binary is
actually on PATH, user config wins, `lsp.autostart:false` opts out —
documentSymbol extraction becomes the DEFAULT structured path instead of
the lexical exception. 157/157 suites green (todowise: 81 assertions).

**v94 "gapwise"** — the confirmed v93 gaps fixed inside the existing
architecture, zero fake completion: ONE completion contract for every
execution path (budget exhaustion → INCOMPLETE + checkpoint + resume, never
a fabricated COMPLETED); exhausted workers classified and retried; **Runtime
Intelligence** (discovery with per-fact evidence, real health probes,
claim gates, crash reconcile — `runtime` tool #26); **persistent
incremental world model** (survives restart, re-extracts only what changed,
honest truncation); **persisted core bus + engineering-event ledger** with
restart reconstruction; **LSP-first structured extraction** (lexical is a
labeled fallback, not a silent default); **tool creation pipeline** with
behavioral verification in a real child process; **strict learned-skill
promotion** (equivalent to downloads: behavioral evidence + freshness +
staleness); **strategy 3.0** with contextual factors and justifications.
26 tools, 148/148 suites green.

**v93 "sensewise"** — three new senses: a background **process manager**
(dev servers survive the tool call; ports detected from output and the OS
socket table, never guessed; kill hits the whole group; the lifetime fuse
is a resource fuse, never a completion claim), a **persistent Node REPL**
(variables and loaded data survive between calls; timeout = "still
running", never fabricated), and **semantic code search** (BM25 +
embedding hybrid, find code by meaning when grep finds nothing literal).
The last v91 islands (skillforge, embeddings, memgraph) are wired. 25
tools, 140/140 suites green, 99 new assertions.** Nothing rewritten — the
v91 engines remain the source of truth; every module that shipped but was
never consulted is now wired into the living system: a **prediction
ledger** (predict before each segment → settle against observed reality →
calibrate future plans from real prediction errors), **language-adapter
coverage** in every agent prompt (67 languages, honest deep-vs-conservative),
**world-model consultation** at planning (blast radius + covering tests),
**integrator conflicts** reported and resolved instead of discarded, and the
P0 plugin-load TDZ fix (user tool plugins work again). Carries **v91
"corewise"** (∞ CORE), **v90 "gitwise"**, **v89 "fast"** and **v88 "noguard
+ worker clamp"**: no guards, no blocks, workers 2–8. One folder: `forge/`.

## v122 in one line — full control is ONE switch, and it is inspectable

`forge yolo` prints the resolved state of every layer that can refuse, pause or
freeze; `forge yolo on|off` sets it (`tools.yolo`); `--yolo` / `--safe` force it
for one process; `FORGE_YOLO=0|1` for the shell. It is ON by default because
`tools.unrestricted` and `tools.autoApprove` are, and v122 made that umbrella
reach the layers `--yolo` used to stop short of — the ones that kept refusing
work after "all guards off" was supposedly already true:

| layer | what it did after v88 | what YOLO changes |
|---|---|---|
| shellguard | never refused, still labelled | nothing (already off) |
| governor authority | froze/hid write tools on INSPECT/VERIFY/PLAN, halted on ASK | advises only — the directive, the action and the event stay; the veto goes |
| pre-edit critique | secret-looking path → WAITING_FOR_USER, edit thrash → refusal | the note stays, the block goes |
| read-only workers | bash had to match a 12-prefix allowlist | the classifier answers "is this a check, not a change" — writes stay refused |
| capability router | withheld mutating MCP on INSPECT, froze externals on ASK | quality gates stay (stale, measured-broken, budget); permission-shaped ones go |
| system prompt | told the model commands were blocked, so it declined to try | says full control is granted, in both modes truthfully |

Pin one layer without touching the rest:
`forge config set governor.enforce always` (or `never`, or `auto` = YOLO
decides), same for `critique.enforce`; `FORGE_GOVERNOR=1` /
`FORGE_CRITIQUE_ENFORCE=1` for a single run. Inside chat: `/yolo on|off|status`.

**Five rails YOLO never turns off** — they defend you from *other people's
code*, not from yourself, so switching them off would make the agent less free,
not more: the project-config privilege strip (a cloned `forge.config.json` can
never arm the agent), the injection fence on tool results, secret redaction,
atomic/TOCTOU-safe writes, and socket pinning on URL fetches. `forge yolo`
lists them every time, so none of this is a footnote. Two further behaviours
survive because they are **correctness, not permission**: a read-only worker's
write refusal (a verifier must not edit what it verifies) and the v118/v119
completion gate (it refuses a false DONE, never your command) — printed in
their own block, so "all safety off" never means "results stop meaning
anything".

## v88 in one line

Every command gate is gone (nothing is refused, nothing prompts — block-class
included), the project write boundary is gone, `fetch_url` has no SSRF gate,
the sandbox is opt-in (`FORGE_SANDBOX=1`), and workers are clamped: **low tier
= 2, absolute max = 8**. The risk classifier still labels every command for
logs and `/status` — the verdict is just always *run*.

```
forge/                 the npm package (CLI + tests + bundled skills)
  forge.js             CLI entry
  skills/              102 bundled skills
  tests/               160 suites (npm test, zero network)
LICENSE                MIT
PACKAGE_INFO.txt       capability summary
FORGE-AUDIT-REPORT*.md engineering reports (history)
```

## Install

```bash
cd forge && bash install.sh      # or: npm i -g .
forge                            # first run: provider → model → key → test
forge doctor
```

Needs Node ≥ 20.

## Daily

```bash
forge                            # AUTOPICK: chat, tools on, no prompts
forge --pick                     # choose model
forge ask "question"
forge agent "task"               # coding agent, 19 tools
forge agent --auto "task"        # full autonomous lifecycle (DAG + verify + repair)
forge resume <n|id>
forge undo
forge doctor
```

In chat: Linux commands run in the project folder. Sentences go to the model.
`! cmd` always executes. **v88: nothing is blocked and nothing asks y/N.**

```
/status   /profile [p]   /deep   /shell off
/skills   /skill download <https-url>
/skill verify <name|all>   /skill learn <name>
```

`DOWNLOAD ≠ TRUST`. A download is CANDIDATE until verify. Learn is VERIFIED
only. Indexing is not learned. Nothing auto-ACTIVE. Data lives under
`~/.forge` (`FORGE_DATA_DIR` aliases `FORGE_HOME`).

### Reach surfaces (v99)

```bash
forge mcp catalog                # first 20 of 100 curated GitHub-backed servers
forge mcp catalog browser --all  # search; filter with --runtime/--transport/--auth
forge mcp info ecc               # provenance, pinned version, required environment
forge mcp add ecc                # write one preset (user config only)
MCP_ENCRYPTION_KEY=... forge mcp test ecc
forge mcp remove ecc
forge agent --mcp-config .mcp.json "task"   # this run's MCP servers, config untouched
forge skill search "debug"       # local search over 106 bundled skills
forge skill recommend testing    # curated GitHub skill repos + raw URLs
```

MCP servers connect lazily (first tool call), never at startup. Adding one never
enables the other 99. Secrets are never invented or stored by catalog presets:
GitHub and ECC reference `GITHUB_PERSONAL_ACCESS_TOKEN` and
`MCP_ENCRYPTION_KEY` from the process environment. Downloads still use the SSRF-guarded,
verify-then-activate path.

## Self-test (Node only, no network)

```bash
cd forge
npm test                         # all suites (e2e + cleanroom included)
FORGE_FAST=1 npm test            # Node suites only (~39 s, 4-way parallel)
```

`npm test` is the source of truth. Suite counts are not duplicated here.
