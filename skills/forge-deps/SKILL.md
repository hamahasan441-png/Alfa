---
name: forge-deps
description: "Upgrade, bump or add a dependency or package (including a major version) safely: read the changelog, pin it, one package at a time, prove it with the project's own tests"
---
# forge-deps

A dependency change is a code change you did not write. Treat it like one.

## Method

1. **Know where you start.** Run the project's own test command and record the
   result BEFORE touching anything. A suite that was already red is not the
   upgrade's fault, and you must be able to tell the difference.
2. **Read what changed.** Before bumping, read the package's changelog or
   release notes between the current and target version (the repo's
   `CHANGELOG.md`, GitHub releases, or current docs — context7 if it is
   configured). List every BREAKING item that touches an API this project
   calls: `grep` for the imports.
3. **One package at a time.** Never batch unrelated upgrades: when the suite
   goes red you must know which package did it.
4. **Use the project's package manager and lockfile.** npm → `npm install
   pkg@x.y.z` (updates `package-lock.json`); pnpm/yarn/bun likewise; pip →
   the pinned file the repo already uses; cargo → `cargo update -p`; go →
   `go get pkg@vX` then `go mod tidy`. Commit the lockfile with the manifest.
5. **Pin exactly** what you verified. No `latest`, no widened ranges you did
   not test.
6. **Fix the breakage at the call sites**, not by patching `node_modules` or
   vendored code.
7. **Prove it.** The same test command, green, plus the build if there is
   one. Say which version you moved from and to, and which breaking changes
   applied.

## Stop and report instead of guessing

- A major version whose migration touches many files: list the call sites
  and the migration steps, then do it in reviewable steps.
- A peer-dependency conflict the lockfile cannot resolve: report both
  constraints; do not force-install over it.
