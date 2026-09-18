#!/usr/bin/env node
/**
 * forge — read-path boundary suite (v124), the sibling of test-fs-toctou.mjs.
 *
 * Writes have been descriptor-relative since v21.1 (securefs: O_NOFOLLOW on
 * every component, temp→fsync→rename). READS were still `fs.openSync(path)`,
 * and `read_file` resolved the same name FOUR times — existsSync, statSync,
 * openSync for the binary sniff, then openSync again inside readLineRange.
 * Every gap between those was a window in which the name could be re-pointed,
 * and the most damaging one is between the SNIFF and the STREAM: the sniff
 * would clear a text file while the stream served whatever replaced it.
 *
 * v124 opens once through projectOpenRead() and serves the size, the sniff and
 * the streamed window from THAT descriptor. These tests assert both halves:
 * nothing about ordinary reading changed, and the swap no longer lands.
 *
 * Zero network. Temp dirs only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-readtoctou-home-"))
process.env.FORGE_HOME = HOME
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}

const { execTool } = await import("../tools.js")
const { secureOpenRead, SecureFsError } = await import("../securefs.js")

const NUL = String.fromCharCode(0)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-readtoctou-"))
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "forge-readtoctou-out-"))
fs.mkdirSync(path.join(ROOT, "sub"), { recursive: true })
fs.writeFileSync(path.join(ROOT, "a.txt"), "l1\nl2\nl3\nl4\nl5\n")
fs.writeFileSync(path.join(ROOT, "sub", "b.txt"), "x\n")
fs.writeFileSync(path.join(ROOT, "bin.dat"), Buffer.from(`bin${NUL}data\n`))
fs.writeFileSync(path.join(OUT, "secret.txt"), "OUTSIDE\n")
fs.symlinkSync(path.join(ROOT, "a.txt"), path.join(ROOT, "link.txt"))
fs.symlinkSync(path.join(OUT, "secret.txt"), path.join(ROOT, "outside.txt"))
fs.symlinkSync(path.join(ROOT, "sub"), path.join(ROOT, "dirlink"))

const ctx = { cwd: ROOT, root: ROOT, timeoutSec: 10, maxToolOutput: 32000, readOnly: true, _plugins: new Map() }
const read = async (args) => String(await execTool(ctx, "read_file", args))

console.log("== ordinary reading is unchanged ==")
{
  const whole = await read({ path: "a.txt" })
  ok("a plain file reads with line numbers", /^\s*1\| l1/m.test(whole) && /5\| l5/.test(whole), whole.slice(0, 80))
  const win = await read({ path: "a.txt", offset: 3 })
  ok("an offset window starts where asked", /^\s*3\| l3/m.test(win) && !/1\| l1/.test(win), win.slice(0, 60))
  const linked = await read({ path: "link.txt" })
  ok("a symlinked FILE is still readable (aliases are deliberate)", /1\| l1/.test(linked), linked.slice(0, 60))
  ok("a file under a symlinked DIRECTORY is still readable", /1\| x/.test(await read({ path: "dirlink/b.txt" })))
  // v88 noguard: reads are unrestricted, so "outside the project" is allowed —
  // the hardening is about HOW the open happens, not a new boundary.
  ok("a symlink pointing outside still resolves (v88: reads are unrestricted)",
    /OUTSIDE/.test(await read({ path: "outside.txt" })))
  ok("an absolute path outside the project still reads",
    /OUTSIDE/.test(await read({ path: path.join(OUT, "secret.txt") })))
}

console.log("== the historical error messages are preserved ==")
{
  const missing = await read({ path: "nope.txt" })
  ok("missing file", /^ERROR: not found: /.test(missing), missing)
  const dir = await read({ path: "sub" })
  ok("directory", /^ERROR: is a directory: /.test(dir), dir)
  ok("binary file", /^ERROR: binary file \(not readable as text\)/.test(await read({ path: "bin.dat" })))
  ok("offset past EOF names the line count",
    /past the end of the file \(5 lines\)/.test(await read({ path: "a.txt", offset: 99 })))
}

console.log("== the sniff and the content come from ONE descriptor ==")
{
  // The attack the old code allowed: let the 8KB binary sniff pass on a text
  // file, then re-point the NAME before readLineRange opened it a second time.
  // Fault injection (not timing luck): the first readSync of the run swaps the
  // file for a NEW INODE holding binary bytes. A path-resolving reader serves
  // the swapped bytes; a descriptor-pinned reader cannot see them at all.
  const victim = path.join(ROOT, "swap.txt")
  fs.writeFileSync(victim, "ORIGINAL-1\nORIGINAL-2\n")
  const realReadSync = fs.readSync
  let fired = false
  fs.readSync = function (...a) {
    const n = realReadSync.apply(this, a)
    if (!fired) {
      fired = true
      try {
        fs.unlinkSync(victim) // new inode, same name
        fs.writeFileSync(victim, Buffer.from(`SWAPPED${NUL}BINARY\n`))
      } catch { /* the assertion below is what judges this */ }
    }
    return n
  }
  let out
  try { out = await read({ path: "swap.txt" }) } finally { fs.readSync = realReadSync }

  ok("the swap actually happened (the injection is live)",
    fired && /SWAPPED/.test(fs.readFileSync(victim, "latin1")))
  ok("the read served the ORIGINAL bytes, not the swapped ones",
    /ORIGINAL-1/.test(out) && !/SWAPPED/.test(out), out.slice(0, 120))
  ok("…and the swapped BINARY content never reached the model",
    !out.includes(NUL) && !/binary file/.test(out), out.slice(0, 120))
}

console.log("== the securefs read primitive keeps its own contract ==")
{
  let escaped = null
  try { const h = secureOpenRead(ROOT, path.join(OUT, "secret.txt")); fs.closeSync(h.fd); escaped = "opened" }
  catch (e) { escaped = e }
  ok("a target outside the anchor root is refused (EESCAPE)",
    escaped instanceof SecureFsError && escaped.code === "EESCAPE", String(escaped?.code ?? escaped))

  let linked = null
  try { const h = secureOpenRead(ROOT, "outside.txt"); fs.closeSync(h.fd); linked = "opened" }
  catch (e) { linked = e }
  ok("a symlinked FINAL component is refused by the primitive (ESYMLINK)",
    linked instanceof SecureFsError && linked.code === "ESYMLINK", String(linked?.code ?? linked))

  let dirErr = null
  try { const h = secureOpenRead(ROOT, "sub"); fs.closeSync(h.fd); dirErr = "opened" }
  catch (e) { dirErr = e }
  ok("a directory is refused (ENOTFILE)",
    dirErr instanceof SecureFsError && dirErr.code === "ENOTFILE", String(dirErr?.code ?? dirErr))

  const good = secureOpenRead(ROOT, "a.txt")
  ok("a regular file opens and carries its fstat",
    typeof good.fd === "number" && good.stat.isFile() && good.stat.size > 0)
  fs.closeSync(good.fd)
}

console.log("== the wiring is real (read_file no longer opens by path) ==")
{
  const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("function read_file(ctx, args)"), src.indexOf("function read_image(ctx, args)"))
  ok("read_file opens through projectOpenRead", /projectOpenRead\(ctx, p\)/.test(body))
  ok("read_file no longer resolves the name itself",
    !/fs\.openSync\(/.test(body) && !/fs\.existsSync\(/.test(body) && !/fs\.statSync\(p\)/.test(body))
  ok("read_file closes the descriptor it opened", /finally\s*\{\s*try\s*\{\s*fs\.closeSync\(fd\)/.test(body))
  const rlr = src.slice(src.indexOf("function readLineRange("), src.indexOf("function read_file(ctx, args)"))
  ok("readLineRange takes a descriptor, never a path", /function readLineRange\(fd, start, end\)/.test(rlr))
  ok("readLineRange opens nothing itself", !/fs\.openSync\(/.test(rlr))
  ok("projectOpenRead anchors through securefs", /secureOpenRead\(root, target\)/.test(src))
}

try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {}
try { fs.rmSync(OUT, { recursive: true, force: true }) } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n== read-toctou suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
