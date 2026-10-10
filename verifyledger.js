/**
 * forge — structured verification ledger (v21 hardened, zero dependencies)
 *
 * verify.js already proves a MUTATION landed (file exists, parses, the
 * replacement text is present) with local, side-effect-free checks. This
 * module is the task-level counterpart: it collects EVIDENCE that the OBJECTIVE
 * holds, not that a command merely ran.
 *
 * Hardening (v23):
 *  - every verification record contains taskId, nodeId, segmentId,
 *    verificationEpoch, affectedFiles, scope, type, passed, exitCode,
 *    output/evidence, timestamp
 *  - failures evaluated against correct scope: unrelated Node A failure
 *    must not block Node B; whole-project/regression may have broader scope
 *  - deterministic invalidation after mutations
 *  - verification is a hard gate: missing/failed/unavailable blocks COMPLETED
 */

import { loadBuiltin } from "./lazybuiltin.js"
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
import path from "node:path"
import { dockerInvocation, normalizeCommand } from "./checkcmd.js"
import { exitMarkerCode } from "./cmdout.js"

export const VTYPE = {
  SYNTAX: "syntax",
  FOCUSED_TEST: "focused_test",
  REGRESSION_TEST: "regression_test",
  BUILD: "build",
  RUNTIME: "runtime",
  INTEGRATION: "integration",
  SECURITY: "security",
  ACCEPTANCE: "acceptance",
  // v98 shipwise — build artifacts as first-class evidence: a build that
  // exits 0 is a claim, the artifact on disk (dist output, APK, docker image
  // file, migration result) is the evidence. Records are produced from
  // observed artifacts (runtimesession.artifactRuntimeEvidence) and satisfy
  // the runtime-validation requirement; they never enter RISK_PROFILE's
  // blanket lists — applicability is adapter-gated at the enforcement site
  // (never-invent: a plain JS repo is never asked for an APK).
  ARTIFACT: "artifact",
}

export const RISK_PROFILE = {
  trivial: [VTYPE.SYNTAX],
  low: [VTYPE.SYNTAX],
  medium: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST],
  high: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD],
  critical: [VTYPE.SYNTAX, VTYPE.FOCUSED_TEST, VTYPE.REGRESSION_TEST, VTYPE.BUILD, VTYPE.SECURITY],
}

export const VERIFICATION_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PASSED: "PASSED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  UNKNOWN: "UNKNOWN",
  NOT_AVAILABLE: "NOT_AVAILABLE",
  // P0: evidence that exists but was produced before the artifact changed
  STALE: "STALE",
  // P0: no evidence was produced for a required type
  MISSING: "MISSING",
}

// ---------------------------------------------------------------------------
// What evidence CAN exist for a change (never invent a requirement)
// ---------------------------------------------------------------------------
//
// RISK_PROFILE asks every medium-risk change for a syntax check and a focused
// test. For `create hello.txt containing hi` neither can exist — a text file
// has no syntax checker and the project had no tests — so the controller
// asked for them 32 segments in a row (134 model calls) and ended WAITING
// with the file written in the first. The single loop finished the same task
// in 2 calls. A requirement no check can ever meet is not rigour; it is a
// loop. So a required type is dropped only when it provably cannot apply, and
// the reason is reported with the status (never silently):
//   - only documentation / text / images changed → no syntax, test or build
//   - only data/config-without-a-checker changed  → no syntax check
//   - the project has no test runner              → no test evidence
//   - the project has no build                    → no build evidence
// When in doubt a type stays required.

/** Prose and assets: nothing parses, tests or builds them. */
const PROSE_EXT = new Set([".txt", ".text", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".asciidoc", ".org", ".rtf", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf"])
/** Files with no syntax checker a check command could be recognised as. */
const NO_SYNTAX_EXT = new Set([...PROSE_EXT, ".csv", ".tsv", ".env", ".ini", ".cfg", ".conf", ".properties", ".lock", ".svg"])
const PROSE_NAMES = /^(readme|license|licence|changelog|changes|authors|contributors|notice|copying|todo)(\.[^/]*)?$/i

const extOfFile = (f) => {
  const b = path.basename(String(f ?? ""))
  if (PROSE_NAMES.test(b)) return ".txt"
  const i = b.lastIndexOf(".")
  return i > 0 ? b.slice(i).toLowerCase() : ""
}

const projectFacts = new Map() // cwd → { at, tests, build }
const PROJECT_FACTS_MS = 5000   // the run may add tests or a build mid-task

/** Does this project have a test runner / a build? Conservative: any sign counts. */
export function projectVerificationFacts(cwd = process.cwd()) {
  const hit = projectFacts.get(cwd)
  if (hit && Date.now() - hit.at < PROJECT_FACTS_MS) return hit
  const has = (rel) => { try { fs.statSync(path.join(cwd, rel)); return true } catch { return false } }
  const read = (rel) => { try { return fs.readFileSync(path.join(cwd, rel), "utf8").slice(0, 200_000) } catch { return "" } }
  let tests = false, build = false
  const pkgText = read("package.json")
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText)
      const sc = pkg.scripts ?? {}
      if (typeof sc.test === "string" && !/no test specified/i.test(sc.test)) tests = true
      if (Object.keys(sc).some((k) => /^test[:\w-]*$/.test(k) && k !== "test")) tests = true
      if (typeof sc.build === "string" || typeof sc.compile === "string" || typeof sc.typecheck === "string") build = true
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      if (["jest", "vitest", "mocha", "ava", "tap", "jasmine", "@playwright/test", "cypress", "uvu"].some((d) => d in deps)) tests = true
      if (["typescript", "webpack", "vite", "rollup", "esbuild", "@babel/core", "parcel", "tsup"].some((d) => d in deps)) build = true
    } catch { tests = true; build = true } // unreadable manifest: assume both
  }
  if (["pytest.ini", "tox.ini", "conftest.py", "noxfile.py", ".rspec", "phpunit.xml", "phpunit.xml.dist", "karma.conf.js", "jest.config.js", "jest.config.ts", "vitest.config.ts", "vitest.config.js"].some(has)) tests = true
  if (/\bpytest\b|\[tool\.pytest/.test(read("pyproject.toml") + read("setup.cfg"))) tests = true
  if (["Cargo.toml", "go.mod", "build.gradle", "build.gradle.kts", "pom.xml", "CMakeLists.txt", "mix.exs"].some(has)) { tests = true; build = true }
  if (has("tsconfig.json")) build = true
  const mk = read("Makefile") + read("makefile")
  if (/^test\s*:/m.test(mk) || /^check\s*:/m.test(mk)) tests = true
  if (mk.trim()) build = true
  if (!tests) {
    // a shallow look for test files or folders (bounded)
    const SKIP = new Set(["node_modules", ".git", ".forge", "dist", "build", "vendor", ".venv", "venv", "target", "__pycache__"])
    const TESTFILE = /(^test_.*\.py$|_test\.(py|go)$|[._-](test|spec)\.[cm]?[jt]sx?$|Test\.java$|_spec\.rb$)/i
    let seen = 0
    const walk = (dir, depth) => {
      if (tests || depth > 3 || seen > 3000) return
      let ents = []
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (tests || ++seen > 3000) return
        if (e.isDirectory()) {
          if (SKIP.has(e.name)) continue
          if (/^(tests?|__tests__|spec)$/i.test(e.name)) { tests = true; return }
          walk(path.join(dir, e.name), depth + 1)
        } else if (TESTFILE.test(e.name)) { tests = true; return }
      }
    }
    walk(cwd, 0)
  }
  const out = { at: Date.now(), tests, build }
  projectFacts.set(cwd, out)
  return out
}

/**
 * Which required evidence types cannot apply to these changed files in this
 * project: [{ type, reason }]. Empty when in doubt (or nothing changed).
 */
export function inapplicableEvidence(required = [], changedFiles = [], { cwd = process.cwd(), ran = null } = {}) {
  // `ran`: evidence types this task has already produced (any record, even a
  // stale one). A test that already ran here proves the project has tests,
  // whatever its manifest says.
  const already = ran instanceof Set ? ran : new Set(ran ?? [])
  const files = (changedFiles ?? []).map(String).filter(Boolean)
  if (!files.length || !required.length) return []
  const exts = files.map(extOfFile)
  const names = files.slice(0, 4).map((f) => path.basename(f)).join(", ") + (files.length > 4 ? ` (+${files.length - 4})` : "")
  const out = []
  const allProse = exts.every((e) => PROSE_EXT.has(e))
  if (allProse) {
    for (const t of required) if (t !== VTYPE.ACCEPTANCE) out.push({ type: t, reason: `only documentation, text or image files changed (${names}) — nothing parses, tests or builds them` })
    return out
  }
  const facts = projectVerificationFacts(cwd)
  for (const t of required) {
    if (t === VTYPE.SYNTAX && exts.every((e) => NO_SYNTAX_EXT.has(e))) out.push({ type: t, reason: `no syntax checker exists for the changed files (${names})` })
    else if ((t === VTYPE.FOCUSED_TEST || t === VTYPE.REGRESSION_TEST) && !facts.tests && !already.has(VTYPE.FOCUSED_TEST) && !already.has(VTYPE.REGRESSION_TEST)) out.push({ type: t, reason: "this project has no tests or test runner — no test can cover the change" })
    else if (t === VTYPE.BUILD && !facts.build && !already.has(VTYPE.BUILD)) out.push({ type: t, reason: "this project has no build step" })
  }
  return out
}

// Node's own runner (`node --test …`), `bun test` and `deno test` are test
// runs too — before, `node --test test/x.test.js` was classified RUNTIME, so a
// project tested that way (forge itself) could never show test evidence.
const TEST_CMD = /(^|[\s/])(test|jest|vitest|mocha|pytest|cargo[ _]test|go[ _]test|rspec|unittest)([\s]|$)|\bnode\s+(?:--?[\w-]+(?:=\S+)?\s+)*--test\b|\b(?:bun|deno)\s+test\b/i
const BUILD_CMD = /\b(build|tsc|webpack|vite build|cargo build|make|compile|babel)\b/i
const SECURITY_CMD = /\b(audit|npm audit|snyk|trivy|semgrep|bandit|gosec|lint)\b/i

// v129: was classifyCommand — shellguard.js owns that name for SHELL SAFETY
// and seven modules import it. This asks whether a command is a check.
export function classifyCheckCommand(command = "") {
  const c = String(command)
  if (SECURITY_CMD.test(c)) return VTYPE.SECURITY
  if (/\bnode\s+--check\b|\b(node|tsc|python3?|ruby)\s+-c\b|--syntax[ -]?check|syntax check/i.test(c)) return VTYPE.SYNTAX
  if (BUILD_CMD.test(c)) return VTYPE.BUILD
  if (TEST_CMD.test(c)) {
    const hasTarget = /[\w/.-]+(?:spec|test)\.\w+|::|(-k\s)|(-t\s)|(--grep)|(-m\s)|(run\s+[\w/.-]+)/i.test(c)
    const bare = /^\s*(npm|pnpm|yarn|bun|cargo|go)\s+(run\s+)?test\s*$/.test(c.trim())
    if (hasTarget && !bare) return VTYPE.FOCUSED_TEST
    return VTYPE.REGRESSION_TEST
  }
  return VTYPE.RUNTIME
}

/**
 * P1 — UNKNOWN IS NOT SUCCESS.
 *
 * An exit status we could not observe is NOT exit status 0. Before this fix a
 * command that was killed by a signal, OOM-killed, or that never reported a
 * code at all was recorded as `exitCode: 0` ⇒ `passed: true`, so a segfaulting
 * test run satisfied the verification gate.
 *
 * `UNKNOWN_EXIT_CODE` is `null`: it is falsy AND distinct from 0, so the strict
 * `exitCode === 0` success test can never be satisfied by it.
 */
export const UNKNOWN_EXIT_CODE = null

/**
 * Explicit failure shapes. Exit status is authoritative when available; these
 * patterns only classify a result whose status is unknown, and they never
 * upgrade an unknown status to success.
 */
export const FAILURE_SHAPES = [
  // most specific first: a signal is a crash, not a generic failure
  { kind: "signal", test: /signal: (SIG)?(SEGV|ABRT|BUS|FPE|ILL|KILL)|segmentation fault|segfault|core dumped|\bsigsegv\b|\bsigabrt\b/i },
  { kind: "killed", test: /\[killed[:\s]|process was killed|SIGKILL|(^|\s)Killed(\s|$)/i },
  { kind: "timeout", test: /timed out|timeout after|ETIMEDOUT|TimeoutError/i },
  { kind: "oom", test: /out of memory|JavaScript heap out of memory|Cannot allocate memory|MemoryError|OOMKilled/i },
  { kind: "panic", test: /\bpanic:|panicked at|internal error:|fatal error:|UnhandledPromiseRejection|unhandled rejection/i },
  { kind: "permission_denied", test: /permission denied|EACCES|not permitted|Operation not permitted|403 forbidden/i },
  { kind: "not_found", test: /command not found|not found:|\bnot found\b|ENOENT|No such file or directory|module not found|can'?t (find|open)/i },
  { kind: "no_tests", test: /no tests? (found|ran|executed|matched)|no test files|0 tests? (found|ran|executed)|No test suite/i },
  { kind: "build_failure", test: /BUILD FAILED|build failed|compile error|compilation failed|error TS\d+|error\[E\d+\]|SyntaxError:|tsc.*error/i },
  { kind: "test_failure", test: /tests? failed|failures:|AssertionError|FAILED\s|\bFAIL\b|✗|✘|Expected .*Received|1\)\s/i },
  { kind: "generic_failure", test: /\b(failed|failure|fatal|error|exception|traceback)\b/i },
]

/**
 * A runner's summary that counts ZERO failures is the opposite of a failure:
 * `node --test` prints "# fail 0", cargo "0 failed", maven "Failures: 0".
 * `\bFAIL\b` / `\bfailed\b` matched those words and a green run was recorded
 * FAILED. Only zero counts are removed — "10 failed" or "# fail 3" stay.
 */
function withoutZeroCounts(s) {
  return s
    // TAP summaries (`# fail 0`) — on their own line, or inside a tail that
    // was collapsed to one line ("# pass 1 # fail 0 # cancelled 0 …")
    .replace(/(^|[ \t])#[ \t]*(fail|failed|failures?|errors?|cancelled)[ \t]+0(?![\w.])/gim, "$1")
    .replace(/(^|[^\w.])0[ \t]+(?:tests?[ \t]+|specs?[ \t]+|suites?[ \t]+)?(failed|failures?|failing|errors?|errored)\b/gi, "$1")
    .replace(/\b(failed|failures?|errors?)[ \t]*[:=][ \t]*0(?![\w.])/gi, "")
}

/** Classify a result string when the exit status is unknown. */
export function detectFailureShape(text = "") {
  const out = withoutZeroCounts(String(text ?? ""))
  for (const shape of FAILURE_SHAPES) {
    if (shape.test.test(out)) return shape.kind
  }
  return null
}

/**
 * Resolve an exit status from a command result. Returns a number, or
 * `UNKNOWN_EXIT_CODE` (null) when the status genuinely cannot be observed.
 */
export function resolveExitCode(opts = {}, text = "") {
  const out = String(text ?? "")
  if (Number.isInteger(opts.exitCode)) return opts.exitCode
  if (Number.isInteger(opts.exit_code)) return opts.exit_code
  // the LAST marker: runBash appends it after the command's own output
  const fromText = exitMarkerCode(out)
  if (fromText != null) return fromText
  if (/timed out|ETIMEDOUT|TimeoutError/i.test(out)) return 124
  // a crash is observable: 128 + signal. "segmentation fault" is SIGSEGV even
  // when the harness never prints a numeric status.
  const signal = /\[signal: ([A-Z]+)\]|signal: (SIG)?(SEGV|ABRT|BUS|FPE|ILL)|segmentation fault|segfault|core dumped/i.exec(out)
  if (signal) return 128 + 11 // 128 + SIGSEGV — a signal is never success
  if (/\[killed[:\s]|\bKilled\b/i.test(out)) return 137 // 128 + SIGKILL
  return UNKNOWN_EXIT_CODE
}

export function evaluateVerification(command, result, opts = {}) {
  const out = String(result ?? "")
  const resolved = resolveExitCode(opts, out)
  const exitCode = resolved
  const timedOut = exitCode === 124 || /timed out after|TimeoutError/i.test(out)
  const truncated = opts.truncated === true
  const killed = opts.killed === true || opts.signal === "SIGKILL"
  const type = opts.type || classifyCheckCommand(command)

  const observed = exitCode !== UNKNOWN_EXIT_CODE
  const shape = detectFailureShape(out)
  // Success requires RELIABLE evidence: an OBSERVED exit status of 0, no
  // timeout, no truncation, no kill, and no failure shape in the output.
  // Unknown / truncated / killed ⇒ not passed. Never infer PASS from tails.
  const passed = observed && exitCode === 0 && !timedOut && !shape && !truncated && !killed

  const evidence = extractEvidence(out, type)

  // P1 scoping: every record contains required fields
  return withAliases({
    verification_id: opts.verification_id || opts.verificationId || `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    verificationId: null, // convenience alias, filled in just below
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? opts.run_id ?? null,
    nodeId: opts.nodeId ?? null,
    segmentId: opts.segmentId ?? null,
    verificationEpoch: opts.verificationEpoch ?? opts.verification_epoch ?? 0,
    affectedFiles: (opts.affectedFiles ?? opts.affected_files ?? []).map(String),
    affected_files: (opts.affectedFiles ?? opts.affected_files ?? []).map(String), // backward compat
    // `scope` is the EVIDENCE BREADTH (focused / regression / syntax / …);
    // `identityScope` says WHO the evidence belongs to: a node or the task.
    scope: opts.scope ?? (type === VTYPE.FOCUSED_TEST ? "focused" : type === VTYPE.REGRESSION_TEST ? "regression" : type),
    identityScope: opts.identityScope ?? (opts.nodeId ? "node" : "task"),
    type,
    passed,
    exitCode,
    exit_code: exitCode, // backward compat
    exitCodeKnown: observed, // P1: false ⇒ the status was never observed
    failureShape: shape, // timeout | signal | oom | killed | panic | …
    output: out.slice(0, 2000),
    evidence,
    timestamp: opts.timestamp ?? Date.now(),
    confidence: confidenceFor(type, passed, out, observed),
    timed_out: timedOut,
    truncated: truncated === true,
    killed: killed === true,
    command: String(command).slice(0, 300),
    duration: opts.duration ?? null,
    // v21.1 P1 — provenance: where/when the check ran and what it covered.
    // `stale` is set at record time when the producing run ALREADY wrote files
    // after the check: such evidence never verified those files.
    cwd: opts.cwd ?? null,
    env: opts.env ?? null,
    repoState: opts.repoState ?? null,
    stdoutTail: opts.stdoutTail != null ? String(opts.stdoutTail).slice(-2000) : null,
    filesWrittenAfter: (opts.filesWrittenAfter ?? []).map(String).slice(0, 50),
    // V5: a check that ran inside a container says WHICH container — only
    // present on docker/podman invocations (see dockerEvidence)
    ...dockerField(command, opts),
  })
}

function dockerField(command, opts) {
  const d = opts.docker !== undefined ? opts.docker : dockerEvidence(command, { inspect: opts.dockerInspect ?? null })
  return d ? { docker: d } : {}
}

// ---------------------------------------------------------------------------
// V5 — DOCKER / EXTERNAL EVIDENCE
//
// A green `docker run node:20 npm test` says the tests passed in SOME image
// called node:20 — a tag moves, so the record alone cannot reproduce it. When
// a check runs through docker (or podman), the record says what is known about
// the environment: the image and its content digest, the container identity,
// the command run inside it, the NAMES of the environment variables it was
// given (never their values), platform and workdir (the invocation is parsed
// by checkcmd.dockerInvocation, the one command-shape authority). The digest is read from
// the local engine (`image inspect`, bounded) and only when that answers;
// `reproducible` is true only when a content digest is known, and the
// reason says why not otherwise. Docker is never required: no engine, no digest,
// same pass/fail verdict.
// ---------------------------------------------------------------------------

/**
 * The execution environment of a docker/podman check, or null when the
 * command did not run through a container engine. The ledger runs no
 * processes: the engine query is INJECTED (`inspect(engine, args)` → stdout
 * string, or { error }) — runtimesession.engineInspect is the one
 * implementation. Without it the static facts are still reported.
 */
export function dockerEvidence(command = "", { inspect = null } = {}) {
  const probe = typeof inspect === "function"
  const engineInspect = (engine, args) => { try { return inspect(engine, args) } catch (e) { return { error: String(e?.message ?? e).slice(0, 120) } } }
  const inv = dockerInvocation(command)
  if (!inv) return null
  const ev = {
    engine: inv.engine, compose: inv.compose, subcommand: inv.subcommand,
    image: inv.image, digest: null, imageId: null,
    container: inv.container, containerId: null, service: inv.service ?? null,
    command: inv.command ? String(inv.command).slice(0, 200) : null,
    envNames: inv.envNames, platform: inv.platform, workdir: inv.workdir,
    reproducible: false, reason: null,
  }
  if (!inv.certain) {
    // never report a guessed identity: an unknown option may have eaten the image name
    ev.image = null; ev.container = null; ev.service = null; ev.command = null
    ev.reason = "the invocation uses options this parser does not know — image/container identity is uncertain"
    return ev
  }
  const pinnedDigest = String(inv.image ?? "").match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null
  if (pinnedDigest) ev.digest = pinnedDigest
  if (probe && inv.image && !inv.compose && !pinnedDigest) {
    const r = engineInspect(inv.engine, ["image", "inspect", "--format", "{{.Id}}|{{join .RepoDigests \",\"}}", inv.image])
    if (typeof r === "string" && r) {
      const [id, digests] = r.split("|")
      ev.imageId = id || null
      ev.digest = (digests ?? "").split(",").find((d) => /@sha256:[0-9a-f]{64}$/.test(d)) ?? null
    } else ev.reason = `image digest unavailable (${r?.error ?? "no answer from the engine"})`
  } else if (probe && inv.container && !inv.compose) {
    const r = engineInspect(inv.engine, ["inspect", "--format", "{{.Id}}|{{.Config.Image}}|{{.Image}}", inv.container])
    if (typeof r === "string" && r) {
      const [cid, img, iid] = r.split("|")
      ev.containerId = cid || null
      ev.image = img || null
      ev.imageId = iid || null
      const d = ev.imageId ? engineInspect(inv.engine, ["image", "inspect", "--format", "{{join .RepoDigests \",\"}}", ev.imageId]) : null
      if (typeof d === "string") ev.digest = d.split(",").find((x) => /@sha256:[0-9a-f]{64}$/.test(x)) ?? null
    } else ev.reason = `container identity unavailable (${r?.error ?? "no answer from the engine"})`
  }
  // reproducible only by a content digest (RepoDigests / a pinned @sha256);
  // a bare local image id names the exact image on this machine, which is
  // said, and nothing more
  ev.reproducible = Boolean(ev.digest)
  if (ev.reproducible) ev.reason = null
  else if (/^sha256:[0-9a-f]{64}$/.test(String(ev.imageId ?? ""))) ev.reason = "local image id known, no registry digest — the exact image is identified on this machine only"
  if (!ev.reproducible && !ev.reason) {
    ev.reason = inv.compose
      ? "compose service — the image is resolved from the compose file, not recorded here"
      : !probe ? "engine not queried — image content digest unknown (a tag can move)"
      : "image content digest unknown (a tag can move)"
  }
  return ev
}

/** Normalise a finished record (aliases) before it is stored. */
function withAliases(rec) {
  rec.verificationId = rec.verification_id
  return rec
}

function confidenceFor(type, passed, out, observed = true) {
  if (!observed) return "none" // unknown status carries no confidence at all
  if (!passed) return "high"
  if (/\b(\d+)\s*(tests?|passed|ok|suites?)\b/i.test(out)) return "high"
  if (type === VTYPE.BUILD || type === VTYPE.REGRESSION_TEST) return "medium"
  return "medium"
}

function extractEvidence(out, type) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
  const summary = lines.find((l) => /\b(passed|failed|ok|success|compiled|built|test|suite)\b/i.test(l))
  const pick = summary || lines[lines.length - 1] || ""
  return String(pick).slice(0, 300)
}

export function createLedger({ dockerInspect = null } = {}) {
  const records = []
  let epoch = 0

  const add = (rec, { invalidate = false } = {}) => {
    epoch++
    rec.verificationEpoch = rec.verificationEpoch ?? epoch
    rec.verification_epoch = rec.verificationEpoch
    if (invalidate && rec.affectedFiles?.length) {
      for (const r of records) {
        if (r.affectedFiles?.some((f) => rec.affectedFiles.includes(f)) || r.affected_files?.some((f) => rec.affectedFiles.includes(f))) {
          r.invalidated = true
          r.invalidatedAt = Date.now()
          r.invalidatedBy = rec.verification_id
        }
      }
    }
    if (rec.passed) {
      for (const r of records) {
        // only a PASS of the SAME check clears its failure: a green
        // `vitest run src/unrelated.test.js` says nothing about a red
        // `vitest run src/p.test.js` of the same ledger type (both are
        // focused tests and their scopes overlap whenever the controller
        // scopes every check to every changed file)
        if (r.type === rec.type && !r.passed && sameScope(r, rec) && sameCheck(r, rec)) {
          r.superseded = true
          r.supersededBy = rec.verification_id
        }
      }
    }
    records.push(rec)
    return rec
  }

  const sameCheck = (a, b) => {
    const id = (x) => { try { return normalizeCommand(String(x.command ?? "")) } catch { return String(x.command ?? "").trim() } }
    const ia = id(a), ib = id(b)
    return Boolean(ia) && ia === ib
  }

  const sameScope = (a, b) => {
    const af = (a.affectedFiles ?? a.affected_files ?? []).map(norm2)
    const bf = (b.affectedFiles ?? b.affected_files ?? []).map(norm2)
    if (!af.length || !bf.length) return true
    return af.some((f) => bf.includes(f)) || bf.some((f) => af.includes(f))
  }

  const recordCommand = (command, result, opts = {}) => {
    const rec = evaluateVerification(command, result, {
      dockerInspect,
      ...opts,
      verificationEpoch: opts.verificationEpoch ?? ++epoch,
    })
    // Evidence produced BEFORE later writes in the same run is stale for the
    // files those writes touched. A passing record whose scope intersects the
    // later writes (or a shell write with unknown target) is invalidated at
    // once — it was true of an artifact that no longer exists. Failures are
    // kept: a failure is a fact until a later PASS supersedes it.
    if (rec.passed && rec.filesWrittenAfter?.length) {
      const later = new Set(rec.filesWrittenAfter.map(norm2))
      const unknownTarget = rec.filesWrittenAfter.some((f) => /^\(shell write\)$/.test(f))
      const scope = (rec.affectedFiles ?? []).map(norm2)
      const hit = unknownTarget || !scope.length || scope.some((f) => later.has(f) || [...later].some((l) => l.endsWith("/" + f) || f.endsWith("/" + l)))
      if (hit) { rec.invalidated = true; rec.invalidatedAt = Date.now(); rec.invalidatedBy = "writes-after-check"; rec.staleReason = "files were written after this check ran" }
    }
    return add(rec, { invalidate: false })
  }

  const invalidate = (files = []) => {
    const set = new Set(files.map(String).map(norm2))
    let n = 0
    for (const r of records) {
      if (r.invalidated) continue
      const affected = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      if (affected.some((f) => set.has(f))) {
        r.invalidated = true
        r.invalidatedAt = Date.now()
        n++
      }
    }
    return n
  }

  /**
   * Files changed AFTER existing evidence: bump the epoch and invalidate the
   * PASSING records whose scope covers them (or that have no scope at all —
   * project-wide evidence is stale once anything changes). Returns the count.
   */
  const touch = (files = []) => {
    const set = new Set(files.map(String).map(norm2))
    if (!set.size) return 0
    epoch++
    let n = 0
    for (const r of records) {
      if (r.invalidated || !r.passed) continue
      const affected = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      const covers = !affected.length || affected.some((f) => set.has(f) || [...set].some((c) => c.endsWith("/" + f) || f.endsWith("/" + c)))
      if (covers) { r.invalidated = true; r.invalidatedAt = Date.now(); r.invalidatedBy = "touch"; r.staleReason = "covered file changed after this check"; n++ }
    }
    return n
  }

  const validRecords = () => records.filter((r) => !r.invalidated && !r.superseded)

  function norm2(f) { return String(f ?? "").replace(/^\.\//, "").replace(/^\/+/, "") }

  /**
   * Is the task verified for its risk level?
   * Scoped: failures in unrelated nodes do not block.
   * Whole-project/regression failures may have broader scope.
   */
  const status = (risk = "medium", changedFiles = [], { nodeId = null, verificationEpoch = null, cwd = null } = {}) => {
    const profile = RISK_PROFILE[risk] ?? RISK_PROFILE.medium
    // only evidence that CAN exist for these files is required; what cannot
    // is reported as notApplicable, with its reason (inapplicableEvidence).
    // Judged only for a caller that names the project (`cwd`): the answer
    // depends on that project, never on whatever directory the process is in.
    let notApplicable = []
    if (cwd) { try { notApplicable = inapplicableEvidence(profile, changedFiles, { cwd, ran: new Set(records.map((r) => r.type)) }) } catch { notApplicable = [] } }
    const dropped = new Set(notApplicable.map((x) => x.type))
    const required = profile.filter((t) => !dropped.has(t))
    const changed = changedFiles.map(norm2)
    const byType = new Map()
    const scopedFailures = []
    const stale = []

    for (const r of validRecords()) {
      // --- P0 ATTRIBUTION -------------------------------------------------
      // Evidence produced by ANOTHER node is not evidence for this one: the
      // fact that node A's tests passed says nothing about node B's change.
      // (A record with no nodeId is task-level evidence and applies to all.)
      const otherNode = Boolean(nodeId && r.nodeId && r.nodeId !== nodeId)
      // --- P0 EPOCH -------------------------------------------------------
      // Evidence from an earlier verification epoch is STALE: the artifact has
      // been touched since it was produced.
      const isStale = verificationEpoch != null && Number(r.verificationEpoch ?? 0) < Number(verificationEpoch)
      if (isStale) stale.push(r)

      if (!r.passed) {
        const rFiles = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
        const covers = !rFiles.length || !changed.length || rFiles.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
        if (covers && (!otherNode || !r.nodeId)) scopedFailures.push(r)
        else if (covers && otherNode && r.scope === "regression") scopedFailures.push(r)
        continue
      }
      if (otherNode || isStale) continue
      const covered = (r.affectedFiles ?? r.affected_files ?? []).map(norm2)
      const covers = !covered.length || !changed.length || covered.some((f) => changed.includes(f) || changed.some((c) => c.endsWith("/" + f) || f.endsWith("/" + c) || c === f))
      if (!covers) continue
      byType.set(r.type, r)
    }

    const satisfied = []
    const missing = []
    for (const t of required) (byType.has(t) ? satisfied : missing).push(t)
    const anyFailure = scopedFailures.length > 0
    const ok = missing.length === 0 && !anyFailure

    let verificationStatus
    // nothing could be checked: not "verified" — NOT_AVAILABLE, with why
    if (required.length === 0 && profile.length > 0 && !anyFailure) verificationStatus = VERIFICATION_STATUS.NOT_AVAILABLE
    else if (required.length === 0) verificationStatus = VERIFICATION_STATUS.NOT_REQUIRED
    else if (ok) verificationStatus = VERIFICATION_STATUS.PASSED
    else if (anyFailure) verificationStatus = VERIFICATION_STATUS.FAILED
    else if (stale.length > 0 && missing.length > 0) verificationStatus = VERIFICATION_STATUS.STALE
    else if (missing.length > 0) verificationStatus = VERIFICATION_STATUS.PENDING
    else verificationStatus = VERIFICATION_STATUS.UNKNOWN

    return {
      ok,
      missing,
      satisfied,
      notApplicable,
      anyFailure,
      failures: scopedFailures,
      stale,
      status: verificationStatus,
      // the ledger records that satisfied this status — what a "verified"
      // claim downstream (engmemory.onTaskCompleted) can point at
      verificationIds: satisfied.map((t) => byType.get(t)?.verification_id).filter(Boolean),
      evidence: validRecords().map((r) => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        segmentId: r.segmentId,
        verificationEpoch: r.verificationEpoch,
        type: r.type,
        passed: r.passed,
        scope: r.scope,
        affectedFiles: r.affectedFiles,
        exitCode: r.exitCode,
        evidence: r.evidence,
        timestamp: r.timestamp,
        invalidated: !!r.invalidated,
        ...(r.docker ? { docker: r.docker } : {}),
      })),
      // v125: the ledger already records `failureShape: "timeout"` and
      // `timed_out` on every record and then described all of them the same
      // way — "a verification command FAILED … repair before completing".
      // A command killed at its time budget did not fail and there is nothing
      // to repair; saying so sent runs off to fix working code. Still blocks
      // (a timeout is not evidence), just asks for the right work.
      reason: ok
        ? (verificationStatus === VERIFICATION_STATUS.NOT_AVAILABLE
          ? `not verified — no automated check applies: ${notApplicable.map((x) => x.reason).filter((v, i, a) => a.indexOf(v) === i).join("; ")}`
          : `verified for risk=${risk} (${satisfied.join("+")})${notApplicable.length ? `; not applicable: ${notApplicable.map((x) => x.type).join(", ")}` : ""}`)
        : anyFailure
          ? (scopedFailures.every((f) => f.failureShape === "timeout" || f.timed_out === true || f.exitCode === 124)
            ? `a verification command did not finish inside its time budget (${scopedFailures.map(f => f.type).join(", ")}) — narrow the check or raise its timeout; it did not fail`
            : `a verification command FAILED in scope: ${scopedFailures.filter(f => !(f.failureShape === "timeout" || f.timed_out === true || f.exitCode === 124)).map(f => f.type).join(", ") || scopedFailures.map(f => f.type).join(", ")} — repair before completing`)
          : `insufficient evidence for risk=${risk}: missing ${missing.join(", ")}`,
    }
  }

  const serialize = () => records.slice(-100)
  const load = (arr) => { if (Array.isArray(arr)) { records.push(...arr.slice(-100)); epoch = Math.max(epoch, ...arr.map(r => r.verificationEpoch ?? r.verification_epoch ?? 0)) } }

  return { add, recordCommand, invalidate, touch, status, records: validRecords, all: () => records.slice(), serialize, load, get epoch() { return epoch } }
}

// ---------------------------------------------------------------------------
// P0 — FINAL RISK RECALCULATION
// ---------------------------------------------------------------------------
//
// Planning risk (`riskForChange`, above) is computed from the OBJECTIVE before
// anything happened: "add a comment" is trivial. Final risk is computed from
// what the agent ACTUALLY did — the changed/created/deleted files, the symbols
// it touched and the mutating commands it ran — and it is the risk that must
// drive final verification.
//
// The bug this fixes: initialRisk = trivial ⇒ no verification required ⇒
// COMPLETED, even though the run went on to edit seven files, package.json and
// an authentication module. Final risk is therefore monotonic with the initial
// risk: it can raise it, never lower it.

export const RISK_ORDER = { trivial: 0, low: 1, medium: 2, high: 3, critical: 4 }

/** Path shapes that escalate risk no matter what the objective said. */
export const SENSITIVE_PATH_RULES = [
  { test: /(^|\/)(auth|authentication|authorization|session|login|permission|rbac|oauth|jwt|credential|token)[^/]*\.(js|mjs|cjs|ts|tsx|py|go|rs|java|rb)$/i, risk: "critical", signal: "authentication/authorization module" },
  { test: /(^|\/)(crypto|crypt|password|secret|signing|keys?|certificate|tls|ssl)[^/]*\.(js|mjs|ts|py|go|rs|rb)$/i, risk: "critical", signal: "cryptography/secret material" },
  { test: /(^|\/)\.env(\.|$)|(^|\/)(\.aws|\.ssh|\.gnupg)\/|(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|\.htpasswd)$/i, risk: "critical", signal: "credential file" },
  { test: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|requirements.*\.txt|pyproject\.toml|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|pom\.xml|build\.gradle|composer\.(json|lock))$/i, risk: "high", signal: "dependency manifest" },
  { test: /(^|\/)(migrations?|schema|prisma|knexfile|seed(er)?s?)\//i, risk: "high", signal: "database migration/schema" },
  { test: /\.(sql|prisma)$/i, risk: "high", signal: "database schema" },
  { test: /(^|\/)\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose[^/]*|nginx\.conf|\.gitlab-ci\.yml|Jenkinsfile|Makefile)$/i, risk: "high", signal: "build/CI/deployment configuration" },
  { test: /(^|\/)(tsconfig[^/]*|vite\.config\.[jt]s|webpack\.config\.[jt]s|rollup\.config\.[jt]s|next\.config\.[jt]s|jest\.config\.[jt]s|vitest\.config\.[jt]s|\.eslintrc[^/]*|\.babelrc)$/i, risk: "high", signal: "toolchain configuration" },
  { test: /(^|\/)(install\.sh|setup\.[sh|py]|deploy[^/]*\.(sh|py|js)|terraform[^/]*\.tf|.*\.tf)$/i, risk: "high", signal: "install/deploy script" },
  { test: /(^|\/)(security|sandbox|shellguard|netguard|safepath|permissions?|policy)[^/]*\.(js|mjs|ts|py|go|rs)$/i, risk: "high", signal: "security-sensitive module" },
]

/** Mutating commands whose execution escalates risk (tool/command mutations). */
const MUTATING_COMMAND_RULES = [
  { test: /\b(npm|pnpm|yarn|bun|pip|poetry|cargo|gem|apt-get|brew)\s+(install|add|remove|uninstall|update|upgrade)\b/i, risk: "high", signal: "package manager mutation" },
  { test: /\bgit\s+(push|commit|reset|checkout|merge|rebase|stash|cherry-pick|revert)\b/i, risk: "medium", signal: "git history mutation" },
  { test: /\b(docker|kubectl|helm|terraform|ansible)\b/i, risk: "high", signal: "infrastructure mutation" },
  { test: /\b(migrate|migration|db:push|prisma\s+migrate|alembic)\b/i, risk: "high", signal: "database mutation" },
  { test: /\brm\s+-r|\brm\s+-f|\bmv\s+|\bdd\s+|\bchmod\s+|\bchown\s+/i, risk: "medium", signal: "destructive filesystem command" },
  { test: /\b(curl|wget|nc|ssh|scp|rsync)\b/i, risk: "medium", signal: "network/remote command" },
]

const SYMBOL_RULES = [
  { test: /^(authenticate|authorize|verifyToken|signJwt|hashPassword|checkPermission|validateSession|encrypt|decrypt)$/i, risk: "critical", signal: "auth/crypto symbol" },
  { test: /^(exec|execSync|spawn|eval|runCommand|shellExecute)$/i, risk: "high", signal: "execution-boundary symbol" },
]

function maxRisk(a, b) {
  return (RISK_ORDER[b] ?? 0) > (RISK_ORDER[a] ?? 0) ? b : a
}

/**
 * Best-effort extraction of the symbols a set of files defines, bounded in
 * files and bytes so a huge file can never stall the risk pass.
 * Used to answer "did this change touch authenticate()/authorize()/exec()?".
 */
export function detectAffectedSymbols(files = [], cwd = process.cwd(), { maxFiles = 12, maxBytes = 200_000 } = {}) {
  const out = new Set()
  let n = 0
  for (const f of files ?? []) {
    if (n++ >= maxFiles) break
    try {
      const p = path.resolve(cwd, String(f))
      const fd = fs.openSync(p, "r")
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, 64 * 1024))
        const read = fs.readSync(fd, buf, 0, buf.length, 0)
        const src = buf.subarray(0, read).toString("utf8")
        const re = /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g
        let m
        while ((m = re.exec(src))) {
          const name = m[1] || m[2]
          if (name) out.add(name)
          if (out.size >= 400) break
        }
      } finally { fs.closeSync(fd) }
    } catch { /* unreadable / binary — skip */ }
  }
  return [...out].slice(0, 400)
}

function basenameOf(p) {
  const s = String(p ?? "").replace(/\\/g, "/")
  return s.split("/").pop() ?? s
}

/**
 * Recalculate risk from what actually changed.
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]   modified files (paths or relative)
 * @param {string[]} [input.createdFiles]
 * @param {string[]} [input.deletedFiles]
 * @param {string[]} [input.affectedSymbols]
 * @param {string[]} [input.commands]       mutating commands that were run
 * @param {string}   [input.task]           original objective
 * @param {string}   [input.initialRisk]    planning-time risk (never lowered)
 * @param {boolean}  [input.securitySensitive]
 * @returns {{ risk: string, initialRisk: string, escalated: boolean, signals: string[], reasons: string[] }}
 */
export function finalRiskForChange(input = {}) {
  const changed = normList(input.changedFiles)
  const created = normList(input.createdFiles)
  const deleted = normList(input.deletedFiles)
  const symbols = normList(input.affectedSymbols)
  const commands = normList(input.commands)
  const initialRisk = RISK_ORDER[input.initialRisk] != null ? input.initialRisk : riskForChange({
    filesChanged: changed.length,
    filesCreated: created.length,
    task: input.task ?? "",
    securitySensitive: input.securitySensitive === true,
  })

  let risk = initialRisk
  const signals = []
  const reasons = []
  const escalate = (next, signal, where) => {
    if ((RISK_ORDER[next] ?? 0) > (RISK_ORDER[risk] ?? 0)) {
      risk = next
      reasons.push(`${where} → ${signal} raises risk to ${next}`)
    }
    if (signal && !signals.includes(signal)) signals.push(signal)
  }

  for (const f of [...changed, ...created, ...deleted]) {
    for (const rule of SENSITIVE_PATH_RULES) {
      if (rule.test.test(f)) escalate(rule.risk, rule.signal, basenameOf(f))
    }
  }
  for (const s of symbols) {
    for (const rule of SYMBOL_RULES) {
      if (rule.test.test(s)) escalate(rule.risk, rule.signal, `symbol ${s}`)
    }
  }
  for (const c of commands) {
    for (const rule of MUTATING_COMMAND_RULES) {
      if (rule.test.test(c)) escalate(rule.risk, rule.signal, `command "${String(c).slice(0, 60)}"`)
    }
  }

  // breadth of the change
  const touched = changed.length + created.length + deleted.length
  if (touched >= 8) escalate("high", `${touched} files touched`, "change breadth")
  else if (touched >= 4) escalate("medium", `${touched} files touched`, "change breadth")
  if (deleted.length) escalate("medium", `${deleted.length} file(s) deleted`, "deletion")

  return {
    risk,
    initialRisk,
    escalated: (RISK_ORDER[risk] ?? 0) > (RISK_ORDER[initialRisk] ?? 0),
    signals,
    reasons,
    counts: { changed: changed.length, created: created.length, deleted: deleted.length, symbols: symbols.length, commands: commands.length },
  }
}

function normList(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => String(x))
  if (v instanceof Set) return [...v].filter(Boolean).map((x) => String(x))
  if (typeof v === "string") return [v]
  return []
}

export function riskForChange({ filesChanged = 0, filesCreated = 0, task = "", securitySensitive = false } = {}) {
  const t = String(task ?? "").toLowerCase()
  if (securitySensitive || /security|vulnerab|injection|exploit|sanitiz|auth|secret|token|password|crypto|permission|sandbox|escape/i.test(t)) return "critical"
  if (filesChanged + filesCreated === 0) {
    if (/\b(docs?|documentation|readme|comment|typo|rename|explain|summar|read me)\b/.test(t) || /fix/.test(t) === false && /implement|add |create|build|change|refactor/i.test(t) === false) return "trivial"
    return /fix|implement|add |create|build|change|refactor|migrat/i.test(t) ? "medium" : "trivial"
  }
  if (/\b(docs?|documentation|readme|comment|typo)\b/.test(t) && filesChanged + filesCreated <= 2) return "low"
  if (/core|architect|refactor across|multi-file|migrat|provider|router|shellguard|safety/i.test(t) || filesChanged >= 8) return "high"
  if (filesChanged + filesCreated >= 2 || /fix|bug|implement|feature|add |change/i.test(t)) return "medium"
  return "low"
}
