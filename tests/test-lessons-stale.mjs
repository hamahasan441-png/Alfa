#!/usr/bin/env node
/**
 * forge v155 — a fix one run proved outlives the next edit to the file.
 *
 * Measured with real headless runs before the change: v135 records "fix that
 * worked" when a check goes red, a file changes, and the check goes green, and
 * the next run IS shown it — until the file is touched again. Any later edit
 * (an unrelated function appended; the same bug coming back) made the lesson
 * stale, and stale lessons were dropped from the prompt. Also measured:
 *   - a plain `forge agent` run sees lessons only through engineering memory
 *     (continuity.js), never through context.js — whose render v132 fixed
 *     while the live one still printed an unproven next step like a fix;
 *   - the recorded symptom was mostly forge's own "[forge] …" hints;
 *   - the lesson named the file by an absolute path.
 *
 * The rule that stays: a stale lesson never CONSTRAINS (compose.js, the
 * strategies to avoid). It only informs, labelled, after every fresh one.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lstale-home-"))
process.env.HOME = HOME
delete process.env.FORGE_HOME
delete process.env.FORGE_DATA_DIR

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const L = await import("../lessons.js")
const { projectDir } = await import("../memory.js")
const { createEngMemory } = await import("../engmemory.js")

/** A project whose index says `changed` files were modified after every lesson. */
function project(changed = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lstale-"))
  const files = {}
  for (const f of ["api.js", "db.js", "ui.js"]) files[f] = { mtime: changed.includes(f) ? Date.now() + 60_000 : 1_000, size: 10, symbols: [] }
  fs.mkdirSync(projectDir(cwd), { recursive: true })
  fs.writeFileSync(path.join(projectDir(cwd), "index.json"), JSON.stringify({ version: 2, files }))
  return cwd
}
const lesson = (cwd, over) => L.recordLesson({
  failure: "npm test failed 1 time(s) before passing", cause: "the route returned 500",
  successfulRepair: "changed api.js — after which `npm test` passed", task: "fix the api route", files: ["api.js"], confidence: 0.7, ...over,
}, cwd)

console.log("== informing vs constraining ==")
{
  const cwd = project(["api.js"])
  lesson(cwd)
  const q = "the api route returns 500, fix it"
  eq("default: a stale lesson is still dropped (every constraining caller)", L.relevantLessons(q, { cwd }).length, 0)
  const inc = L.relevantLessons(q, { cwd, includeStale: true })
  ok("includeStale: it comes back…", inc.length === 1)
  ok("…marked stale", inc[0]?.stale === true)
  ok("…as a copy — the stored lesson is not changed", !("stale" in L.loadLessons(cwd)[0]))
  const text = L.lessonsForPrompt(q, { cwd })
  ok("the prompt includes it", /fix that worked: changed api\.js/.test(text), text)
  ok("…labelled", /learned before api\.js last changed — check it still applies/.test(text), text)
  ok("the planner's advisory text includes it too", /changed api\.js/.test(L.lessonsForPlan(q, { cwd }).text))
  ok("a caller can still ask for fresh only", L.lessonsForPrompt(q, { cwd, includeStale: false }) === "")
  L.recordLesson({ failure: "retry loop on the api", cause: "the route returned 500", failedStrategy: "retry the request until it passes", task: "fix the api route", files: ["api.js"] }, cwd)
  eq("ineffectiveStrategies still drops it — stale evidence never constrains", L.ineffectiveStrategies("api route 500 retry", { cwd, strategyHint: "retry" }).length, 0)
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== fresh first, stale after ==")
{
  const cwd = project(["api.js"])
  // The stale one matches the query far better than the fresh one.
  lesson(cwd, { failure: "api route 500 api route 500 api route", task: "api route 500" })
  lesson(cwd, { failure: "db migration failed", cause: "route table missing", successfulRepair: "changed db.js", files: ["db.js"], task: "fix the db migration" })
  const q = "api route 500"
  const hits = L.relevantLessons(q, { cwd, includeStale: true, limit: 3 })
  eq("the fresh lesson ranks first even though the stale one scores higher", hits.map((h) => !!h.stale), [false, true])
  eq("limit 1 keeps only the fresh one — stale never displaces current knowledge", L.relevantLessons(q, { cwd, includeStale: true, limit: 1 }).map((h) => h.files[0]), ["db.js"])
  // The async path: an embedder that prefers the stale lesson cannot put it first.
  let calls = 0
  const embedder = { embed: async (texts) => { calls++; return texts.map((t) => (/api route 500 api route/.test(t) ? [1, 0] : /db migration/.test(t) ? [0, 1] : [1, 0])) } }
  const a = await L.relevantLessonsAsync(q, { cwd, includeStale: true, limit: 3, embedder })
  // A mutation run caught v155's own first draft here: a shadowed `ranked`
  // threw inside the try, the catch returned BM25, and embeddings silently
  // stopped reranking lessons. The embedder must actually be consulted.
  eq("async: the embedder is actually consulted", calls, 1)
  eq("async: embeddings reorder within fresh and within stale, never across", a.map((h) => !!h.stale), [false, true])
  const block = await L.lessonsForPromptAsync(q, { cwd, embedder })
  ok("lessonsForPromptAsync (context.js) includes the stale lesson, labelled, after the fresh one",
    /changed db\.js[\s\S]*learned before api\.js last changed/.test(block), block)
  // within one freshness, embeddings DO reorder: two fresh lessons, BM25 says one, the embedder the other
  const cwd2 = project([])
  lesson(cwd2, { failure: "api route 500 api route 500 api route", task: "api route 500" })
  lesson(cwd2, { failure: "db migration failed", cause: "route table missing", successfulRepair: "changed db.js", files: ["db.js"], task: "fix the db migration" })
  const flip = { embed: async (texts) => texts.map((t, i) => (i === 0 ? [0, 1] : /db migration/.test(t) ? [0, 1] : [1, 0])) }
  const f = await L.relevantLessonsAsync(q, { cwd: cwd2, limit: 2, embedder: flip, alpha: 0.9 })
  eq("async: among fresh lessons the embedder's order wins (alpha 0.9)", f.map((h) => h.files[0]), ["db.js", "api.js"])
  fs.rmSync(cwd2, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== one renderer ==")
{
  const proven = L.lessonLine({ failure: "npm test failed", successful_repair: "changed a.js", cause: "boom" })
  ok("a proven repair reads as one", /fix that worked: changed a\.js/.test(proven), proven)
  const unproven = L.lessonLine({ failure: "run ended BLOCKED", solution: "allow the writes", cause: "refused" })
  ok("an unproven next step never reads as a fix", /not repaired — the next step recorded was: allow the writes/.test(unproven) && !/fix that worked/.test(unproven), unproven)
  eq("nothing recorded says so", /no repair recorded/.test(L.lessonLine({ failure: "x" })), true)
  const long = L.lessonLine({ failure: "npm test failed", successful_repair: "changed a.js", cause: "x".repeat(600) + "add(2,2) returned 0" })
  ok("the fix comes before the cause", long.indexOf("fix that worked") < long.indexOf("cause:"))
  ok(`a long cause keeps its END, where a command's error is (≤ ${L.LESSON_CAUSE_CHARS})`, long.endsWith("add(2,2) returned 0") && long.split("cause: ")[1].length <= L.LESSON_CAUSE_CHARS, long.slice(-60))
  const staleLine = L.lessonLine({ failure: "f", successful_repair: "r", files: ["/abs/path/lib.js", "b.js"], stale: true })
  ok("stale: names the files by basename", /learned before lib\.js, b\.js last changed/.test(staleLine), staleLine)
}

console.log("== engineering memory: what a `forge agent` prompt is built from ==")
{
  const cwd = project(["api.js"])
  lesson(cwd)
  const block = createEngMemory({ cwd }).retrievalBlock("the api route returns 500, fix it", { limit: 5, maxChars: 700 })
  ok("a stale lesson reaches the block", /fix that worked: changed api\.js/.test(block), block)
  ok("…tagged and labelled", /\(lesson, files changed since\)/.test(block) && /check it still applies/.test(block), block)
  L.recordLesson({ failure: "run ended BLOCKED on MUTATIONS_ALL_REFUSED", cause: "every write refused", solution: "re-run with a policy that allows the writes", task: "fix the api route" }, cwd)
  const b2 = createEngMemory({ cwd }).retrievalBlock("fix the api route blocked writes refused", { limit: 5, maxChars: 700 })
  ok("a blocked run's next step reads as unrepaired here too", /not repaired — the next step recorded was: re-run with a policy/.test(b2) && !/fix that worked: re-run/.test(b2), b2)
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== the same fix, stale vs fresh, in one ranking ==")
{
  const cwd = project(["api.js"])
  lesson(cwd, { failure: "api test failed before passing", files: ["api.js"] })
  lesson(cwd, { failure: "api test failed before passing again", successfulRepair: "changed ui.js — after which `npm test` passed", files: ["ui.js"] })
  const res = createEngMemory({ cwd }).retrieve({ query: "api test failed before passing", limit: 5 }).filter((x) => x.layer === "L5")
  eq("the fresh lesson outranks the stale one", res.map((x) => !!x.stale), [false, true])
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log("== end to end: two real headless runs ==")
async function twoRuns(between) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lstale-e2e-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  fs.writeFileSync(path.join(work, "check.js"), `const { add } = require("./lib.js")\nif (add(2, 2) !== 4) { console.error("add(2,2) returned " + add(2, 2)); process.exit(1) }\nconsole.log("ok")\n`)
  fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n")
  const script = [
    { name: "bash", input: { command: "npm test" } },
    { name: "write_file", input: { path: "lib.js", content: "exports.add = (a, b) => a + b\n" } },
    { name: "bash", input: { command: "npm test" } },
  ]
  let run = 0, run2Prompt = ""
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      if (run === 2) run2Prompt += `${typeof j.system === "string" ? j.system : JSON.stringify(j.system)}\n`
      const n = (j.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_result") : []).length
      const step = run === 1 ? script[n] : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
        ...(step ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: step.name, input: step.input }] } : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const go = async (task) => {
    run++
    const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
      "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "8", "--", task],
      { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: "ignore" })
    return new Promise((r) => { const t = setTimeout(() => { c.kill("SIGKILL"); r("timeout") }, 30000); c.once("exit", (code) => { clearTimeout(t); r(code) }) })
  }
  const c1 = await go("fix the add function so npm test passes")
  const stored = JSON.parse(fs.readFileSync(path.join(home, ".forge", "projects", fs.readdirSync(path.join(home, ".forge", "projects"))[0], "lessons.json"), "utf8"))
  between(work)
  const c2 = await go("add is broken again — make npm test pass")
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  fs.rmSync(dir, { recursive: true, force: true })
  return { c1, c2, stored, run2Prompt }
}
{
  const r = await twoRuns((work) => fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n"))
  eq("both runs complete", [r.c1, r.c2], [0, 0])
  const les = r.stored[0] ?? {}
  eq("the lesson names the file relative to the project", les.files, ["lib.js"])
  ok("…in its repair text too", /^changed lib\.js — after which `npm test` passed$/.test(les.successful_repair), les.successful_repair)
  ok("its cause is the command's own error", /add\(2,2\) returned 0/.test(les.cause), les.cause)
  ok("…not forge's hints about it", !/\[forge\]/.test(les.cause) && !/\[forge\]/.test(les.symptoms), les.cause)
  ok("the bug came back: run 2 is shown the fix that worked", /fix that worked: changed lib\.js — after which `npm test` passed/.test(r.run2Prompt), r.run2Prompt.slice(0, 300))
  ok("…labelled as learned before lib.js changed", /learned before lib\.js last changed/.test(r.run2Prompt))
  ok("…with the error that identifies the bug", /add\(2,2\) returned 0/.test(r.run2Prompt.split("--- engineering memory")[1] ?? ""))
}
{
  const r = await twoRuns((work) => fs.appendFileSync(path.join(work, "lib.js"), "exports.mul = (a, b) => a * b\n"))
  ok("an unrelated edit to the file no longer hides it", /fix that worked: changed lib\.js/.test(r.run2Prompt))
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== lessons-stale suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
