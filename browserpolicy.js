/**
 * forge — browser action policy (Phase 4 boot split, zero dependencies)
 *
 * The pure, synchronous rules about browser actions, split out of browser.js
 * so the tool layer can classify a browser call (does it write a file? does it
 * drive the page? is it a verification action?) WITHOUT loading the whole
 * browser driver at boot. browser.js re-exports every name here, so existing
 * imports keep working.
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
