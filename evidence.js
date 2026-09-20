/**
 * forge — evidence kinds (Ω, zero dependencies)
 *
 * Decisions distinguish FACT / INFERENCE / HYPOTHESIS / UNKNOWN / VERIFIED /
 * STALE. Guesses never become facts. Provenance is required. A fact about a
 * file is STALE the moment that file is written after the fact's `asOf`.
 *
 * v91 (∞ CORE §19): the evidence engine carries the full claim ladder —
 * OBSERVATION / FINDING / ANALYSIS join the kinds, VERIFICATION and PROOF
 * mark verified claims, and every item may carry structured provenance:
 * source, command, file, line, symbol, timestamp, task, reproducibility,
 * confidence and freshness. When the source changes, dependent evidence
 * goes STALE (isStale is unchanged and now also honors `provenance.file`).
 */
export const KIND = {
  FACT: "FACT",
  OBSERVATION: "OBSERVATION",
  FINDING: "FINDING",
  ANALYSIS: "ANALYSIS",
  INFERENCE: "INFERENCE",
  HYPOTHESIS: "HYPOTHESIS",
  VERIFICATION: "VERIFICATION",
  VERIFIED: "VERIFIED",
  PROOF: "PROOF",
  UNKNOWN: "UNKNOWN",
  STALE: "STALE",
}

export function fact(value, { source = "observe", files = [], asOf = Date.now() } = {}) {
  return { kind: KIND.FACT, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }
}

/** v91 §19 — raw observation (tool output, command result). Evidence-bearing
 *  but weaker than a fact: it is what we SAW, not yet what we KNOW. */
export function observation(value, { source = "tool", files = [], asOf = Date.now(), confidence = 0.8, provenance = null } = {}) {
  return withProvenance({ kind: KIND.OBSERVATION, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — a finding: the result of looking for something specific. */
export function finding(value, { source = "search", files = [], asOf = Date.now(), confidence = 0.7, provenance = null } = {}) {
  return withProvenance({ kind: KIND.FINDING, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — an analysis: interpretation over observations/findings. */
export function analysis(value, { source = "analyze", files = [], asOf = Date.now(), confidence = 0.6, provenance = null } = {}) {
  return withProvenance({ kind: KIND.ANALYSIS, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — the record that a specific verification ran and what it showed. */
export function verification(value, { source = "verify", files = [], asOf = Date.now(), confidence = 1, provenance = null } = {}) {
  return withProvenance({ kind: KIND.VERIFICATION, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }, provenance)
}

/** v91 §19 — proof: the strongest claim; requires a reproducible source. */
export function proof(value, { source = "prove", files = [], asOf = Date.now(), provenance = null } = {}) {
  const ev = withProvenance({ kind: KIND.PROOF, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }, provenance)
  if (!ev.provenance || !ev.provenance.reproducible) {
    // a proof without reproducibility is a VERIFICATION, never a PROOF
    ev.kind = KIND.VERIFICATION
    ev.downgraded_from = KIND.PROOF
  }
  return ev
}

export function inference(value, { source = "reason", files = [], asOf = Date.now(), confidence = 0.6 } = {}) {
  return { kind: KIND.INFERENCE, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }
}

export function hypothesis(value, { source = "guess", files = [], asOf = Date.now(), confidence = 0.4 } = {}) {
  return { kind: KIND.HYPOTHESIS, value, source: String(source), files: asFiles(files), asOf, confidence: clamp01(confidence) }
}

export function unknown(value, { source = "gap" } = {}) {
  return { kind: KIND.UNKNOWN, value, source: String(source), files: [], asOf: Date.now(), confidence: 0 }
}

export function verified(value, { source = "test", files = [], asOf = Date.now() } = {}) {
  return { kind: KIND.VERIFIED, value, source: String(source), files: asFiles(files), asOf, confidence: 1 }
}

/**
 * A fact covering `files` is stale when any of those files was written after
 * `asOf`. Callers pass the write ledger (path → mtime/epoch).
 * v91: provenance.file and provenance.symbol follow the same rule.
 */
/**
 * v127 — THE path-comparison rule, in one place.
 *
 * Two paths name the same file when they are equal after separator
 * normalization, or when one is the other's suffix at a segment boundary.
 * That last clause is what makes `agent.js` and `/home/user/Alfa/agent.js`
 * the same file and keeps `agent.js` and `vendor/notagent.js` different.
 * verifyledger.js already reasoned this way for verification scope; nothing
 * else did.
 */
/**
 * v133.1: canonicalize before comparing. Separator normalization alone left
 * `/repo/src/../agent.js` and `/repo/agent.js` looking like different files,
 * so `isStale` and `staleFiles` could keep evidence active for a file that had
 * in fact changed — the exact failure this function exists to prevent.
 */
function canonical(p) {
  const raw = String(p ?? "").replace(/\\/g, "/")
  const rooted = raw.startsWith("/")
  const out = []
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      // A leading `..` on a RELATIVE path is meaningful and must be kept;
      // popping it would silently turn `../a.js` into `a.js`.
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!rooted) out.push("..")
      continue
    }
    out.push(seg)
  }
  return (rooted ? "/" : "") + out.join("/")
}

export function samePath(a, b) {
  const x = canonical(a)
  const y = canonical(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.endsWith("/" + y) || y.endsWith("/" + x)
}

function baseOf(p) {
  const s = String(p ?? "").replace(/\\/g, "/")
  return s.slice(s.lastIndexOf("/") + 1)
}

// A writes map is looked at once per memory entry — up to 500 entries against
// a map that can hold every file in the repo. Indexing it by basename keeps
// the fuzzy match O(1) in the common case, and the index is cached against the
// map object itself so a retrieval pass builds it once.
const writeIndexCache = new WeakMap()
function writeIndex(writes) {
  const keys = Object.keys(writes)
  // Identity alone was not enough: a caller that ADDS a path to the same
  // writes object after an index was built got the stale index back, and the
  // fuzzy lookup then answered `false` for a file that was right there. The
  // key count is the cheap invalidation that covers the way this map actually
  // changes — entries are added, never rewritten in place.
  const hit = writeIndexCache.get(writes)
  if (hit && hit.size === keys.length) return hit.idx
  let idx = new Map()
  for (const k of Object.keys(writes)) {
    const b = baseOf(k)
    if (!b) continue
    if (!idx.has(b)) idx.set(b, [])
    idx.get(b).push(k)
  }
  writeIndexCache.set(writes, { idx, size: keys.length })
  return idx
}

/**
 * v127 — a fact about a file is stale when that file was written after it,
 * whichever spelling of the path either side happened to record.
 *
 * This was an exact key lookup (`writes[f]`), so staleness depended on two
 * unrelated producers having chosen the same string. They do not. Measured:
 * `worldFromCwd()` keys its writes RELATIVE (`agent-benchmark.js`), while a
 * live run's writes arrive ABSOLUTE from the tool arguments — and
 * `filesCited()`, in this same subsystem, extracts `./governor.js` with a
 * leading `./` that matched neither. So:
 *
 *   fact cites "agent.js", write recorded "/home/user/Alfa/agent.js"  → NOT stale
 *   fact cites "agent.js", write recorded "./agent.js"                → NOT stale
 *   fact cites "src\\a.js", write recorded "src/a.js"                 → NOT stale
 *
 * Each of those is a remembered claim about a file that has since changed,
 * silently served as current truth. The exact hit stays the fast path; the
 * basename index only runs when it misses.
 */
export function isStale(ev, writes = {}) {
  if (!ev || ev.kind === KIND.UNKNOWN) return false
  if (ev.kind === KIND.STALE) return true
  const asOf = Number(ev.asOf) || 0
  const paths = new Set([...(ev.files || [])])
  const p = ev.provenance
  if (p?.file) paths.add(p.file)
  if (!paths.size || !writes || typeof writes !== "object") return false
  let idx = null
  for (const f of paths) {
    const exact = writes[f]
    if (exact != null && Number(exact) > asOf) return true
    idx = idx || writeIndex(writes)
    for (const k of idx.get(baseOf(f)) || []) {
      if (samePath(k, f) && Number(writes[k]) > asOf) return true
    }
  }
  return false
}

/** v91 §19 — attach structured provenance (source, command, file, line,
 *  symbol, task, reproducibility, freshness). Bounded and serializable. */
export function withProvenance(ev, provenance = null) {
  if (!provenance || typeof provenance !== "object") return ev
  ev.provenance = {
    command: provenance.command != null ? String(provenance.command).slice(0, 300) : undefined,
    file: provenance.file != null ? String(provenance.file).slice(0, 500) : undefined,
    line: Number.isFinite(Number(provenance.line)) ? Number(provenance.line) : undefined,
    symbol: provenance.symbol != null ? String(provenance.symbol).slice(0, 200) : undefined,
    task: provenance.task != null ? String(provenance.task).slice(0, 120) : undefined,
    node: provenance.node != null ? String(provenance.node).slice(0, 120) : undefined,
    reproducible: provenance.reproducible === true ? true : undefined,
    commandHash: provenance.commandHash != null ? String(provenance.commandHash).slice(0, 64) : undefined,
  }
  // drop undefined keys so JSON stays compact
  for (const k of Object.keys(ev.provenance)) if (ev.provenance[k] === undefined) delete ev.provenance[k]
  if (!Object.keys(ev.provenance).length) delete ev.provenance
  return ev
}

/** Convert a v32 index (`{ files: { rel: { mtime } } }`) into the writes ledger `isStale` expects. Empty/missing index → {}. */
export function writesFromIndex(idx) {
  const out = {}
  const files = idx && idx.files && typeof idx.files === "object" && !Array.isArray(idx.files) ? idx.files : null
  if (!files) return out
  for (const [rel, rec] of Object.entries(files)) {
    const m = Number(rec?.mtime)
    if (Number.isFinite(m) && m > 0) out[String(rel)] = m
  }
  return out
}

export function markStale(ev) {
  return { ...ev, kind: KIND.STALE, confidence: 0 }
}

export function createEvidenceLog() {
  const items = []
  function record(ev) {
    items.push(ev)
    return ev
  }
  function invalidate(writes) {
    for (let i = 0; i < items.length; i++) {
      if (isStale(items[i], writes) && items[i].kind !== KIND.STALE) items[i] = markStale(items[i])
    }
  }
  function ofKind(kind) {
    return items.filter((e) => e.kind === kind)
  }
  function snapshot() {
    return items.map((e) => ({ ...e, files: [...(e.files || [])] }))
  }
  return { record, invalidate, ofKind, snapshot, get length() { return items.length } }
}

function asFiles(files) {
  return (Array.isArray(files) ? files : [files]).map((f) => String(f || "")).filter(Boolean).slice(0, 32)
}
function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}
