#!/usr/bin/env node
// v186 — an identifier is not a key.
//
// Reported: a run debugging a provider read `"models":["[redacted
// high-entropy value]"]` — the high-entropy rule took the model id
// deepseek-ai/DeepSeek-V4-Flash-0731 for a key, and the agent could not see
// what it was fixing. With YOLO off (in YOLO nothing is redacted since v185),
// identifiers — model ids, branch names — now pass; keys stay redacted.
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
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-modelids-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const S = await import("../secrets.js")

console.log("== 1. identifiers pass ==")
for (const id of [
  "deepseek-ai/DeepSeek-V4-Flash-0731", "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
  "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1", "moonshotai/Kimi-K2-Instruct-0905-preview", "google/gemini-2_5-flash-preview-05-20",
  "openrouter/qwen3-coder-480b-a35b-instruct", "claude/forge-v185-yolo-no-redaction",
]) ok(id, S.redact(`model ${id} here`) === `model ${id} here`, S.redact(id))

console.log("== 2. keys stay redacted ==")
for (const key of [
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4eHh4eHg=",
  "dGhpcy1pcy1hLXNlY3JldC1rZXktdmFsdWUtMTIz", "ab12-cd34-ef56-gh78-ij90-kl12-mn34-op56", "pk_Xy7Qz_Lm4Np8Rs2Tv6Wx0Yz3Ab5Cd9Ef1Gh",
  "Kp9-Wq2-Zx7-Rt4-Yu6-Io1-Pa3-Sd8-Fg5-Hj0", "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
]) ok(`redacted: ${key.slice(0, 24)}…`, !S.redact(`x ${key} y`).includes(key), S.redact(key))
console.log("== 2b. each rule, on a string only it stops ==")
for (const [rule, key] of [
  ["a 4+ letter run needs a vowel", "Bcdfg-Hjklm-Npqrs-Tvwxz-Bcdfg-Hjklm"],
  ["only one letter may follow a number", "Tiger-Mango26rN-Lemon-Sugar-Onion-Apple"],
  ["two pieces must carry a real word", "Mango-ab12-cd34-ef56-gh78-ij90-kl12"],
  ["one word must have 5+ letters", "Kiwi-Lime-ab12-cd34-ef56-gh78-ij90-kl12"],
  ["no piece longer than 20", "AbCdEfGhIjKlMnOpQrStUvWx-Mango-Lemon"],
  ["at least 3 pieces", "Mangolemonadepie-Sugarplumtreesss"],
]) ok(`${rule}: ${key.slice(0, 22)}… stays redacted`, !S.looksLikeIdentifier(key) && !S.redact(`x ${key} y`).includes(key), S.redact(key))
ok("a secret-NAMED value is masked whatever its shape", !S.redact("password=correct-horse-battery-staple-orange").includes("battery"))
ok("an identifier is not counted as a secret found", S.redactSecrets("deepseek-ai/DeepSeek-V4-Flash-0731").found === 0)

console.log("== 3. random keys shaped like identifiers do not pass ==")
{
  // seeded, so the same keys every run: a randomized test must not be a coin
  // flip. Only strings of 32+ characters are ever candidates (BLOB_RE).
  let seed = 0x5eed186
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const pick = () => cs[Math.floor(rnd() * cs.length)]
  const passedA = [], passedB = []
  const N = 50000
  for (let i = 0; i < N; i++) {
    let s1 = ""
    for (let j = 0; j < 40; j++) s1 += rnd() < 0.12 ? "-_/"[Math.floor(rnd() * 3)] : pick()
    if (S.looksLikeIdentifier(s1)) passedA.push(s1)
    const groups = []
    const n = 5 + Math.floor(rnd() * 4)
    for (let g = 0; g < n; g++) { let x = ""; const len = 4 + Math.floor(rnd() * 3); for (let j = 0; j < len; j++) x += pick(); groups.push(x) }
    const s2 = groups.join("-")
    if (s2.length >= 32 && S.looksLikeIdentifier(s2)) passedB.push(s2)
  }
  ok(`${N} random 40-character keys with separators: none taken for an identifier`, passedA.length === 0, passedA.slice(0, 3).join(" "))
  ok(`${N} random grouped keys of 32+ characters: none taken for an identifier`, passedB.length === 0, passedB.slice(0, 3).join(" "))
}

console.log("== 4. a real run with YOLO off: the model reads the ids, not the key ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-modelids-run-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "provider.json"), JSON.stringify({ models: ["deepseek-ai/DeepSeek-V4-Flash-0731"], apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }) + "\n")
  let result = ""
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const j = JSON.parse(b || "{}")
      const tool = (j.messages ?? []).find((m) => m.role === "tool")
      if (tool) result = String(tool.content ?? "")
      const msg = tool ? { role: "assistant", content: "done" } : { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat provider.json" }) } }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: tool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--safe", "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "4", "--", "check the provider config"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
  await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r() }, 60000); child.once("exit", () => { clearTimeout(t); r() }) })
  srv.closeAllConnections?.(); await new Promise((r) => srv.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
  ok("the model id reaches the model", result.includes("deepseek-ai/DeepSeek-V4-Flash-0731"), result.slice(0, 200))
  ok("…the key beside it does not", !!result && !result.includes("sk-live-abcdefghijklmnopqrstuvwxyz0123456789"))
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== model-ids suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
