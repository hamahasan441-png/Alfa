#!/usr/bin/env node
/**
 * forge — a governor STOP must not eat the model's answer (v125).
 *
 * The bug, reproduced from a real run:
 *
 *   /agent continue plan to upgrade and enhance Alfa
 *   → stopped BLOCKED: no final answer was produced — a governor note about
 *     stopping is not an answer to the user — 3 completion attempts did not
 *     clear it
 *   ⚠ FINISHED WITH FAILING CHECKS  tests: failed (exit 124)
 *     Changes 1 file · Verified 2 passing checks
 *
 * One file changed, two checks green, and the user was handed a note about
 * stopping. Five defects in a row, each defensible alone:
 *
 *   1. the bash tool advertised "default 45" for a timeout whose real default
 *      is 180, so the model raised it by hand — to 240
 *   2. the nudge told it to run `npm test`: ~257 suites + a ~6.5-min e2e +
 *      a clean-room npm install. Killed at 240s → exit 124
 *   3. the completion gate read exit 124 as a FAILED check and ordered
 *      REPAIR — of code nothing had shown to be broken
 *   4. the model could not clear an unsatisfiable blocker, burned its three
 *      attempts, and the run ended COMPLETION_ABANDONED → governorHalt
 *   5. the verification nudge had already WITHDRAWN the real answer, and only
 *      the provider-death exit ever restored it. finalText was "", so the
 *      governor's note became the run's entire output
 *
 * The governor was not malfunctioning. It correctly reported "no answer" for
 * a state that should never have existed. This suite pins each link.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-govans-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const { evaluateCompletion, BLOCKER, COMPLETION } = await import("../completion.js")
const { authorityFor, ACTION } = await import("../governor.js")
const { ciVerifyInvocation, focusedVerify } = await import("../verify.js")
const { AGENT_BUDGETS } = await import("../config.js")

const base = { task: "fix src/p.js", mutating: true, wrote: true, modelAnswered: true, klass: "MEDIUM", existsFn: () => true }

console.log("== link 3: a check that TIMED OUT is not a check that FAILED ==")
{
  const timedOut = evaluateCompletion({ ...base, commandChecks: [{ command: "npm run test", passed: false, timedOut: true, exitCode: 124 }] })
  eq("a timeout raises CHECK_TIMED_OUT, not FAILED_CHECK", timedOut.blockers.map((b) => b.code), [BLOCKER.CHECK_TIMED_OUT])
  eq("…and asks for VERIFY — narrow the check", timedOut.next, "VERIFY")
  ok("…and never orders REPAIR of unproven code",
    !timedOut.blockers.some((b) => b.nextAction === "REPAIR"), JSON.stringify(timedOut.blockers.map((b) => b.nextAction)))
  ok("…and says in words that it did not fail", /did not fail|never returned/.test(timedOut.blockers[0].why), timedOut.blockers[0].why)
  ok("…and it still BLOCKS (a timeout proves nothing)", timedOut.ok === false && timedOut.status === COMPLETION.BLOCKED)

  // exit 124 alone is enough — the `timedOut` flag is not always carried
  const byExit = evaluateCompletion({ ...base, commandChecks: [{ command: "npm test", passed: false, exitCode: 124 }] })
  eq("exit 124 alone is recognised as a timeout", byExit.blockers.map((b) => b.code), [BLOCKER.CHECK_TIMED_OUT])

  // and the other direction must NOT have softened
  const real = evaluateCompletion({ ...base, commandChecks: [{ command: "npm test", passed: false, exitCode: 1 }] })
  eq("a check that RAN and FAILED still raises FAILED_CHECK", real.blockers.map((b) => b.code), [BLOCKER.FAILED_CHECK])
  eq("…and still orders REPAIR", real.next, "REPAIR")

  const bareFail = evaluateCompletion({ ...base, commandChecks: [{ command: "npm test", passed: false }] })
  eq("a failure with no exit code recorded is still a failure, not a timeout",
    bareFail.blockers.map((b) => b.code), [BLOCKER.FAILED_CHECK])

  // both at once: two different orders, both reported
  const mixed = evaluateCompletion({ ...base, commandChecks: [
    { command: "npm test", passed: false, exitCode: 1 },
    { command: "npm run e2e", passed: false, timedOut: true, exitCode: 124 },
  ] })
  ok("a run with both gets both blockers",
    mixed.blockers.some((b) => b.code === BLOCKER.FAILED_CHECK) && mixed.blockers.some((b) => b.code === BLOCKER.CHECK_TIMED_OUT),
    JSON.stringify(mixed.blockers.map((b) => b.code)))

  // a passing run must not have acquired a phantom blocker
  const clean = evaluateCompletion({ ...base, commandChecks: [{ command: "npm test", passed: true, exitCode: 0 }] })
  ok("a passing check still completes cleanly", clean.ok === true, JSON.stringify(clean.blockers))
  ok("…and is still counted as positive evidence", clean.evidence.positive.some((p) => /check\(s\) ran and passed/.test(p)))
}

console.log("== a timeout is a FACT, so YOLO's evidence waiver does not clear it ==")
{
  const waived = { task: "fix src/p.js", mutating: true, klass: "MEDIUM", existsFn: () => true, requireEvidence: false, wrote: true, modelAnswered: true }
  const t = evaluateCompletion({ ...waived, commandChecks: [{ command: "npm test", passed: false, timedOut: true, exitCode: 124 }] })
  ok("a timed-out check blocks even with evidence waived", t.ok === false, JSON.stringify(t.status))
  eq("…and it is still the timeout blocker, not a failure", t.blockers.map((b) => b.code), [BLOCKER.CHECK_TIMED_OUT])
}

console.log("== link 5: an answer the model gave is never destroyed ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  // the restore must be on the SINGLE post-loop path, before answerPresent is
  // read — not on one branch of one exit, which is how it was missed
  const restore = /if \(!String\(finalText \?\? ""\)\.trim\(\) && withdrawnText\) \{[\s\S]{0,400}?finalText = withdrawnText/.exec(src)
  ok("the withdrawn answer is restored when the run ended before a restatement", !!restore)
  const restoreAt = restore ? restore.index : -1
  const answerAt = src.indexOf('const answerPresent = String(finalText ?? "").trim().length > 0')
  ok("…and it runs BEFORE answerPresent is computed (or it changes nothing)",
    restoreAt >= 0 && answerAt >= 0 && restoreAt < answerAt, `${restoreAt} vs ${answerAt}`)
  ok("…exactly once — §36, not a second private copy",
    (src.match(/finalText = withdrawnText/g) || []).length === 1,
    String((src.match(/finalText = withdrawnText/g) || []).length))

  // and the governor's note must no longer REPLACE a real answer
  ok("the governor note is appended to an answer, not substituted for it",
    /finalText = answerPresent \? `\$\{finalText\}\\n\\n\$\{GOV_PREFIX\} \$\{governorNote\}` : governorNote/.test(src))
  ok("the old replace-the-answer form is gone",
    !/if \(governorHalt && !answerPresent && governorNote\) finalText = governorNote/.test(src))
}

console.log("== link 5, measured: the real loop keeps the answer through a silent provider ==")
{
  const { runAgent } = await import("../agent.js")
  const ANSWER = "I changed one.txt as requested and it now holds v1."
  let calls = 0
  const server = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      calls++
      // 1: write a file · 2: give the answer (the nudge then withdraws it)
      // 3+: go silent, exactly as a provider hiccup after the nudge
      const message = calls === 1
        ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "one.txt", content: "v1\n" }) } }] }
        : calls === 2 ? { role: "assistant", content: ANSWER }
          : { role: "assistant", content: "" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-govans-run-"))
  const prev = process.cwd()
  let result = null, threw = null
  try {
    process.chdir(dir)
    result = await Promise.race([
      runAgent({
        // verifyNudge left ON — it is the thing under test
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 12 } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
        task: "write one.txt", journal: false,
      }),
      new Promise((r) => setTimeout(() => r(null), 60000)),
    ])
  } catch (e) { threw = e }
  finally { process.chdir(prev); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

  ok("the run did not die on the silent provider", !threw, threw && String(threw.message).slice(0, 120))
  ok("the nudge did fire (otherwise this proves nothing)", result?.verifyNudged === true, JSON.stringify(result?.verifyNudged))
  ok(`the model's answer survived the withdrawal (${String(result?.text ?? "").slice(0, 40)}…)`,
    String(result?.text ?? "").includes(ANSWER), JSON.stringify(String(result?.text ?? "").slice(0, 200)))
  ok("…and the work is still reported", result?.wrote === true, JSON.stringify(result?.wrote))
  // The restore must not LAUNDER: the write is still on the books as
  // uncovered. (A task this small completes with an uncovered write by
  // design — UNVERIFIED_WRITES blocks at MEDIUM and above — and that was
  // already true on v101's provider-death branch. What must never happen is
  // the gap going missing because an answer reappeared.)
  eq("…and the uncovered write is still reported as uncovered",
    (result?.verification?.unverified ?? []).length, 1)
  eq("…with no check claimed to have covered it", result?.verification?.covered ?? null, [])
}

console.log("== v128: a STATUS note does not overwrite the answer either ==")
{
  // v125 stopped the GOVERNOR's note from replacing a real answer and missed
  // the same shape on the budget / loop-halt / refused-only path, three
  // hundred lines further down. Found by reproducing the reported failure end
  // to end: the withdrawn answer WAS restored (the gate's finalAnswerPresent
  // blocker cleared) and was then assigned over by the loop-halt note, so the
  // user still saw a note about stopping. Half a fix is not a fix.
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("the three end-of-run notes go through one append helper",
    /const note = \(n\) => \(String\(finalText \?\? ""\)\.trim\(\) \? `\$\{finalText\}/.test(src))
  for (const [label, re] of [
    ["loop halt", /finalText = note\(`\(run stopped after repeating/],
    ["refused-only", /finalText = note\(`\(every attempt to change a file was refused/],
    ["step budget", /finalText = note\(`\(run stopped at the step budget/],
  ]) ok(`${label} appends rather than replaces`, re.test(src))
  eq("no end-of-run note assigns over finalText any more",
    (src.match(/finalText = `\(run stopped|finalText = `\(every attempt/g) || []).length, 0)
}

console.log("== nothing is ever handed back empty when work was done ==")
{
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("a run with writes and no text reports its own record",
    /if \(!String\(finalText \?\? ""\)\.trim\(\) && wrote\) \{/.test(src))
  ok("…and says plainly that it is not the model's answer",
    /not as the model's answer/.test(src))
  // it must be a REPORT, never an answer: the gate has already run by then
  const gateAt = src.indexOf("const fastGate = canCompleteFastPath({")
  const synthAt = src.indexOf('if (!String(finalText ?? "").trim() && wrote) {')
  ok("…and it is synthesized AFTER the gate, so NO_ANSWER stays a real blocker",
    gateAt >= 0 && synthAt > gateAt, `${gateAt} vs ${synthAt}`)
}

console.log("== link 1: the bash tool states its real timeout, not a stale one ==")
{
  const { TOOL_DEFS } = await import("../tools.js")
  const defs = Array.isArray(TOOL_DEFS) ? TOOL_DEFS : []
  const bash = defs.find((d) => (d?.function?.name || d?.name) === "bash")
  ok("the bash tool def is findable", !!bash)
  const desc = String(bash?.function?.parameters?.properties?.timeout_sec?.description ?? "")
  ok(`the stated default is the real one (${desc})`, desc.includes(String(AGENT_BUDGETS.timeoutSec)), desc)
  ok("…and the cap is stated too", desc.includes(String(AGENT_BUDGETS.bashTimeoutCapSec)), desc)
  ok("the stale 45 is gone", !/\b45\b/.test(desc), desc)
  const tsrc = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  ok("and it is read from the budget, so it cannot drift again",
    /default \$\{AGENT_BUDGETS\.timeoutSec\}/.test(tsrc))
}

console.log("== link 2: the agent is given a check the project proves can finish ==")
{
  // this repository is its own fixture: CI runs `npm test` with a fast lane
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const inv = ciVerifyInvocation(root, "npm test")
  ok(`the CI invocation is recovered (${inv})`, inv.includes("npm test") && inv.length > "npm test".length, inv)
  ok("…and it carries the fast lane CI itself relies on", /FORGE_FAST=1/.test(inv), inv)
  ok("…and the concurrency pin", /FORGE_TEST_CONCURRENCY=1/.test(inv), inv)

  ok("focusedVerify surfaces it alongside the bare command", /FORGE_FAST/.test(focusedVerify(root, []).ciCommand || ""))

  // it must never invent: no workflow, no claim
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "forge-govans-bare-"))
  eq("a project with no workflow gets nothing invented", ciVerifyInvocation(bare, "npm test"), "")
  eq("an empty command gets nothing invented", ciVerifyInvocation(root, ""), "")
  // a step whose env interpolates is not ours to reproduce
  const interp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-govans-interp-"))
  fs.mkdirSync(path.join(interp, ".github", "workflows"), { recursive: true })
  // built by join, not as one literal: a `key:` followed by an escaped newline
  // inside a JS string reads to test-path-hygiene as a Windows drive path
  fs.writeFileSync(path.join(interp, ".github", "workflows", "x.yml"), [
    "jobs:",
    "  build:",
    "    env:",
    "      TOKEN: ${{ secrets.TOK }}",
    "      SAFE: '1'",
    "    steps:",
    "      - run: npm test",
    "",
  ].join("\n"))
  const got = ciVerifyInvocation(interp, "npm test")
  ok(`an interpolated secret is never copied into the hint (${got})`, !/secrets|TOKEN/.test(got), got)
  ok("…while the plain value beside it still is", /SAFE=1/.test(got), got)
  for (const d of [bare, interp]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

  const asrc = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")
  ok("the nudge prefers the CI form", /its CI runs it as: \$\{fv\.ciCommand\}/.test(asrc))
  ok("…and warns that a check is killed at the budget", /A check is killed at \$\{/.test(asrc))
  ok("…and says a timed-out check proves nothing", /a check that times out proves nothing/.test(asrc))
}

console.log("== the governor's authority flag is single-valued ==")
{
  const src = fs.readFileSync(new URL("../governor.js", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("export function authorityFor"), src.indexOf("export function isMutatingExternal"))
  eq("`enforce` is set exactly once per branch", (body.match(/^\s*enforce: /gm) || []).length, 2) // advisory + enforced
  ok("the dead duplicate is gone", !/enforce: true,\s*\n\s*enforce: halt/.test(body))

  // the fix must be behaviour-preserving: the veto still forbids nothing where
  // it forbade nothing before
  for (const klass of ["MICRO", "SMALL", "MEDIUM", "LARGE"]) {
    const a = authorityFor(ACTION.EXECUTE, { klass })
    ok(`${klass} EXECUTE still forbids nothing`, a.forbidden.length === 0 && a.keep === null && a.hideWrites === false)
  }
  const micro = authorityFor(ACTION.INSPECT, { klass: "MICRO" })
  ok("MICRO INSPECT still hides no writes", micro.hideWrites === false && micro.forbidden.length === 0)
  const stop = authorityFor(ACTION.STOP, { klass: "MICRO" })
  ok("STOP still halts and still freezes writes", stop.halt === true && stop.enforce === true && stop.forbidden.length > 0)
  ok("advisory mode still reports enforce=false", authorityFor(ACTION.EXECUTE, { enforce: false }).enforce === false)
}

console.log("== the --auto kernel stops laundering a note into a COMPLETED answer ==")
{
  // v118 closed this in agent.js and left the meta/--auto path open: the
  // kernel read `res.text` and nothing else, so a segment that ended in a
  // governor STOP handed its note in, and a satisfied WHOLE-TASK gate turned
  // it into a COMPLETED task's finalText.
  const msrc = fs.readFileSync(new URL("../meta.js", import.meta.url), "utf8")
  const asrc = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8")

  ok("agent states whether the MODEL produced the text", /answered: answerPresent/.test(asrc))
  ok("…and carries the note as its own field, not folded into the answer",
    /governorNote: governorNote \|\| null/.test(asrc))

  ok("meta reads that flag instead of sniffing the string", /const answerOf = \(r\) => \{/.test(msrc))
  ok("…and an unanswered segment yields no answer", /if \(r\.answered === false\) return ""/.test(msrc))
  ok("…while a result predating the flag is read as before",
    !/r\.answered !== true/.test(msrc) && /return String\(r\.text \?\? ""\)\.trim\(\)/.test(msrc))
  eq("every attemptCompletion callsite goes through it",
    (msrc.match(/attemptCompletion\(\{ text: answerOf\(res\)/g) || []).length, 3)
  eq("…and none passes the raw text any more",
    (msrc.match(/attemptCompletion\(\{ text: res\.text/g) || []).length, 0)
  ok("the 'task completed' claim is replaced by the task's own record",
    /finalText = String\(text \?\? ""\)\.trim\(\) \|\| completionSummary\(\)/.test(msrc))
  ok("…which says plainly that no answer was produced",
    /no segment produced a final answer/.test(msrc))

  // the REFUSED path is the one place a note SHOULD be surfaced: the task did
  // not complete and the note is the reason. It must not have been muzzled.
  ok("a refused task still reports the run's text, note included",
    /refuseCompletion\(\{ v, segment, segmentId, nodeId: currentNodeId, finalRiskLevel, text: res\.text \}\)/.test(msrc))
}

console.log("== measured: a run that never answers reports answered=false ==")
{
  const { runAgent } = await import("../agent.js")
  let calls = 0
  const server = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      calls++
      // only ever writes; never produces final text, so the budget ends it
      const message = { role: "assistant", content: "", tool_calls: [{ id: `t${calls}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `f${calls}.txt`, content: `v${calls}\n` }) } }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-govans-noans-"))
  const prev = process.cwd()
  let result = null
  try {
    process.chdir(dir)
    result = await Promise.race([
      runAgent({
        config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, verifyNudge: false, maxSteps: 4 } },
        provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" },
        task: "write some files", journal: false,
      }),
      new Promise((r) => setTimeout(() => r(null), 90000)),
    ])
  } catch { /* an exhausted run may throw; the flag is what we assert */ }
  finally { process.chdir(prev); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

  ok("the run ended", !!result, "timed out")
  ok("the model never answered, and the result says so", result?.answered === false, JSON.stringify(result?.answered))
  // the budget end already writes its own honest report (v94), which is why
  // the v125 backstop does not fire here — the point of `answered` is that a
  // non-empty `text` no longer implies the model said it
  ok("…while `text` is still non-empty, which is exactly why the flag is needed",
    String(result?.text ?? "").trim().length > 0)
  ok("…and that text does not claim completion",
    /INCOMPLETE, not completed/.test(String(result?.text ?? "")), JSON.stringify(String(result?.text ?? "").slice(0, 160)))
  ok("…and the status is not COMPLETED", result?.status !== "COMPLETED", JSON.stringify(result?.status))
  // this is the laundering the meta fix prevents: text present, answer absent
  ok("meta would take no answer from this run", result?.answered === false && String(result?.text ?? "").length > 0)
}

console.log("== the ledger stops calling a timeout a failure ==")
{
  const src = fs.readFileSync(new URL("../verifyledger.js", import.meta.url), "utf8")
  ok("a timeout-only scope is described as a timeout",
    /did not finish inside its time budget/.test(src))
  ok("…and a real failure still says repair", /repair before completing/.test(src))
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== governor-answer suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
