/**
 * forge — what the browser tool's actions do, decided without loading it (v179).
 *
 * The tool layer classifies every call before it runs (does it write files?
 * may a verification step use it?). Those answers lived in browser.js, so
 * every agent run loaded the whole browser driver (~40KB and its graph) at
 * boot to answer three one-line questions about a tool most runs never call.
 * browser.js imports these from here and re-exports them: one implementation.
 */
export const ACTIONS = Object.freeze([
  "open", "snapshot", "click", "fill", "type", "press",
  "screenshot", "scroll", "back", "reload", "close", "status", "errors", "visual_diff",
])
export const VERIFY_ACTIONS = Object.freeze(["open", "snapshot", "screenshot", "status", "close", "reload", "back", "errors", "visual_diff"])
export const PAGE_MUTATING = Object.freeze(["click", "fill", "type", "press", "scroll"])

export function isPageMutating(action) {
  return PAGE_MUTATING.includes(String(action || "").toLowerCase())
}

export function isVerifyAction(action) {
  return VERIFY_ACTIONS.includes(String(action || "").toLowerCase())
}

/** Screenshot-with-path is a filesystem write; everything else is the page. */
export function browserMutatesFilesystem(args = {}) {
  const action = String(args.action || "").toLowerCase()
  if (action !== "screenshot") return false
  return !!String(args.path || "").trim()
}
