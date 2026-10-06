/**
 * forge — optional bash sandbox (v27, zero dependencies)
 *
 * PLAN-v24 Tier 2 item 5: wrap model bash in bubblewrap when the binary is
 * actually on PATH. Shellguard remains the classifier — this is a process
 * boundary ON TOP, never a replacement. If bwrap is missing we spawn
 * `/bin/sh -c` exactly as v26 did and we never report `sandboxed: true`.
 *
 * The plugin-isolation lesson: a missing isolator is "unsandboxed", not a
 * fake sandbox. Do not unshare the network namespace — npm / git / fetches
 * need it; netguard still owns URL policy.
 *
 * Escape hatch became the default in v88: model bash runs UNSANDBOXED unless
 * FORGE_SANDBOX=1 explicitly asks for the wrap. FORGE_BWRAP=/path/to/bwrap
 * pins the binary (tests).
 *
 * v87: a bwrap binary on PATH is NOT enough. Unprivileged bwrap needs the
 * kernel's overflow uid/gid sysctls to build its user namespace; inside
 * containers / hardened kernels it exists but EVERY command dies before it
 * runs with:  bwrap: Can't read /proc/sys/kernel/overflowuid: Permission denied
 * A missing isolator is "unsandboxed", not a fake sandbox — so we probe once
 * and treat such a bwrap as missing (commands then run directly via /bin/sh).
 */
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
import path from "node:path"
import os from "node:os"
import { resolveShell } from "./sysshell.js"
import { lazyExport, loadBuiltin } from "./lazybuiltin.js"
const spawnSync = lazyExport("child_process", "spawnSync") // loaded on first use (lazybuiltin.js)

const RO_TRY = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt"]

let kernProbe = undefined // undefined = not probed yet
let kernProbes = 0

/** Can unprivileged bwrap actually build a user namespace on this kernel? */
function bwrapKernelSupport() {
  if (process.platform !== "linux") return false
  if (kernProbe !== undefined) return kernProbe
  const readable = (p) => { try { fs.readFileSync(p); return true } catch { return false } }
  kernProbes++
  kernProbe = readable("/proc/sys/kernel/overflowuid") && readable("/proc/sys/kernel/overflowgid")
  return kernProbe
}

/** v94 todowise: cheap kernel RE-PROBE. The overflowuid/overflowgid verdict is
 *  cached once per process; a kernel hardened AFTER forge started keeps
 *  serving the stale "supported" verdict and every sandboxed command burns a
 *  failed bwrap start. On the first observed bwrap startup failure the caller
 *  re-probes (tools.js v87 fallback) so findSandboxBinary() sees the REAL
 *  kernel state — hardened → bwrap treated as missing, commands run through
 *  the resolved shell without the dead wrapper. Re-probes are counted
 *  (kernelProbeCount) so a test can prove one actually happened. */
export function reprobeKernelSupport() {
  kernProbe = undefined
  return bwrapKernelSupport()
}

/** Test affordance: reset WITHOUT re-probing (the next findSandboxBinary()
 *  probes lazily). Production paths use reprobeKernelSupport(). */
export function resetKernelProbe() {
  kernProbe = undefined
}

/** How many real kernel probes this process performed (tests assert the
 *  re-probe actually happened — never a claimed reset). */
export function kernelProbeCount() {
  return kernProbes
}

function isSetuid(p) {
  try { return !!(fs.statSync(p).mode & 0o4000) } catch { return false }
}

function exists(p) {
  try { return !!p && fs.existsSync(p) } catch { return false }
}

function which(name) {
  const pathEnv = process.env.PATH || ""
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const cand = path.join(dir, name)
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
    } catch {}
  }
  return null
}

/** Resolve the sandbox binary, or null. Never throws. */
export function findSandboxBinary({ confined = false } = {}) {
  // v88 "noguard": sandbox wrapping is OPT-IN. Default is unsandboxed /bin/sh
  // (full control — the owner's standing decision). Set FORGE_SANDBOX=1 to
  // wrap model bash in bwrap again when the binary actually works.
  // V6: a CONFINED run (forge improve) asked for confinement itself, so it is
  // wrapped whenever a working bwrap exists — unless FORGE_SANDBOX=0 says no.
  const want = process.env.FORGE_SANDBOX
  const on = want === "1" || want === "true" || want === "on" || want === "yes"
  const off = want === "0" || want === "false" || want === "off" || want === "no"
  if (!on && !(confined && !off)) return null
  const bin = process.env.FORGE_BWRAP
    ? (exists(process.env.FORGE_BWRAP) ? process.env.FORGE_BWRAP : null)
    : which("bwrap")
  if (!bin) return null
  // v87: setuid bwrap does not need unprivileged userns; a plain binary on a
  // kernel that hides overflowuid/overflowgid can never start — treat it as
  // missing instead of failing every single command.
  if (!isSetuid(bin) && !bwrapKernelSupport()) return null
  return bin
}

/**
 * @returns {{ available: boolean, kind: "bwrap"|"none", binary: string|null }}
 * `opts.binary` injects a path (tests). Pass `null` to force unsandboxed.
 */
export function detectSandbox(opts = {}) {
  const binary = Object.prototype.hasOwnProperty.call(opts, "binary")
    ? (opts.binary || null)
    : findSandboxBinary({ confined: opts.confined === true })
  if (!binary) return { available: false, kind: "none", binary: null }
  return { available: true, kind: "bwrap", binary }
}

/**
 * argv for a sandboxed `/bin/sh -c command`. Binds the project (and HOME if
 * it is a real directory) read-write; system prefixes read-only; pid
 * unshared; network left intact. Missing binary → unsandboxed argv.
 *
 * @returns {{ file: string, args: string[], sandboxed: boolean, kind: "bwrap"|"none" }}
 */
export function wrapBash(command, { cwd, root, binary, confine = null } = {}) {
  const det = detectSandbox(binary !== undefined ? { binary } : { confined: Boolean(confine?.root) })
  const cmd = String(command ?? "")
  if (!det.available && confine?.root && binary === undefined) {
    const ns = wrapConfinedNamespace(cmd, { cwd, root: confine.root, protect: confine.protect ?? [] })
    if (ns) return ns
  }
  if (!det.available) {
    // v94 knowwise: resolved shell (Termux has no /bin/sh — $PREFIX/bin/sh)
    return { file: resolveShell(), args: ["-c", cmd], sandboxed: false, kind: "none" }
  }
  const project = path.resolve(root || cwd || process.cwd())
  const chdir = path.resolve(cwd || project)
  const args = [
    "--unshare-pid",
    "--die-with-parent",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ]
  for (const p of RO_TRY) {
    if (exists(p)) args.push("--ro-bind-try", p, p)
  }
  const shell = resolveShell()
  // FORGE_SHELL / Termux: make sure the shell itself is visible in the sandbox
  const shellDir = path.dirname(shell)
  if (!RO_TRY.includes(shellDir) && exists(shellDir)) args.push("--ro-bind-try", shellDir, shellDir)
  const home = process.env.HOME || os.homedir()
  if (confine?.root) {
    // V6 confined run: every PROTECTED tree (the person's checkout, its git
    // dir) is read-only; the worktree and its own git admin dir (which git
    // itself must update) are writable. HOME stays as for any run — builds
    // legitimately write caches there — but a protected tree inside it is not
    // writable. Later binds win, so the order is: HOME, protected (ro), worktree.
    if (home && exists(home) && path.resolve(home) !== project) args.push("--bind", path.resolve(home), path.resolve(home))
    for (const p of confine.protect ?? []) if (p && exists(p)) args.push("--ro-bind", path.resolve(p), path.resolve(p))
    args.push("--bind", project, project)
    try {
      const link = fs.readFileSync(path.join(project, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (link && exists(link)) args.push("--bind", path.resolve(project, link), path.resolve(project, link))
    } catch { /* not a linked worktree */ }
  } else {
    args.push("--bind", project, project)
    if (home && exists(home)) {
      const resolvedHome = path.resolve(home)
      if (resolvedHome !== project) args.push("--bind", resolvedHome, resolvedHome)
    }
  }
  args.push("--chdir", chdir, shell, "-c", cmd)
  return { file: det.binary, args, sandboxed: true, kind: "bwrap" }
}

// ---------------------------------------------------------------------------
// V7 — CONFINEMENT WITHOUT BWRAP: a private mount namespace.
//
// A confined run (forge improve) where bwrap is not installed used to rely on
// the lexical shell check alone, and a script written inside the worktree
// could compute the checkout's path at runtime and write there. Where the
// kernel allows unprivileged user namespaces, util-linux `unshare` gives the
// same guarantee bwrap does for that case: inside a private mount namespace
// every protected tree is re-mounted READ-ONLY, then the worktree and its git
// admin dir are re-bound read-write. The process keeps the person's uid
// (--map-current-user), so files it creates are theirs. Probed once per
// process on a throwaway tree; any failure means "not available", never a
// half-confined run. FORGE_SANDBOX=0 turns it off like every other wrap.
// ---------------------------------------------------------------------------

let nsProbe = undefined
const NS_ARGS = ["--map-current-user", "--keep-caps", "-m", "--propagation", "private"]

/** Shell program run inside the namespace: re-mount, then exec the command.
 *  Paths and the command travel in the environment, never spliced in. */
const NS_SCRIPT = [
  "set -e",
  "IFS='\n'",
  "for p in $FORGE_NS_RO; do [ -e \"$p\" ] && mount --bind \"$p\" \"$p\" && mount -o remount,bind,ro \"$p\" \"$p\"; done",
  "for p in $FORGE_NS_RW; do [ -e \"$p\" ] && mount --bind \"$p\" \"$p\" && mount -o remount,bind,rw \"$p\" \"$p\"; done",
  "unset IFS FORGE_NS_RO FORGE_NS_RW",
  "cd \"$FORGE_NS_CWD\"",
  "exec \"$FORGE_NS_SHELL\" -c \"$FORGE_NS_CMD\"",
].join("\n")

function unshareBinary() {
  const bin = process.env.FORGE_UNSHARE || which("unshare")
  return bin && exists(bin) ? bin : null
}

/** Can this process build a confining mount namespace? Probed once, for real:
 *  a protected temp tree must refuse a write and its rw sub-tree accept one. */
export function namespaceConfinementAvailable() {
  if (nsProbe !== undefined) return nsProbe
  nsProbe = false
  if (process.platform !== "linux") return nsProbe
  const bin = unshareBinary()
  if (!bin) return nsProbe
  let dir = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nsprobe-"))
    const inner = path.join(dir, "rw")
    fs.mkdirSync(inner)
    const shell = resolveShell()
    const r = spawnSync(bin, [...NS_ARGS, shell, "-c", NS_SCRIPT], {
      env: { ...process.env, FORGE_NS_RO: dir, FORGE_NS_RW: inner, FORGE_NS_CWD: inner, FORGE_NS_SHELL: shell, FORGE_NS_CMD: `(echo x > "${dir}/blocked") 2>/dev/null; echo y > ok` },
      timeout: 5000, stdio: "ignore",
    })
    nsProbe = r.status === 0 && !fs.existsSync(path.join(dir, "blocked")) && fs.existsSync(path.join(inner, "ok"))
  } catch { nsProbe = false }
  finally { if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
  return nsProbe
}

/** Test affordance: forget the probe verdict. */
export function resetNamespaceProbe() { nsProbe = undefined }

/** argv for a confined command in a private mount namespace, or null. */
export function wrapConfinedNamespace(command, { cwd, root, protect = [] } = {}) {
  const want = process.env.FORGE_SANDBOX
  if (want === "0" || want === "false" || want === "off" || want === "no") return null
  if (!namespaceConfinementAvailable()) return null
  const project = path.resolve(root)
  const rw = [project]
  try {
    const link = fs.readFileSync(path.join(project, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (link) rw.push(path.resolve(project, link))
  } catch { /* not a linked worktree */ }
  const ro = protect.filter(Boolean).map((p) => path.resolve(p)).filter((p) => !p.includes("\n"))
  if (!ro.length) return null
  const shell = resolveShell()
  return {
    file: unshareBinary(),
    args: [...NS_ARGS, shell, "-c", NS_SCRIPT],
    env: { FORGE_NS_RO: ro.join("\n"), FORGE_NS_RW: rw.join("\n"), FORGE_NS_CWD: path.resolve(cwd || project), FORGE_NS_SHELL: shell, FORGE_NS_CMD: String(command ?? "") },
    sandboxed: true,
    kind: "namespace",
  }
}
