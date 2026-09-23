#!/usr/bin/env node
/**
 * forge — prompt budget + stable/volatile cache split (v137.promptbudget)
 *
 * Non-vacuous: each assertion constructs the world it claims to reject.
 * A probe that cannot fail is furniture.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pbud-home-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 240) : ""}`) }
}

const {
  assemblePrompt, budgetPrompt, charBudgetFor, classifyVolatileChunk, STABLE_MARKER,
} = await import("../promptbudget.js")
const { agentSystemPrompt, agentSystemPromptParts } = await import("../agent.js")
const { thinkingParamFor, applyAnthropicSystem, applyAnthropicCaching } = await import("../providers.js")

const identity = [
  "You are forge — an autonomous terminal coding agent.",
  "Working directory: /tmp/x",
  "",
  "RULES:",
  "1. think",
  "6. Keep writes inside the working directory.",
  "7. Run in-project commands yourself.",
  "",
  "TOOLS — all available, use them automatically as needed:",
  "- todo",
].join("\n")

console.log("== 1. always-blocks survive a tiny budget ==")
{
  const r = assemblePrompt([
    { id: "rules", lane: "stable", keep: "always", rank: 100, text: "ALWAYS-BLOCK-TEXT-LONGER-THAN-TEN" },
    { id: "noise", lane: "volatile", keep: "droppable", rank: 1, text: "noise" },
  ], { budget: 10 })
  ok("budget=10 still includes always", r.included.includes("rules") && r.full.includes("ALWAYS-BLOCK-TEXT-LONGER-THAN-TEN"))
  ok("always is not in dropped", !r.dropped.some((d) => d.id === "rules"))
  ok("droppable is dropped when always already exceeds", r.dropped.some((d) => d.id === "noise"))
  ok("chars exceeds the tiny budget", r.chars > 10)
}

console.log("== 2. droppable is dropped before prefer when over budget ==")
{
  const r = assemblePrompt([
    { id: "a", lane: "stable", keep: "always", rank: 100, text: "AAAAAAAAAA" },
    { id: "p", lane: "volatile", keep: "prefer", rank: 50, text: "PPPPPPPPPP" },
    { id: "d", lane: "volatile", keep: "droppable", rank: 99, text: "DDDDDDDDDD" },
  ], { budget: 24 })
  ok("prefer is kept", r.included.includes("p"))
  ok("droppable is dropped even with a higher rank", r.dropped.some((d) => d.id === "d") && !r.included.includes("d"))
}

console.log("== 3. prefer is dropped before always ==")
{
  const r = assemblePrompt([
    { id: "a", lane: "stable", keep: "always", rank: 100, text: "AAAAAAAAAA" },
    { id: "p", lane: "volatile", keep: "prefer", rank: 90, text: "PPPPPPPPPPPPPPPPPPPP" },
  ], { budget: 15 })
  ok("always survives", r.included.includes("a"))
  ok("prefer is dropped", r.dropped.some((d) => d.id === "p" && d.keep === "prefer"))
}

console.log("== 4. stable is always a prefix of full ==")
{
  const r = assemblePrompt([
    { id: "s", lane: "stable", keep: "always", rank: 100, text: "STABLE-PREFIX" },
    { id: "v", lane: "volatile", keep: "prefer", rank: 50, text: "VOLATILE-TAIL" },
  ], { budget: 6800 })
  ok("full.startsWith(stable)", r.full.startsWith(r.stable))
  ok("full = stable + sep + volatile", r.full === r.stable + "\n\n" + r.volatile)
}

console.log("== 5. two different volatile sets share identical stable ==")
{
  const stable = { id: "s", lane: "stable", keep: "always", rank: 100, text: "IDENTITY" }
  const a = assemblePrompt([stable, { id: "v1", lane: "volatile", keep: "prefer", rank: 50, text: "TASK-A" }], { budget: 6800 })
  const b = assemblePrompt([stable, { id: "v2", lane: "volatile", keep: "prefer", rank: 50, text: "TASK-B" }], { budget: 6800 })
  ok("stable is byte-identical", a.stable === b.stable && a.stable === "IDENTITY")
  ok("volatile differs", a.volatile !== b.volatile)
}

console.log("== 6. budgetPrompt: shared identity+TOOLS, identical .stable ==")
{
  const a = budgetPrompt(identity + "\n\nSKILLS FOR THIS TASK (1)\n- foo", { klass: "SMALL" })
  const b = budgetPrompt(identity + "\n\nSKILLS FOR THIS TASK (1)\n- bar", { klass: "SMALL" })
  ok("identical .stable", a.stable === b.stable)
  ok("stable includes TOOLS heading", a.stable.includes(STABLE_MARKER))
  ok("stable does not include the skills block", !a.stable.includes("SKILLS FOR THIS TASK"))
  ok("volatile carries the skills", a.volatile.includes("SKILLS FOR THIS TASK") && a.volatile.includes("foo"))
}

console.log("== 7. classifyVolatileChunk headings ==")
{
  const skills = classifyVolatileChunk("SKILLS FOR THIS TASK (2) — call load_skill(name) before using one:\n- tdd")
  const repo = classifyVolatileChunk("REPO MAP (top-level symbols — use this to locate code before ls/grep):\n- a.js: foo")
  const tryFirst = classifyVolatileChunk("TRY FIRST (known repair — apply it, then verify; do not rediscover):\n- x")
  ok("SKILLS heading is prefer", skills.id === "skills" && skills.keep === "prefer")
  ok("REPO map is droppable", repo.id === "repomap" && repo.keep === "droppable")
  ok("TRY FIRST is prefer", tryFirst.id === "steer-repair" && tryFirst.keep === "prefer")
  ok("TRY FIRST rank is higher than SKILLS", tryFirst.rank > skills.rank)
}

console.log("== 8. charBudgetFor ordering ==")
{
  ok("MICRO < SMALL < MEDIUM < LARGE < ARCHITECTURAL",
    charBudgetFor("MICRO") < charBudgetFor("SMALL")
    && charBudgetFor("SMALL") < charBudgetFor("MEDIUM")
    && charBudgetFor("MEDIUM") < charBudgetFor("LARGE")
    && charBudgetFor("LARGE") < charBudgetFor("ARCHITECTURAL"))
  ok("RECOVERY equals MEDIUM default", charBudgetFor("RECOVERY") === charBudgetFor("MEDIUM"))
  ok("unknown klass defaults to MEDIUM", charBudgetFor("nope") === 6800 && charBudgetFor(null) === 6800)
  ok("MICRO is 3600", charBudgetFor("MICRO") === 3600)
  ok("ARCHITECTURAL is 11000", charBudgetFor("ARCHITECTURAL") === 11000)
}

console.log("== 9. agentSystemPrompt is a string; Parts returns the split ==")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pbud-"))
  const opts = { cwd: tmp, skillsDir: null, skillsEnabled: false, repoMap: false, config: {}, task: "do a thing" }
  const s = agentSystemPrompt(opts)
  const p = agentSystemPromptParts(opts)
  ok("agentSystemPrompt still a string", typeof s === "string" && s.length > 0)
  ok("Parts returns stable", typeof p.stable === "string")
  ok("Parts returns volatile", typeof p.volatile === "string")
  ok("Parts returns full", typeof p.full === "string" && p.full === s)
  ok("Parts returns dropped", Array.isArray(p.dropped))
  ok("Parts returns chars", typeof p.chars === "number" && p.chars === p.full.length)
  ok("Parts returns budget", typeof p.budget === "number" && p.budget > 0)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log("== 10. two real prompts with different tasks share .stable ==")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pbud-"))
  const base = { cwd: tmp, skillsDir: null, skillsEnabled: false, repoMap: false, config: {} }
  const a = agentSystemPromptParts({ ...base, task: "fix a typo in the readme" })
  const b = agentSystemPromptParts({ ...base, task: "rename the CSS variables in the theme file" })
  ok("equal .stable across tasks", a.stable === b.stable && a.stable.length > 0)
  ok("stable is a prefix of both fulls", a.full.startsWith(a.stable) && b.full.startsWith(b.stable))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log("== 11. huge repo-map is dropped on MICRO, kept on ARCHITECTURAL ==")
{
  const repo = "REPO MAP (top-level symbols — use this to locate code before ls/grep):\n" + "x".repeat(8000)
  const full = identity + "\n\n" + repo
  const micro = budgetPrompt(full, { klass: "MICRO" })
  const arch = budgetPrompt(full, { klass: "ARCHITECTURAL" })
  ok("MICRO dropped list contains the repo map", micro.dropped.some((d) => d.id === "repomap"))
  ok("MICRO full does not carry the 8k padding", !micro.full.includes("x".repeat(1000)))
  ok("ARCHITECTURAL keeps it (or at least does not drop it)",
    arch.included.includes("repomap") || !arch.dropped.some((d) => d.id === "repomap"))
}

console.log("== 12. the prompt still contains RULES: and TOOLS ==")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pbud-"))
  const p = agentSystemPrompt({ cwd: tmp, skillsDir: null, skillsEnabled: false, repoMap: false, config: {}, task: "do a thing" })
  ok("contains RULES:", p.includes("RULES:"))
  ok("contains TOOLS — all available", p.includes("TOOLS — all available"))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log("== 13. providers.js consumes systemStable; no TOOLS search ==")
{
  ok("thinkingParamFor still works (4.5 is budgeted)", thinkingParamFor("claude-opus-4-5", 16384).type === "enabled")
  ok("thinkingParamFor still works (4.7 is adaptive)", thinkingParamFor("claude-opus-4-7", 16384).type === "adaptive")
  const body = {}
  applyAnthropicSystem(body, { systemStable: "STABLE-PREFIX", systemVolatile: "VOLATILE-TAIL" }, "IGNORED-FULL")
  ok("systemStable is the cached block",
    Array.isArray(body.system)
    && body.system[0]?.text === "STABLE-PREFIX"
    && body.system[0]?.cache_control?.type === "ephemeral")
  ok("systemVolatile is uncached",
    body.system[1]?.text === "VOLATILE-TAIL" && body.system[1]?.cache_control == null)
  // v139 integration: breakpoint PLACEMENT belongs to applyAnthropicCaching
  // (one place, so the two request builders cannot drift — v138 §36), so the
  // fallback contract is asserted on the composed pair, the way a real
  // request is built, rather than on applyAnthropicSystem alone.
  const fallback = {}
  applyAnthropicSystem(fallback, { system: "WHOLE" }, null)
  applyAnthropicCaching(fallback)
  ok("without systemStable, whole system is one cached block",
    fallback.system?.[0]?.text === "WHOLE" && fallback.system?.[0]?.cache_control?.type === "ephemeral")
  ok("...and that is the ONLY system block", fallback.system.length === 1)

  // THE COLLISION THIS RELEASE HAD TO RESOLVE. applyAnthropicCaching marks
  // the LAST system block; applyAnthropicSystem makes the FIRST one the
  // stable prefix. Run naively together the breakpoint lands on the volatile
  // tail — caching the one part that changes every task, so the split buys
  // nothing. The breakpoint must stay on stable.
  const split = {}
  applyAnthropicSystem(split, { systemStable: "STABLE", systemVolatile: "VOL" }, null)
  applyAnthropicCaching(split)
  ok("after both, the breakpoint is on STABLE", split.system[0].cache_control?.type === "ephemeral")
  ok("...and the volatile tail stays uncached", split.system[1].cache_control == null)
  const src = fs.readFileSync(new URL("../providers.js", import.meta.url), "utf8")
  ok("providers.js references systemStable", /systemStable/.test(src))
  ok("providers.js does NOT search for the TOOLS marker", !/TOOLS — all available/.test(src))
}

console.log("== 14. default prompt does NOT say FULL CONTROL unless yolo ==")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pbud-"))
  const dflt = agentSystemPrompt({ cwd: tmp, skillsDir: null, skillsEnabled: false, repoMap: false, config: {}, task: "do a thing" })
  const yolo = agentSystemPrompt({ cwd: tmp, skillsDir: null, skillsEnabled: false, repoMap: false, config: {}, task: "do a thing", yolo: { yolo: true } })
  ok("default prompt does not say FULL CONTROL", !/FULL CONTROL \(YOLO\)/.test(dflt))
  ok("yolo prompt does say FULL CONTROL", /FULL CONTROL \(YOLO\)/.test(yolo))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== prompt-budget suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
