/**
 * autofix.js — v99 "loopwise" deterministic repair fast path.
 *
 * When verification fails with a LINT/FORMAT-class problem, the v98 loop
 * spent a full LLM repair run (tokens, latency, risk of unrelated edits) on
 * something the project's own formatter fixes deterministically. Before the
 * LLM repair fires, try the discovered native fix command ONCE:
 *
 *   - the trigger is a lint/format-shaped failure text (pattern, not a guess)
 *   - the command comes from the project's OWN manifests (langengine stacks)
 *   - only DIRECT formatter invocations are allowlisted (no `npm run x`)
 *   - shellguard must classify it "safe" (no pipes, redirects, sudo, nets)
 *   - bounded: 90s timeout, one command per call, full output tail captured
 *
 * The result is EVIDENCE, not a claim: the caller records the command and
 * its exit code in the verification ledger, exactly like an agent-run check.
 * If the fast path does not apply or fails, the LLM repair runs as before —
 * this is a shortcut on a path that already existed, never a replacement.
 */
import { spawnSync } from "node:child_process"
import { classifyCommand } from "./shellguard.js"
import { inspectProject } from "./langengine.js"

/**
 * FORMAT-BY-DEFAULT tools: `black .` and `isort .` name no action, so nothing
 * in the command itself says "this formats". They are recognised by name.
 */
const ALLOWED_FORMATTERS = new Set([
  "prettier", "eslint", "biome", "standard", "ruff", "black", "isort", "autopep8",
  "gofmt", "goimports", "rustfmt", "cargo", "stylua", "dart", "mix", "dotnet",
  "clang-format", "swift-format", "mix_format", "gci", "gofumpt",
])

/**
 * Programs whose job is to run ANOTHER program.
 *
 * shellguard rates several of these "safe" because the danger lives in the
 * argument, not the verb: `bash ./fmt.sh` and `npx <anything>` both classify
 * safe and would execute arbitrary code. This is a DENY list about INDIRECTION
 * — it never tries to enumerate formatters, which is exactly the job the name
 * allowlist below could not keep doing.
 */
const INDIRECT_RUNNERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "env", "eval", "exec", "xargs", "nohup", "time", "timeout", "watch",
  "node", "deno", "bun", "python", "python2", "python3", "ruby", "perl", "php", "java", "dotnet-script", "osascript", "powershell", "pwsh",
  "npm", "npx", "pnpm", "pnpx", "yarn", "bunx", "corepack", "pip", "pipx",
  "make", "just", "task", "rake", "gradle", "gradlew", "mvn", "ant", "bazel", "buck",
  "docker", "podman", "nerdctl", "kubectl", "nix", "nix-shell", "poetry", "pipenv", "uv", "uvx", "tox", "hatch", "conda", "micromamba",
  "ssh", "sudo", "doas", "su",
])

/**
 * Multi-purpose tools whose format action is ONE subcommand among many:
 * `cargo run` and `dotnet build` must never ride this path (audit A10).
 */
const FORMAT_SUBCOMMAND = new Map([["cargo", "fmt"], ["dotnet", "format"], ["mix", "format"]])

/** Tools that both REPORT and FIX: the command must say which it is doing. */
const LINT_CAPABLE = new Set(["eslint", "ruff", "biome", "standard"])

/** Subcommands / flags by which a command NAMES a formatting action. */
const FORMAT_SUBCOMMANDS = new Set(["fmt", "format", "fix"])
const FIXING_FLAG = /(?:^|\s)(?:--fix|--write|--in-place|--apply|-w|-i|-F)(?:[=\s]|$)/

/**
 * Does this command SAY it formats? Either a format subcommand (`taplo fmt`,
 * `php-cs-fixer fix`) or an in-place/fixing flag (`shfmt -w`, `yapf -i`,
 * `ktlint -F`). This is what lets a formatter the table never heard of run,
 * instead of falling through to a full LLM repair.
 */
function namesAFormattingAction(first, parts) {
  if (/(?:fmt|format)$/.test(first)) return true // gofmt, rustfmt, nixpkgs-fmt, clang-format
  const sub = String(parts[1] ?? "").toLowerCase()
  if (FORMAT_SUBCOMMANDS.has(sub)) return true   // taplo fmt, php-cs-fixer fix
  return FIXING_FLAG.test(parts.join(" "))       // shfmt -w, yapf -i, ktlint -F
}

/** Failures that a formatter plausibly repairs. */
const LINTISH = /\b(lint|linter|prettier|eslint|biome|ruff|black|isort|flake8|pycodestyle|gofmt|rustfmt|clang-format|formatting|format check|style (error|issue|violation)|code style)\b/i

const TIMEOUT_MS = 90_000

function safeCandidate(cmd) {
  const c = String(cmd ?? "").trim()
  if (!c || c.length > 200) return null
  // never a compound/shell pipeline — classifyCommand would flag it anyway,
  // but the allowlist check below needs a single direct invocation
  if (/[;|&><`]|\$\(/.test(c)) return null
  const parts = c.split(/\s+/)
  // compare on the BASENAME so a repo-local binary (./node_modules/.bin/prettier)
  // is recognised — and, more importantly, so /bin/bash cannot slip past the
  // indirection check by spelling itself out.
  const first = String(parts[0] ?? "").toLowerCase().replace(/^.*[\\/]/, "")
  if (!first) return null
  // a program that runs another program is never a formatter, whatever it is
  // called and however shellguard rates it
  if (INDIRECT_RUNNERS.has(first)) return null
  // subcommand families must name their FORMAT subcommand — `cargo run x`
  // or `dotnet build` must never ride this path (audit A10)
  const mustSub = FORMAT_SUBCOMMAND.get(first)
  if (mustSub && !new RegExp(`^\\S*${first}\\s+${mustSub}(\\s|$)`, "i").test(c)) return null
  // TWO ways to qualify: a format-by-default tool we know by name, or a command
  // that SAYS it formats. The second is what v124 added — the name table had
  // become the only gate, so a project whose formatter was not on it paid a
  // full LLM repair for something deterministic.
  if (!ALLOWED_FORMATTERS.has(first) && !namesAFormattingAction(first, parts)) return null
  // A lint-capable tool only qualifies when the command actually FIXES —
  // `eslint .` and `ruff check .` only report. Which spelling means "fix"
  // differs per tool (`eslint --fix`, `biome format --write`), so this asks
  // the same shape question as above instead of hard-coding one flag.
  if (LINT_CAPABLE.has(first) && !namesAFormattingAction(first, parts)) return null
  const v = classifyCommand(c, { autonomous: true })
  if (v.level !== "safe") return null
  return c
}

/**
 * @param {object} o
 * @param {string} o.cwd
 * @param {object|null} o.config merged config (tools.autofix === false disables)
 * @param {string} o.failureText the failing verification output / error text
 * @param {string[]} [o.changedFiles] relative changed files (language scoping hint)
 * @returns {{tried:boolean, applied:boolean, command:string, exitCode:number|null, tail:string, reason:string}}
 */
export function tryNativeAutoFix({ cwd = process.cwd(), config = null, failureText = "", changedFiles = [] } = {}) {
  const out = { tried: false, applied: false, command: "", exitCode: null, tail: "", reason: "" }
  if (config?.tools?.autofix === false) { out.reason = "autofix disabled by config"; return out }
  const text = String(failureText ?? "")
  if (!LINTISH.test(text)) { out.reason = "failure is not lint/format-shaped"; return out }
  // candidates from the project's own discovered stacks (format beats lint --fix)
  let stacks = []
  try { stacks = inspectProject(cwd).stacks ?? [] } catch { stacks = [] }
  const langs = new Set(changedFiles.map((f) => {
    const ext = String(f).split(".").pop()?.toLowerCase() ?? ""
    return ext
  }))
  const candidates = []
  for (const s of stacks) {
    // prefer stacks whose language matches a changed file's extension family
    const langOf = (l) => String(l ?? "").toLowerCase()
    const relevant = !langs.size || !s.language || langs.size === 0 ? true : (
      (langs.has("js") || langs.has("mjs") || langs.has("cjs") || langs.has("jsx") || langs.has("ts")) && ["javascript", "typescript"].includes(langOf(s.language))
      || (langs.has("py") && langOf(s.language) === "python")
      || (langs.has("go") && langOf(s.language) === "go")
      || (langs.has("rs") && langOf(s.language) === "rust")
    )
    if (s.format && relevant) candidates.push(s.format)
    if (s.lint && /\b--fix\b/.test(String(s.lint)) && relevant) candidates.push(s.lint)
  }
  for (const raw of candidates) {
    const cmd = safeCandidate(raw)
    if (!cmd) continue
    out.tried = true
    out.command = cmd
    try {
      const r = spawnSync(cmd, { cwd, shell: true, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: process.env })
      const code = typeof r.status === "number" ? r.status : null
      out.exitCode = code
      out.tail = String((r.stdout ?? "") + (r.stderr ?? "")).split("\n").filter(Boolean).slice(-8).join("\n").slice(0, 1200)
      out.applied = code === 0
      out.reason = code === 0 ? "formatter completed cleanly" : `formatter exited ${code}`
      return out
    } catch (e) {
      out.reason = `formatter could not run: ${String(e?.message ?? e).slice(0, 160)}`
      return out
    }
  }
  out.reason = candidates.length ? "no allowlisted safe fix command" : "no discovered fix command for these files"
  return out
}
