#!/usr/bin/env node
/**
 * forge — audit 2026-10: the two execution engines (agent.js single loop,
 * meta.js controller) behind one outcome contract (runtask.js), and the
 * lifecycle of the commands they run. Every case here failed before the fix.
 *
 *   E1  a signal to a non-terminal `forge agent` left the running command
 *       alive (its own process group; process.exit ran no kill) — and with
 *       no --result-json the signal was not trapped at all
 *   E2  a controller run that FAILED exited 0 and its error was lost
 *   E3  a segment that threw forgot the files it had already written
 *       (filesChanged [], wrote false — no undo hint); the CLI did the same
 *       for a single-loop run that threw
 *   E4  a provider error that cannot succeed on retry (HTTP 400 "does not
 *       support tools", repeated empty answers) went through repair on the
 *       controller: 4–7 model calls where the single loop made 1–3
 *   E5  cancel: the single loop threw AbortError, the controller returned
 *       CANCELLED — webchat stored the latter as an ordinary reply
 *
 * A scripted OpenAI-compatible model in this process; real `forge agent`
 * child processes for the signal cases. Isolated FORGE_HOME.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const FORGE = path.join(ROOT, "forge.js")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-engines-"))
process.env.FORGE_HOME = path.join(TMP, "home")
process.env.NO_COLOR = "1"
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }

// ── the scripted model ─────────────────────────────────────────────────────
const toolCall = (id, name, args) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
const say = (t) => ({ role: "assistant", content: t })
const hasToolMsg = (body) => (body.messages || []).some((m) => m.role === "tool")

async function mockModel(script) {
  const log = []
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "stub" }] })); return }
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", async () => {
      let body = {}; try { body = JSON.parse(b) } catch { }
      log.push(body)
      const r = await script(log.length, body)
      if (r === "HANG") return
      if (r?.httpStatus) { res.writeHead(r.httpStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: r.msg } })); return }
      const finish = r.tool_calls ? "tool_calls" : "stop"
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const delta = { role: "assistant", content: r.content ?? "" }
        if (r.tool_calls) delta.tool_calls = r.tool_calls.map((t, i) => ({ index: i, ...t }))
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
        res.end("data: [DONE]\n\n")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: r, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return {
    log, baseUrl,
    provider: { name: "mock", protocol: "openai", baseUrl, apiKey: "k", model: "stub" },
    toolRequests: () => log.filter((b) => b.tools?.length).length,
    close: () => { server.closeAllConnections?.(); server.close() },
  }
}

// ── processes, without pgrep (absent on some Android/Termux installs) ──────
function liveProcs(cmdline) {
  const found = []
  let ents = null
  try { ents = fs.readdirSync("/proc") } catch { ents = null }
  if (ents) {
    for (const d of ents) {
      if (!/^\d+$/.test(d)) continue
      try {
        const c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")
        if (c !== cmdline) continue
        const st = fs.readFileSync(`/proc/${d}/stat`, "utf8")
        if (st.slice(st.lastIndexOf(")") + 2).split(" ")[0] !== "Z") found.push(Number(d))
      } catch { /* it went away while we looked */ }
    }
    return found
  }
  const ps = spawnSync("ps", ["-eo", "pid=,stat=,args="], { encoding: "utf8" })
  for (const l of String(ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)
    if (m && m[3].trim() === cmdline && !m[2].startsWith("Z")) found.push(Number(m[1]))
  }
  return found
}
const reap = (cmdline) => { for (const pid of liveProcs(cmdline)) { try { process.kill(pid, "SIGKILL") } catch { } } }
async function waitFor(pred, ms) { const until = Date.now() + ms; while (Date.now() < until) { if (pred()) return true; await sleep(50) } return pred() }

// ── in-process: both engines through the ONE entry point ───────────────────
const RT = await import("../runtask.js")
const { runTask, adaptMetaResult } = RT
// a missing contract must FAIL the cases below, not crash the suite
const exitCodeOf = typeof RT.exitCodeOf === "function" ? RT.exitCodeOf : () => "exitCodeOf missing"
const { runAgent } = await import("../agent.js")
const { createForgeCore } = await import("../core.js")

async function viaRunTask(mode, script, { signal, timeoutMs = 60000 } = {}) {
  const m = await mockModel(script)
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`))
  const prev = process.cwd()
  process.chdir(dir)
  let out = null, thrown = null
  try {
    out = await Promise.race([
      runTask({ task: "create hello.txt containing hi", mode, provider: m.provider, runAgent, createForgeCore, signal, env: {},
        config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } },
        onEvent: () => {}, agentOpts: { journal: false } }),
      sleep(timeoutMs).then(() => { throw new Error(`timed out after ${timeoutMs}ms`) }),
    ])
  } catch (e) { thrown = e }
  finally { process.chdir(prev) }
  m.close()
  return { out, thrown, dir, toolRequests: m.toolRequests() }
}

const writeThen400 = (n, body) => {
  if (!body.tools?.length) return say("1. create hello.txt")
  if (hasToolMsg(body)) return { httpStatus: 400, msg: "model does not support tools" }
  return toolCall(`c${n}`, "write_file", { path: "hello.txt", content: "hi\n" })
}

try {
  console.log("== E2/E3: a controller segment that throws after a write ==")
  {
    const r = await viaRunTask("meta", writeThen400)
    const m = r.out?.meta, res = r.out?.res
    ok("the run returns (FAILED), it does not throw", !r.thrown && m?.status === "FAILED", r.thrown?.message ?? m?.status)
    ok("E2: the raw result carries the provider error", /does not support tools/.test(String(m?.error ?? "")), JSON.stringify(m?.error))
    ok("E2: …and so does the adapted result", /does not support tools/.test(String(res?.error ?? "")), JSON.stringify(res?.error))
    eq("E2: a FAILED controller run maps to exit 1", exitCodeOf(res), 1)
    ok("E3: the file written before the error is in filesChanged", (m?.filesChanged ?? []).some((f) => f.endsWith(`${path.sep}hello.txt`)), JSON.stringify(m?.filesChanged))
    eq("E3: wrote", res?.wrote, true)
    ok("E3: its tool call and tokens are counted", m?.toolCalls >= 1 && res?.usage?.promptTokens > 0, JSON.stringify({ toolCalls: m?.toolCalls, usage: res?.usage }))
    ok("the file really is there", fs.existsSync(path.join(r.dir, "hello.txt")))
  }

  console.log("== E3: the single loop's thrown error carries what it did ==")
  {
    const r = await viaRunTask("single", writeThen400)
    ok("single throws the provider error", /does not support tools/.test(String(r.thrown?.message ?? "")), r.thrown?.message)
    const p = r.thrown?.partial
    eq("e.partial.wrote", p?.wrote, true)
    eq("e.partial.toolLog has the write", p?.toolLog?.map((t) => t.name), ["write_file"])
    ok("e.partial.usage counted the tokens", p?.usage?.promptTokens > 0, JSON.stringify(p?.usage))
    ok("e.partial is not enumerable (a serialized error stays small)", r.thrown && !Object.keys(r.thrown).includes("partial"))
  }

  console.log("== E4: a provider error retrying cannot fix — same number of calls on both engines ==")
  for (const [label, script] of [
    ["HTTP 400 does not support tools", (n, body) => body.tools?.length ? { httpStatus: 400, msg: "gemma:2b does not support tools" } : say("1. create hello.txt")],
    ["an empty answer every time", (n, body) => body.tools?.length ? say("") : say("1. create hello.txt")],
  ]) {
    const single = await viaRunTask("single", script)
    const meta = await viaRunTask("meta", script)
    ok(`${label}: single throws`, single.thrown != null, single.out?.res?.status)
    eq(`${label}: controller ends FAILED`, meta.out?.meta?.status, "FAILED")
    eq(`${label}: controller tool-bearing calls == single's (${single.toolRequests})`, meta.toolRequests, single.toolRequests)
    ok(`${label}: …and the controller says why`, String(meta.out?.res?.error ?? "").length > 0 && String(meta.out?.res?.error) === String(single.thrown?.message), `${meta.out?.res?.error} vs ${single.thrown?.message}`)
  }

  console.log("== E5: a cancel is one outcome, whichever engine ran ==")
  for (const mode of ["single", "meta"]) {
    const ctrl = new AbortController()
    const script = (n, body) => {
      if (!body.tools?.length) return say("1. run the long command")
      if (hasToolMsg(body)) return say("done")
      setTimeout(() => ctrl.abort(), 600)
      return toolCall(`c${n}`, "bash", { command: "sleep 289" })
    }
    const t0 = Date.now()
    const r = await viaRunTask(mode, script, { signal: ctrl.signal })
    eq(`${mode}: runTask throws AbortError`, r.thrown?.name, "AbortError")
    ok(`${mode}: promptly (${Date.now() - t0}ms)`, Date.now() - t0 < 15000)
    if (mode === "meta") {
      eq("meta: the error carries the controller's result", r.thrown?.result?.taskStatus, "CANCELLED")
      ok("meta: …and its task id (chat /retry resumes by it)", typeof r.thrown?.result?.taskId === "string" && r.thrown.result.taskId.length > 0, r.thrown?.result?.taskId)
    }
    eq(`${mode}: the command was killed`, liveProcs("sleep 289").length, 0)
    reap("sleep 289")
  }
  {
    // webchat: the page's agent turn ends "stopped" — not a reply saying "cancelled by user"
    const { createWebChat } = await import("../webchat.js")
    const m = await mockModel((n, body) => {
      if (!body.tools?.length) return say("1. run the long command")
      if (hasToolMsg(body)) return say("done")
      return toolCall(`c${n}`, "bash", { command: "sleep 288" })
    })
    const proj = fs.mkdtempSync(path.join(TMP, "webchat-"))
    const prev = process.cwd()
    process.chdir(proj)
    const ctrl = new AbortController()
    const chat = createWebChat({
      config: { providers: {} }, cwd: proj, getProvider: () => m.provider, stream: async function* () { },
      systemPrompt: async () => "test",
      runAgentTurn: ({ task, onEvent, signal }) => runTask({ task, mode: "meta", provider: m.provider, runAgent, createForgeCore, signal, env: {}, config: { providers: {}, tools: { assumeYes: true }, agent: { verifyNudge: false, modelStrategy: false } }, onEvent }),
    })
    const timer = setInterval(() => { if (liveProcs("sleep 288").length) { clearInterval(timer); ctrl.abort() } }, 50)
    let reply = null, thrown = null
    try { reply = await chat.send({ id: "audit-cancel", text: "create hello.txt by running the long command", mode: "agent" }, { signal: ctrl.signal }) } catch (e) { thrown = e }
    finally { clearInterval(timer); process.chdir(prev); m.close() }
    ok("webchat: send resolves", !thrown, thrown?.message)
    eq("webchat: a cancelled controller turn is 'stopped'", reply?.error, "stopped")
    ok("webchat: …not stored as an answer", !/cancelled by user/.test(String(reply?.text ?? "")), reply?.text)
    reap("sleep 288")
  }

  console.log("== the outcome contract (pure) ==")
  {
    eq("exitCodeOf FAILED", exitCodeOf({ taskStatus: "FAILED" }), 1)
    eq("exitCodeOf CANCELLED", exitCodeOf({ taskStatus: "CANCELLED" }), 130)
    eq("exitCodeOf COMPLETED / WAITING", [exitCodeOf({ taskStatus: "COMPLETED" }), exitCodeOf({ taskStatus: "WAITING" })], [0, 0])
    eq("exitCodeOf single-loop statuses keep exit 0", [exitCodeOf({ status: "INCOMPLETE" }), exitCodeOf({ status: "COMPLETED_UNVERIFIED" })], [0, 0])
    eq("adaptMetaResult: error is additive, null by default", [adaptMetaResult({ status: "COMPLETED" }).error, adaptMetaResult({ status: "FAILED", error: "x" }).error], [null, "x"])
  }

  console.log("== E1: the exit hook kills a foreground command's whole tree ==")
  {
    // no abort signal at all: only tools.js's exit hook can reach it
    const script = path.join(TMP, "exit-hook.mjs")
    fs.writeFileSync(script, `
      const { makeToolContext } = await import(${JSON.stringify(new URL("../tools.js", import.meta.url).href)})
      const t = makeToolContext({ cwd: process.cwd(), root: process.cwd(), timeoutSec: 60, assumeYes: true })
      t.exec("bash", { command: "sleep 287 & sleep 286; echo never" })
      // exit only when the parent has SEEN the command running (no fixed timer
      // racing a slow machine); a long fallback keeps a lost parent from hanging
      process.stdin.once("data", () => process.exit(0))
      setTimeout(() => process.exit(0), 30000)
    `)
    const work = fs.mkdtempSync(path.join(TMP, "hook-"))
    const p = spawn(process.execPath, [script], { cwd: work, env: { ...process.env, FORGE_HOME: process.env.FORGE_HOME }, stdio: ["pipe", "ignore", "ignore"] })
    const started = await waitFor(() => liveProcs("sleep 286").length > 0, 15000)
    ok("the command started", started)
    try { p.stdin.write("exit\n") } catch { }
    await new Promise((r) => p.once("exit", r))
    const gone = await waitFor(() => liveProcs("sleep 286").length === 0 && liveProcs("sleep 287").length === 0, 3000)
    ok("after process.exit neither the command nor its background child is left", gone, `left: ${liveProcs("sleep 286").concat(liveProcs("sleep 287")).join(",")}`)
    reap("sleep 286"); reap("sleep 287")
  }

  console.log("== E1/E2/E3: the real CLI ==")
  const cli = (args, { cwd, port }) => {
    const home = fs.mkdtempSync(path.join(TMP, "clihome-"))
    const child = spawn(process.execPath, [FORGE, "agent", "--yolo", "--provider", "openai", "--model", "stub", "--base-url", `http://127.0.0.1:${port}/v1`, "--max-steps", "6", ...args],
      { cwd, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: path.join(home, ".forge"), OPENAI_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
    const exited = new Promise((r) => { const t = setTimeout(() => child.kill("SIGKILL"), 60000); child.once("exit", (code, signal) => { clearTimeout(t); r({ code, signal }) }) })
    return { child, exited, out: () => out }
  }
  for (const [label, flags, sig, want, sleepCmd, withResult] of [
    ["single loop, SIGTERM, no --result-json", ["--single"], "SIGTERM", 143, "sleep 291", false],
    ["single loop, SIGINT, --headless --result-json", ["--single", "--headless"], "SIGINT", 130, "sleep 292", true],
    ["controller, SIGTERM, --result-json", ["--auto"], "SIGTERM", 143, "sleep 293", true],
  ]) {
    const m = await mockModel((n, body) => {
      if (!body.tools?.length) return say("1. run the command")
      if (hasToolMsg(body)) return say("ok")
      return toolCall("c1", "bash", { command: sleepCmd })
    })
    const work = fs.mkdtempSync(path.join(TMP, "cli-"))
    const rj = path.join(work, "..", `${path.basename(work)}.json`)
    const run = cli([...flags, ...(withResult ? ["--result-json", rj] : []), "--", "run the long command"], { cwd: work, port: new URL(m.baseUrl).port })
    const started = await waitFor(() => liveProcs(sleepCmd).length > 0, 30000)
    ok(`${label}: the command is running`, started, run.out().slice(-300))
    run.child.kill(sig)
    const r = await run.exited
    eq(`${label}: forge exits ${want} by its own hand`, [r.code, r.signal], [want, null])
    const gone = await waitFor(() => liveProcs(sleepCmd).length === 0, 3000)
    ok(`${label}: the command did not outlive forge`, gone, `still running: ${liveProcs(sleepCmd).join(",")}`)
    if (withResult) {
      const j = readJson(rj)
      eq(`${label}: result file ABORTED with the exit code`, [j?.status, j?.exitCode, j?.reason], ["ABORTED", want, `signal ${sig}`])
    }
    reap(sleepCmd)
    m.close()
  }
  for (const [label, flags, want] of [
    ["controller", ["--auto"], { code: 1, status: "FAILED" }],
    ["single loop", ["--single"], { code: 1, status: "ERROR" }],
  ]) {
    const m = await mockModel(writeThen400)
    const work = fs.mkdtempSync(path.join(TMP, "cli-"))
    const rj = path.join(work, "..", `${path.basename(work)}.json`)
    const run = cli([...flags, "--headless", "--result-json", rj, "--", "create hello.txt containing hi"], { cwd: work, port: new URL(m.baseUrl).port })
    const r = await run.exited
    const j = readJson(rj)
    eq(`${label} provider error: exit ${want.code} (E2)`, r.code, want.code)
    eq(`${label}: result status ${want.status}, exitCode ${want.code}`, [j?.status, j?.exitCode], [want.status, want.code])
    ok(`${label}: result error names the provider's reason (E2)`, /does not support tools/.test(String(j?.error ?? "")), JSON.stringify(j?.error))
    eq(`${label}: result says it wrote (E3)`, j?.wrote, true)
    ok(`${label}: and tells you how to undo it (E3)`, /undo this whole run/.test(run.out()), run.out().slice(-300))
    m.close()
  }
} finally {
  for (const c of ["sleep 286", "sleep 287", "sleep 288", "sleep 289", "sleep 291", "sleep 292", "sleep 293"]) reap(c)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n== audit-engines suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
