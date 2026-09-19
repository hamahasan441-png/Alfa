#!/usr/bin/env node
/**
 * forge — v124 full-control developer mode.
 *
 * YOLO is the owner's switch for THEIR OWN machine: under it nothing refuses
 * and nothing pauses to ask. This suite pins the three things v124 added, and
 * — more importantly — the three lines it deliberately did NOT cross:
 *
 *   1. delivery never PAUSES under full control … but full control never turns
 *      delivery ON. `gitship.*` ships "off"; promotion is of the consent TIER
 *      the owner already chose, never of "off".
 *   2. completion evidence can be waived … but the verdict then reads
 *      COMPLETED_UNVERIFIED. A failing check, a missing answer and a no-op
 *      mutation still block: those are facts, not missing evidence.
 *   3. the sandbox is orthogonal — full control never silently arms a jail.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolo124-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"
delete process.env.FORGE_YOLO
delete process.env.FORGE_SANDBOX

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { yoloState } = await import("../yolo.js")
const { gitshipMode } = await import("../gitship.js")
const { evaluateCompletion, COMPLETION, BLOCKER } = await import("../completion.js")

const ON = { tools: { yolo: true } }
const OFF = { tools: { yolo: false } }
const env = {} // never inherit an ambient FORGE_YOLO

console.log("== full control removes the delivery PAUSE ==")
{
  ok("yolo grants deliverUnattended", yoloState(ON, env).deliverUnattended === true)
  ok("yolo off does not", yoloState(OFF, env).deliverUnattended === false)
  ok("it is independently settable without yolo", yoloState({ tools: { yolo: false, deliverUnattended: true } }, env).deliverUnattended === true)
}

console.log("== …but it never turns delivery ON ==")
{
  // the whole point: a YOLO run in a repo that never opted in ships NOTHING
  eq("unattended + no gitship config is still all off",
    gitshipMode({}, { unattended: true }),
    { commit: "off", branch: "off", push: "off", pr: "off" })
  eq("unattended does not promote an explicit off",
    gitshipMode({ gitship: { commit: "off", push: "off", pr: "off" } }, { unattended: true }),
    { commit: "off", branch: "off", push: "off", pr: "off" })
}

console.log("== it promotes the consent TIER the owner already enabled ==")
{
  const enabled = { gitship: { commit: "ask", push: "explicit", pr: "gh" } }
  eq("attended keeps every ask", gitshipMode(enabled), { commit: "ask", branch: "off", push: "explicit", pr: "gh" })
  eq("unattended promotes ask→auto, explicit→auto, gh→auto",
    gitshipMode(enabled, { unattended: true }),
    { commit: "auto", branch: "off", push: "auto", pr: "auto" })
  // an owner may also write the auto tier by hand, with no yolo at all
  eq("auto is a first-class config value",
    gitshipMode({ gitship: { commit: "auto", push: "auto", pr: "auto" } }),
    { commit: "auto", branch: "off", push: "auto", pr: "auto" })
  // "on" was never an asking tier, so there is nothing to promote
  eq("commit=on is untouched", gitshipMode({ gitship: { commit: "on" } }, { unattended: true }).commit, "on")
  // garbage still falls back to off, in both directions
  eq("garbage still falls back to off",
    gitshipMode({ gitship: { commit: "yes-please", push: "force", pr: "api" } }, { unattended: true }),
    { commit: "off", branch: "off", push: "off", pr: "off" })
}

console.log("== completion evidence may be waived — never faked ==")
{
  const base = {
    task: "update the parser in src/p.js", wrote: true, mutating: true,
    modelAnswered: true, klass: "MEDIUM", existsFn: () => true,
    unverified: ["src/p.js"], commandChecks: [],
  }
  const strict = evaluateCompletion({ ...base, requireEvidence: true })
  ok("evidence required → BLOCKED on uncovered writes",
    strict.ok === false && strict.status === COMPLETION.BLOCKED, JSON.stringify(strict.status))
  ok("…and the blocker names the unverified writes",
    strict.blockers.some((b) => b.code === BLOCKER.UNVERIFIED_WRITES))

  const waivedV = evaluateCompletion({ ...base, requireEvidence: false })
  ok("evidence waived → allowed through", waivedV.ok === true)
  ok("…but NEVER as a clean COMPLETED",
    waivedV.status === COMPLETION.COMPLETED_UNVERIFIED && waivedV.status !== COMPLETION.COMPLETED, waivedV.status)
  ok("…and the waived evidence travels with the verdict",
    waivedV.waived.some((b) => b.code === BLOCKER.UNVERIFIED_WRITES), JSON.stringify(waivedV.waived))
  ok("…and is still reported as negative evidence (nothing is hidden)",
    waivedV.evidence.negative.some((w) => /covering check/.test(w)), JSON.stringify(waivedV.evidence.negative))

  // a fully covered run is a clean COMPLETED even with the waiver available
  const covered = evaluateCompletion({ ...base, unverified: [], requireEvidence: false })
  eq("nothing to waive → plain COMPLETED", covered.status, COMPLETION.COMPLETED)
}

console.log("== waiving evidence never waives a FACT ==")
{
  const facts = { task: "fix src/p.js", mutating: true, klass: "MEDIUM", existsFn: () => true, requireEvidence: false }
  const failed = evaluateCompletion({ ...facts, wrote: true, modelAnswered: true, commandChecks: [{ command: "npm test", passed: false }] })
  ok("a check that RAN and FAILED still blocks",
    failed.ok === false && failed.blockers.some((b) => b.code === BLOCKER.FAILED_CHECK), JSON.stringify(failed.status))

  const silent = evaluateCompletion({ ...facts, wrote: true, modelAnswered: false, commandChecks: [] })
  ok("no final answer still blocks", silent.ok === false && silent.blockers.some((b) => b.code === BLOCKER.NO_ANSWER))

  const noop = evaluateCompletion({ ...facts, wrote: false, modelAnswered: true, commandChecks: [] })
  ok("a mutation that wrote nothing still blocks", noop.ok === false && noop.blockers.some((b) => b.code === BLOCKER.NOTHING_CHANGED))
}

console.log("== yolo implies the waiver; the explicit key still wins ==")
{
  ok("yolo on → evidence not required", yoloState(ON, env).requireCompletionEvidence === false)
  ok("yolo off → evidence required", yoloState(OFF, env).requireCompletionEvidence === true)
  ok("completion.requireEvidence:false stands without yolo",
    yoloState({ tools: { yolo: false }, completion: { requireEvidence: false } }, env).requireCompletionEvidence === false)
}

console.log("== the sandbox is orthogonal — full control never arms a jail ==")
{
  ok("yolo alone does NOT enable the sandbox", yoloState(ON, env).sandbox === false)
  ok("the config key does", yoloState({ ...ON, sandbox: { enabled: true } }, env).sandbox === true)
  ok("so does FORGE_SANDBOX=1", yoloState(OFF, { FORGE_SANDBOX: "1" }).sandbox === true)
}

console.log("== the status screen tells the truth about all three ==")
{
  const { formatYolo } = await import("../yolo.js")
  const text = formatYolo(yoloState(ON, env))
  ok("it says delivery never pauses", /never pauses/.test(text))
  ok("it says gitship still decides whether to ship", /still decides WHETHER to ship/.test(text))
  ok("it says an unproven finish is COMPLETED_UNVERIFIED", /COMPLETED_UNVERIFIED/.test(text))
  ok("it names the sandbox pairing command", /forge yolo on --sandbox/.test(text))
}

// ---------------------------------------------------------------------------
// The guarantee the owner actually cares about, asserted END TO END rather than
// as policy state: in YOLO, a command RUNS. Everything above this point checks
// flags and screens; none of it would have noticed if a later change quietly
// reintroduced a refusal in the execution path.
//
// This is a standing requirement, restated by the owner more than once: YOLO is
// the developer's mode and it is unrestricted, until the final version ships.
// So it is pinned here, not left to be re-verified by hand each time the guard
// is touched. v124 added an honest-prompt pass and re-derived modelMayRun's
// grants from the caller; both were checked against this section before landing.
// ---------------------------------------------------------------------------
console.log("== YOLO end to end: the command actually runs, nothing is refused ==")
{
  const { execTool } = await import("../tools.js")
  const { modelMayRun } = await import("../shellguard.js")
  const { agentSystemPrompt } = await import("../agent.js")

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolo-e2e-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolo-out-"))
  const ctx = {
    cwd: proj, root: proj, timeoutSec: 20, maxToolOutput: 4000, _plugins: new Map(),
    config: { tools: { yolo: true } },
    allowSudo: true, allowNetworkUpload: true, allowInterpreterEval: true,
    unrestricted: true, assumeYes: true, autonomous: true,
  }
  const refused = (out) => /^ERROR: .*(not allowed|blocked|refus|denied|needs consent)/i.test(String(out))

  // every shape the old prompt claimed was "blocked"
  const ran = []
  for (const [label, cmd] of [
    ["a plain command", "echo yolo-works"],
    ["interpreter eval", `node -e "console.log('eval ran')"`],
    ["a write outside the project", `echo escaped > ${path.join(outside, "f.txt")} && cat ${path.join(outside, "f.txt")}`],
    ["an rm -rf (harmless path)", "rm -rf /nonexistent-yolo-probe-path"],
  ]) {
    const out = String(await execTool(ctx, "bash", { command: cmd }))
    ok(`YOLO runs ${label}`, !refused(out), out.slice(0, 80))
    ran.push(out)
  }
  ok("the interpreter eval really executed", /eval ran/.test(ran[1]), ran[1].slice(0, 60))
  ok("the outside-project write really landed", /escaped/.test(ran[2]), ran[2].slice(0, 60))

  const target = path.join(outside, "written.txt")
  const w = String(await execTool(ctx, "write_file", { path: target, content: "yolo\n" }))
  ok("write_file outside the project succeeds", !/^ERROR/.test(w) && fs.existsSync(target), w.slice(0, 80))

  // the verdict stays `ok` for every risk level — classification is for the LOG
  for (const cmd of ["rm -rf /", "mkfs.ext4 /dev/sda", "sudo apt-get install x", "npm publish"]) {
    const v = modelMayRun(cmd, { cwd: proj, root: proj }, { allowSudo: true, allowNetworkUpload: true, allowInterpreterEval: true })
    ok(`modelMayRun still allows: ${cmd}`, v.ok === true, JSON.stringify(v))
  }

  // and the prompt the model sees must not claim otherwise
  const p = agentSystemPrompt({
    cwd: proj, skillsDir: null, skillsEnabled: false, memoryPath: path.join(HOME, "m.md"),
    role: null, task: "t", repoMap: false, config: { tools: { yolo: true } }, yolo: { yolo: true },
  })
  for (const [label, re] of [
    ["grants FULL CONTROL", /FULL CONTROL \(YOLO\)/],
    ["says nothing is refused", /nothing is refused and nothing pauses to ask/],
    ["names: no command gate", /no command gate/],
    ["names: no project boundary", /no project boundary/],
    ["names: no sudo\/interpreter\/network consent", /no sudo\/interpreter\/network consent/],
    ["forbids self-censoring", /refuse nothing, skip nothing for safety/],
  ]) ok(`the YOLO prompt ${label}`, re.test(p))

  // the restricted rules belong to the OTHER branch and must never leak in
  for (const [label, re] of [
    ["the unenforced-boundary rule", /NOTHING ENFORCES THIS FOR YOU/],
    ["the nothing-is-blocked rule", /NOTHING IS BLOCKED/],
  ]) ok(`the YOLO prompt does not carry ${label}`, !re.test(p))

  for (const d of [proj, outside]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n== yolo-unlimited suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
