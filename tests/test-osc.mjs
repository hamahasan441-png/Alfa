#!/usr/bin/env node
/**
 * forge — OSC: talking to the terminal itself (v136).
 *
 * ui.js owns SGR (colour). osc.js owns OSC — the sequences that address the
 * terminal EMULATOR rather than the character cell: hyperlinks, the window
 * title, desktop notifications, shell-integration marks.
 *
 * forge already MEASURED OSC 8 correctly (render.js strips it, so a hyperlink
 * occupies only its visible text) and had never emitted a single OSC byte.
 *
 * WHY MOST OF THIS SUITE IS ABOUT SANITIZING
 *
 * An SGR sequence carries a number. An OSC sequence carries a STRING — and
 * every string forge would put in one comes from somewhere it does not
 * control: a URL from a tool result, a task title from the model, a path from
 * a repository. OSC is terminated by BEL or ESC-backslash, so a payload
 * containing either ENDS THE SEQUENCE EARLY and the rest is read by the
 * terminal as fresh input. That is a terminal-injection hole, and it is the
 * reason this module exists as one gate rather than as escape sequences
 * scattered through the UI.
 */
import fs from "node:fs"
import path from "node:path"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const osc = await import("../osc.js")
const { displayWidth } = await import("../render.js")

const ALL_ON = { hyperlink: true, title: true, notify: true, marks: true }
const ALL_OFF = { hyperlink: false, title: false, notify: false, marks: false }
const BEL = "\u0007"
const ESC = "\u001b"

console.log("== a payload can never end its own sequence ==")
{
  // Each of these, passed through verbatim, would close the OSC and leave the
  // terminal executing whatever follows.
  const attacks = [
    [`title${BEL}rest`, "BEL terminator"],
    [`title${ESC}\\rest`, "ESC-backslash terminator"],
    [`title${ESC}]0;pwned${BEL}`, "a nested OSC that renames the window"],
    [`a\u0000b`, "NUL"],
    [`a\nb\rc`, "newline and carriage return"],
    [`a\u009cb`, "C1 string terminator"],
  ]
  for (const [raw, what] of attacks) {
    const out = osc.oscSafe(raw)
    ok(`${what}: no ESC survives`, !out.includes(ESC), JSON.stringify(out))
    ok(`${what}: no BEL survives`, !out.includes(BEL), JSON.stringify(out))
    // eslint-disable-next-line no-control-regex
    ok(`${what}: no control character survives`, !/[\u0000-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out))
  }
  // …and the same must hold once it is wrapped in a real sequence
  const seq = osc.setTitle(`x${BEL}${ESC}]0;evil${BEL}`, ALL_ON)
  eq("a title sequence contains exactly one terminator", (seq.match(/\u001b\\/g) || []).length, 1)
  ok("…and no BEL at all", !seq.includes(BEL), JSON.stringify(seq))
}

console.log("== ANSI in, letters out ==")
{
  eq("styled text keeps its letters, loses its codes", osc.oscSafe("\u001b[31mred\u001b[0m"), "red")
  eq("whitespace is collapsed, not preserved", osc.oscSafe("  a \t\t b  "), "a b")
  ok("a long title is truncated with an ellipsis", osc.oscSafe("x".repeat(500)).endsWith("…"))
  ok("…to the cap", osc.oscSafe("x".repeat(500)).length <= 256)
  eq("empty stays empty", osc.oscSafe(""), "")
  eq("nullish is not a crash", osc.oscSafe(null) + osc.oscSafe(undefined), "")
}

console.log("== a hyperlink target must be a URL forge is willing to hand over ==")
{
  for (const good of ["https://example.com/a?b=c#d", "http://x.test/", "file:///tmp/a.js", "mailto:a@b.test"])
    ok(`allowed: ${good}`, osc.safeUrl(good) !== null)
  // A terminal that hands these to the system handler is a code-execution path.
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "jar:file:///x"])
    eq(`refused: ${bad}`, osc.safeUrl(bad), null)
  eq("a control character anywhere disqualifies", osc.safeUrl(`https://x.test/${BEL}`), null)
  eq("…including ESC", osc.safeUrl(`https://x.test/${ESC}]0;x`), null)
  eq("not a URL at all", osc.safeUrl("just some text"), null)
  eq("empty", osc.safeUrl(""), null)
  ok("an absurdly long URL is refused rather than truncated", osc.safeUrl("https://x.test/" + "a".repeat(4000)) === null)
}

console.log("== a link that cannot be made returns its plain text ==")
{
  // The caller must never have to ask first — the result is always usable.
  eq("refused scheme → the label", osc.hyperlink("click", "javascript:x", ALL_ON), "click")
  eq("unsupported terminal → the label", osc.hyperlink("click", "https://x.test/", ALL_OFF), "click")
  const link = osc.hyperlink("click", "https://x.test/", ALL_ON)
  ok("a real link wraps the label", link.includes("click") && link.startsWith("\u001b]8;;"), JSON.stringify(link))
  eq("…and occupies only the label's width — render.js already knew how", displayWidth(link), 5)
  eq("no label falls back to the url", displayWidth(osc.hyperlink("", "https://x.test/", ALL_ON)), "https://x.test/".length)
}

console.log("== file links ==")
{
  const l = osc.fileLink("/tmp/a b.js", "a b.js", 42, ALL_ON)
  ok("a space is encoded, not left raw", l.includes("%20"), JSON.stringify(l))
  ok("the line rides as a fragment", l.includes("#42"), JSON.stringify(l))
  eq("…and it still measures as the label", displayWidth(l), 6)
  eq("a relative path has no unambiguous file:// form, so it stays text",
    osc.fileLink("src/a.js", "a.js", 1, ALL_ON), "a.js")
  eq("a bad line number is simply omitted", osc.fileLink("/tmp/a.js", "a.js", -3, ALL_ON).includes("#"), false)
}

console.log("== capability: a pipe never receives OSC bytes ==")
{
  const cap = (env, tty) => osc.oscCapability(env, tty)
  eq("not a TTY → nothing", cap({ TERM: "xterm-256color" }, false), ALL_OFF)
  eq("undefined TTY (a pipe) → nothing", cap({ TERM: "xterm-256color" }, undefined), ALL_OFF)
  eq("TERM=dumb → nothing", cap({ TERM: "dumb" }, true), ALL_OFF)
  eq("no TERM → nothing", cap({}, true), ALL_OFF)
  eq("FORGE_NO_OSC=1 → nothing, whatever else says", cap({ TERM: "xterm", FORGE_NO_OSC: "1" }, true), ALL_OFF)
  eq("CI → nothing (its log viewer is not a terminal a human is at)",
    cap({ TERM: "xterm-256color", CI: "true" }, true), ALL_OFF)

  ok("a plain xterm gets the title, which it has honoured for decades",
    cap({ TERM: "xterm-256color" }, true).title === true)
  ok("…but not hyperlinks, which it may print as garbage",
    cap({ TERM: "xterm-256color" }, true).hyperlink === false)
  ok("a known-modern terminal gets hyperlinks", cap({ TERM: "xterm-256color", WT_SESSION: "1" }, true).hyperlink === true)
  ok("…and so does one identified by TERM_PROGRAM", cap({ TERM: "xterm", TERM_PROGRAM: "iTerm.app" }, true).hyperlink === true)
  ok("FORGE_FORCE_OSC=1 turns everything on", Object.values(cap({ TERM: "xterm", FORGE_FORCE_OSC: "1" }, true)).every(Boolean))

  // NO_COLOR is about COLOUR. A user who turned colour off still wants a
  // working window title, and the NO_COLOR spec does not cover OSC.
  ok("NO_COLOR does not disable the title", cap({ TERM: "xterm", NO_COLOR: "1" }, true).title === true)
}

console.log("== every emitter is silent when its capability is off ==")
{
  for (const [name, call] of [
    ["hyperlink", () => osc.hyperlink("t", "https://x.test/", ALL_OFF)],
    ["setTitle", () => osc.setTitle("t", ALL_OFF)],
    ["restoreTitle", () => osc.restoreTitle(ALL_OFF)],
    ["notify", () => osc.notify("t", "b", ALL_OFF)],
    ["markPrompt", () => osc.markPrompt(ALL_OFF)],
    ["markCommandStart", () => osc.markCommandStart(ALL_OFF)],
    ["markCommandDone", () => osc.markCommandDone(1, ALL_OFF)],
  ]) {
    const out = call()
    ok(`${name} emits no escape when off`, !String(out).includes(ESC), JSON.stringify(out))
  }
  eq("an empty title emits nothing rather than a blank sequence", osc.setTitle("   ", ALL_ON), "")
  eq("a notification with no content emits nothing", osc.notify("", "", ALL_ON), "")
  ok("a non-integer exit code does not reach the terminal",
    osc.markCommandDone("; rm -rf /", ALL_ON) === "\u001b]133;D;0\u001b\\")
}

console.log("== it is wired in, not an island ==")
{
  const term = fs.readFileSync(path.join(ROOT, "terminal.js"), "utf8")
  ok("terminal.js owns the title", /import \{ setTitle as oscTitle, restoreTitle as oscRestoreTitle \} from "\.\/osc\.js"/.test(term))
  ok("…and drops a repeat rather than re-emitting", /if \(seq === titleShown\) return/.test(term))
  ok("…and hands the title back to the shell on the way out",
    /titleShown \? oscRestoreTitle\(\) : ""/.test(term))

  const view = fs.readFileSync(path.join(ROOT, "agentview.js"), "utf8")
  ok("agentview drives it from the STATE", /term\.setWindowTitle\?\.\(windowTitleFor\(s\)\)/.test(view))
  ok("…never from the per-second tick, which carries only elapsed time",
    !/function tick\(\)[\s\S]{0,400}?setWindowTitle/.test(view))
  ok("…and returns the tab to plain forge when the view stops", /term\.setWindowTitle\?\.\("forge"\)/.test(view))

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  ok("osc.js is shipped", pkg.files.includes("osc.js"))
}

console.log(`\n== osc suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
