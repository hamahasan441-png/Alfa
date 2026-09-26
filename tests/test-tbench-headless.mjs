#!/usr/bin/env node
/**
 * forge v149 — the headless contract a benchmark harness drives forge by.
 *
 * Terminal-Bench (via Harbor) installs an agent in a fresh container and runs
 * it with the task text, stdin closed, and nothing but a provider key in the
 * environment. It judges the result by running the task's own tests. So the
 * agent has to: start without a wizard, run to an end on its own, say how it
 * ended in a form a program can read, and never mistake which model it is.
 *
 * Every forge run here is under `env -i`: measured while building this, a run
 * that inherited the host environment picked github-models off a stray
 * GITHUB_TOKEN and sent it a request. A test must not be able to do that.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const FORGE = path.join(ROOT, "forge.js")
const { VERSION } = await import("../version.js")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-headless-"))

/** Start the stub model; resolves with { port, stop }. */
function startStub(env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, "tbench-stub-model.mjs"), "0"], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    p.stdout.on("data", (c) => {
      out += c
      const m = /listening (\d+)/.exec(out)
      if (m) resolve({ port: Number(m[1]), stop: () => new Promise((r) => { p.once("exit", r); p.kill() }) })
    })
    p.once("error", reject)
    setTimeout(() => reject(new Error("stub did not start")), 10000)
  })
}

/** Run `forge agent` headless in a clean environment. Async, so the stub keeps serving. */
function forgeAgent(args, { env = {}, cwd, timeoutMs = 90000 } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"))
  const work = cwd ?? fs.mkdtempSync(path.join(TMP, "work-"))
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [FORGE, "agent", ...args], {
      cwd: work, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    p.stdout.on("data", (c) => { out += c })
    p.stderr.on("data", (c) => { out += c })
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs)
    p.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, work, ms: Date.now() - t0 }) })
  })
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Spawn `forge agent` and hand back the live process (v151: signals, mid-run reads). */
function forgeSpawn(args, { env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"))
  const work = fs.mkdtempSync(path.join(TMP, "work-"))
  const child = spawn(process.execPath, [FORGE, "agent", ...args], {
    cwd: work, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", (c) => { out += c })
  child.stderr.on("data", (c) => { out += c })
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })))
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000)
  exited.then(() => clearTimeout(timer))
  return { child, work, exited, out: () => out }
}

const stub = await startStub()
const base = `http://127.0.0.1:${stub.port}`
const common = (res, extra = []) => ["--headless", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", base, "--result-json", res, ...extra]
const KEY = { ANTHROPIC_API_KEY: "stub-key" }

try {
  console.log("== a task runs to completion, unattended ==")
  {
    const res = path.join(TMP, "ok.json")
    const r = await forgeAgent([...common(res), "--", "Create it. STUB_RUN: echo hello-from-forge > out.txt"], { env: KEY })
    eq("exit 0", r.code, 0)
    ok("the tool actually ran in the working directory", fs.existsSync(path.join(r.work, "out.txt")) && fs.readFileSync(path.join(r.work, "out.txt"), "utf8").trim() === "hello-from-forge", r.out.slice(-400))
    ok("no wizard, no question", !/onboard|welcome|choose a provider|\[y\/N\]/i.test(r.out), r.out.slice(0, 300))
    const j = readJson(res)
    ok("a result file was written", j !== null)
    eq("schema", j?.schema, "forge.agent-result/1")
    eq("forge version", j?.forge, VERSION)
    // v202: it wrote out.txt and ran no check — finished, not proven
    eq("status", j?.status, "COMPLETED_UNVERIFIED")
    eq("provider and model are the ones asked for", [j?.provider, j?.model], ["anthropic", "stub-model"])
    eq("one tool call", j?.toolCalls, 1)
    ok("steps counted", j?.steps >= 1, String(j?.steps))
    // The stub bills 120 fresh + 40 cache read + 10 cache write per call. forge
    // normalizes input as fresh + read + write, the convention Harbor reports.
    const calls = j?.usage?.inputTokens / 170
    ok("input tokens = all input, cache included", Number.isInteger(calls) && calls >= 1, JSON.stringify(j?.usage))
    eq("cache reads broken out", j?.usage?.cacheReadTokens, 40 * calls)
    eq("cache writes broken out", j?.usage?.cacheWriteTokens, 10 * calls)
    eq("output tokens", j?.usage?.outputTokens, 30 * calls)
    eq("not estimated — the provider reported usage", j?.usage?.estimated, false)
    eq("cost is null: forge has no price table and does not guess", j?.costUsd, null)
    eq("no error", [j?.error, j?.exitCode], [null, 0])
  }

  console.log("== --headless does not swallow the task ==")
  {
    // headless is a boolean flag. Before it was registered as one, the parser
    // took the next word as its VALUE — `forge agent --headless "fix it"` ran
    // with no task at all.
    const res = path.join(TMP, "noswallow.json")
    const r = await forgeAgent(["--headless", "STUB_RUN: echo swallowed-not > s.txt", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", base, "--result-json", res], { env: KEY })
    eq("exit 0", r.code, 0)
    ok("the task after --headless was the task", fs.existsSync(path.join(r.work, "s.txt")), r.out.slice(-300))
  }

  console.log("== the model is named, never inferred ==")
  {
    for (const [args, want] of [
      [[], /--provider and --model required/],
      [["--provider", "anthropic"], /--model required/],
      [["--model", "m"], /--provider required/],
    ]) {
      const res = path.join(TMP, `name-${args.length}.json`)
      // A GITHUB_TOKEN in the environment is exactly the trap: without the
      // rule, resolution would pick github-models off it.
      const r = await forgeAgent(["--headless", ...args, "--result-json", res, "--", "x"], { env: { ...KEY, GITHUB_TOKEN: "ghp_not_a_real_token" }, timeoutMs: 20000 })
      eq(`[${args.join(" ")}] exits 2`, r.code, 2)
      ok(`[${args.join(" ")}] says what is missing`, want.test(r.out), r.out.slice(-200))
      ok(`[${args.join(" ")}] never reached a provider`, !/github-models/.test(r.out))
      eq(`[${args.join(" ")}] result says ERROR`, readJson(res)?.status, "ERROR")
    }
    const nokey = await forgeAgent(["--headless", "--provider", "anthropic", "--model", "m", "--", "x"], { timeoutMs: 20000 })
    eq("a missing key exits 2 before any request", nokey.code, 2)
    ok("…naming the variable to set", /set ANTHROPIC_API_KEY/.test(nokey.out), nokey.out.slice(-200))
    const unknown = await forgeAgent(["--headless", "--provider", "no-such-provider", "--model", "m", "--", "x"], { timeoutMs: 20000 })
    eq("an unknown provider exits 2", unknown.code, 2)
    ok("…and says so", /unknown provider "no-such-provider"/.test(unknown.out), unknown.out.slice(-200))
    ok("refusals are fast (no network, no retries)", nokey.ms < 15000 && unknown.ms < 15000, `${nokey.ms}ms ${unknown.ms}ms`)
  }

  console.log("== a run that hits its budget ends, and says how ==")
  {
    const loop = await startStub({ STUB_LOOP: "1" })
    try {
      const res = path.join(TMP, "budget.json")
      const r = await forgeAgent(["--headless", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", `http://127.0.0.1:${loop.port}`, "--max-steps", "3", "--result-json", res, "--", "STUB_RUN: date +%s%N"], { env: KEY })
      // Exit 0: the run reached an end. Whether the task was solved is the
      // verifier's call — a harness that treated INCOMPLETE as a crash would
      // score an agent that stopped honestly the same as one that died.
      eq("exit 0 on an honest stop", r.code, 0)
      const j = readJson(res)
      eq("status INCOMPLETE", j?.status, "INCOMPLETE")
      ok("the step cap held", j?.steps <= 3 + 2, String(j?.steps))
    } finally { await loop.stop() }
    for (const bad of ["0", "-1", "abc", "1.5", "999999"]) {
      const res = path.join(TMP, `ms-${bad}.json`)
      const r = await forgeAgent(["--headless", "--provider", "anthropic", "--model", "m", "--max-steps", bad, "--result-json", res, "--", "x"], { env: KEY, timeoutMs: 20000 })
      eq(`--max-steps ${bad} exits 2`, r.code, 2)
    }
  }

  console.log("== v151: the result is kept current while the run goes ==")
  {
    // Measured through Harbor at v150: a task that hit its agent timeout
    // after 21 steps was reported with no tokens at all — Harbor cancels the
    // exec from outside and reads the file, and forge only wrote it at the end.
    const loop = await startStub({ STUB_LOOP: "1" })
    try {
      const res = path.join(TMP, "live.json")
      const run = forgeSpawn(["--headless", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", `http://127.0.0.1:${loop.port}`, "--max-steps", "500", "--result-json", res, "--", "STUB_RUN: sleep 0.1; date +%s%N"], { env: KEY })
      // Read it as fast as a harness might, the whole time it is being
      // rewritten: never a partial file (it is written aside and renamed).
      let reads = 0, bad = 0, live = null
      const until = Date.now() + 20000
      while (Date.now() < until) {
        if (fs.existsSync(res)) {
          reads++
          const j = readJson(res)
          if (!j) bad++
          else if (j.status === "RUNNING" && j.steps >= 3) { live = j; if (reads > 150) break }
        }
        await sleep(5)
      }
      ok("mid-run, the file says RUNNING", live?.status === "RUNNING", JSON.stringify(live))
      ok("…with the steps reached so far", live?.steps >= 3, String(live?.steps))
      ok("…the tool calls", live?.toolCalls >= 2, String(live?.toolCalls))
      ok("…and the tokens spent so far", live?.usage?.inputTokens > 0 && live?.usage?.outputTokens > 0, JSON.stringify(live?.usage))
      eq("…and no exit code yet — it has not ended", live?.exitCode, null)
      ok(`never caught half-written (${reads} reads during the run, ${bad} unparseable)`, reads > 50 && bad === 0, `${reads} reads, ${bad} bad`)

      // SIGTERM: the one a harness sends before it kills.
      const before = readJson(res)?.steps ?? 0
      run.child.kill("SIGTERM")
      const { code, signal } = await run.exited
      eq("SIGTERM exits 143 (128 + 15), by forge's own hand", [code, signal], [143, null])
      const j = readJson(res)
      eq("the final record says ABORTED", j?.status, "ABORTED")
      eq("…and why", j?.reason, "signal SIGTERM")
      eq("…with the exit code it used", j?.exitCode, 143)
      ok("…and everything it had spent", j?.steps >= before && j?.usage?.inputTokens > 0, JSON.stringify({ steps: j?.steps, before, usage: j?.usage }))
      eq("no temp file left beside it", fs.readdirSync(TMP).filter((f) => f.startsWith("live.json.")), [])
    } finally { await loop.stop() }

    for (const [sig, code] of [["SIGHUP", 129], ["SIGINT", 130]]) {
      const loop2 = await startStub({ STUB_LOOP: "1" })
      try {
        const res = path.join(TMP, `sig-${sig}.json`)
        const run = forgeSpawn(["--headless", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", `http://127.0.0.1:${loop2.port}`, "--max-steps", "500", "--result-json", res, "--", "STUB_RUN: sleep 0.1; date +%s%N"], { env: KEY })
        const until = Date.now() + 20000
        while (Date.now() < until && !(readJson(res)?.steps >= 2)) await sleep(20)
        run.child.kill(sig)
        const r = await run.exited
        eq(`${sig} → exit ${code}, ABORTED`, [r.code, readJson(res)?.status, readJson(res)?.reason], [code, "ABORTED", `signal ${sig}`])
      } finally { await loop2.stop() }
    }
  }

  console.log("== v151: a plan that stops is not left RUNNING ==")
  {
    // Plan mode (not headless) ends after the plan when nobody can approve it.
    // With the file now written during the run, that clean exit must leave a
    // final record, not a RUNNING one that reads like a run cut off.
    const res = path.join(TMP, "plan-only.json")
    const r = await forgeAgent(["--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", base, "--result-json", res, "--plan", "STUB_RUN: ls"], { env: KEY })
    eq("exit 0", r.code, 0)
    eq("status PLAN_ONLY", readJson(res)?.status, "PLAN_ONLY")
  }

  console.log("== provider errors are errors ==")
  {
    const res = path.join(TMP, "401.json")
    const r = await forgeAgent([...common(res), "--", "STUB_RUN: true"], { env: { ANTHROPIC_API_KEY: "wrong-key" } })
    eq("a rejected key exits 1", r.code, 1)
    const j = readJson(res)
    eq("result says ERROR", j?.status, "ERROR")
    ok("with the provider's reason", /401/.test(j?.error ?? ""), j?.error)
    eq("…and the provider it was using", j?.provider, "anthropic")
  }

  console.log("== plan mode is refused, not hung ==")
  {
    const res = path.join(TMP, "plan.json")
    const r = await forgeAgent([...common(res), "--plan", "--", "STUB_RUN: true"], { env: KEY, timeoutMs: 20000 })
    eq("exit 2", r.code, 2)
    ok("says why", /--plan needs a person/.test(r.out), r.out.slice(-200))
  }

  console.log("== without --result-json nothing is written ==")
  {
    const r = await forgeAgent(["--headless", "--yolo", "--provider", "anthropic", "--model", "stub-model", "--base-url", base, "--", "STUB_RUN: echo x > y.txt"], { env: KEY })
    eq("exit 0", r.code, 0)
    const stray = fs.readdirSync(r.work).filter((f) => f.endsWith(".json"))
    eq("no stray result file in the workspace", stray, [])
  }

  console.log("== the source says what it means ==")
  {
    const src = fs.readFileSync(FORGE, "utf8")
    ok("headless is a boolean flag", /const BOOLEAN_FLAGS = new Set\(\[[^\]]*"headless"/.test(src))
    ok("headless never calls the onboarding wizard", /(?:const|let) cfg = headless \? config : await onboardIfMissing\(config\)/.test(src))
    ok("the unattended desktop notification is skipped headless", /if \(!headless\) await notifyIfUnattended/.test(src))
    // v151: once the final record is written, a late signal must not replace
    // COMPLETED with ABORTED.
    ok("the final write removes the signal handlers", /const finalResult = \(fields\) => \{\s*finalWritten = true\s*for \(const sig of trapped\) process\.removeListener\(sig, onSignal\)/.test(src))
    ok("SIGINT is trapped only headless — in a terminal Ctrl+C is the console's", /headless \? \["SIGTERM", "SIGHUP", "SIGINT"\] : \["SIGTERM", "SIGHUP"\]/.test(src))
    ok("the result file is written aside and renamed", /fs\.writeFileSync\(tmp, [\s\S]{0,80}\n\s*fs\.renameSync\(tmp, file\)/.test(src))
  }
} finally {
  await stub.stop()
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== tbench-headless suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
