/**
 * forge redteam — authorized, read-only weakness analysis.
 * Covers the scope gate, each weakness rule (a true positive and the
 * false positives found on forge's own tree), fixture demotion, and that the
 * module does no network or process work. Zero network, isolated HOME.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const R = await import("../redteam.js")
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-redteam-"))

let n = 0
const t = (name, fn) => { try { fn(); n++; console.log(`  ok   ${name}`) } catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); process.exitCode = 1 } }
const scan = (text, o) => R.scanText(text, o ?? {}).map((f) => `${f.wclass}/${f.severity}`)
const hits = (text, wclass, o) => R.scanText(text, o ?? {}).filter((f) => f.wclass === wclass)

// ---- the scope gate: no authorization, no run --------------------------------
t("scope: a missing file refuses", () => { assert.equal(R.loadScope(path.join(WORK, "nope.json")).ok, false) })
t("scope: invalid JSON refuses with a reason", () => {
  const p = path.join(WORK, "bad.json"); fs.writeFileSync(p, "{not json")
  const s = R.loadScope(p); assert.equal(s.ok, false); assert.match(s.reason, /not valid JSON/)
})
t("scope: authorized must be literally true", () => {
  const p = path.join(WORK, "unauth.json"); fs.writeFileSync(p, JSON.stringify({ authorized: "yes", attestation: "I own this." }))
  assert.equal(R.loadScope(p).ok, false)
})
t("scope: an attestation sentence is required", () => {
  const p = path.join(WORK, "noatt.json"); fs.writeFileSync(p, JSON.stringify({ authorized: true }))
  assert.match(R.loadScope(p).reason, /attestation/)
})
t("scope: a valid file passes and carries owner + targets", () => {
  const p = path.join(WORK, "ok.json"); fs.writeFileSync(p, JSON.stringify({ authorized: true, owner: "Me", attestation: "I own these assets.", targets: ["src/"] }))
  const s = R.loadScope(p); assert.equal(s.ok, true); assert.equal(s.owner, "Me"); assert.deepEqual(s.targets, ["src/"])
})
t("scope: a NETWORK target is refused — this tool reads local files only", () => {
  for (const tgt of ["https://example.com", "10.0.0.5", "api.example.com:443", "example.com"]) {
    const p = path.join(WORK, "net.json"); fs.writeFileSync(p, JSON.stringify({ authorized: true, attestation: "I own this.", targets: [tgt] }))
    const s = R.loadScope(p)
    assert.equal(s.ok, false, tgt); assert.match(s.reason, /LOCAL FILES only|does not reach hosts/)
  }
})
t("scope: a local path that merely looks domain-ish is allowed if it exists", () => {
  const d = path.join(WORK, "my.config.dir"); fs.mkdirSync(d, { recursive: true })
  const p = path.join(WORK, "localdot.json"); fs.writeFileSync(p, JSON.stringify({ authorized: true, attestation: "I own this.", targets: [d] }))
  assert.equal(R.loadScope(p).ok, true)
})
t("scopeTemplate is valid JSON, unauthorized by intent, and says local-only", () => {
  const tpl = JSON.parse(R.scopeTemplate())
  assert.equal(tpl.authorized, true) // template is pre-filled; the user still edits owner/attestation
  assert.match(tpl.note, /local files only/i)
})

// ---- the weakness rules: true positives --------------------------------------
t("secret exposure: a hard-coded high-entropy key is CRITICAL", () => {
  assert.ok(hits('const apiKey = "A1b2C3d4E5f6G7h8"', R.WCLASS.SECRET_EXPOSURE).length)
  assert.ok(hits('token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', R.WCLASS.SECRET_EXPOSURE).length)
})
t("secret exposure: placeholders, env lookups and interpolation are NOT flagged", () => {
  for (const s of ['apiKey = "not-needed"', 'apiKey = `k-${Date.now()}`', 'secret = process.env.SECRET', 'password = "changeme"', 'token: "${env.TOKEN}"', 'key = "example"']) {
    assert.equal(hits(s, R.WCLASS.SECRET_EXPOSURE).length, 0, s)
  }
})
t("command injection: a shell built from a variable is CRITICAL; an args array is not", () => {
  assert.ok(hits("cp.exec(process.env.OPEN_CMD + ' ' + url)", R.WCLASS.INJECTION).length)
  assert.ok(hits("child_process.exec(`rm ${file}`)", R.WCLASS.INJECTION).length)
  assert.equal(hits('execFile("git", ["log", branch], cb)', R.WCLASS.INJECTION).length, 0, "args array is safe")
  assert.equal(hits("spawn('ls', ['-la', dir])", R.WCLASS.INJECTION).length, 0)
})
t("command injection: RegExp.exec is never mistaken for a shell", () => {
  for (const s of ["const m = RISK_RE.exec(s)", "const cd = /^cd\\s+/.exec(c)", "const m = /^py\\s+/i.exec(s)", "str.match(re).exec(x)"]) {
    assert.equal(scan(s).length, 0, s)
  }
})
t("SQL injection: a concatenated query is flagged; log strings with 'where'/'update' are not", () => {
  assert.ok(hits('db.query("SELECT * FROM users WHERE id=" + id)', R.WCLASS.INJECTION).length)
  assert.ok(hits('run(`UPDATE users SET name=${name} WHERE id=${id}`)', R.WCLASS.INJECTION).length)
  for (const s of ['lines.push(`where: ${st.phase}`)', 'return `update ${branch}`', 'console.log(`4. update API key`)', 'throw new Error(`no lane: ${l} select nothing`)']) {
    assert.equal(hits(s, R.WCLASS.INJECTION).length, 0, s)
  }
})
t("eval: dynamic code execution is flagged", () => { assert.ok(hits("const r = eval(userInput)", R.WCLASS.INJECTION).length) })
t("transport: a public http:// url is flagged; localhost/private/new URL base/schema are not", () => {
  assert.ok(hits('fetch("http://api.example.org/x")', R.WCLASS.TRANSPORT).length)
  for (const s of ['const u = new URL(req.url, "http://x")', 'connect("http://127.0.0.1:8080")', 'open("http://localhost:3000")', 'open("http://10.0.0.2")', 'xmlns="http://www.w3.org/2000/svg"']) {
    assert.equal(hits(s, R.WCLASS.TRANSPORT).length, 0, s)
  }
})
t("transport: disabling TLS verification is HIGH", () => {
  assert.ok(hits("{ rejectUnauthorized: false }", R.WCLASS.TRANSPORT).some((f) => f.severity === "high"))
  assert.ok(hits("requests.get(url, verify=False)", R.WCLASS.TRANSPORT).some((f) => f.severity === "high"))
})
t("weak crypto: a fast hash on a PASSWORD is HIGH; a cache-key hash is only LOW", () => {
  assert.ok(hits('createHash("sha256").update(password).digest("hex")', R.WCLASS.CRYPTO).some((f) => f.severity === "high"))
  const cacheKey = hits('createHash("sha1").update(cwd).digest("hex")', R.WCLASS.CRYPTO)
  assert.ok(cacheKey.length && cacheKey.every((f) => f.severity === "low"), "a non-password SHA1 is LOW, not HIGH")
  assert.equal(hits('createHash("sha256").update(cwd).digest("hex")', R.WCLASS.CRYPTO).length, 0, "SHA-256 on a non-secret is fine")
})
t("access control: an id from the request with no owner scope is flagged", () => {
  assert.ok(hits("User.findById(req.params.id)", R.WCLASS.ACCESS_CONTROL).length)
  assert.equal(hits("User.findOne({ id: req.params.id, owner: req.user.id })", R.WCLASS.ACCESS_CONTROL).length, 0, "owner-scoped lookup is safe")
})
t("unsafe deserialization: pickle.loads / yaml.load without SafeLoader", () => {
  assert.ok(hits("data = pickle.loads(blob)", R.WCLASS.DESERIALIZATION).length)
  assert.ok(hits("cfg = yaml.load(text)", R.WCLASS.DESERIALIZATION).length)
  assert.equal(hits("cfg = yaml.load(text, Loader=yaml.SafeLoader)", R.WCLASS.DESERIALIZATION).length, 0)
})
t("attack surface: 0.0.0.0 bind, debug mode, wildcard CORS", () => {
  assert.ok(hits('server.listen(3000, "0.0.0.0")', R.WCLASS.SURFACE).length)
  assert.ok(hits("app.debug = True", R.WCLASS.SURFACE).length)
  assert.ok(hits('cors({ origin: "*" })', R.WCLASS.SURFACE).length)
})

// ---- comments and fixtures ---------------------------------------------------
t("a weakness only MENTIONED in a doc comment is not a finding", () => {
  assert.equal(scan('// example: const apiKey = "A1b2C3d4E5f6G7h8"').length, 0)
})
t("in a test/fixture file every finding is capped at INFO", () => {
  const f = R.scanText('const apiKey = "A1b2C3d4E5f6G7h8"; eval(x)', { file: "tests/test-foo.mjs", isFixture: true })
  assert.ok(f.length >= 2 && f.every((x) => x.severity === "info"), JSON.stringify(f.map((x) => x.severity)))
})

// ---- analyze() over a directory ----------------------------------------------
t("analyze() reads a tree read-only and reports findings with file:line", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rt-an-"))
  fs.writeFileSync(path.join(d, "app.js"), 'const apiKey = "A1b2C3d4E5f6G7h8"\nfetch("http://api.example.org")\n')
  fs.mkdirSync(path.join(d, "tests")); fs.writeFileSync(path.join(d, "tests", "t.mjs"), 'const apiKey = "A1b2C3d4E5f6G7h8"\n')
  const rep = R.analyze({ dir: d })
  assert.ok(rep.filesScanned >= 2)
  const crit = rep.findings.find((f) => f.severity === "critical")
  assert.ok(crit && crit.file === "app.js" && crit.line === 1, JSON.stringify(crit))
  // the same literal in the test file is demoted to INFO
  assert.ok(rep.findings.some((f) => f.file === "tests/t.mjs" && f.severity === "info"))
})
t("analyze() respects scope targets (sub-paths only)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rt-tg-"))
  fs.mkdirSync(path.join(d, "src")); fs.writeFileSync(path.join(d, "src", "a.js"), 'fetch("http://api.example.org")\n')
  fs.writeFileSync(path.join(d, "root.js"), 'const apiKey = "A1b2C3d4E5f6G7h8"\n')
  const rep = R.analyze({ dir: d, targets: ["src/"] })
  assert.ok(rep.findings.every((f) => f.file.startsWith("src/")), "only the scoped sub-path is scanned")
})
t("formatReport: empty findings says it is NOT a clean bill of health", () => {
  const out = R.formatRedteamReport({ filesScanned: 3, findings: [], counts: {}, bySeverity: {} })
  assert.match(out, /NOT a clean bill of health/)
})

// ---- purity: the module touches no network and spawns nothing ----------------
t("redteam.js imports nothing that can reach the network or spawn a process", () => {
  const src = fs.readFileSync(path.join(here, "..", "redteam.js"), "utf8")
  for (const bad of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "child_process", "node:child_process", "fetch(", ".connect(", "exec(", "spawn("]) {
    // allow the strings INSIDE rule patterns (they detect these words); forbid
    // an actual import/require/call. Check import+require lines specifically.
    const importsIt = new RegExp(`(?:import[^\\n]*from\\s*["']${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|require\\(\\s*["']${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`).test(src)
    assert.equal(importsIt, false, `redteam.js must not import/require ${bad}`)
  }
  // the only runtime imports are node:fs, node:path and ./selfaudit.js
  const imp = [...src.matchAll(/^import[^\n]*from\s*["']([^"']+)["']/gm)].map((m) => m[1]).sort()
  assert.deepEqual(imp, ["./selfaudit.js", "node:fs", "node:path"])
})

console.log(`\n== redteam suite: ${n} passed, ${process.exitCode ? "some" : 0} failed ==`)
