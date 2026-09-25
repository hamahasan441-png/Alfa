/**
 * forge — what a shell command IS, as far as checks and lessons care (v168).
 *
 * `looksLikeCheck` (v120) moved here from agent.js so the bash tool can use
 * it too (tools.js cannot import agent.js). Added in v168:
 *
 *   - `splitOutputFilter`: a check piped into `| tail -N` / `| head -N`. The
 *     shell reports the LAST stage's exit code, so a failing `npm test 2>&1 |
 *     tail -20` came back as success — and forge recorded a PASSING check,
 *     which covers every write before it (completion.unverifiedWrites). The
 *     shell here is dash: no PIPESTATUS, no pipefail. So forge runs the check
 *     itself and applies the tail/head to its output — same output, the
 *     check's own exit code.
 *   - `normalizeCommand`: one identity for commands that are the same
 *     command typed differently (`node ./setup.js` / `node setup.js`, `npm t`
 *     / `npm test`, a `cd <project> &&` prefix, an output filter), so a lesson
 *     re-applied in another spelling is recognised.
 *
 * No imports beyond node:path — tools.js loads this on the agent's boot path.
 */
import path from "node:path"

/**
 * v120 — IS THIS COMMAND ACTUALLY A CHECK, OR DOES IT MERELY MENTION ONE?
 *
 * The old test was `/\b(test|jest|...|lint)\b/i.test(command)`, matched
 * anywhere in the string. Found in a real run:
 *
 *   grep -n "riskBias" tests/test-plannerisk.mjs
 *
 * `test-plannerisk` contains `test` followed by a word boundary, so that grep
 * was recorded as a PASSING verification check. That is not cosmetic:
 * completion.unverifiedWrites() treats every write before a passing check as
 * covered, so a grep over a file whose NAME contains "test" could mark real
 * writes as verified. Reproduced against the real gate — one write, one grep,
 * `unverified: []`.
 *
 * A check is what the command RUNS, not what it mentions. So: split on the
 * shell separators a command can chain with, and look at the head of each
 * segment. A segment whose verb is a reader (grep, ls, cat, find…) is never a
 * check, whatever its arguments say.
 */
/** Runners whose NAME already says "this is a check" — no keyword needed. */
const SELF_EVIDENT_CHECK = /^(jest|vitest|mocha|pytest|rspec|ava|tap|tox|nose2?|eslint|ruff|flake8|mypy|tsc|snyk|semgrep|bandit|gosec|shellcheck|clippy)\b/i
/** Runners that check only when the rest of the command says so. */
const GENERIC_RUNNER = /^(npm|pnpm|yarn|bun|node|deno|python3?|cargo|go|rake|bundle|make|cmake|gradle|mvn|dotnet|swift|ruby|php|composer)\b/i
const CHECK_INTENT = /\b(test|tests|check|build|compile|lint|typecheck|audit|coverage|verify)\b/i
/** A reader is never a check, whatever its arguments happen to be named. */
const READ_ONLY_VERBS = /^(grep|rg|ag|ls|cat|head|tail|wc|find|fd|stat|file|echo|printf|pwd|which|type|tree|du|df|sed|awk|cut|sort|uniq|diff|git)\b/i
/** Wrappers that run the NEXT word — the verb that matters is behind them. */
export const WRAPPERS = /^(npx|bunx|pnpm\s+dlx|yarn\s+dlx|time|env|sudo|nice)\s+/i

export function looksLikeCheck(command) {
  const raw = String(command ?? "")
  if (!raw.trim()) return false
  // `cd x && npm test` chains; each segment is judged on its own head.
  for (const seg of raw.split(/(?:&&|\|\||;|\||\n)/)) {
    let head = seg.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "") // strip VAR=1 prefixes
    while (WRAPPERS.test(head)) head = head.replace(WRAPPERS, "")
    if (!head) continue
    if (READ_ONLY_VERBS.test(head)) continue
    if (SELF_EVIDENT_CHECK.test(head)) return true
    // `python -m pytest` / `node --test`: the runner is generic, but the thing
    // it is asked to run names itself. "pytest" has no word boundary around
    // "test", so the intent regex alone cannot see it.
    if (GENERIC_RUNNER.test(head) && (CHECK_INTENT.test(head) || head.split(/\s+/).slice(1).some((a) => SELF_EVIDENT_CHECK.test(a)))) return true
  }
  return false
}


/**
 * A check piped into a plain `| tail -N` or `| head -N`, and nothing else:
 * `{ base, filter: { kind, n }, merged }`, or null. Anything with another
 * pipe, a `||`, or more after the filter is left alone — forge only takes
 * over a shape whose output it can reproduce exactly.
 */
export function splitOutputFilter(command) {
  const raw = String(command ?? "")
  const m = /^([\s\S]*?)\s*\|\s*(tail|head)\s+(?:-n\s*|--lines=|-)(\d+)\s*$/.exec(raw)
  if (!m) return null
  const base = m[1].trim()
  if (!base || base.includes("|") || /[\n`]|\$\(/.test(base)) return null
  const n = Number(m[3])
  if (!Number.isFinite(n) || n <= 0) return null
  return { base, filter: { kind: m[2], n }, merged: /(^|\s)2>&1\s*$/.test(base) }
}

/** Apply a tail/head filter to output text, as the shell would have. */
export function applyOutputFilter(text, { kind, n } = {}) {
  const s = String(text ?? "")
  if (!s) return s
  const endsNl = s.endsWith("\n")
  const lines = (endsNl ? s.slice(0, -1) : s).split("\n")
  const kept = kind === "head" ? lines.slice(0, n) : lines.slice(-n)
  return kept.join("\n") + (endsNl || kind === "head" && lines.length > n ? "\n" : "")
}

const NPM_ALIASES = [
  [/^(npm|pnpm)\s+i(\s|$)/, "$1 install$2"],
  [/^npm\s+add(\s|$)/, "npm install$1"],
  [/^npm\s+(?:t|tst|run(?:-script)?\s+test)(\s|$)/, "npm test$1"],
  [/^npm\s+run-script\s+/, "npm run "],
  [/^(pnpm|yarn)\s+run\s+(?=\S)/, "$1 "],
  [/^yarn\s+install(\s|$)/, "yarn$1"],
  [/^python3(\s)/, "python$1"],
  [/^pip3(\s)/, "pip$1"],
  [/^python\s+-m\s+pip(\s)/, "pip$1"],
]

/**
 * One identity for the same command typed differently. Used to COMPARE
 * commands (lessons, repeated checks) — what was typed is still what is
 * shown and stored.
 */
export function normalizeCommand(command, { cwd = process.cwd() } = {}) {
  let c = String(command ?? "").trim().replace(/\s+/g, " ")
  // `cd <this project> && …` — the model often prefixes where it already is
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(c)
  if (cd) {
    const dir = cd[1].replace(/^["']|["']$/g, "")
    if (path.resolve(cwd, dir) === path.resolve(cwd)) c = c.slice(cd[0].length)
  }
  // what is done with the output is not the command
  const f = splitOutputFilter(c)
  if (f) c = f.base
  c = c.replace(/\s*;\s*echo\b[^;&|]*$/, "")
  c = c.replace(/\s+2>&1$/, "").replace(/\s+>\s*\/dev\/null$/, "")
  // `./script` is `script` as an argument; a bare `./x` command is left alone
  c = c.split(" ").map((w, i) => (i > 0 && /^\.\/[^/]/.test(w) ? w.slice(2) : w)).join(" ")
  for (const [re, to] of NPM_ALIASES) c = c.replace(re, to)
  return c.trim()
}
