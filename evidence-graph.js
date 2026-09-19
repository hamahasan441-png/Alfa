/**
 * forge — bounded evidence graph (v130 alpha)
 *
 * Keeps claims, actions, observations and verification artifacts connected.
 * This is additive to evidence.js: the graph indexes provenance; it does not
 * upgrade a claim's trust level by itself.
 */
// v127 §36: the path rule lives in evidence.js — this module compares paths
// for staleness the same way the evidence engine does, rather than keeping a
// second copy that could drift from it.
import { samePath } from "./evidence.js"

function idOf(prefix, n) { return `${prefix}-${Date.now().toString(36)}-${n.toString(36)}` }
function text(v, max = 500) { return String(v ?? "").slice(0, max) }

export function recordVerificationEvent(graph, event = {}) {
  if (!graph || typeof graph.addNode !== "function") return null
  // v127: the `= {}` default only covers `undefined`. publishVerificationEvent
  // builds `ev` from an event object it does not own, so an explicit null
  // reached here and threw on `event.type` — inside a try/catch that swallowed
  // it, so the record was silently lost rather than merely skipped.
  if (event == null || typeof event !== "object") event = {}
  const passed = event.type === "VERIFICATION_PASSED" || event.passed === true
  return graph.addNode("VERIFICATION", {
    type: passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
    command: text(event.command, 300),
    reason: text(event.reason ?? event.evidence, 500),
    exitCode: Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null,
  }, {
    id: event.verificationId ? text(event.verificationId, 120) : undefined,
    status: passed ? "VERIFIED" : "FAILED",
    files: Array.isArray(event.files) ? event.files : [],
  })
}

export function createEvidenceGraph({ maxNodes = 1000, maxEdges = 3000 } = {}) {
  const nodes = new Map()
  const edges = []
  let seq = 0

  /**
   * v127 — evicting a node evicts the edges that referenced it.
   *
   * Eviction used to delete the node and leave its edges behind, so the graph
   * accumulated edges pointing at ids it no longer held. Three consequences,
   * all real:
   *
   *   - `related()` returned edges to nodes that do not exist
   *   - `snapshot()` serialized them
   *   - `restore()` drops them (it checks `nodes.has` on both ends), so
   *     SNAPSHOT → RESTORE WAS NOT A ROUND TRIP
   *
   * cognition.js persists `evidenceGraph.snapshot()` and restores it when a
   * run resumes, so this was provenance quietly lost at exactly the moment it
   * matters. Measured on a 10-node graph pushed 6 nodes past its cap: 9 edges
   * live, 6 of them dangling, 3 surviving a round trip.
   *
   * The `predicts` links cognition draws from a PREDICTION to the ACTION that
   * fulfilled it are the first to go, because the prediction is the older node.
   * That is the edge drift detection is built on.
   */
  function evict(id) {
    nodes.delete(id)
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].from === id || edges[i].to === id) edges.splice(i, 1)
    }
  }

  function addNode(type, value, meta = {}) {
    const id = text(meta.id || idOf("ev", ++seq), 120)
    // v127: re-recording an id refreshes its recency instead of silently
    // keeping the original insertion slot. A Map preserves insertion order and
    // `set` on an existing key does NOT move it, so eviction — which takes the
    // first key — was throwing away the node most recently written to. Both
    // real callers re-use stable ids (recordVerificationEvent with
    // `verificationId`, cognition with `pred.id`), so the record being actively
    // updated was the one most likely to be dropped. Deleting first makes the
    // order least-recently-updated, which is what the eviction assumes.
    // Note: delete, not evict — this node is being kept, so its edges stay.
    nodes.delete(id)
    nodes.set(id, { id, type: text(type, 40), value, at: Number(meta.at) || Date.now(), status: text(meta.status || "ACTIVE", 40), files: Array.isArray(meta.files) ? meta.files.slice(0, 32).map((x) => text(x, 500)) : [] })
    while (nodes.size > maxNodes) evict(nodes.keys().next().value)
    return id
  }

  function link(from, to, relation = "supports") {
    if (!nodes.has(from) || !nodes.has(to)) return false
    edges.push({ from, to, relation: text(relation, 60), at: Date.now() })
    while (edges.length > maxEdges) edges.shift()
    return true
  }

  function staleFiles(files = []) {
    const changed = (Array.isArray(files) ? files : [files]).map((x) => text(x, 500)).filter(Boolean)
    if (!changed.length) return 0
    let count = 0
    for (const node of nodes.values()) {
      if (node.status !== "ACTIVE") continue
      // v127: was an exact Set lookup, so a node recorded with an absolute
      // path was never marked stale by a relative write (or the reverse).
      if (node.files.some((f) => changed.some((c) => samePath(f, c)))) {
        node.status = "STALE"
        count += 1
      }
    }
    return count
  }

  function related(id) {
    const out = []
    for (const e of edges) if (e.from === id || e.to === id) out.push({ ...e })
    return out
  }

  function snapshot() {
    return { schema: "1.0.0", nodes: [...nodes.values()].map((x) => ({ ...x, files: [...x.files] })), edges: edges.map((x) => ({ ...x })) }
  }

  function restore(input) {
    if (!input || typeof input !== "object") return false
    nodes.clear(); edges.length = 0
    if (Array.isArray(input.nodes)) for (const n of input.nodes.slice(-maxNodes)) {
      if (!n?.id) continue
      nodes.set(text(n.id, 120), { id: text(n.id, 120), type: text(n.type, 40), value: n.value, at: Number(n.at) || 0, status: text(n.status || "ACTIVE", 40), files: Array.isArray(n.files) ? n.files.slice(0, 32).map((x) => text(x, 500)) : [] })
    }
    if (Array.isArray(input.edges)) for (const e of input.edges.slice(-maxEdges)) if (nodes.has(e?.from) && nodes.has(e?.to)) edges.push({ from: e.from, to: e.to, relation: text(e.relation, 60), at: Number(e.at) || 0 })
    return true
  }

  return { addNode, link, staleFiles, related, snapshot, restore, get size() { return nodes.size } }
}
