#!/usr/bin/env node
/**
 * forge v159 — what the user told forge to remember is a rule, not a search result.
 *
 * `forge memory add "…" [--project]` reached a prompt only through BM25 against
 * the task text. Measured with real headless runs, both tiers: "Always use pnpm
 * in this project, never npm or yarn." was in the prompt for "use pnpm to add
 * lodash" and absent for "add lodash as a dependency".
 *
 * What must hold:
 *   - user-authored entries (source "cli") reach every prompt, framed as rules,
 *     project first, bounded, never silently truncated;
 *   - the model's own notes (the memory tool) stay relevance-ranked;
 *   - a rule is not shown twice, and does not go stale when a file it names
 *     changes.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rules-home-"))
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
const count = (hay, needle) => hay.split(needle).length - 1

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const M = await import("../memory.js")
const { createEngMemory } = await import("../engmemory.js")

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-rules-"))
const PNPM = "Always use pnpm in this project, never npm or yarn."

console.log("== which entries are rules ==")
{
  const cwd = project()
  M.appendMemory("project", PNPM, cwd, { source: "cli" })
  M.appendMemory("project", "the build takes about four minutes on CI", cwd, { source: "tool" })
  M.appendMemory("project", "agent observed flaky port 3000", cwd, { source: "agent" })
  M.appendMemory("global", "Write commit messages in the imperative mood.", cwd, { source: "cli" })
  eq("only what the user added with `forge memory add` — project first", M.standingRules(cwd).map((r) => [r.tier, r.text]),
    [["project", PNPM], ["global", "Write commit messages in the imperative mood."]])
  const block = M.formatRules(M.standingRules(cwd))
  ok("framed as rules to follow", /^USER RULES \(saved with `forge memory add` — follow them unless the current task explicitly says otherwise\):/.test(block), block)
  ok("a global rule says it applies everywhere", /imperative mood\. \(all projects\)/.test(block), block)
  eq("no rules, no section", M.formatRules([]), "")
}

console.log("== always in the prompt, once ==")
{
  const cwd = project()
  M.appendMemory("project", PNPM, cwd, { source: "cli" })
  M.appendMemory("project", "lodash is pinned to 4.17.21 because of a CVE audit", cwd, { source: "tool" })
  const unrelated = M.relevantMemory("install the test framework", { cwd })
  ok("a task that shares no words with the rule still gets it", unrelated.includes(PNPM), unrelated)
  ok("…while the model's own unrelated note stays out", !unrelated.includes("pinned to 4.17.21"), unrelated)
  const related = M.relevantMemory("use pnpm to add lodash", { cwd })
  eq("a task that DOES share its words shows it once, not twice", count(related, "never npm or yarn"), 1)
  ok("…and the relevant note still ranks in", related.includes("pinned to 4.17.21"), related)
  ok("rules come first", related.indexOf("USER RULES") < related.indexOf("pinned"), related)
  eq("no task text at all: the rules alone", M.relevantMemory("", { cwd }), M.formatRules(M.standingRules(cwd)))
  const excluded = M.relevantMemory("use pnpm to add lodash", { cwd, rules: "exclude" })
  ok("rules: \"exclude\" (engineering memory) — neither the section nor the entry", !excluded.includes("never npm") && excluded.includes("pinned"), excluded)
  ok("rules: false (compose) — the pre-v159 pool, relevance only", !M.relevantMemory("install the test framework", { cwd, rules: false }).includes("never npm") &&
    M.relevantMemory("use pnpm to add lodash", { cwd, rules: false }).includes("never npm"))
}

console.log("== bounded, never silently cut ==")
{
  const cwd = project()
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar",
    "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "amber", "birch", "cedar", "dune"]
  for (const w of words) M.appendMemory("project", `rule number ${w}: the ${w} service must stay behind the ${w} gateway and never be called directly`, cwd, { source: "cli" })
  const all = M.standingRules(cwd)
  eq("all 30 distinct project rules are stored (plus the global one from above)", [all.filter((r) => r.tier === "project").length, all.length], [30, 31])
  const block = M.formatRules(all)
  ok(`the section stays within ${M.RULES_MAX_CHARS} characters (plus its overflow line)`, block.split("\n").slice(0, -1).join("\n").length <= M.RULES_MAX_CHARS, String(block.length))
  const shown = count(block, "\n- rule number")
  const more = /\(\+(\d+) more rules not shown — see `forge memory list --all`\)$/.exec(block)
  ok("what does not fit is counted and named: shown + not shown = every rule", more && Number(more[1]) + shown === all.length, block.slice(-120))
  const multi = M.formatRules([{ text: "line one\n  line two", tier: "project" }])
  ok("a multi-line rule is one line in the prompt", multi.endsWith("- line one line two"), multi)
}

console.log("== a rule does not go stale ==")
{
  const cwd = project()
  // the index says gen/api.ts changed after both notes were written
  fs.mkdirSync(M.projectDir(cwd), { recursive: true })
  fs.writeFileSync(path.join(M.projectDir(cwd), "index.json"), JSON.stringify({ version: 2, files: { "gen/api.ts": { mtime: Date.now() + 60_000, size: 1, symbols: [] } } }))
  M.appendMemory("project", "Never hand-edit gen/api.ts — regenerate it with `pnpm gen`.", cwd, { source: "cli" })
  M.appendMemory("project", "gen/api.ts exports 12 endpoints", cwd, { source: "tool" })
  const mem = M.relevantMemory("update the api client in gen/api.ts", { cwd })
  ok("the rule naming a changed file is still there", mem.includes("Never hand-edit gen/api.ts"), mem)
  ok("…while a FACT about that file is dropped as stale, as before", !mem.includes("exports 12 endpoints"), mem)
}

console.log("== the async path (semantic retrieval) ==")
{
  const cwd = project()
  M.appendMemory("project", PNPM, cwd, { source: "cli" })
  M.appendMemory("project", "lodash is pinned to 4.17.21 because of a CVE audit", cwd, { source: "tool" })
  let calls = 0
  const embedder = { embed: async (texts) => { calls++; return texts.map(() => [1, 0]) } }
  const a = await M.relevantMemoryAsync("add lodash as a dependency", { cwd, embedder })
  ok("with an embedder: rules included", a.includes(PNPM), a)
  ok("…the ranked part still ranked (embedder consulted)", calls === 1 && a.includes("pinned"), `calls=${calls}`)
  eq("…rule shown once", count(a, "never npm or yarn"), 1)
  const b = await M.relevantMemoryAsync("add lodash as a dependency", { cwd })
  ok("without one: the same as the sync path", b === M.relevantMemory("add lodash as a dependency", { cwd }))
  const onlyRules = project()
  M.appendMemory("project", PNPM, onlyRules, { source: "cli" })
  eq("only rules, nothing to rank: the rules", await M.relevantMemoryAsync("anything", { cwd: onlyRules, embedder }), M.formatRules(M.standingRules(onlyRules)))
}

console.log("== engineering memory does not repeat them ==")
{
  const cwd = project()
  M.appendMemory("project", PNPM, cwd, { source: "cli" })
  M.appendMemory("project", "pnpm store lives in /opt/pnpm-store on CI", cwd, { source: "tool" })
  const block = createEngMemory({ cwd }).retrievalBlock("use pnpm to add lodash", { limit: 5, maxChars: 700 })
  ok("the rule is not ranked again as evidence", !block.includes("never npm or yarn"), block)
  ok("…the model's note still is", block.includes("pnpm store lives"), block)
}

console.log("== compose keeps the relevance-only pool ==")
{
  // compose's memory lands in meta's context NEXT TO context.js's memory
  // section, which already carries the rules; compose rendering them too
  // would put every rule in the prompt twice.
  const { compose } = await import("../compose.js")
  const cwd = project()
  M.appendMemory("project", PNPM, cwd, { source: "cli" })
  const built = compose("install the test framework", { cwd, includeSkills: false, includeBlast: false })
  ok("an unrelated task: compose's memory does not repeat the rule", !String(built?.memory ?? "").includes("never npm"), String(built?.memory ?? ""))
  ok("…and does not add a rules section of its own", !String(built?.memory ?? "").includes("USER RULES"))
}

console.log("== end to end: real headless runs ==")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rules-e2e-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0" }))
  const env = { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }
  const forge = (...args) => execFileSync(process.execPath, [path.join(ROOT, "forge.js"), ...args], { cwd: work, env, encoding: "utf8" })
  forge("memory", "add", PNPM, "--project")
  forge("memory", "add", "Write commit messages in the imperative mood.")
  let prompt = ""
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      prompt += `${typeof j.system === "string" ? j.system : JSON.stringify(j.system)}\n${JSON.stringify(j.messages?.[0] ?? "")}\n`
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const run = async (task) => {
    prompt = ""
    const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
      "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "2", "--", task], { cwd: work, env, stdio: "ignore" })
    await new Promise((r) => { const t = setTimeout(() => { c.kill("SIGKILL"); r() }, 30000); c.once("exit", () => { clearTimeout(t); r() }) })
    return prompt
  }
  const p1 = await run("add lodash as a dependency")
  ok("the project rule reaches a task that does not mention it", p1.includes("never npm or yarn"))
  ok("…and so does the global one", p1.includes("imperative mood"))
  ok("…under USER RULES", p1.includes("USER RULES (saved with `forge memory add`"))
  const p2 = await run("use pnpm to add lodash")
  eq("a task that mentions it: the rule appears once in the whole prompt", count(p2, "never npm or yarn"), 1)
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  fs.rmSync(dir, { recursive: true, force: true })
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n== memory-rules suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
