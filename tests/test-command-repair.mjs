#!/usr/bin/env node
/**
 * forge v156 — a check that a COMMAND fixed teaches the next run.
 *
 * v135 credits a red-then-green check only to the files written in between.
 * Measured with real headless runs at v155: `npm test` red (config.json
 * missing) → `node setup.js` → green recorded 0 lessons, and the next run
 * failing the same way was told nothing. Installs, setup and codegen steps,
 * migrations: the commonest repairs in a fresh checkout or a benchmark task.
 *
 * What must hold:
 *   - only commands that could change state are credited (not `cat`, `ls`,
 *     `git status`), and only ones that succeeded;
 *   - only commands between the LAST failure and the pass, by execution order;
 *   - a check that went green with nothing in between teaches nothing.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const { looksLikeStateChange, looksLikeCheck } = await import("../agent.js")
const { provenRepairs } = await import("../lessons.js")

console.log("== could this command have changed anything? ==")
{
  const yes = ["npm install", "npm ci", "node setup.js", "pip install -r requirements.txt", "make", "cd app && npm ci",
    "echo '{}' > config.json", "cat a >> b", "sed -i 's/a/b/' f.txt", "sed -i.bak s/a/b/ f", "git checkout -- lib.js", "git stash",
    "rm -rf build", "FOO=1 node gen.js", "npx prisma migrate dev", "mkdir -p out", "cp a b", "chmod +x run.sh",
    "python manage.py migrate", "ls && npm install", "printf x > f"]
  const no = ["ls", "cat f", "grep -n x f", "git status", "git diff", "git log --oneline -3", "echo hi", "sed -n 1p f",
    "cd dir", "ls 2>&1", "cat f 2>/dev/null", "find . -name x", "pwd && ls", "", "which node", "cat x > /dev/null",
    "awk '{print $1}' f", "git show HEAD", "echo done >&2", "head -5 f | sort | uniq"]
  const wrongYes = yes.filter((c) => !looksLikeStateChange(c))
  const wrongNo = no.filter((c) => looksLikeStateChange(c))
  ok(`state-changing: all ${yes.length} recognised`, !wrongYes.length, JSON.stringify(wrongYes))
  ok(`read-only: none of ${no.length} credited`, !wrongNo.length, JSON.stringify(wrongNo))
  // a check is recorded as a check, not as a repair — the two branches are exclusive
  ok("`npm test` is a check (so never also a repair)", looksLikeCheck("npm test"))
}

console.log("== what provenRepairs credits ==")
{
  const chk = (passed, commandIndex, extra = {}) => ({ command: "npm test", passed, step: 1, tail: passed ? "" : "config.json is missing", commandIndex, writeIndex: 0, ...extra })
  const [r] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, 1)], commands: ["node setup.js"] })
  eq("the command between the red and green check", r.ran, ["node setup.js"])
  eq("…with no files", r.changed, [])
  const [before] = provenRepairs({ commandChecks: [chk(false, 1), chk(true, 2)], commands: ["npm install", "node setup.js"] })
  eq("a command before the failure is not credited", before.ran, ["node setup.js"])
  const [after] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, 1)], commands: ["node setup.js", "npm run build"] })
  eq("a command after the pass is not credited", after.ran, ["node setup.js"])
  const [last] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, 1), chk(false, 2), chk(true, 3)], commands: ["a.sh", "b.sh", "c.sh"] })
  eq("only the LAST failure counts: earlier red/green cycles were superseded", last.ran, ["c.sh"])
  const [noIdx] = provenRepairs({ commandChecks: [chk(false, undefined), chk(true, undefined)], commands: ["node setup.js"] })
  eq("no commandIndex, no credit — there is no step fallback for commands", noIdx.ran, [])
  const [halfIdx] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, undefined)], commands: ["node setup.js", "npm run later"] })
  eq("…and none when only one end has one: the other end cannot be placed", halfIdx.ran, [])
  const [dup] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, 3)], commands: ["npm i", "npm i", "node g.js"] })
  eq("repeats are credited once", dup.ran, ["npm i", "node g.js"])
  const many = Array.from({ length: 10 }, (_, i) => `step${i}.sh`)
  const [cap] = provenRepairs({ commandChecks: [chk(false, 0), chk(true, 10)], commands: many })
  eq("at most 6, the LAST ones — nearest the pass", cap.ran, many.slice(-6))
  const [both] = provenRepairs({ commandChecks: [chk(false, 0, { writeIndex: 0 }), chk(true, 1, { writeIndex: 1 })], commands: ["npm i"], writes: ["/p/lib.js"] })
  eq("files and commands together", [both.changed, both.ran], [["/p/lib.js"], ["npm i"]])
  eq("a check that never failed credits nothing", provenRepairs({ commandChecks: [chk(true, 0), chk(true, 1)], commands: ["x"] }).length, 0)
  eq("older records without `commands` still work", provenRepairs({ commandChecks: [chk(false, 0), chk(true, 1)] })[0].ran, [])
}

/** Two headless runs in one project; run 1 follows `script`, run 2 does nothing. */
async function runs({ files, script, between = () => {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cmdrep-"))
  const home = path.join(dir, "home"), work = path.join(dir, "work")
  fs.mkdirSync(home); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(work, f), t)
  let run = 0, prompt2 = "", so1 = ""
  const srv = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const j = JSON.parse(body)
      if (run === 2) prompt2 += `${typeof j.system === "string" ? j.system : JSON.stringify(j.system)}\n`
      const n = (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "tool_result") : []).length
      const step = run === 1 ? script[n] : null
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
        ...(step ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: step.name ?? "bash", input: step.input ?? { command: step } }] }
          : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const go = async (task) => {
    run++
    const c = spawn(process.execPath, [path.join(ROOT, "forge.js"), "agent", "--headless", "--yolo", "--provider", "anthropic", "--model", "stub",
      "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "10", "--", task],
      { cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "k", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "ignore"] })
    let so = ""
    c.stdout.on("data", (d) => { so += d })
    const code = await new Promise((r) => { const t = setTimeout(() => { c.kill("SIGKILL"); r("timeout") }, 30000); c.once("exit", (x) => { clearTimeout(t); r(x) }) })
    if (run === 1) so1 = so
    return code
  }
  const c1 = await go("make npm test pass")
  let lessons = []
  try { const pd = path.join(home, ".forge", "projects"); lessons = JSON.parse(fs.readFileSync(path.join(pd, fs.readdirSync(pd)[0], "lessons.json"), "utf8")) } catch { /* none */ }
  between(work)
  const c2 = await go("npm test fails again — make it pass")
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) })
  fs.rmSync(dir, { recursive: true, force: true })
  return { c1, c2, lessons, prompt2, so1 }
}
const NEEDS_CONFIG = {
  "check.js": `const fs = require("fs")\nif (!fs.existsSync("config.json")) { console.error("config.json is missing"); process.exit(1) }\nconsole.log("ok")\n`,
  "setup.js": `require("fs").writeFileSync("config.json", "{}")\n`,
}

console.log("== end to end: a setup step ==")
{
  const r = await runs({ files: NEEDS_CONFIG, script: ["npm test", "node setup.js", "npm test"], between: (w) => fs.rmSync(path.join(w, "config.json")) })
  eq("both runs complete", [r.c1, r.c2], [0, 0])
  eq("one lesson", r.lessons.length, 1)
  const l = r.lessons[0] ?? {}
  eq("its repair is the command", l.successful_repair, "ran `node setup.js` — after which `npm test` passed")
  eq("it names no files — so no edit can make it stale", l.files, [])
  ok("its cause is the real error", /config\.json is missing/.test(l.cause), l.cause)
  ok("run 1 said what it learned", /learned: npm test went green after ran `node setup\.js`/.test(r.so1), r.so1.slice(-300))
  ok("run 2, failing the same way, is shown it", /fix that worked: ran `node setup\.js` — after which `npm test` passed/.test(r.prompt2))
}

console.log("== only what could have fixed it ==")
{
  const r = await runs({ files: { ...NEEDS_CONFIG, "broken.js": "process.exit(3)\n" },
    script: ["npm test", "cat check.js", "git status", "node broken.js", "node setup.js", "ls", "npm test"] })
  eq("a reader, a failed command and a read-only git are left out", r.lessons[0]?.successful_repair, "ran `node setup.js` — after which `npm test` passed")
}

console.log("== files and a command together ==")
{
  const r = await runs({
    files: { "check.js": `const fs = require("fs"); const { add } = require("./lib.js")\nif (!fs.existsSync("config.json") || add(2, 2) !== 4) { console.error("not ready"); process.exit(1) }\n`, "lib.js": "exports.add = (a, b) => a - b\n", "setup.js": NEEDS_CONFIG["setup.js"] },
    script: ["npm test", { name: "write_file", input: { path: "lib.js", content: "exports.add = (a, b) => a + b\n" } }, "node setup.js", "npm test"],
  })
  eq("both are credited", r.lessons[0]?.successful_repair, "changed lib.js; ran `node setup.js` — after which `npm test` passed")
}

console.log("== nothing in between, nothing learned ==")
{
  // check.js fails once and then passes on its own (it leaves a marker): a
  // flaky check, not a repair. Nothing ran and nothing was written in between.
  const r = await runs({ files: { "check.js": `const fs = require("fs")\nif (!fs.existsSync(".seen")) { fs.writeFileSync(".seen", ""); console.error("flaky"); process.exit(1) }\n` },
    script: ["npm test", "npm test"] })
  eq("a check that went green by itself records no lesson", r.lessons.length, 0)
}

console.log(`\n== command-repair suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
