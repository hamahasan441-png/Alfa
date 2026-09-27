/**
 * forge — the MCP coding core (v217, zero dependencies)
 *
 * The vendored catalog (mcpcatalog.generated.js) is the top 100 of a registry
 * dump ranked by registry score, and for a coding agent most of it is noise:
 * a wine registry, an expense tracker, a podcast, a petstore. The servers a
 * coding agent actually reaches for were not in it at all, so a "testing" gap
 * recommended `petstore` and a "git" gap recommended an email server.
 *
 * This is the short list that matters, kept by hand:
 *   - every launch spec is PINNED to a version that was checked against its
 *     registry (npm / PyPI) and connected through forge's own MCP client
 *     before it was written down (v217: all nine listed their tools);
 *   - every homepage is the upstream GitHub repository;
 *   - credentials are environment REFERENCES, never values;
 *   - `nativeOverlap` names the built-in tools that already do the job, so a
 *     recommendation never pushes a server forge does not need.
 *
 * Nothing here connects to or installs anything. `forge mcp add <name>` is
 * still one explicit user action per server.
 */
import fs from "node:fs"
import path from "node:path"
import { catalogEntry as generatedEntry } from "./mcpcatalog.js"

const GITHUB = generatedEntry("github")

/** The coding core, most broadly useful first. */
export const MCP_CORE = Object.freeze([
  {
    name: "context7", aliases: ["upstash/context7", "@upstash/context7-mcp"], category: "docs",
    desc: "Current, version-specific library documentation and examples, pulled on demand — instead of what the model half-remembers.",
    homepage: "https://github.com/upstash/context7", version: "4.1.1", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "@upstash/context7-mcp@4.1.1"], env: {},
    capabilities: ["documentation", "web_search"], nativeOverlap: [],
  },
  {
    name: "playwright", aliases: ["microsoft/playwright-mcp", "@playwright/mcp"], category: "browser",
    desc: "Drive a real browser through its accessibility tree: navigate, click, fill, read the console, take screenshots — for testing a web UI.",
    homepage: "https://github.com/microsoft/playwright-mcp", version: "0.0.82", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "@playwright/mcp@0.0.82", "--headless"], env: {},
    capabilities: ["browser"], nativeOverlap: ["browser"],
  },
  {
    name: "chrome-devtools", aliases: ["ChromeDevTools/chrome-devtools-mcp", "chrome-devtools-mcp"], category: "browser",
    desc: "Chrome DevTools for the agent: performance traces, network requests, console messages and page automation.",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp", version: "1.10.1", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--headless"], env: {},
    capabilities: ["browser", "performance"], nativeOverlap: ["browser"],
  },
  { ...GITHUB, capabilities: ["vcs_hosting", "issues", "pull_requests", "ci"], nativeOverlap: ["github"] },
  {
    name: "git", aliases: ["mcp-server-git"], category: "dev",
    desc: "The reference git server: status, diffs, log, branches, commits.",
    homepage: "https://github.com/modelcontextprotocol/servers", version: "2026.8.18", runtime: "python", transport: "stdio",
    command: "uvx", args: ["mcp-server-git==2026.8.18", "--repository", "."], env: {},
    capabilities: ["vcs_inspection"], nativeOverlap: ["git_status", "git_diff", "git_log", "git_blame"],
  },
  {
    name: "fetch", aliases: ["mcp-server-fetch"], category: "web",
    desc: "The reference fetch server: a web page as clean markdown, in chunks.",
    homepage: "https://github.com/modelcontextprotocol/servers", version: "2026.8.18", runtime: "python", transport: "stdio",
    command: "uvx", args: ["mcp-server-fetch==2026.8.18"], env: {},
    capabilities: ["network_fetch"], nativeOverlap: ["fetch_url"],
  },
  {
    name: "filesystem", aliases: ["@modelcontextprotocol/server-filesystem"], category: "dev",
    desc: "The reference filesystem server, confined to the directories it is given.",
    homepage: "https://github.com/modelcontextprotocol/servers", version: "2026.8.31", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "."], env: {},
    capabilities: ["file_read", "file_editing", "file_create"], nativeOverlap: ["read_file", "write_file", "edit_file"],
  },
  {
    name: "memory", aliases: ["@modelcontextprotocol/server-memory"], category: "memory",
    desc: "The reference knowledge-graph memory server: entities, relations, observations.",
    homepage: "https://github.com/modelcontextprotocol/servers", version: "2026.8.31", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2026.8.31"], env: {},
    capabilities: ["memory_write"], nativeOverlap: ["memory"],
  },
  {
    name: "sequential-thinking", aliases: ["@modelcontextprotocol/server-sequential-thinking"], category: "reasoning",
    desc: "The reference step-by-step reasoning server.",
    homepage: "https://github.com/modelcontextprotocol/servers", version: "2026.8.31", runtime: "node", transport: "stdio",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.8.31"], env: {},
    capabilities: ["reasoning"], nativeOverlap: ["think"],
  },
].map((e) => Object.freeze({ core: true, ...e })))

const norm = (v) => String(v ?? "").trim().toLowerCase()

/** A core entry by name or alias. */
export function coreEntry(name) {
  const w = norm(name)
  if (!w) return null
  return MCP_CORE.find((e) => norm(e.name) === w || (e.aliases || []).some((a) => norm(a) === w)) ?? null
}

/** Any server forge knows: the coding core first, then the generated catalog. */
export function findServer(name) {
  return coreEntry(name) ?? generatedEntry(name)
}

/**
 * Core servers that provide a capability. With `nativeTools`, a server whose
 * whole job a native tool already does is left out — a gap means the native
 * is missing, so overlap is only a reason to skip when the native is there.
 */
export function coreForCapability(capability, { nativeTools = null } = {}) {
  const c = norm(capability).replace(/[\s-]+/g, "_")
  if (!c) return []
  return MCP_CORE.filter((e) => e.capabilities.some((k) => k === c || k.startsWith(c) || c.startsWith(k)))
    .filter((e) => !nativeTools || !e.nativeOverlap.length || !e.nativeOverlap.every((t) => nativeTools.has(t)))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

const WEB_DEPS = /^(react|react-dom|vue|svelte|@sveltejs\/kit|next|nuxt|@angular\/core|vite|solid-js|preact|astro|@remix-run\/react|lit)$/

/**
 * Which core servers fit THIS project, and why — read from the project's own
 * files, never guessed. Servers that only duplicate a native tool are not
 * recommended (they stay listed in `forge mcp catalog`).
 */
export function recommendForProject(cwd = process.cwd()) {
  const out = []
  const why = (name, reason) => { const e = coreEntry(name); if (e && !out.some((r) => r.entry.name === name)) out.push({ entry: e, reason }) }
  const pkg = readJson(path.join(cwd, "package.json"))
  const deps = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }) : []
  const has = (f) => { try { return fs.existsSync(path.join(cwd, f)) } catch { return false } }
  const manifests = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle"].filter(has)
  const web = deps.filter((d) => WEB_DEPS.test(d))
  if (web.length) {
    why("playwright", `a web frontend (${web.slice(0, 3).join(", ")}) — test the UI in a real browser`)
    why("chrome-devtools", "a web frontend — performance traces, network and console")
  }
  const depCount = deps.length || (manifests.some((m) => m !== "package.json") ? 1 : 0)
  if (depCount) why("context7", `the project depends on libraries (${manifests.join(", ")}) — current docs instead of recalled ones`)
  try {
    const cfg = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8")
    if (/url\s*=\s*\S*github\.com[:/]/i.test(cfg)) why("github", "the origin is on GitHub — issues, pull requests and Actions runs")
  } catch { /* not a git checkout */ }
  return out
}
