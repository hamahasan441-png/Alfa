---
name: forge-ci
description: "Fix a failing CI job: read the real log, reproduce the exact step locally, fix the root cause, never skip or disable a check"
---
# forge-ci

A red CI job is evidence. The fix starts from the log, not from a guess.

## Method

1. **Read the failing step's log**, end to end: the first error, not the
   last line. With GitHub, `gh run view <id> --log-failed` (or the github
   tool / github MCP server if configured) shows only the failing steps.
2. **Find the exact command** the job ran in the workflow file
   (`.github/workflows/*.yml`, `.gitlab-ci.yml`, …) — including its working
   directory, environment variables and tool versions (Node, Python, OS).
3. **Reproduce locally** with that same command. If it passes locally, the
   difference IS the bug: compare versions, env vars, a missing lockfile,
   case-sensitive paths, timezone, or a file that exists only on your
   machine.
4. **Fix the root cause.** A flaky test gets made deterministic (seed, clock,
   ordering, a real wait instead of a sleep) — it is never retried into green.
5. **Never** skip, disable, quarantine or loosen a test or a lint rule to get
   green, and never push an empty commit to re-run CI.
6. **Prove it** with the same command locally, then say which step failed,
   why, and what changed.
