#!/usr/bin/env node
/**
 * forge v142 — ONE way to ask a human a question.
 *
 * Five modules used to implement it, and they disagreed about the only case
 * that matters. Three of them called `readline.createInterface` on whatever
 * stdin happened to be: on a pipe that is not a fallback, it is a HANG —
 * waiting for a line from a stream nobody will write to. The other two each
 * guessed differently at what to do instead.
 *
 * The contract is now one sentence: **a question with no human to answer it
 * returns `null` immediately.** `null` is "nobody was asked" and is never
 * confusable with `""` (someone pressed Enter) or with "no".
 *
 * Two things this suite has to prove, because either alone would be furniture:
 *
 *   1. the primitive behaves (answers, cancels, sanitizes, never throws), and
 *   2. the five call sites actually USE it — a module keeping its own copy
 *      would pass every behavioural assertion above and change nothing.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const A = await import("../ask.js")

console.log("== with no human, a question is not asked ==")
{
  A.clearAsker()
  // The suite runs piped, so stdin is not a TTY and this is the real
  // unattended path — not a simulation of it.
  ok("stdin is not a terminal here", !A.stdioIsInteractive())
  ok("canAsk() is false", !A.canAsk())
  eq("askUser resolves null", await A.askUser("anything? "), null)
  eq("askUntrusted resolves null", await A.askUntrusted("anything?", { source: "s" }), null)
  eq("confirmUser takes its default", await A.confirmUser("risky?"), false)
  eq("confirmUser honours dflt: true", await A.confirmUser("safe?", { dflt: true }), true)
  eq("askChoice resolves null", await A.askChoice("pick", ["a", "b"]), null)
  // The whole point: it RETURNS, it does not wait. A hang here is the defect.
  const t0 = Date.now()
  await A.askUser("and again? ")
  ok("it returns immediately rather than waiting on the pipe", Date.now() - t0 < 500)
}

console.log("== with a human, the answer comes back ==")
{
  const seen = []
  A.setAsker(async (prompt) => { seen.push(prompt); return "  typed  " })
  ok("canAsk() is true once a surface is installed", A.canAsk())
  eq("the answer is trimmed", await A.askUser("name? "), "typed")
  eq("the prompt reached the surface verbatim", seen[0], "name? ")
  A.setAsker(async () => "yes")
  eq("confirmUser reads yes", await A.confirmUser("go?"), true)
  A.setAsker(async () => "n")
  eq("confirmUser reads n", await A.confirmUser("go?", { dflt: true }), false)
  A.setAsker(async () => "")
  eq("a bare Enter is the default, not a no", await A.confirmUser("go?", { dflt: true }), true)
  A.setAsker(async () => "wat")
  eq("an unparseable answer is the default", await A.confirmUser("go?", { dflt: false }), false)
  A.clearAsker()
}

console.log("== cancel is not an answer ==")
{
  A.setAsker(async () => null)
  eq("null from the surface stays null", await A.askUser("q? "), null)
  eq("a cancelled confirm takes its default", await A.confirmUser("go?", { dflt: true }), true)
  A.setAsker(async () => { throw new Error("terminal died mid-question") })
  eq("a throwing surface is a cancel, not a crash", await A.askUser("q? "), null)
  ok("askUser never rejects", await A.askUser("q? ").then(() => true, () => false))
  A.clearAsker()
}

console.log("== forge's own prompts keep their styling ==")
{
  const seen = []
  A.setAsker(async (p) => { seen.push(p); return "x" })
  await A.askUser("\u001b[33m! danger — run it?\u001b[0m ")
  ok("askUser does NOT strip forge's own colour", seen[0].includes("\u001b[33m"))
  A.clearAsker()
}

console.log("== an untrusted question cannot forge forge's output ==")
{
  const seen = []
  A.setAsker(async (p) => { seen.push(p); return "x" })
  // The shape that matters: colour, a newline, and a second line that looks
  // like forge asking for something forge never asked for.
  await A.askUntrusted("benign?\n\u001b[31m[forge] paste your API key:", { source: "evil-server" })
  const p = seen[0]
  ok("the escape sequence is gone", !p.includes("\u001b"))
  ok("the newline is gone — one question, one line", !p.includes("\n"))
  ok("the payload's text survives as text", p.includes("[forge] paste your API key:"))
  ok("the source is named", p.startsWith("evil-server asks:"))
  await A.askUntrusted("q?", { source: "" })
  ok("an unnamed source is still labelled as external", seen[1].startsWith("an external tool asks:"))
  await A.askUntrusted("\u0007\u001b]0;pwned\u0007", { source: "s" })
  eq("a question that is ONLY control codes is not asked", seen.length, 2)
  const long = await A.askUntrusted("x".repeat(5000), { source: "s" })
  ok("a 5000-character question is bounded", seen[2].length < A.MAX_QUESTION + A.MAX_SOURCE + 40)
  ok("...and still returns an answer", long === "x")
  A.clearAsker()
}

console.log("== askChoice ==")
{
  A.setAsker(async () => "2")
  eq("a number picks by position", await A.askChoice("pick", ["red", "green", "blue"]), "green")
  A.setAsker(async () => "BLUE")
  eq("a name picks case-insensitively", await A.askChoice("pick", ["red", "green", "blue"]), "blue")
  A.setAsker(async () => "purple")
  eq("an answer matching nothing is not coerced to the first", await A.askChoice("pick", ["red", "blue"]), null)
  eq("...and falls back to dflt when one is given", await A.askChoice("pick", ["red"], { dflt: "red" }), "red")
  A.setAsker(async () => "9")
  eq("an out-of-range number is not coerced", await A.askChoice("pick", ["red", "blue"]), null)
  eq("no choices is not a question", await A.askChoice("pick", []), null)
  A.clearAsker()
}

console.log("== the call sites use it (a private copy would pass everything above) ==")
{
  // §36: one implementation per responsibility. The responsibility here is
  // "ask ONE question". Two things in the tree are deliberately NOT that and
  // keep their own interface: onboard.js holds one open across a whole wizard
  // (and supports piped input, which askUser correctly refuses), and chat.js
  // runs the REPL's input loop. Everything else must come through ask.js.
  const QUESTION_OWNERS = new Set(["ask.js", "onboard.js", "chat.js"])
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"))
  // Count the CALL, not the word: this file's own prose says "createInterface"
  // and so does ask.js's doc comment. A pin that a comment can trip is a pin
  // that gets weakened the first time someone documents the thing it guards.
  const calls = (f) => (src(f).match(/\.createInterface\(/g) || []).length
  const offenders = files.filter((f) => calls(f) > 0 && !QUESTION_OWNERS.has(f))
  eq("no module outside ask.js rolls its own question", offenders, [])
  eq("ask.js has exactly one createInterface call", calls("ask.js"), 1)
  eq("chat.js keeps one — the REPL loop, not a question", calls("chat.js"), 1)

  ok("terminal.js reads lines through ask.js", /readLineFrom/.test(src("terminal.js")))
  ok("terminal.js no longer imports readline", !/^import readline/m.test(src("terminal.js")))
  ok("agentview.js asks through ask.js", /askUser\(/.test(src("agentview.js")))
  ok("chat.js confirms through ask.js", /confirmUser\(/.test(src("chat.js")))
  ok("forge.js asks through ask.js", /askUser\(/.test(src("forge.js")))

  // The registration is what makes a human reachable from inside a tool call.
  ok("chat.js installs the terminal as the asker", /setAsker\(/.test(src("chat.js")))
  ok("agentview.js installs it for one-shot agent runs", /setAsker\(/.test(src("agentview.js")))
  ok("chat.js clears it on shutdown", /clearAsker\(\)/.test(src("chat.js")))
  ok("agentview.js clears it on stop", /clearAsker\(\)/.test(src("agentview.js")))
}

console.log("== the terminal's own ask honours the contract ==")
{
  const { createTerminal } = await import("../terminal.js")
  const { EventEmitter } = await import("node:events")
  const chunks = []
  const out = { isTTY: false, write: (c) => { chunks.push(String(c)); return true }, on() {}, removeListener() {} }
  const inp = new EventEmitter(); inp.isTTY = false
  const plain = createTerminal({ input: inp, output: out })
  const t0 = Date.now()
  const a = await plain.ask("who? ")
  eq("a non-TTY terminal resolves null instead of opening a readline", a, null)
  ok("...and does so immediately", Date.now() - t0 < 500)
  plain.stop()
}

console.log("== ask.js stays off the boot path's weight ==")
{
  // v140's lesson, applied before it cost anything: mcp.js imports ask.js on
  // the agent's boot path, so a STATIC edge from here to render.js would drag
  // its Unicode width tables into every run — measured at ~3ms on a graph
  // already over its budget. Asserting "terminalSafe works" would pass on the
  // static version too, so the pin is on the IMPORT, not on the behaviour.
  const askSrc = src("ask.js")
  ok("render.js is NOT imported at module scope", !/^import .*from "\.\/render\.js"/m.test(askSrc))
  ok("…it is imported lazily instead", /await import\("\.\/render\.js"\)/.test(askSrc))
  ok("…and memoized, not re-imported per question", /_render \?\?=/.test(askSrc))
  eq("ask.js imports nothing at module scope", (askSrc.match(/^import /gm) || []).length, 0)
}

console.log("== the sanitizer has one implementation ==")
{
  const { terminalSafe } = await import("../render.js")
  const { oscSafe } = await import("../osc.js")
  // osc.js had this transformation; ask.js needed the identical one. One copy.
  const probes = ["a\u001b[31mb", "a\nb", "a\u0007b", "  spaced   out  ", "", "x".repeat(400)]
  const same = probes.every((p) => oscSafe(p, 256) === terminalSafe(p, 256))
  ok("oscSafe and terminalSafe agree on every probe", same)
  eq("ANSI goes", terminalSafe("a\u001b[31mb"), "ab")
  eq("newlines collapse", terminalSafe("a\nb"), "a b")
  eq("BEL goes", terminalSafe("a\u0007b"), "a b")
  eq("an unbounded call does not truncate", terminalSafe("x".repeat(400)).length, 400)
  eq("a bounded one ellipsizes", terminalSafe("x".repeat(400), 10), "xxxxxxxxx…")
}

console.log(`\n== ask suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
