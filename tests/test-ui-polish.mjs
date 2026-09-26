#!/usr/bin/env node
// v198 — a professional terminal UI.
//
// 1. The palette: makeTheme looked colours up under the capability's name
//    ("256", "truecolor") while the palette keys were c256 / tc, so every
//    terminal got 16 colours. render.js kept a second theme whose accent was
//    cyan. Now one palette, and a truecolor terminal gets truecolor.
// 2. The chat start screen: an aligned block (project, model, session) in
//    place of a `cwd:` line and one long `•` line.
// 3. The header: "forge · agent · run de12 · ● EXECUTING 33%".
// 4. Result cards: one shape — title, rule, aligned rows — with file names
//    and the checks that ran.
// 5. `forge --help`: grouped, each group's descriptions in one column.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-"))
let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`) }
}
const U = await import("../ui.js")
const R = await import("../render.js")
const strip = (s) => R.stripAnsi(String(s))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version

console.log("== 1. one palette, real colours ==")
{
  const tc = U.makeTheme("truecolor"), c256 = U.makeTheme("256"), c16 = U.makeTheme("16"), none = U.makeTheme("none")
  ok("truecolor emits 24-bit colour", /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[0m$/.test(tc.success("x")), JSON.stringify(tc.success("x")))
  ok("256 emits 256-colour", /^\x1b\[38;5;\d+mx\x1b\[0m$/.test(c256.error("x")), JSON.stringify(c256.error("x")))
  ok("16 emits a basic colour", /^\x1b\[3\dmx\x1b\[0m$/.test(c16.warning("x")), JSON.stringify(c16.warning("x")))
  ok("none emits nothing, for every token", ["primary", "success", "warning", "error", "info", "accent", "brand", "subtle", "muted"].every((k) => none[k]("x") === "x"))
  ok("the accent is its own colour, not info's", tc.accent("x") !== tc.info("x") && c16.accent("x") !== c16.info("x"))
  ok("brand and subtle exist at every capability", [tc, c256, c16].every((t) => t.brand("x") !== "x" && t.subtle("x") !== "x"))
  const th = U.theme()
  ok("render.js THEME paints with ui.js's palette, token for token", ["primary", "success", "warning", "error", "info", "accent", "muted", "subtle", "brand"].every((k) => R.THEME[k]("x") === th.paint(k, "x")))
  ok("…its legacy aliases too", R.THEME.ok("x") === th.success("x") && R.THEME.fail("x") === th.error("x") && R.THEME.warn("x") === th.warning("x"))
  const cap = (env, tty = true) => U.colorCapability(env, tty)
  ok("capability detection is unchanged", cap({ COLORTERM: "truecolor" }) === "truecolor" && cap({ TERM: "xterm-256color" }) === "256" && cap({ TERM: "xterm" }) === "16" && cap({ NO_COLOR: "1", COLORTERM: "truecolor" }) === "none" && cap({ COLORTERM: "truecolor" }, false) === "none" && cap({ FORCE_COLOR: "1", COLORTERM: "truecolor" }, false) === "truecolor")
}

console.log("== 2. the start screen ==")
{
  const lines = U.bannerLines("9.9.9", "openrouter", "qwen/qwen3-coder:free", { cwd: path.join(os.homedir(), "code", "app"), branch: "main", tools: 22, terminal: true, yolo: true, rows: [["mode", "deep"]] }).map(strip)
  ok("`forge v<version>` first on the banner line", lines[1].startsWith("forge v9.9.9  ·  "), lines[1])
  ok("project row: the path with ~ and the branch", lines.includes("  project   ~/code/app  (main)"), lines.join("\n"))
  ok("model row: provider / model", lines.includes("  model     openrouter / qwen/qwen3-coder:free"))
  ok("session row: tools, terminal, YOLO", lines.includes("  session   22 tools on  ·  terminal on  ·  YOLO"))
  ok("extra rows use the same column", lines.includes("  mode      deep"))
  ok("the keys hint is one line", lines.some((l) => /^  \/help commands  ·  Alt\+P palette  ·  Ctrl\+C cancel/.test(l)))
  const bare = U.bannerLines("1.0.0", "", "", {}).map(strip)
  ok("no model: it says how to get one", bare.some((l) => /model     none configured — run forge onboard/.test(l)), bare.join("\n"))
  const deepPath = U.bannerLines("1", "p", "m", { cwd: "/a/very/long/path/that/goes/on/and/on/for/a/while/until/it/is/too/wide/proj" }).map(strip)
  ok("a very long path keeps its last three parts", deepPath.includes("  project   …/is/too/wide/proj  ") || deepPath.includes("  project   …/too/wide/proj"), deepPath.join("\n"))
  ok("a string is still taken as the old one-line extra", U.bannerLines("1", "p", "m", "hello").map(strip).some((l) => l.trim() === "hello"))

  // the branch, read without a git process
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-git-"))
  fs.mkdirSync(path.join(repo, ".git")); fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature/ui\n")
  ok("branch from .git/HEAD, from a subdirectory", U.gitBranchOf(path.join(repo, "src", "deep")) === "feature/ui", U.gitBranchOf(path.join(repo, "src", "deep")))
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
  ok("a detached HEAD: its short hash", U.gitBranchOf(repo) === "0123456")
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-wt-"))
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "w"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "w", "HEAD"), "ref: refs/heads/wt-branch\n")
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "w")}\n`)
  ok("a worktree: follows its gitdir file", U.gitBranchOf(wt) === "wt-branch", U.gitBranchOf(wt))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-nogit-"))
  ok("outside a repository: no branch", U.gitBranchOf(outside) === "" || !fs.existsSync(path.join(os.tmpdir(), ".git")))
  for (const d of [repo, wt, outside]) fs.rmSync(d, { recursive: true, force: true })

  // a real chat
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] })) }) })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-home-")), work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uipolish-work-"))
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeProvider: "stub", providers: { stub: { protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "m" } }, skills: { enabled: false }, chat: { stream: false } }))
  let out = ""
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "forge.js"), "chat"], { cwd: work, env: { PATH: process.env.PATH, HOME: home, FORGE_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (d) => { out += d }); child.stderr.on("data", (d) => { out += d })
    child.stdin.write("/status\n/exit\n"); child.stdin.end()
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 60000)
    child.once("exit", () => { clearTimeout(t); resolve() })
  })
  srv.close()
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true })
  ok("a real chat opens with the block", out.includes(`forge v${VERSION}  ·  autonomous engineering`) && /\n  project   /.test(out) && /\n  model     stub \/ m\n/.test(out) && /\n  session   \d+ tools on/.test(out), out.slice(0, 600))
  ok("…without the old `cwd:` and `auto-tools:` lines", !/^cwd: /m.test(out) && !/auto-tools:/.test(out))
  ok("skills moved to /status", /\n  skills:     /.test(out))
}

console.log("== 3. the header and status line ==")
{
  const o = R.renderOptions({ now: 1_000_000 })
  const st = { state: "EXECUTING", mode: "agent", provider: "openrouter", model: "qwen/qwen3-coder:free", task: { id: "run-abc-de12", title: "add a subtract function and test it", startedAt: 1_000_000 - 83_000, step: 4 }, plan: [{ text: "a", status: "done" }, { text: "b", status: "doing" }, { text: "c", status: "todo" }] }
  for (const w of [40, 80, 120]) {
    const h = strip(R.renderHeader(st, w, o)), sl = strip(R.renderStatusLine(st, w, o))
    ok(`${w} columns: nothing wider than the terminal`, R.displayWidth(h) <= w - 1 && R.displayWidth(sl) <= w - 1, `${h} | ${sl}`)
    ok(`${w} columns: the state survives`, h.includes("EXECUTING") && sl.includes("EXECUTING"))
  }
  const wide = strip(R.renderHeader(st, 120, o))
  ok("the wordmark, mode and run id, joined with ·", wide.startsWith("forge · agent · run de12 · "), wide)
  ok("one separator throughout (no double-space gaps)", !/ {2}/.test(wide), wide)
  const coloured = R.renderHeader(st, 120, { ...o, th: R.THEME })
  ok("the wordmark is painted with the brand token", coloured.startsWith(R.THEME.brand("forge")))
}

console.log("== 4. result cards ==")
{
  const o = R.renderOptions({ now: 0 })
  const oA = R.renderOptions({ now: 0, ascii: true })
  const done = R.renderCompletion({ title: "add subtract", summary: "Added subtract and a test.\nmore", files: ["/p/index.js", "/p/test.js"], cwd: "/p", checks: [{ command: "npm test", passed: false }, { command: "npm run lint", passed: true }, { command: "npm test", passed: true }], steps: 6, toolCalls: 9, elapsedMs: 83_000 }, 100, o).map(strip)
  ok("title line: mark, word, muted detail", done[0] === "✓ COMPLETED  ·  add subtract", done[0])
  ok("then a rule", /^─{8,48}$/.test(done[1]), done[1])
  ok("the summary's first line", done.includes("  Summary      Added subtract and a test."), done.join("\n"))
  ok("changes name the files", done.includes("  Changes      2 files — index.js, test.js"))
  ok("checks: each command once, its last result, in order", done.includes("  Checks       npm run lint ✓  ·  npm test ✓"), done.join("\n"))
  ok("every row's value starts in one column", done.slice(2).every((l) => l.length > 15 && l[14] === " " && l[15] !== " "), done.join("\n"))
  const many = R.filesText(["a", "b", "c", "d", "e"].map((f) => `/p/${f}.js`), o, { cwd: "/p" })
  ok("more than three files: three and a count", many === "5 files — a.js, b.js, c.js +2", many)
  const fail = R.renderFailure({ title: "fix it", reason: "provider HTTP 400: " + "word ".repeat(60), steps: 3, files: 0, next: "retry with another model" }, 80, o).map(strip)
  ok("failure: the same title shape", fail[0] === "✗ TASK FAILED  ·  fix it" && /^─+$/.test(fail[1]), fail.slice(0, 2).join("\n"))
  const reasonRows = fail.filter((l, i) => i >= 2 && (l.startsWith("  Reason") || /^ {15}\S/.test(l)))
  ok("…the reason still wraps under its label (v180)", reasonRows.length > 1 && reasonRows.every((l) => R.displayWidth(l) <= 79), reasonRows.join("\n"))
  ok("…in the shared label column", fail.slice(2).filter((l) => l.trim()).every((l) => l.slice(0, 15).trim() === "" || l[14] === " "))
  const ascii = R.renderCompletion({ files: ["/p/a.js"], cwd: "/p", checks: [{ command: "npm test", passed: true }] }, 80, oA).map(strip)
  ok("FORGE_ASCII: no Unicode in a card", ascii.every((l) => /^[\x20-\x7e]*$/.test(l)), ascii.join("\n"))
  const { createTerminal } = await import("../terminal.js")
  const { createUIStore } = await import("../uistate.js")
  const { createAgentView } = await import("../agentview.js")
  const { Writable } = await import("node:stream")
  let buf = ""
  const output = new Writable({ write(c, _e, cb) { buf += c; cb() } }); output.columns = 100
  const term = createTerminal({ input: { isTTY: false }, output, forceTTY: false, env: { NO_COLOR: "1" } })
  const store = createUIStore({ mode: "chat", provider: "p", model: "m", cwd: "/p", terminal: { columns: 100, rows: 24, tty: false } })
  store.dispatch({ type: "TASK_STARTED", id: "run-1-aaaa", title: "t", kind: "agent" })
  const view = createAgentView({ term, store, cwd: "/p", plain: true, silent: true })
  view.printResult({ text: "Done.", steps: 2, toolLog: [], commandChecks: [{ command: "npm test", passed: true, exitCode: 0 }] }, { elapsedMs: 10 })
  view.stop()
  const card = strip(buf)
  ok("the agent's own card: COMPLETED title, rule, and the check that ran", /✓ COMPLETED  ·  2 steps/.test(card) && /\n─{8,}\n/.test(card) && /\n  Checks       npm test ✓/.test(card), card)
}

console.log("== 5. forge --help ==")
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "forge.js"), "--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
  const help = r.stdout
  ok("exits 0 and still says usage", r.status === 0 && /^usage  forge \[command\] \[options\]$/m.test(help))
  const HEADINGS = ["Get started", "Chat & sessions", "In chat — terminal + deep", "Agent & plans", "Control — v88 shell + v122 YOLO, one switch, one report", "Memory & knowledge", "Skills, tools & MCP", "Providers & config", "Diagnostics & bench", "Environment — full power on any device, Termux/NetHunter ready", "Flags"]
  const lines = help.split("\n")
  ok("every group heading, in order", HEADINGS.every((h, i) => lines.indexOf(h) > (i ? lines.indexOf(HEADINGS[i - 1]) : -1)), HEADINGS.filter((h) => !lines.includes(h)).join(", "))
  // within a group, every command row's description starts in one column
  let misaligned = []
  HEADINGS.forEach((h, i) => {
    const from = lines.indexOf(h) + 1, to = i + 1 < HEADINGS.length ? lines.indexOf(HEADINGS[i + 1]) : lines.indexOf("", from)
    const rows = lines.slice(from, to).filter((l) => /^  (forge|FORGE_|--|-m|!)/.test(l) || /^  \S.*\S {2,}\S/.test(l) && /^  (forge|FORGE_|--|!)/.test(l))
    const cols = new Set(rows.map((l) => { const m = /^  (\S(?:.*?\S)?) {2,}(?=\S)/.exec(l); return m ? m[0].length : -1 }))
    if (cols.size > 1) misaligned.push(`${h}: ${[...cols].join(",")}`)
  })
  ok("within each group, descriptions start in one column", misaligned.length === 0, misaligned.join(" | "))
  const COMMANDS = ["forge --pick", "forge ask", "forge chat", "forge resume", "forge agent", "forge agent --auto", "forge --yolo", "forge yolo", "forge --safe", "forge agent --plan", "forge plan list|show|apply", "forge undo", "forge tasks", "forge onboard", "forge config", "forge config show|path|get|set|unset", "forge doctor", "forge sessions", "forge skills", "forge skill download", "forge skill verify", "forge skill promote", "forge skill autopromote", "forge skill caps", "forge skill benchmark", "forge skill learn", "forge skill ttl", "forge tool download", "forge tool verify", "forge mcp catalog", "forge memory", "forge data", "forge claims", "forge cognition", "forge decisions", "forge knowledge", "forge skill ingest", "forge variant list", "forge knowtype list", "forge variant add", "forge roles", "forge experiment", "forge embeddings", "forge bench", "forge bench --cases", "forge selfaudit", "forge eval", "forge plugins", "forge tools", "forge use", "forge models", "forge provider add", "forge provider test", "forge provider set-key", "forge provider remove", "FORGE_FASTWISE", "FORGE_FAILOVER", "FORGE_SHELL"]
  const missing = COMMANDS.filter((c) => !help.includes(c))
  ok(`all ${COMMANDS.length} commands from v197's help are still listed`, missing.length === 0, missing.join(", "))
  ok("memory move is listed", /forge memory .*move <n>/.test(help))
  ok("the claims tests rely on stay (YOLO rails, AutoPick, the terminal)", /never turns off/.test(help) && /injection fence/.test(help) && /AutoPick/.test(help) && /like a real terminal/.test(help) && /tools\.autoApprove/.test(help))
  ok("no colour codes under NO_COLOR", !/\x1b\[/.test(help))
}

try { fs.rmSync(process.env.FORGE_HOME, { recursive: true, force: true }) } catch {}
console.log(`== ui-polish suite: ${PASS} passed, ${FAIL} failed ==`)
process.exitCode = FAIL ? 1 : 0
