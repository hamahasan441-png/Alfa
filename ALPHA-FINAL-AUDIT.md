# Alpha Final — audit and what changed

The spec's rule 29 was "audit before implementation; don't guess". This is
that audit: for each of the 30 requirements, where forge already handles it,
whether that code runs on the live path, and what this change did. "Live"
means reachable from `forge.js` and called during a real run (checked by the
import graph and by the call sites named here, not by reading module
headers).

## The main finding

Most of the spec already existed **as ideas, in separate modules that never
met**. The task's understanding was held in five structures:

| structure | held | used by | persisted with the task? | reached workers / reviewer / continue? |
|---|---|---|---|---|
| `usermodel.js` | explicit vs inferred intent, intent hypotheses, ambiguity, authority, rejected approaches | `cognition.js` (its own prompt block) | no | no |
| `goal-contract.js` `createGoalContract` | intent versions, semantic drift, dropped constraints | `cognition.js` | in `cognition.json` only | no |
| `goal-contract.js` `deriveGoalContract` | constraints, prohibitions, acceptance, deliverables | `meta.js` → task record `goal` | yes (frozen at start) | no |
| `contract.js` | intent versions, requirement status, unknowns, gaps, closure | `cognition.js` (its own prompt block) | in `cognition.json` only | no |
| `taskmodel.js` | origin tags (requirement / assumption / inference / fact) | `omega.js` kernel | no | no |

And the controller built its cognition on a resume from the objective text
alone (`resume: { objective }`), so **a resumed task forgot everything the
run had learned**.

## What this change does — one canonical understanding (`understanding.js`)

Not a sixth extractor: one record the existing extractors feed.

* **Built once** in `cognition.boot()` (the one core both engines use) from
  `usermodel.understand()` + `deriveGoalContract()`, plus what neither did:
  temporal statements ("we already implemented X" is context, not a
  request), non-goals, priorities, dependencies, risks, implicit engineering
  requirements (always INFERRED), contradictions inside the request, and an
  inferred success criterion when none was stated.
* **Typed items**: EXPLICIT · INFERRED · ASSUMED · VERIFIED · UNKNOWN ·
  CONTRADICTED, each with a confidence and a source. An inference is never
  promoted to EXPLICIT; only evidence makes something VERIFIED.
* **Evolves** with every controller event and every check in either engine:
  plan, step progress, checks (a passing named check VERIFIES its acceptance
  item; a failing one CONTRADICTS an assumption it touches — self-correction),
  re-plans and strategy changes (decisions with reason/evidence/confidence;
  failed approaches become rejected approaches), goal reinterpretations,
  drift (a planned step that shares nothing with the goal).
* **Knowledge vs state** are separate fields.
* **Persisted** on the task record (`taskstate.setUnderstanding`) at the
  moments that change it, and in `cognition.json`.
* **Used**:
  - one structured prompt block replaces the separate user-model and
    task-contract blocks (single loop system prompt, every controller
    segment);
  - every worker gets the same compact "SHARED UNDERSTANDING" (in-process and
    worktree workers);
  - the code reviewer is asked to judge intent, acceptance, must-nots, drift
    and contradicted assumptions;
  - completion levels IMPLEMENTED → TESTED → VERIFIED → ACCEPTED → COMPLETE in
    the final report (controller) and after a single-loop run;
  - **continue**: a resume restores the record and the first segment gets a
    brief — what we were doing, why, done, verified, remaining, do-not-retry,
    next;
  - `forge tasks --show` prints it.

## Requirement by requirement

| # | requirement | where | status |
|---|---|---|---|
| 1 | canonical understanding model | `understanding.js`, held by `cognition.js`, on the task record | **new — consolidates the five structures above** |
| 2 | intent, not just words | `usermodel.intentHypothesesFor` → `intent.means` / hypotheses | existed; now in the one record and the prompt |
| 3 | explicit vs inferred | item types | **new** (usermodel had the vocabulary; nothing used it end to end) |
| 4 | confidence-aware | per-item confidence; low-confidence assumptions listed "to check in the repository before relying on them" | **new** |
| 5 | ambiguity detection | usermodel ambiguity + vague-request detection → interpretations + smallest assumption (ASSUMED) | extended |
| 6 | contextual understanding | `continuity.js`, `engmemory.js`, `worldmodel.js`, `rehydrate.js` | existed, live |
| 7 | temporal understanding | past / continue statements → context, never requirements | **new** |
| 8 | goal preservation | frozen original (goal-contract, contract), drift on planned steps, the block in every segment | extended |
| 9 | plan from outcome backward | the controller's planner prompt now gets the understanding and is told to plan backward from the success/acceptance lines (skipping done work and non-goals, checking low-confidence assumptions first); `plancritique.js` still checks coverage | **new** in the existing planner (no second planner) |
| 10 | dynamic task graph | `dag.js` (invalidation, replan) | existed, live |
| 11 | adaptive reasoning | `governor.js` next action; `replan.js`; repair loop | existed, live |
| 12 | root-cause reasoning | `hypothesis.js`, `causal.js` (in the `omega.js` kernel), `diagnose.js` | existed, live |
| 13 | contradiction detection | contradictions in the request; evidence contradicting assumptions | **new** for these two sources; memory-vs-repo contradictions: `memgraph.js` invalidation (existed) |
| 14 | architectural understanding | `worldmodel.js`, `repomap.js`, `knowgraph.js` | existed, live |
| 15 | change impact | `impact.js` (kernel + world model), reviewer import graph | existed, live |
| 16 | self-correction | failed checks contradict assumptions; corrections log | **new** |
| 17 | learning from execution | `lessons.js` (confidence, context, evidence), `engmemory.js` | existed, live |
| 18 | intelligent memory retrieval | `engmemory.js` BM25 + task/file/freshness/confidence/evidence reranking | existed, live |
| 19 | knowledge vs state | `knowledge` and `state` are separate fields | **new** in the record |
| 20 | reasoning traceability | decisions with reason, evidence, confidence, affected step | **new** in the record (`decisions.js` keeps architecture decisions) |
| 21 | intelligent context compression | the structured block is rebuilt from the record each segment, so it survives transcript compaction (`compaction.js` handles the transcript) | **new** |
| 22 | multi-agent shared understanding | "SHARED UNDERSTANDING" to every worker | **new** |
| 23 | reviewer intelligence | reviewer prompt gets the understanding and the intent questions | **new** |
| 24 | completion intelligence | completion levels; the completion gate stays authoritative | **new** (reported, not a second gate) |
| 25 | intelligent continue | resume restores the record; resume brief to the first segment | **new** |
| 26 | intelligence loop | governor observe→act→verify→replan | existed; the record now updates as checks, tool results and controller events arrive |
| 27 | evidence-grounded | VERIFIED only from checks/acceptance evidence | rule enforced in code |
| 28 | preserve capabilities | full test suite (see PR) | kept |
| 29 | audit first | this file | done |
| 30 | quality bar | see "what is not done" | — |

## What is not done (honestly)

* **The five structures still exist as inputs.** Removing `contract.js`,
  `usermodel.js` and `taskmodel.js` outright would break dozens of tested
  callers (`omega.js`, `review.js`, tests that pin their APIs). What changed is
  that only the canonical record is shown to the model, persisted, shared,
  reviewed and resumed. Folding the inputs into it is follow-up work, best
  done with the live eval (`forge eval --mode auto`) to show nothing got
  worse.
* **Single loop**: its system prompt is built once per run, so the block it
  sees is the understanding at the start; checks during the run update the
  record (and the completion level) but not that run's prompt. The
  controller re-sends it every segment.
* **Completion levels are reported, not enforced.** The existing completion
  gate still decides COMPLETED; making ACCEPTED a hard requirement changes
  what "done" means and needs the live eval first.
* **No live-model measurement** — this environment cannot reach a provider.
  The derivation is rule-based (deterministic, testable); how much it helps a
  real model is what `forge eval` is for.
