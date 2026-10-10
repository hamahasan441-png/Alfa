#!/usr/bin/env node
/**
 * forge — audit: long-running tasks, recovery, durable state.
 *
 * Each block reproduces one audited defect and fails on the code before the
 * fix:
 *   Q2  a killed queue runner leaves its agent child running; reconcile said
 *       INTERRUPTED and retry started a SECOND agent on the same item
 *   R2  resume never restarted a plan node that was RUNNING at the crash
 *   R3  resume closed a crashed run's unverified edit as COMPLETED
 *   R1  a resumed task kept the crashed pid (offered for resume while live)
 *   S1  the supervisor restarted the task from scratch, on any non-zero exit
 *   Q1/T1 a queue/task file that fails to parse was silently replaced
 *   M1  concurrent processes erased each other's engineering-memory records
 *   T2  a kill mid-trim left the transcript torn/empty
 *   P1  Ctrl+C during provider backoff surfaced as the provider error
 * Namespace imports throughout: on old code a missing export is a FAIL line,
 * not a link error that hides every other case.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const mod = (f) => pathToFileURL(path.join(ROOT, f)).href
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-work-"))
process.chdir(WORK)

const ts = await import("../taskstate.js")
const Q = await import("../taskqueue.js")
const dag = await import("../dag.js")
const meta = await import("../meta.js")
const sup = await import("../supervisor.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v } catch {} await sleep(25) } return null }
const metaCfg = { providers: {}, agent: { autonomous: true, modelStrategy: false }, tools: {} }

// ---------------------------------------------------------------------------
console.log("== Q1: a corrupt queue file is moved aside, never overwritten ==")
{
  const dir = fs.mkdtempSync(path.join(HOME, "q1-"))
  const file = path.join(dir, "queue.json")
  for (const t of ["task A", "task B", "task C"]) Q.addItem(t, { file })
  const good = fs.readFileSync(file, "utf8")
  const torn = good.slice(0, good.length - 40)
  fs.writeFileSync(file, torn)
  let threw = null
  try { Q.addItem("task D", { file }) } catch (e) { threw = e }
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith("queue.json.corrupt-"))
  ok("the next add does not throw", !threw, threw?.message)
  ok("the corrupt queue is kept as queue.json.corrupt-<ts>", aside.length === 1, fs.readdirSync(dir).join(","))
  ok("…byte-for-byte", aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), "utf8") === torn)
  ok("the live queue holds the new item", Q.readQueue({ file }).items.map((i) => i.task).join() === "task D")
  // a plain read of a corrupt file also preserves it
  fs.writeFileSync(file, "{ not json")
  const r = Q.readQueue({ file })
  ok("readQueue of a corrupt file returns an empty queue", Array.isArray(r.items) && r.items.length === 0)
  ok("…and moves the file aside too", fs.readdirSync(dir).filter((f) => f.startsWith("queue.json.corrupt-")).length === 2)
  // an absent file is just empty — nothing quarantined
  const dir2 = fs.mkdtempSync(path.join(HOME, "q1b-"))
  Q.readQueue({ file: path.join(dir2, "queue.json") })
  ok("an absent queue is empty, nothing moved aside", fs.readdirSync(dir2).filter((f) => f.includes("corrupt")).length === 0)
}

console.log("== T1: a corrupt task record is moved aside, never overwritten ==")
{
  const t = ts.openTask("t-corrupt", { objective: "migrate DB to v2", cwd: WORK })
  t.setGoal({ original: "migrate DB to v2", constraints: [] }); t.noteVerification({ passed: true, command: "npm test" }); t.flush()
  const f = ts.taskFile("t-corrupt"); const s = fs.readFileSync(f, "utf8"); const half = s.slice(0, Math.floor(s.length / 2))
  fs.writeFileSync(f, half)
  ts.openTask("t-corrupt", { create: true, objective: "continue", cwd: WORK })
  const aside = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith("t-corrupt.json.corrupt-"))
  ok("the torn record is kept as <file>.corrupt-<ts>", aside.length === 1, fs.readdirSync(path.dirname(f)).join(","))
  ok("…with its original bytes (goal + ledger recoverable)", aside.length === 1 && fs.readFileSync(path.join(path.dirname(f), aside[0]), "utf8") === half)
  ok("the corrupt-copy is not listed as a task", !ts.listTasks({}).some((x) => x == null))
  fs.writeFileSync(ts.taskFile("t-corrupt2"), "{{{")
  const r = ts.openTask("t-corrupt2", { create: false })
  ok("openTask(create:false) on a corrupt record → null", r === null)
  ok("…and the record is preserved aside", fs.readdirSync(path.dirname(f)).some((x) => x.startsWith("t-corrupt2.json.corrupt-")))
}

// ---------------------------------------------------------------------------
console.log("== R1: a resumed task is owned by the resuming process ==")
{
  const t1 = ts.openTask("t-dup", { create: true, objective: "rewrite parser", cwd: WORK })
  t1.transition(ts.TASK_STATUS.EXECUTING, { reason: "seg 1" })
  t1.record.pid = 999999; t1.flush(ts.DURABILITY.CRITICAL)
  ok("a crashed task (dead pid) is offered as interrupted", ts.interruptedTasks({ cwd: WORK }).some((t) => t.task_id === "t-dup"))
  const t2 = ts.openTask("t-dup", { create: true, cwd: WORK })
  t2.transition(ts.TASK_STATUS.EXECUTING, { reason: "resumed" }); t2.flush(ts.DURABILITY.CRITICAL)
  ok("the record's pid is the resumer's", ts.readTask("t-dup").pid === process.pid, ts.readTask("t-dup").pid)
  ok("it is no longer offered as interrupted while being resumed", !ts.interruptedTasks({ cwd: WORK }).some((t) => t.task_id === "t-dup"))

  const refusal = ts.taskResumeRefusal
  ok("taskResumeRefusal is exported", typeof refusal === "function")
  if (typeof refusal === "function") {
    ok("a live foreign owner refuses resume", /still running/.test(refusal({ task_id: "x", status: "EXECUTING", pid: process.ppid }) ?? ""))
    ok("a terminal task refuses resume", /COMPLETED/.test(refusal({ task_id: "x", status: "COMPLETED", pid: 999999 }) ?? ""))
    ok("a dead owner may be resumed", refusal({ task_id: "x", status: "EXECUTING", pid: 999999 }) === null)
  }
  // the CLI refuses BEFORE any provider/onboarding is needed
  const live = ts.openTask("t-live", { create: true, objective: "x", cwd: WORK })
  live.transition(ts.TASK_STATUS.EXECUTING, { reason: "running elsewhere" })
  live.record.pid = process.ppid; live.flush(ts.DURABILITY.CRITICAL)
  const cli = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "tasks", "--resume", "t-live"], { cwd: WORK, env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }, encoding: "utf8", timeout: 30000, input: "" })
  ok("`forge tasks --resume` refuses a task another live process owns (exit 1)", cli.status === 1 && /still running/.test(cli.stdout + cli.stderr), `exit ${cli.status}: ${(cli.stdout + cli.stderr).slice(-200)}`)
  const done = ts.openTask("t-done", { create: true, objective: "x", cwd: WORK })
  done.transition(ts.TASK_STATUS.EXECUTING, {}); done.transition(ts.TASK_STATUS.COMPLETED, {})
  const cli2 = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "tasks", "--resume", "t-done"], { cwd: WORK, env: { ...process.env, FORGE_HOME: HOME, NO_COLOR: "1" }, encoding: "utf8", timeout: 30000, input: "" })
  ok("`forge tasks --resume` refuses a COMPLETED task (exit 1)", cli2.status === 1 && /COMPLETED/.test(cli2.stdout + cli2.stderr), `exit ${cli2.status}: ${(cli2.stdout + cli2.stderr).slice(-200)}`)
}

// ---------------------------------------------------------------------------
console.log("== R2: resume re-runs a node that was RUNNING at the crash (+ S1 child side) ==")
{
  const g = dag.buildDAG([
    { id: "n1", objective: "investigate", read_only: true, role: "researcher" },
    { id: "n2", objective: "rewrite", dependencies: ["n1"], role: "coder" },
    { id: "n3", objective: "test", dependencies: ["n2"], role: "tester" },
  ])
  dag.markCompleted(g, "n1", null, { verification: dag.VERIFICATION_NOT_REQUIRED })
  dag.executeNode(g, "n2", {})
  const t = ts.openTask("crash-run", { create: true, objective: "rewrite the thing", cwd: WORK })
  t.setDAG(dag.serializeDAG(g)); t.setNodeId("n2")
  t.transition(ts.TASK_STATUS.EXECUTING, { reason: "segment 2" })
  t.record.pid = 999999; t.flush(ts.DURABILITY.CRITICAL)
  const seen = []
  const events = []
  const fake = async (a) => {
    seen.push(a.nodeId ?? null)
    if (a.planOnly) return { text: "", toolRecords: [], commandChecks: [], toolLog: [] }
    return { text: "done", budgetHit: false, steps: 1, toolRecords: [], toolLog: [],
      commandChecks: [{ command: "node --check src/x.js", exitCode: 0, passed: true, tail: "ok" },
                      { command: "npx vitest run src/x.test.js", exitCode: 0, passed: true, tail: "1 passed" }] }
  }
  const supFile = path.join(HOME, "sup-task.json")
  process.env.FORGE_SUPERVISED = "1"; process.env.FORGE_SUPERVISOR_TASK_FILE = supFile
  let r = null, err = null
  try {
    r = await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "rewrite the thing", runAgent: fake, workers: false, maxSegments: 6, resumeTaskId: "crash-run", signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  } catch (e) { err = e } finally { delete process.env.FORGE_SUPERVISED; delete process.env.FORGE_SUPERVISOR_TASK_FILE }
  ok("resume ran without throwing", !err, err?.message)
  ok("the interrupted node n2 was re-run", seen.includes("n2"), JSON.stringify(seen))
  ok("the task finished COMPLETED", r?.status === "COMPLETED", r?.status)
  ok("every node completed", (r?.task?.dag?.nodes ?? []).every((n) => n.status === "completed"), (r?.task?.dag?.nodes ?? []).map((n) => `${n.id}:${n.status}`).join(" "))
  ok("a DAG_NODES_REQUEUED event names n2", events.some((e) => e.type === "DAG_NODES_REQUEUED" && (e.nodeIds ?? []).includes("n2")))
  // dag unit: READY when deps done, PENDING otherwise
  const h = dag.buildDAG([{ id: "a", objective: "a" }, { id: "b", objective: "b", dependencies: ["a"] }])
  dag.executeNode(h, "a", {}); h.nodes.get("b").status = dag.NODE_STATUS.RUNNING
  const ids = typeof dag.requeueInterruptedNodes === "function" ? dag.requeueInterruptedNodes(h) : []
  ok("requeueInterruptedNodes: deps met → ready, deps unmet → pending", h.nodes.get("a").status === "ready" && h.nodes.get("b").status === "pending" && ids.length === 2, `${h.nodes.get("a").status}/${h.nodes.get("b").status}`)
  // S1 child side: a supervised run says which task it owns
  let owned = null
  try { owned = JSON.parse(fs.readFileSync(supFile, "utf8")) } catch {}
  ok("S1: a supervised meta run records its task id for the supervisor", owned?.taskId === "crash-run", JSON.stringify(owned))
}

console.log("== R3: resume never closes a crashed run's unverified edit ==")
{
  const runR3 = async (id, checks) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-r3-"))
    const prev = process.cwd(); process.chdir(dir)
    try {
      fs.mkdirSync("src"); fs.writeFileSync("src/x.js", "export const x = (\n") // broken edit left behind
      const g = dag.buildDAG([{ id: "n1", objective: "rewrite src/x.js", role: "coder", targetFiles: ["src/x.js"] }])
      dag.executeNode(g, "n1", {}); dag.markExecutionSucceeded(g, "n1", "edited")
      const t = ts.openTask(id, { create: true, objective: "rewrite src/x.js", cwd: dir })
      t.setDAG(dag.serializeDAG(g)); t.setNodeId("n1"); t.noteFiles(["src/x.js"], [])
      t.transition(ts.TASK_STATUS.EXECUTING, { reason: "seg 1" }); t.transition(ts.TASK_STATUS.VERIFYING, { reason: "about to verify" })
      t.record.pid = 999999; t.flush(ts.DURABILITY.CRITICAL)
      const fake = async () => ({ text: "All done.", budgetHit: false, steps: 1, toolRecords: [], toolLog: [], commandChecks: checks })
      return await meta.runMeta({ config: metaCfg, provider: { name: "x", model: "m" }, task: "rewrite src/x.js", runAgent: fake, workers: false, maxSegments: 4, resumeTaskId: id, signal: new AbortController().signal })
    } finally { process.chdir(prev) }
  }
  const r = await runR3("crash-unv", [])
  ok("no verification evidence → the task is NOT COMPLETED", r.status !== "COMPLETED", r.status)
  ok("…and node n1 is not completed", (r.task.dag?.nodes ?? []).every((n) => n.status !== "completed"), (r.task.dag?.nodes ?? []).map((n) => `${n.id}:${n.status}`).join(" "))
  const r2 = await runR3("crash-unv-ok", [{ command: "node --check src/x.js", exitCode: 0, passed: true, tail: "ok" }])
  ok("with passing syntax evidence the resumed task completes", r2.status === "COMPLETED", `${r2.status}: ${JSON.stringify(r2.verification).slice(0, 160)}`)
}

// ---------------------------------------------------------------------------
console.log("== S1: the supervisor resumes the crashed task, and only after a crash ==")
{
  const re = sup.restartableExit
  ok("restartableExit is exported", typeof re === "function")
  if (typeof re === "function") {
    ok("SIGKILL → restart", re({ code: null, signal: "SIGKILL" }) === true)
    ok("exit 137 (killed under a shell) → restart", re({ code: 137, signal: null }) === true)
    ok("exit 1 (ERROR/FAILED) → no restart", re({ code: 1, signal: null }) === false)
    ok("exit 130 (Ctrl+C) → no restart", re({ code: 130, signal: null }) === false)
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-sup-"))
  const launches = []
  const spawnFn = (exe, args, opts) => {
    launches.push({ args: args.slice(1), env: opts.env })
    const n = launches.length
    const tf = opts.env.FORGE_SUPERVISOR_TASK_FILE
    // 1st: records its task, then is SIGKILLed mid-run; 2nd: an ordinary failure exit; 3rd would succeed
    const code = n === 1 ? `require('fs').writeFileSync(${JSON.stringify(String(tf ?? path.join(cwd, "none")))}, JSON.stringify({taskId:'task-s1-abc'})); process.kill(process.pid,'SIGKILL')`
      : n === 2 ? "process.exit(1)" : "process.exit(0)"
    return spawn(exe, ["-e", code], { stdio: "ignore" })
  }
  const r = await sup.supervise(["agent", "drop the users table and recreate it"], { cwd, spawnFn, waitForRecovery: async () => {} })
  ok("the child is told where to record its task", typeof launches[0]?.env?.FORGE_SUPERVISOR_TASK_FILE === "string")
  ok("the restart after SIGKILL resumes the SAME task", JSON.stringify(launches[1]?.args) === JSON.stringify(["tasks", "--resume", "task-s1-abc"]), JSON.stringify(launches.map((l) => l.args)))
  ok("an ordinary exit 1 is not restarted", launches.length === 2 && r.ok === false && r.reason === "EXIT_1", JSON.stringify(r))
  ok("the task-id handoff file is cleaned up", !fs.existsSync(String(launches[0]?.env?.FORGE_SUPERVISOR_TASK_FILE ?? path.join(cwd, "x"))))
}

// ---------------------------------------------------------------------------
console.log("== Q2: a killed runner's live agent child blocks reconcile/retry ==")
{
  const dir = fs.mkdtempSync(path.join(HOME, "q2-"))
  const file = path.join(dir, "queue.json")
  const log = path.join(dir, "agent.log")
  const fakeAgent = path.join(dir, "fake-agent.mjs")
  fs.writeFileSync(fakeAgent, `import fs from "node:fs"
const a = process.argv.slice(2); const rf = a[a.indexOf("--result-json") + 1]
fs.appendFileSync(${JSON.stringify(log)}, "start " + process.pid + "\\n")
setTimeout(() => { fs.writeFileSync(rf, JSON.stringify({ status: "COMPLETED" })) }, 20000)
`)
  Q.addItem("migrate prod DB", { file })
  const runnerSrc = `const q = await import(${JSON.stringify(mod("taskqueue.js"))}); await q.runQueue({ file: ${JSON.stringify(file)}, runItem: (item, o) => q.spawnAgentItem(item, { ...o, forgeJs: ${JSON.stringify(fakeAgent)}, stdio: "ignore" }) })`
  const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerSrc], { env: { ...process.env, FORGE_HOME: HOME }, stdio: "ignore" })
  const started = await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").trim())
  const agentPid = started ? Number(started.split(/\s+/)[1]) : 0
  const recorded = await waitFor(() => Q.readQueue({ file }).items[0]?.agent_pid, 4000)
  ok("the runner records agent_pid on the item", recorded === agentPid && agentPid > 0, `recorded=${recorded} agent=${agentPid}`)
  runner.kill("SIGKILL")
  await new Promise((r) => runner.exitCode != null || runner.signalCode ? r() : runner.on("exit", r))
  ok("the agent child outlives the SIGKILLed runner", agentPid > 0 && alive(agentPid))
  Q.reconcileQueue({ file })
  ok("reconcile keeps the item RUNNING while its agent lives", Q.readQueue({ file }).items[0]?.status === "RUNNING", Q.readQueue({ file }).items[0]?.status)
  const retry = Q.retryItem("1", { file })
  ok("retry is refused while the agent lives", retry.ok === false, JSON.stringify(retry))
  let ran2 = 0
  const r2 = await Q.runQueue({ file, runItem: async () => { ran2++; return { exitCode: 0 } } })
  ok("a second runner does NOT start a duplicate agent", ran2 === 0 && r2.ran.length === 0, `ran=${ran2}`)
  // the old reconciliation must have marked it retryable — the duplicate
  // agent is the bug; INTERRUPTED with a live agent is never offered
  const it = Q.readQueue({ file }).items[0]
  if (it.status === "INTERRUPTED") {
    const r3 = Q.retryItem("1", { file })
    ok("an INTERRUPTED item with a live agent_pid is not retryable", r3.ok === false, JSON.stringify(r3))
  }
  try { process.kill(agentPid, "SIGKILL") } catch {}
  await waitFor(() => !alive(agentPid), 5000)
  Q.reconcileQueue({ file })
  ok("once the agent is gone, reconcile marks it INTERRUPTED", Q.readQueue({ file }).items[0]?.status === "INTERRUPTED", Q.readQueue({ file }).items[0]?.status)
  ok("…and retry is allowed again", Q.retryItem("1", { file }).ok === true)
  ok("only ONE agent ever started", fs.readFileSync(log, "utf8").trim().split("\n").length === 1, fs.readFileSync(log, "utf8"))
}

// ---------------------------------------------------------------------------
console.log("== M1: concurrent processes keep each other's memory records ==")
{
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-m1-"))
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-m1h-"))
  const go = path.join(H, "go")
  const env = { ...process.env, FORGE_HOME: H }
  const child = (label, extra = "") => `process.chdir(${JSON.stringify(W)}); const m = await import(${JSON.stringify(mod("engmemory.js"))}); const e = m.createEngMemory({ cwd: process.cwd(), taskId: '${label}' }); e.recordMemory({ text: '${label}: first fact' }); ${extra}`
  const storeTexts = () => {
    const d = path.join(H, "projects")
    const p = fs.readdirSync(d).map((x) => path.join(d, x, "engmemory.json")).find((x) => fs.existsSync(x))
    return p ? JSON.parse(fs.readFileSync(p, "utf8")).records.map((r) => r.text) : []
  }
  // A loads + records, waits; B records and exits; A records again
  const A = spawn(process.execPath, ["--input-type=module", "-e", child("A", `const fs = await import('node:fs'); while (!fs.existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 20)); e.recordMemory({ text: 'A: second fact' })`)], { env, stdio: "inherit" })
  await waitFor(() => { try { return storeTexts().includes("A: first fact") } catch { return false } })
  spawnSync(process.execPath, ["--input-type=module", "-e", child("B")], { env, stdio: "inherit" })
  fs.writeFileSync(go, "1")
  await new Promise((r) => A.on("exit", r))
  const texts = storeTexts()
  ok("B's record survives A's later write", texts.includes("B: first fact"), JSON.stringify(texts))
  ok("A's records are all there", texts.includes("A: first fact") && texts.includes("A: second fact"), JSON.stringify(texts))
  // concurrent writers hammering the same store
  const hammer = (label) => new Promise((res) => spawn(process.execPath, ["--input-type=module", "-e",
    `process.chdir(${JSON.stringify(W)}); const m = await import(${JSON.stringify(mod("engmemory.js"))}); const e = m.createEngMemory({ cwd: process.cwd(), taskId: '${label}' }); for (let i = 0; i < 15; i++) e.recordMemory({ text: '${label} fact ' + i })`], { env, stdio: "inherit" }).on("exit", res))
  await Promise.all([hammer("H1"), hammer("H2"), hammer("H3")])
  const all = storeTexts()
  const lost = ["H1", "H2", "H3"].flatMap((l) => Array.from({ length: 15 }, (_, i) => `${l} fact ${i}`)).filter((t) => !all.includes(t))
  ok("3 concurrent writers × 15 records: none lost", lost.length === 0, `lost ${lost.length}: ${lost.slice(0, 5).join(", ")}`)
}

// ---------------------------------------------------------------------------
console.log("== T2: kill -9 in the middle of the transcript trim ==")
{
  // the child arms a fault: the first large write (the trim) writes HALF its
  // bytes and then the process SIGKILLs itself — a deterministic kill mid-write
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audrec-tr-"))
  const src = `import fs from "node:fs"
const s = await import(${JSON.stringify(mod("sessions.js"))}); s.setSessionStoreOverride(${JSON.stringify(dir)})
const p = s.transcriptPath("sess1")
const line = JSON.stringify({ ts: 1, role: "user", content: "x".repeat(1000), sessionId: "sess1" }) + "\\n"
fs.writeFileSync(p, line.repeat(Math.ceil(8.2 * 1024 * 1024 / line.length)))
const BIG = 1024 * 1024
const wfs = fs.writeFileSync, ws = fs.writeSync
fs.writeFileSync = function (f, data, ...rest) { const b = Buffer.from(typeof data === "string" ? data : data); if (b.length > BIG) { wfs.call(fs, f, b.subarray(0, b.length >> 1), ...rest); process.kill(process.pid, "SIGKILL") } return wfs.call(fs, f, data, ...rest) }
fs.writeSync = function (fd, buf, off, len, ...rest) { if (Buffer.isBuffer(buf) && (len ?? buf.length) > BIG) { ws.call(fs, fd, buf, off, (len ?? buf.length) >> 1); process.kill(process.pid, "SIGKILL") } return ws.call(fs, fd, buf, off, len, ...rest) }
s.appendTranscript({ sessionId: "sess1", role: "user", content: "new turn" })
`
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, FORGE_HOME: dir }, encoding: "utf8", timeout: 60000 })
  ok("the child was killed mid-trim (fault fired)", r.signal === "SIGKILL", `status=${r.status} signal=${r.signal} ${String(r.stderr).slice(-200)}`)
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".transcript.jsonl"))
  const txt = f ? fs.readFileSync(path.join(dir, f), "utf8") : ""
  const lines = txt.split("\n").filter(Boolean)
  let bad = 0
  for (const l of lines) { try { JSON.parse(l) } catch { bad++ } }
  ok("the transcript is not empty", txt.length > 0)
  ok("every line still parses (no torn record)", bad === 0, `${bad} bad line(s)`)
  ok("no history was lost (the pre-trim transcript is intact)", lines.length > 7000 && lines.at(-1).includes("new turn"), `${lines.length} lines`)
}

// ---------------------------------------------------------------------------
console.log("== P1: Ctrl+C during provider backoff is an AbortError ==")
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("overloaded", { status: 503 })
  try {
    const { streamChatResilient } = await import("../providers.js")
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200)
    const t0 = Date.now()
    let err = null
    try { for await (const _ of streamChatResilient({ provider: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], signal: ac.signal }, { attempts: 3, backoffMs: 5000 })) {} }
    catch (e) { err = e }
    ok("the abort ends the backoff promptly", Date.now() - t0 < 3000, `${Date.now() - t0}ms`)
    ok("the error is an AbortError (→ ABORTED/130, not ERROR/1)", err?.name === "AbortError", `${err?.name}: ${err?.message}`)
    ok("the provider error is kept as its cause", /503|overloaded/.test(String(err?.cause?.message ?? "")), String(err?.cause?.message))
  } finally { globalThis.fetch = realFetch }
  const cli = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
  ok("forge agent treats any error after the abort as ABORTED", /const aborted = e\?\.name === "AbortError" \|\| con\.signal\?\.aborted === true/.test(cli))
}

console.log(`\n== audit-recovery suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
