/**
 * forge — OSC: the one module that speaks to the TERMINAL ITSELF (zero deps)
 *
 * ui.js owns SGR (colour). This owns OSC — the escape sequences that address
 * the terminal EMULATOR rather than the character cell:
 *
 *   OSC 8     hyperlink        a path or URL the user can click
 *   OSC 0/2   window title     what the tab says while a run is going
 *   OSC 9/777 notification     a desktop toast when a long run finishes
 *   OSC 133   shell marks      jump-to-prompt / "command finished" in the host
 *
 * forge already MEASURES OSC 8 correctly (render.js `displayWidth` strips it,
 * so a hyperlink occupies only its visible text) and has never emitted a
 * single OSC byte. This is the emitter, and it is one module for the same
 * reason ui.js is one module: so "does this terminal support it, and is this
 * payload safe" is answered in exactly one place.
 *
 * WHY SANITIZING IS THE POINT, NOT A DETAIL
 *
 * An SGR sequence carries a number. An OSC sequence carries a STRING, and
 * every string forge would put in one comes from somewhere it does not
 * control: a URL from a tool result, a task title from the model, a file path
 * from a repository. OSC is terminated by BEL or ESC-backslash, so a payload
 * containing either ENDS THE SEQUENCE EARLY and everything after it is
 * interpreted by the terminal as fresh input — a title that sets another
 * title, a link that opens a command palette, a notification that emits
 * control characters into the user's screen.
 *
 * So the rule here is the same one contentfence.js applies to tool output:
 * untrusted text is never passed through verbatim. Control characters are
 * removed (never escaped — there is no escaping in OSC), payloads are
 * length-capped, and a hyperlink target must parse as an allow-listed scheme.
 * A payload that cannot be made safe produces NO sequence at all, and the
 * caller still gets its plain text back.
 */
import { stripAnsi } from "./render.js"

/** OSC payloads are terminated by ST; BEL is the legacy form. Both must be
 *  impossible to inject, so both are stripped rather than escaped. */
const OSC = "\x1b]"
const ST = "\x1b\\"

/** Long titles and URLs get truncated by terminals anyway; an unbounded one is
 *  just a way to push the rest of the screen off. */
const MAX_TITLE = 256
const MAX_URL = 2048
const MAX_BODY = 512

/** Only schemes a terminal can sensibly and safely open. Notably NOT
 *  `javascript:`, `data:` or `vbscript:` — a terminal that hands those to the
 *  system handler is a code-execution path, and forge must not produce one. */
const SAFE_SCHEMES = new Set(["http:", "https:", "file:", "mailto:"])

/**
 * Remove everything that could terminate or re-open an OSC sequence.
 *
 * Deliberately a REMOVE, not an escape: OSC has no escaping mechanism, so the
 * only safe transformation is deletion. C0 (including ESC and BEL), DEL and
 * C1 all go; so does any ANSI already in the string, because a caller passing
 * styled text into a window title means to pass its letters, not its codes.
 */
export function oscSafe(text, max = MAX_TITLE) {
  let s = stripAnsi(String(text ?? ""))
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  s = s.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

/**
 * Is `url` something a terminal may be handed?
 * @returns {string|null} the normalized href, or null when it must not be emitted.
 */
export function safeUrl(url) {
  const raw = String(url ?? "").trim()
  if (!raw || raw.length > MAX_URL) return null
  // A control character anywhere is disqualifying on its own: there is no
  // legitimate URL containing one, and it is exactly the injection shape.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (!SAFE_SCHEMES.has(u.protocol)) return null
  return u.href
}

/**
 * What this terminal can be told, decided once from the environment.
 *
 * Gated on being a TTY rather than on NO_COLOR: NO_COLOR is about colour, and
 * a user who turned colour off still wants a working window title. What must
 * never happen is OSC bytes landing in a PIPE or a file, which is the TTY
 * check. `TERM=dumb` and CI get nothing.
 */
export function oscCapability(env = process.env, tty = process.stdout.isTTY) {
  const off = { hyperlink: false, title: false, notify: false, marks: false }
  if (String(env.FORGE_NO_OSC ?? "") === "1") return off
  if (tty !== true) return off
  const term = String(env.TERM ?? "").toLowerCase()
  if (!term || term === "dumb") return off
  // CI logs are not a terminal a human is looking at, and several CI viewers
  // render raw OSC as garbage.
  if (env.CI && String(env.CI) !== "false" && !env.FORGE_FORCE_OSC) return off

  const prog = String(env.TERM_PROGRAM ?? "").toLowerCase()
  const modern = Boolean(
    env.WT_SESSION ||                      // Windows Terminal
    env.VTE_VERSION ||                     // GNOME Terminal, Tilix, …
    env.KONSOLE_VERSION ||
    env.KITTY_WINDOW_ID ||
    env.ALACRITTY_WINDOW_ID ||
    env.WEZTERM_PANE ||
    ["iterm.app", "apple_terminal", "vscode", "hyper", "warpterminal", "ghostty", "rio"].includes(prog),
  )
  const force = String(env.FORGE_FORCE_OSC ?? "") === "1"
  // The title is the safe universal: xterm-compatible terminals have honoured
  // OSC 0/2 for decades, and one that does not simply ignores it.
  const title = /xterm|screen|tmux|rxvt|vt100|linux|ansi|alacritty|kitty|wezterm|foot|contour/.test(term) || modern || force
  return {
    hyperlink: modern || force,
    title,
    // OSC 9 is iTerm2's; OSC 777 is the rxvt/VTE form. Only claim it where it
    // is known, because an unsupported one prints its payload as text.
    notify: force || prog === "iterm.app" || Boolean(env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_PANE),
    marks: force || modern,
  }
}

let _cap = null
export function oscCap() { return (_cap ??= oscCapability()) }
/** Tests and `forge config` re-read the environment after changing it. */
export function resetOscCapability() { _cap = null }

/**
 * A clickable label. Returns the PLAIN TEXT unchanged whenever the link cannot
 * be made — an unsupported terminal, a pipe, or a URL that failed the check —
 * so a caller can always use the result and never has to ask first.
 */
export function hyperlink(text, url, cap = oscCap()) {
  const label = String(text ?? "")
  const href = safeUrl(url)
  if (!href || !cap.hyperlink) return label
  // The id parameter is left empty: it is optional, and forge has no need to
  // group links across rows.
  return `${OSC}8;;${href}${ST}${label || href}${OSC}8;;${ST}`
}

/** A clickable local path. `line` makes editors jump to it where supported. */
export function fileLink(absPath, label = null, line = null, cap = oscCap()) {
  const p = String(absPath ?? "")
  const text = String(label ?? p)
  if (!p.startsWith("/")) return text            // relative paths have no unambiguous file:// form
  const frag = Number.isInteger(line) && line > 0 ? `#${line}` : ""
  try { return hyperlink(text, `file://${encodeURI(p)}${frag}`, cap) } catch { return text }
}

/** Set the window/tab title. "" restores nothing — use `restoreTitle`. */
export function setTitle(text, cap = oscCap()) {
  if (!cap.title) return ""
  const t = oscSafe(text, MAX_TITLE)
  if (!t) return ""
  // OSC 2 is the window title; OSC 0 sets icon+window. 2 is the narrower one
  // and the one a tabbed terminal actually shows.
  return `${OSC}2;${t}${ST}`
}

/** Hand the title back to the shell. Terminals reset it from their own config
 *  on the next prompt; emitting an empty title is the portable way to ask. */
export function restoreTitle(cap = oscCap()) {
  return cap.title ? `${OSC}2;${ST}` : ""
}

/**
 * A desktop notification — for the run the user walked away from.
 * OSC 9 carries one string; OSC 777 carries title and body separately.
 */
export function notify(title, body = "", cap = oscCap()) {
  if (!cap.notify) return ""
  const t = oscSafe(title, MAX_TITLE)
  const b = oscSafe(body, MAX_BODY)
  if (!t && !b) return ""
  return `${OSC}777;notify;${t};${b}${ST}`
}

/**
 * OSC 133 shell-integration marks. They let the host terminal fold output,
 * jump between prompts and show a per-command exit status — the same
 * integration a modern shell installs, which forge could not participate in
 * because it never emitted the marks.
 */
export function markPrompt(cap = oscCap()) { return cap.marks ? `${OSC}133;A${ST}` : "" }
export function markCommandStart(cap = oscCap()) { return cap.marks ? `${OSC}133;C${ST}` : "" }
export function markCommandDone(exitCode = 0, cap = oscCap()) {
  if (!cap.marks) return ""
  const code = Number.isInteger(exitCode) ? exitCode : 0
  return `${OSC}133;D;${code}${ST}`
}
