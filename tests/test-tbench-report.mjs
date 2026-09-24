#!/usr/bin/env node
/**
 * forge v149 — reading Terminal-Bench results, and keeping the two halves of
 * the integration (Node CLI, Python adapter) from drifting apart.
 *
 * The fixtures under tests/fixtures/harbor-jobs are trimmed copies of jobs
 * harbor 0.23.0 actually wrote (see their README); `derived-mixed` adds
 * hand-made trials for the cases a stub run cannot produce.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0, SKIP = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const skip = (name, why) => { SKIP++; console.log(`  skip ${name} — ${why}`) }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const FIX = path.join(HERE, "fixtures", "harbor-jobs")
const TB = await import("../tbench.js")
const { getCatalog } = await import("../providers.js")
// The Harbor-free logic (provider table, run command, pinned Node) lives in
// core.py; the BaseInstalledAgent subclass in agent.py. Checked as one.
const ADAPTER = ["core.py", "agent.py"].map((f) => fs.readFileSync(path.join(ROOT, "integrations", "harbor", "forge_harbor", f), "utf8")).join("\n")
const FORGE_SRC = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
const forge = (...args) => spawnSync(process.execPath, [path.join(ROOT, "forge.js"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: os.tmpdir() } })

console.log("== a real Terminal-Bench 2.0 job ==")
{
  const r = TB.readHarborJob(path.join(FIX, "tb2-real"))
  eq("dataset", r.dataset, "terminal-bench@2.0")
  ok("recognized as forge's adapter", r.isForge && r.agent === TB.HARBOR_AGENT, r.agent)
  eq("model", r.model, "anthropic/stub-model")
  eq("tasks", r.tasks.map((t) => t.task), ["fix-git", "log-summary-date-ranges", "regex-log"])
  eq("solved", [r.summary.tasksSolved, r.summary.tasks], [0, 3])
  eq("every trial is a false completion — the stub claims done and does nothing", r.summary.falseCompletions, 3)
  eq("errors", r.summary.errors, 0)
  eq("tokens summed from Harbor's agent_result", [r.summary.inputTokens, r.summary.cacheTokens, r.summary.outputTokens], [510, 120, 90])
  eq("cost unknown stays unknown", r.summary.costUsd, null)
  ok("finished", r.finished)
}

console.log("== the verifier decides, not the agent ==")
{
  const r = TB.readHarborJob(path.join(FIX, "smoke"))
  eq("a local -p run is labelled by its path", r.dataset, "local:tests/harbor-tasks")
  const by = Object.fromEntries(r.trials.map((t) => [t.task, t]))
  eq("both trials: forge said COMPLETED", [by["forge-smoke-pass"].forgeStatus, by["forge-smoke-fail"].forgeStatus], ["COMPLETED", "COMPLETED"])
  eq("…the tests passed one", [by["forge-smoke-pass"].solved, by["forge-smoke-fail"].solved], [true, false])
  eq("…so exactly one false completion", r.summary.falseCompletions, 1)
  eq("mean reward", r.summary.meanReward, 0.5)
}

console.log("== one task given with -p ==")
{
  // Harbor records a single local task under `tasks`, not `datasets`.
  const r = TB.readHarborJob(path.join(FIX, "single-task"))
  eq("labelled by its path", r.dataset, "local:tests/harbor-tasks/forge-smoke-nonode")
  eq("solved on an image with no Node (the adapter brought one)", [r.summary.tasksSolved, r.summary.tasks], [1, 1])
}

console.log("== errors, attempts and partial costs ==")
{
  const r = TB.readHarborJob(path.join(FIX, "derived-mixed"))
  eq("4 trials over 3 tasks", [r.summary.trials, r.summary.tasks], [4, 3])
  const pass = r.tasks.find((t) => t.task === "forge-smoke-pass")
  eq("a task passed in either of two attempts is solved (pass@k)", [pass.attempts, pass.solved], [2, true])
  eq("tasks solved", r.summary.tasksSolved, 1)
  const crash = r.trials.find((t) => t.task === "forge-smoke-crash")
  eq("an errored trial has no reward", crash.reward, null)
  eq("…is unsolved", crash.solved, false)
  eq("…and names the error", crash.error, "NonZeroAgentExitCodeError")
  eq("errors counted", r.summary.errors, 1)
  // An error is a failed task, never one dropped from the denominator.
  eq("mean over ALL trials, the error as 0: (1+0+0+0)/4", r.summary.meanReward, 0.25)
  eq("an error is not a false completion — forge never claimed anything", r.summary.falseCompletions, 2)
  // One trial knew its cost, three did not: a partial sum would read as a total.
  eq("cost known for only some trials → null, not a partial sum", r.summary.costUsd, null)
  eq("…while that trial's own cost is kept", r.trials.find((t) => t.trial === "forge-smoke-pass__attempt2").costUsd, 0.42)
  eq("tokens: an unknown count adds nothing, not NaN", r.summary.inputTokens, 510 * 3)
}

console.log("== the report ==")
{
  const txt = TB.formatHarborJob(TB.readHarborJob(path.join(FIX, "derived-mixed")))
  ok("false completions are named per trial", /forge-smoke-fail\s+forge COMPLETED, 3 steps\s+← false completion/.test(txt), txt)
  ok("errors are marked ERR with their type", /ERR\s+forge-smoke-crash\s+NonZeroAgentExitCodeError: forge exited 1/.test(txt))
  ok("the error rule is stated", /errors counted as 0/.test(txt))
  ok("attempts are stated as the most any task got (uneven: 2, 1, 1)", /solved in any of up to 2 attempts per task/.test(txt), txt.split("\n")[2])
  ok("…and not claimed for a single-attempt job", !/attempts/.test(TB.formatHarborJob(TB.readHarborJob(path.join(FIX, "tb2-real"))).split("\n")[2]))
  ok("an unknown cost says why", /unknown \(forge carries no price table\)/.test(txt))
  const r = TB.readHarborJob(path.join(FIX, "smoke"))
  ok("a job still running says its numbers are partial", /NOT FINISHED/.test(TB.formatHarborJob({ ...r, finished: false })))
  const other = TB.formatHarborJob({ ...r, isForge: false, agent: "claude-code" })
  ok("another agent's job is reported, and labelled", /agent: claude-code — not forge's adapter/.test(other))
  ok("…without forge-only claims", !/false completion/.test(other))
  const j = JSON.parse(TB.formatHarborJob(r, { json: true }))
  eq("--json round-trips", j.summary.tasksSolved, 1)
  let threw = null
  try { TB.readHarborJob(os.tmpdir()) } catch (e) { threw = e.message }
  ok("a directory that is not a job says so", /not a Harbor job directory/.test(threw ?? ""), threw)
}

console.log("== the CLI ==")
{
  const how = forge("tbench")
  eq("forge tbench exits 0", how.status, 0)
  ok("…and gives the command, with the adapter and the dataset", how.stdout.includes(TB.HARBOR_AGENT) && how.stdout.includes(TB.DEFAULT_DATASET) && how.stdout.includes(TB.harborAdapterDir()))
  ok("…and says a run costs real tokens", /spends real tokens/.test(how.stdout))
  const rep = forge("tbench", "report", path.join(FIX, "tb2-real"))
  eq("forge tbench report exits 0", rep.status, 0)
  ok("…and reports", /tasks solved\s+0\/3/.test(rep.stdout), rep.stdout)
  eq("report without a directory exits 1", forge("tbench", "report").status, 1)
  eq("an unknown subcommand exits 1", forge("tbench", "nope").status, 1)
  const js = forge("tbench", "report", path.join(FIX, "smoke"), "--json")
  ok("--json is JSON", (() => { try { return JSON.parse(js.stdout).summary.trials === 2 } catch { return false } })(), js.stdout.slice(0, 200))
}

console.log("== the Python adapter agrees with forge ==")
{
  // The provider table lives in Python; the provider catalog lives in Node.
  // Parse one and check it against the other, so a rename on either side
  // fails here instead of in a paid benchmark run.
  const table = ADAPTER.slice(ADAPTER.indexOf("PROVIDER_MAP"), ADAPTER.indexOf("}", ADAPTER.indexOf("PROVIDER_MAP")))
  const rows = [...table.matchAll(/"([\w-]+)":\s*\("([\w-]+)",\s*"(\w+)"\)/g)].map((m) => ({ harbor: m[1], forge: m[2], env: m[3] }))
  ok("the table parsed", rows.length >= 10, String(rows.length))
  for (const r of rows) {
    const c = getCatalog(r.forge)
    ok(`${r.harbor} → forge "${r.forge}" exists`, !!c)
    eq(`${r.harbor} → the key forge reads for ${r.forge}`, r.env, c?.envKey ?? null)
  }
  // Harbor aliases gemini → google and together_ai → together BEFORE the
  // lookup; keying the table by the alias would miss every Gemini run.
  ok("keyed by Harbor's canonical names", rows.some((r) => r.harbor === "google") && !rows.some((r) => r.harbor === "gemini" || r.harbor === "together_ai"))

  // Every flag the adapter passes must be one forge handles.
  const cmd = ADAPTER.slice(ADAPTER.indexOf("def build_run_command"), ADAPTER.indexOf("def context_from_result"))
  const flags = [...new Set([...cmd.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]))]
  ok("flags found", flags.length >= 6, flags.join(" "))
  for (const f of flags) {
    const key = f.slice(2)
    ok(`forge handles ${f}`, new RegExp(`flags(\\.${key.replace(/-/g, "_")}\\b|\\["${key}"\\])`).test(FORGE_SRC) || new RegExp(`"${key}"`).test(FORGE_SRC.slice(0, FORGE_SRC.indexOf("function parseArgs"))), f)
  }
  ok("the instruction comes after --, so task text cannot become a flag", /args \+= \["--", instruction\]/.test(cmd))
  ok("the key goes in the environment, never on the command line", !/"--key"/.test(cmd))

  // The pinned Node.
  const ver = /NODE_VERSION = "v(\d+)\.\d+\.\d+"/.exec(ADAPTER)
  const min = Number(/MIN_NODE_MAJOR = (\d+)/.exec(ADAPTER)?.[1])
  ok("the pinned Node meets the adapter's own minimum", ver && Number(ver[1]) >= min, `${ver?.[0]} vs ${min}`)
  ok("…and forge's engines field", ver && Number(ver[1]) >= Number(/>=\s*(\d+)/.exec(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node ?? "")?.[1] ?? 0))
  const hashes = [...ADAPTER.matchAll(/"(x64|arm64)": "([0-9a-f]+)"/g)]
  eq("a sha256 for each architecture", hashes.map((h) => [h[1], h[2].length]), [["x64", 64], ["arm64", 64]])
}

console.log("== it ships ==")
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  for (const f of ["tbench.js", "integrations/harbor/forge_harbor/__init__.py", "integrations/harbor/forge_harbor/agent.py", "integrations/harbor/forge_harbor/core.py"]) {
    ok(`package.json files[] has ${f}`, pkg.files.includes(f))
  }
  // An `npm i -g` install must be able to print a working adapter path.
  ok("harborAdapterDir() points at the package's own copy", fs.existsSync(path.join(TB.harborAdapterDir(), "forge_harbor", "agent.py")))
}

console.log("== the adapter's own tests ==")
{
  // Two halves (tests/test_harbor_adapter.py). The CORE — provider table,
  // pinned Node and its hash check, run command — needs only python3 and
  // always runs. The AGENT half needs harbor (Python >= 3.12), which is not a
  // forge dependency: set FORGE_HARBOR_PYTHON to a Python that has it.
  const py = [process.env.FORGE_HARBOR_PYTHON, "python3"].filter(Boolean)
    .find((p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"], { encoding: "utf8" }).status === 0)
  if (!py) skip("tests/test_harbor_adapter.py", "no python3 >= 3.8 on PATH")
  else {
    const r = spawnSync(py, [path.join(HERE, "test_harbor_adapter.py")], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: os.tmpdir(), PYTHONPATH: path.join(ROOT, "integrations", "harbor") },
    })
    const out = r.stdout ?? ""
    const last = out.trim().split("\n").pop()
    ok(`adapter tests pass (${last})`, r.status === 0, `${out.slice(-800)}\n${(r.stderr ?? "").slice(-800)}`)
    ok("the core half ran — it is never skipped", /#### CORE/.test(out))
    const skipped = /harbor half: skipped — (.*)/.exec(out)
    if (skipped) skip("adapter's harbor half", `${skipped[1]} (set FORGE_HARBOR_PYTHON)`)
    else ok("the harbor half ran against the real base classes", /#### AGENT/.test(out))
  }
}

console.log(`\n== tbench-report suite: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==`)
process.exit(FAIL ? 1 : 0)
