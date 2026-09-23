/**
 * forge — handing a URL to the USER's browser, safely (zero dependencies)
 *
 * Not to be confused with `browser.js`, which is the opposite direction:
 * that module drives a headless chromium so forge can VERIFY a UI, reading
 * the page, screenshotting it, clicking things. This module hands a url to
 * the human's own browser and then knows nothing further — no page, no
 * screenshot, no reading. Two modules, two responsibilities, and the reason
 * they cannot share a url checker is that they are asking different
 * questions: `browser.js:validateTarget` asks "may forge FETCH this",
 * `inspectUrl` asks "may forge ask the operating system to LAUNCH this",
 * which is narrower (no file:, no mailto:) and does not involve resolving
 * anything.
 *
 * One caller today (MCP url-mode elicitation) and a list of MUSTs from its
 * specification that are really just the rules for showing anyone a link
 * somebody else chose:
 *
 *   MUST NOT automatically pre-fetch the URL or any of its metadata
 *   MUST NOT open it without explicit consent from the user
 *   MUST show the full URL for examination before consent
 *   MUST open it in a way that lets neither the client nor the model inspect
 *       the page or what the user types into it
 *   SHOULD highlight the domain, to blunt subdomain spoofing
 *   SHOULD warn on ambiguous URIs (Punycode)
 *
 * So this module NEVER fetches. It parses, it describes, and — once somebody
 * else has obtained consent — it hands the string to the operating system's
 * own handler and forgets it. There is no code path here that reads a
 * response, because the absence of one is the guarantee.
 *
 * ── On Punycode, and why the ugly form is the honest one ────────────────────
 * `new URL()` gives back the ASCII form: `https://pаypal.com` (with a
 * Cyrillic а) arrives as `https://xn--pypal-4ve.com`. It would be friendlier
 * to decode that for display. It would also be exactly wrong — the decoded
 * form is the spoof, and rendering it is the attack working. forge shows the
 * `xn--` form and says why, which is unpleasant to read and impossible to
 * misread.
 *
 * ── On schemes ──────────────────────────────────────────────────────────────
 * https only, plus http on the loopback so a server being developed locally
 * still works. Not `file:`, not `mailto:`, and certainly not the handler
 * schemes an OS will happily execute: `safeUrl` in osc.js is about what a
 * TERMINAL may be told, which is a different and wider question than what
 * forge may ask an operating system to launch.
 */
import { spawn } from "node:child_process"
import { childEnv } from "./childenv.js"

/** A URL longer than this is a payload, not a link someone will read. */
export const MAX_URL = 2048

/** Why a URL was refused. Each one is a thing a human would want said. */
export const URL_VERDICT = Object.freeze({
  OK: "ok",
  MALFORMED: "malformed",
  TOO_LONG: "too-long",
  BAD_SCHEME: "bad-scheme",
  CONTROL_CHARS: "control-chars",
  CREDENTIALS: "credentials",
})

/**
 * What a human needs to know before consenting to open this.
 *
 * Never throws, never fetches. Returns `{ ok, verdict, href, host, punycode,
 * reason }` — `href` is the NORMALIZED url, which is the only form that
 * should ever be printed: whatever escapes, newlines or bidi marks were in
 * the original cannot survive `new URL()` and re-serialization.
 */
export function inspectUrl(raw) {
  const s = String(raw ?? "").trim()
  const no = (verdict, reason) => ({ ok: false, verdict, reason, href: null, host: null, punycode: false })
  if (!s) return no(URL_VERDICT.MALFORMED, "no url was given")
  if (s.length > MAX_URL) return no(URL_VERDICT.TOO_LONG, `the url is ${s.length} characters long`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return no(URL_VERDICT.CONTROL_CHARS, "the url contains control characters")
  let u
  try { u = new URL(s) } catch { return no(URL_VERDICT.MALFORMED, "the url could not be parsed") }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1"
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    return no(URL_VERDICT.BAD_SCHEME, `forge opens https links only (this one is "${u.protocol.replace(/:$/, "")}")`)
  }
  // A url carrying a username or password is either a credential the server
  // should not have put there or a display trick (`https://trusted.com@evil`).
  if (u.username || u.password) return no(URL_VERDICT.CREDENTIALS, "the url embeds credentials")
  const punycode = u.hostname.split(".").some((label) => label.startsWith("xn--"))
  return { ok: true, verdict: URL_VERDICT.OK, reason: "", href: u.href, host: u.hostname, punycode }
}

/**
 * The lines a user reads before answering "may I open this?".
 *
 * The host is on its own line rather than left inside the href, because a
 * URL long enough to push the domain off the right edge of a terminal is the
 * whole of subdomain spoofing. Plain strings, no styling: the caller owns how
 * these are presented, and this stays testable as text.
 */
export function describeUrl(inspected) {
  if (!inspected?.ok) return []
  const out = [`  url:    ${inspected.href}`, `  domain: ${inspected.host}`]
  if (inspected.punycode) {
    out.push("  WARNING: this domain is written in Punycode (xn--). It may be")
    out.push("           a look-alike of a name you recognize. The form above")
    out.push("           is the real one; a prettier spelling would be the trick.")
  }
  return out
}

/** The platform's own URL handler, as argv. `null` where forge knows of none. */
function openerFor(platform = process.platform) {
  if (platform === "darwin") return ["open"]
  if (platform === "win32") {
    // NOT `cmd /c start`: cmd re-parses its arguments, so a `&` in a query
    // string becomes a command separator. rundll32 takes the url as one
    // argument and does no parsing of its own.
    return ["rundll32.exe", "url.dll,FileProtocolHandler"]
  }
  // Everything else is treated as freedesktop; a missing xdg-open surfaces as
  // a spawn error, which openInBrowser reports rather than throwing.
  return ["xdg-open"]
}

let opener = null

/**
 * Install a different way to open a URL.
 *
 * The same shape as ask.js's asker, for the same reason: a surface that owns
 * the user's session may know better than `xdg-open` does — and a test needs
 * to exercise the whole flow without a browser window appearing. `fn(href)`
 * resolves `{ok, reason}` and is trusted to honour the same guarantee this
 * module does: hand the url over, read nothing back.
 */
export function setUrlOpener(fn) {
  opener = typeof fn === "function" ? fn : null
  return opener
}

/** Restore the platform opener. */
export function clearUrlOpener() {
  opener = null
}

/**
 * Is there anything to open a URL with?
 *
 * This is what a CAPABILITY must be gated on. Declaring url-mode support
 * without an opener would leave forge unable to meet the spec's "MUST open
 * the URL in a secure manner", and a server is entitled to ask for whatever
 * the client declares.
 */
export function canOpenBrowser(platform = process.platform, env = process.env) {
  if (opener) return true
  if (String(env.FORGE_NO_BROWSER ?? "") === "1") return false
  // A machine with no display has no browser to hand this to. DISPLAY or
  // WAYLAND_DISPLAY is what xdg-open itself needs; macOS and Windows always
  // have a handler.
  if (platform !== "darwin" && platform !== "win32") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  }
  return openerFor(platform) !== null
}

/**
 * Hand `href` to the operating system's handler.
 *
 * Detached with every stdio stream ignored, and unref'd — forge does not wait
 * for it, does not read from it, and does not keep the process alive for it.
 * That is not tidiness: "the client must not be able to inspect the content
 * or the user's inputs" is the requirement, and having no pipe is how it is
 * met rather than promised.
 *
 * @returns {Promise<{ok: boolean, reason: string}>} — never throws.
 */
export function openInBrowser(href, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const checked = inspectUrl(href)
    // Re-inspected here on purpose. This function is the last thing between a
    // string and the user's operating system, and a caller that forgot to
    // check is exactly the caller this has to survive. An installed opener is
    // held to the SAME vetting — it is another way to open a url, not a way
    // to open a different set of them.
    if (!checked.ok) return resolve({ ok: false, reason: checked.reason })
    if (opener) {
      return Promise.resolve()
        .then(() => opener(checked.href))
        .then((r) => resolve({ ok: r?.ok === true, reason: String(r?.reason ?? "") }))
        .catch((e) => resolve({ ok: false, reason: String(e?.message ?? e).slice(0, 200) }))
    }
    if (!canOpenBrowser(platform, env)) return resolve({ ok: false, reason: "no browser is available on this machine" })
    const argv = openerFor(platform)
    let child
    try {
      child = spawnFn(argv[0], [...argv.slice(1), checked.href], {
        detached: true,
        stdio: "ignore",
        env: childEnv({}, env),
      })
    } catch (e) {
      return resolve({ ok: false, reason: String(e?.message ?? e).slice(0, 200) })
    }
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    child.once?.("error", (e) => done({ ok: false, reason: String(e?.message ?? e).slice(0, 200) }))
    try { child.unref?.() } catch { /* a handler that cannot be unref'd still opened */ }
    // A spawn error arrives asynchronously, so give it one turn before calling
    // this a success. Longer would mean waiting on a browser to start, which
    // is neither forge's business nor bounded.
    //
    // Deliberately NOT unref'd, which is the opposite of the child above. The
    // child must not hold forge open; this timer is the only thing that will
    // ever settle the promise, and unref'ing it let the process exit with the
    // await still pending — which is how this comment came to be written.
    setTimeout(() => done({ ok: true, reason: "" }), 50)
  })
}
