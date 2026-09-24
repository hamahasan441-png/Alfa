#!/usr/bin/env node
/**
 * tests/test-wiring.mjs — capabilities that existed but nothing called.
 *
 * THE FAILURE MODE THIS GUARDS
 *
 * A module that ships, passes its own unit tests, and is never imported by
 * anything is worse than a missing feature: the tests are green, the
 * CHANGELOG says it shipped, and the behaviour does not exist. `osc.js`
 * shipped at v136 with six emitters and ONE caller. `cache_ineffective` was
 * emitted by v139 and rendered by nothing.
 *
 * So these assertions are about REACHABILITY, not about the emitters
 * themselves — `test-osc.mjs` already proves those produce correct bytes.
 * Here the question is only ever: does a real code path call it?
 *
 * Non-vacuity: each check names the specific caller, so deleting the wiring
 * fails the test. A bare "the export exists" check would pass on the dead
 * code it is supposed to catch.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 200) : ""}`) }
}

console.log("== cache_ineffective reaches a human ==")
{
  const agent = read("agent.js")
  const chat = read("chat.js")
  ok("agent.js still emits it", /type: "cache_ineffective"/.test(agent))
  ok("agentEventPrinter renders it", /ev\.type === "cache_ineffective"/.test(agent))
  ok("the rendered line names the provider", /prompt cache ineffective on \$\{ev\.provider\}/.test(agent))
  // chat.js routes unknown event types through a `shown` set that dedups by
  // TYPE — a second provider's warning would have been swallowed by the
  // first. Listing it explicitly is the point of this assertion.
  ok("chat.js routes it explicitly, not via the deduping default",
    /case "cache_ineffective":/.test(chat))
}

console.log("== osc.js has real callers, not just exports ==")
{
  const forge = read("forge.js")
  const terminal = read("terminal.js")
  ok("forge.js loads osc.js", /import\("\.\/osc\.js"\)/.test(forge))
  // LAZILY, and that is not a detail. osc.js measured 3ms to import, and an
  // eager import put those 3ms on `forge --help` and every other command
  // that will never emit an OSC byte — the exact pattern netlazy.js exists
  // for. A static import here would be a startup regression.
  ok("...lazily, not at module scope", !/^import .*from "\.\/osc\.js"/m.test(forge))
  ok("...memoized so a long run imports it once", /_osc \?\?= await import/.test(forge))
  ok("fileLink has a caller", /fileLink\(path\.resolve/.test(forge))
  ok("notify has a caller", /notify\(`forge — \$\{verdict\}`/.test(forge))
  // The cheap check must come FIRST, or a short run pays the import anyway.
  ok("the elapsed-time gate precedes the import",
    /if \(elapsed < UNATTENDED_RUN_MS\) return\s*\n\s*const \{ notify \} = await loadOsc\(\)/.test(forge))
  ok("the toast is gated on elapsed time", /UNATTENDED_RUN_MS/.test(forge))
  ok("...and the gate is a named constant, not a literal",
    /const UNATTENDED_RUN_MS = /.test(forge))
  ok("the title emitter keeps its v136 caller", /osc\.js/.test(terminal))
  // The toast must never be able to break a run — it is decoration.
  ok("the toast call is wrapped", /function notifyIfUnattended[\s\S]{0,400}try \{/.test(forge))
  ok("...and swallows its own failure", /catch \{ \/\* a toast must never affect the run's outcome \*\/ \}/.test(forge))
  // Reachability: both convergence points of the one-shot run call it, so a
  // run that ends down either branch still notifies.
  const calls = [...forge.matchAll(/notifyIfUnattended\(res, t0, task\)/g)].length
  ok(`both run-completion paths notify (${calls})`, calls >= 2)
}

console.log("== the single file prunes superseded runtime trees ==")
{
  const script = read("scripts/build-single-file.mjs")
  ok("the launcher template contains the sweep", /RUNTIME_KEEP/.test(script))
  ok("only COMPLETE trees are candidates", /\.complete/.test(script) && /entries/.test(script))
  ok("the sweep cannot stop the CLI", /catch \{ \/\* housekeeping only \*\/ \}/.test(script))
}

console.log("== the sweep actually sweeps (end to end) ==")
{
  // Built once and run twice against a HOME we control, so the assertion is
  // about observed directories rather than about the source text above.
  const dist = path.join(ROOT, "dist", "forge.mjs")
  if (!fs.existsSync(dist)) {
    console.log("  skip  dist/forge.mjs not built (run scripts/build-single-file.mjs)")
  } else {
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-"))
    const rt = path.join(HOME, "runtime")
    fs.mkdirSync(rt, { recursive: true })
    const mk = (name, when) => {
      const d = path.join(rt, name)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, ".complete"), name)
      fs.utimesSync(path.join(d, ".complete"), when, when)
    }
    // Four superseded trees, plus one interrupted tree with no marker.
    mk("152.0.0-old1", 1000), mk("152.0.0-old2", 2000)
    mk("152.0.0-old3", 3000), mk("152.0.0-old4", 4000)
    fs.mkdirSync(path.join(rt, "152.0.0-interrupted"), { recursive: true })
    try {
      execFileSync(process.execPath, [dist, "--version"], {
        env: { ...process.env, FORGE_HOME: HOME }, stdio: "ignore", timeout: 60000,
      })
      const left = fs.readdirSync(rt).sort()
      ok("the two oldest complete trees are gone",
        !left.includes("152.0.0-old1") && !left.includes("152.0.0-old2"), left.join(","))
      ok("the two newest complete trees are kept",
        left.includes("152.0.0-old3") && left.includes("152.0.0-old4"), left.join(","))
      // An interrupted tree has no marker: another process may be mid-write
      // into it, so it is never a candidate.
      ok("an interrupted tree is left alone", left.includes("152.0.0-interrupted"), left.join(","))
      // And the tree this very run extracted must survive its own sweep.
      ok("the tree in use survives", left.some((d) => /^\d+\.\d+\.\d+-[0-9a-f]{16}$/.test(d)), left.join(","))
    } catch (e) {
      ok("single-file run for the prune check", false, e.message)
    } finally {
      try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
    }
  }
}

console.log(`\n== wiring suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
