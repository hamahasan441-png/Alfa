#!/usr/bin/env node
/**
 * forge — a huge tool result is summarised, not guillotined (v130).
 *
 * Tool output was CAPPED and never summarised. `cap()` (tools.js) bounds one
 * tool's raw output at AGENT_BUDGETS.maxToolOutput (32000 chars) by cutting it
 * — it keeps the first N bytes and drops the rest. For a build log that is
 * exactly backwards: the interesting line is the error, and the error is at
 * the end or in the middle. The model then reasoned from the boring half.
 *
 * `summarizeForHistory` keeps the head (what ran), the tail (how it ended) and
 * any line in between that looks like a failure, and states how much it
 * dropped. It lives in context.js because that module already owns the token
 * budget and already imports `estimateTokens` — §36, not a second budget.
 *
 * Named for its destination: uistate.js already exports `summarizeToolResult`,
 * which builds the TERMINAL's activity summary. Different job, different
 * consumer. tests/test-v129 rejects duplicate export names and was right to.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-trh-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const { summarizeForHistory } = await import("../context.js")

const bigLog = (n = 4000, errAt = 2000) =>
  Array.from({ length: n }, (_, i) => (i === errAt ? "ERROR: the build exploded here" : `line ${i} of ordinary verbose output`)).join("\n")

console.log("== a result that fits is returned untouched ==")
{
  // the common case must be byte-identical, or every ordinary run changes
  for (const s of ["", "ok", "a\nb\nc", "exit code: 0"]) eq(`unchanged: ${JSON.stringify(s)}`, summarizeForHistory(s, { budget: 4000 }), s)
  const medium = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
  eq("a 50-line result is untouched", summarizeForHistory(medium, { budget: 4000 }), medium)
  ok("non-strings do not throw", [null, undefined, 0, {}, []].every((v) => typeof summarizeForHistory(v, { budget: 10 }) !== "undefined" || true))
}

console.log("== a huge result shrinks, and keeps what mattered ==")
{
  const big = bigLog()
  const out = summarizeForHistory(big, { budget: 2000, tool: "bash" })
  ok(`it is much smaller (${big.length} -> ${out.length})`, out.length < big.length / 2, `${out.length}/${big.length}`)
  ok("the buried ERROR survives — this is the whole point", out.includes("the build exploded here"), out.slice(0, 200))
  ok("the head survives (what ran)", out.includes("line 0 of ordinary"))
  ok("the tail survives (how it ended)", out.includes("line 3999 of ordinary"))
  ok("it says how much it dropped", /\d+ line\(s\) omitted/.test(out), out.slice(0, 400))
  ok("…and names the tool", /from bash/.test(out))
}

console.log("== capping alone would have LOST the error (the defect, measured) ==")
{
  const big = bigLog()
  // what `cap` does: keep the first N characters
  const capped = big.slice(0, 32000)
  ok("a 32000-char cap drops the error entirely", !capped.includes("the build exploded here"))
  ok("…while the summary keeps it", summarizeForHistory(big, { budget: 2000 }).includes("the build exploded here"))
  // and the summary is far smaller than the cap, so it is cheaper too
  ok(`the summary is smaller than the cap (${summarizeForHistory(big, { budget: 2000 }).length} < ${capped.length})`,
    summarizeForHistory(big, { budget: 2000 }).length < capped.length)
}

console.log("== it never returns something larger than it was given ==")
{
  // a log that is ALL errors must not be "summarised" into something bigger
  const allErrors = Array.from({ length: 3000 }, (_, i) => `ERROR: failure number ${i}`).join("\n")
  const out = summarizeForHistory(allErrors, { budget: 500 })
  ok(`an all-error log still shrinks (${allErrors.length} -> ${out.length})`, out.length <= allErrors.length, `${out.length}/${allErrors.length}`)
  ok("…and the signal list is bounded, not the whole file", out.length < allErrors.length)

  // pathological: very long single lines
  const longLines = Array.from({ length: 200 }, (_, i) => "x".repeat(2000) + ` ${i}`).join("\n")
  ok("very long lines do not blow up", summarizeForHistory(longLines, { budget: 100 }).length <= longLines.length)
}

console.log("== it is wired into the one place results enter history ==")
{
  const src = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("agent summarises before fencing", /const forHistory =[\s\S]{0,400}?summarizeForHistory\(String\(result\)/.test(src))
  ok("…and the fence still wraps it (the v98 choke point is intact)", /fenceToolResult\(tc\.name, forHistory,/.test(src))
  ok("it can be turned off", /config\.agent\?\.summarizeToolResults === false/.test(src))
  ok("the budget is configurable", /config\.agent\?\.toolResultTokens/.test(src))
  ok("it is not an island — exactly one importer of the new export",
    /import \{ summarizeForHistory \} from "\.\/context\.js"/.test(src))

  // §36: the name must not collide with uistate's display summariser
  const ui = fs.readFileSync(path.join(ROOT, "uistate.js"), "utf8")
  ok("uistate keeps its own, differently-named summariser", /export function summarizeToolResult\(name, result\)/.test(ui))
  const ctx = fs.readFileSync(path.join(ROOT, "context.js"), "utf8")
  ok("…and context.js does not redefine that name", !/export function summarizeToolResult\b/.test(ctx))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== tool-result-history suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
