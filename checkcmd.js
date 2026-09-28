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

const DOCKER_BIN = /^(?:sudo\s+(?:-\S+\s+)*)?(docker|podman)$/
/** Options of run/exec/compose that take a value — bounded, the common ones.
 *  An unrecognized `--flag value` makes the image parse UNCERTAIN, and an
 *  uncertain parse is reported as such rather than guessed. */
const DOCKER_VALUE_FLAGS = new Set(["-e", "--env", "--env-file", "--name", "-v", "--volume", "-w", "--workdir", "-p", "--publish", "--platform", "--network", "--net", "-u", "--user", "--entrypoint", "--mount", "-l", "--label", "--cpus", "-m", "--memory", "--shm-size", "--gpus", "-h", "--hostname", "--add-host", "--ulimit", "--cap-add", "--cap-drop", "--device", "--tmpfs", "--pull", "--restart", "--runtime", "--security-opt", "--ipc", "--pid", "--userns", "--cidfile", "--dns", "--link", "--log-driver", "--log-opt", "--stop-signal", "--stop-timeout", "--memory-swap", "--cpuset-cpus", "-f", "--file", "--project-name", "--profile", "--workdir", "-t", "--tag", "--build-arg", "--target", "--progress", "--cache-from"])
const DOCKER_BOOL_FLAGS = new Set(["--rm", "-i", "-t", "-it", "-ti", "-d", "--detach", "--init", "--privileged", "--read-only", "--interactive", "--tty", "-T", "--no-deps", "--service-ports", "--quiet", "-q", "--no-cache", "--pull-always", "--remove-orphans", "--build"])

/** Split one shell step into words, honoring quotes (no expansion). */
function shellWords(s) {
  const out = []
  let cur = "", q = null, any = false
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; any = true; continue }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue }
    cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

/** `a && b; c | d` → its top-level steps; separators inside quotes stay. */
function topLevelSteps(command) {
  const out = []
  let cur = "", q = null
  const s = String(command)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; cur += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue }
    if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && s[i + 1] === "&")) {
      out.push(cur); cur = ""
      if ((ch === "|" && s[i + 1] === "|") || ch === "&") i++
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/**
 * V5: parse a docker/podman invocation — engine, subcommand, image or
 * container or compose service, the command run inside it, the NAMES of the
 * env vars it is given (never their values), platform and workdir. Returns
 * null for anything else. `certain: false` when an option this bounded parser
 * does not know may have taken the next word — callers then trust nothing
 * positional. Pure: no process is run.
 */
export function dockerInvocation(command = "") {
  // the container step of a compound command (`cd x && docker run …`)
  const seg = topLevelSteps(command).find((x) => /^(?:sudo\s+(?:-\S+\s+)*)?(?:docker|podman)\s/.test(x))
  if (!seg) return null
  const w = shellWords(seg)
  while (w.length && w[0] !== "docker" && w[0] !== "podman") w.shift()
  const engine = w.shift()
  if (!engine || !DOCKER_BIN.test(engine)) return null
  let compose = false
  if (w[0] === "compose") { compose = true; w.shift() } else if (w[0] === "container") w.shift()
  const sub = w.shift() ?? null
  if (!["run", "exec", "build", "start"].includes(sub)) return { engine, compose, subcommand: sub, image: null, container: null, service: null, command: null, envNames: [], platform: null, workdir: null, certain: false }
  const envNames = []
  let name = null, platform = null, workdir = null, tag = null, certain = true
  let i = 0
  for (; i < w.length; i++) {
    const t = w[i]
    if (!t.startsWith("-") || t === "-") break
    const [flag, inline] = t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, null]
    if (DOCKER_BOOL_FLAGS.has(flag) && !(sub === "build" && flag === "-t")) continue
    if (DOCKER_VALUE_FLAGS.has(flag) || (sub === "build" && flag === "-t")) {
      const v = inline ?? w[++i] ?? ""
      if (flag === "-e" || flag === "--env") envNames.push(String(v).split("=")[0])
      else if (flag === "--name") name = v
      else if (flag === "--platform") platform = v
      else if (flag === "-w" || flag === "--workdir") workdir = v
      else if (flag === "-t" || flag === "--tag") tag = tag ?? v
      continue
    }
    if (inline == null) certain = false // an unknown flag: its value may be the next word
  }
  const target = w[i] ?? null
  const rest = w.slice(i + 1).join(" ") || null
  const base = { engine, compose, subcommand: sub, envNames: [...new Set(envNames)].slice(0, 16), platform, workdir, certain }
  if (sub === "build") return { ...base, image: tag, container: null, service: null, command: null, context: target }
  if (compose) return { ...base, image: null, container: null, service: target, command: rest }
  if (sub === "exec" || sub === "start") return { ...base, image: null, container: target, service: null, command: rest }
  return { ...base, image: target, container: name, service: null, command: rest }
}

export function looksLikeCheck(command) {
  const raw = String(command ?? "")
  if (!raw.trim()) return false
  // V5: `docker run img npm test` / `docker compose exec api pytest` — the
  // container is where it runs, the command inside is what it IS
  const inv = /\b(?:docker|podman)\s/.test(raw) ? dockerInvocation(raw) : null
  if (inv?.certain && (inv.subcommand === "run" || inv.subcommand === "exec") && inv.command) {
    const inner = inv.command.replace(/^(?:sh|bash|ash|dash|zsh)\s+-l?c\s+/, "")
    if (inner !== raw && looksLikeCheck(inner)) return true
  }
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
  // v172: `| tee FILE` / `| tee -a FILE` — the other common way to keep a log
  const t = /^([\s\S]*?)\s*\|\s*tee\s+(-a\s+)?([^\s|;&<>`$"']+)\s*$/.exec(raw)
  if (t) {
    const base = t[1].trim()
    if (!base || base.includes("|") || /[\n`]|\$\(/.test(base)) return null
    return { base, filter: { kind: "tee", file: t[3], append: Boolean(t[2]), n: 0 }, merged: /(^|\s)2>&1\s*$/.test(base) }
  }
  const m = /^([\s\S]*?)\s*\|\s*(tail|head)\s+(?:-n\s*|--lines=|-)(\d+)\s*$/.exec(raw)
  if (!m) return null
  const base = m[1].trim()
  if (!base || base.includes("|") || /[\n`]|\$\(/.test(base)) return null
  const n = Number(m[3])
  if (!Number.isFinite(n) || n <= 0) return null
  return { base, filter: { kind: m[2], n }, merged: /(^|\s)2>&1\s*$/.test(base) }
}

/**
 * V5 — A CHECK PIPED THROUGH SEVERAL STAGES.
 *
 * `npm test 2>&1 | grep -v warn | tail -20` reports its LAST stage's status,
 * so a red suite reads green. splitOutputFilter() takes over the one-filter
 * shapes it can reproduce exactly; anything longer is a pipeline forge cannot
 * re-run itself. `{ stages }` when the command is exactly `check | … | …` —
 * pipes only (no &&, ||, ;, newline, substitution, |&) and a first stage that
 * is itself a check — so the caller can read the FIRST stage's own status
 * (bash PIPESTATUS), or say it is unknown. null for anything else.
 */
export function pipelineCheck(command) {
  const raw = String(command ?? "").trim()
  if (!raw || /&&|\|\||;|\n|`|\$\(|\|&/.test(raw)) return null
  const stages = raw.split("|").map((x) => x.trim())
  if (stages.length < 2 || stages.some((x) => !x)) return null
  if (!looksLikeCheck(stages[0])) return null
  return { stages }
}

/** Apply a tail/head filter to output text, as the shell would have. */
export function applyOutputFilter(text, { kind, n } = {}) {
  const s = String(text ?? "")
  if (!s || kind === "tee") return s // tee shows everything; the file is written by the caller
  const endsNl = s.endsWith("\n")
  const lines = (endsNl ? s.slice(0, -1) : s).split("\n")
  const kept = kind === "head" ? lines.slice(0, n) : lines.slice(-n)
  return kept.join("\n") + (endsNl || kind === "head" && lines.length > n ? "\n" : "")
}

// V5: a bounded table — the common spellings of the SAME check. Anything not
// here still works through generic command evidence; it is just compared by
// its exact (normalised) text.
const NPM_ALIASES = [
  [/^(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx)\s+(?:--yes\s+|-y\s+)?(jest|vitest|mocha|ava|tap|eslint|tsc|prettier|biome|playwright)(\s|$)/, "$1$2"],
  [/^(npm|pnpm)\s+i(\s|$)/, "$1 install$2"],
  [/^npm\s+add(\s|$)/, "npm install$1"],
  [/^npm\s+(?:t|tst|run(?:-script)?\s+test)(\s|$)/, "npm test$1"],
  [/^npm\s+run-script\s+/, "npm run "],
  [/^(pnpm|yarn)\s+run\s+(?=\S)/, "$1 "],
  [/^yarn\s+install(\s|$)/, "yarn$1"],
  [/^python3(\s)/, "python$1"],
  [/^pip3(\s)/, "pip$1"],
  [/^python\s+-m\s+pip(\s)/, "pip$1"],
  [/^python\s+-m\s+pytest(\s|$)/, "pytest$1"],
  [/^pnpm\s+t(\s|$)/, "pnpm test$1"],
  [/^cargo\s+t(\s|$)/, "cargo test$1"],
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
