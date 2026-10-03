/**
 * forge redteam — AUTHORIZED, READ-ONLY weakness analysis.
 *
 * What this is, and the lines it will not cross:
 *   - It reads LOCAL FILES ONLY — source and config in a directory you point
 *     it at. It opens no sockets, resolves no hosts, sends no packets, and
 *     spawns nothing. There is no network code in this module by design, so
 *     it cannot be turned into a scanner or an exploit runner by configuration.
 *   - It is SCOPE-GATED: every run needs a scope file in which you attest the
 *     target is yours or you are authorized to test it. No attestation, no run.
 *   - It REPORTS. It finds weakness CLASSES (injection, auth/access control,
 *     secret exposure, transport, surface) and explains why each is a risk and
 *     how to fix it. It does not write exploits, payloads, or proof-of-concept
 *     attacks, and it never modifies the target.
 *
 * It is the defensive, blue-for-red counterpart to selfaudit.js: same static,
 * line-anchored, false-positive-averse style (a lead you confirm by reading
 * the code, never a verdict), aimed at the weakness classes a red team or a
 * code review would look for first.
 */

import fs from "node:fs"
import path from "node:path"
import { sourceFiles, stripNonCode, SKIP_DIRS } from "./selfaudit.js"

export const REDTEAM_VERSION = 1

/** Severity, ordered. Used for ranking and the exit summary. */
export const SEVERITY = Object.freeze({ CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFO: "info" })
const SEV_ORDER = ["critical", "high", "medium", "low", "info"]

/** The weakness classes this reports. Each is a recognizable review category,
 *  not a product or payload. */
export const WCLASS = Object.freeze({
  SECRET_EXPOSURE: "secret-exposure",
  INJECTION: "injection",
  ACCESS_CONTROL: "access-control",
  TRANSPORT: "transport",
  AUTH: "authentication",
  SURFACE: "attack-surface",
  CRYPTO: "weak-crypto",
  DESERIALIZATION: "unsafe-deserialization",
})

// Files worth scanning for config-shaped weaknesses, beyond .js/.mjs source.
const CONFIG_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".php", ".java",
  ".json", ".yml", ".yaml", ".env", ".conf", ".ini", ".toml", ".tf", ".sh"]

/**
 * A scope file is the authorization gate. It is a small JSON document the USER
 * writes and signs off on:
 *   {
 *     "authorized": true,
 *     "owner": "me / my company",
 *     "attestation": "I own or am authorized to test these assets",
 *     "targets": ["./", "src/", "config/"]   // local paths, optional
 *   }
 * `authorized` MUST be literally true and the attestation MUST be present. A
 * missing, malformed, or unattested scope file refuses the run — there is no
 * default-allow and no --force.
 */
export function loadScope(scopePath) {
  let raw
  try { raw = fs.readFileSync(scopePath, "utf8") } catch { return { ok: false, reason: `scope file not found: ${scopePath}` } }
  let doc
  try { doc = JSON.parse(raw) } catch (e) { return { ok: false, reason: `scope file is not valid JSON: ${String(e.message || e)}` } }
  if (doc.authorized !== true) return { ok: false, reason: "scope file must set \"authorized\": true — stating you own or are authorized to test the target" }
  if (typeof doc.attestation !== "string" || doc.attestation.trim().length < 8) {
    return { ok: false, reason: "scope file must include an \"attestation\" sentence stating your authorization" }
  }
  const targets = Array.isArray(doc.targets) ? doc.targets.filter((t) => typeof t === "string" && t.trim()) : []
  // Hard refusal: a scope file that lists network targets is a misuse of this
  // tool. It reads local files; a host, URL or IP has no meaning here, and
  // accepting one would invite someone to think it reaches out. Say so plainly.
  const NETWORKISH = /^(https?:\/\/|ftp:\/\/|\d{1,3}(\.\d{1,3}){3}\b|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$)/i
  const networky = targets.filter((t) => NETWORKISH.test(t.trim()) && !fs.existsSync(t))
  if (networky.length) {
    return { ok: false, reason: `this tool analyzes LOCAL FILES only — it does not reach hosts, URLs or IPs. Remove network targets from the scope file: ${networky.slice(0, 3).join(", ")}` }
  }
  return { ok: true, owner: typeof doc.owner === "string" ? doc.owner : null, attestation: doc.attestation.trim(), targets }
}

/** A sample scope file, for `forge redteam --init-scope`. */
export function scopeTemplate() {
  return JSON.stringify({
    authorized: true,
    owner: "YOUR NAME OR ORG",
    attestation: "I own these assets or am explicitly authorized to test them.",
    targets: ["./"],
    note: "This tool reads local files only. It never contacts a host. Network targets are refused.",
  }, null, 2) + "\n"
}

// ---- weakness rules --------------------------------------------------------
//
// Each rule is { wclass, severity, why, fix, test(line, file) → match|null }.
// A rule matches a LINE of de-commented source. The matcher returns a short
// evidence string (the trigger) or null. Line-level, so a finding can point at
// a file:line a reviewer opens. Deliberately conservative: a rule that fires
// on half the codebase teaches people to ignore the tool.

const RULES = [
  // --- secret exposure ---
  {
    wclass: WCLASS.SECRET_EXPOSURE, severity: SEVERITY.CRITICAL,
    why: "a long-lived credential committed in source is readable by anyone with repo access and leaks in every clone, fork and backup",
    fix: "move it to an environment variable or a secret manager, rotate the exposed value, and add the file to .gitignore",
    // assignment of a quoted secret-looking value to a key that names a secret
    test: (ln) => {
      const m = /\b(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*(["'`])([^"'`]{8,})\1/i.exec(ln)
      if (!m) return null
      const v = m[2]
      // not a real secret: placeholder, env lookup, or an interpolated value
      if (/\$\{|\$\(|%\(|\{\{|<%|#\{/.test(v)) return null // interpolated at runtime, not literal
      if (/^(?:your|xxx+|changeme|change_me|placeholder|example|sample|dummy|fake|test|none|not[-_]?needed|n\/a|redacted|\*+|\.+|-+)/i.test(v)) return null
      if (/^(?:process\.env|os\.environ|env\.|null|undefined|true|false)/i.test(v)) return null
      // must look like a key, not a human word or a short label: require mixed
      // case or digits or symbols, and enough length that guessing is the point
      const entropy = (/[a-z]/.test(v) && /[A-Z0-9]/.test(v)) || /[-_+/=]/.test(v) || /\d{4,}/.test(v)
      if (!entropy || v.length < 12) return null
      return `hard-coded secret-like value (${v.length} chars)`
    },
  },
  {
    wclass: WCLASS.SECRET_EXPOSURE, severity: SEVERITY.HIGH,
    why: "a recognizable cloud/service key format in source is almost certainly a live credential",
    fix: "revoke and rotate the key at the provider, then load it from the environment",
    test: (ln) => {
      const pats = [/AKIA[0-9A-Z]{16}/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /\bsk-[A-Za-z0-9]{20,}/, /xox[baprs]-[0-9A-Za-z-]{10,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
      for (const p of pats) if (p.test(ln)) return `credential pattern: ${p.source.slice(0, 24)}…`
      return null
    },
  },
  // --- injection ---
  {
    wclass: WCLASS.INJECTION, severity: SEVERITY.HIGH,
    why: "a SQL statement built by string concatenation lets an attacker-controlled value change the query (SQL injection)",
    fix: "use parameterized queries / prepared statements; never concatenate user input into SQL",
    // A STRONG SQL shape inside a quoted span — a multi-keyword clause, not the
    // bare word "update" or "where" (those are ordinary English and were the
    // source of dozens of false positives on log strings). And the splice must
    // break OUT of the quotes right where the SQL text is, not merely appear
    // somewhere on the line.
    test: (ln) => {
      const m = /(["'`])([^"'`]*\b(?:select\b[^"'`]*\bfrom\b|insert\s+into\b|delete\s+from\b|update\s+\w+\s+set\b|\bfrom\s+\w+\s+where\b)[^"'`]*)\1/i.exec(ln)
      if (!m) return null
      const q = m[1]
      // the quoted SQL must be concatenated or interpolated with a non-literal:
      // `"… where id=" + x`, `x + "select …"`, or `${x}` inside the SQL itself
      const splicedOutside = ln.includes(`${q} +`) || ln.includes(`${q}+`) || /\+\s*["'`]/.test(ln)
      const splicedInside = /\$\{[^}]+\}/.test(m[2])
      return (splicedOutside || splicedInside) ? "SQL assembled with string concatenation or interpolation" : null
    },
  },
  {
    wclass: WCLASS.INJECTION, severity: SEVERITY.CRITICAL,
    why: "passing untrusted input to a shell lets it run arbitrary commands (command injection)",
    fix: "avoid the shell; pass an argument array to execFile/spawn with shell:false, and validate inputs",
    test: (ln) => {
      // the exec-family call and the dynamic value must be in the SAME call,
      // i.e. between the call's "(" and the matching argument — approximated by
      // requiring the interpolation to sit inside the first "(...)" after exec.
      // A shell-exec shape only — NOT RegExp.exec (`/re/.exec`, `RE.exec`).
      // We match child_process.exec / cp.exec / execSync / an execa() call /
      // spawn / os.system / system( / popen / subprocess.*. A ".exec" that is a
      // method on a regex or any identifier is excluded: we never match a bare
      // ".exec", only the forms above.
      const m = /(?:\bchild_process\s*\.\s*exec|\bcp\s*\.\s*exec|\bexecSync|\bexeca\s*\(|\bspawn\s*\(|\bos\s*\.\s*system|\bsystem\s*\(|\bpopen\s*\(|\bsubprocess\s*\.\s*(?:call|run|Popen|check_output))\s*\(?([^)]*)/i.exec(ln)
      if (!m) return null
      const arg = m[1]
      // an args ARRAY (execFile/spawn style) or shell:false is the safe form
      if (/\[\s*["'`]/.test(arg)) return null
      // a string literal with a variable spliced in is the dangerous form
      if (/\$\{|["'`]\s*\+\s*\w|\w\s*\+\s*["'`]|%\s*\(|\.format\s*\(|\bf["'`]/.test(arg)) return "shell command built from a variable"
      return null
    },
  },
  {
    wclass: WCLASS.INJECTION, severity: SEVERITY.HIGH,
    why: "eval / dynamic code execution on any value derived from input is remote code execution",
    fix: "remove eval; use a parser or an explicit dispatch table for the cases you actually need",
    test: (ln) => /\b(?:eval|new Function)\s*\(/.test(ln) && !/\/\/\s*nosec|eslint/.test(ln) ? "dynamic code execution (eval / new Function)" : null,
  },
  // --- access control ---
  {
    wclass: WCLASS.ACCESS_CONTROL, severity: SEVERITY.HIGH,
    why: "reading a record by an id taken straight from the request, with no owner check, is an IDOR — one user can read another's data",
    fix: "scope the lookup to the authenticated principal (WHERE id = ? AND owner = currentUser), or check ownership before returning",
    // a findById / lookup keyed on req params, near no ownership word on the line
    test: (ln) => /\b(?:findById|findOne|get|load|fetch)\b[\s\S]*\breq\.(?:params|query|body)\b/i.test(ln) && !/\b(?:owner|user_id|userId|current|auth|principal|tenant)\b/i.test(ln) ? "record fetched by request id with no owner scope on this line" : null,
  },
  {
    wclass: WCLASS.ACCESS_CONTROL, severity: SEVERITY.MEDIUM,
    why: "a route handler with no authorization middleware or role check may be reachable by anyone",
    fix: "require authentication and check the caller's role/permission before the handler runs",
    test: (ln) => /\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*["'`][^"'`]+["'`]\s*,\s*(?:async\s*)?\(?(?:req|request)\b/i.test(ln) && !/\b(?:auth|authorize|requireLogin|ensureAuth|isAuthenticated|guard|rbac|can|permit)\b/i.test(ln) ? "route handler with no auth middleware on the route line" : null,
  },
  // --- transport ---
  {
    wclass: WCLASS.TRANSPORT, severity: SEVERITY.MEDIUM,
    why: "a cleartext http:// endpoint for anything but localhost exposes traffic to interception and tampering",
    fix: "use https:// and enable HSTS; redirect http to https at the edge",
    test: (ln) => {
      const m = /["'`]http:\/\/([a-z0-9.-]+)/i.exec(ln)
      if (!m) return null
      const host = m[1].toLowerCase()
      // localhost and private/loopback hosts are not a transport risk
      if (/^(?:localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|x$|example\.|test\.)/.test(host)) return null
      // `new URL(x, "http://base")` and `new URL(req.url, …)` use the base only
      // to parse a relative path — the scheme never reaches the wire
      if (/new URL\s*\(/.test(ln)) return null
      // a schema/namespace URL (xmlns, w3.org, json-schema) is an identifier
      if (/(?:xmlns|w3\.org|schema|\.dtd|namespace|ns=)/i.test(ln)) return null
      return `cleartext http:// endpoint (${host})`
    },
  },
  {
    wclass: WCLASS.TRANSPORT, severity: SEVERITY.HIGH,
    why: "disabling TLS certificate verification defeats HTTPS entirely and invites man-in-the-middle",
    fix: "remove the override; fix the actual certificate chain instead",
    test: (ln) => /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["'`]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false))/i.test(ln) ? "TLS verification disabled" : null,
  },
  // --- auth / session ---
  {
    wclass: WCLASS.AUTH, severity: SEVERITY.MEDIUM,
    why: "a session or auth cookie without HttpOnly/Secure can be stolen by script or sent over cleartext",
    fix: "set httpOnly: true, secure: true and sameSite on session cookies",
    test: (ln) => /\b(?:cookie|session)\b/i.test(ln) && /\b(?:httpOnly|secure)\s*:\s*false/i.test(ln) ? "session cookie flag set to false" : null,
  },
  // --- weak crypto ---
  {
    wclass: WCLASS.CRYPTO, severity: SEVERITY.HIGH,
    why: "hashing a password or token with a fast digest (MD5/SHA1/SHA-256) is brute-forceable; MD5/SHA1 are also collision-broken",
    fix: "use bcrypt, scrypt or argon2 for passwords; for other secrets use HMAC with a strong key",
    // only fires when the SAME line ties a weak/fast hash to a password/secret
    test: (ln) => /\b(?:createHash\s*\(\s*["'`](?:md5|sha1|sha256)["'`]|hashlib\.(?:md5|sha1|sha256)|MessageDigest\.getInstance\(\s*["'`](?:MD5|SHA-1|SHA-256)["'`])/i.test(ln) && /\b(?:password|passwd|pwd|secret|credential|token|pin)\b/i.test(ln) ? "fast hash used on a password/secret" : null,
  },
  {
    wclass: WCLASS.CRYPTO, severity: SEVERITY.LOW,
    why: "MD5/SHA1 are collision-broken — fine for a non-security cache key or checksum, but never for integrity or signatures you rely on against an adversary",
    fix: "if this value is security-relevant, move to SHA-256+; if it is only a cache/dedup key, this is acceptable (annotate it so review knows)",
    test: (ln) => /\b(?:createHash\s*\(\s*["'`](?:md5|sha1)["'`]|hashlib\.(?:md5|sha1)\b|MessageDigest\.getInstance\(\s*["'`](?:MD5|SHA-1)["'`]|\bDES\b(?!cri))/i.test(ln) && !/\b(?:password|passwd|pwd|secret|credential|token|pin)\b/i.test(ln) && !/md5\/sha1|weak hash/i.test(ln) ? "MD5/SHA1 — verify it is not relied on for security" : null,
  },
  // --- unsafe deserialization ---
  {
    wclass: WCLASS.DESERIALIZATION, severity: SEVERITY.HIGH,
    why: "deserializing untrusted data with a format that can instantiate objects can execute attacker code",
    fix: "use a data-only format (JSON) and a safe loader (yaml.safe_load, pickle only on trusted data)",
    test: (ln) => /\b(?:pickle\.loads?|yaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)|cPickle\.loads?|Marshal\.load|readObject\s*\()/.test(ln) ? "unsafe deserialization call" : null,
  },
  // --- attack surface ---
  {
    wclass: WCLASS.SURFACE, severity: SEVERITY.LOW,
    why: "binding a service to 0.0.0.0 exposes it on every interface, including public ones",
    fix: "bind to 127.0.0.1 unless the service is meant to be reachable externally, and firewall it if so",
    test: (ln) => /["'`]0\.0\.0\.0["'`]|\blisten\s*\(\s*\d+\s*,\s*["'`]0\.0\.0\.0["'`]/.test(ln) ? "service bound to 0.0.0.0 (all interfaces)" : null,
  },
  {
    wclass: WCLASS.SURFACE, severity: SEVERITY.MEDIUM,
    why: "debug mode in production leaks stack traces, config and sometimes a remote code console",
    fix: "force debug off in production builds and gate it behind an environment check",
    test: (ln) => /\b(?:debug\s*[:=]\s*true|DEBUG\s*=\s*True|app\.debug\s*=\s*True|flask.*debug\s*=\s*True)/i.test(ln) ? "debug mode enabled" : null,
  },
  {
    wclass: WCLASS.SURFACE, severity: SEVERITY.LOW,
    why: "a permissive CORS policy (Allow-Origin: *) lets any site make credentialed requests to the API",
    fix: "allow a specific list of origins; never combine Allow-Origin: * with credentials",
    test: (ln) => /Access-Control-Allow-Origin["'`]?\s*[:,]\s*["'`]\*["'`]|cors\(\s*\{\s*origin\s*:\s*["'`]\*["'`]/i.test(ln) ? "wildcard CORS origin" : null,
  },
]

/** Lines that are clearly test fixtures or examples, where a "secret" is fake. */
const FIXTURE_HINT = /(?:^|\/)(?:tests?|spec|specs|fixtures?|examples?|samples?|mocks?|__tests__|e2e|benchmark|bench)(?:\/|$|[._-])|\.(?:test|spec)\.|\b(?:mock|dummy|fake|stub)\b/i

/**
 * Scan one file's text. Returns findings (possibly empty). Comments are
 * stripped first (a weakness discussed in a doc comment is not a weakness),
 * reusing selfaudit's line-anchored stripper.
 */
export function scanText(text, { file = "", isFixture = false } = {}) {
  const findings = []
  const code = stripNonCode(text)
  const lines = code.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!ln.trim() || ln.trim().length > 1000) continue
    for (const rule of RULES) {
      // in a test/fixture file, a hard-coded secret is almost always fake —
      // demote the two credential rules to INFO rather than crying wolf
      let evidence
      try { evidence = rule.test(ln, file) } catch { evidence = null }
      if (!evidence) continue
      // test/fixture/example code is not shipped, so a pattern there is a lead
      // at most, never a production weakness — cap it at INFO so real findings
      // in real code are not buried under fixtures
      const severity = isFixture ? SEVERITY.INFO : rule.severity
      findings.push({ wclass: rule.wclass, severity, why: rule.why, fix: rule.fix, file, line: i + 1, evidence, snippet: ln.trim().slice(0, 160) })
    }
  }
  return findings
}

/**
 * Analyze a directory of local files. READ-ONLY. No network, no execution.
 * @param {object} o
 * @param {string}   o.dir        root to scan
 * @param {string[]} [o.targets]  optional sub-paths (from the scope file); default the whole dir
 * @param {number}   [o.maxFiles]
 * @returns {{ version, root, filesScanned, findings, counts, bySeverity }}
 */
export function analyze({ dir, targets = [], maxFiles = 6000 } = {}) {
  const root = path.resolve(dir)
  const roots = targets.length ? targets.map((t) => path.resolve(root, t)) : [root]
  const seen = new Set()
  const rels = []
  for (const r of roots) {
    let base = r, pre = ""
    try {
      const st = fs.statSync(r)
      if (st.isFile()) { const rel = path.relative(root, r); if (!seen.has(rel)) { seen.add(rel); rels.push(rel) } continue }
    } catch { continue }
    pre = path.relative(root, base)
    for (const f of sourceFiles(base, { exts: CONFIG_EXTS, skip: SKIP_DIRS, maxFiles })) {
      const rel = pre ? `${pre}/${f}` : f
      if (!seen.has(rel)) { seen.add(rel); rels.push(rel) }
    }
  }
  const findings = []
  let filesScanned = 0
  for (const rel of rels) {
    const abs = path.join(root, rel)
    let text
    try { text = fs.readFileSync(abs, "utf8") } catch { continue }
    if (text.includes("\u0000")) continue // binary
    filesScanned++
    const isFixture = FIXTURE_HINT.test(rel)
    for (const f of scanText(text, { file: rel, isFixture })) findings.push(f)
  }
  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line)
  const bySeverity = {}
  for (const s of SEV_ORDER) bySeverity[s] = findings.filter((f) => f.severity === s).length
  const counts = {}
  for (const f of findings) counts[f.wclass] = (counts[f.wclass] ?? 0) + 1
  return { version: REDTEAM_VERSION, root, filesScanned, findings, counts, bySeverity }
}

const SEV_TAG = { critical: "CRIT", high: "HIGH", medium: "MED ", low: "LOW ", info: "INFO" }

/** Human report. `limit` caps the detailed list; the summary always totals all. */
export function formatRedteamReport(report, { limit = 40, color = (s) => s } = {}) {
  const L = []
  const { bySeverity, counts, filesScanned, findings } = report
  const sevLine = SEV_ORDER.filter((s) => bySeverity[s]).map((s) => `${bySeverity[s]} ${s}`).join(" · ") || "no findings"
  L.push(`  ${filesScanned} file(s) scanned · ${findings.length} finding(s): ${sevLine}`)
  if (Object.keys(counts).length) L.push("  by class: " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "))
  L.push("")
  if (!findings.length) {
    L.push("  No weakness-class patterns matched. This is NOT a clean bill of health — a")
    L.push("  static scan proves only that these patterns are absent, never that the")
    L.push("  system is secure. Confirm by review and by testing in a safe environment.")
    return L.join("\n")
  }
  for (const f of findings.slice(0, limit)) {
    L.push(`  [${SEV_TAG[f.severity]}] ${f.wclass}  ${f.file}:${f.line}`)
    L.push(`         ${f.evidence}`)
    L.push(`         why: ${f.why}`)
    L.push(`         fix: ${f.fix}`)
    L.push("")
  }
  if (findings.length > limit) L.push(`  … and ${findings.length - limit} more (raise --limit, or --json for all)`)
  L.push("  Leads to confirm by reading the code — a pattern match is not a proven")
  L.push("  vulnerability. Fix in your own code; never test against systems you do not own.")
  return L.join("\n")
}
