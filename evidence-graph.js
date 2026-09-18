/**
 * forge — bounded evidence graph (v130 alpha)
 *
 * Keeps claims, actions, observations and verification artifacts connected.
 * This is additive to evidence.js: the graph indexes provenance; it does not
 * upgrade a claim's trust level by itself.
 */
function idOf(prefix, n) { return `${prefix}-${Date.now().toString(36)}-${n.toString(36)}` }
function text(v, max = 500) { return String(v ?? "").slice(0, max) }

export function recordVerificationEvent(graph, event = {}) {
  if (!graph || typeof graph.addNode !== "function") return null
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

  function addNode(type, value, meta = {}) {
    const id = text(meta.id || idOf("ev", ++seq), 120)
    nodes.set(id, { id, type: text(type, 40), value, at: Number(meta.at) || Date.now(), status: text(meta.status || "ACTIVE", 40), files: Array.isArray(meta.files) ? meta.files.slice(0, 32).map((x) => text(x, 500)) : [] })
    while (nodes.size > maxNodes) nodes.delete(nodes.keys().next().value)
    return id
  }

  function link(from, to, relation = "supports") {
    if (!nodes.has(from) || !nodes.has(to)) return false
    edges.push({ from, to, relation: text(relation, 60), at: Date.now() })
    while (edges.length > maxEdges) edges.shift()
    return true
  }

  function staleFiles(files = []) {
    const changed = new Set((Array.isArray(files) ? files : [files]).map((x) => text(x, 500)).filter(Boolean))
    let count = 0
    for (const node of nodes.values()) {
      if (node.files.some((f) => changed.has(f)) && node.status === "ACTIVE") {
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
