#!/usr/bin/env node
/**
 * forge v144 — handing a URL to the USER's browser (openurl.js).
 *
 * MCP url-mode elicitation exists because form mode is FORBIDDEN from
 * carrying the things servers most often need: the spec says a server MUST
 * NOT request passwords, API keys, access tokens or payment credentials in a
 * form, and MUST use url mode for those. Without url mode a server needing a
 * credential has no route to the user at all.
 *
 * What it costs is a list of client MUSTs, and every one of them is really
 * just the rule for showing anyone a link somebody else chose:
 *
 *   MUST NOT pre-fetch the url or any of its metadata
 *   MUST NOT open it without explicit consent
 *   MUST show the full url before consent
 *   MUST open it where neither the client nor the model can read the page
 *   SHOULD highlight the domain (subdomain spoofing)
 *   SHOULD warn on Punycode
 *
 * The first and the fourth are guarantees about code that does NOT exist, so
 * they are tested as such: a real HTTP server that must record zero requests,
 * and a spawn whose stdio is asserted to be `ignore`. An assertion that
 * "forge did not fetch" is only worth anything against a server that would
 * have noticed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-browser-"))
process.env.FORGE_HOME = DIR
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const B = await import("../openurl.js")
const { inspectUrl, describeUrl, openInBrowser, canOpenBrowser, URL_VERDICT, MAX_URL } = B

/** A spawn that records instead of launching. Shaped like a ChildProcess. */
function fakeSpawn() {
  const calls = []
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { once() {}, unref() {} }
  }
  fn.calls = calls
  return fn
}
const GUI = { DISPLAY: ":0" }

console.log("== what forge will and will not open ==")
{
  const good = inspectUrl("https://mcp.example.com/ui/set_api_key?a=1&b=2")
  ok("an https url is fine", good.ok, good.reason)
  eq("…normalized", good.href, "https://mcp.example.com/ui/set_api_key?a=1&b=2")
  eq("…with its host pulled out", good.host, "mcp.example.com")

  eq("http is refused", inspectUrl("http://example.com/x").verdict, URL_VERDICT.BAD_SCHEME)
  ok("…and says why, in words", /https/.test(inspectUrl("http://example.com/x").reason))
  ok("http on the loopback is allowed, for a server being developed locally", inspectUrl("http://localhost:8080/x").ok)
  ok("…and on 127.0.0.1", inspectUrl("http://127.0.0.1:8080/x").ok)

  // The schemes an operating system will happily EXECUTE. osc.js:safeUrl
  // allows file: and mailto: because that is about what a TERMINAL may be
  // told; this is about what forge may ask an OS to launch, which is narrower.
  for (const u of ["file:///etc/passwd", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "ftp://x/y"]) {
    eq(`${u.slice(0, 24)} is refused`, inspectUrl(u).verdict, URL_VERDICT.BAD_SCHEME)
  }

  eq("a url with credentials is refused", inspectUrl("https://trusted.com@evil.example/x").verdict, URL_VERDICT.CREDENTIALS)
  eq("…including a password", inspectUrl("https://u:p@example.com/x").verdict, URL_VERDICT.CREDENTIALS)
  eq("an unparseable url", inspectUrl("not a url").verdict, URL_VERDICT.MALFORMED)
  eq("an empty url", inspectUrl("").verdict, URL_VERDICT.MALFORMED)
  eq("a null url", inspectUrl(null).verdict, URL_VERDICT.MALFORMED)
  eq("a url with a control character", inspectUrl("https://example.com/\u0007x").verdict, URL_VERDICT.CONTROL_CHARS)
  eq("…or an escape sequence", inspectUrl("https://example.com/\u001b[31m").verdict, URL_VERDICT.CONTROL_CHARS)
  eq("an oversized url", inspectUrl("https://example.com/" + "x".repeat(MAX_URL)).verdict, URL_VERDICT.TOO_LONG)
  ok("…and the cap is stated, not implied", MAX_URL > 0)
}

console.log("== what the user is shown ==")
{
  const u = inspectUrl("https://accounts.example.com/oauth/authorize?client_id=abc&scope=read")
  const lines = describeUrl(u)
  ok("the FULL url is shown, not a shortened one", lines.some((l) => l.includes(u.href)), JSON.stringify(lines))
  ok("the domain is on its own line", lines.some((l) => /^\s*domain:\s*accounts\.example\.com$/.test(l)), JSON.stringify(lines))
  ok("no Punycode warning when there is nothing to warn about", !lines.some((l) => /Punycode/.test(l)))
  eq("a refused url describes nothing", describeUrl(inspectUrl("javascript:x")), [])
}

console.log("== Punycode is shown as Punycode, and called out ==")
{
  // `pаypal.com` with a Cyrillic а. `new URL` gives back the ASCII form, and
  // showing that ugly form is the POINT: decoding it back for readability
  // would render the spoof and call it a courtesy.
  const u = inspectUrl("https://pаypal.com/login")
  ok("it parses", u.ok, u.reason)
  ok("the host is the xn-- form", u.host.startsWith("xn--"), u.host)
  ok("…flagged as Punycode", u.punycode === true)
  const lines = describeUrl(u)
  ok("the user is warned", lines.some((l) => /Punycode/.test(l)), JSON.stringify(lines))
  ok("…and the displayed url is the ASCII one, never the look-alike", lines.every((l) => !l.includes("pаypal")))
  ok("a plain ascii domain is not flagged", inspectUrl("https://paypal.com/login").punycode === false)
}

console.log("== the hand-off is a spawn, not a shell ==")
{
  const sp = fakeSpawn()
  const r = await openInBrowser("https://example.com/a?x=1&y=2", { platform: "linux", env: GUI, spawnFn: sp })
  ok("it reports success", r.ok, r.reason)
  eq("one launch", sp.calls.length, 1)
  eq("the freedesktop opener", sp.calls[0].cmd, "xdg-open")
  eq("the url is ONE argument, unparsed", sp.calls[0].args, ["https://example.com/a?x=1&y=2"])
  ok("…so an & in the query is not a command separator", sp.calls[0].args[0].includes("&"))
  ok("no shell is involved", sp.calls[0].opts.shell !== true)

  // "the client must not be able to inspect the content or the user's
  // inputs" — having no pipe is how that is met rather than promised.
  eq("every stdio stream is ignored", sp.calls[0].opts.stdio, "ignore")
  ok("it is detached", sp.calls[0].opts.detached === true)
  ok("the child gets a scrubbed environment, not forge's", !("FORGE_HOME" in (sp.calls[0].opts.env ?? {})), JSON.stringify(Object.keys(sp.calls[0].opts.env ?? {}).slice(0, 8)))

  const mac = fakeSpawn()
  await openInBrowser("https://example.com/", { platform: "darwin", env: {}, spawnFn: mac })
  eq("macOS uses open", mac.calls[0]?.cmd, "open")

  const win = fakeSpawn()
  await openInBrowser("https://example.com/a?x=1&y=2", { platform: "win32", env: {}, spawnFn: win })
  eq("Windows uses rundll32, NOT `cmd /c start`", win.calls[0]?.cmd, "rundll32.exe")
  ok("…because cmd would re-parse the & in a query string", win.calls[0].args[0] === "url.dll,FileProtocolHandler")
  eq("…and the url stays one argument", win.calls[0].args[1], "https://example.com/a?x=1&y=2")
}

console.log("== a url that was never vetted still does not reach the OS ==")
{
  // openInBrowser re-inspects. The caller that forgot to check is exactly the
  // caller this has to survive, so the guard cannot live only at the call site.
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://example.com/x", "https://u:p@evil.example/", "nonsense"]) {
    const sp = fakeSpawn()
    const r = await openInBrowser(bad, { platform: "linux", env: GUI, spawnFn: sp })
    ok(`${bad.slice(0, 22)} → refused`, !r.ok && sp.calls.length === 0, `${r.ok} / ${sp.calls.length} spawns`)
  }
}

console.log("== no browser, no promise ==")
{
  ok("a headless linux box cannot open a url", !canOpenBrowser("linux", {}))
  ok("…DISPLAY is enough", canOpenBrowser("linux", { DISPLAY: ":0" }))
  ok("…and so is wayland", canOpenBrowser("linux", { WAYLAND_DISPLAY: "wayland-0" }))
  ok("macOS always can", canOpenBrowser("darwin", {}))
  ok("Windows always can", canOpenBrowser("win32", {}))
  ok("FORGE_NO_BROWSER=1 turns it off everywhere", !canOpenBrowser("darwin", { FORGE_NO_BROWSER: "1" }))
  const sp = fakeSpawn()
  const r = await openInBrowser("https://example.com/", { platform: "linux", env: {}, spawnFn: sp })
  ok("…and openInBrowser refuses rather than spawning into the void", !r.ok && sp.calls.length === 0)
  ok("…saying so", /no browser/.test(r.reason), r.reason)
}

console.log("== a spawn that fails is reported, never thrown ==")
{
  const throwing = () => { throw new Error("ENOENT xdg-open") }
  const r = await openInBrowser("https://example.com/", { platform: "linux", env: GUI, spawnFn: throwing })
  ok("it resolves false instead of throwing", r.ok === false)
  ok("…with the reason", /ENOENT/.test(r.reason), r.reason)
  const erroring = () => ({ once: (ev, fn) => { if (ev === "error") setTimeout(() => fn(new Error("EACCES")), 1) }, unref() {} })
  const r2 = await openInBrowser("https://example.com/", { platform: "linux", env: GUI, spawnFn: erroring })
  ok("an ASYNC spawn error is caught too", r2.ok === false, JSON.stringify(r2))
  ok("…with its reason", /EACCES/.test(r2.reason), r2.reason)
}

console.log("== nothing here ever fetches ==")
{
  // The strongest form of this assertion is a server that WOULD have noticed.
  const hits = []
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200).end("<title>anything</title>") })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${srv.address().port}/secret-token-page`
  const u = inspectUrl(url)
  ok("the loopback url is accepted (so the server is genuinely reachable)", u.ok, u.reason)
  describeUrl(u)
  const sp = fakeSpawn()
  await openInBrowser(url, { platform: "linux", env: GUI, spawnFn: sp })
  await new Promise((r) => setTimeout(r, 150))
  eq("inspect, describe and open made ZERO requests", hits, [])
  ok("…though the url was handed to the opener", sp.calls.length === 1)
  const src = fs.readFileSync(new URL("../openurl.js", import.meta.url), "utf8")
  ok("openurl.js contains no fetch of any kind", !/fetch\(|pinnedFetch|https?\.request|\.get\(/.test(src))
  await new Promise((r) => { try { srv.close(r) } catch { r() } })
}

console.log("== §36: one way to open a url ==")
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const files = fs.readdirSync(root).filter((f) => f.endsWith(".js"))
  const offenders = files.filter((f) => f !== "openurl.js" && /xdg-open|rundll32|url\.dll/.test(fs.readFileSync(path.join(root, f), "utf8")))
  eq("no module outside openurl.js launches the user's browser", offenders, [])
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== openurl suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
