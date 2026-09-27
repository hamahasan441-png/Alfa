/**
 * forge — the V5 authority bench cases (v202–v206).
 *
 * Programme cases for the V5 releases: one policy (v202), recovery that
 * happens once (v203), one review contract (v204), evidence beyond files and
 * the model that ran (v205), and the memory of what did not work (v206).
 *
 * Split out of benchsuite.js at v206. The repository graph skips any source
 * file over 256 KiB (repomap.js `maxBytesPerFile`), and benchsuite.js had
 * grown past it — so forge's own bench vanished from forge's own graph
 * (test-graph-integrity). Splitting keeps both files indexable; raising the
 * limit for one file would change what every project's graph admits.
 *
 * `v5Cases(h)` takes the suite's helpers (the verdict `ok`, the LANE / HOW /
 * DISCIPLINE vocabularies, `scriptedHeadlessRun`, the repo root) so this
 * module never imports benchsuite.js back.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, execFileSync, spawn } from "node:child_process"

export function v5Cases({ ok, LANE, HOW, DISCIPLINE, scriptedHeadlessRun, HERE }) {
  /** v203: run `body` (an async module body returning JSON) in a child whose
   *  FORGE_HOME is `home` — the task and journal stores are resolved at import. */
  function inForgeHome(home, body, { cwd = HERE, env = {} } = {}) {
    const code = `const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out ?? null))`
    return new Promise((resolve) => {
      execFile(process.execPath, ["--input-type=module", "-e", code], { cwd, env: { ...process.env, FORGE_HOME: home, ...env }, timeout: 60000 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout)) } catch { resolve({ error: String(err?.message ?? stdout).slice(0, 200) }) }
      })
    })
  }

  /** v204: a git repo with one committed file, app.js, for a review to diff against. */
  function reviewRepo(dir) {
    const work = path.join(dir, "work"); fs.mkdirSync(work, { recursive: true })
    const g = (...a) => execFileSync("git", a, { cwd: work, stdio: "ignore" })
    g("init", "-q"); fs.writeFileSync(path.join(work, "app.js"), "export const greeting = \"hi\"\n")
    g("add", "."); g("-c", "user.email=bench@forge.local", "-c", "user.name=bench", "commit", "-qm", "init")
    return work
  }
  // a credential-shaped assignment the deterministic review observes (assembled
  // at run time, so no credential-shaped literal sits in forge's source)
  const REVIEW_SECRET_LINE = `const api_key = "${["zq8Xk2Lm9Pw4", "Rt7Yv1Nb6Hc3"].join("")}"`

  /** v203: an interrupted autonomous task AND its own journal entry (one run),
   *  both left by a dead process, in `home` for project `work`. */
  const INTERRUPTED_FIXTURE = (work, { task = "port the parser", runId = "run-bench-intr-0001", taskId = "task-bench-intr-0001" } = {}) => `
    const fs = await import("node:fs")
    const TS = await import(${JSON.stringify(path.join(HERE, "taskstate.js"))})
    const RL = await import(${JSON.stringify(path.join(HERE, "runlog.js"))})
    const t = TS.openTask(${JSON.stringify(taskId)}, { runId: ${JSON.stringify(runId)}, objective: ${JSON.stringify(task)}, cwd: ${JSON.stringify(work)} })
    t.transition(TS.TASK_STATUS.EXECUTING, { reason: "bench" }); t.flush()
    const tf = TS.taskFile(${JSON.stringify(taskId)}); const tr = JSON.parse(fs.readFileSync(tf, "utf8")); tr.pid = 4194303; fs.writeFileSync(tf, JSON.stringify(tr))
    const log = RL.openRun({ runId: ${JSON.stringify(runId)}, task: ${JSON.stringify(task)}, cwd: ${JSON.stringify(work)} }); log.step(3)
    await new Promise((r) => setTimeout(r, 250))
    const rf = RL.runFile(${JSON.stringify(runId)}); const rr = JSON.parse(fs.readFileSync(rf, "utf8")); rr.pid = 4194303; rr.step = 3; fs.writeFileSync(rf, JSON.stringify(rr))
  `

  /**
   * v206: a project whose `npm test` fails on a missing config.json. Run 1 runs
   * `npm test`, then `fix` (the wrong fix writes an unrelated file; the right
   * one writes config.json), then `npm test` again. Run 2, in the same project
   * and HOME, starts with `node wrong-fix.js`. Returns the failed-attempt
   * lessons on disk after run 1 and the tool-result text run 2's model got back.
   */
  // the default scenario is shared by two cases: run it once per bench run
  let failedAttemptDefault = null
  function failedAttemptScenario(opts = {}) {
    if (opts.fix && opts.fix !== "node wrong-fix.js") return failedAttemptRun(opts)
    return (failedAttemptDefault ??= failedAttemptRun(opts))
  }
  async function failedAttemptRun({ fix = "node wrong-fix.js" } = {}) {
    const out = { attempts: null, secondRunSaw: "", error: null }
    const http = await import("node:http")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-failed-attempt-"))
    let srv = null
    try {
      const home = path.join(dir, "home"), work = path.join(dir, "work")
      fs.mkdirSync(home); fs.mkdirSync(work)
      fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node check.js" } }))
      fs.writeFileSync(path.join(work, "check.js"), `const fs = require("fs")\nif (!fs.existsSync("config.json")) { console.error("config.json is missing"); process.exit(1) }\n`)
      fs.writeFileSync(path.join(work, "wrong-fix.js"), `require("fs").writeFileSync("other.json", "{}")\n`)
      fs.writeFileSync(path.join(work, "setup.js"), `require("fs").writeFileSync("config.json", "{}")\n`)
      const scripts = { 1: ["npm test", fix, "npm test"], 2: ["node wrong-fix.js", "node wrong-fix.js"] }
      let run = 0
      srv = http.createServer((req, res) => {
        let body = ""
        req.on("data", (c) => { body += c })
        req.on("end", () => {
          let j = {}
          try { j = JSON.parse(body) } catch { /* answered as an empty turn */ }
          const blocks = (j.messages ?? []).flatMap((msg) => Array.isArray(msg.content) ? msg.content.filter((c) => c?.type === "tool_result") : [])
          if (run === 2 && blocks.length) out.secondRunSaw = blocks.map((blk) => typeof blk.content === "string" ? blk.content : JSON.stringify(blk.content)).join("\n")
          const cmd = scripts[run]?.[blocks.length]
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", usage: { input_tokens: 10, output_tokens: 2 },
            ...(cmd ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${blocks.length}`, name: "bash", input: { command: cmd } }] }
              : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }) }))
        })
      })
      await new Promise((r) => srv.listen(0, "127.0.0.1", r))
      const go = async (task) => {
        run += 1
        const child = spawn(process.execPath, [path.join(HERE, "forge.js"), "agent", "--headless", "--yolo",
          "--provider", "anthropic", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`,
          "--max-steps", "8", "--", task], {
          cwd: work, env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "stub-key", NO_COLOR: "1" }, stdio: "ignore",
        })
        return new Promise((r) => {
          const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; r("timeout") }, 30000)
          child.once("exit", (c) => { clearTimeout(t); r(c) })
        })
      }
      await go("make npm test pass")
      try {
        const pd = path.join(home, ".forge", "projects")
        const all = JSON.parse(fs.readFileSync(path.join(pd, fs.readdirSync(pd)[0], "lessons.json"), "utf8"))
        out.attempts = all.filter((x) => String(x.failed_action ?? "").trim()).map((x) => ({ action: x.failed_action, check: x.check ?? null, kind: x.kind ?? null, confidence: x.confidence }))
      } catch { out.attempts = [] }
      fs.rmSync(path.join(work, "config.json"), { force: true })
      await go("npm test fails — make it pass")
    } catch (e) {
      out.error = `failed-attempt scenario could not run: ${String(e?.message ?? e).slice(0, 140)}`
    } finally {
      if (srv) {
        try { srv.closeAllConnections?.() } catch {}
        await new Promise((r) => { try { srv.close(r) } catch { r() } })
      }
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    return out
  }

  // v207: scripted OpenAI-protocol turns for the token cases
  const toolTurn = (n, name, args) => ({ json: { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } })
  const doneTurn = (text = "done") => ({ json: { id: "c", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } })
  const reqTools = (body) => (body?.tools ?? []).map((t) => t?.function?.name).filter(Boolean)
  const DEFERRABLE = ["runtime", "browser", "plan_whatif", "memory", "process", "repl", "kg_query", "code_context", "semantic_search"]
  const fixProject = (work) => {
    fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: "node test.js" } }))
    fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n")
    fs.writeFileSync(path.join(work, "test.js"), "const { add } = require('./lib'); if (add(2, 2) !== 4) { console.error('FAIL add'); process.exit(1) } console.log('ok')\n")
  }
  const fixScript = [["read_file", { path: "lib.js" }], ["bash", { command: "npm test" }], ["edit_file", { path: "lib.js", old: "(a, b) => a - b", new: "(a, b) => a + b" }], ["bash", { command: "npm test" }]]
  const fixRespond = (n) => (fixScript[n - 1] ? toolTurn(n, ...fixScript[n - 1]) : doneTurn("Fixed: add now adds; npm test passes."))

  // v208: a repo whose lib.js has a(), b() and class C { m() } — then only b's body changes
  const LIB_BEFORE = "function a() {\n  return 1\n}\n\nexport function b(x) {\n  const y = x + 1\n  return y\n}\n\nclass C {\n  m() {\n    return 3\n  }\n}\n"
  const LIB_AFTER = LIB_BEFORE.replace("const y = x + 1", "const y = x + 2")
  const structureRepo = (dir) => {
    const work = path.join(dir, "work"); fs.mkdirSync(work, { recursive: true })
    const g = (...a) => execFileSync("git", a, { cwd: work, stdio: "ignore" })
    g("init", "-q"); fs.writeFileSync(path.join(work, "lib.js"), LIB_BEFORE)
    g("add", "."); g("-c", "user.email=bench@forge.local", "-c", "user.name=bench", "commit", "-qm", "init")
    fs.writeFileSync(path.join(work, "lib.js"), LIB_AFTER)
    return work
  }
  const reviewFactsBody = `
    const CR = await import(${JSON.stringify(path.join(HERE, "codereview.js"))})
    const facts = CR.gatherReviewFacts({ cwd: process.cwd(), files: ["lib.js"] })
    const f = facts.files[0] ?? {}
    const prompt = CR.reviewerPrompt({ objective: "tweak b", facts, findings: [] })
    const L = await import(${JSON.stringify(path.join(HERE, "langadapter.js"))})
    const nested = typeof L.changedSymbols === "function" ? L.changedSymbols("lib.js", ${JSON.stringify(LIB_AFTER)}, [12], { cwd: process.cwd() }).symbols : null
    return { symbols: f.changedSymbols ?? null, source: f.symbolSource ?? null, prompt: /changes in: b/.test(prompt), nested }`

  return [
  {
    id: "yolo-means-no-asking",
    name: "under YOLO a failing tool never hands the decision back to the user",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "yoloState resolves YOLO from FORGE_YOLO / tools.yolo too, but the tool layer's 'ask the user' escalation (and chat's y/N confirm) read only the raw tools.autoApprove switch — so with YOLO on and autoApprove off, `forge yolo` said full control while a permission failure still asked the user",
    async check() {
      const { createToolIntel } = await import("./toolintel.js")
      const intel = createToolIntel({ exec: async () => "ERROR: EACCES: permission denied, open '/etc/shadow'", config: { tools: { yolo: true, autoApprove: false } }, ctx: { cwd: HERE, root: HERE } })
      const r = await intel.runCall({ id: "c1", name: "read_file", args: { path: "/etc/shadow" } })
      const asked = /\[forge\] ask the user/.test(String(r?.result ?? ""))
      return ok(!asked, asked ? "YOLO on (tools.yolo), autoApprove off: the failing tool's result told the model to ask the user" : "YOLO on (tools.yolo), autoApprove off: the failure is handed back to the run, not to the user")
    },
  },
  {
    id: "unverified-write-is-not-completed",
    name: "a run that changes a file and never checks it does not report COMPLETED",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "the run's own verdict said COMPLETED_UNVERIFIED for writes no passing check covers (and `forge yolo` promises exactly that), but the final status came from the fast gate, which passes unverified writes — so the result file, the card and a harness all read COMPLETED for work nobody proved",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unverified-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"), rj = path.join(dir, "r.json")
      fs.mkdirSync(home); fs.mkdirSync(work)
      try {
        const writeCall = { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "feature.js", content: "export const feature = 1\n" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        const r = await scriptedHeadlessRun({ home, work, task: "add feature.js", maxSteps: 4, extraArgs: ["--result-json", rj], respond: (n) => (n === 1 ? { json: writeCall } : { json: { id: "c", choices: [{ message: { role: "assistant", content: "Added feature.js." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }) })
        let status = null
        try { status = JSON.parse(fs.readFileSync(rj, "utf8")).status } catch { /* none */ }
        if (!fs.existsSync(path.join(work, "feature.js"))) return ok(false, `the run wrote nothing (exit ${r.exit}) — the scenario exercised nothing`)
        // …and it is still a FINISHED run: no /retry offered, its answer kept
        const { isFinished } = await import("./completion.js")
        const good = status === "COMPLETED_UNVERIFIED" && isFinished(status)
        return ok(good, good ? "wrote feature.js, ran no check: COMPLETED_UNVERIFIED (finished, not proven)" : `wrote feature.js, ran no check, and the result file says ${status}${status === "COMPLETED_UNVERIFIED" ? " — but it is not treated as finished" : ""}`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "recovery-offered-once",
    name: "an interrupted run is offered for recovery once, not once per record",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "an interrupted autonomous task and its own journal entry describe the same run; chat offered the task, and when the person chose to leave it as-is, offered the journal entry for the same run straight after",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rec-once-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"); fs.mkdirSync(home); fs.mkdirSync(work)
      try {
        const r = await inForgeHome(home, INTERRUPTED_FIXTURE(work) + `
          const REC = await import(${JSON.stringify(path.join(HERE, "recovery.js"))})
          if (typeof REC.recoveryCandidates !== "function") return { missing: true, tasks: TS.interruptedTasks({ cwd: ${JSON.stringify(work)} }).length, runs: RL.interruptedRuns({ cwd: ${JSON.stringify(work)} }).length }
          const c = REC.recoveryCandidates({ cwd: ${JSON.stringify(work)} })
          return { tasks: c.tasks.length, runs: c.runs.length }`)
        if (r?.error) return ok(false, r.error)
        if (r.missing) return ok(false, `no recovery authority decides what to offer — chat offered the ${r.tasks} interrupted task(s) and then all ${r.runs} journal run(s), the task's own run included`)
        return ok(r.tasks === 1 && r.runs === 0, r.tasks === 1 && r.runs === 0 ? "the interrupted task is offered; its own journal entry is not offered again" : `offered ${r.tasks} task(s) and ${r.runs} journal run(s) for one interrupted run`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "recovery-claimed-once",
    name: "an interrupted run can be resumed by one process only",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "recovery was read-then-act, and a resumed task kept the dead pid of the process that crashed — so while one process resumed it, it still read as interrupted, and a second chat or a supervised restart could resume the same run at the same time",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rec-claim-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"); fs.mkdirSync(home); fs.mkdirSync(work)
      try {
        const r = await inForgeHome(home, INTERRUPTED_FIXTURE(work) + `
          if (typeof TS.claimRecovery !== "function" || typeof RL.claimRun !== "function") return { missing: true }
          const first = TS.claimRecovery("task-bench-intr-0001", { pid: ${process.pid} })
          const stillListed = TS.interruptedTasks({ cwd: ${JSON.stringify(work)} }).length
          const second = TS.claimRecovery("task-bench-intr-0001")
          const run1 = RL.claimRun("run-bench-intr-0001"), run2 = RL.claimRun("run-bench-intr-0001")
          return { first: first.ok, epoch: first.epoch, stillListed, second: second.ok, secondWhy: second.reason, run1: run1.ok, run2: run2.ok }`)
        if (r?.error) return ok(false, r.error)
        if (r.missing) return ok(false, "there is no claim: any process that reads a run as interrupted may resume it, and a resumed task keeps the dead pid that made it look interrupted")
        const good = r.first && r.epoch === 1 && r.stillListed === 0 && !r.second && r.run1 && !r.run2
        return ok(good, good ? "the first claim wins (epoch 1), the task stops reading as interrupted, and a second claim is refused — for tasks and journal runs alike" : JSON.stringify(r))
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "supervised-restart-continues",
    name: "a supervised restart continues the run it lost instead of starting over",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "supervisor.js restarts the child with the same argv and sets FORGE_SUPERVISED / FORGE_RESTART_COUNT, and nothing read them: the restarted run did the task again from step one beside the interrupted one, which the next chat start then offered to resume too",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sup-restart-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"); fs.mkdirSync(path.join(home, ".forge"), { recursive: true }); fs.mkdirSync(work)
      const TASK = "port the parser to the new API"
      const http = await import("node:http")
      const seen = []
      const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c }); req.on("end", () => { try { seen.push(JSON.parse(b)) } catch { /* as-is */ } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "Continued." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) }) })
      try {
        const fx = await inForgeHome(path.join(home, ".forge"), INTERRUPTED_FIXTURE(work, { task: TASK }) + "return { ok: true }")
        if (fx?.error) return ok(false, fx.error)
        await new Promise((r) => srv.listen(0, "127.0.0.1", r))
        const child = spawn(process.execPath, [path.join(HERE, "forge.js"), "agent", "--headless", "--yolo", "--provider", "seekai", "--model", "stub", "--base-url", `http://127.0.0.1:${srv.address().port}`, "--max-steps", "2", "--", TASK], {
          cwd: work, env: { PATH: process.env.PATH, HOME: home, SEEKAI_API_KEY: "k", NO_COLOR: "1", FORGE_SUPERVISED: "1", FORGE_RESTART_COUNT: "1" }, stdio: ["ignore", "pipe", "pipe"],
        })
        let out = ""
        child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
        await new Promise((r) => { const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; r() }, 30000); child.once("exit", () => { clearTimeout(t); r() }) })
        const prompt = JSON.stringify(seen[0]?.messages ?? [])
        const old = await inForgeHome(path.join(home, ".forge"), `const RL = await import(${JSON.stringify(path.join(HERE, "runlog.js"))}); const r = RL.readRun("run-bench-intr-0001"); return { status: r?.status, note: r?.note }`)
        const continued = /supervised restart 1/.test(prompt) && /Resume this interrupted task/.test(prompt) && /step 3/.test(prompt)
        const closed = old?.status === "cancelled" && /supervised restart 1/.test(String(old?.note ?? ""))
        return ok(continued && closed, continued && closed ? "restart 1 continued the interrupted run (step 3, its files) and closed it, so nothing offers it again" : `the restarted run was ${continued ? "" : "not "}told what it was continuing; the interrupted run is ${old?.status ?? "?"}${old?.note ? ` (${old.note})` : ""}`)
      } finally {
        try { srv.closeAllConnections?.(); srv.close() } catch { /* closed */ }
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
      }
    },
  },
  {
    id: "inferred-finding-never-blocks",
    name: "only what a review observed can block; a reviewer model's unchecked claim is reported, not enforced",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "the code review counted every finding marked blocker as a blocker — a secret found in the diff, and equally a reviewer model's claim at a line the diff never added; nothing said which was seen and which was asserted",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rev-basis-"))
      try {
        const work = reviewRepo(dir); fs.mkdirSync(path.join(dir, "home"))
        const r = await inForgeHome(path.join(dir, "home"), `
          const fs = await import("node:fs")
          const CR = await import(${JSON.stringify(path.join(HERE, "codereview.js"))})
          const RV = await import(${JSON.stringify(path.join(HERE, "review.js"))})
          fs.writeFileSync("app.js", 'export const greeting = "hello"\\n' + ${JSON.stringify(REVIEW_SECRET_LINE)} + "\\n")
          const agent = async () => ({ text: '{"findings":[{"severity":"blocker","file":"app.js","line":40,"id":"made_up_race","issue":"a race on the greeting","fix_hint":"lock it"}]}' })
          const r = await CR.runCodeReview({ agent, config: {}, provider: {}, objective: "change the greeting", files: ["app.js"] })
          const out = { blockers: r.blockers.map((b) => b.id), inferred: r.findings.filter((f) => f.basis === "INFERRED").map((f) => f.id) }
          if (typeof RV.reviewDecision === "function" && r.canonical) {
            out.decided = RV.reviewDecision(r.canonical).blocking.map((f) => f.id)
            fs.writeFileSync("app.js", 'export const greeting = "hello"\\n')
            const after = RV.reviewDecision(r.canonical)
            out.afterFix = { ok: after.ok, stale: after.counts.stale }
          }
          return out`, { cwd: work })
        if (r?.error) return ok(false, r.error)
        const seen = r.blockers.includes("secret_in_code")
        const claim = r.blockers.includes("made_up_race")
        const good = seen && !claim && r.inferred.includes("made_up_race") && JSON.stringify(r.decided) === JSON.stringify(["secret_in_code"]) && r.afterFix?.ok === true && r.afterFix.stale >= 1
        return ok(good, good
          ? "the secret in the diff blocks; the model's claim at a line the diff never added is reported as INFERRED; once app.js is rewritten the old finding is stale and blocks nothing"
          : claim ? "a reviewer model's claim at a line the diff never added blocks exactly like the secret found in the diff" : JSON.stringify(r))
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "code-review-blocker-reaches-gate",
    name: "a code-review blocker reaches the completion gate",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "the autonomous controller turned code-review blockers into required actions, then cleared every recurring required action at the top of each completion attempt and re-derived all of them but these — so the gate never saw a code-review blocker, not even a secret found in the diff",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rev-gate-"))
      try {
        const work = reviewRepo(dir); fs.mkdirSync(path.join(dir, "home"))
        const r = await inForgeHome(path.join(dir, "home"), `
          const fs = await import("node:fs"); const path = await import("node:path")
          const meta = await import(${JSON.stringify(path.join(HERE, "meta.js"))})
          const events = []
          const runAgent = async (o) => {
            const t = String(o.task ?? "")
            if (o.planOnly) return { text: "1. fix the session token handling in app.js", toolRecords: [], commandChecks: [], toolLog: [] }
            if (/CODE REVIEWER/.test(t)) return { text: '{"findings":[]}', toolRecords: [], commandChecks: [], toolLog: [] }
            if (o.verifier) return { text: "verified", toolRecords: [], commandChecks: [{ command: "node --check app.js", exitCode: 0, passed: true, tail: "" }], toolLog: [] }
            const p = path.resolve("app.js")
            fs.writeFileSync(p, 'export const greeting = "hello"\\n' + ${JSON.stringify(REVIEW_SECRET_LINE)} + "\\n")
            return { text: "fixed", budgetHit: false, steps: 2, toolRecords: [{ tool: "edit_file", files_changed: [p] }], commandChecks: [{ command: "node --check app.js", exitCode: 0, passed: true, tail: "" }], toolLog: [{ step: 1, name: "edit_file", result: "edited app.js" }] }
          }
          const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false, maxSegments: 2 }, tools: {}, review: { code: true, maxPerTask: 2 } }
          const r = await meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "fix the session token handling bug in the auth module app.js", runAgent, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
          return {
            status: r.status,
            reviewed: events.filter((e) => e.type === "CODE_REVIEW_COMPLETED").reduce((n, e) => n + (e.blockers || 0), 0),
            gate: (r.completionGate?.blockers ?? []).map((b) => String(b.reason)),
          }`, { cwd: work })
        if (r?.error) return ok(false, r.error)
        if (!r.reviewed) return ok(false, "the code review found no blocker — the scenario exercised nothing")
        const atGate = r.gate.some((g) => /pending required action.*codereview: app\.js/.test(g))
        return ok(atGate && r.status !== "COMPLETED", atGate ? `the review's blocker (a secret added to app.js) is a pending action at the gate; the task is ${r.status}, not COMPLETED` : `the review reported ${r.reviewed} blocker(s); the gate saw none of them (gate: ${r.gate.join(" | ") || "clean"}; task ${r.status})`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "review-in-result-file",
    name: "the result file carries the run's review, each finding with its basis",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "a run that rewrote many files was reviewed, and the review's findings went to the terminal and nowhere a harness reads — --result-json had no review at all",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rev-result-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"), rj = path.join(dir, "r.json")
      fs.mkdirSync(home); fs.mkdirSync(work)
      try {
        const calls = [1, 2, 3, 4, 5].map((i) => ({ id: `w${i}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `part${i}.js`, content: `export const part${i} = ${i}\n` }) } }))
        const writeAll = { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: calls }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        const r = await scriptedHeadlessRun({ home, work, task: "split the module into parts", maxSteps: 4, extraArgs: ["--result-json", rj], respond: (n) => (n === 1 ? { json: writeAll } : { json: { id: "c", choices: [{ message: { role: "assistant", content: "Split into five parts." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }) })
        let j = null
        try { j = JSON.parse(fs.readFileSync(rj, "utf8")) } catch { /* none */ }
        if (!fs.existsSync(path.join(work, "part5.js"))) return ok(false, `the run wrote nothing (exit ${r.exit}) — the scenario exercised nothing`)
        const rv = j?.review
        const good = rv && rv.required === true && rv.counts?.observed >= 1 && rv.findings.every((f) => ["OBSERVED", "INFERRED", "RECOMMENDED"].includes(f.basis))
        return ok(Boolean(good), good ? `five files changed: the result file has the review (${rv.counts.observed} observed finding(s), ${rv.blocking.length} blocking, enforced=${rv.enforced})` : `five files changed and the run was reviewed, but the result file's review is ${JSON.stringify(rv ?? null).slice(0, 160)}`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "docker-run-of-a-test-is-a-check",
    name: "a docker build, or a check run inside a container, counts as a check",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "`docker` is none of the runners forge recognised, so `docker build -t app .` and `docker run app npm test` were never checks — a run that proved its image builds and its tests pass inside it recorded no evidence of either",
    async check() {
      const { looksLikeCheck } = await import("./checkcmd.js")
      const want = { "docker build -t app .": true, "docker run --rm -w /w node:22 npm test": true, "docker compose -f ci.yml build": true, "docker run app sleep 5": false, "docker ps": false, "docker compose up -d": false }
      const wrong = Object.entries(want).filter(([c, w]) => looksLikeCheck(c) !== w).map(([c, w]) => `${c} → ${w ? "not a check" : "a check"}`)
      return ok(wrong.length === 0, wrong.length ? `misjudged: ${wrong.join("; ")}` : "docker builds and in-container checks are checks; a plain container run, `docker ps` and `compose up` are not")
    },
  },
  {
    id: "docker-evidence-has-digest",
    name: "a docker build is recorded with the image it produced — id and digest read back from docker",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "a build that exits 0 is a claim and the artifact is the evidence (v98's artifact rule), but a docker image was never observed: the result file had no check at all for `docker build -t …`, let alone the image's id or digest",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-docker-ev-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"), bin = path.join(dir, "bin"), rj = path.join(dir, "r.json")
      for (const d of [home, work, bin]) fs.mkdirSync(d)
      // a stand-in docker: `build` succeeds, `image inspect` answers with an id and a registry digest
      fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\ncase "$1" in\n  build) echo "naming to docker.io/library/forge-bench:1 done"; exit 0;;\n  image) echo "sha256:${"ab".repeat(32)}|forge-bench@sha256:${"cd".repeat(32)}"; exit 0;;\n  *) exit 0;;\nesac\n`, { mode: 0o755 })
      fs.writeFileSync(path.join(work, "Dockerfile"), "FROM scratch\n")
      try {
        const buildCall = { id: "c", choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "b1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "docker build -t forge-bench:1 ." }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        const r = await scriptedHeadlessRun({ home, work, task: "build the image", maxSteps: 4, extraArgs: ["--result-json", rj], env: { PATH: `${bin}:${process.env.PATH}` }, respond: (n) => (n === 1 ? { json: buildCall } : { json: { id: "c", choices: [{ message: { role: "assistant", content: "Built forge-bench:1." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }) })
        let j = null
        try { j = JSON.parse(fs.readFileSync(rj, "utf8")) } catch { /* none */ }
        const last = j?.checks?.lastCheck
        const img = last?.artifact
        const good = last && /docker build/.test(last.command) && last.passed === true && img?.kind === "docker-image" && img.observed === true && img.ref === "forge-bench:1" && /^sha256:(ab){32}$/.test(img.id) && img.digests?.[0] === `forge-bench@sha256:${"cd".repeat(32)}`
        return ok(Boolean(good), good ? `the check is recorded with image forge-bench:1 → ${img.id.slice(0, 19)}…, digest ${img.digests[0].slice(0, 30)}…` : `after \`docker build -t forge-bench:1 .\` (exit ${r.exit}) the result file's checks are ${JSON.stringify(j?.checks ?? null).slice(0, 180)}`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "result-names-the-model-that-ran",
    name: "after a failover the result file names the model that finished the run",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.HARNESS,
    why: "a mid-run failover switched provider and model, but the run's result carried neither — so --result-json (and every harness score read from it) credited the model the run STARTED on, which had failed",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-route-"))
      const home = path.join(dir, "home"), work = path.join(dir, "work"), rj = path.join(dir, "r.json")
      fs.mkdirSync(path.join(home, ".forge"), { recursive: true }); fs.mkdirSync(work)
      const http = await import("node:http")
      const failing = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid api key" } })) }) })
      const answering = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "Done on the backup." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) }) })
      try {
        await new Promise((r) => failing.listen(0, "127.0.0.1", r)); await new Promise((r) => answering.listen(0, "127.0.0.1", r))
        fs.writeFileSync(path.join(home, ".forge", "config.json"), JSON.stringify({
          failover: true,
          retry: { attempts: 1, backoffMs: 50, connectMs: 3000 },
          providers: {
            primary: { protocol: "openai", baseUrl: `http://127.0.0.1:${failing.address().port}`, apiKey: "k1", model: "model-a" },
            backup: { protocol: "openai", baseUrl: `http://127.0.0.1:${answering.address().port}`, apiKey: "k2", model: "model-b" },
          },
        }))
        const child = spawn(process.execPath, [path.join(HERE, "forge.js"), "agent", "--headless", "--yolo", "--provider", "primary", "--model", "model-a", "--max-steps", "3", "--result-json", rj, "--", "say hello"], {
          cwd: work, env: { PATH: process.env.PATH, HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
        })
        let out = ""
        child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
        await new Promise((r) => { const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; r() }, 45000); child.once("exit", () => { clearTimeout(t); r() }) })
        let j = null
        try { j = JSON.parse(fs.readFileSync(rj, "utf8")) } catch { /* none */ }
        if (!/backup/.test(out) && j?.status !== "COMPLETED") return ok(false, `the failover never happened — the scenario exercised nothing (status ${j?.status ?? "?"}): ${out.slice(-200)}`)
        const sw = j?.routing?.switches?.[0]
        const good = j?.provider === "backup" && j?.model === "model-b" && sw?.from === "primary/model-a" && sw?.to === "backup/model-b"
        return ok(good, good ? "primary/model-a failed (401), backup/model-b finished: the result names backup/model-b and records the switch" : `the run failed over to backup/model-b, and the result file says ${j?.provider}/${j?.model} (routing: ${JSON.stringify(j?.routing ?? null).slice(0, 120)})`)
      } finally {
        for (const s of [failing, answering]) { try { s.closeAllConnections?.(); s.close() } catch { /* closed */ } }
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
      }
    },
  },
  {
    id: "failed-attempt-remembered",
    name: "a command that was tried and left the check failing the same way is remembered as exactly that",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "forge recorded the exact commands that turned a check green, but for what did NOT work only labels ('repeat same approach', 'tools used: bash, edit_file') — so the memory of failed approaches could never name the thing a later run was about to repeat",
    async check() {
      const r = await failedAttemptScenario()
      if (r.error) return ok(false, r.error)
      const hit = (r.attempts ?? []).find((att) => att.action === "node wrong-fix.js")
      const good = hit && hit.check === "npm test" && hit.kind === "failed_attempt" && hit.confidence < 0.5
      return ok(Boolean(good), good ? `\`node wrong-fix.js\` is remembered as tried and not fixing \`npm test\` (confidence ${hit.confidence}, below what may constrain a plan)` : `after npm test → node wrong-fix.js → npm test (same failure), the failed approaches on disk are ${JSON.stringify(r.attempts)}`)
    },
  },
  {
    id: "failed-attempt-flagged-on-repeat",
    name: "repeating a command an earlier run proved did not fix the check is flagged on its result",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "nothing recognised a run repeating something that had already failed: the prompt could say 'avoid: repeat same approach', and the model ran the same useless command again with nothing said about it",
    async check() {
      const r = await failedAttemptScenario()
      if (r.error) return ok(false, r.error)
      if (!r.secondRunSaw) return ok(false, "run 2 never sent back a tool result — the scenario exercised nothing")
      const notes = r.secondRunSaw.match(/\(governor\) an earlier run ran this exact command and `npm test` still failed the same way/g) ?? []
      const flagged = notes.length === 1
      if (notes.length > 1) return ok(false, `run 2 ran \`node wrong-fix.js\` twice and was told ${notes.length} times — once per run is the rule`)
      return ok(flagged, flagged ? "run 2's `node wrong-fix.js` came back with a note: an earlier run ran it and `npm test` still failed the same way" : `run 2 repeated \`node wrong-fix.js\` and its result said nothing about it: ${r.secondRunSaw.slice(0, 160)}`)
    },
  },
  {
    id: "failed-attempt-needs-the-same-failure",
    name: "only a check failing the SAME way again makes a command a failed attempt; the lookup knows a command however it is typed",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "a command followed by a different error changed something — that is not 'no effect'; a check is never an attempt; and a lesson must recognise `node ./wrong-fix.js` as the `node wrong-fix.js` it recorded, and grow more certain each time the same attempt fails again",
    async check() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-attempt-rules-"))
      try {
        fs.mkdirSync(path.join(dir, "home")); fs.mkdirSync(path.join(dir, "work"))
        const r = await inForgeHome(path.join(dir, "home"), `
          const L = await import(${JSON.stringify(path.join(HERE, "lessons.js"))})
          if (typeof L.failedAttempts !== "function") return { missing: true }
          const chk = (tail, commandIndex) => ({ command: "npm test", passed: false, exitCode: 1, tail, commandIndex, step: commandIndex })
          const cmds = ["node wrong-fix.js", "npm test", "rm -f cache.db"]
          const same = L.failedAttempts({ commandChecks: [chk("Error: config.json is missing", 0), chk("Error: config.json is missing", 3)], commands: cmds })
          const other = L.failedAttempts({ commandChecks: [chk("Error: config.json is missing", 0), chk("TypeError: parse is not a function", 3)], commands: cmds })
          // a pass printing the very same text is still a pass: never "failed the same way"
          const passed = L.failedAttempts({ commandChecks: [chk("Error: config.json is missing", 0), { ...chk("Error: config.json is missing", 3), passed: true, exitCode: 0 }], commands: cmds })
          const rec = { kind: L.LESSON_KIND.FAILED_ATTEMPT, failure: "x did not fix npm test", cause: "missing", failedAction: "node wrong-fix.js", failedStrategy: "ran x", check: "npm test", confidence: 0.4 }
          L.recordLesson(rec); const again = L.recordLesson(rec)
          return {
            same: same[0]?.attempts ?? [], other: other.length, passed: passed.length,
            respelled: L.triedAndFailed("node ./wrong-fix.js").length,
            unrelated: L.triedAndFailed("node setup.js").length,
            again: again.confidence,
          }`, { cwd: path.join(dir, "work") })
        if (r?.error) return ok(false, r.error)
        if (r.missing) return ok(false, "there is no record of what was tried and did not work — only labels")
        const good = JSON.stringify(r.same) === JSON.stringify(["node wrong-fix.js", "rm -f cache.db"]) && r.other === 0 && r.passed === 0 && r.respelled === 1 && r.unrelated === 0 && r.again === 0.5
        return ok(good, good ? "same failure after → both state-changing commands are attempts (the check between is not); a different failure → none; `node ./wrong-fix.js` is recognised; a second sighting raises 0.4 → 0.5" : JSON.stringify(r))
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
  {
    id: "failed-attempt-not-from-a-fix",
    name: "a command that did fix the check is never remembered as a failed attempt",
    lane: LANE.PROGRAMME, how: HOW.EXERCISED,
    discipline: DISCIPLINE.LOOP,
    why: "the mirror rule must not learn the wrong thing: a command followed by the check passing is a proven repair, never a failed attempt",
    async check() {
      const r = await failedAttemptScenario({ fix: "node setup.js" })
      if (r.error) return ok(false, r.error)
      const wrong = (r.attempts ?? []).filter((att) => att.kind === "failed_attempt")
      return ok(wrong.length === 0 && Array.isArray(r.attempts), wrong.length ? `a command that fixed npm test was recorded as a failed attempt: ${JSON.stringify(wrong)}` : "npm test → node setup.js → npm test (green): no failed attempt recorded")
    },
  },
    {
      id: "request-sends-core-tools-only",
      name: "a request carries the core tool schemas, not all of them — and the run still does its work",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "measured on a real run: the 34 tool schemas were ~5.6k tokens of EVERY request (56–74% of it) while a coding run calls a handful — runtime, browser, plan_whatif, memory, process… were paid for on every step whether used or not",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-core-tools-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work"), rj = path.join(dir, "r.json")
        fs.mkdirSync(home); fs.mkdirSync(work); fixProject(work)
        try {
          const r = await scriptedHeadlessRun({ home, work, task: "fix the failing test in lib.js", maxSteps: 8, extraArgs: ["--result-json", rj], respond: fixRespond })
          let status = null
          try { status = JSON.parse(fs.readFileSync(rj, "utf8")).status } catch { /* none */ }
          const first = reqTools(r.seen[0]?.body)
          const sent = DEFERRABLE.filter((n) => first.includes(n))
          const schemaTok = Math.round(JSON.stringify(r.seen[0]?.body?.tools ?? []).length / 4)
          const good = first.includes("load_tools") && sent.length === 0 && status === "COMPLETED" && /a \+ b/.test(fs.readFileSync(path.join(work, "lib.js"), "utf8"))
          return ok(good, good ? `the first request offers ${first.length} tools (~${schemaTok} tokens of schema), rare ones behind load_tools; the run still fixed lib.js and ended COMPLETED` : `first request: ${first.length} tools (~${schemaTok} tokens) — deferrable ones sent: ${sent.join(", ") || "none"}; load_tools ${first.includes("load_tools") ? "offered" : "absent"}; run status ${status}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "deferred-tool-loads-on-request",
      name: "load_tools adds a deferred tool's schema for the rest of the run, and the tool runs",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "a deferred tool must be one call away, not gone: load_tools has to put its schema on every later request, and calling it has to execute it exactly as before",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-load-tools-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work)
        try {
          const steps = [["load_tools", { names: ["kg_query"] }], ["kg_query", { query: "files" }]]
          const r = await scriptedHeadlessRun({ home, work, task: "look something up", maxSteps: 6, respond: (n) => (steps[n - 1] ? toolTurn(n, ...steps[n - 1]) : doneTurn()) })
          const before = reqTools(r.seen[0]?.body), after = reqTools(r.seen[1]?.body), later = reqTools(r.seen[2]?.body)
          const results = JSON.stringify(r.seen[2]?.body?.messages ?? [])
          const ran = results.includes("kg_query") && !/unknown tool \\"kg_query\\"/.test(results)
          // a task that NAMES a deferred tool gets it from the first request
          let named = false
          try {
            const { deferDefs } = await import("./tooldefer.js")
            const { TOOL_DEFS, BUILTIN_TOOL_NAMES } = await import("./tools.js")
            named = deferDefs(TOOL_DEFS, { builtins: BUILTIN_TOOL_NAMES, task: "check it with the browser" }).offered.some((d) => d.function.name === "browser")
          } catch { named = false }
          const good = !before.includes("kg_query") && before.includes("load_tools") && after.includes("kg_query") && later.includes("kg_query") && ran && named
          return ok(good, good ? "kg_query was not offered, load_tools put its schema on the next request and every one after, and the call ran; a task naming the browser gets it up front" : `offered before/after/later: ${before.includes("kg_query")}/${after.includes("kg_query")}/${later.includes("kg_query")}; load_tools ${before.includes("load_tools") ? "offered" : "absent"}; ran: ${ran}; named tool up front: ${named}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "old-tool-output-masked-early",
      name: "old tool outputs are masked well before the window fills — the error lines stay",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "old tool outputs were only shrunk once history reached 40% of the window (~51k tokens on 128k), so every earlier output was re-sent in full on every step; open-source agents mask old observations far earlier (Claude Code, OpenCode, arXiv 2508.21433)",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mask-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work)
        fs.writeFileSync(path.join(work, "big.js"), "const n = process.argv[2]; for (let i = 0; i < 120; i++) { console.log('row', n, i, 'x'.repeat(40)); if (n === '3' && i === 60) console.log('Error: FAIL-MARKER-3 widget broke') } if (n === '3') process.exit(1)\n")
        try {
          const r = await scriptedHeadlessRun({ home, work, task: "run the row generator", maxSteps: 14, respond: (n) => (n <= 10 ? toolTurn(n, "bash", { command: `node big.js ${n - 1}` }) : doneTurn()) })
          const last = r.seen[r.seen.length - 1]?.body?.messages ?? []
          const outs = last.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""))
          const masked = outs.filter((c) => /\[old tool output masked from \d+ chars\]/.test(c)).length
          const recentWhole = outs.slice(-3).every((c) => !/\[old tool output masked/.test(c) && c.length > 5000)
          const marker = outs.some((c) => c.includes("FAIL-MARKER-3"))
          const total = r.seen.reduce((sum, q) => sum + JSON.stringify(q.body ?? {}).length, 0)
          const good = outs.length >= 10 && masked >= 5 && recentWhole && marker
          return ok(good, good ? `${masked} old outputs masked before the window was anywhere near full; the last 3 whole; the failing run's error line kept (~${Math.round(total / 4)} input tokens over the run)` : `outputs ${outs.length}, masked ${masked}, last 3 whole ${recentWhole}, error line kept ${marker}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "token-saving-opt-out",
      name: "agent.deferTools:false and agent.maskAfterTokens:0 give back the full request",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "both savings change what the model sees, so each must be switchable off in config: every tool offered, no load_tools, old outputs untouched until the old 40% threshold",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-optout-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(path.join(home, ".forge"), { recursive: true }); fs.mkdirSync(work); fixProject(work)
        fs.writeFileSync(path.join(home, ".forge", "config.json"), JSON.stringify({ agent: { deferTools: false, maskAfterTokens: 0 } }))
        try {
          const r = await scriptedHeadlessRun({ home, work, task: "fix the failing test in lib.js", maxSteps: 8, respond: fixRespond })
          const first = reqTools(r.seen[0]?.body)
          const good = !first.includes("load_tools") && DEFERRABLE.every((n) => first.includes(n))
          return ok(good, good ? `opted out: all ${first.length} tools offered, no load_tools` : `opted out, yet the first request offered ${first.length} tools (load_tools ${first.includes("load_tools") ? "present" : "absent"}; missing: ${DEFERRABLE.filter((n) => !first.includes(n)).join(", ") || "none"})`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "review-knows-the-changed-function",
      name: "code review is told which function a change landed in",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "the reviewer saw a changed file and its diff, never which declarations the change touched — so 'the change is inside b()' had to be re-derived by the model from raw hunks",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-changed-fn-"))
        try {
          const work = structureRepo(dir); fs.mkdirSync(path.join(dir, "home"))
          const r = await inForgeHome(path.join(dir, "home"), reviewFactsBody, { cwd: work })
          if (r?.error) return ok(false, r.error)
          const good = JSON.stringify(r.symbols) === JSON.stringify(["b"]) && (r.source === "lexical" || r.source === "tree-sitter") && r.prompt && JSON.stringify(r.nested) === JSON.stringify(["C.m"])
          return ok(good, good ? `only b()'s body changed: the review facts say changes in [b] (${r.source}), and the reviewer's prompt says so; a line inside a method is named C.m` : `review facts for a change inside b(): ${JSON.stringify(r)}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "review-uses-tree-sitter-when-present",
      name: "with tree-sitter on PATH, changed functions come from its parse spans",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "tree-sitter was used only for symbol NAMES in extraction, and its parse spans (where each declaration starts and ends) were thrown away — the one layer that can map a changed line to its function exactly",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ts-spans-"))
        try {
          const work = structureRepo(dir); fs.mkdirSync(path.join(dir, "home"))
          const bin = path.join(dir, "bin"); fs.mkdirSync(bin)
          // a stand-in tree-sitter: the S-expression a real `tree-sitter parse lib.js` prints for this file
          const sexp = "(program [0, 0] - [15, 0] (function_declaration [0, 0] - [2, 1] name: (identifier [0, 9] - [0, 10])) (export_statement [4, 0] - [7, 1] declaration: (function_declaration [4, 7] - [7, 1] name: (identifier [4, 16] - [4, 17]))) (class_declaration [9, 0] - [13, 1] name: (identifier [9, 6] - [9, 7]) body: (class_body [9, 8] - [13, 1] (method_definition [10, 2] - [12, 3] name: (property_identifier [10, 2] - [10, 3])))))"
          fs.writeFileSync(path.join(bin, "tree-sitter"), `#!/bin/sh\necho '${sexp}'\n`, { mode: 0o755 })
          const r = await inForgeHome(path.join(dir, "home"), reviewFactsBody, { cwd: work, env: { PATH: `${bin}:${process.env.PATH}` } })
          if (r?.error) return ok(false, r.error)
          const good = JSON.stringify(r.symbols) === JSON.stringify(["b"]) && r.source === "tree-sitter"
          return ok(good, good ? "tree-sitter on PATH: the change is mapped to b() through its parse span (provenance tree-sitter)" : `with tree-sitter on PATH the review facts say ${JSON.stringify(r)}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "bench-width-follows-the-machine",
      name: "the bench runs as many cases at once as the machine can take",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "every programme case spawns forge children, and the test runner learned (v100) that a flat 4 at once is fatal on a phone — Android's lowmemorykiller kills the whole Termux session — but the bench kept running 4 at a time everywhere",
      async check() {
        const B = await import("./benchsuite.js")
        if (typeof B.programmeWidth !== "function") return ok(false, "the bench runs a flat 4 cases at once on every machine")
        const { testConcurrency, TEST_ANDROID_MAX_CONCURRENCY } = await import("./test-runner-policy.js")
        const w = (o) => B.programmeWidth({ testConcurrency, env: {}, ...o })
        const phone = w({ profile: { cores: 2, freeMB: 1200, totalMB: 3000, tier: "low" } })
        const android = w({ profile: { cores: 8, freeMB: 6000, totalMB: 12000, tier: "high" }, android: true })
        const desktop = w({ profile: { cores: 8, freeMB: 16000, totalMB: 32000, tier: "high" } })
        const serial = w({ profile: { cores: 8, freeMB: 16000, totalMB: 32000, tier: "high" }, env: { FORGE_BENCH_SERIAL: "1" } })
        const good = phone === 1 && android <= TEST_ANDROID_MAX_CONCURRENCY && desktop === 4 && serial === 1
        return ok(good, good ? `a low-tier phone runs 1 at a time, Android at most ${TEST_ANDROID_MAX_CONCURRENCY}, a desktop 4, FORGE_BENCH_SERIAL=1 one` : `widths — phone ${phone}, android ${android}, desktop ${desktop}, serial ${serial}`)
      },
    },
    {
      id: "system-prompt-carries-no-filler",
      name: "the system prompt carries no block that says nothing, and says each fact once",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.PROMPT,
      why: "measured on a real run, ~7.2k chars of system prompt on every request carried a version banner, a self-model with no data, an all-'none' horizon line, a generic three-step plan and a routing line the tool policy already states — and repeated the skills, playbooks and blast radius in a second, shorter form",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-no-filler-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work); fixProject(work)
        try {
          const r = await scriptedHeadlessRun({ home, work, task: "fix the failing test in lib.js", maxSteps: 3, respond: () => doneTurn() })
          const sys = String((r.seen[0]?.body?.messages ?? []).find((m) => m.role === "system")?.content ?? "")
          if (!sys) return ok(false, "no system prompt captured — the scenario exercised nothing")
          const has = (re) => re.test(sys)
          const filler = [
            has(/^ALPHA INTELLIGENCE v[\d.]+: evidence is advisory/m) && "version banner",
            has(/^SELF-MODEL \(measured, not claimed\):\n- insufficient evidence/m) && "empty self-model",
            has(/^HORIZON: .*risk=normal verify=none impact=none replan=none/m) && "all-none horizon",
            has(/^CAPABILITY ROUTER: /m) && has(/^TOOL POLICY \(capability-first/m) && "routing line said twice",
            has(/^- implement: Implement the requested change while preserving existing contracts/m) && "generic adaptive plan",
            has(/^\[skills\] /m) && has(/^SKILLS FOR THIS TASK/m) && "skills twice",
            has(/^\[playbooks\] /m) && has(/^PLAYBOOKS: /m) && "playbooks twice",
            has(/^\[blast\] /m) && has(/^BLAST: /m) && "blast twice",
          ].filter(Boolean)
          // a horizon that DOES say something stays
          let keepsReal = false
          try {
            const { pruneFiller } = await import("./promptbudget.js")
            keepsReal = typeof pruneFiller === "function" && /ESCALATE-VERIFICATION/.test(pruneFiller("RULES:\n1. x\n\nHORIZON: action=CONTINUE frontier=a risk=ESCALATE-VERIFICATION verify=focused_test impact=lib.js replan=none recovery=none:none wave=1. Advisory only; authority and completion gates remain authoritative."))
          } catch { keepsReal = false }
          const essentials = has(/^RULES:/m) && has(/^TOOL POLICY/m)
          const good = !filler.length && keepsReal && essentials
          return ok(good, good ? `system prompt ${sys.length} chars: no filler block, each fact once, rules and tool policy intact; a horizon with a real value is kept` : `system prompt ${sys.length} chars — filler: ${filler.join(", ") || "none"}; real horizon kept: ${keepsReal}; essentials: ${essentials}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "lsp-tools-deferred-without-a-server",
      name: "language-server tools are offered only when a server serves this project's files",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "the four lsp_* tools were offered on every request whenever ANY language server was on PATH — pyright in a JavaScript project included — ~300 tokens a request for tools that could not serve a single file",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lsp-defer-"))
        const bin = path.join(dir, "bin"); fs.mkdirSync(bin)
        // a stand-in python language server: only its presence on PATH matters here
        fs.writeFileSync(path.join(bin, "pylsp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
        const env = { PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":") }
        const run = async (name, files) => {
          const home = path.join(dir, `${name}-home`), work = path.join(dir, `${name}-work`)
          fs.mkdirSync(home); fs.mkdirSync(work)
          for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(work, f), c)
          const r = await scriptedHeadlessRun({ home, work, task: "look around", maxSteps: 2, env, respond: () => doneTurn() })
          const tools = r.seen[0]?.body?.tools ?? []
          return { lsp: reqTools(r.seen[0]?.body).filter((n) => n.startsWith("lsp_")), loadable: String(tools.find((t) => t.function?.name === "load_tools")?.function?.description ?? "").includes("lsp_definition") }
        }
        try {
          const js = await run("js", { "lib.js": "exports.add = (a, b) => a + b\n", "package.json": "{\"name\":\"w\"}" })
          const py = await run("py", { "app.py": "def add(a, b):\n    return a + b\n" })
          const good = js.lsp.length === 0 && js.loadable && py.lsp.length === 4
          return ok(good, good ? "JS project + only a Python server: no lsp_* schema, named on load_tools; Python project: all four offered up front" : `JS project offered ${js.lsp.length} lsp tool(s) (loadable: ${js.loadable}); Python project offered ${py.lsp.length}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "edit-accepts-claude-code-names",
      name: "an edit with old_string/new_string edits the file; an empty old says so",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "edit_file takes old/new; a model trained on Claude Code sends old_string/new_string — `old` then read as empty, which is found everywhere, and the model was told its unique text 'appears multiple times' and spent turns on the wrong fix",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-edit-names-"))
        try {
          fs.writeFileSync(path.join(dir, "lib.js"), "exports.add = (a, b) => a - b\n")
          const { makeToolContext } = await import("./tools.js")
          const t = makeToolContext({ cwd: dir, root: dir })
          const edited = String(await t.exec("edit_file", { path: "lib.js", old_string: "a - b", new_string: "a + b" }))
          const multi = String(await t.exec("multi_edit", { path: "lib.js", edits: [{ old_string: "a + b", new_string: "a * b" }] }))
          const empty = String(await t.exec("edit_file", { path: "lib.js" }))
          const body = fs.readFileSync(path.join(dir, "lib.js"), "utf8")
          const good = /^OK/.test(edited) && /^OK/.test(multi) && body.includes("a * b") && /old is empty/.test(empty) && !/multiple times/.test(empty)
          return ok(good, good ? "old_string/new_string edit (edit_file and multi_edit); an empty old gets 'old is empty', not 'appears multiple times'" : `edit: ${edited.slice(0, 80)} | multi: ${multi.slice(0, 80)} | empty: ${empty.slice(0, 80)}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "skills-listed-in-their-own-words",
      name: "a picked skill is listed by its description, not its scoring keywords",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.PROMPT,
      why: "tags and aliases are joined into the description for scoring, and that blob was what the model read — 'forge-test: Add or fix tests … test jest pytest cargo coverage testing unit-test' on every request",
      async check() {
        const { pickSkills } = await import("./skillforge.js")
        const { formatSkillPicks } = await import("./evaluate.js")
        const { TASK_CLASS } = await import("./classify.js")
        // "jest" is only in forge-test's TAGS: the pick proves scoring still uses them
        const picks = pickSkills("set up jest for the parser", [{ name: "forge-test", desc: "Add or fix tests for the files you just changed" }], { klass: TASK_CLASS.MEDIUM })
        const listed = formatSkillPicks(picks)
        const line = listed.split("\n").find((l) => l.startsWith("- forge-test")) ?? ""
        const good = line === "- forge-test: Add or fix tests for the files you just changed"
        return ok(good, good ? "picked on a tag (jest), listed in its own words" : `listed: ${JSON.stringify(line || listed.slice(0, 160))}`)
      },
    },
    {
      id: "task-said-once-in-the-prompt",
      name: "the task is not restated in the system prompt when the user message already says it",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.PROMPT,
      why: "the user model and the task contract each restated the whole task — the same words the user message carries — on every request; their frozen wording only adds something when it differs from what the run was asked (a meta segment)",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-task-once-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work); fixProject(work)
        const task = "fix the failing test in lib.js"
        try {
          const r = await scriptedHeadlessRun({ home, work, task, maxSteps: 3, respond: () => doneTurn() })
          const msgs = r.seen[0]?.body?.messages ?? []
          const sys = String(msgs.find((m) => m.role === "system")?.content ?? "")
          if (!sys) return ok(false, "no system prompt captured — the scenario exercised nothing")
          const times = sys.split(task).length - 1
          const userSays = msgs.some((m) => m.role === "user" && String(m.content).includes(task))
          const blocks = /^USER MODEL /m.test(sys) && /^TASK CONTRACT /m.test(sys)
          // a segment whose original objective differs keeps the frozen wording
          const { pruneFiller } = await import("./promptbudget.js")
          const contract = "TASK CONTRACT (original wording is frozen):\n- Intent v1 (original): build the whole billing module\n- closure: closable"
          const keptWhenDifferent = /Intent v1 \(original\): build the whole billing module/.test(pruneFiller(contract, { task: "write the invoice parser" }))
          const good = times === 0 && userSays && blocks && keptWhenDifferent
          return ok(good, good ? `task in the system prompt ${times}×, in the user message once; both blocks kept; a different original is kept` : `task in system prompt ${times}×; user message carries it: ${userSays}; blocks present: ${blocks}; different original kept: ${keptWhenDifferent}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "large-output-capped-near-10k",
      name: "a long-line command output reaches the model near 10 KB, error line kept",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "the history budget counted LINES: 60 lines of 600 chars were 'under 100 lines' and went to the model whole — 32 KB, ~8k tokens, re-sent on every later request while the last turns stay unmasked",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-big-out-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work)
        fs.writeFileSync(path.join(work, "gen.js"), "for (let i = 0; i < 60; i++) { if (i === 30) console.log('Error: config key missing at row 30'); console.log('row ' + i + ' ' + 'y'.repeat(600)) }\nconsole.log('SUMMARY: 1 failed'); process.exit(1)\n")
        try {
          const r = await scriptedHeadlessRun({ home, work, task: "run node gen.js and report", maxSteps: 3, respond: (n) => (n === 1 ? toolTurn(1, "bash", { command: "node gen.js" }) : doneTurn()) })
          const res = String((r.seen[1]?.body?.messages ?? []).find((m) => m.role === "tool")?.content ?? "")
          if (!res) return ok(false, "no tool result captured — the scenario exercised nothing")
          const kept = res.includes("config key missing at row 30") && res.includes("SUMMARY: 1 failed") && /\[exit code: 1\]/.test(res)
          const good = res.length <= 11000 && kept
          return ok(good, good ? `a 36 KB output reached the model as ${res.length} chars, with the mid-output error, the tail and the exit code` : `tool result ${res.length} chars; error/tail/exit kept: ${kept}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "one-file-fix-is-small",
      name: "a symptom word does not make a one-file fix a large task",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.HARNESS,
      why: "\"fix the failing test in lib.js\" was LARGE on the word \"failing\" alone: the autonomous path planned it with 6 workers, a DAG, a repo model and a required review, and the direct path preloaded delegate and spent the LARGE prompt budget",
      async check() {
        const { classifyTask } = await import("./classify.js")
        const small = ["fix the failing test in lib.js", "debug why checkout is broken in cart.js", "the build is broken, see src/app.py."]
        const large = ["fix the failing tests in lib.js and util.js", "the test suite is failing in lib.js", "fix the failing test", "refactor lib.js, it is broken"]
        const got = (t) => classifyTask(t).class
        const wrongSmall = small.filter((t) => got(t) !== "SMALL")
        const wrongLarge = large.filter((t) => got(t) === "SMALL" || got(t) === "MICRO")
        const frozen = classifyTask("fix the failing test in lib.js").legacy === "complex"
        const good = !wrongSmall.length && !wrongLarge.length && frozen
        return ok(good, good ? "one named file + symptom words → SMALL; two files, a test suite, no file or a refactor stay large; the frozen v20 level is unchanged" : `should be SMALL: ${wrongSmall.map((t) => `${t} (${got(t)})`).join("; ") || "ok"} | should stay large: ${wrongLarge.join("; ") || "ok"} | legacy frozen: ${frozen}`)
      },
    },
    {
      id: "green-check-is-not-failing",
      name: "a check that failed and then passed is not reported as failing",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.LOOP,
      why: "the completion verdict read every run of every check: the red `npm test` a fix then turned green stayed 'a check the run itself ran is failing', and a run that had just gone green was told to REPAIR",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-green-check-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work); fixProject(work)
        try {
          // the fix goes green, then the model keeps working without answering,
          // so the governor's completion verdict is what it reads
          const r = await scriptedHeadlessRun({ home, work, task: "make npm test pass by fixing add in lib.js", maxSteps: 9,
            respond: (n) => (fixScript[n - 1] ? toolTurn(n, ...fixScript[n - 1]) : toolTurn(n, "list_dir", { path: "." })) })
          const notes = r.seen.flatMap((q) => (q.body?.messages ?? []).filter((m) => m.role === "user").map((m) => String(m.content)))
          const verdict = notes.some((t) => /TASK NOT COMPLETE/.test(t))
          const stale = notes.some((t) => /a check the run itself ran is failing/.test(t))
          const { evaluateCompletion } = await import("./completion.js")
          const redAfter = evaluateCompletion({ wrote: true, mutating: true, modelAnswered: true, cwd: work,
            commandChecks: [{ command: "npm test", passed: true, exitCode: 0 }, { command: "npm test 2>&1 | tail -20", passed: false, exitCode: 1 }] })
          const stillRed = redAfter.blockers.some((b) => b.code === "FAILED_CHECK")
          const greenAfter = evaluateCompletion({ wrote: true, mutating: true, modelAnswered: true, cwd: work,
            commandChecks: [{ command: "npm test", passed: false, exitCode: 1 }, { command: "npm test 2>&1 | tail -20", passed: true, exitCode: 0 }] })
          const respelledGreen = !greenAfter.blockers.some((b) => b.code === "FAILED_CHECK")
          const good = verdict && !stale && stillRed && respelledGreen
          return ok(good, good ? "after red → green the governor's verdict names no failing check; the same check respelled counts as one (red → green clears, green → red blocks)" : `verdict seen: ${verdict}; stale 'failing' note: ${stale}; green→red still blocks: ${stillRed}; respelled red→green clears: ${respelledGreen}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "segment-runs-at-the-task-class",
      name: "an autonomous segment runs at the objective's size, not its boilerplate's",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.LOOP,
      why: "every executing segment re-classified its own task text — forge's continuation paragraph ('… focused + regression + build …') or repair paragraph — so a SMALL objective ran its segments as LARGE (bigger prompt, delegate preloaded, LARGE skill routing, the tool-creating gap step) and a resume ran as whatever that text scored",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-seg-class-"))
        const work = path.join(dir, "work"); fs.mkdirSync(work); fs.mkdirSync(path.join(dir, "home"))
        fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "w", scripts: { test: "node test.js" } }))
        fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n")
        fs.writeFileSync(path.join(work, "test.js"), "if (require('./lib').add(2, 2) !== 4) process.exit(1)\n")
        try {
          const r = await inForgeHome(path.join(dir, "home"), `
            const fs = await import("node:fs"); const path = await import("node:path")
            const meta = await import(${JSON.stringify(path.join(HERE, "meta.js"))})
            const A = await import(${JSON.stringify(path.join(HERE, "agent.js"))})
            const calls = []; let execs = 0
            const runAgent = async (o) => {
              const t = String(o.task ?? "")
              const kind = o.planOnly ? "plan" : o.verifier ? "verify" : /CODE REVIEWER/.test(t) ? "review" : /previous step FAILED/.test(t) ? "repair" : /^Continue the autonomous task/.test(t) ? "continue" : "exec"
              calls.push({ kind, klass: o.klass ?? null })
              if (kind === "plan") return { text: "1. fix add in lib.js", toolRecords: [], commandChecks: [], toolLog: [] }
              if (kind === "review") return { text: '{"findings":[]}', toolRecords: [], commandChecks: [], toolLog: [] }
              if (kind === "verify") return { text: "verified", toolRecords: [], commandChecks: [{ command: "npm test", exitCode: 0, passed: true, tail: "" }], toolLog: [] }
              const pass = kind === "repair" || ++execs > 1
              if (pass) fs.writeFileSync("lib.js", "exports.add = (a, b) => a + b\\n")
              return { text: pass ? "fixed" : "tried", budgetHit: false, steps: 2, toolRecords: [{ tool: "edit_file", files_changed: [path.resolve("lib.js")] }], commandChecks: [{ command: "npm test", exitCode: pass ? 0 : 1, passed: pass, tail: pass ? "" : "FAIL add" }], toolLog: [{ step: 1, name: "edit_file", result: "edited lib.js" }] }
            }
            const cfg = { providers: {}, agent: { autonomous: true, modelStrategy: false, maxSegments: 3 }, tools: {}, review: { code: false } }
            const go = (extra) => meta.runMeta({ config: cfg, provider: { name: "x", model: "m" }, task: "fix add in lib.js", runAgent, signal: new AbortController().signal, ...extra })
            const first = await go({})
            const fresh = calls.splice(0)
            await go({ resumeTaskId: first.taskId })
            const resumed = calls.splice(0)
            const cont = "Continue the autonomous task (segment 2). Work toward the objective; do not restart from scratch.\\n\\nObjective: fix add in lib.js\\n\\nAfter your edits, VERIFY with the appropriate command (focused test for a single-function change; focused + regression + build for a core change)."
            const budgeted = A.agentSystemPromptParts({ cwd: process.cwd(), task: cont, klass: "SMALL" }).klass
            return { fresh, resumed, budgeted }`, { cwd: work })
        if (r?.error) return ok(false, r.error)
        const working = (cs) => cs.filter((c) => c.kind === "exec" || c.kind === "continue" || c.kind === "repair")
        const kinds = new Set(working(r.fresh).map((c) => c.kind))
        if (!kinds.has("continue") || !kinds.has("repair")) return ok(false, `the scenario reached ${[...kinds].join(", ") || "nothing"} — it needs a continuation segment and a repair`)
        const wrong = [...working(r.fresh), ...working(r.resumed)].filter((c) => c.klass !== "SMALL")
        const good = !wrong.length && working(r.resumed).length > 0 && r.budgeted === "SMALL"
        return ok(good, good ? `${working(r.fresh).length} segment/repair runs and ${working(r.resumed).length} after a resume all ran SMALL (the objective's class); the continuation text budgets SMALL when told` : `runs not at SMALL: ${wrong.map((c) => `${c.kind}=${c.klass}`).join(", ") || "none"}; resumed runs: ${working(r.resumed).length}; continuation budgets ${r.budgeted}`)
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
    },
  },
    {
      id: "run-honours-the-callers-class",
      name: "a run told its task's class routes and offers tools by it",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.LOOP,
      why: "runAgent classified its task text in four places and took no class from its caller, so the controller could not stop forge's own continuation paragraph from routing LARGE and preloading delegate",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-run-class-"))
        const work = path.join(dir, "work"); fs.mkdirSync(work); fs.mkdirSync(path.join(dir, "home"))
        fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n")
        const run = (hint) => inForgeHome(path.join(dir, "home"), `
          const http = await import("node:http")
          const seen = []
          const srv = http.createServer((q, s) => { let b = ""; q.on("data", (c) => { b += c }); q.on("end", () => { seen.push(JSON.parse(b)); s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) }) })
          await new Promise((r) => srv.listen(0, "127.0.0.1", r))
          const { runAgent } = await import(${JSON.stringify(path.join(HERE, "agent.js"))})
          const events = []
          const task = "Continue the autonomous task (segment 2). Work toward the objective; do not restart from scratch.\\n\\nObjective: fix add in lib.js\\n\\nAfter your edits, VERIFY with the appropriate command (focused test for a single-function change; focused + regression + build for a core change). Then either continue to the next remaining step or give a concise final summary if the objective is fully met and verified."
          await runAgent({ config: { providers: {}, agent: {}, tools: {} }, provider: { name: "seekai", protocol: "openai", baseUrl: "http://127.0.0.1:" + srv.address().port, model: "stub", apiKey: "k" }, task, klass: ${JSON.stringify(hint)}, maxStepsOverride: 2, journal: false, onEvent: (e) => events.push(e) })
          srv.close()
          const sys = String((seen[0]?.messages ?? []).find((m) => m.role === "system")?.content ?? "")
          return { route: events.filter((e) => e.type === "info" && /^ROUTE /.test(String(e.text))).map((e) => String(e.text).split(":")[0]), delegate: (seen[0]?.tools ?? []).some((t) => t.function?.name === "delegate"), requests: seen.length, sysChars: sys.length, skills: /^\\[skills\\]|^SKILLS FOR THIS TASK/m.test(sys) }`, { cwd: work })
        try {
          const told = await run("SMALL")
          const untold = await run(null)
          if (told?.error || untold?.error) return ok(false, told?.error || untold?.error)
          if (!untold.requests || !untold.route.length) return ok(false, "no request or no route line — the scenario exercised nothing")
          // SMALL: no skill listing (skills are picked for SMALL only when named) and the SMALL prompt budget (5200 chars)
          const toldPrompt = !told.skills && told.sysChars > 0 && told.sysChars <= 5200
          const good = told.route.every((r) => r === "ROUTE SMALL") && told.route.length > 0 && !told.delegate && toldPrompt && untold.route.includes("ROUTE LARGE") && untold.delegate
          return ok(good, good ? `told SMALL: routes SMALL, no delegate, no skill listing, a ${told.sysChars}-char prompt; not told: the same text routes LARGE and preloads delegate (unchanged default)` : `told SMALL: ${told.route.join(",")} delegate=${told.delegate} skills=${told.skills} prompt=${told.sysChars}; not told: ${untold.route.join(",")} delegate=${untold.delegate}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "governor-says-a-repeat-once",
      name: "a step directive that repeats the last one is sent in one line",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.PROMPT,
      why: "the governor's step directive rides after every tool turn and stays in history, so the same two-line note was re-sent on every later request — ~1.7k tokens of the last request on a 25-step run, most of them word-for-word repeats",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-gov-once-"))
        const home = path.join(dir, "home"), work = path.join(dir, "work")
        fs.mkdirSync(home); fs.mkdirSync(work); fixProject(work)
        try {
          const steps = Array.from({ length: 8 }, (_, i) => (i % 2 ? ["read_file", { path: "test.js" }] : ["grep_files", { pattern: "add" }]))
          const r = await scriptedHeadlessRun({ home, work, task: "look through lib.js and test.js and explain add", maxSteps: 12, respond: (n) => (steps[n - 1] ? toolTurn(n, ...steps[n - 1]) : doneTurn("add subtracts; that is the bug.")) })
          const last = r.seen[r.seen.length - 1]?.body?.messages ?? []
          const notes = last.filter((m) => m.role === "user" && String(m.content).startsWith("(governor)")).map((m) => String(m.content))
          if (notes.length < 4) return ok(false, `only ${notes.length} governor note(s) in history — the scenario exercised nothing`)
          const full = notes.filter((t) => /You MUST follow this action this step/.test(t))
          const short = notes.filter((t) => /^\(governor\) unchanged/.test(t))
          // every full note differs from the full note before it; a short one follows a full one it repeats
          const fullRepeats = full.filter((t, i) => i > 0 && t === full[i - 1]).length
          const firstIsFull = /You MUST follow/.test(notes[0])
          // a short note repeats the action of the last full one — a CHANGED action is never shortened
          const tagOf = (t) => /GOVERNOR: (\S+ \[[^\]]+\])/.exec(t)?.[1] ?? /unchanged: (\S+ \[[^\]]+\])/.exec(t)?.[1] ?? null
          let lastFull = null, mismatched = 0
          for (const t of notes) { if (/^\(governor\) unchanged/.test(t)) { if (tagOf(t) !== lastFull) mismatched++ } else lastFull = tagOf(t) }
          const good = firstIsFull && short.length >= 1 && fullRepeats === 0 && mismatched === 0 && short.every((t) => t.length < 90)
          return ok(good, good ? `${notes.length} notes: ${full.length} in full (each a change), ${short.length} one-line repeats` : `notes ${notes.length}: full ${full.length} (repeated in full ${fullRepeats}), short ${short.length} (${mismatched} standing for a changed action), first full ${firstIsFull}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
    {
      id: "prompt-lists-stay-whole",
      name: "a list in the system prompt reaches the model whole or not at all",
      lane: LANE.PROGRAMME, how: HOW.EXERCISED,
      discipline: DISCIPLINE.PROMPT,
      why: "cognition pushed a list's header and each item as separate chunks, and the prompt budget keeps or drops chunks one at a time — a real run was shown 'ADAPTIVE PLAN:' with its inspect step and nothing else, the impact, implement and verify steps silently cut",
      async check() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-whole-lists-"))
        const work = path.join(dir, "work"); fs.mkdirSync(work); fs.mkdirSync(path.join(dir, "home"))
        fs.writeFileSync(path.join(work, "lib.js"), "exports.add = (a, b) => a - b\n")
        fs.writeFileSync(path.join(work, "test.js"), "const { add } = require('./lib')\n")
        try {
          const r = await inForgeHome(path.join(dir, "home"), `
            const { createCognition } = await import(${JSON.stringify(path.join(HERE, "cognition.js"))})
            const { budgetPrompt } = await import(${JSON.stringify(path.join(HERE, "promptbudget.js"))})
            const cog = createCognition({ cwd: process.cwd(), objective: "fix add in lib.js so test.js passes" })
            const block = cog.promptBlock()
            // a second list: strategies, ranked on architectural work
            const arch = createCognition({ cwd: process.cwd(), objective: "rewrite the auth architecture across files" })
            arch.next({ steps: 0, writes: 0, inspected: false, hasPlan: false })
            const archBlock = arch.promptBlock()
            const stable = "You are forge.\\n\\nRULES:\\n1. inspect first\\nTOOLS — all available, use them automatically as needed:\\n- bash"
            const filler = Array.from({ length: 6 }, (_, i) => "NOTE " + i + ": " + "x".repeat(300)).join("\\n\\n")
            const raw = stable + "\\n\\n" + filler + "\\n\\n" + block
            const outs = []
            for (let budget = 400; budget <= raw.length + 200; budget += 60) outs.push(budgetPrompt(raw, { budget }).full)
            return { block, archBlock, outs }`, { cwd: work })
          if (r?.error) return ok(false, r.error)
          const planLines = String(r.block).split("\n").filter((l) => /^- (inspect|impact|implement|verify): /.test(l))
          if (planLines.length < 3 || !planLines.some((l) => l.startsWith("- impact:"))) return ok(false, `the cognition built no multi-step plan with a non-template step (${planLines.length} steps) — the scenario exercised nothing`)
          const together = String(r.block).includes("ADAPTIVE PLAN (evidence-driven, bounded):\n" + planLines[0])
          let partial = 0, orphan = 0, whole = 0
          for (const out of r.outs) {
            const has = planLines.filter((l) => out.includes(l)).length
            const header = out.includes("ADAPTIVE PLAN (evidence-driven, bounded):")
            if (header && has === planLines.length) whole++
            else if (header) partial++
            else if (has) orphan++
          }
          // every list, in either block, is one chunk: no chunk opens with a list item
          const strategies = /STRATEGIES \(ranked[^\n]*:\n- /.test(String(r.archBlock))
          const loose = [r.block, r.archBlock].flatMap((b) => String(b).split("\n\n")).filter((c) => /^- /.test(c.trim())).length
          const good = together && strategies && loose === 0 && partial === 0 && orphan === 0 && whole > 0
          return ok(good, good ? `the plan's ${planLines.length} steps and the ranked strategies ride under their headers; across ${r.outs.length} budgets the plan was whole ${whole}× and absent otherwise — never partial` : `plan steps under header: ${together}; strategies under header: ${strategies}; loose item chunks: ${loose}; across ${r.outs.length} budgets: whole ${whole}, header with some steps ${partial}, steps without header ${orphan}`)
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } }
      },
    },
  ]
}
