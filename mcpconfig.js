/**
 * forge — MCP configuration and cached inventory, readable without the MCP
 * client (v179).
 *
 * Every agent run asked two small questions of mcp.js — "are any servers
 * configured?" and "what tools does the cached inventory list?" — and a
 * namespaced tool name was parsed back by the capability fabric. Answering
 * them loaded the whole MCP client (~110KB and its graph) at boot, on every
 * run, including the many with no MCP servers at all. mcp.js imports these
 * from here and re-exports them: one implementation.
 */
import pathMod from "node:path"
import fsMod from "node:fs"
import { resolveDataDir } from "./config.js"

/** The configured, enabled servers, as [name, spec] pairs. */
export function configuredServers(config) {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers).filter(([, s]) => s && typeof s === "object" && s.disabled !== true && (s.command || s.url))
}

/** Parse a namespaced name back to { server, tool }, or null if not one of ours. */
export function parseMcpToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ""))
  return m ? { server: m[1], tool: m[2] } : null
}

export function inventoryPath() {
  return pathMod.join(resolveDataDir(), "cache", "mcp-tools.json")
}

export function loadInventoryFile() {
  try {
    const j = JSON.parse(fsMod.readFileSync(inventoryPath(), "utf8"))
    if (j && j.v === 1 && j.servers && typeof j.servers === "object") return j
  } catch { /* absent/corrupt → cold cache */ }
  return { v: 1, servers: {} }
}

/** v97 §33: read-only view of the CACHED MCP tool inventory for capability
 *  resolution (the unified ladder). Never connects; a cold cache is an empty
 *  list, honestly. [{ server, tool, description }] */
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
