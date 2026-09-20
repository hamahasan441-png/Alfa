/**
 * forge — Node's network stack, loaded when a socket is actually opened.
 *
 * WHY THIS MODULE EXISTS (v134)
 *
 * Importing `node:http` costs 46ms in a fresh process; `node:https` 19ms,
 * `node:net` 10ms, `node:dns/promises` 2ms — measured best-of-5 against a
 * 22-27ms bare node. Three modules on the agent's boot path imported them at
 * MODULE SCOPE:
 *
 *     netguard.js         dns, http, https, net     52ms
 *     runtimesession.js   http, net
 *     browser.js          net
 *
 * netguard is worse than it looks: it is in the shared core that all eight of
 * agent.js's heavy entry points reach (context, capabilities, caproute,
 * router, compose, toolintel, tools, mcp), so every single forge run paid for
 * the HTTP stack — including the majority that never open a socket.
 *
 * v130 tried to cut boot cost by lazy-importing tools.js from agent.js, saw no
 * change, and concluded "the cost is the tree, not the edge". Right about the
 * edge, wrong about where the tree's weight sat: not spread across 106
 * modules, but in four builtins at the root.
 *
 * §36 — one implementation. Three copies of a memoized loader would be three
 * places to get the concurrency wrong, and the first thing to get wrong is
 * exactly that: two parallel callers must share ONE in-flight import and must
 * never observe a half-assigned set.
 *
 * This module imports nothing itself, so importing it is free.
 */

let loaded = null
let inflight = null

/**
 * @returns {Promise<{dns: any, http: any, https: any, net: any}>}
 * Resolves the same object every time; concurrent callers share one import.
 */
export async function loadNetworkStack() {
  if (loaded) return loaded
  inflight ??= Promise.all([
    import("node:dns/promises"), import("node:http"), import("node:https"), import("node:net"),
  ]).then(([d, h, s, n]) => {
    loaded = { dns: d.default ?? d, http: h.default ?? h, https: s.default ?? s, net: n.default ?? n }
    return loaded
  }).catch((e) => { inflight = null; throw e })   // a failed load must be retryable
  return inflight
}

/** The already-loaded stack, or null. For a sync path that a caller has
 *  guaranteed is preceded by `loadNetworkStack()` — it never loads on its own,
 *  so it can never hide a missing await behind a silent import. */
export function networkStack() { return loaded }
