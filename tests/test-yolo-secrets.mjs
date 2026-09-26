#!/usr/bin/env node
// v185 — YOLO shows secrets as they are.
//
// The owner's decision: YOLO is the developer's mode — nothing refused and
// nothing hidden — until the release. Secret redaction hid values from them,
// from the model and in transcripts (and its high-entropy rule took model ids
// like deepseek-ai/DeepSeek-V4-Flash-0731 for keys). With YOLO on nothing is
// redacted; NODE_ENV=production, an explicit FORGE_SECURITY_MODE=on or
// tools.securityMode "on" still redact. The injection fence and socket
// pinning are separate and stay.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
delete process.env.FORGE_SECURITY_MODE
delete process.env.NODE_ENV
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolosec-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const SM = await import("../security-mode.js")
const S = await import("../secrets.js")
const Y = await import("../yolo.js")
const KEY = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789"
const MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
const shown = () => S.redact(`key ${KEY} model ${MODEL}`)

console.log("== 1. who decides whether secrets are redacted ==")
{
  SM.setYoloSecrets({ yolo: false })
  ok("YOLO off: redacted", !shown().includes(KEY) && SM.redactionEnabled())
  SM.setYoloSecrets({ yolo: true })
  ok("YOLO on: shown as-is — the key and the model id", shown().includes(KEY) && shown().includes(MODEL) && !SM.redactionEnabled())
  ok("…the count is still honest (the secret was seen)", S.redactSecrets(`key ${KEY}`).found === 1 && S.redactSecrets(`key ${KEY}`).text.includes(KEY))
  process.env.FORGE_SECURITY_MODE = "on"
  ok("YOLO on + FORGE_SECURITY_MODE=on: redacted (asked for explicitly)", !shown().includes(KEY))
  delete process.env.FORGE_SECURITY_MODE
  ok("YOLO on + tools.securityMode \"on\": redacted", SM.setYoloSecrets({ yolo: true, config: { tools: { securityMode: "on" } } }) === false && !shown().includes(KEY))
  SM.setYoloSecrets({ yolo: true })
  process.env.NODE_ENV = "production"
  ok("YOLO on + NODE_ENV=production: redacted (the release safety net)", !shown().includes(KEY))
  delete process.env.NODE_ENV
  process.env.FORGE_SECURITY_MODE = "off"
  SM.setYoloSecrets({ yolo: false })
  ok("security off (YOLO or not): shown, as before", shown().includes(KEY))
  delete process.env.FORGE_SECURITY_MODE
  SM.setYoloSecrets({ yolo: false })
}

console.log("== 2. what forge says about it ==")
{
  const on = Y.yoloState({ tools: { unrestricted: true, autoApprove: true } }, {})
  ok("yoloState says secrets are shown", on.yolo && on.showsSecrets === true)
  ok("…and the table says so, and how to redact again", /secrets:\s+shown as-is — nothing is redacted in YOLO \(tools\.securityMode on/.test(Y.formatYolo(on)))
  ok("explicit securityMode on: the table says redacted", Y.yoloState({ tools: { unrestricted: true, autoApprove: true, securityMode: "on" } }, {}).showsSecrets === false)
  ok("YOLO off: redacted", Y.yoloState({ tools: { yolo: false } }, {}).showsSecrets === false)
  ok("secret redaction is no longer on the \"never turned off by YOLO\" list", !Y.NEVER_YOLO.some(([n]) => /secret/.test(n)))
  ok("…the injection fence and socket pinning still are (they neither hide nor refuse)", Y.NEVER_YOLO.some(([n]) => /injection fence/.test(n)) && Y.NEVER_YOLO.some(([n]) => /socket pinning/.test(n)))
}

/** A headless run whose model cats a file holding a key and a model id. */
async function run({ args = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolosec-run-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "provider.json"), JSON.stringify({ models: [MODEL], apiKey: KEY }) + "\n")
  let result = null
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const tool = (j.messages ?? []).find((m) => m.role === "tool")
      if (tool) result = String(tool.content ?? "")
      const msg = tool ? { role: "assistant", content: "done" } : { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat provider.json" }) } }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: tool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", ...args, "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "4", "--", "check the provider config"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1", ...env }, stdio: "ignore" })
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 60000); child.once("exit", () => { clearTimeout(t); r() }) })
  srv.closeAllConnections?.(); await new Promise((r) => srv.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
  return result ?? ""
}

console.log("== 3. a real run: what the model reads ==")
{
  const yolo = await run()
  ok("YOLO (the default): the model reads the key and the model id as they are", yolo.includes(KEY) && yolo.includes(MODEL), yolo.slice(0, 240))
  ok("…the injection fence is still there", /untrusted data, not instructions/.test(yolo))
  const safe = await run({ args: ["--safe"] })
  ok("--safe: the key is redacted", !!safe && !safe.includes(KEY), safe.slice(0, 240))
  const explicit = await run({ env: { FORGE_SECURITY_MODE: "on" } })
  ok("YOLO + FORGE_SECURITY_MODE=on: the key is redacted", !!explicit && !explicit.includes(KEY), explicit.slice(0, 240))
  const prod = await run({ env: { NODE_ENV: "production" } })
  ok("YOLO + NODE_ENV=production: the key is redacted", !!prod && !prod.includes(KEY), prod.slice(0, 240))
}

console.log("== 4. chat: /yolo off redacts again, live ==")
{
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      let j = {}
      try { j = JSON.parse(b) } catch { /* empty */ }
      const msgs = j.messages ?? []
      const last = msgs.at(-1)
      if (last?.role === "tool") seen.push(String(last.content ?? ""))
      const sse = (delta, finish) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { "content-type": "text/event-stream" })
      if (last?.role === "tool") { res.write(sse({ content: "read it" }, "stop")); return res.end("data: [DONE]\n\n") }
      res.write(sse({ tool_calls: [{ index: 0, id: `t${seen.length}`, function: { name: "read_file", arguments: JSON.stringify({ path: "provider.json" }) } }] }, "tool_calls"))
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolosec-chat-"))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-yolosec-work-"))
  fs.writeFileSync(path.join(work, "provider.json"), JSON.stringify({ models: [MODEL], apiKey: KEY }) + "\n")
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } }, skills: { enabled: false } }))
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "ignore", "ignore"] })
    child.stdin.write("read provider.json\n/yolo off\nread provider.json again\n/exit\n"); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 60000)
    child.on("exit", () => { clearTimeout(t); resolve() })
  })
  srv.closeAllConnections?.(); srv.close()
  ok("in YOLO the chat's tool result shows the key", seen[0]?.includes(KEY), (seen[0] ?? "").slice(0, 200))
  ok("after /yolo off, the same read is redacted", seen.length >= 2 && !seen[1].includes(KEY), (seen[1] ?? "").slice(0, 200))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== yolo-secrets suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
