#!/usr/bin/env node
// v194 — prompt engineering: what the model is told, said once, plainly.
//
// 1. A dropped chat answer is continued with the words it stopped at quoted,
//    and whatever a model repeats anyway is trimmed where the pieces meet
//    (closes `stream-continue-no-repeat`).
// 2. The agent's system prompt: rules numbered 1..N (no "6b"), no "think step
//    by step", the level-2 brief in words instead of a JSON dump of forge's
//    planner state, and the gaps said once instead of twice in two formats.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prompteng-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const CH = await import("../chat.js")
const AG = await import("../agent.js")
const D = await import("../disciplines.js")
const PB = await import("../promptbudget.js")

console.log("== 1. the continuation note quotes where the answer stopped ==")
{
  const n = CH.streamContinueNote("The fix: add a retry around the fetch")
  ok("it quotes the last words", /ends with: «The fix: add a retry around the fetch»/.test(n), n)
  ok("…and asks for the very next word", /continue from the very next word after that/.test(n))
  ok("…keeping v176's instruction", /Continue exactly where it stopped/.test(n))
  const long = CH.streamContinueNote(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "))
  ok("a long answer: the last 12 words, marked as a tail", /«…w28 w29 w30 w31 w32 w33 w34 w35 w36 w37 w38 w39»/.test(long), long)
  ok("nothing shown: v176's note as it was", CH.streamContinueNote("  ") === CH.STREAM_CONTINUE_NOTE)
}

console.log("== 2. what a continuation repeats is trimmed ==")
{
  const shown = "The fix: add a retry around the fetch"
  const cut = (next) => next.slice(CH.repeatedStart(shown, next))
  ok("three repeated words are dropped", cut(" around the fetch call, then log the error.") === " call, then log the error.", JSON.stringify(cut(" around the fetch call, then log the error.")))
  ok("the whole shown tail repeated", cut("add a retry around the fetch call") === " call")
  ok("a single repeated word is kept (\"the the\" can be real)", cut(" fetch and more") === " fetch and more")
  ok("no repeat: nothing dropped", CH.repeatedStart(shown, " call, then log the error.") === 0)
  ok("a line break before the repeat is handled", cut("\n\naround the fetch call") === " call")
  ok("words must match exactly (case)", CH.repeatedStart(shown, " Around The fetch call") === 0)
  ok("at least REPEAT_MIN_WORDS", CH.REPEAT_MIN_WORDS === 2)
}

console.log("== 3. a real chat whose stream drops mid-answer ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prompteng-chat-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      const j = JSON.parse(b || "{}")
      seen.push(j)
      const chunk = (content, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { "content-type": "text/event-stream" })
      if (seen.length === 1) { res.write(chunk("The fix: add a retry ")); return res.end(chunk("around the fetch")) }
      res.write(chunk(" around the fetch call, "))
      res.write(chunk("then log the error.", "stop"))
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } }, tools: { assumeYes: true }, skills: { enabled: false } }))
  let stdout = ""
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "ignore"] })
    child.stdout.on("data", (d) => { stdout += d })
    child.stdin.write("how do I fix the flaky fetch?\n/exit\n"); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 60000)
    child.once("exit", () => { clearTimeout(t); resolve() })
  })
  srv.closeAllConnections?.(); srv.close()
  let saved = ""
  try { const sd = path.join(home, "sessions"); saved = fs.readdirSync(sd, { recursive: true }).filter((f) => String(f).endsWith(".json")).map((f) => fs.readFileSync(path.join(sd, String(f)), "utf8")).join("\n") } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  const ask = JSON.stringify(seen[1]?.messages ?? [])
  ok("the continuation request quotes where it stopped", /ends with: «The fix: add a retry around the fetch»/.test(ask), ask.slice(-300))
  ok("on screen: joined without the repeated words", /add a retry around the fetch call, then log the error\./.test(stdout) && !/around the fetch around the fetch/.test(stdout), stdout.slice(-300))
  ok("in the saved session too", /add a retry around the fetch call, then log the error\./.test(saved) && !/around the fetch around the fetch/.test(saved))
}

console.log("== 4. the agent's system prompt ==")
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prompteng-proj-"))
fs.writeFileSync(path.join(PROJ, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node test.js" } }))
fs.writeFileSync(path.join(PROJ, "index.js"), "export const add = (a, b) => a + b\n")
fs.writeFileSync(path.join(PROJ, "test.js"), "import { add } from './index.js'; if (add(1, 2) !== 3) process.exit(1)\n")
const prompt = (task) => AG.agentSystemPrompt({ cwd: PROJ, task, config: {}, skillsDir: null, skillsEnabled: true, repoMap: true })
{
  const p = prompt("add a subtract function and test it")
  const nums = D.ruleNumbers(p)
  ok(`the rules are numbered 1..${nums.length}, in order`, nums.length === 9 && nums.join() === "1,2,3,4,5,6,7,8,9", nums.join(" "))
  ok("no \"think step by step\"; rule 1 says to look with tools", !/think step by step/i.test(p) && /^1\. Inspect reality with tools/m.test(p))
  ok("git_status is for a git repository", /In a git repository check `git_status` first/.test(p))
  ok("the delegate roles read as words, not \"role=tuner\"", !/role=tuner/.test(p) && /role: researcher, reviewer, tester, security or coder/.test(p))
  ok("no raw JSON in the prompt", D.jsonBlob(p) === null, D.jsonBlob(p))
  ok("the level-2 brief is words, under its heading", /^LEVEL-2 AUTONOMY: approaches to weigh: minimal-change, test-first, refactor-safe • verify at MEDIUM/m.test(p), p.split("\n").find((l) => /LEVEL-2/.test(l)))
  ok("…and prompt budgeting still ranks it as the droppable level-2 block", PB.classifyVolatileChunk(p.split("\n").find((l) => /LEVEL-2/.test(l))).id === "level2")
  ok("…without the planner's internal schedule", !/maxParallel|singleWriter|contextCompressed|schedule/.test(p))
  ok("nothing said twice — the gaps once", D.saidTwice(p).length === 0 && p.split("\n").filter((l) => /^\[gaps\]|^GAPS:/.test(l)).length <= 1, D.saidTwice(p).join(" | "))
  ok("no double blank line where the V4 line is absent", !/\n\n\n/.test(p))
  const a = D.stablePrefix(p), b = D.stablePrefix(prompt("rename the CSS variables in the theme"))
  ok("two tasks still share a byte-identical cacheable prefix", a && a === b)
}

console.log("== 5. the level-2 brief, formatted ==")
{
  const l2 = { decomposition: { nodes: [{ id: "a", objective: "add the parser", dependencies: [] }, { id: "b", objective: "wire it into the CLI", dependencies: ["a"] }] }, counterfactual: { candidates: [{ id: "minimal-change" }] }, verification: { level: "HIGH", blast: { radius: 3, unknown: false } } }
  const t = AG.formatLevel2Brief(l2, "add a parser and wire it in")
  ok("several steps are listed, with what each waits for", t === "LEVEL-2 AUTONOMY: steps: 1) add the parser; 2) wire it into the CLI (after 1) • approaches to weigh: minimal-change • verify at HIGH (blast radius 3)", t)
  ok("one step that is the task itself is not repeated back", !/steps:/.test(AG.formatLevel2Brief({ ...l2, decomposition: { nodes: [{ id: "a", objective: "do it", dependencies: [] }] } }, "do it")))
  ok("nothing to say: nothing", AG.formatLevel2Brief({}, "x") === "")
}

try { fs.rmSync(PROJ, { recursive: true, force: true }); fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== prompt-engineering suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
