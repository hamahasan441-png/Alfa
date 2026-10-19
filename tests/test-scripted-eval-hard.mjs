#!/usr/bin/env node
/**
 * forge — the harder scripted scenarios (s9–s20), both engines.
 *
 * Runs `node scripts/scripted-eval.mjs --only s9,…,s20 --json --out FILE`:
 * the same scripted OpenAI-compatible model, temp projects and one child
 * process per run as the base eval, and asserts that every run is CORRECT by
 * the scenario's own judge (on disk, by the harness's own test run, never by
 * what forge or the model says), plus a few properties that state the
 * measured failure each scenario was added for:
 *
 *   s9   an edit whose old text does not match is answered as an error, and the run recovers
 *   s10  three 429s with Retry-After 0.05 s: done in seconds (it waited 60 s per request after two)
 *   s11  a test that prints ~400 KB: no request to the model is over 40k tokens
 *   s12  malformed tool-call JSON is answered as an error, and the run recovers
 *   s13  an unknown tool name is answered as an error, and the run recovers
 *   s14  a hanging test command is cut by the shell timeout and reported as a timeout
 *   s15  a test rewritten to always pass is never COMPLETED (it was, on both engines)
 *   s16  an answer cut mid-stream is retried
 *   s17  "all tests pass" over a red run is never COMPLETED
 *   s18  a 91-step task completes (the single loop called f1.txt in docs/ "missing")
 *   s19  told the test was weakened, the model restores it and fixes the code: COMPLETED
 *   s20  a test change the task asks for is not "weakening": COMPLETED
 *
 * Exact call/token counts and wall times are REPORTED, never asserted (s10's
 * bound is two orders of magnitude above the measured time).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const SCRIPT = path.join(ROOT, "scripts", "scripted-eval.mjs")
const ONLY = ["s9", "s10", "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19", "s20"]

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-scripted-eval-hard-"))
const OUT = path.join(TMP, "report.json")
const concurrency = os.freemem() > 2 * 1024 ** 3 && (os.cpus()?.length || 1) >= 2 ? 2 : 1

try {
  console.log(`== node scripts/scripted-eval.mjs --only ${ONLY.join(",")} (concurrency ${concurrency}) ==`)
  const t0 = Date.now()
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--json", "--out", OUT, "--only", ONLY.join(","), "--concurrency", String(concurrency)], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let err = ""
    child.stdout.on("data", () => { })
    child.stderr.on("data", (d) => { err += d })
    const timer = setTimeout(() => child.kill("SIGKILL"), 420_000)
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, err }) })
  })
  ok(`the script exits 0 (${((Date.now() - t0) / 1000).toFixed(1)}s)`, run.code === 0, `code=${run.code} signal=${run.signal} ${run.err.slice(-400)}`)
  let report = null
  try { report = JSON.parse(fs.readFileSync(OUT, "utf8")) } catch { report = null }
  ok("--out wrote a JSON report", report != null, run.err.slice(-300))
  if (!report) throw new Error("no report — nothing more to check")
  ok("twelve scenarios × two engines", report.rows.length === ONLY.length * 2 && ONLY.every((s) => ["single", "meta"].every((e) => report.rows.some((r) => r.scenario === s && r.engine === e))))
  try {
    const { formatReport } = await import(pathToFileURL(SCRIPT).href)
    console.log(formatReport(report).split("\n").map((l) => `  | ${l}`).join("\n"))
  } catch (e) { console.log(`  (could not render the table: ${e?.message})`) }

  console.log("== every run is correct by its own judge ==")
  for (const r of report.rows) ok(`${r.scenario}/${r.engine} ${r.name}: correct (${r.status})`, r.correct === true && !r.crashed, r.notes)

  console.log("== what each scenario was added for ==")
  const row = (s, e) => report.rows.find((r) => r.scenario === s && r.engine === e) ?? {}
  for (const e of ["single", "meta"]) {
    ok(`s10/${e}: three 429s cost seconds, not minutes`, Number(row("s10", e).ms) < 30_000, `ms=${row("s10", e).ms}`)
    ok(`s11/${e}: the model never got a 40k-token request`, Number(row("s11", e).checks?.maxPromptTokens) < 40_000, `max=${row("s11", e).checks?.maxPromptTokens}`)
    ok(`s15/${e}: a weakened test is never COMPLETED`, !["COMPLETED", "COMPLETED_UNVERIFIED"].includes(row("s15", e).status), row("s15", e).status)
    ok(`s17/${e}: "all tests pass" over a red run is never COMPLETED`, !["COMPLETED", "COMPLETED_UNVERIFIED"].includes(row("s17", e).status), row("s17", e).status)
    ok(`s19/${e}: restored + fixed is COMPLETED`, row("s19", e).status === "COMPLETED", row("s19", e).status)
    ok(`s20/${e}: an asked-for test change is COMPLETED`, row("s20", e).status === "COMPLETED", row("s20", e).status)
  }
  ok("s15/meta: the WAITING result says what it waits for", /Not completed/.test(row("s15", "meta").text ?? "") && /test integrity/.test(row("s15", "meta").text ?? ""), row("s15", "meta").text)
  ok("no false completion anywhere", report.findings.filter((f) => f.kind === "false-completion").length === 0, JSON.stringify(report.findings.filter((f) => f.kind === "false-completion")))
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== scripted-eval-hard suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
