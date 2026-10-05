#!/usr/bin/env node
/**
 * forge — a new task starts from the command you just typed.
 *
 * The complaint: "when I start a new task, understand MY command and task —
 * don't automatically use the last other message, and don't complicate
 * memory, chat and sessions."
 *
 * The rule, proven against the real CLI and a mock model:
 *   - `forge agent "<task>"` sends the model that task, not earlier runs'
 *     goals, blockers or questions (agent.continuity: true opts back in) —
 *     but what forge LEARNED that matches the task (a lesson) still reaches
 *     it: memory is kept, other work's state is not
 *   - a new `forge chat` (piped or terminal) is a new conversation; the last
 *     one is mentioned, not loaded (chat.autoRehydrate: true opts back in)
 *   - a question an EARLIER conversation asked does not swallow a new line
 *   - `forge chat --continue` / `/resume` bring all of it back, and `/new`
 *     drops it again
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fresh-"))
const CH = path.join(TMP, "home")
fs.mkdirSync(CH, { recursive: true })
// this process reads the same stores the children write
process.env.FORGE_HOME = CH

const REPO = path.join(TMP, "repo")
fs.mkdirSync(path.join(REPO, ".git"), { recursive: true })
fs.writeFileSync(path.join(REPO, "package.json"), '{"name":"probe"}\n')

// ---- a mock model that records every prompt ---------------------------------
const prompts = []
const server = http.createServer((req, res) => {
  let b = ""
  req.on("data", (c) => { b += c })
  req.on("end", () => {
    try { prompts.push(JSON.parse(b).messages.map((m) => `[${m.role}] ${String(m.content ?? "")}`).join("\n")) } catch { /* probes */ }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
      choices: [{ index: 0, message: { role: "assistant", content: "Understood.\nEND" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const writeConfig = (extra = {}) => fs.writeFileSync(path.join(CH, "config.json"), JSON.stringify({
  activeProvider: "mock",
  providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "mock-1" } },
  tools: { assumeYes: true },
  ...extra,
  agent: { autonomous: true, maxSteps: 2, maxSegments: 1, ...(extra.agent ?? {}) },
  chat: { ...(extra.chat ?? {}) },
}))
writeConfig()

const env = { ...process.env, FORGE_HOME: CH, NO_COLOR: "1" }
const finish = (child, resolve) => {
  let out = ""
  child.stdout.on("data", (d) => { out += d })
  child.stderr?.on("data", (d) => { out += d })
  const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "timeout", out }) }, 120000)
  child.on("exit", (code) => { clearTimeout(t); resolve({ code, out }) })
}
/** piped (non-terminal) run */
const run = (args, input = "") => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), ...args], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] })
  child.stdin.write(input); child.stdin.end()
  finish(child, resolve)
})
const since = (n) => prompts.slice(n)
const has = (ps, re) => ps.some((p) => re.test(p))

const GOAL = "Build a CSV-to-JSON converter in convert.js with a --pretty flag"
const OLD_GOAL = /CSV-to-JSON|convert\.js/i

try {
  console.log("== 1. earlier work exists in this project ==")
  {
    const r1 = await run(["chat"], [GOAL, "/agent yes, authorized, start", "/exit", ""].join("\n"))
    ok("session 1 ran (a conversation, an agent task)", r1.code === 0, r1.out.slice(-300))
    // and a question that earlier work left unanswered
    const de = await import("../decisionengine.js")
    de.createDecisionEngine({ cwd: REPO, taskId: "t-old" })
      .ask({ title: "Storage backend", question: "Which storage backend should convert.js use?", options: [{ id: "a", label: "SQLite" }, { id: "b", label: "Postgres" }], key: "storage" })
    ok("an old question is pending", de.loadAskings(REPO).some((d) => d.key === "storage" && d.status === "PENDING"))
    // and a lesson that matches the NEXT task's own words
    const L = await import("../lessons.js")
    L.recordLesson({ failure: "the README lint failed before passing", cause: "markdownlint MD041 first line must be a heading",
      successfulRepair: "made the README's first line a level-1 heading — after which `npm run lint` passed",
      task: "add a README that explains the project", files: ["README.md"], confidence: 0.8 }, REPO)
  }

  console.log("== 1b. the two kinds, at the source ==")
  {
    const { continuityBlock } = await import("../continuity.js")
    const fresh = await continuityBlock({ cwd: REPO, query: "add a README that explains the project", workState: false })
    ok("a new task's block has the matching lesson", /first line a level-1 heading/.test(fresh), fresh.slice(0, 400))
    ok("…headed as learning, not as earlier work", /^WHAT FORGE HAS LEARNED/.test(fresh) && !/CONTINUITY —/.test(fresh))
    ok("…and no work state: no open question, no other task", !/STILL WAITING|Which storage backend|ALREADY UNDERWAY|ALREADY SAID/.test(fresh), fresh)
    const cont = await continuityBlock({ cwd: REPO, query: "add a README that explains the project" })
    ok("a continued task's block still has the work state", /STILL WAITING/.test(cont) && /^CONTINUITY —/.test(cont), cont.slice(0, 300))
  }

  console.log("== 2. forge agent: a new task is its own command ==")
  {
    const n = prompts.length
    const r = await run(["agent", "add a README that explains the project"])
    const ps = since(n)
    ok("the run reached the model", ps.length > 0, r.out.slice(-300))
    ok("…with the new command", has(ps, /add a README that explains the project/))
    ok("…and none of the earlier task", !has(ps, OLD_GOAL), ps.map((p) => p.slice(0, 120)).join(" // ").slice(0, 400))
    ok("…no continuity block", !has(ps, /CONTINUITY —/))
    ok("…and not the old question", !has(ps, /STILL WAITING|Which storage backend/))
    // Whether the lessons fit is the prompt budget's call (a MICRO task's
    // 3600 chars may have no room; lessons-stale / lesson-outcome prove they
    // reach a run that has it). What this change owns: the block arrives
    // WHOLE — never the old header and footer with the lesson cut out between.
    ok("what forge learned arrives whole or not at all — never an empty frame",
      ps.every((p) => !/WHAT FORGE HAS LEARNED/.test(p) || /first line a level-1 heading/.test(p)),
      ps.map((p) => p.slice(p.indexOf("WHAT FORGE"), p.indexOf("WHAT FORGE") + 300)).join(" // "))
  }
  {
    writeConfig({ agent: { continuity: true } })
    const n = prompts.length
    await run(["agent", "add a CHANGELOG"])
    ok("agent.continuity: true opts back in to earlier work", has(since(n), /CONTINUITY —/), `prompts: ${since(n).length}`)
    writeConfig()
  }

  console.log("== 3. a new chat is a new conversation ==")
  {
    const n = prompts.length
    const r = await run(["chat"], ["SQLite", "/exit", ""].join("\n"))
    const ps = since(n)
    ok("the chat reached the model", ps.length > 0, r.out.slice(-300))
    ok("…without the earlier conversation or its work", !has(ps, OLD_GOAL) && !has(ps, /CONTINUITY —/), ps.map((p) => p.slice(-200)).join(" // ").slice(0, 400))
    const { loadAskings } = await import("../decisionengine.js")
    ok("a line in a NEW conversation does not answer an OLD question",
      loadAskings(REPO).find((d) => d.key === "storage")?.status === "PENDING", r.out.slice(-300))
    ok("…and nothing says it did", !/answered:/.test(r.out))
  }

  console.log("== 4. --continue brings it all back; /new drops it ==")
  {
    const n = prompts.length
    const r = await run(["chat", "--continue"], ["SQLite", "/new", "a brand new question about tabs", "/exit", ""].join("\n"))
    ok("the continued chat ran", r.code === 0, r.out.slice(-300))
    const ps = since(n)
    const before = ps.filter((p) => !/a brand new question about tabs/.test(p))
    const after = ps.filter((p) => /a brand new question about tabs/.test(p))
    ok("a continued conversation carries its earlier work", has(before, /CONTINUITY —/) && has(before, OLD_GOAL), before.map((p) => p.slice(0, 120)).join(" // ").slice(0, 400))
    const { loadAskings } = await import("../decisionengine.js")
    ok("…and a line there answers the question it left open", loadAskings(REPO).find((d) => d.key === "storage")?.status === "ANSWERED", r.out.slice(-400))
    ok("after /new the model sees the new question", after.length > 0)
    ok("…and nothing from before /new", !has(after, OLD_GOAL) && !has(after, /CONTINUITY —/) && !has(after, /\[user\] SQLite/),
      after.map((p) => p.slice(0, 300)).join(" // ").slice(0, 500))
  }

  console.log("== 5. a terminal start: mentioned, not loaded ==")
  {
    // a real terminal (script(1) gives the child a pty)
    const tty = (input) => new Promise((resolve) => {
      const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "forge.js"))} chat`
      const child = spawn("script", ["-qec", cmd, "/dev/null"], { cwd: REPO, env: { ...env, TERM: "dumb", COLUMNS: "100", LINES: "30" }, stdio: ["pipe", "pipe", "pipe"] })
      // let the UI come up before typing
      setTimeout(() => { child.stdin.write(input) }, 2500)
      setTimeout(() => { try { child.stdin.end() } catch {} }, 6000)
      finish(child, resolve)
    })
    const r = await tty("/exit\r")
    const out = r.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    ok("a terminal chat says the last conversation is saved", /your last one here is saved/.test(out), out.slice(0, 600))
    ok("…and does not reattach it", !/rehydrated previous session/.test(out))
    writeConfig({ chat: { autoRehydrate: true } })
    const r2 = await tty("/exit\r")
    const out2 = r2.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    ok("chat.autoRehydrate: true still reattaches", /rehydrated previous session/.test(out2), out2.slice(0, 600))
    writeConfig()
  }
} finally {
  server.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== fresh-task suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
