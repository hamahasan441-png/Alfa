## 149.0.0 — Terminal-Bench

forge now runs on Terminal-Bench through Harbor, the benchmark's official
harness. It is scored the way every other agent on it is scored: by the task's
own tests, never by forge's opinion of its own work.

```bash
PYTHONPATH=integrations/harbor harbor run --dataset terminal-bench@2.0 \
  --agent forge_harbor.agent:ForgeAgent --model anthropic/claude-opus-5
forge tbench report jobs/<job-name>
```

**No score is claimed here.** A real score needs a model key and real
tokens, and none were spent building this. What was run is everything short
of that. The real Harbor 0.23.0 ran in real Docker, with forge installed by
the adapter, on real Terminal-Bench 2.0 task images. A scripted stub model
stood in for the model.

### What was actually run

| run | result |
|---|---|
| smoke task, stub writes the right answer | reward **1** |
| smoke task, stub writes the wrong answer | forge said `COMPLETED`, reward **0**: the verifier decides |
| smoke task on plain `ubuntu:24.04` (no Node) | reward **1**, with no network inside the task |
| three real Terminal-Bench 2.0 tasks (`fix-git`, `regex-log`, `log-summary-date-ranges`) | **0 exceptions**; forge installed on the real images, ran headless on the real instructions, verifier ran. Reward 0, as it must be: the stub cannot solve them. |

`tests/harbor-e2e.sh` reproduces all of it (opt-in: needs Docker and Harbor).

### Checked against the source, not memory

Harbor's current interface was read from the harbor 0.23.0 wheel itself:
`BaseInstalledAgent`, its bundled Node agents (pi, opencode), provider
resolution, and the task and job layouts. Two findings changed the plan:

- **The registry has `terminal-bench@2.0` (89 tasks).** `@3.0` and `@4.0`
  return "not found", so the comparable public run today is 2.0.
- **All 89 tasks use prebuilt images without Node**, and a runtime downloaded
  *inside* a task makes installing the agent depend on the task's network. So
  the adapter downloads Node v22.23.3 **on the host**, checks it against
  SHA-256 hashes committed in the repo (so the check does not trust the
  server it downloads from), caches it, and uploads it. The task needs no
  network, and the runtime is kept off the task's `PATH`.

### forge's side: a headless contract

`forge agent --headless` is what a harness drives:

- **Never prompts or onboards.** A wizard waiting on `/dev/null` is a hang the
  harness can only time out, and a timeout scores as a failed task.
- **`--provider` and `--model` are required.** Found while building this:
  without them, forge took the first catalog entry whose key happened to be in
  the environment. In a container carrying a `GITHUB_TOKEN`, as every CI job
  does, that was `github-models`, and a benchmark would have filed the score
  under a model nobody asked for.
- A missing key or an unknown provider exits **2** before any request.
- **`--max-steps N`** sets the budget. **`--result-json FILE`** records status,
  steps, tool calls, and tokens (input includes cache reads and writes, which
  is Harbor's convention; cache is also broken out). Cost is `null`, because
  forge has no price table and does not guess.
- **Exit 0 means the run reached an end, COMPLETED or INCOMPLETE.** Whether
  the task was solved is the verifier's call. Non-zero means a real error.
- Also fixed on the way: `headless` was not a boolean flag, so
  `forge agent --headless "fix it"` would have swallowed the task as the
  flag's value.

### Reading the results

`forge tbench report <job>` reads the per-trial files Harbor writes, not the
job aggregate. It reports tasks solved (pass@k over attempts), mean reward
with errors counted as 0 (an error is a failed task, never one dropped from
the denominator), and one number the aggregate cannot give: **false
completions**, trials where forge said `COMPLETED` and the task's tests said
no. That is forge's own eval headline, measured here by a benchmark forge
does not control. An unknown cost prints as unknown, not `$0.00`. The first
cut had that bug, because `Number(null)` is 0.

### Tests

- `tests/test-tbench-headless.mjs` (55 checks): real forge runs under `env -i`
  against the stub. The first manual run inherited the host environment and
  contacted github-models off a stray token, so no test can do that now.
- `tests/test-tbench-report.mjs` (100 checks): job fixtures trimmed from real
  Harbor output, the CLI, and a cross-language check that parses the Python
  provider table and verifies every entry against forge's catalog, and every
  flag the adapter passes against flags forge handles.
- `tests/test_harbor_adapter.py`: the adapter's pure logic (`core.py`: hash
  check, quoting, provider table) runs on any python3, so CI covers it (32
  checks). The `BaseInstalledAgent` subclass runs against Harbor's real base
  classes when Harbor is installed (57 checks in all).
- 25 mutations of the load-bearing lines were all caught. Checking them found
  one gap, which is now closed: the pure adapter logic was first tested only
  when Harbor was installed, which CI does not have. Splitting out `core.py`
  put it under CI.

## 148.0.0 — The benchmark was measuring the hardware

`forge bench` at v147 reported six speed regressions — "these used to pass" —
and exited 1. None of them was real.

### Proving it before fixing it

The baseline was recorded at v128. The obvious reading is that nineteen
versions of new code cost 18–46%. So v128 was checked out beside v147 and both
were timed on one host, **interleaved** so any slow moment hit both equally:

| | v128's own code | v147 | v128's baseline recorded |
|---|---|---|---|
| CLI cold start (p50) | ~110–115ms | ~107–116ms | **86ms** |
| prompt composition (p50) | ~142–148ms | ~135–156ms | **110ms** |

Indistinguishable. The code had not changed cost; the **host** was ~1.3×
slower. And `sameMachine` — which compares `{cores, totalMB, tier}` — said the
two were comparable, because they had the same core count and RAM. Nothing
measured the one thing that differed: how fast the silicon is.

### Three yardsticks with no forge code in them

Each run now also times fixed workloads that contain no forge code at all, so
optimizing forge cannot move them:

- **spawn** — a bare `node -e ""`
- **cpu** — integer hashing, float math and string building, folded into a
  checksum the suite pins (edit the workload without bumping
  `CALIBRATION_VERSION` and a test fails, rather than every old baseline
  silently comparing a new yardstick to an old one)
- **io** — a cached read walk over a corpus built untimed

They are sampled in a full pass at the start, **one rep of each between every
case**, and a full pass at the end, and stored with the baseline. Each case
names the yardstick it is bound by (`calibrate: "spawn" | "cpu" | "io"`), and
when both sides are calibrated its baseline is restated in this host's units
before the verdict. The recorded number and the restated one are both printed,
with the factor, before any verdict that depends on them.

### Four things the first cut got wrong, each found by measuring

1. **The error guard always fired.** Using single-sample spread (p50/min − 1)
   as the error gave ~0.3 per side on an idle host, so every row would have
   read "inconclusive". The error is now how far each side's best-of-N moved
   between the first and second half of its run — the error of the estimate
   actually used — combined in quadrature, since the two sides are
   independent measurements.
2. **The cpu probe measured V8's tiering.** Fused into one function it ran
   12ms for three calls, then a flat 17ms: best-of-N caught the early tier and
   called it the host. Split into three separately compiled helpers, it is
   flat from the first warm call.
3. **The io probe measured the ext4 journal.** Writing and unlinking files per
   rep moved it from 22ms to 48ms within minutes on one idle host. Every
   io-bound case is a *read* over page-cached files, so that is what it times.
4. **Contention cannot be normalized — it can only be detected.** Under four
   CPU hogs, a best-over-best factor read the host as ×1.01 while prompt
   composition ran 51% slower (a short rep often escapes preemption, so the
   minimum ignores sustained load). A median-over-median factor then read ×2
   while the cold starts barely moved, and produced four false "faster" rows.
   Contention is not a property of the host: each workload is hit
   differently. So the **speed** factor is best-over-best (what this silicon
   can do), and **contention** — how much further the probe's median sat
   above its best this run than at baseline — is counted as error. It widens
   the band, and past `CALIBRATION_MAX_ERROR` the row says **inconclusive**:
   not a pass, not a regression, and not scored.

### Measured on real runs

Eleven full perf runs on one host, every comparison computed offline from the
same measurements:

| comparison | raw (pre-v148) false verdicts | calibrated |
|---|---|---|
| idle, interleaved ×3 | 0, 1, 2 | **0, 0, 0** |
| idle, not interleaved ×3 | 1, 2, 2 | 0, 0, 0 (one run: 4 inconclusive) |
| four CPU hogs ×3 | **9, 9, 9** | **0, 0, 0** (15, 15, 8 inconclusive) |
| the same idle runs on a simulated 1.3× host | 7, 8, 8 | **0, 0, 0** |

And the direction that matters more — a normalizer that explained everything
away would score perfectly above and be worthless. A real +40% regression
injected into one case **on that 1.3× host** is still `slower`, with no
collateral. The suite proves it both ways, and a faster host where a case
stood still now reads `slower` too — raw numbers called that unchanged.

### What it costs

Sensitivity. With real idle noise and an injected regression, the smallest
reliably-caught change moved from roughly +10–15% to +15–25% for most cases;
the io-bound walks, which raw numbers could not catch reliably either, need
~+40%. That is the price of a verdict that means something, and it is stated
rather than hidden.

### An uncalibrated baseline is a limitation, not a verdict

The speed lane already skipped a baseline from a different machine profile:
*"A degraded comparison is a reported limitation, never a pass/fail result."*
v148 extends that to the case the profile cannot see. A baseline recorded
before v148 cannot tell a slower host from slower code, so the bench lane
skips with the reason and the fix. `forge perf --compare` still prints the raw
rows, with a note saying exactly that.

On this host, with the v128 baseline: **before**, speed 9/15 and exit 1;
**v148**, speed skipped with the reason; **after `forge perf --save`**, speed
15/15, suite 97.2%.

### Tests

`tests/test-perf-calibration.mjs` — 93 assertions: the v147 bug and its fix,
restating cannot hide a regression (either host direction), per-case
yardsticks, contention detected and never normalized, quadrature error, the
uncalibrated fallback and its note, the report, the probes containing no forge
code (source scan), the cpu checksum, the calibrator live (including cleanup
of its io corpus), and the bench lane. Thirteen mutations of the load-bearing
lines — factor from medians, linear error, contention ignored, no restating,
one yardstick for all, never inconclusive, band ignoring error, no
interleaving, halves collapsed, version unchecked, an io probe that writes,
inconclusive counted as regression, the lane scoring inconclusive — are all
caught.

## 147.0.0 — Seven of ten were already dead

The request was to add the best cloud skills from GitHub, without duplicates.
Checking the list before adding to it found something worth more than the
addition.

### The caveat had been cashed

`skillregistry.js` shipped at v99 carrying ten curated skill URLs and this, in
its own header:

> URLs are hints, not promises — a moved branch fails the download honestly.

Nobody ever looked. **Seven of the ten were 404.** `forge skill recommend` —
the whole point of the module — was mostly handing out links that fail at
download time. Honest failure is only honest if someone checks; otherwise it
is a broken feature with an excuse attached.

| repo | before | after |
|---|---|---|
| `obra/superpowers` | 3 live | **6 live** |
| `anthropics/skills` | 0 live, 3 dead | **13 live** |
| `LukasNiessen/terrashark` | — | **1 live** (new) |
| `Egonex-AI/Understand-Anything` | 0 live, 2 dead | 0 live, 2 recorded |
| `zai-org/GLM-Skills` | 0 live, 2 dead | 0 live, 2 recorded |

### The cloud entry

**`LukasNiessen/terrashark`** — Terraform/OpenTofu across AWS, Azure and GCP:
identity churn, secret exposure, blast radius, CI drift, compliance gates. It
is the only cloud/IaC entry in the list, and two details were verified rather
than assumed: its `SKILL.md` is at the **repository root**, not under
`skills/` like every other entry, and it is a real Agent Skill — YAML
frontmatter with `name` and `description`, a workflow body.

Searching found plenty of repos *about* cloud work and very few that actually
expose a fetchable `SKILL.md`. The list only records what was fetched.

### `anthropics/skills` had moved, which is why nothing was deleted

Its three URLs all 404'd. The repo had reorganized `document-skills/` to
`skills/`; the new paths verify, and the entry went from three examples to
thirteen.

That is exactly why the two repos that could not be resolved were **not**
deleted. They 404 on every path tried — `skills/`, bare, `Skills/`, on `main`
and `master` — but a failed guess is not proof a repo is gone, and
`anthropics/skills` is the proof of that. Their dead URLs moved out of
`examples`, where something might recommend them, into `stale` with the date
and what was tried, so the next check starts from there rather than from
scratch.

### Checked, and re-checkable

Every live URL carries `checked`, the date it last returned 200.
`verifyRegistry()` re-fetches them all through `pinnedFetch` — the only
function in the module that touches the network, imported lazily so printing a
list never loads the network stack.

`tests/test-skill-registry.mjs` is in two halves. The offline half always
runs: shape, uniqueness (no duplicate repo, no duplicate URL, no name
duplicated within a repo), every live URL a raw `SKILL.md` under the repo it
claims, and — the contract that matters — **`recommendRepos` never offers a
stale URL**, checked across seven queries. The network half runs under
`FORGE_NET_TESTS=1` and fetches all twenty. Opt-in deliberately: a suite that
goes red when GitHub has a bad minute is a suite people learn to ignore, and
an ignored suite is how this list died the first time.

### Two pins that encoded the wrong thing

**`examples.length >= 2` per repo.** Reads as a quality bar, is really a
counter — and once seven URLs were known dead, the only way to satisfy it
would have been to keep 404s in the list to make up the numbers. It now asks
that whatever *is* listed is a raw `SKILL.md`, and that the list as a whole
offers at least ten.

**`recommendRepos("testing")[0] === "obra/superpowers"`.** It ranked first
only because it was the *sole* match. `anthropics/skills` now matches too —
`webapp-testing`, a correct hit — both score 1, and the tie broke
alphabetically. Pinning the winner of a tie is pinning the tie-break, so the
assertion now asks that the stemmer finds it at all, and pins the *order* on
`tdd` and `debugging`, which actually discriminate.

## 146.0.0 — The cache that silently isn't there

Two ways a `cache_control` breakpoint does nothing at all. Neither raises an
error. Both cost full price on every step, forever.

### The lookback, and the detail that inverts it

Anthropic's documentation:

> Each breakpoint walks backward **at most 20 positions** to find a prior cache
> entry… a turn that adds more than 20 positions of other content (long
> sequential tool loops, many text/image blocks) still can — the next request's
> breakpoint won't find the previous cache and silently misses.

forge had this recorded since v138 and had not acted on it, because acting on
it needs a position count forge did not keep. It now has one — and writing it
against the specification rather than the note corrected the note:

> a run of consecutive `tool_use` blocks counts as one position, and so does a
> run of consecutive `tool_result` blocks

Which inverts the risk. forge's **parallel** tool calls were never the problem:
forty of them are one position. **Sequential depth** always was, and a long
sequential tool loop is forge's other normal shape. Ten round-trips is 21
positions — already past the window.

So `cachePositions()` counts the way the lookback counts, and when a
conversation is past the window `applyAnthropicCaching` plants a bridge marker
about fifteen positions back. The next request's lookback lands on it whatever
happens in between.

The budget is the constraint: tools, the stable system block and the tail take
three of the four breakpoints Anthropic allows, so the bridge takes the fourth
and there is exactly one. A turn that grows by more than twenty positions
*between* the bridge and the next request still misses — recorded as the
leftover, with the placement change that would buy a second slot.

### The minimum nobody had written down

Grepping the tree found no per-model cache minimum anywhere. The real floors
are **not monotonic across generations**:

| Model | Minimum |
|---|---:|
| Opus 5, Fable 5/5.1, Mythos 5/5.1 | 512 |
| Opus 4.8, Sonnet 5, Sonnet 4.6/4.5 | 1024 |
| Opus 4.7, Haiku 3.5 | 2048 |
| Opus 4.6, Opus 4.5, Haiku 4.5 | 4096 |

A 3K-token prefix caches on Opus 5 and silently will not on Opus 4.6, three
generations *earlier* and eight times the floor. An unrecognized model gets the
worst case, deliberately.

### The first version of this was wrong, and v89 caught it

The first cut **skipped marking** below the minimum. That is wrong, and the
reasoning is worth keeping:

Marking below the minimum is free — the API ignores it. Skipping is not free,
because the only size forge has is bytes/4 (it cannot know the real token count
without a `count_tokens` round trip it would pay for on every step), and that
estimate **understates** tokens for code, JSON and CJK, which is most of what
forge sends. An underestimate would drop a marker from a prompt that *would*
have cached — silently costing real money. The exact failure this release
exists to remove.

So forge marks regardless. The minimum went somewhere more useful instead.

### Telling "never created" from "never read"

Those two look identical in the usage counters — nothing read, nothing written
— and the advice is opposite. One says *find your invalidator*; the other says
*there is nothing to find*. `cacheHealth` takes the model now and reports a
`too-small` state that names the floor, so a run on Opus 4.6 with a short
prompt stops reading as a broken cache.

### Two pins that said more than they meant

`tests/test-disciplines.mjs` and the `harness-anthropic-paths-cache-alike`
bench case both matched the literal string `applyAnthropicCaching(body)`.
Adding an options argument broke them — a pin that was never about the
arguments. Both ask whether the builders *call* it, so both match the call now.
Same correction as v145's catalog pin, from the same habit.

### What the new suite cannot catch, stated rather than implied

Four mutants were run. Three were caught: no bridge, runs not collapsing, and a
dropped rule for a model whose floor is *below* the default. The fourth was
not — removing the rule for a 4096 model leaves the answer unchanged, because
4096 is also the fall-through default. That is acceptable precisely because the
default is the safe answer for those models, and the suite says so rather than
implying a guard it does not have.

### Benchmark

Unchanged: capability 24/24, discipline 16/16, programme 15/17 on every run of
both the change and the base. Speed {9, 9} against a base of {11, 9} in the
same window; boot measured directly at 184/180/185ms against 190/192/183ms,
best-of-9, so the lane difference is host load and not this diff.

## 145.0.0 — SeekAI

A twenty-third provider: **SeekAI**, an OpenAI-compatible relay at
`https://seekai.cc/v1`.

### Verified, not transcribed

The request came with a working Python snippet, which is a claim about an API
rather than a description of one. So the entry was checked against the
endpoint itself:

```
GET  https://seekai.cc/v1/models           → 401 {"error":{"message":
     "Invalid token (request id: …)","type":"new_api_error"}}
POST https://seekai.cc/v1/chat/completions → the same 401
Authorization: Bearer <token>              → a dummy Bearer is read as a
     TOKEN and rejected as invalid, not as a missing header
https://seekai.cc/                         → <title>New API</title>
```

That identifies it as a **New API** gateway: the standard `/v1` surface,
Bearer auth, and a live `/v1/models` list. Which is `protocol: "openai"` in
forge's catalog, exactly as the snippet implied — but now for a stated reason.

Both live paths were then exercised with a throwaway key: `listModels()`
degrades to the catalog defaults with a `HTTP 401` warning rather than
throwing, and `probe()` reports `{ok: false, status: 401}` carrying the
server's own message. A provider that fails honestly is the requirement; this
one does.

`contextWindow` is the conservative relay default (128k), as with `unorouter`
and `tokenrouter`. A relay fronts many upstreams and forge cannot know which
one a given key reaches, so overstating it would have forge pack a prompt the
upstream then refuses. `listModels()` returns the live list once
`SEEKAI_API_KEY` is set, so the catalog models are only fallbacks.

One line in `CATALOG` is the whole wiring: the onboarding wizard, `forge
provider list`, env-var detection, failover and `listModels` all read it.

### A pin that said more than it meant

`tests/test-v94b.mjs` required tokenrouter to be the **last** catalog entry.
Appending anything broke it — which is not a guard, it is a statement that the
catalog is closed. What it meant to protect is that appending never shifts the
wizard's numbered picks (`custom` at 17, `apinex` at 18), so that is what it
checks now, plus that tokenrouter still sits past them.

The first draft of the v145 test had the same mistake in it (`seekai is
last`), and it is corrected the same way rather than copied forward.

The catalog also gained the invariants a hand-edited flat array actually
needs: names unique, env vars unique (two providers sharing one variable
would silently activate off each other), and every keyed entry naming its own.

## 144.0.0 — Somewhere forge will never look

An MCP server can send a forge user to a URL now, which is the only way it can
ever ask for a credential.

### Why url mode is not optional

The specification forbids the obvious alternative. A server **MUST NOT** use
form mode to request passwords, API keys, access tokens or payment details,
and **MUST** use url mode for those. So a client that supports only form mode
is not a client with one convenience missing — it is a client that a server
needing any credential cannot reach at all. That was forge from v131 to v143.

### What it costs, which is a list of MUSTs

`openurl.js` is new, and every rule in it comes from the spec:

| | |
|---|---|
| MUST NOT pre-fetch the url or its metadata | there is no fetch in the module, and the suite proves it against a real server that would have recorded one |
| MUST NOT open without explicit consent | consent is a separate prompt, and a mutant that opens first fails the suite |
| MUST show the full url before consent | the normalized href, and the domain on its own line — a url long enough to push the domain off the right edge is the whole of subdomain spoofing |
| MUST open where neither client nor model can read the page | a detached spawn with every stdio stream `ignore`d: no pipe, rather than a promise not to look |
| SHOULD warn on Punycode | shown as `xn--`, and said out loud |

**On Punycode, and why the ugly form is the honest one.** `new URL()` returns
the ASCII form: `https://pаypal.com` with a Cyrillic а arrives as
`https://xn--pypal-4ve.com`. Decoding that back for readability would be
friendlier and exactly wrong — the decoded form *is* the spoof, and rendering
it is the attack working. forge shows the `xn--` form and explains it.

**On schemes.** https only, plus http on the loopback so a locally developed
server still works. Not `file:`, not `mailto:`, and none of the handler
schemes an OS will execute. `osc.js:safeUrl` allows `file:` and `mailto:` and
was deliberately **not** reused: it answers what a *terminal* may be told,
which is a wider question than what forge may ask an operating system to
launch.

**On Windows.** `rundll32.exe url.dll,FileProtocolHandler`, not `cmd /c
start`. `cmd` re-parses its arguments, so a `&` in a query string becomes a
command separator; `rundll32` takes the url as one argument and parses
nothing.

The capability follows the same doctrine as everything else here:
`elicitation` declares `{ form: {} }` when a human is reachable and adds
`{ url: {} }` when there is also a browser. A headless CI run declares
neither. And consent forge could not honour is a **cancel**, never an
`accept` — telling a server a browser is open on a page nobody is looking at
would leave it waiting for an interaction that cannot happen.

### A module I nearly destroyed

The first draft of this was written to `browser.js`, which already exists and
is 917 lines of the *opposite* thing: driving a headless chromium so forge can
verify a UI — reading the page, screenshotting it, clicking. Restored from
git, and this module is `openurl.js`.

The names were the tell, and so is the reason they cannot share a url checker:
`browser.js:validateTarget` asks "may forge **fetch** this", `inspectUrl` asks
"may forge ask the operating system to **launch** this". The second is
narrower and resolves nothing. Both modules now say so in their headers, and
the suite pins that only one of them launches the user's browser.

### Benchmark

The programme lane goes **14/16 → 15/17**: `mcp-elicitation-url` closes, and
`mcp-back-channel-reconnect` opens.

That second one is not a slot-filler. v143 declared capabilities on the
strength of an open SSE channel; if the stream then ends — the server
restarted, a proxy timed it out — forge notices and does nothing, so a long
session keeps the declaration and loses the channel. The new case opens a real
channel, ends it from the server side, and watches for a second GET that never
comes. It is also what keeps the benchmark's own guard satisfied: at least one
OPEN programme case must be deterministic, so the lane's headroom never rests
on `boot-budget`'s stopwatch.

Capability 24/24 and discipline 16/16 unchanged. Speed {9, 9} against a base
of {10, 9} in the same window, on a host running well below its earlier form
(boot ~185ms against ~148ms this morning, on both the change and the base).

## 143.0.0 — The pinned stream

A hosted MCP server can ask forge for things now. The reason it could not was
not in `mcp.js` at all.

### The blocker was one layer down

v131 shipped the dual-era split and left this in TODO.md, deliberately:

> HTTP legacy still declares `capabilities: {}`… a legacy server may answer a
> declaration with a server-initiated JSON-RPC request, and plain Streamable
> HTTP POSTs give forge no channel to reply on.

The fix everyone names is "open the SSE GET stream". The reason nobody had is
that forge could not open one: `pinnedFetch` accumulates the whole response
and resolves on `end`. That is exactly right for a JSON-RPC POST and useless
for a channel whose entire job is to stay open — it would have buffered until
`maxBytes` or the timeout, whichever came first.

So `netguard.js` gained a streaming mode. `onChunk(buf)` makes the *same*
request path resolve at the headers and forward the body chunk by chunk. Every
pin is unchanged, because it is the same path with the accumulator removed
rather than a second one: same resolution, same per-hop private-address rule,
same post-connect peer assertion, same redirect handling. The suite proves
each of those on the streaming path rather than assuming them, including that
a loopback address is still refused as **blocked** — with security explicitly
re-armed for that one probe, because the suite runner turns it off and an
assertion into a disabled guard proves nothing.

What does change is honest and documented: `maxBytes` no longer bounds the
body, because nothing is accumulated to bound and a channel held open for an
hour exceeds any cap that could be written. Bounding the buffer moves to the
consumer, which is why `onChunk` is mandatory to get there at all.

### The declaration follows the channel

`McpHttpClient.start()` opens the back-channel **before** `initialize`, and
what it finds decides what forge may declare. A server that answers the GET
with 405 — the spec's own "no back-channel here" — still gets `capabilities:
{}`. A 200 that is not an event stream gets the same. Declaring what forge
cannot honour is the mistake v131 avoided, and it stays avoided; what changed
is that there is now a case where forge *can* honour it.

A server-initiated request arriving on the stream is answered with a POST
carrying the same JSON-RPC id.

### One dispatcher, both transports

`_serve` was a method on the stdio client, which is why the HTTP client could
not have answered a server request even with a channel to answer on. It is
`serveServerRequest(msg, ctx)` now — a function returning the JSON-RPC body
instead of writing it — so both transports serve the same set from the same
code.

That drift had already happened: v142 taught MRTR about `elicitation/create`
and left the legacy dispatcher behind. Both know about it now, under the same
`canAsk()` gate, so a legacy server can elicit on either transport and an
unattended run refuses on both.

### Bounding what netguard no longer bounds

An SSE event that is opened and never terminated is the one unbounded shape
left once the transport stops accumulating. A frame over `MAX_SSE_FRAME_BYTES`
(1MB) closes the channel rather than being truncated into something that might
parse as a different message. One frame, not one session: a channel open for
an hour is fine.

`close()` tears the stream down. On HTTP that used to be a no-op with a
comment explaining there was nothing to reap — true until this release added
the one thing here that does leak if nobody closes it.

### Two things this release found in its own work

**The bench case was leaving the next lane dirty.** `srv.close()` is
asynchronous, and the new case returned while its listening socket was still
winding down — into the speed lane, which times process boots. Measured:
speed {9, 9} with the teardown unawaited, {10, 10, 11} with it awaited, against
a base measuring {11, 10} in the same window. Awaited now.

**Closing the last deterministic gap broke the benchmark's own guard.**
`tests/test-benchsuite.mjs` requires at least one OPEN programme case that is
not `MEASURED`, so the lane's headroom never rests on a stopwatch — and with
the back-channel closed, `boot-budget` was the only thing left open. The
answer is not a weaker guard: `mcp-elicitation-url` is now open, and it is a
real gap rather than one invented to fill the slot. Form mode **must not**
carry passwords, API keys or payment details — the spec says so — which makes
URL mode the only route by which a server can obtain one, and forge declares
only `form`. Its client MUSTs (show the full URL, highlight the domain, warn
on Punycode, never pre-fetch, open it where neither forge nor the model can
read the page) are the work that case is asking for.

### Benchmark

The programme lane goes **13/15 → 14/16**: the back-channel case closes, and
one new case opens. `mcp-http-back-channel` is now **exercised rather than
surface** — the old check grepped `mcp.js` for `method: "GET"`, which a GET
that opened nothing would have satisfied, and declaring capabilities was never
the capability either. It now runs a real HTTP server on the loopback, pushes
a `roots/list` down the channel, and asserts forge's answer came back with
real roots.

Capability 24/24 and discipline 16/16 unchanged. Speed {10, 10, 11} against a
base of {11, 10} on the same host in the same window — the flap TODO.md
records, on a host noticeably more loaded than when v142 was measured (boot
~175ms against ~148ms earlier the same day, on both the change and the base).

## 142.0.0 — One way to ask

An MCP server can ask a forge user for a value now. The reason it could not
before was never the protocol — MRTR shipped in v131, `roots/list` and
`sampling/createMessage` were answered — it was that forge had no single place
that knew how to ask a human anything.

### Five spellings of one question

"Ask the user something" was implemented five times:

| | |
|---|---|
| `terminal.js:ask` | the real one — inline in the fullscreen editor, Ctrl-C → null, single-keypress, masking |
| `agentview.js:ask` | `term.ask` on a TTY, else its own `readline/promises` |
| `chat.js:confirmPrompt` | `term.ask` when a UI exists, else its own callback readline — with no check that a human is there |
| `chat.js:2301` | its own readline, guarded by `process.stdin.isTTY` |
| `forge.js:291` | its own `readline/promises`, errors swallowed |

They disagreed about the one case that matters. Three of them called
`createInterface` on whatever stdin happened to be. On a pipe that is not a
fallback, it is a **hang**: the interface waits for a line from a stream
nobody will ever write to, and forge stops with no output and no error. The
other two each guessed differently at what to do instead.

`ask.js` states the contract once:

> **A question with no human to answer it returns `null` immediately.**

`null` is "nobody was asked". It is never confusable with `""` (someone
pressed Enter) or with "no". Every caller now decides its own unattended
policy from the same fact — `confirmUser`'s `dflt` is both "what Enter means"
and "what no-human means", in one place instead of five.

Two things stay out of it, and the suite says so rather than pretending:
`onboard.js` holds one interface open across a whole wizard and deliberately
accepts piped input, and `chat.js` runs the REPL's input loop. Neither is
"ask one question".

### The plumbing TODO.md asked for

The v131 leftover named the gap exactly:

> Wiring it needs a way to reach the interactive surface from inside a tool
> call (chat.js owns the prompt; `agent.js` does not).

An MCP call happens inside a tool, inside the agent. `chat.js` and
`agentview.js` now install the terminal with `setAsker`, and anything deep in
a tool call reaches the human through `askUser`. That indirection is the
feature.

### Elicitation, form mode, and only when someone is there

`clientCapabilities` declares `elicitation: { form: {} }` **when `canAsk()`
is true** — a real question about this process, not a config flag. An
unattended run declares nothing, because the spec entitles a server to ask
for whatever the client declares, and a client that declares a prompt it
cannot show has not gained a feature, it has promised one. A server that asks
for it anyway still gets v131's loud "forge never declared that", because
answering an undeclared capability politely teaches servers to keep asking.

What forge implements: consent for the whole form first (so the user decides
once, knowing who is asking and what for), then one question per property,
typed back per the schema — an `integer` returns `30`, not `"30"`. All three
response actions are real and distinct: `accept` with content, `decline` for
an explicit no, `cancel` for a dismissal or a Ctrl-C. A required property
forge cannot render makes the whole form a `decline`, because collecting the
rest and calling it `accept` would hand the server a form it never asked for.

**URL mode stays undeclared.** It carries its own list of client MUSTs — show
the full URL, highlight the domain, warn on Punycode, never pre-fetch, open it
where neither forge nor the model can read the page — and forge implements
none of them. Declaring it would be exactly the mistake v131 avoided with
`capabilities: {}`.

### A server's text is not forge's text

An elicitation message is written by something that is neither forge nor the
user. `askUntrusted` is the only door for those: it sanitizes before a byte
reaches the terminal, and it names the source, which is the spec's own MUST.
Without it a "question" carrying an escape sequence and a newline can paint a
second line that looks like forge's own and ask for an API key.

`askUser` deliberately does **not** sanitize — its strings are forge's, and a
confirmation stripped of its colour has lost the warning. Two functions rather
than one flag, because a flag can be forgotten at one call site.

The transformation itself is `render.js:terminalSafe`, which is what
`osc.js:oscSafe` already was — now one implementation with an OSC-specific
budget on top, pinned by a probe comparing them byte for byte.

### And the import that would have cost the boot path

`mcp.js` imports `ask.js`, so `ask.js` is on the agent's boot path. A static
edge from it to `render.js` put that module's Unicode width tables there too:
**measured at ~3ms** on a graph already over its budget (149ms vs 146ms,
best-of-9, three times each). Made lazy and memoized, the difference is gone.
`tests/test-ask.mjs` pins the *import*, not the behaviour — a static version
would pass every behavioural assertion.

### Benchmark

The programme lane goes **12/15 → 13/15**, and nothing else moves. Measured
against the unmodified base, three runs each, alternating on the same host:
capability 24/24 and discipline 16/16 on all six; programme 13/15 on every run
of the change and 12/15 on every run of the base; speed {13, 12, 14} for the
change and {13, 14, 12} for the base — the same distribution, which is the
host-load flap TODO.md already records for this lane, not an effect of this
release. Totals therefore range 91.4%–97.1%; the honest single number is
**+1 programme case**, and the best observed run is 68/70.

`mcp-elicitation` is now **exercised rather than surface**: the old case
asserted that `clientCapabilities` named `elicitation`, which a client that
could not answer one would have passed. It now drives a stub server through
InputRequiredResult → `fulfilInputRequests` → `handleElicitation` → the
installed asker → the retry carrying the typed values, and checks that the
capability is *withheld* when nobody is there.

## 141.0.0 — One definition of a proven lesson

A number with two homes is a bug waiting for someone to change one of them.

forge had two confidence floors for lessons and a name for only one:

    lessons.js   LESSON_RETIRE_BELOW = 0.15    "keep it at all"
    evolve.js    HARD_AVOID_MIN      = 0.5     "trust it enough to constrain"

The second sat among the `SKILL_*` thresholds, in a module about skills, and
`compose.js:indexKnow` imported it *from there* to filter LESSONS — then
re-derived the rest of the criterion inline: a recorded repair, and files to
check the claim against. So "what makes a lesson strong enough to act on?"
was answered in three places, and no single reader held the answer.

v129 already recorded this exact lesson one file over, about the two SKILL
thresholds: *when two thresholds exist, the subject belongs in the name.* It
was recorded and not applied to the lesson thresholds themselves.

### The concept, named once

`lessons.js` now owns it:

  - **`LESSON_PROVEN_MIN = 0.5`** — the line between INFORM and CONSTRAIN.
  - **`LESSON_TIER`** — `retired` (forgotten) / `advisory` (may inform) /
    `proven` (may constrain), with `lessonTier(l)` reading the same
    `confidence ?? 0.6` default `lessonPool` has always used. A tier that
    disagreed with the filter feeding it would be a second bug of the same
    shape.
  - **`lessonMayConstrain(l)`** — the whole criterion, not a third of it:
    proven confidence, a recorded repair, and files to check it against. A
    lesson that names no files cannot be checked against the tree it claims
    to be about; one with no repair is an observation, not a fix.

`evolve.js` keeps the name `HARD_AVOID_MIN` — every caller still works — but
it is now `export const HARD_AVOID_MIN = LESSON_PROVEN_MIN`. One number, one
home. `compose.js:indexKnow` asks by name instead of re-deriving.

### The behaviour is identical, and that is the claim

A lesson at confidence 0.3 still reaches the prompt through `lessonsForPrompt`
and still cannot become a hard avoid. That was always right; nothing said so.

`tests/test-lesson-tiers.mjs` (44 assertions) proves the refactor changed
nothing, by running the real `compose()` path over a matrix and comparing
against the v140 selection re-implemented from the code this release replaced.
The matrix is the point — a refactor test fed only lessons that pass would
still pass if `lessonMayConstrain` were `() => true`. Every rejecting clause
gets a lesson that trips only it, and two mutants were run to confirm the
suite catches both directions: too loose (advisory lessons constrain) and too
strict (two files required).

It also pins what stays local: `compose.js` still drops a lesson whose only
file is an absolute path, *after* `lessonMayConstrain` accepts it. That check
is load-bearing, not leftover — what compose does with a path is compose's
business, not the lesson's.

Benchmark unchanged. Measured against the unmodified base on the same host in
the same minute, both scored **94.3%** (66/70) with capability 24/24 and
discipline 16/16. Both lost exactly one speed case, and not the same one:
the base dropped `perf-startup-status`, the change dropped
`perf-grep-symbol`. A later run of the change took the speed lane to 15/15
(**95.7%**, 67/70). That lane flaps with host load and this release does not
touch it; the honest reading is that the score did not move.

## 140.0.0 — The Wiring

A module that ships, passes its own unit tests and is never imported is worse
than a missing feature: the tests are green, the CHANGELOG says it shipped,
and the behaviour does not exist. Three of those were open in TODO.md. This
release closes them by adding the callers.

### `osc.js` had six emitters and one caller

v136 shipped hyperlinks, a desktop toast and OSC 133 shell marks. The only
importer in the tree was `terminal.js`, taking `setTitle` and `restoreTitle`.
`hyperlink`, `fileLink`, `notify`, `markPrompt`, `markCommandStart` and
`markCommandDone` had zero callers — the module was 75% dead, and its own
78-assertion suite passed the whole time, because it tested the bytes rather
than the reachability.

Two now have real callers:

  - **`fileLink`** — the "unverified: N changed file(s)" line lists the files
    a user most wants to OPEN, so it is the obvious first hyperlink. The
    helper returns the plain label whenever the terminal cannot do OSC 8.
  - **`notify`** — a desktop toast for the run nobody watched finish, gated
    at 30s because a toast for a run the user just watched complete is noise
    printed on top of output already on their screen. Wrapped, and its
    failure swallowed: a toast must never affect a run's outcome.

OSC 133 stays unwired, deliberately — see the leftovers.

### `cache_ineffective` was emitted and rendered by nothing

v139 added the one observable symptom of a silently invalidated prompt cache
— full price on every step, forever, no error — and then emitted it into an
event stream nothing read. `agentEventPrinter` renders it now.

`chat.js` routes it EXPLICITLY rather than through the `default` branch,
which dedups by event type: a second provider whose cache is also dead would
have been silenced by the first one's warning.

### Nothing pruned superseded runtime trees

The single-file build ids are content hashes, so every rebuild unpacks a NEW
~4MB tree beside the old ones and nothing ever removed them. A CI box that
builds per commit fills its disk with copies of a program it already has.

The launcher now keeps the two newest COMPLETE trees and deletes the rest.
Three deliberate exclusions: the tree in use is never a candidate; a tree
with no `.complete` marker is never a candidate (another process may be
mid-write into it); and every failure is swallowed, because a housekeeping
sweep must not stop the CLI it is cleaning up after.

### The import that made `forge --help` slower

The first cut of this wiring imported `osc.js` at forge.js module scope. The
speed lane flagged `perf-startup-help` and `perf-startup-status`, and
measuring rather than dismissing it found a real 3ms: every command that will
never emit an OSC byte was paying to load the module that emits them. That is
the exact pattern `netlazy.js` exists for.

It is loaded lazily and memoized now, and the elapsed-time gate is checked
BEFORE the import so a short run never loads it at all. `test-wiring.mjs`
asserts the laziness, not just the reachability — a static import here would
be a startup regression that the old assertions would have passed.

(The speed lane still flaps on this container independently, 13/15 then 15/15
on consecutive runs; that is the host variance TODO.md already records for
`boot-budget`, not this change.)

### Verification

  - `npm test` — all 267 suites pass
  - `tests/test-wiring.mjs` — 23 assertions
  - `tests/e2e-forge.sh` — 256 passed, 0 failed
  - `tests/test-wiring.mjs` — 20 assertions, and the prune half is END TO END:
    it builds the single file, seeds four superseded trees plus one
    interrupted one, runs the binary, and reads back which directories
    survived. Source-text checks alone would pass on wiring that never runs.
  - osc 78, single-file 33 — both unchanged

## 139.0.0 — Proof The Cache Is Working

v138 placed prompt-cache breakpoints. Nothing checked they were ever HIT — and
a prompt cache that stops working is the quietest failure in the system: same
answers, no error, no warning, full price forever. The only signal the
provider gives is a number forge was throwing away.

### v138 made forge's own token accounting wrong

Anthropic splits input tokens across three fields once caching is on:

    input_tokens                 the uncached tail ONLY
    cache_read_input_tokens      served from cache (~0.1x price)
    cache_creation_input_tokens  written to cache (~1.25x price)

forge mapped `prompt_tokens = input_tokens` and dropped the other two. That
was harmless while nothing cached. v138 turned caching on for the agent's own
path and thereby made every prompt-token number forge reports a FRACTION of
the real input — and worse, a fraction that shrinks as the cache gets better.
A well-cached step reported 120 tokens for a 7,570-token prompt: a 63x
under-report, on the number `/status`, the session line and `meta.js` all
read.

`normalizeAnthropicUsage` keeps `prompt_tokens` meaning what every consumer
already believes it means — the whole input — and carries the breakdown
alongside it. Fixing the meaning at the source beat auditing agent.js,
chat.js and meta.js for a field whose definition had moved under them. A
provider that says nothing about caching gets no cache fields invented for
it, because "no cache" and "0% hit rate" are different claims.

### Naming the silent invalidator

`cacheHealth()` reads the accumulated counters and distinguishes the three
states that look identical from the outside:

    unknown     the provider never mentioned caching — not a fault
    cold        too few steps to judge; step 1 can only ever write
    never-read  written repeatedly, never read back — the prefix is being
                invalidated between steps, at 1.25x, for nothing
    ok          reads are happening, with the share of input served

The `minSteps` boundary is 3 on purpose: step 1 writes, step 2 is the first
that could read, and a run that ends at two steps must not be accused of a
fault it never had the chance to exhibit. `agent.js` emits
`cache_ineffective` ONCE per run when the verdict is `never-read`, so the
condition the caching documentation describes as the thing to watch for is
the one thing forge now actually watches.

### Verification

  - `npm test` — all 265 suites pass
  - `tests/e2e-forge.sh` — 256 passed, 0 failed
  - `test-clean-room-package` — 30 passed
  - `forge bench` — 67/70, **95.7%**; discipline 16/16
  - `tests/test-disciplines.mjs` — 134 assertions, including that each verdict
    is reachable and that "never-read" and "ok" are not the same constant

Both halves of CI's `full-suite` were run locally before pushing this time.
v138 shipped a bug `npm test` could not see, because `full-suite` runs a
clean-room package install and the e2e CLI and the unit suites run neither.

## 138.0.0 — The Prefix Nobody Cached

v137 fixed extended thinking in `streamAnthropic` and then found the same
mistake one line deeper: the fix had been applied to one of TWO Anthropic
request builders. Looking at the other builder for anything else it had been
left out of turned up something larger.

### The agent loop had no prompt caching at all

`providers.js` has two Anthropic request builders. `streamAnthropic` carries
this comment, added in v89:

> The static prefix (tool schemas + system prompt ≈ 16 KB / 4 k tokens on a
> stock agent) is re-sent on EVERY step of a multi-step run — with
> cache_control on the last tool and the system block, the provider serves
> that prefix from cache.

It is accurate about `streamAnthropic`. The agent loop does not call
`streamAnthropic`. `agent.js:1339` calls `chatOnce`, which reaches
`chatOnceInner`, whose Anthropic branch built its body with **no
`cache_control` anywhere** — not on the tools, not on the system block. So
the sentence describing forge's most-repeated cost was true of a function
forge's agent never executes.

Measured on this tree:

    tool schemas   4926 tok
    system prompt  2227 tok
    TOTAL          7153 tok   re-sent at full price on EVERY step

7153 tokens clears even the strictest cacheable-prefix minimum (4096 on
Opus 4.6 / Haiku 4.5; 512 on Opus 5), so this was always cacheable and simply
was not cached.

### And neither builder cached the conversation

Anthropic renders `tools` -> `system` -> `messages`, and caching is a prefix
match. Both builders stopped at `system`, so the growing message history — the
part that gets LARGER with every step — was re-sent at full price every time.
The documented shape for an agent loop is a breakpoint on the static prefix
plus one on the conversation tail; forge had the first only on a path it does
not use, and the second nowhere.

### One implementation, because this is exactly how it broke

`applyAnthropicCaching(body)` places all three breakpoints and both builders
call it. The tools breakpoint is deliberately kept alongside the system one
even though the system breakpoint already covers tools+system: across RUNS the
task changes the system prompt and does not change the tool list, so the tools
breakpoint is the only one that survives a new task. Three breakpoints, and
Anthropic's limit is four.

The tail breakpoint is placed only once an assistant turn exists — once the
exchange demonstrably IS a conversation. A cache write costs 1.25x and only
repays when something reads it, so marking the tail of a genuine one-shot call
(`mcp.js`, the chat one-offs) would be a pure surcharge on bytes no later
request will ever read.

### What it is worth

An arithmetic model, not a live measurement — stated as such. A 20-step run
whose history grows to 40k tokens, cache reads at ~0.1x:

    billed input, before   563,060 tok-equivalents
    billed input, after     98,744 tok-equivalents
    reduction                 82.5%

The measured half is the 7153-token prefix and the fact that the agent path
carried no `cache_control`; the run shape above is a model with its
assumptions written down.

### Verification

  - `npm test` — all 265 suites pass
  - `forge bench` — 66/69, **95.7%**; discipline 15/15
  - `harness-anthropic-paths-cache-alike` is structural as well as
    behavioural: it fails if any builder hand-rolls a `cache_control` literal
    instead of calling the one helper, which is the way this broke the first
    time.

## 137.0.0 — Five Disciplines, Measured

"Make it better at prompt, loop, harness, context and graph engineering" has
no answer while none of the five is measured. `forge bench` scored four lanes
— capability, programme, speed, autonomy — and every one of them is a
statement about MATURITY: what forge can do, what it cannot do yet, how fast,
did it finish. None of them is a statement about a SUBJECT.

So v137 adds a second axis rather than four more lanes.

### Why discipline is a tag and not a lane

Modelling the five as lanes would have crossed the axes and made `GUARD_LANES`
incoherent: is a failing prompt case a regression, or a roadmap item? It
depends entirely on which case. Some prompt work is an invariant that holds
today; some is room above the benchmark.

`discipline` is therefore orthogonal to `lane`:

  - the **discipline lane** holds invariants that hold NOW, exercised against
    the real modules. It GUARDS the exit code — a red one means forge
    regressed, which is the whole definition of a guard lane.
  - **programme cases** carry a discipline tag too (13 of them do), so the
    roadmap is sliceable by subject without the programme lane ever being
    asked to be green.
  - `forge bench --discipline prompt` slices across both, which is the
    question an engineer actually asks.

Twelve new cases, ten of them EXERCISED — a grep is not a benchmark.

### What the prompt discipline found on its first run

**The prompt named its skills twice.** `agentSystemPrompt` emitted
`formatSkillPicks` ("SKILLS FOR THIS TASK (3)", with descriptions) and then,
a few blocks later, `formatSteer` emitted "SKILLS (call load_skill before
using): …" from `composed.skills` — a SECOND and independent selection. 539 +
413 characters saying the same thing, and not necessarily the same three
names: the model could be handed two disagreeing skill lists in one prompt
with no way to tell which was authoritative.

The comment above that block had said "the decision was already made once, by
selectForTurn" since it was written. It was true of that block and false of
the prompt. The pick list wins; the steer block drops its names when they have
already been given (`namesAlreadyGiven`), and keeps its TRY FIRST known-repair
block, which is a different statement and is not duplicated anywhere.

### The system prompt built in 172ms, and 136ms of it was one mistake made twice

Measured on this tree (672 indexed files, best-of-5, warm), the per-run system
prompt build broke down as:

    relevantMemory            71ms
    relevantLearnings         65ms
    buildRepoMap              23ms
    composeOnce (cached)       0ms

`relevantMemory` on a repository with an EMPTY memory file cost 71ms. The
reason is ordering:

    const pool = livePool(memoryPool(cwd), cwd, {...})
    if (!pool.length) return ""

`livePool` builds a full repository world — `worldFromCwd`, measured at 64ms
for this tree — to apply a staleness filter, and only then does the caller
notice there was nothing to filter. `liveLearnings` had the same shape, and
paid it again. A fresh checkout therefore built a 672-file graph twice per run
to answer a question about zero entries.

Two fixes, each of which earns its place independently:

  - **`livePool` and `liveLearnings` read what they filter before building the
    filter.** The staleness filter is a function OF the pool; with no pool
    there is no question to answer.
  - **`memgraph` memoizes the world per index revision.** Three call sites
    rebuilt the same world every run (compose.js, and memory.js twice). The
    cache belongs in the module that owns the world (§36), so a fourth caller
    gets the saving without knowing it exists. Keyed by the index file's
    mtime+size, not by cwd — a re-index during a long run MUST invalidate it,
    or the world silently describes a repository that no longer exists.

The guard alone would flatter a fresh checkout and do nothing for a real user;
the cache alone would do nothing before the first build. Both were verified
against the case the other cannot help:

    empty pool  (fresh checkout)   71ms -> 0ms   (the guard)
    40-entry pool (real memory)    70ms -> 0ms   (the cache, after one build)

    system prompt build, warm     172ms -> 28ms  (6.1x)
    system prompt build, cold     493ms -> 274ms

### Catching two of its own cases being vacuous

A guard lane's dangerous failure is not "a case is wrong" but "a case cannot
be wrong" — a probe that passes whatever the code does is furniture that
reports 100%. Two of the twelve were exactly that when first written:

  - `loop-effort-scales-with-task` called `resolveEffort` with an options
    object. The signature is positional — `(profile, task, opts)` — so every
    input hit the `default` branch and returned `{deep:false}`. Both sides
    matched, and the case "passed" having proved nothing about adaptation.
  - `graph-invalidation-is-transitive` asserted only that the graph changed.
    On a fresh graph the grandchild is already not-completed, so the assertion
    held without any invalidation occurring. It now drives the whole chain to
    COMPLETED first, then invalidates the root, then checks the grandchild.

`tests/test-disciplines.mjs` (62 assertions) is mostly non-vacuity: for each
case it constructs the broken world the case claims to detect and asserts that
it says so.

### Deep mode sent a request its own default models reject

`streamAnthropic` set, unconditionally:

    body.thinking = { type: "enabled", budget_tokens: N }

That is the pre-4.6 form. From Claude 4.7 onward `budget_tokens` is not
deprecated but REJECTED WITH A 400 — and forge's own default Anthropic model
list is `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`, two of which
reject it. Deep mode is the mode forge escalates INTO for complex work, so the
harder the task, the likelier the run died at the first model call. It is one
line, it had no test, and no benchmark case looked at the provider contract.

`thinkingParamFor(model, maxTokens)` parses the version rather than matching a
table, because a table goes stale by design — a new model ships and the table
does not know it:

    claude-opus-5      -> 5.0  adaptive        claude-haiku-4-5   -> 4.5  budget
    claude-fable-5-1   -> 5.1  adaptive        claude-opus-4-1    -> 4.1  budget
    claude-opus-4-8    -> 4.8  adaptive        claude-3-5-sonnet  -> 3.5  budget
    claude-sonnet-4-6  -> 4.6  adaptive

Both of Anthropic's naming schemes parse (the version moved from before the
family to after it). An id that does not parse gets `adaptive`: every
currently-served model accepts it, unrecognised ids are overwhelmingly newer
than this code rather than older, and a hard 400 on every deep request is the
worse failure to risk.

### What the other four disciplines found: mostly nothing, stated plainly

The loop, harness, context and graph cases pin invariants that already held.
That is a result, not a gap in the work — the point of measuring is to learn
where the defects are NOT, and a benchmark that only ever reports problems is
one that was written to.

Compaction in particular was profiled looking for the same ordering defect
found in memory (expensive work before the cheap check that would have
skipped it) and does not have it: 310KB / 400 turns compacts in 5ms, folds
correctly at ~79k estimated tokens against a 128k window, and is a true no-op
below the threshold. `context-compaction-triggers-only-under-pressure` now
pins both halves, because each alone is vacuous — a compactor that never
fires passes "left alone", one that always fires passes "compacted".

### Four escapes caught in review, and what each one says

All four were in this release's own new code. They are recorded because the
pattern matters more than the fixes.

**The fix was applied to one of two paths.** `streamAnthropic` got
`thinkingParamFor`; `chatOnceInner`'s non-streaming Anthropic branch kept the
literal `budget_tokens`, so deep mode went on 400ing there. The grep that
"confirmed one occurrence" had been truncated by `head -10` — the second site
was on the next line. The budget literal is now constructed in exactly one
place, and `tests/test-disciplines.mjs` asserts that it stays that way.

**The boundary was computed from a decimal.** `Number("4.10")` is 4.1, so
`claude-opus-4-10` compared as OLDER than the 4.6 boundary and would have been
sent the rejected shape. Being right about models that do not exist yet is the
whole reason this parses instead of matching a table, so the comparison now
uses integer major/minor. The exported `anthropicModelVersion` stays a decimal
and is documented as reporting-only.

**The prompt cases built a prompt no run would produce.** `loadConfig` takes a
config FILE path and returns `{config, sources, ignored}`. The cases passed
`cwd` and then handed the wrapper to `agentSystemPrompt` as its config, so
`readJson` failed on a directory AND every config lookup — `yoloState`
included — read undefined and fell through to a default. Nothing complained,
because the prompt still built. The timings were re-measured against the
correct config afterwards and are unchanged (29ms vs 28ms): the 172ms baseline
was dominated by `relevantMemory` and `relevantLearnings`, which take `cwd`
and never saw the config at all.

**A benchmark that ran nothing reported success.** This is the v133.1 hole,
reopened one level deeper by this release's own slice logic:
`--lane capability --discipline prompt` selects a lane the slice then skips,
so nothing ran and the summary said `0/0  score 0%  regressed:false` and
exited 0. The `--lane` validation in `forge.js` was written to close exactly
this, but it validates each flag ALONE and the emptiness lives in the
INTERSECTION — which only `runSuite` can see. The guard now sits there, at the
boundary that knows.

### Verification

  - `npm test` — all 265 suites pass
  - security lane: security 246, memory 14, memory-pipeline 39, plugins 24,
    toolintel 171; providers 46
  - `forge bench` — 65/68, **95.6%** (v136: 51/54, 94.4%)
    capability 24/24, discipline 14/14, speed 15/15, programme 12/15

## 136.0.0 — The Terminal, Told

ui.js owns SGR — the escape sequences that colour a character cell. Nothing
owned **OSC**, the ones that address the terminal EMULATOR: hyperlinks, the
window title, desktop notifications, shell-integration marks.

The gap was oddly asymmetric. forge already *measured* OSC 8 correctly —
`render.js` strips it, so a hyperlink occupies only its visible text — and had
never emitted a single OSC byte. It could read the format and not write it.

`osc.js` is the emitter, and it is one module for the same reason `ui.js` is
one module: so "does this terminal support it, and is this payload safe" is
answered in exactly one place.

### Sanitizing is the point, not a detail

An SGR sequence carries a **number**. An OSC sequence carries a **string** —
and every string forge would put in one comes from somewhere it does not
control: a URL from a tool result, a task title from the model, a path from a
repository. OSC is terminated by BEL or `ESC \`, so a payload containing
either **ends the sequence early** and everything after it is read by the
terminal as fresh input:

```
title\x07\x1b]0;pwned\x07     →  a tool result that renames your window
```

So the same rule `contentfence.js` applies to tool output applies here.
Control characters are **removed, not escaped** — OSC has no escaping
mechanism, so deletion is the only safe transformation. Payloads are
length-capped. A hyperlink target must parse as an allow-listed scheme:
`http`, `https`, `file`, `mailto` — never `javascript:` or `data:`, because a
terminal that hands those to the system handler is a code-execution path.

A payload that cannot be made safe produces **no sequence at all**, and the
caller still gets its plain text back — so `hyperlink()` is always usable and
no caller has to ask first.

### What it can now do

| | |
|---|---|
| **OSC 8** | a clickable path or URL — and `displayWidth` already measured it right |
| **OSC 2** | the tab says `forge · Thinking — <task>` |
| **OSC 777** | a desktop toast when the run you walked away from finishes |
| **OSC 133** | prompt marks, so the host terminal can fold output and show per-command status |

### Where the title is driven from, and where it is not

Deliberately **not** from `setStatus()`. The status row carries a live elapsed
counter (`● Thinking 14.2s`), so a title wired to it would emit an OSC write
every second for no new information. `agentview.js` drives it from
`refreshStatus()` — the STATE change — and never from `tick()`. `terminal.js`
compares the sanitized result and drops a repeat, and hands the title back to
the user's shell in the same single write as the rest of its teardown, so a
killed terminal is never left advertising a run that ended.

### Degrading

Gated on being a **TTY**, not on `NO_COLOR`: that variable is about colour, and
a user who turned colour off still wants a working window title. What must
never happen is OSC bytes landing in a pipe or a file. `TERM=dumb`, a missing
`TERM`, CI, and `FORGE_NO_OSC=1` all get nothing. A plain `xterm` gets the
title (honoured for decades) but not hyperlinks, which it may print as garbage;
those need a terminal that identifies itself, or `FORGE_FORCE_OSC=1`.

### Verification

`tests/test-osc.mjs` — **78 assertions**, most of them adversarial: six
injection shapes (BEL, `ESC \`, a nested OSC, NUL, newline, C1) checked to
leave no control character behind and to produce exactly one terminator; every
refused URL scheme; every emitter proven silent when its capability is off; and
the wiring itself, including that the title is **not** reachable from `tick()`.

## 135.0.1 — A Write That Ran Beside the Check Proves Nothing

Two review findings against v135's `provenRepairs()`, both real, and the first
is an asymmetry in my own reasoning.

v135 excluded a file written by the **same step as the failing check**, on the
grounds that it landed before that result was known. The same argument applies
at the other end and was not made: `agent.js` runs one model turn's tool calls
through `runBatch()`, so **every call in a turn shares a step number**. A write
at `toStep` ran *beside* the passing check, not before it — the pass cannot be
evidence for it, and recording it as `successfulRepair` would hand a later run
a file that fixed nothing.

### The better fix was already in the data

Rather than change `<=` to `<`, this uses what the checks already record.
`commandChecks` carry `writeIndex` — `writesSoFar.length` at the moment the
check executed — so the writes that landed between two checks are exactly

```js
writes.slice(failed.writeIndex, fixed.writeIndex)
```

That is captured in **execution order**, so batching is handled by
construction: a write that ran before the check in the same batch is inside the
index, one that ran after it is not. Exact, where comparing steps was an
approximation. The step comparison remains as a fallback for records that
predate it, now applying the same rule at both ends.

### The second finding is the limit already recorded in TODO

The reviewer also asked that attribution be restricted to the failing check's
*verified scope*, so an unrelated file written in the same window is not
credited. That is the limitation v135 recorded in `TODO.md` rather than hid,
and the index boundary narrows it substantially without guessing. Doing it
properly means reusing `verifyledger`'s scope machinery, which is its own
change; the TODO entry stands.

`tests/test-run-teaches.mjs` → 51 assertions, covering both paths and the
preference between them.

## 135.0.0 — Which Attempt Worked

v132 taught forge to record a lesson when a run ends **blocked**. That is the
cheap half. The expensive half is a run that **failed three times and then
worked**: it knows which of the things tried was the one that fixed it, and no
amount of reading the final diff recovers that. It was thrown away.

`forge bench` programme lane **11/15 → 12/15**.

### Nothing is guessed — the loop already had the evidence

```
commandChecks[]  { command, passed, step, tail }   every check it ran
writes[] / writeSteps[]                            each file, and WHEN
```

A **proven repair** is a check that FAILED and later PASSED. The files written
between those two steps are what changed in between, so they are the repair.
That is an observation about this run — same command, same tree, red then green
— not an inference about causes.

`provenRepairs()` (lessons.js) is deliberately strict, because each of these
would be a repair it did not earn:

| | |
|---|---|
| a check that **never failed** | nothing was repaired |
| a check **still failing** at the end | not a repair |
| a **different** command passing | proves nothing about the failing one |
| an **earlier** red/green cycle | superseded by the last failure |
| a file written by the **same step** as the failing check | came before its result was known |

Results come back hardest-won first, so the caller taking `[0]` gets the check
that took the most tries — the one that taught the most.

### It reads as a fix that worked, because one did

The blocked-run lesson carries `solution` and renders as *"not repaired — the
next step recorded was…"*. This one carries `successfulRepair` and renders as
*"fix that worked: changed upload.js — after which `npm test` passed"*, at
confidence **0.7** against the unproven lesson's 0.35. v132 built that
distinction into the renderer; this is the first lesson that earns the stronger
side of it.

Both halves now run: a blocked run still records what stopped it, a completed
one records what unstopped it.

### The benchmark case was rewritten, not just satisfied

`run-teaches-on-success` previously tested `recordsSuccess && !onlyOnFailure`.
That was already an improvement on the version before it, but it was still
wrong in a way that would have surfaced today: keeping the (correct) failure
branch would have kept `onlyOnFailure` true forever, so the case could not have
closed honestly. It now requires a `successfulRepair:` **inside a
COMPLETED-gated block** and a `provenRepairs(` call — the actual property,
which cannot be satisfied by bolting a field onto the failure path.

### Verification

`tests/test-run-teaches.mjs` grows to 45 assertions, including one per way a
naive implementation claims an unearned repair, and the ordering guarantee.
All 263 suites pass.

## 134.1.0 — Eleven Review Findings, Verified One at a Time

A machine reviewer read this PR and filed eleven findings. Every one was
checked against the code; **all eleven were real**, and the sharpest was
against the fix shipped in 133.1 an hour earlier.

### The guard that could not catch its own bug

133.1 added a guard so the benchmark's "room above it" could never again rest
on a stopwatch. It compared case **declarations**:

```js
deterministic.length >= timed.length     // counts what EXISTS
```

which passes happily in exactly the situation it was written to catch — every
deterministic case succeeding while `boot-budget` is the only failure. It now
counts what is actually **open**, from `runSuite`'s results:

```js
openDeterministic.length > 0             // counts what is FAILING
```

A guard that cannot fail in the scenario it names is not a guard.

### The report and the exit code disagreed about "regression"

`runSuite` counted a regression only in the guard lanes (capability, speed).
`formatSuite` counted every non-programme failure. So an autonomy failure
printed under **"REGRESSED (n) — these used to pass"** while the summary said
`regressed: false` and `forge bench` exited 0 — two contradictory statements
about one run, in one report. `GUARD_LANES` is now named once and read by both.

### An incomparable baseline was still being scored

`perfbench` computes `sameMachine` and warns when a baseline came from
different hardware. The speed lane built its rows from `ran`/`passed`/`total`
and dropped that note, then scored the rows anyway — so an incomparable
measurement could set `regressed` and fail `forge bench` **for running on other
hardware**. The lane is now skipped with the reason stated. This is the same
mistake as the stopwatch above, one layer down.

### Two defects in v132's own code

- **`mcp_reconnect` rendered as nothing.** `loadMcpTools` emits
  `params: { reason }`; the event adapter read only `message` and `data`, so a
  reconnect printed `mcp <server>:` — an empty status line at exactly the
  moment the user wants to know why. (`data` as an object is now serialized
  too, instead of rendering `[object Object]`.)
- **A paused run recorded a failure lesson.** `resStatus` becomes
  `WAITING_FOR_USER`, which satisfies `!== "COMPLETED"`, so a run that stopped
  for a human decision persisted `run ended WAITING_FOR_USER on <blocker>` —
  and later surfaced it in prompts as something to avoid. A pending decision is
  not a failed outcome.

### Two more of 133.1's new cases were gameable

- `mcp-http-back-channel` passed on `!stillEmpty || hasStream`, so merely
  *declaring* capabilities would close it — while there is still nowhere to
  answer a server-initiated request. It requires `hasStream` now; declaring
  without the channel would make forge worse, not better.
- `run-teaches-on-success` computed `onlyOnFailure` and then ignored it, so
  adding a `successfulRepair:` field to the existing failure-only branch would
  have closed the case without teaching anything after a successful run.

### `evidence.js`

- **`samePath` did not canonicalize dot segments**, so
  `/repo/src/../agent.js` and `/repo/agent.js` compared as different files and
  `isStale` could keep evidence alive for a file that had changed — the exact
  failure it exists to prevent. A leading `..` on a relative path is preserved,
  because popping it would silently turn `../a.js` into `a.js`.
- **The basename index was cached on object identity alone.** A caller that
  added a path to the same writes object got the stale index back, and the
  fuzzy lookup answered "no" for a file that was right there.

### `forge bench` CLI

- A **misspelled lane** (`--lane capabilty`) matched nothing, so the run
  reported `total: 0, score: 0, regressed: false` and exited 0 — a typo that
  reads as a clean benchmark. Unknown lanes are now rejected.
- The help text still advertised **"20 deterministic eval cases"** (there are
  24) and documented neither `--cases` nor `--lane`. It now reads the count
  from `BENCH_CASES` rather than restating it.

All 263 suites pass; `test-benchsuite` gains three assertions covering the
regression definition, the rejected lane, and the corrected guard.

## 134.0.0 — The Boot Cost Was Four Builtins

`agent.js` imports in a fresh process in **112ms**. The `boot-budget` case has
been open since v129 and it is the last item of the "more fast" stage.

Two baselines appear below and they are not the same measurement, so both are
named: **178ms** is `BOOT_BASELINE_MS`, the v128-era cost the case was written
against and what the budget is judged against; **156ms** is what this machine
measured immediately before the change, and it is the honest before/after pair
for the table.

### v130 looked in the wrong place, and said so precisely enough to find it

v130 tried to cut boot by lazy-importing `tools.js` from `agent.js`, measured
**no change at all**, reverted it, and wrote down the conclusion: *"the cost is
the tree, not the edge."* That was right about the edge and wrong about where
the tree's weight sat.

Measuring every one of `agent.js`'s 47 direct imports in isolation:

```
agent.js = 134ms marginal, but FOURTEEN direct imports cost 65-122ms alone
  122ms context.js · 111ms capabilities.js · 101ms caproute.js · 100ms router.js
   99ms compose.js  ·  97ms toolintel.js  ·  91ms tools.js    ·  80ms mcp.js
```

They do not add up to 134 because they **overlap almost entirely**. The
intersection — the set every one of those eight entry points reaches — is
**seven modules costing 61ms**, and one of them is 52ms of it:

```
  52ms netguard.js · 15ms config.js · 11ms securefs.js · 11ms version.js
```

`netguard.js` imported Node's network stack at module scope:

```
  node:http 46ms · node:https 19ms · node:net 10ms · node:dns 2ms  ≈ 52ms
```

So every forge run paid to load the HTTP stack, including the majority that
never open a socket — because netguard is in the shared core of everything.
Not spread across 106 modules. Four builtins at the root.

### The fix

`netlazy.js` — one memoized loader, imported by the three modules on the boot
path that eagerly pulled sockets (`netguard.js`, `runtimesession.js`,
`browser.js`). §36: three copies would be three places to get the concurrency
wrong, and the first thing to get wrong is exactly that — two parallel callers
must share one in-flight import and must never observe a half-assigned set.

There were only three real uses across all three modules (`dns.lookup`,
`net.isIP`, and choosing `http` vs `https`) and every one is inside a function,
so nothing at module scope changed. `tcpConnectProbe` and `connectWs` became
`async`; both already returned promises and every caller already awaited them.
`requestPinned` stays synchronous and now **fails loudly** if it is ever
reached without the stack loaded, rather than throwing
`undefined.request is not a function` at some future caller.

| | before | after |
|---|---|---|
| `netguard.js` | 52ms | **2ms** |
| `runtimesession.js` | 90ms | 36ms |
| `browser.js` | 89ms | 35ms |
| `tools.js` | 107ms | 69ms |
| `context.js` | 122ms | 79ms |
| **`agent.js`** | **156ms** | **112ms** |

(marginal over a 22ms bare node, best-of-7, fresh process each run)

### On the case being marginal

`boot-budget`'s budget is 120ms. This reads 112ms on a quiet machine and 121ms
under load, so the case will now flip with the host. That is what a target
ought to look like, and it is only safe to ship because **v133.1 made the
benchmark's room structural**: three deterministic cases hold the programme
lane open regardless, so a flipping measurement can no longer take two suites
red with it.

Getting further means attacking the 106-module graph itself — no remaining
builtin is worth it (`node:child_process` is 6ms across 19 modules,
`node:crypto` 12ms across 17).

### Verification

All 263 suites pass, plus the security lane run alone (security 246, memory 14,
memory-pipeline 39, plugins 24, toolintel 171) and the two suites that exercise
the changed sockets directly: `todowise` 81 (it drives `tcpConnectProbe`) and
`ssrf-pinning` 161 (it drives `pinnedFetch` end to end).

## 133.1.0 — The Benchmark's Room Was a Stopwatch

A CI fix, and the defect is worth more than the fix.

Two workflow runs on the **same commit** disagreed: one green, one red, with
`benchsuite` and `v29` failing on the red one. That is usually a flake. It was
not.

At v133 the programme lane reached 11/12, and the one case still open was
`boot-budget` — the only **MEASURED** case in the lane. On the faster of the
two runners `agent.js` imported in under 120ms, so `boot-budget` **passed**,
`notYet` went to 0, and every assertion protecting "a benchmark you already
pass measures nothing" fired at once:

| suite | assertion |
|---|---|
| `test-benchsuite` | the combined score is below 100% |
| `test-benchsuite` | the lane still has open cases |
| `test-benchsuite` | prints why each open case matters |
| `test-benchsuite` | the budget is BELOW today's cost |
| `test-v29` | …which has room above it |
| `test-v29` | …and its open cases are 'not yet' |

So green or red depended on **how fast the CI runner was**. That is the
stopwatch anti-pattern this repository keeps catching — `test-v101` learned it
about timing assertions, and the benchmark's own doctrine says a MEASURED case
is reported, never averaged away. What nobody noticed is that the *room above
the benchmark* had quietly become one too.

`TODO.md` predicted it at v133 — *"the programme lane is down to one open case;
a benchmark you almost pass measures almost nothing"* — and it arrived a
release earlier than expected.

### The fix is structural, not a re-run

Three deterministic programme cases, all real gaps already recorded in
`TODO.md`, so the lane's openness can never again hinge on a clock:

- **`mcp-elicitation`** — forge never declares `elicitation`, and the modern
  spec forbids a server asking for an undeclared capability, so a server that
  needs a value from the human cannot get one.
- **`mcp-http-back-channel`** — the legacy HTTP handshake sends
  `capabilities: {}` *on purpose* (POST-only Streamable HTTP has no channel to
  answer a server-initiated request on). Hosted legacy servers therefore get a
  client that can never be asked. The SSE GET stream is the fix.
- **`run-teaches-on-success`** — v132 records a lesson only when a run ends
  blocked. Three failed approaches followed by one that worked is the most
  useful thing to remember, and it is thrown away.

And the non-vacuity check for `boot-budget` no longer compares the budget
against *this host's* measurement. It compares it against `BOOT_BASELINE_MS`
(178ms — what booting cost when the case was written), which is a property of
the code and identical on every machine. The host's measurement is still
printed; it is just never asserted on.

`tests/test-benchsuite.mjs` gains a guard for the class of bug rather than the
instance: **not every open case may be a measurement.**

### Verified against the condition that broke CI

`boot-budget` was forced to pass — the fast-runner case — and re-run:

| | at v133 | at v133.1 |
|---|---|---|
| `notYet` | 0 | **3** |
| `test-v29` | 2 assertions fail | **64/64 pass** |
| programme lane | 12/12 (full) | 12/15 |

## 133.0.0 — One Droppable File

Install was npm-only. `npm run build:single` now produces **`dist/forge.mjs`**:
one file, **1.4MB**, no dependencies. Copy it onto any box with node >= 20 and
`node forge.mjs` is a working forge — no registry, no `npm i`, nothing to
resolve. This is the "more standalone" half of the upgrade programme, and it
closes the last capability case but one: `forge bench` programme lane
**10/12 → 11/12**.

### Why it self-extracts instead of flattening

The obvious build is a bundler — concatenate the 192 modules, hoist the scopes,
rename the collisions. It would not work here, and not for want of effort.
This codebase legitimately reads its own directory:

| | |
|---|---|
| `version.js` | reads `package.json` from beside itself |
| `benchsuite.js` | `path.join(HERE, "mcp.js")` — spawns `node` on real paths |
| `measureBootMs` | imports a module in a **fresh process**, by path |
| ~40 modules | `new URL("./x", import.meta.url)` |
| many | `await import("./x.js")` chosen at runtime |

A flat bundle has ONE `import.meta.url` and no files on disk, so every one of
those becomes a silent lie: the artifact would start, and then be subtly wrong
in ways no smoke test catches. Extraction restores the layout the code is
entitled to assume, and the result is still one file to move around.

The payload is gzipped JSON in base64 (3.7MB of source → 1.4MB packed). First
run unpacks into `<FORGE_HOME|~/.forge>/runtime/<build-id>`; later runs cost one
marker check. The build id is `<version>-<sha256 of the payload>`, so a rebuild
is never served a stale tree — a version bump alone would not have been enough.

### Two things the tests found before the release did

- **Extraction was not recoverable.** Unpacking writes to a staging directory
  and renames it, so a half-written tree is never importable. But `rename`
  cannot replace a NON-EMPTY directory (`ENOTEMPTY`), and the only handled
  failure was "another process won the race". A first run interrupted between
  `mkdir` and the marker therefore left a tree that could never be repaired,
  and that box stayed broken until someone deleted it by hand. A marker-less
  tree is now removed and re-unpacked.
- **A test imported the builder.** It is a script, so importing it ran a full
  build into `dist/` as a side effect of reading its source.

`tests/test-single-file.mjs` (33 assertions) builds the artifact, runs the
**24-case decision benchmark out of it** from an unrelated directory with a cold
`FORGE_HOME` — and gets 100%, exactly as the repo does — then checks that
extraction is idempotent, content-keyed, `FORGE_HOME`-respecting, recoverable
from an interrupted unpack, and safe under three concurrent cold starts.

### The benchmark case was a file-exists check; now it builds and runs

`single-file-build` asserted that `scripts/build-single-file.mjs` existed. That
would pass on a script that produces a broken artifact, which is the one
failure the case is there to notice. It now builds to a temp directory, runs
the artifact with a cold home, and compares its version against the source
tree's. `scripts/build-single-file.mjs` is also shipped in `files[]`, so an
installed forge can rebuild itself.

### What is deliberately not in the file

`skills/` — 11.6MB of the 15.4MB shipped tree. forge downloads and verifies
skills at runtime and is explicitly not an offline tool, so baking the corpus in
would grow the artifact five-fold to ship what the runtime fetches anyway.
Documentation is out for the same reason: it does not run. Everything needed to
RUN is in there, `package.json` included, because `version.js` reads it.

`dist/` is gitignored. The artifact is a release asset, not source — committing
it would put a second, silently-stale copy of every module in the repository.

### Note on the room above the benchmark

The programme lane is now 11/12, with only `boot-budget` open. That is thin.
`tests/test-benchsuite.mjs` still holds (a benchmark you already pass measures
nothing), but the next release should retire the shipped cases and write harder
ones rather than coast on a single open item.

## 132.0.0 — A Run That Fails Leaves Knowledge Behind

Stage 3 of the upgrade programme: autonomy and knowledge. `forge bench` reads
**96.1%** (capability 24/24, speed 15/15) and the programme lane
goes **8/10 → 10/12** — two new cases, both of which failed before this change
and pass after it, with `single-file-build` and `boot-budget` still open so the
benchmark keeps room above it.

### forge was reading its own notes and never writing any

The learning loop had a read side and no write side:

| | where | when |
|---|---|---|
| **read** | `context.js:265` `lessonsForPrompt` | **every** run's prompt |
| **read** | `compose.js:177` `relevantLessons` | the hard-avoid list |
| **write** | `meta.js` `recordLesson` | multi-segment runs only |
| **write** | `tools.js:2241` `recordLearning` | only if the MODEL remembers to call it |

So a plain `runAgent` run — the commonest path there is — that ran out of
completion attempts, or had every mutation refused, left **nothing** behind.
The next run read an empty file and walked into the same wall.

`runAgent` now records one lesson at the end of a run, and only on the two
outcomes worth warning a later run about: a completion blocker that repeated
until its budget was spent, and a run whose every attempted mutation was
refused. Never from a read-only, plan-only or verifier run; one per run;
confidence **0.35**, because an observation is not a proven repair.

What it records as the way forward is the **completion gate's own
`nextAction`** — a real derived next step, not an invented one — and it goes in
`solution`, never in `successfulRepair`. Nothing repaired this run.

### …and the reader could not have rendered it anyway

Closing the loop needed a second fix, and this one was a live defect on its
own. `lessonPool({ needRepair: true })` admits a lesson on `successful_repair`
**or** `solution` — and `solution` has been a first-class field of
`recordLesson`'s schema since P1 — but `formatLessons` printed only
`successful_repair`. A lesson carrying just a `solution` therefore passed the
filter and rendered as:

```
- failure: build broke • cause: a missing export • fix that worked:
```

The one piece of knowledge it carried, dropped at the last step, with the empty
string still introduced as a fix that worked. A blocked run has no proven
repair, so it is exactly the case that hit this.

The renderer now falls back to `solution` — and says which it is. Flattening
the two would have been the other way to be wrong: `successful_repair` is
something that **did** repair it; `solution` may be a step nobody has run yet.

```
- failure: tests red • cause: off-by-one • fix that worked: fixed the loop bound
- failure: run ended BLOCKED • cause: the gate never cleared • not repaired — the next step recorded was: run the covering check first
```

### Autonomy: a dead MCP server was memoized as a corpse

v96 evicts a **rejected** connect from the lazy-client memo, and named the
reason: one transient failure must not make every later call reuse it. A server
that connected fine and then **died** — crashed, OOM-killed, restarted — is the
same bug one step further along, and it was not handled. The memo kept the
client, `_closed` was true, and every remaining tool call in the session
returned:

```
ERROR: MCP server "…" is closed (exited (code 0))
```

Nothing retried, because nothing had failed to *connect*.

`ensureConnected` now checks before reusing. The check is free in the case that
matters — a gone child sets `_closed`, so `isAlive()` costs nothing — and only
pays a `ping` round-trip for a client that has been **idle past
`MCP_IDLE_PING_MS` (30s)**. Pinging on every call would put a round-trip in
front of every MCP tool, which is a worse trade than the failure it prevents.
A racing second caller reuses the reconnect rather than spawning twice.

### §36: v131 shipped two wrappers with no caller

`forge selfaudit` reported `mcp.js:cancelCall` and `mcp.js:onProgress` as
orphaned capabilities the release after they shipped, and it was right. Both
duplicated something that already had exactly one implementation —
`client.cancel()` (which `_request`'s abort handler calls) and the `onEvent`
option on `connectServer`. They are **deleted, not wired**: wiring a second way
to do a thing is the failure the rule names. `pingServer` was kept, and now has
a production caller.

### Postscript on v131's speed lane

v131 reported five or six perf cases as REGRESSED and argued they were the
machine, not the code — on the evidence that v130 and v131 booted `agent.js` in
216ms and 214ms side by side, and that v130's own `forge perf` read the same
numbers v131 was being marked down for. On a quiet machine, against the same
untouched baseline, the speed lane now reads **15/15**. The argument held, and
not re-saving the baseline to make the lane green was the right call.

### Verification

- `tests/test-run-teaches.mjs` — 19 assertions; **10 fail on v131**
- `tests/test-mcp-dual-era.mjs` — 113 assertions; the recovery section fails on
  v131 with the exact `is closed (exited (code 0))` above
- All suites pass under `FORGE_FAST=1 FORGE_SECURITY_MODE=off
  FORGE_TEST_CONCURRENCY=4`, plus the five security-lane suites run alone

## 131.0.0 — MCP Is Dual-Era

Stage 2 of the upgrade programme. The **programme lane** — the part of the
benchmark with room above it — moves **1/10 → 8/10**, and the capability lane
stays at 24/24. The combined score reads 83.7–85.7% across runs; the spread is
entirely the speed lane, which is measuring this machine rather than this
change (see **On the speed lane** below).

### The problem was not a missing feature. It was a cliff.

MCP split into two eras, and forge was on the wrong side of the split:

| | legacy (`2025-11-25` and earlier) | modern (`2026-07-28`+) |
|---|---|---|
| handshake | `initialize` + `notifications/initialized` | **none** |
| version | negotiated once per session | declared **per request** in `_meta` |
| discovery | `tools/list` | `server/discover` |
| server → client | server-initiated JSON-RPC requests | **MRTR** — servers MUST NOT send requests |

forge spoke `2024-11-05`. The specification's own compatibility matrix says
what that means: **"legacy client + modern server → fails. Legacy clients have
no fall-forward mechanism."** As servers move to modern-only, forge stops being
able to talk to them at all.

forge now **probes each server once** and speaks whichever era it answers in.

### Getting the fallback wrong is the easy failure

The spec is explicit that the fallback **must not be keyed to a specific error
code**, and matching on `-32601` alone is exactly the mistake to make. A legacy
server meeting an unknown pre-`initialize` method may answer `-32601`, or
`-32602`, or nothing at all. Only a *recognized modern* reply — a
`DiscoverResult`, or `UnsupportedProtocolVersionError` (`-32022`) — means
modern; everything else means legacy. `-32022` in particular is a
**negotiation**, not a fallback signal: forge retries with a revision the
server named and never downgrades. A dual-era server that offers only legacy
revisions is taken at its word and handshakes.

`tests/test-mcp-dual-era.mjs` (98 assertions) drives all five shapes against
real stub servers over real pipes, and asserts on the JSONL the stub logged —
on bytes, not intentions.

### `capabilities: {}` was why nothing ever asked forge for anything

Both transports sent an empty capability object under the comment *"a minimal
client: we consume tools, advertise nothing."* Under the modern spec a server
**MUST NOT** send an inputRequest for a capability the client did not declare,
so that literal was the thing standing between forge and every server-side
feature. `clientCapabilities()` now declares what is actually implemented:

- **roots** — answered from `resolveWorkspace` (workspace.js). §36: the "which
  directory is this run about" question already had exactly one answer.
- **sampling** — off unless enabled (`mcp.sampling`, or `FORGE_MCP_SAMPLING=1`).
  It spends the *user's* tokens on a server's behalf, so it is never silent.
- **elicitation** — never declared, because it is not wired. A server that
  cannot ask cannot block.

One deliberate asymmetry: the **legacy HTTP** handshake still sends `{}`. A
legacy server told forge supports roots is entitled to send a JSON-RPC
*request* back, and over plain Streamable HTTP POSTs there is no channel to
answer one on. Declaring a capability we could not honour is worse than not
having it. Legacy **stdio** does declare, because `_dispatch` now answers
server-initiated `ping`, `roots/list` and `sampling/createMessage` — requests
that were previously dropped on the floor while the server waited forever.

### MRTR, and the architecture that happened to suit it

`_dispatch` was a response-only demultiplexer with no way to write
`{id, result}` back. Under the old spec that was a hard blocker for sampling
and roots. Under MRTR it is not a blocker at all: the server returns an
`InputRequiredResult` as the result of the client's *own* request, and the
client retries with the answers. All four MUSTs are pinned: fulfil every
`inputRequest`, echo the opaque `requestState` **verbatim**, use a **different
JSON-RPC id** on the retry, and stop after a bounded number of rounds.

### Cancellation: one line in tools.js

`tools.js` passed plugins `{ cwd, readOnly }` and nothing else, so `ctx.signal`
— the user's Ctrl+C, which every other tool in that switch already received —
never reached an MCP call. An in-flight MCP tool could only be *waited out*, to
the 20-second request timeout, with the server still working the whole time.
The signal is now threaded through `run(args, ctx)` → `callTool` → `_request`,
which sends a real `notifications/cancelled` naming the request id.

### Progress: a long call stops looking like a hung one

`_dispatch` now has a notification branch. `notifications/progress` and
`notifications/message` reach the run through the same `onEvent` the rest of
the loop uses (`agent.js`). forge asks for a `progressToken` only when someone
is listening — without one, a well-behaved server stays silent, so subscribing
is what turns the stream on.

### Two latent bugs fixed in passing

- The server's own `protocolVersion` was read and discarded on **both**
  transports since v23 (`mcp.js:199`, `:361`). It is the only place a legacy
  server states what it actually speaks; it is now kept as
  `serverProtocolVersion`.
- A non-2xx HTTP response was thrown on sight, **before the body was read** —
  which would have made a modern server's `-32022`-inside-a-400 read as "this
  endpoint is broken" rather than as instructions for how to talk to it.

### The benchmark cases were rewritten to the real spec

`TARGET_MCP_PROTOCOL` said `2025-03-26`. I set that from memory at v129 and it
was wrong twice over: the current revision is `2026-07-28`, **and 2025-03-26 is
itself a legacy revision** — so hitting the old target would have achieved
nothing. The seven MCP cases were also `exportsFn(m, "name")` presence checks,
which cannot tell a correct client from a stub. Five of the seven are now
**exercised**: `benchsuite.js` spawns a real stub server and asserts on what
crossed the pipe.

### On the speed lane

`forge bench` reports five or six perf cases as REGRESSED (+13% to +32%),
a different set on each run. **They are not this change.** Measured side by side on the same machine in the same
minute, v130 and v131 boot `agent.js` in **216ms and 214ms**, and v130's own
`forge perf` reads 99.2ms / 95.4ms / 189.7ms — the same numbers v131 is being
marked down for. The saved baseline (86ms / 83ms / 148ms) was captured on a
faster machine. The baseline is stale, not the code. It is left alone rather
than re-saved, because re-saving a baseline to make a red lane green is how a
benchmark stops meaning anything.

### Still open

`single-file-build` and `boot-budget` remain the room above the benchmark. The
boot budget needs the `tools.js` dependency-tree restructure (v130 established
that `tools.js` alone is 148ms of the 182ms, and that lazy-importing it from
`agent.js` changes nothing, because the cost is the tree, not the edge).

## 130.0.0 — A Blind Secret Scanner, and One Honest Speed Failure

Stage 1 of the upgrade programme, plus the defect that Stage 0's benchmark
found on its first outing.

### `redactSecrets` returned the wrong type, and code review went blind

The documented contract is `{ text, found }`. With security off it returned a
**bare string**, so every caller reading `.found` got `undefined`,
`undefined > 0` is false, and nothing threw:

- **`codereview.js:121`** — a `sk-ant-…` key added in a diff produced **no
  finding at all**. Code review silently stopped flagging committed secrets.
- **`childenv.js:32`** — secret-SHAPED environment values were handed to
  helper/MCP processes, while the secret-NAMED check one line above kept
  working. That asymmetry is the tell: the name filter was never gated on
  security mode, so the value filter was not meant to be either.

Redacting and counting are different jobs. Redaction is enforcement and is
correctly skipped when security is off; counting is an observation, and
switching an observation off is what blinded both callers. `redactSecrets` now
always returns the documented shape, always counts honestly, and applies the
masking only when enforcing. One scan, not two — a separate `countSecrets`
would have been a second copy of the whole rule set (§36). `redact()` is
unchanged.

`tests/test-security-mode.mjs` pinned the buggy shape while asserting `.text`
for the on-case twelve lines below — the inconsistency was the bug, visible in
the test the whole time. It now pins the contract in both modes plus the two
callers that went blind.

**How it was found:** it made `bench.js` case `24-reviewer-fixer-planner`
fail. The fast lane runs `FORGE_SECURITY_MODE=off`, and that case asserts
exactly that a secret in added lines is a blocker.

I first recorded this as a concurrency flake. **It was not.** It was
deterministic on `FORGE_SECURITY_MODE=off`; it only looked intermittent
because `test-benchsuite` (new in v129) is the one bench-running suite that
does not clear that variable, and all five of my isolation attempts ran
without it. The `TODO.md` entry is corrected.

Case 24 now **names its failing step** rather than reporting the metric slot
`toolCalls`, and no longer reads `process.cwd()` — a deterministic benchmark
case must not consult a shared, mutable working tree. The diagnostic paid for
itself immediately: `failed step(s): a secret in ADDED lines is a blocker`.
The capability lane's report now names the failing metric too.

### Tool results are summarised, not guillotined

`cap()` bounds one tool's raw output at 32000 chars by **cutting** it — it
keeps the first N bytes and drops the rest. For a build log that is backwards:
the error is at the end or in the middle. Measured on a 4000-line log with the
error at line 2000, a 32000-char cap **loses the error entirely**.

`summarizeForHistory` (in `context.js`, which already owns the token budget and
already imports `estimateTokens`) keeps the head, the tail, and any dropped
line that looks like a failure, and states how much it omitted:

| | before | after |
|---|---|---|
| 4000-line log into history | 32,000 chars, error lost | **3,715 chars, error kept** |
| a result that already fits | unchanged | **unchanged, byte-identical** |

Named for its destination because `uistate.js` already exports
`summarizeToolResult` for the terminal's activity view — a different job, and
`tests/test-v129` was right to reject the collision. Off with
`agent.summarizeToolResults: false`; budget via `agent.toolResultTokens`.

### The boot-time target was wrong, and I am not shipping a change that missed it

Stage 1 planned to cut boot from ~150ms of eager imports to 120ms by
lazy-loading four cold-path modules. I did it for `browser.js` and
`capfabric.js` and measured: **184ms — no change at all.**

The per-module costs that motivated it (63ms, 65ms) were each module *plus its
shared dependency tree in isolation*, not its marginal cost. Removing a leaf
that pulls the same shared deps saves nothing. The real distribution:

| | best-of-N, spawned |
|---|---|
| bare node | 29ms |
| **`tools.js` alone** | **148ms** |
| hot core (5 modules) | 170ms |
| full `agent.js` | 182ms |

`tools.js` accounts for ~119ms of the ~153ms, and it is required on every
turn. The 120ms budget is not reachable by deferring peripheral modules; it
needs `tools.js`'s own tree restructured, which is its own piece of work.

The two lazy imports were **reverted** — `agent.js`'s import block is
byte-identical to v129. A change that does not move the number it was made for
does not ship. The `boot-budget` case stays open and honest.

260/260 fast-lane suites, 494/494 security-enforcement suites.
FORGE-SUITE **79.6% → 81.6%**, programme lane **0/10 → 1/10**, capability and
speed unchanged.

## 129.0.0 — The Measuring Stick

Stage 0 of the upgrade programme. **This release adds no capability.** It adds
the instrument every later stage will be judged by, and writes down the line to
beat. Full numbers in `RELEASE-EVIDENCE-129.0.0.md`.

"Beat your own benchmark" needs one benchmark. forge had five, each answering a
different question and none combining — and the one that measured capability,
`bench.js`, sits at **24/24, 100%**, pinned there on purpose by
`tests/test-v29.mjs`. A benchmark already at 100% is a thermometer stuck at one
reading: it is a regression guard, and it can never be a growth target.

`benchsuite.js` composes the existing harnesses (§36 — not a sixth) into one
score across four lanes, and adds a `programme` lane holding what forge cannot
do yet:

```
FORGE-SUITE v128.0.0  39/49  score 79.6%
  capability   24/24   100%     guard, frozen
  programme     0/10     0%     the room above the benchmark
  speed        15/15   100%     vs a locally saved perf baseline
  autonomy    SKIPPED           no live provider
```

The ten open cases were each verified absent by measurement. `mcp.js` greps for
`sampling`, `roots`, `ping`, `progressToken`, `notifications/cancelled` and
`logging/setLevel` all return **zero**, and its `initialize` sends
`capabilities: {}` under the comment *"a minimal client: we consume tools,
advertise nothing"*.

**A measurement corrected while building this.** A first pass ran
`time node forge.js --version` once and read 1.0s. Both halves were wrong: one
run is mostly cold cache and shell overhead, and `--version` short-circuits
long before the agent loads. Best-of-7, spawned: bare node **28ms**,
`forge --version` **81ms**, `import agent.js` **178ms**, `import chat.js`
**205ms**. Startup is not 1.0s and never was; what is real is ~150ms of eager
module loading before an agent run can begin. The `boot-budget` case targets
120ms and fails today at ~180-210ms, so it is a target that can actually be
hit and actually be missed.

Rules the instrument enforces on itself:

- **A failing programme case is not a broken build.** Those cases fail by
  design until the capability ships, so only the guard lanes set the exit code.
  `forge bench` exits 0 today with all ten open. Otherwise CI would be red
  forever and would stop being read.
- **A lane that cannot run is SKIPPED** — never passed, never failed, excluded
  from the denominator, and named in the report.
- **Every case declares how strongly it is checked** (`exercised`, `measured`,
  `surface`), because a presence check is weaker evidence than a behaviour run
  and should say so rather than be counted as equal.
- **A budget that cannot fail is not a budget.** `tests/test-benchsuite.mjs`
  asserts the boot budget is strictly BELOW today's measured cost — the
  vacuous-assertion trap this project keeps catching.

`forge bench` is now the combined suite; `forge bench --cases` is the original
FORGE-BENCH report, still 24/24, and `--lane <name>` runs one lane. CI runs the
combined score. `tests/test-benchsuite.mjs` adds 42 assertions.

**Found, not fixed:** `bench.js` case `24-reviewer-fixer-planner` is flaky under
4-way test concurrency — it took the capability lane to 23/24 once and did not
reproduce under any of five isolation attempts. Not introduced here; recorded
in `TODO.md` rather than absorbed, because a regression guard that sometimes
lies is worse than no guard, and Stage 1 is about to depend on it.

259/259 fast-lane suites, 494/494 security-enforcement suites.

## 128.0.0 — Half a Fix Is Not a Fix

v125 was verified end to end against the build that produced the original
report, and the verification found the fix incomplete.

The reproduction is faithful: a real project whose own `npm run test` cannot
finish inside its budget, a real `runBash` timeout producing a real exit 124,
a real uncovered write, and the verification nudge really withdrawing the
model's answer. Run against v124.0.0 (the build that failed) and against HEAD.

v125 correctly restored the withdrawn answer — the completion gate's
`finalAnswerPresent` blocker cleared, and `answered` came back `true`. Then,
three hundred lines further down, the loop-halt note **assigned over
`finalText`** and the user saw a note about stopping anyway.

v125 stopped the GOVERNOR's note from replacing a real answer and missed the
identical shape on the end-of-run status notes:

```js
finalText = `(run stopped after repeating the same ${tool} call …)`
finalText = `(every attempt to change a file was refused …)`
finalText = `(run stopped at the step budget …)`
```

All three now go through one `note()` helper that appends when the model said
something and stands alone when it did not. The wording, the status and the
checkpoint are unchanged — only the destruction is gone.

Measured, same scenario, same inputs:

| | v124.0.0 | v128.0.0 |
|---|---|---|
| status | INCOMPLETE | INCOMPLETE |
| timed-out check | exit 124 | exit 124 |
| gate blockers | `finalAnswerPresent`, `notBudgetExhausted` | `notBudgetExhausted` |
| **answer survived** | **no** | **yes** |
| what the user sees | `(run stopped after repeating…)` | `Enhanced the planner: added the retry ceiling…` followed by the status note |

The status is still honestly INCOMPLETE and the budget note is still there.
What changed is that the work is no longer thrown away to make room for it.

Pinned in `tests/test-governor-answer.mjs`: all three notes append, and no
end-of-run note assigns over `finalText` any more.

### And the release script rewrote localhost

Cutting this release exposed a second defect, in `scripts/bump-version.mjs`.
Its `exact string` rule matched the bare version unanchored, so bumping
127.0.0 → 128.0.0 rewrote every `127.0.0.1` in the tree to `128.0.0.1` —
**55 files**, every mock server and provider `baseUrl` in the suite, and 48
suites red at once. `127.0.0.2` in the SSRF suite went the same way, and that
one failed as `EADDRNOTAVAIL: address not available 128.0.0.2`.

The collision only needs the version to be a numeric *prefix* of something
else, so this was a landmine waiting for whichever release happened to hit it,
and localhost was always going to be the one. Both version shapes are now
bounded — no digit or dot may sit immediately before or after the match — which
keeps `"127.0.0"` and `v127.0.0` while rejecting `127.0.0.1` and `1127.0.0`.

`tests/test-version-consistency.mjs` pins the rule two ways: it exercises the
regex against those cases, and it scans the tree for the corruption signature
(the package major spliced into an IP) while leaving the deliberate SSRF
fixtures — `10.0.0.1`, `224.0.0.1`, `240.0.0.1` — alone.

258/258 fast-lane suites, 494/494 security-enforcement suites, bench 24/24.

## 127.0.0 — Provenance and Staleness

The evidence layer answers two questions: *what supports this claim?* and *is
what I remember still true?* Both were being answered wrongly, and both
failures were silent — the graph reported a clean structure, and the memory
reported a fresh fact.

- **Evicting a node left its edges behind.** Dropping a node past `maxNodes`
  deleted the node and kept every edge that referenced it, so `related()`
  returned edges to ids the graph no longer held and `snapshot()` serialized
  them. `restore()` checks both endpoints, so it dropped exactly those — which
  means **snapshot → restore was not a round trip**. `cognition.js` persists
  that snapshot and reloads it when a run resumes, so a resumed run lost
  provenance the live run had. Measured on a 10-node graph pushed 6 past its
  cap: 9 edges live, 6 of them dangling, 3 surviving the round trip. The first
  to go are the `PREDICTION --predicts--> ACTION` links, which is the edge
  drift detection reads.

- **Eviction was FIFO over a Map, so updating a record made it the next to
  go.** `Map.set` on an existing key does not move it, and eviction takes the
  first key — so the node being actively refreshed kept its original slot and
  was evicted before genuinely older ones. Both real callers re-use stable ids
  (`recordVerificationEvent` with `verificationId`, cognition with `pred.id`),
  so this hit exactly the records that mattered most. Re-recording an id now
  refreshes its position, without disturbing its edges.

- **Paths were compared as exact strings, by code that disagreed with its own
  inputs.** `worldFromCwd()` keys its writes relative (`agent-benchmark.js`);
  a live run's writes arrive absolute from the tool arguments; and
  `filesCited()` — in the same subsystem — extracts `./governor.js` with a
  leading `./`. So:

  | remembered fact cites | file written as | was |
  |---|---|---|
  | `agent.js` | `/…/agent.js` | **not stale** |
  | `agent.js` | `./agent.js` | **not stale** |
  | `src\a.js` | `src/a.js` | **not stale** |

  Each of those is a claim about a file that has since changed, served as
  current truth. There is now one `samePath` rule in `evidence.js` — equal
  after separator normalization, or a suffix at a segment boundary — used by
  both `isStale()` and the graph's `staleFiles()`. `evidence-graph.js` imports
  it rather than keeping a second copy (§36). The exact hit stays the fast
  path; a basename index, cached against the writes map itself, runs only on a
  miss, so 500 lookups over a 700-key map take 2ms.

  The other direction is pinned too: `agent.js` is still not `notagent.js`, and
  `a/b.js` is still not `c/b.js`.

- **`recordVerificationEvent(graph, null)` threw.** A `= {}` default only
  covers `undefined`, and the one caller wraps it in a `try/catch`, so a null
  event was not skipped — it was silently discarded.

New suite `tests/test-evidence-provenance.mjs` (42 assertions), covering the
round trip, the eviction order, both directions of the path rule, the
end-to-end memory path through `filesCited`, and the cost of the fuzzy match.

258/258 fast-lane suites, 494/494 security-enforcement suites, bench 24/24.

## 126.0.0 — Graph Integrity

The code graph is the input to almost every judgement forge makes: which tests
cover a change, what a change can break, how much verification a change earns.
Four defects each made that graph quietly smaller than the repository it was
built from, and every consumer downstream reasoned from the shortfall as if it
were fact. Found by measuring forge's graph of forge against the tree itself.

- **`isTestFile` did not recognise how most projects name tests.** It matched
  a list of literal fragments — `.test.`, `.spec.`, `test_`, `_test.go`,
  `_test.py`, `Tests.java` — and missed everything else. This repository's 267
  suites are all `tests/test-<name>.mjs`, and it answered **false for every
  one of them**. So the cross-graph carried **0 TEST edges**, and
  `testsForFiles()` — the function whose whole job is telling the agent which
  tests cover what it just changed — returned `[]` for every input it had ever
  been asked about. v125's verification hint was built on that empty list.
  Also missed: `_test.js`/`_test.ts`, the singular `MyTest.java`,
  `conftest.py`, and any file inside a `tests/`, `test/`, `spec/` or
  `testing/` directory. The matcher is now directory-aware and stem-aware, and
  deliberately conservative in the other direction: `latest.js`, `contest.js`,
  `attest.js` and `src/spectrum.js` are still not tests, because a source file
  wrongly called a test vanishes from the importer graph.

- **There were two answers to "is this a test", and they disagreed (§36).**
  `impact.js` carried its own `TEST_HINT`, which *did* know about a `tests/`
  directory — so the walk fallback found tests the graph could not. The graph
  is built by the indexer, so the indexer's answer is now the only one.

- **Every import extractor capped at 20 imports per file.** `agent.js` has 48
  static imports, so 28 of its edges were dropped — among them
  `./completion.js`, which is why `consumersOf("completion.js")` listed
  bench/evolve/meta and not the module that most depends on it. The cap is now
  a named `MAX_IMPORTS_PER_FILE = 200`, with a separate `MAX_SYMBOLS_PER_FILE`
  for exports/calls/types so the constant does not lie about what it bounds.

- **The walk stopped at 400 files and reported stats indistinguishable from a
  complete index.** forge has 660 indexable files, so 260 were invisible —
  including 234 of its 267 suites — and `impactRadius` answered
  `unknown: false`, "no importers", about files whose importers were never
  scanned. `agent.js` already tells the model that "no importers found is not
  proof that nothing depends on them"; that warning could not fire, because
  nothing downstream knew the walk had been cut short. The walk now reports
  `truncated`, `impactRadius` propagates it into `unknown`, and the default
  budget is one named `DEFAULT_MAX_FILES = 1200` instead of the literal 400
  repeated at five sites. Raising it costs nothing: measured cold on forge,
  indexing all 660 files took **less** wall time than capping at 400 (55ms vs
  204ms), because the cap kept evicting and re-parsing the persisted index.

- **`dag.invalidateNodes()` returned a quadratic blast list.** The cascade
  re-enqueued a node once per path that reached it and pushed it onto
  `blocked` each time. That list is emitted verbatim as `blockedNodes`:

  | nodes | `blocked` returned | actually blocked | time |
  |---|---|---|---|
  | 60 | 1,770 | 59 | 6ms |
  | 120 | 7,140 | 119 | 52ms |
  | 240 | 28,680 | 239 | 627ms |

  Now a plain BFS: each node propagates once. 240 dense nodes → 239 entries,
  0ms. The cascade still reaches the end of a 200-long chain, and completed
  downstream work built on invalidated ground truth is still invalidated
  rather than merely blocked.

Measured on this repository, before → after:

| | before | after |
|---|---|---|
| files in the graph | 400 of 660 | **660 of 660** |
| suites recognised as tests | 0 | **274** |
| TEST edges | 0 | **87** |
| IMPORT edges | 441 | **750** |
| `agent.js` imports extracted | 20 of 48 | **48 of 48** |
| `testsForFiles("governor.js")` | `[]` | **47 suites** |
| `consumersOf("completion.js")` | 3 of 4 | **4 of 4** |
| `impactRadius("agent.js")` importers | 1 | **2** (found `chat.js`) |
| `invalidateNodes` on 240 dense nodes | 28,680 / 627ms | **239 / 0ms** |

New suite `tests/test-graph-integrity.mjs` (40 assertions). It does not use
fixtures: it compares the graph against the tree on disk, so lowering a cap or
narrowing the matcher again moves the numbers and fails. Notably, all 256
pre-existing suites passed both before and after these fixes — the graph was
wrong and nothing noticed, which is what the new suite is for.

257/257 fast-lane suites, 494/494 security-enforcement suites, bench 24/24.

## 125.0.0 — The Governor Stops Eating the Answer

A repair release for one user-visible failure, traced end to end:

```
stopped BLOCKED: no final answer was produced — a governor note about
stopping is not an answer to the user — 3 completion attempts did not clear it
⚠ FINISHED WITH FAILING CHECKS  tests: failed (exit 124)
  Changes 1 file · Tests failed · Verified 2 passing checks
```

One file changed, two checks green, and the user was handed a note about
stopping. The governor was not malfunctioning: it correctly reported that no
answer existed. Five defects in a row produced a state where that was true.

- **The bash tool advertised a timeout it does not have.** `timeout_sec` was
  documented as "default 45"; the real default is `AGENT_BUDGETS.timeoutSec`
  (180), capped at 900. A model that wants more room than it is told it has
  raises the number by hand — this run asked for 240s. Both numbers are now
  read from the budget, so the description cannot drift again.
- **The agent was pointed at a check it could not finish.** `recommendedVerify`
  answers `npm test` for any repo with a test script; here that is ~257 suites
  plus a ~6.5-minute e2e and a clean-room `npm install`. Killed at 240s.
  `focusedVerify` now also returns `ciCommand`: the same command as the
  project's own CI invokes it, read out of `.github/workflows` — for this repo
  `FORGE_SECURITY_MODE=off FORGE_FAST=1 FORGE_TEST_CONCURRENCY=1 npm test`,
  the fast lane that was documented in the README and in CI and was invisible
  to the agent. Nothing is invented: no workflow, no claim, and an env value
  that interpolates (`${{ secrets.X }}`) is never copied into the hint.
- **A check that timed out was read as a check that failed.** `completion.js`
  tested `passed === false` and nothing else, so exit 124 and exit 1 produced
  the same verdict: `FAILED_CHECK` → `REPAIR`. That is an unsatisfiable order —
  there is nothing to repair — so the model burned every completion attempt
  and the run ended `COMPLETION_ABANDONED`. New `BLOCKER.CHECK_TIMED_OUT` with
  `nextAction: "VERIFY"` asks for the work the model can actually do: narrow
  the check or raise its budget. It still blocks; a timeout is not evidence.
  The distinction was already computed and discarded in four places
  (`timedOut`, `failureShape: "timeout"`, `timed_out`, `FAILURE.TIMEOUT`).
  `verifyledger.js` stops describing a timeout as "FAILED … repair before
  completing" too.
- **The verification nudge destroyed a real answer.** The nudge withdraws
  `finalText` on purpose, so the model must restate it after checking. Only
  ONE exit from the loop ever put it back — the provider-death branch — and
  every other exit dropped it. The restore now lives on the single post-loop
  path, before `answerPresent` is read, so it covers governor halt, completion
  abandon, loop halt, budget and abort alike. It does not launder: the gate
  still sees the failing check and the uncovered writes and still refuses.
- **The governor's note replaced the answer instead of accompanying it.**
  v118 was right that a note is not an answer; it never meant "instead of the
  answer". When the model said something, the note is now appended to it.
- **A run that did work never ends empty-handed.** If there is still no text
  but files changed, the run reports its own record (files, checks, and which
  checks merely timed out). Synthesized after the gate, so `NO_ANSWER` stays a
  real blocker and the status is untouched.
- **`governor.js` set `enforce` twice in one object literal.** The second won
  and the first was dead code stating the opposite contract. Kept the
  intended one (`halt || (!micro && hideWrites)`, which test-v122 and
  test-authority already pin); runtime behaviour is unchanged, since wherever
  it is false `keep` is null, `forbidden` is empty and `hideWrites` is false.

- **The `--auto` kernel laundered a note into a COMPLETED answer.** v118
  closed this in `agent.js`; the meta path had the same hole and v118 did not
  cover it. The kernel read `res.text` and nothing else — not `res.status`,
  not `res.governor` — so a segment that ended in a governor STOP handed its
  note straight in, and if the WHOLE-TASK gate was satisfied on its own terms
  (DAG complete, workers settled, evidence sufficient) the note became a
  COMPLETED task's `finalText` and was emitted as `TASK_COMPLETED`. The agent
  result now states `answered` (whether the MODEL produced the text) and
  carries `governorNote` as its own field, so `meta.js` reads a flag instead
  of sniffing a string. The whole-task gate is deliberately NOT changed: it
  asks a different, global question and has no business refusing a finished
  DAG because the last segment ended on a note. The old `"task completed"`
  fallback — a claim, identical whether the run built something or nothing —
  is replaced by the task's own record. The REFUSED path still surfaces the
  note, which is the one place it belongs.

New suite `tests/test-governor-answer.mjs` (71 assertions) pins every link,
including two measured runs of the real agent loop: one against a provider
that goes silent after the nudge (the answer survives, and the uncovered write
is still reported as uncovered), and one that never answers at all (`answered`
is false while `text` is non-empty — which is exactly why the flag exists).

256/256 fast-lane suites, 494/494 security-enforcement suites, bench 24/24.

## 124.0.0 — Guard Hardening, Context Honesty & CI Credibility

An audit-and-repair release. Nothing here adds a feature; every entry closes a
defect found by probing the product's own behaviour, and each one ships with a
regression test that was verified to FAIL against the code before the fix.

Three themes:

- **The shell guard stops being fooled, and stops hanging.** Process
  substitution and nested/escaped substitution were classifying dangerous
  commands as `safe`; two separate ReDoS hangs (one in the fork-bomb detector,
  pre-existing) could freeze the safety check for 18-94 seconds.
- **Bounded things now say when they hit their bound.** The context budget
  silently dropped up to 89% of the available context; `grep_files` could hang
  the agent outright; tools threw instead of returning a readable error.
- **CI tells the truth.** Eight suites were silently skipped, the clean-room
  test mutated the tree it was testing, and a timing assertion was a coin flip
  on a shared runner.

Measured before → after, for one `classifyCommand`:

| input | before | after |
|---|---|---|
| 200 nested substitutions | 94,414ms | 547ms |
| `"$(".repeat(50000)` | 8,016ms | 11ms |
| `echo` + 100k characters | 18,438ms | 14ms |

260 test suites pass in both the default and `FORGE_SECURITY_MODE=enforce`
lanes.

### Loop engineering: `maxSteps` bounds the run it is asked to bound

A productive run extending past its step budget is v99's deliberate design and
it is right. What was wrong is that the extension was bounded only by the
**absolute** hard cap (1000), never by what the caller asked for — and the
increment carries a floor of 32. So a small budget was not a budget at all:

    maxSteps: 4  →  4, 36, 68, … 1000     (32 extensions)

Measured against a mock model that writes a different file every turn — the
shape that always looks productive, so every extension is granted:

| requested | model calls before | after |
|---|---|---|
| `maxSteps: 4` | 517 | **52** |
| `maxSteps: 8` | 521 | **104** |
| `maxSteps: 16` | 529 | **208** |

Nearly identical before, because `maxSteps` was not what stopped them —
`maxToolCallsHardCap` (500) was. Someone capping spend on an untrusted task with
`maxSteps: 4` got roughly 500 model calls.

The ceiling now scales with the request (13×, still clamped to the hard cap).
The factor is chosen so the **default is bit-identical**: 80 × 13 = 1040,
clamped to 1000, exactly as before — and anything at or above the default is
unchanged. Only deliberately small budgets are affected, which is the point.
The tool-call budget gets the same treatment.

Termination itself was audited and is sound: an always-empty model stops after
3 calls, a signature loop after 3, alternating empty/tool-call after 6, all well
inside the budget. The error paths are bounded too — `overflowBudget` is never
reset, and `retryBudget` resets only on a failover whose index advances
monotonically through the chain.

The extension *gate* itself was examined and left alone, which is worth
recording. meta.js's outer loop measures progress as a DELTA since the last
grant and refuses an explicitly-configured budget outright; agent.js's inner
loop uses a level inside a 10-step window and treats `agent.maxSteps` as soft
(v99's deliberate choice — `autoExtendSteps: false` is the opt-out, and
test-v99 pins a configured budget being extended). Aligning them looked
attractive and measured out unnecessary: a model writing one file per 10 turns,
or rewriting the same file, stops after **3** calls because the signature-loop
detector fires first; a model making genuinely diverse reads stops at exactly
its budget, because the diversity check keys on `name:result-prefix` rather than
on the call, so distinct arguments with similar results never look diverse. The
only shape that bought extensions was genuinely distinct writes — real progress
— and that is what the ceiling above now bounds proportionally.

`tests/test-loop-budget.mjs` (24 assertions) drives the real loop against these
adversarial models; 11 of them fail against the pre-change code, reproducing the
517 and 521 figures exactly.

One bench assertion moved with it: `23-step-extension` grepped the 700 bytes
after `productiveExtension` for the literal `maxStepsHardCap)`. The bound is now
computed just above that function, so the text moved while the invariant got
*stricter*. It asserts the invariant now — that the ceiling derives from the
hard cap and that the gate uses it — rather than where the text happens to sit.

### Harness engineering: Ctrl+C no longer waits out a retry backoff

Both retry loops on the hot path slept with a bare
`new Promise((r) => setTimeout(r, wait))`. The *request* was abortable; the wait
*between* requests was not — and in both places the abort signal was already in
scope, used a line or two above. A cancel landing during a backoff simply sat
there until the timer expired.

Measured against a local server answering 429 with `Retry-After: 5`: the abort
fired at 300ms and the loop exited at **8047ms**. The agent loop clamps its wait
at 60 seconds, so its worst case is a cancelled run holding the terminal for a
minute.

| | before | after |
|---|---|---|
| abort during a `Retry-After: 5` backoff | 8047ms | **301ms** |

One `sleepAbortable()` in `retry-policy.js` — the module that already owns
backoff — now serves both call sites, rather than a third private `sleep`. It
resolves on whichever comes first, removes its listener either way (a retry loop
must not leak one per attempt), and never throws on hostile input.

The fix does not weaken retrying: an *unaborted* 429 still makes all three
attempts and still waits between them, which the suite asserts alongside the
cancellation.

The rest of the cancellation path was audited and found already correct, which
is worth recording so the next pass does not redo it: tool execution aborts in
307ms and a pre-aborted signal short-circuits in 1ms without spawning; the event
sink is wrapped at a single choke point, so a throwing `onEvent` cannot kill a
run; every tool call's result is pushed before the `waitingForUser` break, so
the history cannot go malformed that way; and the `agentmanager` / `retrieval`
sleeps are inside `Promise.race`, which is the correct shape. The one further
gap was `firecrawlCrawl`'s poll loop, which checked the signal only *between*
polls — a cancel landing during the 2s wait paid for it — and now uses the same
helper.

`tests/test-harness-abort.mjs` (27 assertions) measures this rather than reading
it — it stands up a provider that always rate-limits and asserts on the clock,
because elapsed time is the only thing a user would notice. 9 of its assertions
fail against the pre-change code, including the 8025ms reproduction.

### Prompt engineering: the prompt no longer promises guards the code removed

The system prompt is the most effective safety mechanism in the product, because
a model that declines to try never reaches the tool layer at all. That only works
while the prompt is TRUE.

`agent.js` already carried a comment saying exactly this, added in v122. It
recurred anyway: v122 corrected the FULL-CONTROL branch of rules 6 and 7 and left
the default one — and YOLO is **off by default**, so the stale branch was the one
nearly every run actually saw. It promised:

- rule 6 — *"Writes must stay inside the working directory … the tool layer
  enforces that"*
- rule 7 — *"Catastrophic commands, writes outside the project, sudo, and
  publishes are blocked"*

Neither had been true since v88. Measured rather than read: `write_file` outside
the project returns `OK wrote …` and creates the file, and `modelMayRun()` answers
`{ok: true, unrestricted: true}` for `rm -rf /`, `mkfs.ext4 /dev/sda`, `sudo …`
and `npm publish` alike.

Both rules now state what is actually the case, which is the *more* cautious
instruction: nothing is blocked, the model's own judgement is the only thing
between the task and the machine, and anything destructive or outside the project
gets a one-line statement of what it will do before it runs. `chatSystemPrompt`
was already correct and is now pinned so it cannot drift the other way.

**And the log was being laundered.** `modelMayRun()` claimed in its own comment to
classify "so the risk level stays visible in logs", then passed
`allowSudo`/`allowNetworkUpload`/`allowInterpreterEval` as `true` — the three
flags that suppress exactly those signals. `sudo rm -rf /var/log` was recorded as
**safe**, a credential upload as `confirm`, `node -e` as `low`. The flags were
vestigial (the verdict is an unconditional `ok`), and the `opts` argument the
caller in `tools.js` populates was ignored outright. Grants now come from the
caller: an ungranted `sudo` reads `danger`, a granted one reads as the consent it
was, and `userMayRun` — which never laundered — agrees again.

`tests/test-prompt-policy.mjs` (48 assertions) does not compare the prompt to a
fixture. It runs the policy and requires the prompt to agree with what the policy
actually did, across every branch the flags can render. If a real block class is
ever restored, the assertions invert on their own and the prompt has to follow.

YOLO is unaffected and now says so under test. The honest-prompt pass rewrote
only the DEFAULT branches of rules 6 and 7; both FULL-CONTROL branches are
untouched, and `modelMayRun`'s verdict is still an unconditional `ok`, so the
higher reported levels change the log and nothing else (`skilldl`, `autofix` and
`capabilities` read `classifyCommand` directly and never saw `modelMayRun`).

`tests/test-yolo-unlimited.mjs` now pins that end to end rather than as policy
state: in YOLO a command actually RUNS — interpreter eval, a write outside the
project, an `rm -rf` — `write_file` outside the project lands, `modelMayRun`
still allows `rm -rf /`, `mkfs.ext4`, `sudo` and `npm publish`, and the prompt
carries all six full-control phrases while carrying neither restricted rule.
YOLO is the developer's mode and it is unrestricted; that is now enforced, not
re-checked by hand each time the guard is touched.

### bounding the shell guard: escaped backticks, and two ReDoS hangs

Four findings from CodeRabbit's review of PR #6, all verified against the code
before acting; two were real bugs in the guard, one of them mine.

**Escaped backticks hid a command (security).** bash requires the inner
delimiters of a nested backtick substitution to be escaped, and the scan looked
for the closing delimiter with `indexOf`, which stops at the first one — escaped
or not:

```sh
echo `echo \`rm -rf /\``      # the scan saw only the fragment:  echo \
```

The real command vanished and the whole thing classified **safe**, the worst
possible answer. The scan is now escape-aware and unescapes one level to recover
the nested payload. (Pre-existing: origin/main answers `safe` too.)

**Unbounded substitution work (availability, mine).** Making the extractor find
nested payloads made classification cubic in the nesting count: **200 nested
substitutions took 94 seconds** of synchronous work inside the bash safety
check. Each opener also scans forward for its close, so unterminated openers
were quadratic on top — `"$(".repeat(50000)` took 8 seconds. Now bounded by
`MAX_SUBSTITUTIONS` (12) and a 20k-character scan budget. Hitting either can
never *improve* a verdict: what was extracted is still classified, and the worst
of that and `confirm` is taken, so a buried `rm -rf /` still **blocks** out to
30 layers and an unreadable thicket asks rather than passes.

**A fixed window was the wrong bound (security, mine).** The first fix for the
ReDoS below ran the detector on a 512-character window around each definition.
That hid the bomb outright once the body was padded past it:
`bomb(){ X=<600 chars>; bomb|bomb& }; bomb` classified **safe** where the
unbounded version blocked. A bound that silently drops evidence is a bypass, not
a guard — and every fork-bomb test had a short body, which is exactly why they
all passed while the guard was broken. Caught in review on PR #6.

The detector now uses no regex and no window: it finds each `name(){ … }` with
`indexOf`, takes the body by counting braces, and answers the two questions the
regexes were really asking — does the body pipe into a background job, and does
it name itself. Both are substring tests, linear in command length and
*independent of body length*, so a 600-character body and a 600k one are read
the same way. The suite now asserts blocking at 0, 100, 400, 500, 511, 512, 513,
2000 and 50000 characters of padding.

**The fork-bomb detector was itself a ReDoS (availability, pre-existing).**
Found by the time bound added above. Its patterns chain several `[^}]*` runs,
one behind a backreference; with no `}` to stop them they backtrack
catastrophically. A CPU profile of `classifyCommand("echo " + "x".repeat(50000))`
put **98-99% of an 18-second run** inside those two regexes — an ordinary long
command line hung the guard. They now run only on a bounded window around each
`name(){` definition, via one shared `matchNearFnDef()` (the pattern was
duplicated in `isForkBomb` and `classifySub`).

Measured, before → after, for one `classifyCommand`:

| input | before | after |
|---|---|---|
| 200 nested substitutions | 94,414ms | 547ms |
| `"$(".repeat(50000)` | 8,016ms | 11ms |
| `echo` + 100k characters | 18,438ms | 14ms |

All 9 fork-bomb spellings still block and ordinary shell functions stay `safe`.

Two documentation/test corrections from the same review: the CHANGELOG credited
`child_process` with rejecting control characters (it rejects only NUL —
`gitPathspecError()` rejects the rest on its own judgement), and a fuzz
assertion matched the payload text `upload-pack`, which git legitimately echoes
back in a no-match message, so correct behaviour would have read as a bug.

### A pin's label now says the same thing as the pin

`scripts/bump-version.mjs` rewrote the version *assertions* and left the
human-readable *labels* alone, so 14 suites still read

```js
ok("package version is 117.x", /^124\./.test(VERSION), VERSION)
```

five releases after 117. The pins were correct the whole time, which is why no
suite ever went red over it — but a failure would have told whoever read it to
expect the wrong version.

Three layers, so it cannot come back: the 14 labels are corrected, the bump
script now rewrites labels alongside pins (128 → 144 pin shapes per release),
and `test-version-consistency` asserts that no suite labels a stale major,
naming the file and line when one does. Found by CodeRabbit on PR #6.

### v101's repo-map cache timing is no longer a coin flip

The `test` lane went red on this branch with

    FAIL the cache is keyed on FILES, not the query — cold=9ms warmOther=185ms

in a suite (`repomap.js`) that none of these commits touch. The cache is fine:
measured on a quiet machine the warm build is 2-3ms against a 50ms allowance,
a ~20x margin. The fragile part was the measurement — a single wall-clock
sample taken while the rest of the suite runs alongside it on a shared runner.

The warm phases are now sampled 5 times and the MINIMUM is taken. Contention
inflates a sample but can never deflate it, so the minimum is the true cost
while a GC or scheduling spike is not. The asserted property is unchanged.

Reproduced and verified rather than assumed: injecting a 180ms spike into one
sample (which lands almost exactly on the 185ms CI figure) fails the old
single-sample form 3 times in 8 and the hardened form 0 times in 8.

### the clean-room suite no longer mutates the tree it tests

`cleanroom-v20.sh` installed the package with
`npm i -g --prefix <temp> "$FORGE_DIR"` — i.e. from the source directory. npm
sets the exec bit on the `bin` entry **in place**, so every full-suite run
silently chmod'd the repo's own `forge.js` from 644 to 755 and left the working
tree dirty. The flip then rode along in the next `git add -A`, which is exactly
how it reached a PR diff as an unexplained mode change.

It now packs a tarball and installs that, matching what
`test-clean-room-package.mjs` already did and what a user actually installs. A
test must never mutate the tree it is testing.

Verified: with the old script `forge.js` came back 755 after a run; with the new
one it stays 644 and `git status` is clean after the full 260-suite run.

### a leading-dash pathspec is a filename, not a flag

Correcting a guard from the fuzz-contract change in the same release, on review
feedback from CodeRabbit on PR #5.

`gitPathspecError()` rejected any path starting with `-`, on the reasoning that
git would read it as a flag. That reasoning was wrong twice over: `git_diff`,
`git_log` and `git_blame` all pass the path **after `--`**, which ends git's
option parsing, and the argv goes to `execFile` rather than a shell — so there
was no injection shape to close. The only effect was to refuse `-report.txt`
and every other legally tracked file whose name starts with a dash.

Verified against git directly: `add`, `commit`, `log`, `blame` and `diff` all
accept such a file after `--`. The NUL-byte and control-character checks stay —
those are real (`child_process` rejects the argv entry and the call throws).

`tests/test-tool-fuzz-contract.mjs` now builds a scratch repo containing a real
`-report.txt` and reads it back through all three tools, so the claim is proven
against git rather than argued from the source; 9 of its assertions fail against
the over-strict guard.

Also in the same suites: `path.dirname(new URL(…).pathname)` → `fileURLToPath`,
since `pathname` keeps percent-escapes and is not a native Windows path, either
of which would make the "is this a git checkout" probe miss and silently skip
the ordinary-usage assertions.

### context engineering: the budget says when it hit its bound

The context engine fits sections (profile, repo map, memory, learnings, lessons,
skills, cross-refs) to a token budget in priority order and drops what does not
fit. That policy is right; not reporting it was the bug. Three things compounded:

- the fit loop set `s.dropped = true` then `continue`d — on an object it never
  pushed anywhere, so the marker died with the local;
- `sections` therefore carried only survivors, and the
  `kept.filter(s => !s.dropped)` that built the text could never match;
- `budgetOverflow`, added in v96 with the comment *"the caller must be able to
  see that"*, had no reader anywhere in the tree.

All three callers (segment, repair, verification) read `.text` and discarded the
rest. Measured on this checkout at an 800-token budget, the repo map — 980 of
1099 available tokens, **89% of the context** — was dropped, and a segment that
ran without it was indistinguishable in the run log from a repo that never had
one.

Every build now returns a fit record (`budget`, `dropped`, `droppedTokens`,
`fitsBudget`), and `buildContextBlock()` in meta.js routes all three callsites
and emits `CONTEXT_TRUNCATED` naming the phase, the budget, and each dropped
section with its token cost. Truncation is a signal, never a failure: the build
is returned unchanged and the run continues either way.

`tests/test-context-fit.mjs` (59 assertions) covers the fit record, the emitted
signal, and that no caller can go around the helper — which is how the signal
died the first time.

### shellguard: a command hidden in a substitution is still a command

Two bypasses found by probing `classifyCommand` with wrapped payloads:

- **Process substitution was never scanned.** `cat <(rm -rf /)`, `tee >(sh)` and
  `diff <(sudo cat /etc/shadow) x` all classified `safe`, while the identical
  `$( … )` spellings blocked. bash runs the inner command either way.
- **Nested substitution escaped the scan.** The extractor was a regex whose
  payload class was `[^)]*`, so it stopped at the first `)`. One extra layer —
  `echo $(echo $(rm -rf /))` — reduced to a harmless `echo` fragment and
  classified `safe`.

`substitutionPayloads()` replaces both regexes with a paren-counting scan that
keeps going past each opener, so nested payloads surface too. Measured over
48 dangerous-command/wrapper pairs: 28 classified better wrapped than bare
before, 0 after. Ordinary `<` / `>` redirects are untouched.

`tests/test-shell-substitution.mjs` (95 assertions) pins the property rather
than the three fixes: a command's classification may never improve by moving
it inside a substitution.

### every tool answers hostile args, none throws

Found by fuzzing the tool layer, the same review pass that found the grep hang.

The tool layer's contract is that a bad call comes back as a string the model
can READ and recover from. A throw is different in kind: it escapes the tool and
the model learns nothing it can act on. Sweeping every wire tool with a battery
of hostile arguments, **411 of 414 combinations kept that contract** — the three
that did not were `git_diff`, `git_log` and `git_blame` with a NUL byte in
`path`: child_process rejects the argv entry and the throw escaped. Every other
file tool already answered a NUL path with an error (`read_file`:
"invalid path component"), so those three were the outliers, not the rule.

- `gitPathspecError()` validates a pathspec before it reaches spawn and is wired
  into all three. A **NUL byte** is what `child_process` itself rejects (it
  throws `ERR_INVALID_ARG_VALUE` on the argv entry) — that is the crash this
  closes. Ordinary **control characters** are accepted by `child_process` and
  are rejected by `gitPathspecError()` on its own judgement, as a path nobody
  means to ask for.
  (Corrected below: a first version of this guard also rejected a **leading
  `-`**, which was wrong — see the Unreleased entry on leading-dash pathspecs.)
- Ordinary usage is untouched: `git_log` with and without a path, `git_diff`
  against a base and a path, and `./`-relative `git_blame` all still work.

New suite `test-tool-fuzz-contract.mjs` keeps the fuzz itself as a regression
(506 tool/arg combinations across 23 in-process tools). It is deliberately a
PROPERTY test — "no tool throws" — rather than three fixed cases, so the next
tool to break the contract is caught by the same net. It fails against the
pre-change tools.js with the exact NUL throws.

### grep_files can no longer hang the agent

Found by review, not by a report. `grep_files` compiles a regex the MODEL wrote
and runs it over every line of every file under a path. JavaScript has no regex
timeout, so ONE nested quantifier froze the whole agent process:
`grep_files {"pattern":"(a+)+$"}` against a single 41-character line never
returned — the run had to be killed. Patterns of that shape are easy to write by
accident (`(\s*\w+)+` is a plausible "words on a line" attempt).

Two defences, both bounded and honest:

- **A deterministic pre-screen** (`riskyRegexReason`) refuses the provably
  catastrophic shape BEFORE compiling: a group whose last token is unbounded and
  which is itself repeated — `(a+)+`, `(\s*\w+)+`, `([a-z]+)*`, `(x{2,})+`.
  The error names the cause and how to rewrite it. It is deliberately
  conservative, so anchored patterns like `(a+b)+`, which cannot blow up, keep
  working; it does not claim to catch overlapping alternation.
- **A wall-clock deadline** bounds the walk (directory, file and every 64th
  line), so a merely SLOW pattern returns partial results that SAY they are
  partial instead of running forever.

`glob_files` was audited too and is safe: `globToRegex` emits `[^/]*` and
`(?:.*/)?` with no nested group quantifier (40 `*`s complete in ~10ms).
`grep_files` was the only tool compiling a model-supplied regex.

New suite `test-grep-redos.mjs` (34 assertions) pins the refusal, the sub-second
bound on it, the absence of collateral damage to ordinary patterns, the
predicate's totality, and the deadline wiring. The runner's 120s per-suite
timeout means a regression surfaces as a failed suite rather than a hung CI.

### reviewer line numbers are checked, not trusted

The code-review pass merges deterministic findings, which carry observed
evidence, with findings a reviewer AGENT reports as strict JSON. The agent's
`file:line` was taken on faith. A wrong coordinate is worse than none: it reads
like a fact and sends the reader to unrelated code.

- `addedLineNumbers()` parses the hunk headers of the diff the pass already
  holds (`@@ -old,n +new,n @@`), tracking the new-side counter exactly — a `+`
  line and a context line each consume one, a `-` line consumes none.
- `verifyFindingLines()` checks every claimed line against the lines that diff
  actually ADDED. Verified → kept, `lineVerified: true`. Unverifiable → `line`
  nulled, claim preserved as `claimedLine`, `lineVerified: false`. No diff to
  check against → `lineVerified: null`, never a guess in either direction.
- The FINDING is never dropped — a real bug reported at the wrong line is still
  a real bug. Only the coordinate is demoted.
- Applied at the single choke point in `runCodeReview`, so nothing reaches the
  caller unchecked. New suite `test-review-lines.mjs` (37 assertions).

Also: `forge yolo` now states what a pinned `governor.enforce: "always"`
restores — an ASK can still pause the run in `WAITING_FOR_USER`, which is the
one way a screen reading FULL CONTROL can still stop for a human.

Also: corrected a TODO entry that was three releases stale. Tree-sitter
consumption was recorded as open, but v101 wired layer 2 through
`treeSitterOr()` and `tests/test-v101.mjs` §16 proves it end to end against a
stub binary. TODO.md claims every item in it is genuinely open, so the entry is
corrected rather than deleted.

### autofix admits any formatter that says it formats

autofix runs a formatter **autonomously** (no LLM, no confirmation) when a
verification failure is lint/format-shaped, so its admission rule is a security
contract. It was a closed table of 22 binary names — the last hand-written
command allowlist in the engine — and a project whose formatter was not on it
paid a full LLM repair for something deterministic.

- The table stays as ONE way to qualify (format-by-default tools like `black .`
  name no action). A command may now also **say** it formats: a format-shaped
  binary name (`nixpkgs-fmt`, `clang-format`), a `fmt`/`format`/`fix`
  subcommand (`taplo fmt`, `php-cs-fixer fix`), or an in-place flag
  (`shfmt -w`, `yapf -i`, `ktlint -F`). Twelve formatters that previously fell
  through to the LLM now run deterministically.
- The guards that carry the safety are kept and tightened. Programs that run
  OTHER programs — `bash ./fmt.sh`, `npx …`, `node …`, `make`, `just`,
  `docker`, `sudo`, `poetry run` — are refused outright, because shellguard
  rates several of them "safe" (the danger is in the argument, not the verb).
  A name-shape rule without that check would have been a hole.
- Binaries are matched by **basename**, so a repo-local
  `./node_modules/.bin/prettier` is recognised — and `/bin/bash` cannot slip
  past the indirection check by spelling itself out.
- **Two dead branches fixed.** `/\b--fix\b/` never matched `--fix` (a `\b`
  between a space and a `-` is not a word boundary), so every
  eslint/ruff/biome/standard command was silently rejected and those four table
  entries were unreachable. The rule now asks for a fixing ACTION rather than
  one hard-coded flag, which also admits `biome format --write` (biome's actual
  fixing form).
- New suite `test-autofix-shape.mjs` (64 assertions) pins the whole admission
  matrix; 15 of them fail against the old implementation.

### read-path TOCTOU hardening

`read_file` resolved the same name **four** times — `existsSync`, `statSync`,
`openSync` for the 8KB binary sniff, then `openSync` again inside
`readLineRange` — and every one of them followed symlinks. Writes have been
descriptor-relative since v21.1 (`secureWriteFile`); reads were the remaining
asymmetry.

- `read_file` now opens **once** through `projectOpenRead()` →
  `secureOpenRead()`: O_NOFOLLOW on every path component, anchored to the
  project root (or, for the unrestricted reads v88 allows, to the target's own
  parent). The size, the binary sniff and the streamed window all come from
  that single descriptor.
- `readLineRange()` now takes a descriptor instead of a path. Its streaming
  budgets (READ_CHUNK / READ_SCAN_CAP / READ_MAX_BYTES / READ_MAX_LINE) are
  unchanged, so the v20.1 OOM fix stands.
- The window this closes is not theoretical: with the old code a file swapped
  between the sniff and the stream served **binary bytes the sniff had already
  cleared**. `tests/test-read-toctou.mjs` (23 assertions) demonstrates it by
  fault injection and fails on the old implementation.
- Symlinked FILES stay readable (repos alias configs and vendored sources on
  purpose): the trailing link is followed once and the DESTINATION is opened
  with O_NOFOLLOW. Reads outside the project remain unrestricted per v88 —
  this changes HOW the open happens, not what may be read.
- Every historical error string is preserved (`not found`, `is a directory`,
  `binary file (not readable as text)`, `past the end of the file`).

### CI credibility, release tooling, full-control developer mode

### CI lanes (the green now covers what it claimed)

CI ran `FORGE_FAST=1 FORGE_SECURITY_MODE=off`, which silently skipped **8
suites**: the fast lane dropped both bash suites and the clean-room package
suite, and the off-lane dropped the five enforcement suites. Two new jobs close
that hole:

- `security-enforcement` — runs `security`, `memory`, `mem-pipeline`, `plugins`
  and `toolintel` with security at its default (ON). These had never run in CI.
- `full-suite` — runs the clean-room package suite and the end-to-end CLI suite
  at default security (what a user actually gets).

It immediately paid for itself: `package.json` was shipping four
`tests/test-horizon-*.mjs` files, against the clean-room suite's own "NO tests
are shipped" contract. Removed — the published package no longer carries tests.

### Release tooling

- `npm run bump <version>` (`scripts/bump-version.mjs`) rewrites `package.json`
  and every test version pin atomically (70 files, 128 pins), with `--dry-run`.
  Bumping by hand is what reddened 69 suites between 122.1.0 and 123.6.0.

### Full-control developer mode (YOLO)

Full control now means it, while keeping the two honesty invariants:

- **delivery never pauses** — `yolo.deliverUnattended` promotes the consent tier
  the owner already enabled (`commit: ask→auto`, `push: explicit→auto`,
  `pr: gh→auto`), so a run no longer parks in `WAITING_FOR_USER` mid-delivery.
  It never promotes `off`: `gitship.*` still decides *whether* to ship and still
  ships `off`, so a YOLO run in a repo that never opted in ships nothing.
  `auto` is also a first-class config value on its own.
- **`completion.requireEvidence: false`** (which YOLO implies) waives the
  covering-check blocker and reports **`COMPLETED_UNVERIFIED`** — never a clean
  `COMPLETED`. The waived evidence travels with the verdict. A check that ran
  and FAILED, a missing answer, and a mutation that wrote nothing still block:
  those are facts, not missing evidence.
- **`forge yolo on --sandbox`** pairs full control with the jail explicitly.
  YOLO alone never arms a sandbox — the two questions stay orthogonal.
- `forge yolo` reports all three, including that `gitship.*` still gates shipping.
- New suite `test-yolo-unlimited.mjs` (30 checks) pins each unlock *and* each
  line deliberately not crossed.

## 123.6.0 — Integration Audit & Wiring Repair

- repaired live Horizon changed-file normalization (absolute agent paths → repository-relative semantic graph paths)
- moved live Horizon observation after tool write journaling so current writes are included in the same update
- replanned DAG is now consumed by the live Horizon checkpoint/frontier/coordinator instead of being advisory-only output
- enriched live Horizon event evidence with impact, replan, recovery, and wave metadata
- repaired live agent Horizon update TDZ/renamed-budget wiring (`stepBudget` → `maxSteps`)
- restored Level-2 brief context propagation through the agent system-prompt boundary
- added a real mock-provider live-agent integration regression for post-write Horizon impact
- no security-critical implementation changes

### 123.6.0 — full-suite audit & repair follow-up

- brought every test suite green under the CI `FORGE_SECURITY_MODE=off` lane:
  - refreshed stale release-gate version pins (`122.1.0` → `123.6.0`) across the
    suites and the v94a README-claim check
  - made the security-behavior suites (secret redaction, content fence, SSRF
    pinning, hardening, MCP opt-in gating, decision benches) assert forge's
    default security-on contract regardless of the ambient off-lane env, so the
    controls stay *tested* in CI rather than skipped
- wired the two previously-orphaned benchmark modules into the CLI:
  `forge agent-bench` (live-provider harness, honest `NOT_RUN`) and
  `forge alpha-bench` (deterministic orchestration benchmark)
- declared the remaining importer-free V4 primitives (`module-loader`,
  `python-ipc`, `processguard`, `test-runner-policy`) as deliberate self-audit
  entry points so `forge selfaudit` reports zero islands while still catching
  any *future* accidental island
- lifecycle repair: `DIAGNOSE → INSPECT` is now an allowed cognitive-state
  transition, so the governor's "re-inspect before repair" decision is reflected
  in the phase instead of being emitted only as text
- allow-listed three deliberate domain-scoped export homonyms
  (`consolidateMemory`, `adaptivePlan`, `adversarialReview`)
- registered three orphaned test suites in the runner
  (`intelligence-next-integration`, `horizon-risk-integration`, `outcome-close`)
- added a dedicated GitHub CLI test suite (`test-github-cli.mjs`, 63 checks):
  deterministic coverage of `github.js` via an injected `gh` spawn — auth-state
  classification, exact read-only argv per action, safe-id validation and
  shell-injection refusal, honest failure paths, evidence-fact derivation,
  bounded preview, and task→action routing
- hardened the path-hygiene import scanner to ignore import-shaped substrings
  inside fixture string literals
- added a root `.gitignore` (runtime `.forge/`, `node_modules/`, editor cruft)
- no security-critical implementation changes

## 123.5.0 — Horizon Multi-Agent Coordination

- Added bounded, conflict-aware multi-agent wave coordination to the live horizon path.
- Advisory only; governor, tool authority, verification and completion remain authoritative.

## 123.4.0 — Horizon Recovery Intelligence

- Added bounded deterministic horizon recovery guidance and live cognition wiring.
- Recovery is advisory; checkpoint, governor, verification, and completion authority remain unchanged.

## 123.3.0 — Repository Impact + Adaptive Replan Wiring

- Wired observed changed files into semantic repository impact analysis on the live horizon path.
- Added evidence-triggered adaptive replanning when horizon observations contain failures.
- Exposed impact/replan state to horizon events and cognition prompt context.
- Security-critical modules unchanged.

## 123.2.0 — Complete live horizon wiring

- Wires horizon risk/frontier updates into the live agent tool loop.
- Horizon nodes carry repository target-file metadata where available.
- Horizon guidance is exposed to the cognition prompt as advisory context.
- Governor, authority, completion, and security controls remain unchanged.

## 123.1.0 — Evidence-Driven Horizon Risk

- Adds deterministic horizon risk scoring from explicit changed-file, historical-failure, and failing-test evidence.
- Flags medium/high-risk frontier nodes for verification escalation without bypassing governor authority.
- No security implementation changes.

## 123.0.0 — Live Horizon Advancement

- Added deterministic `advanceHorizon()` to recompute dependency-safe frontier, decision, and bounded checkpoint state from explicit observed progress.
- Added cognition `updateHorizon()` integration; horizon state can now be advanced from explicit completion/failure/evidence observations without inferring success from writes.
- Added horizon/cognition integration regression coverage.
- Existing authority, verification, memory, routing, execution, and security layers remain unchanged.

## 122.9.0 — Long-Horizon Intelligence

- Added deterministic horizon DAG validation, adaptive frontier selection, checkpoint state, and evidence-aware horizon decisions.
- Wired horizon intelligence into the cognitive boot snapshot without bypassing governor/verification authority.
- Added regression tests; security-critical modules remain untouched.

## 122.7.0 — bounded next-level intelligence + process lifecycle policy

- Added advisory meta-reasoning, long-horizon frontier planning, regression-risk analysis, test proposals, edge-case discovery, strategy evidence scoring, bounded memory consolidation, multi-agent scheduling, and benchmark matrix generation.
- Wired the additive intelligence snapshot into the existing cognition boot path; governor, verification, security, and execution authority remain authoritative.
- Added process lifecycle classification/policy primitives for graceful-first timeout/cancel handling and honest SIGKILL/OOM uncertainty.
- Development/test security behavior remains configurable; production security remains fail-closed. No security implementation module was changed.
- Full fast-lane regression was attempted but did not complete within the execution window; an intermittent state-concurrency child-writer failure was observed. Therefore this release is NOT claimed as full-suite green.

## 122.6.0 — level-2 autonomy composition

Built directly on 122.5.0. No existing subsystem is replaced or duplicated. Added
`autonomy-level2.js`, a deterministic composition layer for:
- hierarchical user-task decomposition with explicit dependencies;
- bounded context compression that prioritizes requirements, verification and failure evidence;
- counterfactual strategy candidates without auto-selecting an unverified winner;
- resource-aware specialist scheduling with a single-writer invariant;
- impact-aware verification escalation using the existing impact and planner-risk engines;
- a Level-2 brief injected into the live agent prompt for non-read-only runs.

No model calls, tool execution, security bypass, or production security changes were added.
Every new behavior has a dedicated regression suite.

## 122.5.0 — intelligence expansion

- Added deterministic semantic repository intelligence using the existing semantic graph: objective-target matching plus bounded dependency/call impact tracing.
- Added adaptive planning that turns repository evidence and observed failures into an inspect → impact → implement/repair → verify sequence and runs the existing plan-quality gate.
- Added failure intelligence that composes existing failure classification with safe recovery strategies and repeated-failure detection.
- Added adversarial completion review over report, tool-use, evidence, and verification facts; unsupported success claims are rejected.
- Added measured strategy composition and a bounded `.forge/intelligence-expansion.json` snapshot; no model result is fabricated by these services.
- Wired the expansion surfaces into the cognitive snapshot/prompt/observation path.
- Security implementation was not changed; the existing development/test security-off behavior and production fail-closed behavior are preserved.
- Full-suite status is explicitly NOT GREEN for this release until the existing state-concurrency failure and long-running full-suite behavior receive a clean isolated run.

## 122.3.0 — outcome learning v2 + live-path learning fix

- Upgraded the bounded strategy outcome model to v2 with recent-outcome history and a conservative Wilson confidence bound before learned strategy ordering can refine the default ranking.
- Preserved the existing safety invariant: outcome learning remains advisory and cannot manufacture completion or bypass the governor.
- Fixed a live cognition close-path ordering defect where the final completion gate was referenced before initialization, which could silently skip reasoning/strategy/outcome persistence.
- Added regression evidence for persisted recent outcomes, conservative confidence bounds, and final-outcome recording.
- Security implementation was not modified in this phase.

## 122.2.0 — verification/evidence + semantic goal hardening

- Added structured Verification Evidence Engine with requirement binding, provenance, staleness, scope, and coverage.
- Added semantic goal/constraint drift detection; dropped constraints are explicit evidence, not silently discarded.
- Added deterministic Brier/ECE prediction calibration metrics.
- Existing security adapters remain unchanged; production security mode remains fail-closed ON.

## 122.1.1 — development security-mode hardening

- Added an explicit development/test `tools.securityMode` / `FORGE_SECURITY_MODE` switch. `off` is accepted only outside `NODE_ENV=production`; production is fail-closed to security ON.
- Wired the mode into content fencing, secret redaction, and network URL enforcement without changing secure filesystem write mechanics.
- Added regression coverage for production fail-closed behavior and explicit development/test mode.

## 122.1.0 — alpha-grade integration hardening

- Added `intelligence-benchmark.js`, a deterministic provider-free integration benchmark exercising the real cognitive state, evidence graph, learning loop, persistence, goal-drift detection, and stuck detection together. It explicitly does **not** claim live-model coding success.
- Added `forge intelligence` / `forge intelligence --json` for the benchmark report; live provider capability remains measured only by `forge eval`.
- Extended Alpha Intelligence with objective fingerprints and bounded goal-drift detection; repeated empty observations no longer create false stuck signals.
- Tightened failure classification for ordinary `N tests failed` evidence.
- Preserved package/version at 122.1.0 and all existing authorities; these changes are additive.

# forge — CHANGELOG

## 122.1.0 — alpha-core intelligence expansion

Additive cognitive upgrade over 122.1.0. Adds a bounded Alpha Intelligence layer for measured plan selection, uncertainty-aware prediction, failure classification, causal attribution, counterfactual impact notes, drift/stuck detection, and persistent strategy learning. It is wired into the live cognition path but never replaces the existing governor, planner, verification, completion, recovery, skills, tools, routing, memory, or terminal authorities.

The adaptive layer only changes strategy ordering when its signal is materially separated; insufficient evidence leaves the established ranking untouched. Learning is persisted per project/class and never manufactures completion.

## 122.1.0 — alpha-core outcome learning

Additive core upgrade: measured same-project strategy outcomes can refine future strategy ordering only after sufficient evidence and a meaningful advantage; learning records preserve causal attribution from the existing kernel. Existing governor, verification, completion, skills, tools, routing, recovery and terminal behavior remain authoritative.

One version, one place: the version lives ONLY in `package.json`; `version.js`
reads it at runtime and every user-agent is built from that single source.
Historical entries below are kept honest and short; completed plans are not
preserved — leftovers live in TODO.md.

## 122.0.1 — release-hardening

Release-hardening patch over 122.0.0: version metadata/tests are synchronized and the worker-timeout regression suite no longer keeps a deliberately orphaned timer alive for 9 seconds. No agent behavior is intentionally changed.

## 122.0.0 — yolowise (full control is one switch, and it is inspectable)


CLI only. No Web OS. No SafetyManager. The owner's decision, recorded once.

v88 removed the shell guards and v87 defaulted `autoApprove` ON, so "all guards
off" was already the shipped posture — and work still got refused. Four layers
the switch never reached were doing the refusing, and a fifth (the prompt) made
the model refuse on the owner's behalf:

- **the governor's authority** (v101) froze or hid every write tool on
  INSPECT/SEARCH/PLAN/REPAIR-adjacent actions and turned ASK into
  WAITING_FOR_USER. Its `enforce` flag existed; nothing outside `governor.js`
  ever set it. `authorityFor(action, { klass, enforce })` now takes the owner's
  state: under YOLO the action, the depth, the directive and the
  `GOVERNOR_ACTION` event all survive, `forbidden`/`keep` are empty,
  `maskToolDefs` offers the full tool set, `enforceToolCall` never refuses, and
  ASK no longer waits. STOP still ends the run — closing a verified run is not
  a veto. `createCognition({ governorEnforce })` carries it to both the
  one-shot agent and `runMeta`, which had been building its own cognition with
  no idea who was in charge.
- **the pre-edit critique** (v112) made a path that merely *looks* secret-bearing
  (`SECRET_HINT` matches a file named `token.ts`) pause the whole run, and a
  third edit to one file a refusal. `critiqueVerdict(c, { klass, enforce })`
  keeps every concern as a note and drops the block; `agent.js` cannot pause on
  a critique ASK when enforcement is off. The checklist itself is never
  disabled by YOLO — the sentence is the useful part.
- **read-only workers** (verifier / reviewer / planner) had to match a
  12-prefix bash allowlist, so `pytest -q tests/test_auth.py`, `make lint`,
  `./check.sh`, `vendor/bin/phpunit` were refused mid-verification while `cat`
  of any file was allowed. `isVerificationGradeBash()` answers the same question
  structurally — no write redirection, classification ≤ `low`, no mutating
  program, no mutating git subcommand, every operand inside the project or
  scratch — which is *stricter* where the list was blind (`git commit`,
  `cp a ~/b`) and correct where it was merely small. The role itself is
  untouched: `write_file`/`edit_file`/`memory`/`todo` stay refused for a
  read-only agent, because "verification cannot change the artifact it
  verifies" is the verification contract, not a permission.
- **the capability router** (v105) withheld mutating MCP on INSPECT/VERIFY and
  froze all externals on ASK/WAIT/STOP — permission rules wearing a routing
  costume, since the model is never told the tool exists. `applyRoutePolicy` /
  `selectForTurn` take `enforce`; under YOLO the action-keyed drops stop while
  every quality gate (stale, measured UNRELIABLE/BROKEN, klass budget,
  native-already-covers) keeps working.
- **the system prompt** still said "catastrophic commands, writes outside the
  project, sudo and publishes are blocked — refine the command instead of
  asking the user to disable safety", four releases after v88 stopped blocking
  them. That is the one guard no config key can turn off: the model believes it
  and never tries. Both prompts (agent + chat) now branch on the same resolved
  state, and the stale `fetch_url`/`read_image` descriptions that claimed a
  protection the code no longer has were corrected.

`yolo.js` is the single resolution (`tools.yolo` ⇒ unrestricted, autoApprove,
assumeYes, sudo, outside-project, traversal, interpreter-eval, network upload,
new plugins, private URLs, no risk ceiling, governor+critique advisory), read
from `agent.js`, `chat.js`, `meta.js`, `toolintel.js` and `tools.js` — never
re-derived per file, and read LIVE in the two places a session can change it
(`/yolo` mid-chat no longer needs a restart to drop the ceiling).

Surface: **`forge yolo [on|off|status]`** — the status table names each layer
and its state, the grants implied, and the **five rails YOLO deliberately never
turns off** (project-config privilege strip, tool-result injection fence, secret
redaction, atomic/TOCTOU-safe writes, socket pinning) with the reason for each,
plus a second block, **kept for correctness, not permission** — a read-only
worker's write refusal and the v118/v119 completion gate. Listing them separately
is the point: `all safety off` must never be silently readable as `a result no
longer has to be true`.
Those are defences against *other people's code*, not friction for the owner: a
cloned repository must never be able to arm the agent that runs on the machine
that cloned it, so `tools.yolo`, `governor.*` and `critique.*` are privileged
keys (`sanitizeProjectConfig` strips them and says so). `--yolo` forces it for
one process; **`--safe`** is the opposite; `FORGE_YOLO=0|1` for the shell;
`FORGE_GOVERNOR=1` / `FORGE_CRITIQUE_ENFORCE=1` pin exactly one layer;
`governor.enforce` / `critique.enforce` accept `auto|always|never` so structure
can be kept without keeping the vetoes. `/status` in chat replaced its single
"NO GUARDS (v88 noguard)" line with the same per-layer truth, since that line
was the part of the UI that was wrong.

FORGE-BENCH unchanged at 24/24. `tests/test-v122.mjs` (158 assertions, 10
sections: resolution, governor authority, cognition wiring, critique, read-only
roles, router, who may arm it, the real exec path, the prompts, the CLI) joins
the run; three v85/v25/v27 source-grep pins that asserted the OLD shape of the
unrestricted implication were rewritten to assert the property — plus a new
behavioural section proving the implication is behaviour, not a grep.

Landing on top of v118–v121 changed two things about this release, and both are
reported rather than smoothed over. It was numbered **v117** while it was being
built; main had already spent v117 on searchwise and shipped through v121, so the
number moved and the suite is `test-v122.mjs` (the name collision was the
discovery — a per-release suite name is a shared namespace, and only a test run
across the real merge proves the two do not fight). And v118's completion work
made `cognition.enforce(gov)` a second path into `authorityFor`: that call is
threaded through the same `governorEnforce`, so a completion candidate that moves
the authority cannot re-arm a veto YOLO already removed. The gate itself is
untouched on purpose — it refuses a *claim*, never a command — and the run report
now says so: `authorityFor`'s enforced branch returns `enforce: true`, which v118
began surfacing in `GOVERNOR_ACTION`, the run's `governor:` field and the
AUTHORITY prompt line, where it had been reading `false` since the day it was
added because no branch ever set the key.

The third finding is the one that made a check go RED, and it was not this
release's code: Actions runs the `push` copy and the `pull_request` copy of the
same commit at the same time, and `test-v93r`'s health assertion slept a FIXED
2500ms and then read the OS socket table exactly once. `npm run dev` does not
own the socket — npm boots, node boots, the grandchild binds — so under doubled
load the port simply was not there yet at 2500ms, `health` said "no port
detected", and the sibling run of the identical SHA was green. A test that
depends on wall-clock luck is not a test. The sleep became a deadline, and the
root cause got fixed where it lives: `health()` (and `claim`, which shares it)
now waits a BOUNDED `HEALTH_DETECT_GRACE_MS` for a launched process to OPEN its
port — `grace_ms` is exposed on the `runtime` tool so a slow Vite app is a
parameter and not a false "not healthy" — while a boot that has already exited
fails at once with its exit code as the diagnosis, so the wait is never paid for
a crash. What no amount of waiting can do is turn a missing listener into a
pass; the refusal keeps its wording and gains the reason. v93r grew 54 → 72
assertions, including the proof that the wait happened, that it is bounded, that
it is switchable off, and that eight concurrent copies of the suite pass under
14-way load (they did not before).

## 113.0.0 — githubwise (GitHub is evidence)

CLI only. No forge-held GitHub token. No GitHubManager.

```
gh inspect (issues / PRs / checks / runs / repo)
        ↓
   Evidence (contract.noteEvidence)
        ↓
   Governor INSPECT / SEARCH
```

Writes (commit / push / `gh pr create`) stay in gitship: opt-in, consent-gated.

- one read-only `github` tool (allowlisted `gh` argv)
- knowledge-gap acquire prefers gh before the web when the task is GitHub/CI
- MICRO does not fetch GitHub
- shell-injection ids refused

## 112.0.0 — criticwise (doomed mutations do not run)


CLI only. No Web OS. No CritiqueManager.

`preMutationCritique` already existed and was advisory-only. The default
agent still executed missing-file edits, secret-path writes, and edit-thrash.

- missing edit target → BLOCK before exec
- same file mutated ≥ 3 times → REPLAN (no 4th patch)
- secret-bearing path → ASK (WAITING_FOR_USER)
- hub file → VERIFY (advisory, write still allowed)
- MICRO stays one-shot (advisory, not blocked)
- `FORGE_CRITIQUE=0` still disables the checklist

## 111.0.0 — jointwise (one route: depth + model + skill)


CLI only. No Web OS. The LLM is an instrument. No JointManager.

The leftover gap after v110: governor, metalearn, modelstrategy, and caplearn
picked independently, so a cheap-failing combo could still be assembled.

- `scoreRoute` composes the three pickers, then prefers a measured-better combo
- MICRO / `FORGE_LOCK_MODEL` / named skill still win
- live agent may switch model only when joint evidence says so
- cognition uses joint depth on the next similar task

## 110.0.0 — modelwise (measured-best model actually runs)


CLI only. No Web OS. The LLM is an instrument.

What was forgotten: `selectModel` / performance history already existed, but
the default agent never called them (modelstrategy imported agent → cycle).
Unrecognized custom model ids were also pinned forever, so history could not
switch.

- modelstrategy imports classify.js, not agent.js
- `applyModelChoice` on the live path (LARGE/SMALL)
- MICRO and `FORGE_LOCK_MODEL=1` keep the caller's model
- measured margin ≥ 3 can switch even for unregistered ids
- outcomes recorded into the existing modelstrategy ledger on close

## 109.0.0 — metawise (reasoning depth is learned)


CLI only. No Web OS. The LLM is an instrument. No second brain.

v106 learned which skill to use. v109 learns how HARD to think:

- record (klass, depth, ok) on cognition.close
- next similar task uses cheaper depth when success is equal
- LARGE cheap-depth failure keeps the deeper governor default
- MICRO never learns extra depth
- env drift (existing envfingerprint) discounts old cheap-depth stats
- ASK/STOP/PLAN authority unchanged
- strategy outcomes rank future PLAN lists (failed strategy is not preferred)
- env drift option discounts learned cheap depth
- retired lessons (confidence ≤ 0.15) no longer retrieve into default routing
- metalearn.json is project-local and survives restart

Not implemented (already exist or not this layer): lesson store, calibration
ledger, capability routing, 20 new event types, counterfactual replay UI.

## 108.0.0 — performwise (layers that planned now run)


CLI only. No Web OS. The LLM is an instrument.

What was forgotten: SEARCH, created tools, and model empirics *existed* but
did not perform.

- governor SEARCH runs `runAcquire` (local grep/glob/read/skill) once
- web is never auto-fetched; acquire is read-only
- after acquire, SEARCH does not fire again
- created tools search the tree; they no longer echo "designed for"
- failover chain is ranked by recorded model empirics (user's chosen model stays)

## 107.0.0 — createwise (gap → verified tool → future route)


CLI only. No Web OS. The LLM is an instrument.

v106 learned which existing capability to use. v107 extends that:

- a *repeated* capability gap (not a single miss) may design/implement/verify
  a project-local tool via the existing toolcreate pipeline
- only VERIFIED tools activate; CANDIDATE never reaches the agent
- MICRO/SMALL never create
- an ACTIVE created tool is reused, not duplicated
- created tools join `selectForTurn` and caplearn (kind: `created`)
- if X then fails on LARGE, the next LARGE turn withholds X
- no ToolManager, no co-router, no RFC crawler, no provenance UI

## 106.0.0 — capabilitywise (measured routing + free knowledge VOI)


CLI only. No Web OS. The LLM is an instrument.

v105 routed catalogs. v106 makes routing LEARN:

- `caplearn.js` records skill/MCP outcomes per task class (conditional
  reputation — strong for A, broken for B)
- UNRELIABLE/BROKEN capabilities are withheld on the next similar turn
  unless the user named them. That is the acceptance test: behavior change.
- Credit assignment from real `load_skill` / `mcp__*` records, not from
  "something failed somewhere"
- Knowledge gaps (existing knowgap engine) feed governor SEARCH — cheapest
  acquire (skill/repo) before a patch; the web is last and never auto-fetched
- Cognition prompt shows measured capability health
- Native / models stay in toolintel / empirics; this does not duplicate them

## 105.0.0 — routewise (smart skill + MCP routing)


CLI only. No Web OS. The LLM is an instrument.

107 bundled skills and a curated 100-server MCP catalog already existed.
Dumping them into every prompt is not intelligence. v105 is the router:

- klass budgets: MICRO/SMALL auto-inject nothing unless named
- quality gate: CANDIDATE skills are not auto-injected; stale playbooks
  are withheld by the turn router unless named
- INSPECT/VERIFY withhold mutating MCP; read-only MCP may stay via allow
- capability gaps recommend `forge mcp add` / `forge skill download` —
  never auto-install, never auto-connect
- load_skill stays available under INSPECT (skills are how the list is used)
- first-party tags for api-design, data-migration, code-reviewer, experiment-suite

## 104.0.0 — bindwise (wire the gaps, close the blind spots)


CLI only. No Web OS. The LLM is an instrument.

v103 learned. Several engines still sat idle on the default path, and one
heuristic silently treated `echo ok` as verification.

v104 binds what already existed:

- `isCoveringCheck` — a covering check is a real test/lint command that
  passed. `echo ok` / `ls` / a body containing the word "pass" is not
  verification. The live `observeTools` path uses this, not a regex.
- VOI experiments are recorded on the omega infogain ledger when a
  bash/test result lands, so the same experiment is not re-picked forever.
- PLAN ranks competing strategies (intent hypotheses, or smallest-reversible
  vs broader) instead of leaving the strategy list empty.
- World-model `testsFor` fills `expectedTests` on a live prediction;
  `invalidate` runs on every successful write so the world cannot stay stale.
- Dead `predictionCalibration` import removed (the prompt already used
  `predictionsForPrompt`).

## 103.0.0 — learnwise (self-model + intent invalidation + VOI)


CLI only. No Web OS. The LLM is an instrument.

v102 predicted and calibrated. The system still did not know itself, still
treated a changed instruction as a new original, and still patched before
the cheapest discriminating experiment.

v103:

- `selfmodel.js` — measured strengths/weaknesses from the prediction ledger
  and model empirics. Insufficient evidence is said out loud. Never a
  personality. Never auto-switches models.
- `absorbInstruction` — a changed instruction becomes v2 discovery; v1
  wording stays frozen; the prior plan is invalidated; a CONFLICT gap is
  recorded. Resume with a new objective uses this path.
- VOI — omega's information-gain catalog now feeds the governor: a
  discriminate experiment is TEST, an inspect experiment is INSPECT, not
  another identical patch.
- Default `forge agent` emits `SELF_MODEL` (calibrated, weaknesses,
  recommend, autoSwitch=false).
- Prompt carries SELF-MODEL + VOI EXPERIMENT on the live path.

## 102.0.0 — intelwise (prediction-calibrated intelligence)


CLI only. No Web OS. The LLM is an instrument.

v101 made the governor the authority. It still chose VERIFY/REPLAN with no
expected observation — so it could not tell a miss from a hit. `prediction.js`
already predicted DAG nodes for `--auto`. Default `forge agent` never opened
a prediction, never settled one, never recorded model empirics.

v102 closes the loop on the live path:

- `predictForAction` — deterministic prediction from intent/reads/scope,
  never from the model's self-reported confidence
- every EXECUTE/REPAIR on default `forge agent` opens a prediction
- settlement against actual writes emits `PREDICTION_SETTLED`
- file drift MISS → governor REPLAN (bounded, never MICRO)
- SCOPE drift → VERIFY before more writes
- objective-only predictions are UNSCORED (honest: "no files named" is not
  "I predicted zero files")
- competing strategies ranked by expected value (reversible + cheap first)
- cheapest-first capability router in the live prompt (native → skill → MCP
  → generated → model)
- default agent records `empirics` (model-outcomes.json) like meta already did
- calibration from the real ledger is injected when samples suffice

Not a rewrite. prediction.js, empirics.js, capfabric.js, omega stay the
engines they were. They now share the contract on the path everything uses.

## 101.0.0 — authoritywise (governor is the authority)


CLI only. No Web OS. The LLM is an instrument.

v100 put a cognitive core on the default `forge agent` path. The governor
chose INSPECT / VERIFY / ASK / STOP — and the loop ignored it. The model
still picked every tool. ASK emitted an event. VERIFY was a comment.
STOP never stopped.

v101 enforces the action:

- ASK / WAIT freeze the run as `WAITING_FOR_USER` (decisionengine.ask,
  no silent goal substitution)
- STOP ends the loop — but only after real verified work; a run that has
  not started is never halted
- VERIFY / INSPECT / PLAN / REPLAN on MEDIUM+ hide write tools and
  BLOCK a forbidden call (`TOOL_BLOCKED`) even if the model ignores the mask
- MICRO / SMALL keep mutation available (existing one-shot paths and the
  verify-nudge stay honest); ASK / STOP still always halt
- every step injects `(governor) GOVERNOR: ACTION [depth] — why` into the
  model request, replacing the previous governor turn so context does not grow
- `cognition.enforce()` / `authorityFor()` / `maskToolDefs()` /
  `enforceToolCall()` are the authority surface; agent.js is the live path

Not a rewrite. Omega, world model, verifyledger, completion, engmemory stay
the engines they were. The governor is no longer a narrator.

## 100.0.0 — cognitionwise (unified cognitive core)

CLI only. No Web OS. The LLM is an instrument.

Default `forge agent` used to skip the kernel entirely — the model picked
every tool, omega lived only on `--auto`, and `core.nextBestAction` was a
read-only view. v100 puts ONE cognitive core on the live path:

- `usermodel.js` — explicit vs inferred, competing intent hypotheses,
  preference provenance + decay, structured feedback, negative knowledge,
  decision authority, attention economics (ask only when inspect cannot)
- `contract.js` — versioned intent (v1 frozen), requirements that refuse
  ASSUMPTION→REQUIREMENT, gap analysis, IMPLEMENTED ≠ VERIFIED ≠ CLOSED
- `governor.js` — chooses THINK/INSPECT/…/ASK/STOP from that state
  (VOI-directed; MICRO stays L1; looping forces REPLAN)
- `cognition.js` — composes those with the existing omega kernel
  (hypothesis/evidence/causal/infogain). Persist `cognition.json`.
- `forge cognition` — inspect the core without a model
- `agent.js` loads cognition on the DEFAULT path (sub-agents stay executors)
- `meta.js` uses `createCognition` instead of a second kernel; DAG node
  objectives actually reach the segment task

Not a rewrite. Omega, world model, verifyledger, completion, engmemory,
prediction stay the engines they were. They now share a contract.

## 99.0.0 — loopwise (the agency release)

- Expanded the offline MCP catalog from 12 hand-written presets to a generated,
  pinned top 100 sourced from active official MCP Registry records and GitHub
  repository health metadata. GitHub's maintained hosted MCP server and MCP ECC
  are explicit inclusions. Catalog search/filtering, `forge mcp info`,
  transport-aware list/test output, and environment-referenced credentials keep
  discovery useful without writing token values into Forge config.

The user-facing verdict on v98 was blunt: the agent STOPS too soon (~25
steps), nothing reviews the code it writes, repairs fly blind, plans are
never questioned, and reaching the wider skill/MCP ecosystem is manual.
v99 answers each in the house way — strengthen existing loops, never
rewrite, every behavior pinned.

- THE STOP FIX: the direct one-shot agent now auto-extends its step AND
  tool-call budgets while PRODUCTIVE (fresh successful writes, passing
  verification checks, or ≥4 distinct tool signatures in the last 10
  steps — and never with a 4× signature loop or a 6-error streak), in
  increments bounded by the same hard caps (1000 steps / 500 calls).
  Each extension emits `step_budget_extended` with its evidence; a
  stalled run still stops honestly (INCOMPLETE + checkpoint + resume) and
  budget exhaustion still never completes (§5). Segment callers
  (maxStepsOverride) are untouched — meta's segment table instead DOUBLES
  (MEDIUM 22→40, LARGE 32→60, ARCHITECTURAL 40→88, RECOVERY 20→30,
  MICRO 8→14, SMALL 14→24, fallback 24→40, cap 64→128; shrink factors
  and floor unchanged).
- THE REVIEWER: codereview.js — after a clean mutating segment, ONE
  bounded read-only review of the actual change: working diff vs HEAD
  (per-file caps, working-tree truth — never the index), the gate's LSP
  diagnostics REUSED (one spawn serves both), failing ledger evidence,
  secret + debugger + TODO + mega-edit smells on ADDED lines.
  Deterministic findings stand alone; a reviewer agent pass adds
  strict-JSON findings (honest parse: garbage never invents); blockers
  become required actions; `CODE_REVIEW_*` events persist; cost bounded
  by `review.maxPerTask` (default 4). Also fixes the v94 latent deadlock:
  required actions were add-only until whole-gate success — recurring
  prefixes (review:/requirement /codereview:/critical-risk runtime
  validation:) are now dropped and re-derived on every completion
  attempt.
- THE FIXER: repairSegment gets a structured DEFECT REPORT (live LSP
  diagnostics on changed files, the last 5 failing verification records,
  the read-only verifier's report — requestVerification now RETURNS it
  instead of discarding) and a deterministic fast path (autofix.js): a
  lint/format-shaped failure runs the project's OWN formatter once —
  allowlisted direct invocations only (no `npm run`), shellguard "safe"
  classified, 90s bound, result recorded as ledger evidence; the LLM
  repair runs only when the failure is not mechanical or the fix failed.
- THE PLANNER: plancritique.js — deterministic plan-QUALITY gate
  (coverage vs the objective's own terms, blob-node detection,
  verification-step presence for mutating plans, read-only balance,
  blind-first-step) plus ONE bounded revision pass when majors exist;
  the revision is adopted only if it re-validates (with the same
  structural repair the original plan gets) AND beats the original
  critique score. `PLAN_CRITIQUE` / `PLAN_REVISED` /
  `PLAN_REVISION_REJECTED` events; fast-path synthesized plans exempt.
- REACH: mcpcatalog.js — 12 curated well-known MCP servers
  (filesystem, memory, sequential-thinking, git, sqlite, postgres,
  playwright, puppeteer, brave-search, github, context7, fetch) with
  `forge mcp add/catalog/remove`: presets write the USER config through
  the same path `forge config set` uses (the privileged mcp section has
  exactly one sanctioned write path), required env vars become explicit
  empty placeholders with the exact fill command printed — secrets are
  never invented, prompted for, or stored by the catalog. skillregistry.js
  — curated best GitHub skill repos (obra/superpowers, anthropics/skills,
  Egonex-AI/Understand-Anything, zai-org/GLM-Skills) with raw SKILL.md
  URLs ready for the existing SSRF-guarded download path, `forge skill
  search` (local index, deterministic scoring) and `forge skill
  recommend` (stemmed matching). 4 new bundled skills: code-reviewer,
  perf-tuning, api-design, data-migration (106 total).
- DELIVERY: gitship.pr = "gh" opens real pull requests through the
  user's OWN gh CLI — passthrough, not an API client: forge never holds
  a GitHub token; requires explicit config + live consent (like push) +
  the commit actually pushed + gh authenticated; the PR body IS the
  PR-ready artifact; "PR already exists" is reported, never fatal to the
  delivery.
- PROOF: FORGE-BENCH 22→24 (+23-step-extension, +24-reviewer-fixer-
  planner); new suite tests/test-v99.mjs (95 assertions, 9 sections:
  raised table, real-loop extension/loop/kill-switch/override behavior,
  reviewer units + meta wiring, planner gate behavior, autofix gating,
  catalog/registry integrity, gitship pr honesty, source pins for the
  deadlock fix). 165 fast suites green; e2e/cleanroom pins updated.

## 98.0.0 — shipwise (the delivery release)

The competitive gap analysis (Forge vs Claude Code / Devin / Cursor / Codex /
OpenHands) named three existential deficits — regex-only language
intelligence, no git delivery, no injection defense — plus two v97 TODO
leftovers (artifact verification, visual regression) and one scale problem
(synchronous walking). v98 closes all six in the house way: nothing
rewritten, every fix wired into the existing systems, every behavior pinned
by a test.

- STRUCTURED EXTRACTION WIRED (the #1 gap since v93): langstruct.js — ONE
  LSP session per server (user config + the autostart table), bounded fan-out
  (time budget, file cap, concurrency), honest per-file fallbacks (server
  failure / zero symbols keep the lexical record and say so). Enriched
  records carry `symbolDetails: [{name, kind, line}]` + `extraction:
  {layer: 3, source: "lsp:<server>"}` and are written into the SHARED
  incremental index; the world model serves them to every consumer (repo
  map, locate, impact, knowgraph). The wiring is honest about cache
  semantics: enriched records are fingerprint-stamped at read time, and
  extractOne now reuses fresh index records (the same cacheHit law as
  walkIndexed) so a rebuild SERVES the structured record instead of
  overwriting it with a lexical re-extraction. INDEX_VERSION bumps 1→2 once
  (one-time re-extraction per project); memgraph's cycle-avoiding INDEX_VER
  copy moves in lockstep (the bump caught it drifting — compose/world
  lessons silently read empty until it was fixed).
- NATIVE JSON TIER (layer 1, the first above-regex production parse):
  .json records get JSON.parse with top-level keys as symbols; invalid JSON
  is reported as a failed native parse, never an empty success.
- VERIFIED GIT DELIVERY (gitship.js — kernel policy, never a tool; the wire
  stays 1:1): after the 9-check completion gate says ok, maybeShip() commits
  ONLY the run's verified files (explicit pathspec, never -A; .forge/**
  never ships; foreign dirty files are named and never staged), with
  forge trailers (Forge-Task-Id / Forge-Run) for crash reconciliation and
  an honest nothing-to-commit skip when the files already match HEAD.
  Identity: repo config wins, else per-invocation `forge-agent <forge@local>`
  (repo/global config NEVER written). branch:"auto" BOOKMARKS forge/<task>
  at the delivery commit (git branch — the user's checkout is never
  switched). push:"explicit" requires a live AUTHORIZATION ask; force is
  structurally absent from the arg arrays. A PR-ready text artifact is
  rendered from gate/ledger data (no remote API, no token trust). All OFF
  by default; `gitship` is a PRIVILEGED config section so a checked-in
  project config can never turn delivery on for everyone who clones. A
  delivery failure NEVER flips the task status — pre-v98 behavior (verified
  files in the working tree) is exactly the fallback. Events: GITSHIP_MODE/
  SKIPPED/COMMITTED (persisted to events.jsonl).
- PROMPT-INJECTION DEFENSE (contentfence.js, G4): every tool result enters
  the conversation through ONE constant attribution fence (header-only —
  the v20.0.1 exit-marker law is pinned by test), with an ADVISORY marker
  scan (instruction-override, role spoofing, identity rewrite, exfiltration
  prompt, policy disarm — surfaced in the header, never fatal). The shared
  data-not-instructions rule rides BOTH system prompts (agent RULES 8 +
  chat). `tools.contentFence` is a privileged key — a project config
  cannot strip the fence.
- WORLD MODEL AT SCALE (the TODO leftover): the documented 0/"unlimited" =
  NO CAP was UNREACHABLE (the resolver's !isFinite guard destroyed
  Infinity and silently fell back to 2000 — verified, fixed, pinned).
  extractOne batches index writes (one load + one save per incremental
  pass — was a quadratic N×N fsync amplification). expand()/locate()
  reuse their completed walk (the 3-walk chain became 1). buildAsync():
  the stat walk runs CHUNKED (cooperative setImmediate yields), in-flight
  callers share ONE promise (the fastwise warm-memo law), and a short
  async-fresh window collapses the per-query drift walks — invalidate()
  closes it immediately so mutations are never masked. The pure-sync
  surface (every existing test) keeps per-call drift semantics untouched.
- CONTRACT_DRIFT BEFORE-CAPTURE FIX (a real v97 bug): the §21 "pre-mutation"
  contracts were captured through the world getter, which REBUILDS and
  re-extracts from disk — so "before" was actually AFTER and drift could
  never fire. worldmodel.persistedRecords() reads the LAST RECORDED TRUTH
  from the persisted snapshot (no walk, no re-extraction), which is what
  the comment always claimed.
- ARTIFACT EVIDENCE (the TODO leftover): runtimesession.artifactRuntimeEvidence()
  observes what a build ACTUALLY produced in the conventional output
  locations for the matched adapter (dist/, build/, app/build/outputs/,
  target/ …) — bounded, read-only, never invented (no adapter → not
  applicable). Observed artifacts become VTYPE.ARTIFACT ledger records
  with positive evidence; their absence at critical risk (where
  verificationPlanForRisk has ALWAYS declared runtimeValidation that
  nothing enforced) is now a required action the gate refuses to complete
  over — the declared-then-ignored flag is enforced.
- BROWSER VISUAL REGRESSION (the TODO leftover): `browser visual_diff
  {name}` — first run CREATES the baseline (snapshot text + screenshot
  sha256) in the project state dir; later runs COMPARE (unifiedDiff of the
  canonical node text + pixel-exact hash verdict) with §42-style evidence
  phrasing (MATCH = positive evidence, DIFF = evidence AGAINST, re-baseline
  only via update:true). CDP screenshots gain captureBeyondViewport
  (full-page). visual_diff is a verification action (verifier agents may
  use it; page-mutating actions stay blocked).
- AGENT LSP TOOL GATE: the read-only LSP tools (definition/references/
  hover/diagnostics) now light up on the AUTOSTART table too — the last
  surface still gated on user config alone, matching what layer 3 reports.
- Tests: tests/test-v98.mjs (95 assertions, 7 sections) +
  tests/test-gitship.mjs (39 assertions, 9 sections) registered in
  run-all; FORGE-BENCH grows to 22 cases (+21-artifact-evidence,
  +22-injection-fence), 22/22 green. Version pins updated across the
  suites (131 test pins + e2e + cleanroom).

## 97.0.0 — unifiedwise (the one-brain release)

FORGE ∞ v97 FINAL UNIFIED ENGINEERING INTELLIGENCE UPGRADE, implemented in
the directive's own phase order (inspect first; no engine rewritten — new
modules where nothing existed, wiring where things were disconnected):

- §4 LOCAL-FIRST SOURCE RESOLUTION (non-negotiable): sourceresolve.js — the
  resolution ladder (explicit file → folder → local ZIP → https URL → git
  repo → workspace; remote search NEVER happens implicitly). ZIP-as-project
  is real: inspect (root/manifests/languages/tests/git metadata) → safe
  extraction (zip-slip guarded, CRC-checked, capped) → operate on the LOCAL
  project. Source records persist (sourceType/sourceId/origin/authority/
  reason/evidence/history) under the project dir; an explicit local archive
  WINS over a git cwd and the conflict is recorded; unresolvable inputs are
  refused, never guessed. CLI: `forge source`, `--source` on agent/chat/ask.
- §3 CANONICAL ENGINEERING STATE: core.engineeringState() — one read-only
  aggregate over the existing stores (identity, source, goal, work/DAG,
  verification, blockers, knowledge, resources, next-best-action). No second
  truth, no private copies.
- §5-§8 SESSION CONTINUITY: raw conversation transcripts (per-turn
  <id>.transcript.jsonl with ts/role/content/sessionId/projectId/classes —
  compaction folds the working context but NEVER destroys history anymore);
  per-message user classification (goal/requirement/correction/decision/
  preference/…, msgclass.js); AUTOMATIC rehydration — a normal `forge chat`
  in a directory with a recent session reattaches without --continue
  (chat.autoRehydrate:false or --new to opt out); §8 reconstruction with
  reality reconciliation (files that vanished are reported stale) in
  rehydrate.js.
- §15 WORLD MODEL CEILING REMOVED: the cap is a CONFIGURABLE BUDGET
  (FORGE_WORLD_MAX_FILES / world.maxFiles; 0 = unlimited), indexing is
  PRIORITIZED (manifests → entry points → src → rest → tests — never readdir
  luck), the stat walk always completes (stats.totalScanned), expand() pages
  in more on demand, and a locate() miss against a truncated world
  auto-expands once — a huge repo takes longer, never becomes invisible.
  semantic search follows the same budget.
- §26 COMPETING HYPOTHESES: a hard failure creates a belief DISTRIBUTION
  (diagnosis 0.5 / structural causal candidate 0.3 / environment-or-tooling
  0.2 when origin is unknown) — never one guess; hypothesisDistribution()
  exposes the normalized ranked set.
- §29 PREDICTIONS EXTENDED: expectedTests + expectedSteps declared up front,
  settled against reality (testsDelta/stepsDelta), calibration reports
  testBias/stepBias and the planner prompt names them.
- §33 UNIFIED CAPABILITY LADDER: one resolver across native tools → skills →
  MCP inventory → created tools (ACTIVE+verified only), with honest GAPS.
  Wired into the agent system prompt (gap line) and `forge caps <capability>`.
  §35: the created-tool lifecycle is CLI-reachable (`forge tool
  life|create|activate|deactivate`) — unverified tools still NEVER activate.
- §21 CONTRACT DRIFT: after a mutating segment, removed producers (renamed
  routes/tables/protos) and orphaned consumers are detected against the
  pre-mutation world and emitted as CONTRACT_DRIFT evidence.
- §41 RUNTIME LIFECYCLE: runtime `up` — (build) → launch → WAIT-READY
  (bounded health polling with backoff; readiness is EARNED by a probe) →
  verdict with per-stage evidence; a process that dies while waiting fails
  fast with the process evidence.
- §42 UI VERIFICATION EVIDENCE: the browser captures console errors, page-log
  errors and failed network loads (CDP Runtime.consoleAPICalled, Log.
  entryAdded, Network.loadingFailed); new `errors` action surfaces them — a
  rendering page with errors is NOT verified.
- §56/§88 TASK REPLAY: replay.js + `forge replay <run|task>` renders the
  recorded timeline (goal → state → action → decision → evidence → result)
  from the run journal, events ledger and task record — read-only, never a
  reconstructed story. CONTRACT_DRIFT/WORLD_INVALIDATED/ENVIRONMENT_DRIFT
  now persist to events.jsonl.
- §49 ZERO-WASTE: identical CONCURRENT model requests coalesce into ONE
  network call (in-flight only; nothing cached after completion).
- §52 ADAPTIVE PARALLELISM: the worktree writer ceiling is configurable
  (worktree.maxNodes / FORGE_WORKTREE_WRITERS, default 2, cap 8); conflict
  keys and the serialized merge lane are unchanged.
- §86 FORGE-BENCH 20/20: the four missing long-horizon categories added
  (runtime-failure, model-switch, session-rehydration, ZIP/local-source) and
  two new metrics (evidence quality — a runtime failure must yield a
  competing hypothesis set; memory continuity — transcript + classification
  survive, keyed by cwd).
- Tests: test-sourceresolve.mjs (38) + test-v97.mjs (109), all 162 fast
  suites green.

## 96.0.0 — unifywise (the wiring release)

Inspection first: five parallel audits of all ~140 modules found v95 had
implemented nearly everything — what was missing was WIRING. This version
reconnects the disconnected (no engine rewritten, every fix a repair):
engmemory task/conversation relevance bonuses fire; TTY resume goes through
the controller (resumeTaskId was silently dropped in the interactive path);
the Core lifecycle map matches meta's real events and meta emits TASK_RESUMED
+ REPAIR_COMPLETED (every phase recordable); empirics + variant outcomes have
production writers; §24 infogain experiments ride segment-1 context (the
"planner prompt carries it" comment was false); the taskmodel origin ledger is
fed from the plan (the no-assumption-as-requirement review check sees real
data); the completion gate checks requirement coverage (unaddressed
requirements block COMPLETED via required actions); the §30 structured handoff
reaches the reassigned worker; episode stage recorders receive the Ω kernel's
hypotheses/experiments/verifications/failed-approaches (and episodes persist
via securefs); runMany maxParallel is a real gate; conflict resolution
consults the world model (honest existence-claims only); MCP connects lazily
from a per-spec inventory cache (cold cache = the old eager behavior, warm
cache defers the spawn to first call, vanished tools are honest errors);
LSP autostart feeds verification diagnostics on the default path (opt-in
flag, pinned default kept); dag accepts "trivial" risk (one ladder with
plannerisk/verifyledger); external SIGTERM is KILLED not TIMEOUT; dead code
removed (reportConflict import, void fs, formatStrategy, hardShrink twins,
download twins). NEW: envfingerprint.js — the §50 environment fingerprint +
drift layer (advisory ENVIRONMENT_DRIFT with per-signal engineering impact,
FORGE_ENVFP=0 off); core.nextBestAction() — the §24 surface as read-only
introspection (pending decision > terminal next_action > live phase > idle),
in status() for the TUI, NOT a second decider; context budgetOverflow is
reported. Proven by tests/test-unifywise.mjs (72 assertions, 19 sections)
and tests/test-envfingerprint.mjs (27 assertions, 7 sections); 160/160 fast
suites green.

## 95.0.0 — worktreewise (isolated worktree execution for DAG nodes)

The last open KERNEL item of the TODO ledger — "nodes would run in a per-node
git worktree so parallel segments never see each other's partial writes;
design exists, no implementation, no test" — implemented, wired and proven by
the new `tests/test-worktreewise.mjs` (75 assertions, 9 sections, suite
"worktreewise", registered in run-all). No engine was rewritten: the fan-out
gains one dispatch lane, the single-writer discipline is kept per tree, and
every fallback is honest.

- worktree.js (NEW) — the worktree lifecycle over git plumbing (execFile with
  argument arrays, never a shell string): `createWorktree` (detached checkout
  of HEAD under .forge/worktrees/<run>-<node>), `captureChanges` (one
  binary-safe patch via `git add -A -N` + `git diff --binary`, .forge state
  excluded by pathspec so forge's own bookkeeping can never be merged into a
  project), `mergeBack` (CHECKED then applied: plain `--check`, 3-way
  `--check`, then apply — a conflicting patch NEVER half-applies; the
  conflicting files are NAMED; the tree stays untouched), `removeWorktree`
  (force + prune, registry updated to a terminal status so a removed
  worktree can never look live), `sweepOrphans` (crash-resume pattern: a
  worktree whose run AND owning pid are gone is swept at the next task
  start), `planIsolation` (eligibility: mutating, NO dependencies — a
  dependent node builds on shared-tree output a HEAD checkout cannot see —
  DECLARED conflict keys, pairwise disjoint, disjoint from the current
  node's keys, bounded by `worktree.maxNodes`, default 2), and
  `uncommittedFiles` (the shared-tree in-flight guard). Gates: default ON in
  a git repo; `FORGE_WORKTREE=0|false|off` or `config.worktree.enabled=false`
  opts out; non-git and no-HEAD are honest refusals.
- worknode.mjs (NEW) — the child-process worker entry. agent.js binds every
  subsystem to process.cwd(), so an isolated node runs as a CHILD PROCESS
  whose cwd IS its worktree — parallel agents can never chdir-race in one
  process, and the child's writes can only land in its own tree. The spec
  (mode 600 — it carries the provider key) and the result JSON live OUTSIDE
  the worktree so captureChanges never sees them; any non-zero exit means
  NO result — the parent maps that to an honest worker failure, never a
  fabricated completion.
- meta.js — the dispatch lane: after the read-only fan-out, READY MUTATING
  nodes that pass `planIsolation` AND whose declared targets have no
  uncommitted shared-tree changes are dispatched to per-node worktrees
  (role: coder — the one mutating role). They run CONCURRENTLY with the main
  agent (disjoint trees; true parallelism), and the MERGE BACK is serialized
  behind a post-agent barrier: `isoJobs` settle (capture → merge → ledger
  evidence → markCompleted with the merge record → removeWorktree) only
  after the main agent's writes are done and before the segment's
  verification accounting — the main tree has exactly one writer at every
  instant, so a lost update is impossible. Honest failure paths: worker
  failed/timed_out/exhausted → worktree discarded, node FAILED with the
  worker's reason; merge conflict → WORKTREE_CONFLICT event + bus mirror,
  the conflicting files named, the node FAILED, the worktree KEPT for
  inspection; clean worktree with a report → acceptance evidence; nothing
  at all → "outcome unverifiable". Creation failure or an ineligible node
  emits WORKTREE_UNAVAILABLE and stays serialized exactly as before — the
  never-list rule ("never run DAG nodes in a shared tree when they mutate
  the same files") is the reason this exists, not a license to break it.
  Task start sweeps orphaned worktrees from crashed runs
  (WORKTREE_ORPHAN_SWEPT). New events: WORKTREE_MODE, WORKTREE_CREATED,
  WORKTREE_MERGED, WORKTREE_CONFLICT, WORKTREE_FAILED, WORKTREE_REMOVED,
  WORKTREE_UNAVAILABLE, WORKTREE_ORPHAN_SWEPT.
- searchproviders.js — the v94 latent bug the version bump caught: a LOCAL
  `const VERSION = "94.0.0"` shadowed the single source of truth, so the
  search provider's user-agent advertised a stale version on every request
  (proven live by the version-consistency suite's real local HTTP server).
  It now imports VERSION from version.js — the v20.2 one-file rule restored.
- package.json — worktree.js + worknode.mjs added to files[]; version
  95.0.0. Test pins updated with intent preserved (VERSION assertions now
  expect 95.0.0 across the v2x–v9x suites and e2e-forge.sh).

## 94.0.0 — todowise (the TODO ledger, closed with proof)

One strengthening patch per open TODO.md item, each proven by the new
`tests/test-todowise.mjs` (81 assertions, suite #160, registered in
run-all). No engine was rewritten; every fix strengthens the module that
owned the gap:

- runtimesession — PROTOCOL-AWARE health probe: HTTP stays primary (status
  + latency evidence); on HTTP failure a real TCP connect (new
  `tcpConnectProbe`) separates "nothing listening" (ok:false, level
  "none") from "listener confirmed, no HTTP response" (ok:true, level
  "tcp", honest "no HTTP probe available" note). The §11 claim gate, the
  session evidence log and the `runtime` tool rendering are level-aware —
  a TCP/WebSocket service is no longer falsely NOT healthy, and "server
  started" is provable for it (process + listener). healthProbe is now
  async (it awaits the TCP fallback).
- runtime — EVIDENCE-BASED group kill: new `signalGroup`,
  `groupMembersEvidence`, `parsePsMembers` (exported). When kill(-pgid) is
  refused, members are enumerated from /proc (Linux) or a bounded `ps`
  parse (portable) and signaled individually; per-entry `killEvidence`
  records the method; the kill note names the walk. The old fallback
  signaled only the leader and orphaned grandchildren — same fix wired
  into tools.js runBash killTree. createProcessManager accepts a test
  `signalFn` injection.
- sandbox — KERNEL RE-PROBE: new `reprobeKernelSupport()` /
  `kernelProbeCount()`; the first observed bwrap startup failure re-probes
  the overflowuid/overflowgid verdict on the spot (tools.js v87 fallback
  path), so a kernel hardened after forge started stops burning a failed
  bwrap start per command. resetKernelProbe stays as the test affordance.
- checkpoint — WORKING-TREE DRIFT VERIFICATION: write tools seal a
  post-write hash (`sealEdited` — write_file, edit_file, multi_edit,
  apply_patch), and `restoreTransactional` gains a DRIFT phase that
  classifies each file against the manifest's (sha, postSha) pair:
  clean / forge-owned (undo proceeds) / EXTERNAL (kept, status "DRIFT",
  ok:false — unattributable work is never clobbered) / unattributed
  (reverts, drift REPORTED) / missing (recreated). The checkpoint is not
  retired on DRIFT. The legacy restoreOne (`forge undo` / restoreRun)
  gets the same external-work protection.
- codesearch — PERSISTENT SEMANTIC INDEX: chunk docs persist under
  ~/.forge/projects/<hash>/semantic-index.json (atomic write, versioned,
  bounded), fingerprint-validated per file with the house
  `${mtimeMs}:${size}` signature — drift beats the index (changed files
  re-chunk), deleted files are dropped, corruption rebuilds, small corpora
  (< 64 docs) skip persistence by design, FORGE_INDEX=0 opts out of load
  AND save. A fresh process adopts unchanged chunks and pays only the stat
  walk (cross-process, proven with real child processes). The module's
  writes are now only its own cache files under ~/.forge (honesty note
  updated); search results are unchanged — adopted docs feed the SAME
  rankDocs pipeline.
- toolcreate — MULTI-STEP SCRIPTED PROBES: designTool accepts
  `probeSteps: [{args, expectOk?, expectContains?, label?}]` (validated,
  capped at 12), verifyTool accepts an explicit `steps` override. The
  child imports the plugin ONCE and runs the sequence in order — module
  state survives across steps, so login → act tools are finally
  promotion-testable. Per-step evidence (ran/threw/error/matchedSchema/
  expectOk/expectContains/preview), a throwing step aborts the sequence,
  `passed` requires ALL steps green; no script → the classic single-probe
  contract, byte-for-byte.
- lsp — FIRST-PARTY AUTO-START TABLE: ts/js (typescript-language-server),
  python (pyright-langserver | pylsp), go (gopls), rust (rust-analyzer).
  A spec is used ONLY when the binary is actually on PATH (presence
  probed, memoized); user config always wins; `lsp.autostart:false` opts
  out. serverForFile falls back to the table, lspAvailability counts it,
  and extractStructured now runs the structured path by default on
  machines with a real server (proven end-to-end against a stand-in LSP
  over real stdio). Trust model unchanged: forge-shipped commands, never
  model output.
- TODO.md — all seven open items closed (each had exactly the test the
  item demanded); the two policy-gated leftovers (research crawler skill,
  DAG worktree isolation) stay open by their own promotion rules.
- Tests: test-v27 import pin and test-v93r healthProbe call updated for
  the async probe + wider sandbox import (intent unchanged). 157/157 fast
  suites, full suite green.

## 94.0.0 — fastwise (same intelligence, less wasted work)

What changed vs the deepwise build (deepwise made judgment wise; fastwise
makes the same judgment cheap and keeps it honest):

- NEW fastwise.js — ONE shared freshness layer, composed of house
  conventions instead of a second cache subsystem: createFreshMemo
  (fixed-window TTL like searchproviders' cacheGet, injectable `now` for
  deterministic tests, oldest-at eviction, the engmemory/critique
  `${mtimeMs}:${size}` signature as an optional drift check — drift beats
  the TTL, failures are never cached, a rejected pass is forgotten);
  fileFingerprint (the house signature with the "absent" sentinel).
- NEW likely-next prefetch: warmCaches runs ONE idle, deferred, unref'd
  warm pass per project per freshness window (60s TTL, FASTWISE_TTL_MS) —
  persists the world-model snapshot (later createWorldModel instances pay
  only the stat-only drift walk) and warms the semantic chunk cache with
  one bounded offline BM25 pass (embed=null; FORGE_INDEX=0 skips it —
  never fakes, never writes). Guided by likelyNext: plan-frontier file
  paths + knowwise knowledge-graph hubs, read through engmemory's ONE KG
  parser (no second graph implementation; the knowwise KG bootstrap is
  NOT duplicated — meta owns it, fastwise never touches it). Wired in
  meta beside the KG bootstrap timer; emits FASTWISE_WARMED once per
  fresh pass.
- modelstrategy.resolveLane: execution lanes (fast/balanced/deep) from
  signals forge already had — task complexity (classifyTaskComplexity),
  device tier/burst (injected from the resource manager), optional role
  class (crewroute stays the owner) — feeding the EXISTING selectModel
  opts (latencyBudgetMs 12s + costBias low for light tasks, nothing
  artificial for deep work, cost bias on low-tier devices). One strategy
  engine; no new decision path; deterministic.
- modelstrategy performance fix with a freshness contract:
  loadPerformance used to re-read model-performance.json on EVERY call
  (effectiveStats calls it twice per candidate — up to ~24 sync reads in
  one selectModel); now an mtime+size memo that re-reads the moment the
  file actually changes and never serves a stale or corrupt file.
  recordOutcome/clearPerformance behavior unchanged (pins re-verified).
- docs: forge --help documents FORGE_FASTWISE=0; README (root + inner)
  fastwise paragraph; PACKAGE_INFO fastwise bullet; package.json files[]
  += fastwise.js.
- DEDUP AUDIT (new test-fastwise.mjs section): tool names unique (29),
  capabilities 1:1 both directions, 34 catalog names unique, all 58
  aliases unique and disjoint from names, 102 skill dirs with unique
  case-insensitive names, unique frontmatter names, unique SKILL.md
  content hashes, no nested SKILL.md shadowing a top-level dir, chat
  commands unique — zero duplicates found, and now guarded so they cannot
  silently return. Suite count 158 → 159 (86 assertions in the new
  suite); no existing assertion weakened.
- doc repair inherited from deepwise: removed a stray duplicated
  `**v94 "gapwise"**` heading line in both READMEs.

## 94.0.0 — deepwise (judgment before action, continued)

- Plan competition + adoption (plannerisk.alternatives + adoptDecision,
  wired in meta): the ORIGINAL plan now competes as a candidate against
  the inspect-first / incremental-verify / conservative-order shapes on
  expected VERIFIED progress — the same thin-prior options for everyone,
  an apples-to-apples comparison. The winner is reported honestly (it may
  be the original), and when a shape-changing variant wins by >= 0.03
  expected verified progress at equal-or-better risk AND success, the
  planner ADOPTS it: the winner's real node definitions flow into the DAG
  (the read-only guard node becomes executed work, not advice), node
  predictions are re-stamped, and live risk restarts at the adopted
  estimate. conservative-order is excluded from adoption (it drops
  declared dependencies) — advised in plan_whatif, never auto-executed.
  plan_whatif renders the honest verdict ("vs original: ... by +N").
  PLAN_ALTERNATIVES carries adopted/why/successProbability; the
  not-adopted note text is unchanged.
- Pre-mutation self-critique (critique.js + toolintel): a deterministic
  checklist BEFORE a mutating call executes — secret-bearing target paths,
  edit-family targets that do not exist on disk (a certain failure, said
  before the wasted call), same-file edit thrash (>= 3 mutations of one
  file in this run, counted from REAL successful mutations only), and hub
  files (in-degree read from the knowwise floor graph
  .ua/knowledge-graph.json — deepwise reuses knowwise output instead of
  building a second graph; absent/stale/unreadable graph = check silently
  skipped). Advisory only: one TOOL_CRITIQUE event (declared in
  TOOL_EVENTS), one additive record.critique field, one result line in
  the same budget as the blast note (never "created"/"deleted", never an
  [exit code] tail, appended AFTER failure classification so it can never
  influence retry decisions). Off with tools.intelligence:false (exact
  raw pre-v20.5 string preserved — pin parity) or FORGE_CRITIQUE=0.
- Reality-to-risk closure: repairSegment outcomes now move LIVE risk
  (liveRisk.experiment) — the last dead path of the live-risk API; all
  three repair call sites pass the live risk through.
- 158 suites (test-deepwise.mjs: competition determinism, winnerDefs
  structural safety — no node lost, original deps preserved, acyclic,
  guard nodes read-only — the full adoption gate branch coverage, the
  critique engine + wiring + both off-switches + exact-parity, and the
  live-risk closure). package.json files[] ships critique.js.

## 94.0.0 — knowwise (living project knowledge + blast radius + Termux, continued)

- Auto-KG bootstrap (knowgraph.js): the FIRST task in any project writes a
  deterministic FLOOR `.ua/knowledge-graph.json` from the world-model
  extractors (repomap buildSemanticGraph over the persistent index — no LLM,
  no network, no understand-anything npm deps, which are absent). Schema-
  conforming (nodes file:<path>, resolved in-project import edges, honest
  empty layers/tour, truncated flag at the 500-file cap). A REAL
  understand-anything graph is detected by its (missing) forge generator
  marker and NEVER touched. Rebuilds only when the source inventory
  fingerprint (file count + size/mtime sum, self-excluded) drifts; corrupt
  floor graphs are rebuilt; atomic tmp+rename; never throws. Deferred +
  unref'd in meta (planning is never delayed; KG_BOOTSTRAPPED event). The
  existing readers — engmemory retrieval bridge (keyword-gated, confidence
  0.55, never fact) and kg_query's shared parser — light up with zero
  further wiring.
- Blast-radius prediction (impact.predictBlastRadius + toolintel): every
  successful write_file / edit_file / multi_edit / apply_patch gets a
  bounded prediction (buildCrossGraph at a 400-file cap) delivered as ONE
  advisory note line + record.blast + a TOOL_BLAST event (declared in
  TOOL_EVENTS). The note never contains "created"/"deleted" (journal
  classification pins) and never ends in `[exit code: N]`. Off with
  tools.intelligence:false (raw pre-v20.5 string preserved verbatim — pin
  parity tested) or FORGE_BLAST_RADIUS=0/False/off.
- Termux/NetHunter full-power shell (sysshell.js): every shell spawn site
  (model bash plainWrap, sandbox wrapBash incl. ro-bind of the shell's dir,
  process_spawn, both chat `!` exec paths) now resolves through ONE
  resolver: FORGE_SHELL (verbatim override) > /bin/sh > $PREFIX/bin/sh
  (Termux) > $SHELL > PATH "sh". Default on normal Linux is unchanged
  /bin/sh (v27 pin parity). forge doctor reports the resolved shell; the
  help text gained an honest "safety" rewrite (v88 noguard reality) + an
  "environment" section (FORGE_SHELL / FORGE_ALLOW_PRIVATE_URLS /
  FORGE_SKILL_ALLOW_PRIVATE / FORGE_BLAST_RADIUS / FORGE_INDEX /
  FORGE_FAILOVER). skilldl gained the additive FORGE_SKILL_ALLOW_PRIVATE=1
  opt-in for private skill mirrors (default behavior unchanged).
- New tests/test-knowwise.mjs (56 assertions): floor-graph schema + readers
  (retrieval + kg parser) + freshness/drift/preservation/corruption/honesty,
  blast engine + full pipeline wiring incl. both opt-outs and the exact-raw
  intelligence:false pin, behavioral KG_BOOTSTRAPPED through the real
  runMeta loop, shell priority matrix incl. the Termux branches via the pure
  pickShell selector. Registered in run-all.mjs (156 → 157 suites).

## 94.0.0 — skillwise (obra/superpowers engineering-process pack, continued)

The second external skills pack bundled as first-party skills (v94b
understand-anything precedent): **obra/superpowers** (MIT,
github.com/obra/superpowers) — the engineering PROCESS discipline layer on
top of forge's existing code/review/debug playbooks:

- 13 of 14 upstream skills bundled (brainstorming, test-driven-development,
  systematic-debugging, verification-before-completion, executing-plans,
  finishing-a-development-branch, receiving-code-review,
  requesting-code-review, subagent-driven-development,
  dispatching-parallel-agents, using-git-worktrees, using-superpowers,
  writing-skills). Upstream `writing-plans` is NOT re-bundled: forge ships
  its own adapted writing-plans already — the no-overwrite policy wins, and
  a test pins that the bundled copy was not silently swapped.
- Byte-identity: the 8 pure-process skills are byte-identical upstream; the
  5 platform-seam skills (using-superpowers, dispatching-parallel-agents,
  subagent-driven-development, requesting-code-review, writing-skills) carry
  an appended "## Forge execution notes" section with the upstream content
  preserved as a byte-identical PREFIX (subagent dispatch maps to forge's
  delegate tool, bundled templates/scripts resolve via the load_skill
  [skill dir:] header). sha256 manifest pins all 13 SKILL.md files against
  silent drift; the MIT license ships at skills/superpowers-LICENSE (outside
  the skill dirs, so imported trees stay pristine).
- Routing: FIRST_PARTY 21 → 34 (tags/aliases per skill, names unique, named
  skill wins, MICRO stays zero-auto-pick, understand-anything routing
  unbroken). 89 → 102 bundled skills; checkSkills validates all 102.
- Strictly-stronger pins: test-v53 (catalog 21 → 34, all 12 v53 + 9
  understand + 13 superpowers must stay), test-v94b (bundled skills
  89 → 102). New tests/test-skillwise.mjs (150 assertions: bundling,
  validity, sha256 manifest, file inventories, notes discipline, routing,
  load_skill seam, frontmatter/dir match).

## 94.0.0 — toolwise (read-only intelligence tools, continued)

Three new agent-facing tools (26 → 29), each a thin composition over engines
that already exist — no new subsystem, no model calls, no network, fully
deterministic reads over real indexes; all three are verification-safe
(READ class, verifier-allowed, MUTATION_CLASS.NONE) and doctor-self-tested:

- `kg_query` — natural questions over the project knowledge graph: who
  imports/depends on a file (worldmodel), blast radius, covering tests,
  symbol locate, recent changes, plus the understand-anything knowledge
  graph (.ua/knowledge-graph.json) via the engmemory bridge (the KG parser
  moved to module level so retrieval and the tool share ONE implementation).
- `plan_whatif` — simulate a plan (or a plan change: add/remove/update
  nodes) through plannerisk BEFORE committing: risk ladder, success
  estimate, factor breakdown, critical path + SPOF, alternatives for
  high-risk shapes, real failure lessons + prediction calibration as
  evidence. Estimates, never proof; it computes, it never executes.
- `code_context` — one-call context pack: semantic hits (codesearch, the
  same BM25/embeddings ladder as semantic_search) + the structural wiring
  of the top files (importers/tests/radius from the world model).

Capabilities registry stays 1:1 with the wire (29 entries, READ/low/
read_only). Strictly-stronger count pins in the existing suites (v30, v31,
v90, v92, v93, v93r, v94a, security, e2e /tools) now lock 29; the new
tests/test-toolwise.mjs proves the three tools against real engines.

## 94.0.0 — masterwise + tokenwise (Engineering Intelligence Core, continued)

No rewrite, no duplicate subsystems — composed over the existing engines:

- Engineering Intelligence Core (searchproviders.js, execcontroller.js,
  engmemory.js, plannerisk.js): adaptive search providers with honest failure
  (never a fabricated "no results"), the execution controller that can never
  mistake a step/segment budget for completion, the layered engineering memory
  (L1–L5 + evidence provenance), and the predictive risk-aware planner
  (plan risk, node predictions, reality delta, live risk updates,
  risk-based verification).
- TokenRouter provider: one OpenAI-compatible `/v1` gateway
  (`https://api.tokenrouter.com/v1`, Bearer key `TOKENROUTER_API_KEY`).
  Verified live (401 "Token not provided" without a key). Free-tier defaults
  (DeepSeek / Qwen / NVIDIA ids); `listModels()` returns the live model list
  once the key is set. 22 catalog providers.
- understand-anything skills pack bundled (89 bundled skills): understand,
  understand-chat, understand-dashboard, understand-diff, understand-domain,
  understand-explain, understand-figma, understand-knowledge,
  understand-onboard — with the subagent definitions shipped inside the
  referencing skills and forge execution notes appended to them. The
  knowledge graph (.ua/knowledge-graph.json) feeds engineering-memory
  retrieval (provenance-tagged, keyword-gated, never fact/verified).
- load_skill serves up to 64KB (the checkSkills ceiling) and prefixes the
  resolved skill directory; skills.js loadSkill ceiling matches.
- test-v53's first-party pin updated strictly stronger (all 12 v53 skills
  must remain + the pack registered); new test-v94b suite (71 assertions).

## 94.0.0 — gapwise (gap fix / integration patch on sensewise)

No rewrite — the confirmed v93 gaps, fixed in place:

- ONE completion contract for every execution path: `canCompleteFastPath`
  shares the whole-task gate's module/shape/invariants; budget exhaustion
  without a final answer is INCOMPLETE (RESOURCE_LIMIT) + boundary
  checkpoint + resume — never a fabricated COMPLETED. Run journals gain
  `incomplete` as a terminal state.
- workers: EXHAUSTED status (settled, `ok:false`, reassignable); meta's
  runner returns the full agent outcome; §35 retries an exhausted worker
  once, then the node FAILS honestly.
- Runtime Intelligence: `runtimesession.js` (evidence-based discovery,
  real health probes, the "server started" claim gate, an ownership ledger
  with pid-reuse-guarded crash reconcile) + the `runtime` tool (#26),
  verifier-gated.
- World model: persistent `world.json`, fingerprint-diff incremental
  builds, honest truncation, durable `invalidate()` wired to meta
  (WORLD_INVALIDATED).
- Core bus persists (bindTask + history replay) + a bounded events.jsonl
  engineering ledger with restart reconstruction.
- Language: documentSymbol structured extraction, LSP-first with a labeled
  lexical fallback; the layer-3 availability bug is fixed.
- Tool creation: `toolcreate.js` lifecycle with behavioral verification in
  a real child process; only ACTIVE+verified tools reach the agent.
- Learned skills: promotion requires recorded behavioral evidence + a fresh
  fingerprint; markStaleSkills wired into meta.
- Strategy 3.0: contextual factors + justification; outcomes stored with
  their context; meta records real outcomes.

## v93.0.0 — sensewise (three new senses, 25 tools)

- `process`: background process manager (spawn/poll/status/kill/list).
  Dev servers survive the tool call; poll returns only NEW output; ports
  are DETECTED from output and the OS socket table — never guessed; kill
  signals the whole process group; the lifetime fuse is a resource fuse
  (timeout-killed, never "exited 0"); live cap 8; children reaped and
  killed at forge exit.
- `repl`: persistent real Node REPL sessions — variables, imports and
  loaded data survive between calls; incomplete input is reset with
  `.break` (reported); timeout reports "still running", never fabricates;
  dead sessions restart transparently (reported).
- `semantic_search`: code search by meaning — BM25 (retrieval.js) reranked
  with provider embeddings when they resolve; any embedding failure
  degrades to plain BM25; truncated scans are reported; verifier-
  whitelisted and read-only.
- Island wiring completed: skillforge (agent/chat/compose/context),
  embeddings (agent/meta), memgraph (memory/lessons/compose), retrieval
  (+codesearch).

## v92.0.0 — wirewise (islands consulted by the living system)

- P0 FIX: agent.js plugin-load TDZ — `unrestricted` was referenced before
  its const declaration; the swallowed ReferenceError meant user tool
  plugins (~/.forge/tools) never loaded in any runAgent invocation.
- prediction ledger (§9): predict before every segment (DAG node targets +
  planning risk — never model self-confidence), settle against observed
  reality, persist bounded per project, feed real prediction errors back
  into planning as calibration.
- language adapters wired (§7/§8): every agent system prompt carries honest
  deep-vs-conservative coverage per language; the 8-layer parse ladder
  stays honest (absent = UNAVAILABLE, never invented).
- world-model consultation at planning (§5/§10): project shape, blast
  radius and covering tests of objective-named files (PLAN_WORLD_CONSULTED).
- integrator conflicts reported (§31): integrateResults overlaps were
  computed and discarded and the core handler was dead code — meta now
  emits INTEGRATION_CONFLICT in the exact claims shape with the evidence
  ladder, plus a bus WARNING mirror.
- /tools help shows the real (dynamic) tool count.

## v91.0.0 — corewise

- core bus + causal chains + episodes + decisions: the conversation-level
  intelligence islands became consulted subsystems instead of shelves.
- decisions.js records the why behind autonomous choices; causal.js links
  tool effects to outcomes; episodes bound and persist run narratives.

## v90.0.0 — gitwise

- git_diff / git_log / git_blame: dedicated read-only git views (HEAD /
  stage / worktree / any ref, path filter, context, line budget with loud
  truncation; blame window capped at 200 lines). execFile argument arrays
  only; base can never be a git flag; LOW-risk READ class, parallel-safe,
  verifier-whitelisted, doctor-self-tested. 19 → 22 tools.
- silent-stop fix: an empty model response (no text, no tool calls) used to
  end the run as "completed" with "(empty answer)". Now: nudge + retry on
  the same step budget (3 attempts); a persistent streak fails loudly with
  exit 1.

## v89.0.0 — fast (zero behavior change, byte-identical results)

- xlang traversals adjacency-indexed + memoized: was O(V×E) repeated ~40×
  per agent run (~60% of agent-step CPU) — a 400-file repo went 1.80s →
  0.39s per step.
- forge.js lazy-loads chat REPL / agent engine / tool registry per
  subcommand: CLI startup 218ms → 57ms.
- provider fail-fast: connect-guard expiry skips same-provider retries and
  goes straight to the failover chain (worst-case dead-provider stall ~94s
  → 8s).
- Anthropic prompt caching on the static prefix (tool schemas + system
  prompt) — cache-served from step 2.
- parallel test runner: FORGE_TEST_CONCURRENCY (default 4); bash suites
  stay sequential (shared port).

## v88.0.0 — noguard (owner's standing decision) + worker clamp

- nothing is refused and nothing prompts: block-class, danger/confirm,
  sudo, interpreter eval — all run; the refusal code paths are gone. No
  project write boundary, no sensitive-read block, no SSRF gate on
  fetch_url.
- bwrap sandbox is OPT-IN (FORGE_SANDBOX=1); default is direct /bin/sh.
- kept on purpose (correctness, not guards): read-only verifier/plan agents
  cannot write (VERIFY ⇒ READ_ONLY), secret redaction of key shapes, socket
  pinning, netguard policy on downloads.
- worker clamp: low-tier / low-RAM machines run 2 parallel read-only
  workers (floor, was 1); the absolute ceiling is 8 on any machine; burst
  scaling included; mutators serialize through a single writer.

## v87.0.0 — full control (broken-bwrap auto-fallback, zero pauses)

- sandbox: a bwrap that cannot build a user namespace (kernel hides
  overflowuid/overflowgid) is probed once and treated as missing; a bwrap
  that dies at startup is detected, the command re-runs UNSANDBOXED, the
  real output is returned (the wrapper error never leaks into results),
  the fallback is announced once, and the broken wrapper is skipped for
  the rest of the session.
- tools.autoApprove (default ON, owner-only): no failure class hands a
  decision back to the user — no "[forge] ask the user:" line, no
  TOOL_ESCALATION event. `--yolo` forces full control for the process.

## v61.0.0 — leftovers live in TODO.md

- completed PLAN files are retired: no PLAN-vN.md ships with the repo;
  unfinished ideas and known gaps live in TODO.md (open items only, nothing
  checked), and the CHANGELOG no longer points at a living PLAN file.
- kernel + package frozen against side writes: assumeYes stays false,
  allowNewPlugins stays false, and a cloned repo's forge.config.json cannot
  flip owner-only switches.

## v60.0.0 and earlier (abridged)

- v85: guarded install (y/N prompts, block list) — the shipped default
  later moved to unrestricted in v88; the cleanroom pins the guards OFF to
  keep testing them.
- v84 → v62: the autonomy hardening ladder — worker timeouts with
  cleanup, exact node attribution, DAG conflict detection, read-only state
  enforcement, invalid-plan refusal, max-segment continuation, verification
  scope and staleness (evidence epochs: stale evidence cannot pass),
  unknown-exit-code honesty, checkpoint integrity + restore + crash matrix,
  effect reconciliation, git recovery, model-routing history, MCP/LSP
  lifecycles, resource-leak audits.
- v21.1: security audit — securefs.js (TOCTOU-proof descriptor-relative
  writes, O_NOFOLLOW per component, symlink refusal), SSRF pinning,
  plugin isolation, shellguard classification split from execution.
- v20.3: installer checks (P1-10): a failing install runs npm exactly once,
  surfaces the real error, and offers the --prefix escape hatch.
- v20.2: `npm test` exists — one command runs every suite by exit code.
