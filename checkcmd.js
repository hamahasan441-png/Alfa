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

/**
 * v190 — A FAILING PIPED CHECK STOPS THE CHAIN AFTER IT.
 *
 * `npm test 2>&1 | tail -5 && git commit -m "tests pass"`: the shell gives a
 * pipeline its LAST stage's status, so the commit ran when the tests failed.
 * v168/v189 take over a piped check only when nothing follows it; the shell
 * is dash (no pipefail).
 *
 * Every top-level pipeline whose first stage is a check is rewritten with the
 * portable way to carry that stage's status out of the pipeline:
 *
 *   { { { CHECK; }; echo "$?" >&3; } | { FILTERS; } >&4; } 3>&1 | (read -r s; exit "$s")
 *
 * wrapped in `{ …; } 4>&1`. The check's output still goes through the same
 * filters, as typed, to the same place (a filter's own `> file` still
 * wins); only the pipeline's status becomes the check's. The rest of the
 * command is untouched. A command forge cannot parse for certain — a
 * subshell, a brace group, `if`/`for`/`while`/`case`, a heredoc, a
 * background `&`, a command substitution, an unclosed quote — returns null
 * and runs exactly as typed.
 */
const SHELL_KEYWORD = /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|!)(?:\s|$)/
export function rewriteCheckPipelines(command) {
  return rewriteChecks(command)?.command ?? null
}

/**
 * v191 — A CHECK'S OWN STATUS, WHATEVER FOLLOWS IT.
 *
 * `npm test; echo "exit=$?"` and `npm test || true` end with the LAST
 * command's status, 0 — so forge recorded a passing check and counted every
 * write before it as verified, while the model's own output said exit=1.
 * And `npm test && git push` failing at the push was recorded as a failing
 * check though the tests passed.
 *
 * With a `nonce`, every check in a command of more than one part is wrapped
 * in a brace group that reports the check's status on stderr, tagged, and
 * then gives that status back:
 *
 *   { CHECK; __forge_c=$?; printf '\n%s=%s\n' MARK "$__forge_c" >&2; (exit "$__forge_c"); }
 *
 * The group runs only when the check would have, and its status is the
 * check's, so `;`, `&&` and `||` around it behave exactly as typed. The bash
 * tool reads the tagged lines, strips them, and records the check's own
 * status (`checkStatusLines`). Pipelines are rewritten as above (v190).
 */
export function rewriteChecks(command, { nonce = null } = {}) {
  const raw = String(command ?? "")
  if (!nonce && !raw.includes("|")) return null
  // top level: segments joined by && || ; newline; each keeps its pipes
  const segs = [] // { text, sep }
  let cur = "", quote = null
  const pipes = [[]] // per segment: indexes in `cur` of top-level single pipes
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i], next = raw[i + 1]
    if (quote) {
      cur += ch
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) cur += raw[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "\\" && i + 1 < raw.length) { cur += ch + raw[++i]; continue }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    if ("(){}`".includes(ch) || (ch === "$" && next === "(") || (ch === "<" && next === "<")) return null
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) { segs.push({ text: cur, sep: ch + next }); cur = ""; pipes.push([]); i++; continue }
    if (ch === ";" || ch === "\n") { segs.push({ text: cur, sep: ch === ";" ? ";" : "\n" }); cur = ""; pipes.push([]); continue }
    if (ch === "&" && raw[i - 1] !== ">" && raw[i - 1] !== "<" && next !== ">") return null // a background job
    if (ch === "|") { pipes[pipes.length - 1].push(cur.length); cur += ch; continue }
    cur += ch
  }
  if (quote) return null
  segs.push({ text: cur, sep: "" })
  if (segs.some(({ text }) => SHELL_KEYWORD.test(text.trim()))) return null
  const parts = segs.filter(({ text }) => text.trim()).length
  const mark = nonce && parts > 1 ? `__FORGE_CHECK_${nonce}` : null
  let pipelines = 0, marked = 0
  const out = segs.map(({ text, sep }, k) => {
    const cuts = pipes[k]
    const lead = /^\s*/.exec(text)[0]
    const tail = sep === "\n" ? "\n" : sep ? ` ${sep} ` : ""
    let body = null
    if (cuts.length) {
      const check = text.slice(0, cuts[0]).trim()
      const filters = text.slice(cuts[0] + 1).trim()
      if (check && filters && looksLikeCheck(check)) {
        pipelines++
        body = `{ { { { ${check}; } 3>&- 4>&-; echo "$?" >&3; } | { ${filters}; } >&4 3>&- 4>&-; } 3>&1 | (read -r __forge_s; exit "$__forge_s") 4>&-; } 4>&1`
      }
    } else if (mark && text.trim() && looksLikeCheck(text.trim())) body = text.trim()
    if (body === null) return text + sep
    if (mark) { marked++; body = `{ ${body}; __forge_c=$?; printf '\\n%s=%s\\n' ${mark} "$__forge_c" >&2; (exit "$__forge_c"); }` }
    return lead + body + tail
  })
  if (!pipelines && !marked) return null
  return { command: out.join("").trim(), pipelines, marked, mark }
}

/**
 * v191: the checks' own statuses, read from (and stripped out of) stderr.
 * Returns { stderr, statuses } — statuses in the order the checks ran.
 */
export function checkStatusLines(stderr, mark) {
  const statuses = []
  if (!mark) return { stderr: String(stderr ?? ""), statuses }
  const re = new RegExp(`\\n?${mark}=(\\d+)\\n?`, "g")
  const text = String(stderr ?? "").replace(re, (_, n) => { statuses.push(Number(n)); return "" })
  return { stderr: text, statuses }
}

/**
 * v192 — THE LAST CHECK FAILED; THE CARD SAYS SO.
 *
 * The model answered "Done — all tests pass." after `npm test` failed with
 * exit 1, and the run ended COMPLETED. The card under that answer said the
 * change was "unverified" — never that the last check failed, or which. The
 * result file carried `lastCheck`; the card, where the person reads it, did
 * not. This is what every result card asks: did the run's last check fail?
 * `{ command, exitCode, timedOut }`, or null (no check, or the last passed).
 */
export function lastCheckFailure(res) {
  const checks = Array.isArray(res?.commandChecks) ? res.commandChecks : []
  const last = checks[checks.length - 1]
  if (!last || last.passed === true) return null
  return { command: String(last.command ?? "").split("\n")[0].slice(0, 120), exitCode: Number.isInteger(last.exitCode) ? last.exitCode : null, timedOut: last.timedOut === true }
}

/** The card's words for it: "`npm test` failed (exit 1)" / "`…` timed out". */
export function describeCheckFailure(f) {
  if (!f) return ""
  return f.timedOut ? `\`${f.command}\` timed out` : `\`${f.command}\` failed${f.exitCode !== null ? ` (exit ${f.exitCode})` : ""}`
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
