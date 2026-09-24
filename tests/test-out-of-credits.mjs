#!/usr/bin/env node
// v165 — what a reported run showed after v163 let it get going:
//
//   · the provider's balance covers 4481 output tokens, not the model's full ceiling …
//   ✗ load_skill focused_verify   ERROR: skill not found: focused_verify
//   · bash and bash write the same target — serialized
//   ✗ TASK FAILED
//     Reason   provider HTTP 402: This request would exceed your available credits …
//     Next     /details for diagnostics, then /retry
//
// 1. Out of credits: the card was cut off before what to do, "Next" did not
//    say it, and a 402 never failed over, even to a tested provider.
// 2. The prompt names first-party "playbooks" that had no steps anywhere, so
//    the model's load_skill for one was an error and a wasted step.
// 3. Two shell commands were said to "write the same target".
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}

const P = await import("../providers.js")
const { runAgent } = await import("../agent.js")
const SPENT = "This request would exceed your available credits. Add more credits to continue."

/** A provider whose balance is spent (always 402), or one that answers. */
function server(kind) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      seen.push(req.url)
      if (kind === "spent") {
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 402, message: SPENT } }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ANSWERED-BY-THE-FALLBACK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q) }) })))
}

console.log("== 1. out of credits ==")
const spent = await server("spent")
const good = await server("good")
const cfg = (failover) => ({
  activeProvider: "seekai", failover,
  providers: {
    seekai: { protocol: "openai", baseUrl: spent.url, apiKey: "k1", model: "deepseek-ai/DeepSeek-V4-Flash-0731" },
    backup: { protocol: "openai", baseUrl: good.url, apiKey: "k2", model: "backup-model" },
  },
  agent: { maxSteps: 4, timeoutSec: 10 }, skills: { enabled: false },
})
ok("a 402 is failover-worthy (this balance is spent; a fallback's is not)", P.isFailoverWorthy(new P.ProviderError("spent", { status: 402 })))
{
  const events = []
  const r = await runAgent({ config: cfg(true), provider: P.buildProvider(cfg(true), "seekai"), task: "say hi", onEvent: (e) => events.push(e) })
  ok("with failover on, a spent balance moves the run to the tested fallback", /ANSWERED-BY-THE-FALLBACK/.test(r.text), r.text)
  ok("…and says why", events.some((e) => e.type === "failover" && /backup/.test(e.to) && /out of credits on seekai/.test(e.reason)), JSON.stringify(events.filter((e) => e.type === "failover")))
}
{
  let err = null
  try { await runAgent({ config: cfg(false), provider: P.buildProvider(cfg(false), "seekai"), task: "say hi", onEvent: () => {} }) } catch (e) { err = e }
  const msg = String(err?.message ?? "")
  ok("with failover off, the run stops on the 402", err?.status === 402, msg)
  ok("…and the reason starts with what to do", /^provider HTTP 402 — out of credits on seekai; top up \(https:\/\/seekai\.cc\/console\/token\), then \/retry: This request would exceed/.test(msg), msg)
  ok("…so an 80-column card row keeps it", msg.slice(0, 78).includes("out of credits on seekai; top up"), msg.slice(0, 78))
}

console.log("== 2. the failure card and /retry, in a real terminal ==")
{
  // one provider: answering, then spent, then topped up again
  let mode = "ok"
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const text = (j.messages ?? []).map((msg) => String(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""))).join("\n")
      const system = String((j.messages ?? []).find((msg) => msg.role === "system")?.content ?? "")
      seen.push({ mode, agent: /autonomous terminal coding agent/.test(system), last: String(j.messages?.at(-1)?.content ?? ""), text })
      if (mode === "spent") {
        res.writeHead(402, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { code: 402, message: SPENT } }))
      }
      const reply = /autonomous terminal coding agent/.test(system) ? "AGENT-DID-IT" : "CHAT-REPLY"
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: "stop" }] })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-credits-home-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-credits-work-"))
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"probe"}\n')
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "seekai", providers: { seekai: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "deepseek-ai/DeepSeek-V4-Flash-0731" } }, agent: { maxSteps: 3 }, skills: { enabled: false } }))
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { cwd: work, env: { ...process.env, FORGE_HOME: home, NO_COLOR: "1", TERM: "xterm-256color", COLUMNS: "100", LINES: "40" }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  const clean = (d) => String(d).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
  child.stdout.on("data", (d) => { out += clean(d) })
  const until = async (re, ms = 30000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(out) }
  const settle = async () => { for (let last = -1; last !== out.length;) { last = out.length; await new Promise((r) => setTimeout(r, 500)) } }
  await until(/forge/i); await new Promise((r) => setTimeout(r, 800))
  child.stdin.write("hello there\r")
  await until(/CHAT-REPLY/)
  mode = "spent"
  child.stdin.write("/agent list the security tests\r")
  const failed = await until(/TASK FAILED/)
  await settle()
  const card = out.replace(/\s+/g, " ")
  mode = "ok" // the person tops up
  const before = seen.length
  child.stdin.write("/retry\r")
  await until(/retrying the agent task/)
  for (const t0 = Date.now(); !seen.slice(before).some((c) => c.agent) && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 50))
  await settle()
  child.stdin.write("/exit\r")
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 8000); child.on("exit", () => { clearTimeout(t); r() }) })
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  ok("the run failed on the spent balance", failed, out.slice(-500))
  ok("the card's Reason says out of credits", /Reason\s+provider HTTP 402 — out of credits on seekai; top up/.test(card), card.slice(-700))
  ok("…and Next says to top up and /retry, not '/details for diagnostics'", /Next\s+top up the provider's credits, then \/retry/.test(card), card.slice(-400))
  const after = seen.slice(before)
  ok("/retry re-ran the failed agent task", after.some((c) => c.agent && /list the security tests/.test(c.text)), JSON.stringify(after.map((c) => [c.agent, c.last.slice(0, 60)])))
  ok("…and did not re-send the last chat message instead (it used to)", !after.some((c) => !c.agent && /^hello there$/.test(c.last.trim())), JSON.stringify(after.map((c) => c.last.slice(0, 40))))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}
await spent.stop(); await good.stop()

console.log("== 3. the playbooks the prompt names can be loaded ==")
{
  const T = await import("../tools.js")
  const { PLUGIN_PLAYBOOKS, playbookText } = await import("../playbooks.js")
  const PI = await import("../plugintel.js")
  const toolNames = new Set(T.TOOL_DEFS ? T.TOOL_DEFS.map((d) => d.function.name) : [])
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skills-"))
  const ctx = { cwd: process.cwd(), root: process.cwd(), skillsDir }
  for (const b of PLUGIN_PLAYBOOKS) {
    const r = String(await T.execTool(ctx, "load_skill", { name: b.name }))
    ok(`load_skill ${b.name} returns its steps`, r.startsWith(`# Playbook: ${b.name}`) && /\n1\. /.test(r) && b.steps.length >= 3, r.slice(0, 120))
  }
  const named = [...new Set(PLUGIN_PLAYBOOKS.flatMap((b) => b.steps.join(" ").match(/`([a-z_]+)`/g) ?? []).map((x) => x.slice(1, -1)))].filter((x) => /^[a-z]+(?:_[a-z]+)+$/.test(x) || ["bash", "think", "todo", "memory"].includes(x))
  const missing = toolNames.size ? named.filter((n) => !toolNames.has(n)) : []
  ok("every tool a playbook step names is a real forge tool", toolNames.size > 10 && missing.length === 0, `missing: ${missing.join(", ")}`)
  ok("plugintel ranks the same playbooks", PI.PLUGIN_PLAYBOOKS === PLUGIN_PLAYBOOKS && PI.PLUGIN_PLAYBOOKS.length === 6)
  ok("the prompt says how to get the steps", /load_skill <name> gives the steps/.test(PI.formatPluginPicks({ playbooks: [PLUGIN_PLAYBOOKS[1]] })))
  fs.mkdirSync(path.join(skillsDir, "focused_verify"), { recursive: true })
  fs.writeFileSync(path.join(skillsDir, "focused_verify", "SKILL.md"), "# my own focused_verify\n")
  ok("a skill of the same name the person installed still wins", /my own focused_verify/.test(String(await T.execTool(ctx, "load_skill", { name: "focused_verify" }))))
  ok("an unknown name is still an error", /skill not found: nope_not_here/.test(String(await T.execTool(ctx, "load_skill", { name: "nope_not_here" }))))
  ok("playbookText is null for a non-playbook", playbookText("nope") === null)
  fs.rmSync(skillsDir, { recursive: true, force: true })
}

console.log("== 4. the scheduler says what it knows ==")
{
  const R = await import("../router.js")
  const sh = R.planExecution([
    { name: "bash", args: { command: "node tests/a.mjs 2>&1 | tail -5" } },
    { name: "bash", args: { command: "node tests/b.mjs 2>&1 | tail -5" } },
  ], { ctx: { cwd: process.cwd() } })
  ok("two shell commands are still run one at a time", sh.serialized.length === 2)
  ok("…but are not said to 'write the same target'", sh.conflicts.length === 1 && !/same target/.test(sh.conflicts[0].note) && /may each change anything/.test(sh.conflicts[0].note), sh.conflicts[0]?.note)
  const w = R.planExecution([
    { name: "write_file", args: { path: "x.txt", content: "a" } },
    { name: "edit_file", args: { path: "x.txt", old: "a", new: "b" } },
  ], { ctx: { cwd: process.cwd() } })
  ok("two writes to one file still say so", w.conflicts.length === 1 && /write the same target/.test(w.conflicts[0].note), w.conflicts[0]?.note)
}

console.log(`\n== out-of-credits suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
