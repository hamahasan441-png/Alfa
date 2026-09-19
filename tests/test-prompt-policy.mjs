#!/usr/bin/env node
/**
 * forge — the system prompt may not promise a guard the code does not have (v124).
 *
 * The prompt is the most effective safety mechanism in the product, because a
 * model that declines to try never reaches the tool layer at all. That only
 * works while the prompt is TRUE. A prompt that claims a guard which does not
 * exist is worse than silence twice over: the model stops warning the user
 * about actions it believes are impossible, and every "that command is not
 * allowed" becomes a bug report about a guard that was never there.
 *
 * agent.js already carried a comment saying exactly this, from v122. It
 * recurred anyway, because v122 fixed the FULL-CONTROL branch of rules 6 and 7
 * and left the default one — and YOLO is off by default, so the stale branch is
 * the one almost every run actually saw. It promised:
 *
 *   rule 6  "Writes must stay inside the working directory … the tool layer
 *            enforces that"
 *   rule 7  "Catastrophic commands, writes outside the project, sudo, and
 *            publishes are blocked"
 *
 * Neither had been true since v88. Measured, not read: `write_file` outside the
 * project returns "OK wrote …" and creates the file, and `modelMayRun()` answers
 * `{ok: true, unrestricted: true}` for `rm -rf /`, `mkfs.ext4 /dev/sda`, `sudo …`
 * and `npm publish` alike.
 *
 * So this suite does not check the prompt's wording against a fixture. It
 * executes the policy and requires the prompt to agree with what the policy
 * actually did. If someone restores a real block class later, the assertions
 * below flip on their own and the prompt has to be updated to match — which is
 * the point.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-promptpol-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 220) : ""}`) }
}

const { agentSystemPrompt } = await import("../agent.js")
const { modelMayRun } = await import("../shellguard.js")
const { yoloState } = await import("../yolo.js")
const { execTool } = await import("../tools.js")

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-promptpol-proj-"))
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "forge-promptpol-out-"))

const render = (opts = {}) => agentSystemPrompt({
  cwd: ROOT, skillsDir: null, skillsEnabled: false, memoryPath: path.join(HOME, "m.md"),
  role: null, task: "do a thing", repoMap: false, config: {}, ...opts,
})

console.log("== the default run is the non-YOLO branch (so it is the one that matters) ==")
{
  ok("YOLO is off by default", yoloState({}, {}).yolo === false)
  const dflt = render()
  ok("…and the default prompt is not the FULL CONTROL text", !/FULL CONTROL \(YOLO\)/.test(dflt))
  const full = render({ yolo: { yolo: true } })
  ok("the FULL CONTROL branch still renders when YOLO is on", /FULL CONTROL \(YOLO\)/.test(full))
}

console.log("== what the command policy ACTUALLY does ==")
{
  const ctx = { cwd: ROOT, root: ROOT, home: os.homedir() }
  const probes = ["rm -rf /", "mkfs.ext4 /dev/sda", "sudo apt-get install x", "npm publish", "git push --force"]
  const verdicts = probes.map((c) => modelMayRun(c, ctx))
  const allAllowed = verdicts.every((v) => v.ok === true)
  ok("every destructive probe is ALLOWED by modelMayRun", allAllowed, JSON.stringify(verdicts[0]))
  ok("…and each is still classified, so the risk stays visible in the log",
    verdicts.every((v) => v.level && v.level !== "safe"), JSON.stringify(verdicts.map((v) => v.level)))

  const target = path.join(OUTSIDE, "outside.txt")
  const w = String(await execTool(
    { cwd: ROOT, root: ROOT, timeoutSec: 10, maxToolOutput: 4000, _plugins: new Map(), config: {} },
    "write_file", { path: target, content: "x\n" }))
  const wrote = fs.existsSync(target)
  ok("a write OUTSIDE the project succeeds (no boundary)", wrote && !/^ERROR/.test(w), w.slice(0, 80))

  // ---- the agreement itself -------------------------------------------------
  const p = render()
  if (allAllowed) {
    ok("the prompt does NOT claim commands are blocked",
      !/\bare blocked\b/.test(p), (p.match(/.{0,70}are blocked.{0,40}/) ?? [""])[0])
    ok("…and says plainly that nothing is blocked",
      /NOTHING IS BLOCKED/.test(p))
    ok("…and names the model's own judgement as the guard",
      /judgement is the only thing/i.test(p))
    ok("…and still requires a one-line warning before destructive work",
      /state in ONE line what it will do/.test(p))
  } else {
    ok("policy blocks something — the prompt must then say so", /\bare blocked\b/.test(p))
  }

  if (wrote) {
    ok("the prompt does NOT claim the tool layer enforces a project boundary",
      !/the tool layer enforces that/.test(p), (p.match(/.{0,70}tool layer enforces.{0,40}/) ?? [""])[0])
    ok("…and says the boundary is unenforced discipline",
      /NOTHING ENFORCES THIS FOR YOU/.test(p))
  } else {
    ok("writes outside are refused — the prompt may claim enforcement", /enforces/.test(p))
  }
}

console.log("== the honest prompt is the more cautious one, not the looser one ==")
{
  const p = render()
  // the old text told the model not to worry because the gate would catch it;
  // the replacement has to actually raise the bar, not just delete a sentence
  ok("destructive shapes are named so the model can recognise them",
    /rm -rf/.test(p) && /sudo/.test(p) && /publish/.test(p) && /force-push/.test(p), "")
  ok("writing outside the project requires saying where and why",
    /say in one line where and why/.test(p))
  ok("the model is told to run destructive work only if the task asked for it",
    /only if the task actually asked for it/.test(p))
  // and it must NOT have become a refusal machine — this is a working agent
  ok("in-project commands are still run without asking",
    /Run in-project commands yourself/.test(p) && /Do not stop to ask/.test(p))
}

console.log("== no branch of the prompt promises a gate, consent or boundary ==")
{
  // sweep every rendering the flags can produce, so a future edit cannot put
  // the claim back into a branch this suite does not happen to render
  const CLAIMS = [
    /\bare blocked\b/,
    /the tool layer enforces that/,
    /asking the user to disable safety/,
  ]
  const shapes = [
    ["default", {}],
    ["yolo", { yolo: { yolo: true } }],
    ["readOnly", { readOnly: true }],
    ["planOnly", { planOnly: true }],
    ["yolo+readOnly", { yolo: { yolo: true }, readOnly: true }],
    ["deep", { deep: true }],
  ]
  for (const [label, opts] of shapes) {
    const p = render(opts)
    for (const re of CLAIMS) {
      ok(`${label}: does not promise ${re.source.slice(0, 34)}`, !re.test(p),
        (p.match(new RegExp(`.{0,60}${re.source}.{0,30}`)) ?? [""])[0])
    }
  }
}

console.log("== the sibling surface (chat) carries no false guarantee either ==")
{
  // v122 corrected chat.js and agent.js's FULL-CONTROL branch, and missed
  // agent.js's default branch. chat is clean today; pin it so the next edit
  // cannot reintroduce there what was just removed here.
  const { chatSystemPrompt } = await import("../chat.js")
  for (const [label, cfg] of [
    ["chat, YOLO off", { tools: { yolo: false } }],
    ["chat, YOLO on", { tools: { unrestricted: true, autoApprove: true } }],
  ]) {
    const p = chatSystemPrompt(cfg, { toolsEnabled: true })
    for (const re of [/\bare blocked\b/, /the tool layer enforces that/, /asking the user to disable safety/]) {
      ok(`${label}: no false guarantee (${re.source.slice(0, 30)})`, !re.test(p),
        (p.match(new RegExp(`.{0,60}${re.source}.{0,30}`)) ?? [""])[0])
    }
  }
}

console.log("== the rule numbering stays intact (the prompt is read as a list) ==")
{
  const p = render()
  for (const n of ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8."]) {
    ok(`rule ${n} is present`, p.includes(`\n${n} `) || p.includes(`${n} `), "")
  }
}

for (const d of [ROOT, OUTSIDE, HOME]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

console.log(`\n== prompt-policy suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
