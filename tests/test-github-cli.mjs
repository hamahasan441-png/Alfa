#!/usr/bin/env node
/**
 * forge — GitHub CLI surface (github.js).
 *
 * GitHub is EVIDENCE gathered through the user's OWN allowlisted `gh` CLI:
 * read-only argv, safe ids, honest failure, never a write and never a token
 * store. These tests drive the whole surface deterministically with an injected
 * spawn, so they need no real `gh` and no network. Judged by exit code.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ghcli-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const {
  GITHUB_VERSION, githubImpliedByTask, actionForTask,
  ghAvailable, ghInspect, formatGithub,
} = await import("../github.js")

/** A spawn stub that records the last call and returns a canned result. */
function stubSpawn(result = { status: 0, stdout: "", stderr: "", error: null }) {
  const calls = []
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result }
  fn.calls = calls
  return fn
}

console.log("== protocol identity ==")
{
  ok("github protocol is 1.0.0", GITHUB_VERSION === "1.0.0", GITHUB_VERSION)
}

console.log("== ghAvailable classifies the three auth states ==")
{
  const missing = ghAvailable({ spawn: stubSpawn({ error: new Error("ENOENT"), status: null }) })
  ok("gh not on PATH → not ok, install hint", missing.ok === false && /not on PATH/i.test(missing.why), missing.why)

  const unauth = ghAvailable({ spawn: stubSpawn({ status: 1, stdout: "", stderr: "not logged in", error: null }) })
  ok("gh present but unauthenticated → not ok, login hint", unauth.ok === false && /auth login|authenticated/i.test(unauth.why), unauth.why)

  const good = ghAvailable({ spawn: stubSpawn({ status: 0, stdout: "Logged in", stderr: "", error: null }) })
  ok("gh authenticated → ok", good.ok === true, good.why)

  const spy = stubSpawn({ status: 0 })
  ghAvailable({ spawn: spy })
  eq("ghAvailable probes `gh auth status`", [spy.calls[0]?.cmd, spy.calls[0]?.args], ["gh", ["auth", "status"]])
}

console.log("== ghInspect builds read-only argv for no-id actions ==")
{
  const cases = {
    repo: ["repo", "view", "--json", "name,description,url,defaultBranchRef,isPrivate,visibility"],
    issues: ["issue", "list", "--limit", "8", "--json", "number,title,state,updatedAt,url"],
    prs: ["pr", "list", "--limit", "8", "--json", "number,title,state,url,headRefName,isDraft"],
    runs: ["run", "list", "--limit", "8", "--json", "databaseId,name,conclusion,status,headBranch,url,displayTitle"],
    releases: ["release", "list", "--limit", "5", "--json", "tagName,name,isDraft,isPrerelease"],
  }
  for (const [action, argv] of Object.entries(cases)) {
    const spy = stubSpawn({ status: 0, stdout: "[]", stderr: "", error: null })
    const r = ghInspect({ action, spawn: spy })
    ok(`${action}: spawns gh`, spy.calls[0]?.cmd === "gh", JSON.stringify(spy.calls[0]?.cmd))
    eq(`${action}: exact argv`, spy.calls[0]?.args, argv)
    ok(`${action}: ok with evidence`, r.ok === true && r.action === action)
  }
}

console.log("== ghInspect builds argv for id actions and validates the id ==")
{
  const idCases = {
    issue: (id) => ["issue", "view", id, "--json", "number,title,state,body,url,comments"],
    pr: (id) => ["pr", "view", id, "--json", "number,title,state,url,body,statusCheckRollup,reviews,headRefName"],
    checks: (id) => ["pr", "checks", id],
    run: (id) => ["run", "view", id, "--json", "conclusion,status,url,displayTitle,name"],
  }
  for (const [action, argv] of Object.entries(idCases)) {
    const spy = stubSpawn({ status: 0, stdout: "{}", stderr: "", error: null })
    ghInspect({ action, id: "12", spawn: spy })
    eq(`${action} 12: substitutes the id in argv`, spy.calls[0]?.args, argv("12"))

    const missing = ghInspect({ action, spawn: stubSpawn({ status: 0 }) })
    ok(`${action}: refuses a missing id (never spawns)`, missing.ok === false && /id/i.test(missing.preview), missing.preview)
  }

  // a ref-shaped id (branch) is allowed by ID_OK for run/checks
  const spy = stubSpawn({ status: 0, stdout: "", stderr: "", error: null })
  ghInspect({ action: "run", id: "feature/x-1.2", spawn: spy })
  eq("run accepts a safe ref id", spy.calls[0]?.args?.[2], "feature/x-1.2")
}

console.log("== ghInspect is fail-closed against injection and unknown actions ==")
{
  const inj = ghInspect({ action: "pr", id: "1; rm -rf /", spawn: stubSpawn({ status: 0 }) })
  ok("shell-metacharacter id refused, no spawn", inj.ok === false && /safe id/i.test(inj.preview), inj.preview)

  const spc = ghInspect({ action: "issue", id: "1 2", spawn: stubSpawn({ status: 0 }) })
  ok("id with a space refused", spc.ok === false, spc.preview)

  const long = ghInspect({ action: "issue", id: "1".repeat(81), spawn: stubSpawn({ status: 0 }) })
  ok("over-long id refused", long.ok === false, long.preview)

  const write = ghInspect({ action: "pr merge", id: "1", spawn: stubSpawn({ status: 0 }) })
  ok("a write-shaped action is not in the read allowlist", write.ok === false && /unknown github action/i.test(write.preview), write.preview)

  // an injected id must never reach argv, even if validation were bypassed:
  const spy = stubSpawn({ status: 0 })
  ghInspect({ action: "pr", id: "$(whoami)", spawn: spy })
  ok("injection id never spawns gh", spy.calls.length === 0)
}

console.log("== ghInspect reports gh failures honestly (never a fake pass) ==")
{
  const nonzero = ghInspect({ action: "repo", spawn: stubSpawn({ status: 1, stdout: "", stderr: "could not resolve to a Repository", error: null }) })
  ok("gh non-zero exit → not ok, stderr surfaced", nonzero.ok === false && /Repository/.test(nonzero.preview), nonzero.preview)
  eq("failed inspect carries no evidence facts", nonzero.facts, [])

  const enoent = ghInspect({ action: "repo", spawn: stubSpawn({ error: new Error("spawn gh ENOENT"), status: null }) })
  ok("spawn error → not on PATH, not ok", enoent.ok === false && /not on PATH/i.test(enoent.preview), enoent.preview)

  const threw = ghInspect({ action: "repo", spawn: () => { throw new Error("boom") } })
  ok("a thrown spawn is caught, never crashes", threw.ok === false && /boom/.test(threw.preview), threw.preview)
}

console.log("== ghInspect status action probes auth without an argv template ==")
{
  const st = ghInspect({ action: "status", spawn: stubSpawn({ status: 0, stdout: "Logged in", stderr: "", error: null }) })
  ok("status ok yields a github-auth fact", st.ok === true && st.facts.some((f) => f.kind === "github-auth" && f.value === "ok"), JSON.stringify(st.facts))
  const stBad = ghInspect({ action: "status", spawn: stubSpawn({ status: 1, stdout: "", stderr: "x", error: null }) })
  ok("status failure is honest", stBad.ok === false && stBad.facts.some((f) => f.kind === "github-auth"), JSON.stringify(stBad.facts))
}

console.log("== evidence facts are derived from real gh output ==")
{
  const ci = ghInspect({ action: "runs", spawn: stubSpawn({ status: 0, stdout: '[{"conclusion":"failure","status":"completed"}]', stderr: "", error: null }) })
  ok("a CI failure in output becomes a github-ci fact", ci.facts.some((f) => f.kind === "github-ci"), JSON.stringify(ci.facts))

  const refs = ghInspect({ action: "issues", spawn: stubSpawn({ status: 0, stdout: '[{"number":1},{"number":2},{"number":3}]', stderr: "", error: null }) })
  ok("numbered items become a github-refs fact", refs.facts.some((f) => f.kind === "github-refs" && /3/.test(f.value)), JSON.stringify(refs.facts))

  const clean = ghInspect({ action: "repo", spawn: stubSpawn({ status: 0, stdout: '{"name":"forge"}', stderr: "", error: null }) })
  ok("clean output has the base github fact and no CI-failure fact", clean.facts.some((f) => f.kind === "github") && !clean.facts.some((f) => f.kind === "github-ci"), JSON.stringify(clean.facts))
  ok("facts are bounded to <= 6", clean.facts.length <= 6)
}

console.log("== preview is bounded and the wire never sees a raw firehose ==")
{
  const big = ghInspect({ action: "repo", spawn: stubSpawn({ status: 0, stdout: "x".repeat(10000), stderr: "", error: null }) })
  ok("preview is capped (<= 4000 chars)", big.preview.length <= 4000, String(big.preview.length))
  const spy = stubSpawn({ status: 0, stdout: "", stderr: "", error: null })
  ghInspect({ action: "repo", spawn: spy })
  ok("spawn is given a timeout and a maxBuffer cap", Number(spy.calls[0]?.opts?.timeout) > 0 && Number(spy.calls[0]?.opts?.maxBuffer) > 0, JSON.stringify(spy.calls[0]?.opts))
}

console.log("== formatGithub renders evidence vs unavailable ==")
{
  ok("empty inspect → empty string", formatGithub(null) === "" && formatGithub(undefined) === "")
  const good = formatGithub({ ok: true, action: "repo", preview: "name forge" })
  ok("ok inspect labelled as evidence", /GITHUB \(evidence\): repo/.test(good), good)
  const bad = formatGithub({ ok: false, action: "pr", preview: "nope" })
  ok("failed inspect labelled unavailable", /GITHUB \(unavailable\): pr/.test(bad), bad)
}

console.log("== task routing: GitHub is implied only when the task is GitHub ==")
{
  for (const t of ["fix the failing GitHub Action on PR 12", "why is CI red on #7", "check the dependabot PR", "look at issue #3", "review the workflow run"]) {
    ok(`implied: "${t.slice(0, 32)}…"`, githubImpliedByTask(t) === true)
  }
  for (const t of ["rename the function", "add a unit test", "typo fix teh readme"]) {
    ok(`not implied: "${t}"`, githubImpliedByTask(t) === false)
  }

  eq("PR 12 routes to pr/12", (() => { const a = actionForTask("review pull request 12"); return [a.action, a.id] })(), ["pr", "12"])
  eq("issue #3 routes to issue/3", (() => { const a = actionForTask("look at issue #3"); return [a.action, a.id] })(), ["issue", "3"])
  ok("CI + number routes to checks", (() => { const a = actionForTask("why is CI failing on #9"); return a.action === "checks" && a.id === "9" })())
  ok("CI without a number routes to runs", actionForTask("why is CI failing").action === "runs")
  ok("release task routes to releases", actionForTask("cut the next release").action === "releases")
  ok("a bare repo task defaults to repo", actionForTask("what is this repository").action === "repo")
}

console.log(`\n== github-cli suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
