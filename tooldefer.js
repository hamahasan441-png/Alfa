/**
 * forge — deferred tool schemas (v207, zero dependencies)
 *
 * Measured on a real headless run (read → test → edit → test, nine requests):
 * the 34 tool schemas were ~5.6k tokens of every request — 56–74% of it —
 * while the tools a coding run actually calls (bash, read/write/edit,
 * grep/glob/list, todo) are ~1.3k. Every request paid for `runtime`,
 * `browser`, `plan_whatif`, `memory`, `process`, … whether or not the run
 * ever touched them.
 *
 * The open-source agents that keep requests small do not send what is not in
 * use: Claude Code defers tools behind a search (the model sees names, loads
 * a schema when it needs it); Codex CLI ships a deliberately tiny set. Here:
 *
 *   - CORE tools are always offered;
 *   - every other built-in is DEFERRED: its name and a few words ride on the
 *     one `load_tools` schema, and `load_tools({ names })` adds the full
 *     schemas to every later request of the run (sticky);
 *   - a deferred tool the task names is offered from the start, and so is
 *     `delegate` on LARGE / ARCHITECTURAL work;
 *   - a deferred tool the model calls directly still RUNS (the executor never
 *     depended on what was offered) and is loaded from then on.
 *
 * Offering is not authority: the executor, the governor's masking and every
 * permission are exactly as before. Plugins (skills, MCP, created tools) are
 * already chosen per task (capindex / selectPlugins) and are not deferred.
 * `agent.deferTools: false` offers everything, as before v207.
 */

export const LOAD_TOOLS = "load_tools"

/** Always offered: what an ordinary coding run calls. */
export const CORE_TOOLS = new Set([
  "bash", "read_file", "write_file", "edit_file", "multi_edit", "apply_patch",
  "list_dir", "grep_files", "glob_files", "todo", "think", "load_skill",
  "git_status", "git_diff",
])

/** A few words about a tool, from its own description — never invented. */
export function toolBlurb(def) {
  const d = String(def?.function?.description ?? "").replace(/\s+/g, " ").trim()
  const first = d.split(/(?<=[.;:])\s|\s[—–-]\s/)[0] || d
  return first.length > 56 ? `${first.slice(0, 53).trimEnd()}…` : first.replace(/[.;:]$/, "")
}

/** The `load_tools` schema, listing what it can load. */
export function loadToolsDef(deferredDefs = []) {
  const list = deferredDefs.map((d) => `${d.function.name} (${toolBlurb(d)})`).join("; ")
  return {
    type: "function",
    function: {
      name: LOAD_TOOLS,
      description: `Load more tools into this run; they stay available for the rest of it. Available: ${list}.`,
      parameters: {
        type: "object",
        properties: { names: { type: "array", items: { type: "string" }, description: "tool names to load" } },
        required: ["names"],
      },
    },
  }
}

/** Does the task text name this tool (as a word)? */
export function taskNamesTool(task, name) {
  const n = String(name ?? "").toLowerCase()
  if (!n) return false
  const t = String(task ?? "").toLowerCase()
  const words = [n, n.replace(/_/g, " ")]
  return words.some((w) => new RegExp(`(^|[^a-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`).test(t))
}

/**
 * Split an offered tool list into what goes on the wire now.
 *
 * @param defs      the run's tool defs (built-ins + plugins), already filtered for mode
 * @param loaded    Set of deferred names loaded so far (load_tools, or a direct call)
 * @param builtins  Set of built-in names (only these are ever deferred)
 * @param task      the task text (a tool it names is offered from the start)
 * @param preload   extra names to offer from the start
 * @returns { offered, deferred } — offered includes load_tools when anything is deferred
 */
export function deferDefs(defs = [], { loaded = new Set(), builtins = new Set(), task = "", preload = [] } = {}) {
  const pre = new Set(preload)
  const offered = []
  const deferred = []
  for (const d of Array.isArray(defs) ? defs : []) {
    const name = d?.function?.name
    if (!name || !builtins.has(name) || CORE_TOOLS.has(name) || loaded.has(name) || pre.has(name) || taskNamesTool(task, name)) offered.push(d)
    else deferred.push(d)
  }
  if (deferred.length) offered.push(loadToolsDef(deferred))
  return { offered, deferred }
}

/**
 * Handle a `load_tools` call: add the known deferred names to `loaded`.
 * Returns the tool result text.
 */
export function handleLoadTools(args, { deferredNames = [], loaded, offeredNames = [] } = {}) {
  const raw = Array.isArray(args?.names) ? args.names : typeof args?.names === "string" ? args.names.split(/[,\s]+/) : []
  const names = [...new Set(raw.map((n) => String(n).trim()).filter(Boolean))].slice(0, 20)
  if (!names.length) return `ERROR: load_tools needs names — available: ${deferredNames.join(", ") || "(none)"}`
  const deferredSet = new Set(deferredNames)
  const offeredSet = new Set(offeredNames)
  const got = [], already = [], unknown = []
  for (const n of names) {
    if (deferredSet.has(n)) { loaded.add(n); got.push(n) }
    else if (offeredSet.has(n) || loaded.has(n)) already.push(n)
    else unknown.push(n)
  }
  const parts = []
  if (got.length) parts.push(`loaded: ${got.join(", ")} — available from your next call on`)
  if (already.length) parts.push(`already available: ${already.join(", ")}`)
  if (unknown.length) parts.push(`no such tool: ${unknown.join(", ")} (loadable: ${deferredNames.filter((n) => !loaded.has(n)).join(", ") || "none left"})`)
  return parts.join("\n")
}
