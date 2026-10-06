/**
 * forge — the parts of MCP the agent needs before any server is contacted.
 *
 * mcp.js is the full client (transports, the handshake, the legacy SSE
 * fallback, lazy connection, elicitation): 120 KB that only a run with MCP
 * servers configured ever uses. These four helpers are what the startup path
 * actually calls — naming a tool, listing configured servers, and the cached
 * tool inventory the system prompt shows — so they live here and the client
 * loads when a server is really used. mcp.js re-exports them.
 */
import { loadBuiltin } from "./lazybuiltin.js"
import path from "node:path"
import { resolveDataDir } from "./config.js"

const fs = loadBuiltin("fs")

/** "mcp__server__tool" → { server, tool } (null when it is not an MCP name). */
export function parseMcpToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ""))
  return m ? { server: m[1], tool: m[2] } : null
}

/** The enabled MCP servers in a config, as [name, spec] pairs. */
export function configuredServers(config) {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers).filter(([, s]) => s && typeof s === "object" && s.disabled !== true && (s.command || s.url))
}

/** Where the cached tool inventory lives (forge's data folder). */
export function inventoryPath() {
  return path.join(resolveDataDir(), "cache", "mcp-tools.json")
}

/** The cached inventory file ({ v: 1, servers }), or an empty one. */
export function loadInventoryFile() {
  try {
    const j = JSON.parse(fs.readFileSync(inventoryPath(), "utf8"))
    if (j && j.v === 1 && j.servers && typeof j.servers === "object") return j
  } catch { /* absent/corrupt → cold cache */ }
  return { v: 1, servers: {} }
}

/** Every cached tool, for the system prompt — read-only, best-effort. */
export function cachedInventoryTools() {
  const out = []
  try {
    const inv = loadInventoryFile()
    for (const entry of Object.values(inv.servers ?? {})) {
      for (const t of entry.tools ?? []) {
        out.push({ server: entry.name ?? null, tool: t?.name, description: t?.description ?? "" })
      }
    }
  } catch { /* read-only, best-effort */ }
  return out.slice(0, 256)
}
