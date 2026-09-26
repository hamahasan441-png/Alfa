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
 *   - v189 `splitFilterStages`: any other plain chain of filters (`| grep`,
 *     `| sort | uniq -c`, …) — the check runs, and its output is fed to the
 *     same stages as typed.
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
  const plainBase = (b) => b && !b.includes("|") && !/[\n`]|\$\(/.test(b)
  // v172: `| tee FILE` / `| tee -a FILE` — the other common way to keep a log
  const t = /^([\s\S]*?)\s*\|\s*tee\s+(-a\s+)?([^\s|;&<>`$"']+)\s*$/.exec(raw)
  if (t && plainBase(t[1].trim())) {
    const base = t[1].trim()
    return { base, filter: { kind: "tee", file: t[3], append: Boolean(t[2]), n: 0 }, merged: /(^|\s)2>&1\s*$/.test(base) }
  }
  const m = /^([\s\S]*?)\s*\|\s*(tail|head)\s+(?:-n\s*|--lines=|-)(\d+)\s*$/.exec(raw)
  if (m && plainBase(m[1].trim()) && Number(m[3]) > 0) {
    const base = m[1].trim()
    return { base, filter: { kind: m[2], n: Number(m[3]) }, merged: /(^|\s)2>&1\s*$/.test(base) }
  }
  return splitFilterStages(raw)
}

/**
 * v189 — A CHECK PIPED THROUGH ANY FILTER KEEPS ITS OWN EXIT CODE.
 *
 * v168/v172 took over `| tail`, `| head` and `| tee`. A model filtering
 * noise — `npm test 2>&1 | grep -v "^npm warn"`, `| grep -E "fail|pass" |
 * head -3` — still got the LAST stage's exit code: the tests failed, grep
 * matched a line, the run saw success and forge recorded a passing check.
 *
 * forge does not re-implement grep. It runs the check, then feeds its output
 * to the same stages, exactly as typed (`kind: "pipe"`): the same lines, and
 * the check's own exit code. Only a plain chain of stages is taken over — no
 * `;`, `&`, `&&`, `||`, redirection, command substitution or newline in them,
 * found outside quotes — and only when the first stage is a check. Anything
 * else runs as typed.
 */
export function splitFilterStages(command) {
  const raw = String(command ?? "")
  const segs = []
  let cur = "", quote = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      cur += ch
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) cur += raw[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "\\" && i + 1 < raw.length) { cur += ch + raw[++i]; continue }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    // `||` is not a pipe: it leaves an empty stage, which is refused below
    if (ch === "|") { segs.push(cur); cur = ""; continue }
    // a stage must be a plain filter: nothing that chains, redirects or
    // substitutes outside quotes (the check itself may carry `2>&1`, `&&`)
    if (segs.length && /[;&<>`\n]/.test(ch)) return null
    if (segs.length && ch === "$" && raw[i + 1] === "(") return null
    cur += ch
  }
  if (quote) return null
  segs.push(cur)
  if (segs.length < 2) return null
  const base = segs[0].trim()
  const stages = segs.slice(1).map((x) => x.trim())
  if (!base || /[\n`]|\$\(/.test(base) || stages.some((x) => !x)) return null
  if (!looksLikeCheck(base)) return null
  return { base, filter: { kind: "pipe", stages: stages.join(" | "), n: 0 }, merged: /(^|\s)2>&1\s*$/.test(base) }
}

/** Apply a tail/head filter to output text, as the shell would have. */
export function applyOutputFilter(text, { kind, n } = {}) {
  const s = String(text ?? "")
  if (!s || kind === "tee" || kind === "pipe") return s // tee shows everything; a pipe's stages are run by the caller
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
