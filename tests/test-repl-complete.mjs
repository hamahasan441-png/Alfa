#!/usr/bin/env node
// v184 — a REPL call returns only when every statement it sent has run.
//
// Node's REPL prints a ready prompt after EVERY complete statement. forge
// took the first prompt for "done", so a multi-statement input returned
// after its first statement whenever the rest was slow to arrive — found as
// `... ... undefined` for "function mk() {…}\nmk()" in a loaded full-suite
// run. A statement that takes time between them makes it certain.
import { createReplManager } from "../repl.js"

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const rm = createReplManager()

console.log("== multi-statement input returns once all of it ran ==")
{
  const r = await rm.run("main", "function mk() {\n  return 7\n}\nconst t0 = Date.now(); while (Date.now() - t0 < 300) {}\nmk()")
  ok("a slow statement in the middle no longer cuts the call short", r.ok && /\b7\b/.test(r.output), JSON.stringify(r.output))
  const logs = await rm.run("main", "console.log('one')\nconst t1 = Date.now(); while (Date.now() - t1 < 200) {}\nconsole.log('two')\nconsole.log('three')")
  ok("every statement's output, in order", logs.ok && /one[\s\S]*two[\s\S]*three/.test(logs.output), JSON.stringify(logs.output))
  ok("forge's end-of-call marker never reaches the output", !/forge-done|\u0001/.test(r.output + logs.output))
  const next = await rm.run("main", "mk() + 1")
  ok("the next call starts clean and sees the earlier state", next.ok && /^8$/m.test(next.output.trim()), JSON.stringify(next.output))
  const aw = await rm.run("main", "await new Promise((r) => setTimeout(() => r('late'), 200))")
  ok("a top-level await still returns its value", aw.ok && /late/.test(aw.output), JSON.stringify(aw.output))
  const bad = await rm.run("main", "function broken( {")
  ok("incomplete input is still an honest error", !bad.ok && /incomplete/i.test(bad.error ?? ""), JSON.stringify(bad))
  const after = await rm.run("main", "40 + 2")
  ok("…and the session is usable after it", after.ok && /42/.test(after.output), JSON.stringify(after.output))
}

rm.dispose?.()
console.log(`== repl-complete suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 200).unref()
