/**
 * runmode.js — single loop vs orchestrator, decided in one place.
 * Pure function, zero network, no HOME needed.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chooseRunMode, RUN_MODE, ORCHESTRATED_CLASSES } from "../runmode.js"

const here = path.dirname(fileURLToPath(import.meta.url))
let n = 0
const t = (name, fn) => { fn(); n++; }

// ── default (no explicit choice): the task's class decides ───────────────
t("micro stays single", () => {
  const r = chooseRunMode({ task: "fix typo in README" })
  assert.equal(r.mode, RUN_MODE.SINGLE); assert.equal(r.class, "MICRO"); assert.equal(r.explicit, false)
})
t("small stays single", () => {
  assert.equal(chooseRunMode({ task: "USE_TOOL please run echo" }).mode, RUN_MODE.SINGLE)
})
t("large goes to orchestrator", () => {
  const r = chooseRunMode({ task: "the test suite is failing, fix it" })
  assert.equal(r.mode, RUN_MODE.META); assert.equal(r.class, "LARGE"); assert.match(r.why, /orchestrator/)
})
t("architectural goes to orchestrator", () => {
  assert.equal(chooseRunMode({ task: "refactor the auth module across files" }).mode, RUN_MODE.META)
})
t("legacy default autonomous:true means auto", () => {
  assert.equal(chooseRunMode({ task: "fix typo", config: { agent: { autonomous: true } } }).mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: "refactor across files", config: { agent: { autonomous: true } } }).mode, RUN_MODE.META)
  assert.equal(chooseRunMode({ task: "refactor across files", config: { agent: { autonomous: "auto" } } }).mode, RUN_MODE.META)
})
t("orchestrated classes are MEDIUM and up", () => {
  assert.deepEqual([...ORCHESTRATED_CLASSES], ["MEDIUM", "LARGE", "ARCHITECTURAL"])
})

// ── explicit choices win, in order ───────────────────────────────────────
const BIG = "refactor the auth module across files"
t("plan mode is always single", () => {
  assert.equal(chooseRunMode({ task: BIG, planOnly: true, flags: { auto: true } }).mode, RUN_MODE.SINGLE)
})
t("resume is always orchestrator", () => {
  assert.equal(chooseRunMode({ task: "fix typo", resume: true, flags: { single: true } }).mode, RUN_MODE.META)
})
t("--single beats a big task", () => {
  const r = chooseRunMode({ task: BIG, flags: { single: true } })
  assert.equal(r.mode, RUN_MODE.SINGLE); assert.equal(r.explicit, true)
})
t("--auto beats a small task and config false", () => {
  assert.equal(chooseRunMode({ task: "fix typo", flags: { auto: true }, config: { agent: { autonomous: false } } }).mode, RUN_MODE.META)
})
t("--auto with --single: --auto wins", () => {
  assert.equal(chooseRunMode({ task: "x", flags: { auto: true, single: true } }).mode, RUN_MODE.META)
})
t("env beats config", () => {
  assert.equal(chooseRunMode({ task: BIG, env: { FORGE_RUN_MODE: "single" }, config: { agent: { autonomous: "meta" } } }).mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: "fix typo", env: { FORGE_RUN_MODE: "meta" } }).mode, RUN_MODE.META)
  // auto in env falls through to config / class
  assert.equal(chooseRunMode({ task: "fix typo", env: { FORGE_RUN_MODE: "auto" }, config: { agent: { autonomous: "meta" } } }).mode, RUN_MODE.META)
})
t("config false / single / meta", () => {
  assert.equal(chooseRunMode({ task: BIG, config: { agent: { autonomous: false } } }).mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: BIG, config: { agent: { autonomous: "single" } } }).mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: "fix typo", config: { agent: { autonomous: "meta" } } }).mode, RUN_MODE.META)
})
t("headless stays single unless asked", () => {
  assert.equal(chooseRunMode({ task: BIG, headless: true }).mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: BIG, headless: true, flags: { auto: true } }).mode, RUN_MODE.META)
  assert.equal(chooseRunMode({ task: BIG, headless: true, config: { agent: { autonomous: "meta" } } }).mode, RUN_MODE.META)
})
t("missing input never throws", () => {
  assert.equal(chooseRunMode().mode, RUN_MODE.SINGLE)
  assert.equal(chooseRunMode({ task: null, config: null, flags: null, env: null }).mode, RUN_MODE.SINGLE)
})

// ── wiring: both entry points use the chooser ────────────────────────────
t("forge agent and chat are wired to runmode.js", () => {
  const forge = fs.readFileSync(path.join(here, "..", "forge.js"), "utf8")
  assert.match(forge, /chooseRunMode\(\{ task, config: cfg, flags, env: process\.env, planOnly: planMode, headless \}\)/)
  assert.match(forge, /if \(runMode\.mode === "meta"\) \{/)
  assert.doesNotMatch(forge, /flags\.auto === true \|\| cfg\.agent\?\.autonomous === "meta"/)
  assert.match(forge, /"single"/)
  const chat = fs.readFileSync(path.join(here, "..", "chat.js"), "utf8")
  assert.match(chat, /chooseRunMode\(\{ task, config, env: process\.env \}\)/)
  assert.match(chat, /resumeTaskId != null \|\| ttyMeta \|\|/)
})

console.log(`runmode ${n}/${n} PASS`)
