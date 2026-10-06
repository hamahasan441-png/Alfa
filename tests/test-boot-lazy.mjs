#!/usr/bin/env node
/**
 * forge — what an agent run does NOT load at startup (lazybuiltin.js and the
 * deferred modules), checked by what a fresh process actually loaded, not by
 * a stopwatch: timings vary by machine, the set of loaded modules does not.
 *
 * The timing itself is the `boot-budget` lane in `forge bench` (120 ms).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bootlazy-"))
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT, ...opts })

try {
  console.log("== a fresh process importing agent.js ==")
  {
    // a loader hook records every forge module that is loaded
    const log = path.join(TMP, "modules.txt")
    fs.writeFileSync(path.join(TMP, "hooks.mjs"), `import fs from "node:fs"\nexport async function load(url, ctx, next) { if (url.startsWith("file:")) fs.appendFileSync(${JSON.stringify(log)}, url + "\\n"); return next(url, ctx) }\n`)
    fs.writeFileSync(path.join(TMP, "reg.mjs"), `import { register } from "node:module"\nregister(${JSON.stringify(pathToFileURL(path.join(TMP, "hooks.mjs")).href)})\n`)
    const probe = `const before = new Set(process.moduleLoadList); await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "agent.js")).href)}); const list = JSON.stringify(process.moduleLoadList.filter((m) => !before.has(m) && m.startsWith("NativeModule ")).map((m) => m.slice(13))); process.stdout.write(list)`
    const plain = node(["--input-type=module", "-e", probe])
    let builtins = []
    try { builtins = JSON.parse(plain.stdout) } catch { }
    ok("agent.js imports cleanly", plain.status === 0 && builtins.length > 0, plain.stderr.slice(0, 400))
    for (const b of ["crypto", "child_process", "zlib", "util", "string_decoder", "worker_threads", "net", "http", "https", "stream", "internal/fs/streams"]) {
      ok(`node:${b} is not loaded at startup`, !builtins.includes(b), builtins.filter((x) => !x.startsWith("internal/")).join(", "))
    }
    const hooked = node(["--import", pathToFileURL(path.join(TMP, "reg.mjs")).href, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "agent.js")).href)})`])
    const loaded = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((u) => path.basename(fileURLToPath(u)))
    ok("the module list was recorded", hooked.status === 0 && loaded.includes("agent.js"), hooked.stderr.slice(0, 300))
    for (const m of ["mcp.js", "plannerisk.js", "engmemory.js"]) ok(`${m} is not loaded at startup`, !loaded.includes(m))
    ok("…its small startup helpers are (mcplite.js)", loaded.includes("mcplite.js"))
  }

  console.log("== the stand-ins behave like the modules ==")
  {
    const L = await import("../lazybuiltin.js")
    const zlib = L.lazyBuiltin("zlib")
    ok("nothing is loaded until it is used", !L.builtinLoaded("zlib"))
    const round = zlib.gunzipSync(zlib.gzipSync(Buffer.from("forge"))).toString()
    ok("a default-import stand-in works on first use", round === "forge" && L.builtinLoaded("zlib"))
    ok("…its keys are the module's keys", Object.keys(zlib).includes("gzipSync") && "constants" in zlib)
    const crypto = L.lazyBuiltin("crypto")
    ok("…and hashes like the real thing", crypto.createHash("sha256").update("x").digest("hex") === (await import("node:crypto")).createHash("sha256").update("x").digest("hex"))
    const real = L.loadBuiltin("crypto")
    crypto.__forgeProbe = 7
    ok("a write goes to the real module", real.__forgeProbe === 7)
    delete real.__forgeProbe
    const execFileSync = L.lazyExport("child_process", "execFileSync")
    ok("a named-function stand-in is called like the function", execFileSync(process.execPath, ["-e", "process.stdout.write('hi')"], { encoding: "utf8" }) === "hi")
    ok("…and keeps its name", execFileSync.name === "execFileSync")
    const execFile = L.lazyExport("child_process", "execFile")
    const r = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write('p')"])
    ok("util.promisify(execFile) still resolves { stdout, stderr }", r && r.stdout === "p", JSON.stringify(r))
    const StringDecoder = L.lazyExport("string_decoder", "StringDecoder")
    const d = new StringDecoder("utf8")
    ok("a class stand-in works with new: the real class, its methods", d.write(Buffer.from("é")) === "é" && d instanceof L.loadBuiltin("string_decoder").StringDecoder)
    ok("…and instanceof the stand-in asks the real class", d instanceof StringDecoder && !({} instanceof StringDecoder))
    ok("loadBuiltin('fs') is node:fs itself", L.loadBuiltin("fs") === (await import("node:fs")).default)
  }

  console.log("== an older Node without process.getBuiltinModule ==")
  {
    const pre = path.join(TMP, "old-node.mjs")
    fs.writeFileSync(pre, "delete process.getBuiltinModule\n")
    const r = node(["--import", pathToFileURL(pre).href, "--input-type=module", "-e",
      `const L = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lazybuiltin.js")).href)}); const h = L.lazyBuiltin("crypto").createHash("sha1").update("a").digest("hex"); const fs = L.loadBuiltin("fs"); process.stdout.write(h + " " + typeof fs.readFileSync)`])
    ok("the built-ins are loaded up front and everything still works", r.status === 0 && r.stdout === "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8 function", r.stdout + r.stderr.slice(0, 300))
    const a = node(["--import", pathToFileURL(pre).href, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "agent.js")).href)}); process.stdout.write("ok")`])
    ok("…agent.js imports there too", a.status === 0 && a.stdout === "ok", a.stderr.slice(0, 300))
  }

  console.log("== moved code keeps its old addresses ==")
  {
    const mcp = await import("../mcp.js"), lite = await import("../mcplite.js")
    ok("mcp.js still exports parseMcpToolName / configuredServers / cachedInventoryTools", mcp.parseMcpToolName === lite.parseMcpToolName && mcp.configuredServers === lite.configuredServers && mcp.cachedInventoryTools === lite.cachedInventoryTools)
    const pr = await import("../plannerisk.js"), rp = await import("../riskplan.js")
    ok("plannerisk.js still exports verificationPlanForRisk", pr.verificationPlanForRisk === rp.verificationPlanForRisk && pr.verificationPlanForRisk("high").level === "HIGH")
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== boot-lazy suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
