/**
 * forge — terminal UI helpers (zero dependencies)
 *
 * Centralized design system: one place decides which COLOR CAPABILITY is
 * available (none / 16 / 256 / truecolor), and one semantic palette maps
 * design tokens (primary, muted, success, warning, error, info, accent) to
 * ANSI output. Every module styles through this theme — UI code never emits
 * a raw escape sequence of its own, so NO_COLOR, TERM=dumb, pipes and
 * screen readers all degrade identically.
 */
// v18 fix: color support is decided LAZILY (first use), not at import time —
// forge.js sets NO_COLOR for non-TTY output only AFTER its imports run, so the
// old import-time check let ANSI codes leak into pipes/files (forge models > list.txt).
import fs from "node:fs"
import path from "node:path"

let _useColor
export function useColor() {
  if (_useColor === undefined) {
    _useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false && !process.argv.includes("--no-color") && String(process.env.TERM || "").toLowerCase() !== "dumb"
  }
  return _useColor
}

/** Terminal color capability: "none" | "16" | "256" | "truecolor".
 *  NO_COLOR / non-TTY / TERM=dumb always mean "none" (FORCE_COLOR=1 wins). */
export function colorCapability(env = process.env, tty = process.stdout.isTTY) {
  if (env.FORCE_COLOR !== "1" && (env.NO_COLOR !== undefined || tty === false || String(env.TERM || "").toLowerCase() === "dumb")) return "none"
  const colorTerm = String(env.COLORTERM || "").toLowerCase()
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor"
  if (/256color/.test(String(env.TERM || "")) || colorTerm === "256color") return "256"
  return "16"
}

/** Semantic palette: token → {16, "256", truecolor} SGR body (without ESC[ / m).
 *  v198: one brand accent (violet) distinct from info (cyan); `subtle` for
 *  labels, `brand` for the wordmark. Truecolor values are chosen to read on
 *  both dark and light backgrounds. */
const PALETTE = {
  primary: { c16: "1", c256: "1", tc: "1" }, // bold
  success: { c16: "32", c256: "38;5;78", tc: "38;2;74;222;128" },
  warning: { c16: "33", c256: "38;5;214", tc: "38;2;251;191;36" },
  error:   { c16: "31", c256: "38;5;203", tc: "38;2;248;113;113" },
  info:    { c16: "36", c256: "38;5;81", tc: "38;2;56;189;248" },
  accent:  { c16: "35", c256: "38;5;141", tc: "38;2;167;139;250" },
  brand:   { c16: "1;35", c256: "1;38;5;141", tc: "1;38;2;167;139;250" },
  subtle:  { c16: "2", c256: "38;5;245", tc: "38;2;148;163;184" },
  muted:   { c16: "2", c256: "2", tc: "2" }, // dim
}

/** v198: capability → palette column. Before, `code[capability]` looked up
 *  "256" / "truecolor" keys that do not exist, so every terminal got 16 colours. */
const COLUMN = { "16": "c16", "256": "c256", truecolor: "tc" }

/**
 * Build a theme object: every token is a function s → styled string (identity
 * when color is unavailable). `paint(kind, s)` is the generic accessor.
 */
export function makeTheme(capability = colorCapability()) {
  const maybe = (body) => (s) => (capability === "none" ? s : `\x1b[${body}m${s}\x1b[0m`)
  const t = {}
  for (const [kind, code] of Object.entries(PALETTE)) {
    const body = code[COLUMN[capability] ?? "c16"] ?? code.c16
    t[kind] = maybe(body)
  }
  t.paint = (kind, s) => (t[kind] || ((x) => x))(s)
  return t
}

let _theme = null
export function theme() {
  if (!_theme) _theme = makeTheme()
  return _theme
}

// Compatibility exports — the historical named helpers, now delegated to the
// semantic theme so every color in the app flows through one palette.
export const bold = (s) => theme().paint("primary", s)
export const dim = (s) => theme().paint("muted", s)
export const cyan = (s) => theme().paint("info", s)
export const green = (s) => theme().paint("success", s)
export const yellow = (s) => theme().paint("warning", s)
export const red = (s) => theme().paint("error", s)
export const magenta = (s) => theme().paint("accent", s)
export const subtle = (s) => theme().paint("subtle", s)
export const brand = (s) => theme().paint("brand", s)

export function info(msg) { console.log(cyan("● ") + msg) }
export function ok(msg) { console.log(green("✓ ") + msg) }
export function warn(msg) { console.log(yellow("! ") + msg) }
export function err(msg) { console.error(red("✗ ") + msg) }

/**
 * Light markdown rendering for the terminal (fenced code, headings, bullets,
 * inline). Kept for non-TTY / one-shot paths; the interactive UI streams
 * through markdown.js for incremental, structured rendering.
 */
export function renderMarkdown(text) {
  if (!useColor()) return text
  let inFence = false
  return String(text).split("\n").map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return dim(line) }
    if (inFence) return cyan(line)
    return line
      .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => bold(t))
      .replace(/^(\s*)[-*]\s+/, "$1• ")
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
      .replace(/`([^`\n]+)`/g, (_, t) => cyan(t))
  }).join("\n")
}

export function estimateTokens(s) {
  return Math.max(1, Math.round((s || "").length / 4))
}

/**
 * v198: the git branch of `cwd`, read from .git/HEAD — no git process at boot.
 * Walks up to the repository root; follows a worktree's `gitdir:` file.
 * Returns "" outside a repository or on a detached HEAD it cannot name.
 */
export function gitBranchOf(cwd = process.cwd()) {
  try {
    let dir = path.resolve(cwd)
    for (let i = 0; i < 64; i++) {
      const dotGit = path.join(dir, ".git")
      let st = null
      try { st = fs.statSync(dotGit) } catch { /* not here */ }
      if (st) {
        let gitDir = dotGit
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))
          if (!m) return ""
          gitDir = path.resolve(dir, m[1].trim())
        }
        const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
        return ref ? ref[1] : /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : ""
      }
      const up = path.dirname(dir)
      if (up === dir) return ""
      dir = up
    }
  } catch { /* unreadable: no branch */ }
  return ""
}

/** "/home/me/code/app" → "~/code/app". */
function tildePath(p, home = process.env.HOME || "") {
  const s = String(p || "")
  return home && (s === home || s.startsWith(home + "/")) ? "~" + s.slice(home.length) : s
}

/**
 * Banner — identity, then a short aligned block: where, which model, what is
 * on. The literal `forge v${version}` stays first so scripts/tests that grep
 * the banner (e2e, clean-room, PTY) keep working.
 *
 * v198: `info` is { cwd, branch, tools, terminal, yolo, rows } (a string is
 * still taken as the old one-line `extra`). Returns the lines it printed.
 */
export function bannerLines(version, provider, model, info = {}) {
  const o = typeof info === "string" ? { extra: info } : (info ?? {})
  const sep = subtle("  ·  ")
  const row = (k, v) => `  ${subtle(k.padEnd(9))} ${v}`
  const lines = ["", brand("forge") + subtle(` v${version}`) + sep + subtle("autonomous engineering")]
  if (o.cwd) {
    let where = tildePath(o.cwd)
    if (where.length > 56) where = "…/" + where.split("/").slice(-3).join("/")
    lines.push(row("project", where + (o.branch ? subtle(`  (${o.branch})`) : "")))
  }
  lines.push(row("model", provider || model ? `${provider || "(none)"}${model ? subtle(" / ") + model : ""}` : yellow("none configured — run forge onboard")))
  const on = []
  if (o.tools != null) on.push(o.tools ? `${o.tools} tools on` : yellow("tools off"))
  if (o.terminal != null) on.push(o.terminal ? "terminal on" : yellow("terminal ! only"))
  if (o.yolo) on.push(yellow("YOLO"))
  if (on.length) lines.push(row("session", on.join(sep)))
  for (const [k, v] of o.rows ?? []) if (v) lines.push(row(k, v))
  if (o.extra) lines.push(row("", o.extra))
  lines.push(subtle(`  /help commands${"  ·  "}Alt+P palette${"  ·  "}Ctrl+C cancel${"  ·  "}Ctrl+C again exit`))
  lines.push("")
  return lines
}

export function printBanner(version, provider, model, info) {
  const lines = bannerLines(version, provider, model, info)
  for (const l of lines) console.log(l)
  return lines
}
