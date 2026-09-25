#!/usr/bin/env node
// v187 — a note stays with the project it was written in.
//
// Reported: a run began with `memory read` and got "MEMORY (~/.forge/
// memory.md): - Enhance the color schema… for the project files in agentv19"
// — a note about another project, in global memory — and went searching the
// whole disk for agentv19 (a 45-second `find /`). The memory tool's scope
// defaulted to global, so a note saved without one was read by every project,
// and a read without one read only global memory. Now a note belongs to its
// project unless the model says it is about the user, and a read without a
// scope shows this project's notes and the user's own.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-memscope-home-"))
process.env.HOME = HOME
process.env.FORGE_HOME = HOME
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const T = await import("../tools.js")
const M = await import("../memory.js")

const GLOBAL = path.join(HOME, "memory.md")
const project = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `forge-memscope-${name}-`)); fs.writeFileSync(path.join(d, "package.json"), `{"name":"${name}"}\n`); return d }
const tool = (cwd, userText = "") => { const t = T.makeToolContext({ cwd, root: cwd, userText, memoryPath: GLOBAL }); return (args) => t.exec("memory", args) }
const A = project("agentv19"), B = project("other")
const inA = tool(A, "from now on always answer in short sentences please"), inB = tool(B)

console.log("== 1. where a note goes ==")
{
  const r = await inA({ action: "append", text: "Enhance the color schema for the project files in agentv19" })
  ok("a note without a scope is saved to the project", /^OK project memory appended/.test(r), r)
  ok("…in the project's memory file, not the global one", M.memoryEntries("project", A).some((e) => /agentv19/.test(e.text)) && !(fs.existsSync(GLOBAL) && /agentv19/.test(fs.readFileSync(GLOBAL, "utf8"))))
  const g = await inA({ action: "append", text: "the user prefers dark mode everywhere", scope: "global" })
  ok("scope: global still goes to global memory", /^OK global memory appended/.test(g) && /dark mode/.test(fs.readFileSync(GLOBAL, "utf8")), g)
  const rule = await inA({ action: "append", text: "always answer in short sentences", rule: true })
  ok("a rule the user stated (rule=true) is still global by default — it is theirs, not the project's", /^OK global rule recorded/.test(rule), rule)
}

console.log("== 2. what another project reads ==")
{
  const r = await inB({ action: "read" })
  ok("project B does not read project A's note", !/agentv19/.test(r), r)
  ok("…it reads the user's global preference", /dark mode/.test(r), r)
  ok("…and the user's rule", /short sentences/.test(r), r)
  ok("the global block says it applies to every project", /every project/.test(r), r)
}

console.log("== 3. what the project itself reads ==")
{
  const r = await inA({ action: "read" })
  ok("project A reads its own note and the global memory, both labelled", /PROJECT MEMORY \(forge-memscope-agentv19-/.test(r) && /agentv19/.test(r) && /MEMORY \(~\/\.forge\/memory\.md/.test(r) && /dark mode/.test(r), r)
  ok("its own notes come first", r.indexOf("PROJECT MEMORY") < r.indexOf("MEMORY (~/.forge"), r)
  ok("scope: project reads only the project", !/dark mode/.test(await inA({ action: "read", scope: "project" })))
  ok("scope: global reads only global", !/color schema/.test(await inA({ action: "read", scope: "global" })))
  const empty = tool(project("fresh"))
  const home2 = await (async () => { const saved = fs.readFileSync(GLOBAL, "utf8"); fs.writeFileSync(GLOBAL, ""); const r2 = await empty({ action: "read" }); fs.writeFileSync(GLOBAL, saved); return r2 })()
  ok("nothing anywhere: one honest empty message", /^\(memory is empty/.test(home2), home2)
}

console.log("== 4. the run's own memory block ==")
{
  const q = "enhance the color schema for the project files"
  const inA2 = String(M.relevantMemory(q, { cwd: A }) ?? "")
  const inB2 = String(M.relevantMemory(q, { cwd: B }) ?? "")
  ok("a run in project A is handed its own note", /agentv19/.test(inA2), inA2)
  ok("a run in project B is not", !/agentv19/.test(inB2), inB2)
}

console.log("== 5. notes saved before v187 are still reachable ==")
{
  const C = project("legacy")
  fs.appendFileSync(GLOBAL, "- Enhance the border colors for the legacy dashboard files\n")
  const r = await tool(C)({ action: "forget", text: "Enhance the border colors for the legacy dashboard" })
  ok("forget without a scope finds an old note in global memory", /^OK forgot note from global memory/.test(r), r)
  ok("…and removes it", !/legacy dashboard/.test(fs.readFileSync(GLOBAL, "utf8")))
  await tool(C)({ action: "append", text: "the legacy build needs node 18 exactly" })
  const f = await tool(C)({ action: "forget", text: "the legacy build needs node" })
  ok("forget without a scope removes a project note from the project", /^OK forgot note from project memory/.test(f), f)
  fs.appendFileSync(GLOBAL, "- the deploy script runs on fridays only\n")
  await tool(C)({ action: "append", text: "the deploy script runs on mondays here" })
  await tool(C)({ action: "append", text: "the deploy script runs twice in staging" })
  const two = await tool(C)({ action: "forget", text: "the deploy script runs" })
  ok("two project notes match: it asks for more words, and does not reach into global memory", /2 notes match/.test(two) && /fridays/.test(fs.readFileSync(GLOBAL, "utf8")), two)
  const rule = await tool(C)({ action: "forget", text: "always answer in short sentences" })
  ok("a user rule in global memory is still protected", /^NOT removed/.test(rule) && /short sentences/.test(fs.readFileSync(GLOBAL, "utf8")), rule)
}

console.log("== 5b. replace rewrites the tier it names ==")
{
  const D = project("tidy"), inD = tool(D)
  await inD({ action: "append", text: "the tidy repo pins eslint at version 8" })
  const before = fs.readFileSync(GLOBAL, "utf8")
  const seen = await inD({ action: "read" })
  const r = await inD({ action: "replace", text: seen.replace(/^.*MEMORY.*$/gm, "").trim() })
  ok("replace without a scope rewrites the project's notes", /^OK project memory replaced/.test(r) && M.memoryEntries("project", D).some((e) => /eslint/.test(e.text)), r)
  ok("…and leaves global memory as it was — a both-tier read tidied up is not copied into every project", fs.readFileSync(GLOBAL, "utf8") === before)
  ok("project B still does not see the tidy repo's note", !/eslint/.test(await inB({ action: "read" })))
  const g = await inD({ action: "replace", text: "- the user prefers dark mode everywhere", scope: "global" })
  ok("scope: global replaces global notes — and keeps the user's rules", /^OK global memory replaced/.test(g) && /kept the user's 1 standing rule/.test(g) && /short sentences/.test(fs.readFileSync(GLOBAL, "utf8")), g)
  fs.rmSync(D, { recursive: true, force: true })
}

console.log("== 6. the model is told ==")
{
  const def = T.TOOL_DEFS?.find?.((d) => d.function?.name === "memory") ?? T.toolDefinitions?.().find?.((d) => d.function?.name === "memory")
  const src = def ? JSON.stringify(def) : fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  ok("the tool description says project is the default and global is for the user", /project \(default/.test(src) && /global: about the user|global \(only what is true of the user/.test(src))
  ok("…and no longer says the default is global", !/memory tier \(default global\)/.test(src))
}

for (const d of [A, B]) fs.rmSync(d, { recursive: true, force: true })
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`== memory-scope suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
