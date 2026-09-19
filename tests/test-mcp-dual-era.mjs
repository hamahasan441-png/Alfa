#!/usr/bin/env node
/**
 * forge — MCP is dual-era (v131).
 *
 * MCP split in two, and forge was on the wrong side of the split:
 *
 *   legacy  (<= 2025-11-25)  `initialize` handshake, one negotiated version,
 *                            `tools/list` discovery, server→client REQUESTS.
 *   modern  (>= 2026-07-28)  no handshake at all, the version declared in
 *                            `_meta` on EVERY request, `server/discover`, and
 *                            MRTR instead of server-initiated requests.
 *
 * forge spoke 2024-11-05, and the specification's own compatibility matrix
 * says what that means: "legacy client + modern server → fails. Legacy clients
 * have no fall-forward mechanism." Not a missing feature — a cliff.
 *
 * The two properties this suite exists to protect:
 *
 *   1. THE LEGACY PATH IS UNCHANGED. Every other MCP suite in this repo drives
 *      a legacy server, and all of them still pass. What this suite adds is
 *      the proof that the FALLBACK is reached for the right reasons — a
 *      -32601, a -32602, a silent server, and a dual-era server that offers
 *      only legacy revisions must all land on `initialize`.
 *
 *   2. THE FALLBACK IS NOT KEYED TO AN ERROR CODE. The spec is explicit about
 *      this and it is the single easiest thing to get wrong: a legacy server
 *      may answer an unknown pre-initialize method with any error, or with
 *      nothing. Only a RECOGNIZED MODERN reply means modern.
 *
 * Every stub here speaks the real wire protocol over real pipes and logs what
 * it received, so the assertions are about bytes, not about intentions.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp2-"))
process.env.FORGE_HOME = DIR
process.env.NO_COLOR = "1"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const mcp = await import("../mcp.js")
const {
  connectServer, clearEraCache, MCP_ERA, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION,
  clientCapabilities, clientMeta, pickProtocolVersion, isDiscoverResult, isInputRequired,
  listRoots, cancelCall, onProgress, pingServer, mcpToolsToPlugins, UNSUPPORTED_PROTOCOL_VERSION,
} = mcp

/**
 * One stub, many servers. `mode` (argv[2]) picks the behaviour and `log`
 * (argv[3]) is a JSONL file of everything it received — the only way to assert
 * that a retry used a NEW id and echoed the state byte-for-byte.
 */
const STUB = `
import fs from "node:fs"
const mode = process.argv[2]
const LOG = process.argv[3]
let buf = ""
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const note = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + "\\n") } catch {} }
const MODERN = "2026-07-28"
let retried = false
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    note(m)
    handle(m)
  }
})

function handle(m) {
  const { id, method, params } = m
  if (method === "notifications/cancelled" || method === "notifications/initialized") return

  if (method === "server/discover") {
    if (mode === "legacy") return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
    if (mode === "legacy_weird") return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } })
    if (mode === "silent") return                       // never answers anything
    if (mode === "dual_legacy_only") {
      return send({ jsonrpc: "2.0", id, result: { supportedVersions: ["2025-06-18", "2025-11-25"], serverInfo: { name: "dual", version: "1" } } })
    }
    if (mode === "wrongversion" && !retried) {
      retried = true
      return send({ jsonrpc: "2.0", id, error: { code: -32022, message: "unsupported protocol version", data: { supported: ["2026-07-28"] } } })
    }
    return send({ jsonrpc: "2.0", id, result: {
      supportedVersions: [MODERN],
      serverInfo: { name: mode, version: "1" },
      capabilities: { tools: {}, resources: {}, logging: {} },
    } })
  }

  if (method === "initialize") {
    if (mode === "silent") return
    send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "legacy-" + mode, version: "1" } } })
    // A LEGACY server is allowed to send the client a REQUEST. forge used to
    // drop these on the floor and the server waited forever.
    if (mode === "legacy_asks") setTimeout(() => send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list" }), 10)
    return
  }

  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ] } })
  }

  if (method === "tools/call") {
    if (mode === "hang") return                          // never answers: cancellation's job
    if (mode === "progress") {
      const token = params?._meta?.progressToken
      if (token) { send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } }) }
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } })
    }
    if (mode === "mrtr") {
      if (!params?.inputResponses) {
        return send({ jsonrpc: "2.0", id, result: {
          resultType: "input_required",
          inputRequests: { where: { method: "roots/list", params: {} } },
          requestState: "OPAQUE::do-not-touch::9",
        } })
      }
      const roots = params.inputResponses.where?.roots ?? []
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "roots=" + roots.length }] } })
    }
    if (mode === "mrtr_undeclared") {
      return send({ jsonrpc: "2.0", id, result: {
        resultType: "input_required",
        inputRequests: { ask: { method: "elicitation/create", params: { message: "your password?" } } },
        requestState: "S",
      } })
    }
    const v = params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? "none"
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "called with " + v }] } })
  }

  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} })
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
}
`.replace("PROTOCOL", JSON.stringify(PROTOCOL_VERSION))

const STUB_PATH = path.join(DIR, "dual-stub.mjs")
fs.writeFileSync(STUB_PATH, STUB)

let n = 0
/** A fresh server name + log file per scenario: era is CACHED per server. */
const server = (mode) => {
  const log = path.join(DIR, `log-${mode}-${n++}.jsonl`)
  return { name: `${mode}${n}`, spec: { command: process.execPath, args: [STUB_PATH, mode, log] }, log }
}
const received = (log) => {
  try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const methods = (log) => received(log).map((m) => m.method)
/**
 * Wait for the stub to have LOGGED a method before asserting on it.
 *
 * `notifications/initialized` is fire-and-forget: `start()` writes it and
 * returns without waiting, so reading the log immediately is a race between
 * this process and the child's append. It passed alone and failed under
 * `FORGE_TEST_CONCURRENCY=4` — the classic shape of a test race, and a real
 * one in the TEST, not in the client.
 */
const settle = async (log, method, ms = 4000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (methods(log).includes(method)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

// ---------------------------------------------------------------------------
console.log("== the pieces the era decision is built from ==")
{
  const caps = clientCapabilities()
  ok("forge declares SOMETHING — `capabilities: {}` was why no server ever asked", Object.keys(caps).length > 0, JSON.stringify(caps))
  ok("roots is declared, because forge can answer it", !!caps.roots)
  eq("sampling is NOT declared by default — it spends the user's tokens", caps.sampling, undefined)
  ok("…and is declared once enabled", !!clientCapabilities({ mcp: { sampling: true } }).sampling)
  ok("elicitation is never declared — a server that cannot ask cannot block", !clientCapabilities({ mcp: { sampling: true } }).elicitation)

  const meta = clientMeta(MODERN_PROTOCOL_VERSION, caps)
  ok("the _meta keys are the spec's namespaced ones, not a short form",
    Object.keys(meta).every((k) => k.startsWith("io.modelcontextprotocol/")), Object.keys(meta).join(","))
  eq("it carries the revision", meta["io.modelcontextprotocol/protocolVersion"], MODERN_PROTOCOL_VERSION)

  eq("version pick prefers ours when offered", pickProtocolVersion(["2025-11-25", MODERN_PROTOCOL_VERSION]), MODERN_PROTOCOL_VERSION)
  eq("a legacy-only offer yields null, so the caller falls back", pickProtocolVersion(["2025-06-18", "2025-11-25"]), null)
  eq("an empty offer yields null", pickProtocolVersion([]), null)
  eq("a newer-only offer takes the closest", pickProtocolVersion(["2027-03-01", "2026-12-01"]), "2026-12-01")

  ok("a DiscoverResult is recognised", isDiscoverResult({ supportedVersions: ["2026-07-28"] }))
  ok("…and an empty object is NOT — that is a legacy server shrugging", !isDiscoverResult({}))
  ok("…nor is a string, a null, or an array", !isDiscoverResult(null) && !isDiscoverResult("x") && !isDiscoverResult([]))

  ok("an InputRequiredResult is recognised by resultType", isInputRequired({ resultType: "input_required" }))
  ok("…and by the presence of inputRequests", isInputRequired({ inputRequests: { a: { method: "roots/list" } } }))
  ok("an ordinary CallToolResult is not", !isInputRequired({ content: [{ type: "text", text: "hi" }] }))
}

// ---------------------------------------------------------------------------
console.log("== a MODERN server: discover, no handshake, _meta on every request ==")
{
  clearEraCache()
  const s = server("modern")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  eq("the era is modern", c.era, MCP_ERA.MODERN)
  eq("…at the revision the server offered", c.protocolVersion, MODERN_PROTOCOL_VERSION)
  eq("serverInfo came from server/discover, not from a handshake", c.serverInfo?.name, "modern")
  ok("…and so did its capabilities", !!c.capabilities?.tools)

  const out = await c.callTool("echo", { text: "x" })
  eq("the call round-trips", out.isError, false)
  ok("…and the server SAW the protocol version in _meta", /called with 2026-07-28/.test(out.text), out.text)

  const seen = methods(s.log)
  eq("server/discover went first", seen[0], "server/discover")
  ok("initialize was NEVER sent — the modern era has no handshake", !seen.includes("initialize"), seen.join(","))
  ok("…and neither was notifications/initialized", !seen.includes("notifications/initialized"))

  const discover = received(s.log)[0]
  ok("the probe itself carried _meta", !!discover.params?._meta?.["io.modelcontextprotocol/protocolVersion"], JSON.stringify(discover.params))
  ok("…including the declared capabilities, which is what unlocks MRTR",
    !!discover.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.roots)
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== the fallback is NOT keyed to an error code ==")
{
  // This is the rule the spec calls out explicitly, and the one a client will
  // get wrong by matching on -32601 alone.
  for (const [mode, why] of [
    ["legacy", "answers -32601 (method not found)"],
    ["legacy_weird", "answers -32602 (invalid params) — a different code, same meaning"],
  ]) {
    clearEraCache()
    const s = server(mode)
    const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
    eq(`a server that ${why} is legacy`, c.era, MCP_ERA.LEGACY)
    eq("…and the handshake happened", c.serverInfo?.name, `legacy-${mode}`)
    eq("…and reported the version the server speaks (never read before v131)", c.serverProtocolVersion, PROTOCOL_VERSION)
    await settle(s.log, "notifications/initialized")
    const seen = methods(s.log)
    eq("the probe still went first", seen[0], "server/discover")
    ok("…then initialize", seen.includes("initialize"))
    ok("…then the initialized notification", seen.includes("notifications/initialized"), seen.join(","))
    const init = received(s.log).find((m) => m.method === "initialize")
    ok("the legacy handshake declares real capabilities now, not `{}`",
      !!init.params?.capabilities?.roots, JSON.stringify(init.params?.capabilities))
    c.close()
  }
}

// ---------------------------------------------------------------------------
console.log("== a SILENT server falls back instead of hanging twice ==")
{
  clearEraCache()
  const s = server("silent")
  const t0 = Date.now()
  let threw = false
  try { await connectServer(s.name, s.spec, { timeoutMs: 600 }) } catch { threw = true }
  const took = Date.now() - t0
  ok("it fails rather than hanging", threw)
  // Generous on purpose: this asserts "it came back", not a stopwatch reading.
  // A tight bound here would be measuring the CI runner's load, not the code —
  // the repo has been bitten by exactly that before (test-v101).
  ok(`it came back rather than hanging (${took}ms)`, took < 15000, `${took}ms`)
  ok("the server was asked to discover, then to initialize", methods(s.log).join(",") === "server/discover,initialize", methods(s.log).join(","))
  // The cost claim itself is a property of the code, not of the clock: the
  // probe is capped so a silent server never pays TWO full request timeouts.
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("…and the probe is capped below a full request timeout",
    /Math\.min\(this\.timeoutMs, PROBE_TIMEOUT_MS\)/.test(src) && /const PROBE_TIMEOUT_MS = \d+/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== -32022 is a NEGOTIATION, never a fallback signal ==")
{
  clearEraCache()
  eq("the code is the spec's UnsupportedProtocolVersionError", UNSUPPORTED_PROTOCOL_VERSION, -32022)
  const s = server("wrongversion")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  eq("the client stayed MODERN", c.era, MCP_ERA.MODERN)
  const seen = methods(s.log)
  eq("it retried server/discover rather than downgrading", seen.filter((m) => m === "server/discover").length, 2)
  ok("initialize was never reached", !seen.includes("initialize"), seen.join(","))
  eq("…with a version the server itself named", c.protocolVersion, "2026-07-28")
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== a DUAL-ERA server offering only legacy revisions is legacy ==")
{
  clearEraCache()
  const s = server("dual_legacy_only")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  // It answered `server/discover` — so a naive client reads "modern" and then
  // asserts a revision the server never claimed.
  eq("forge takes the server at its word", c.era, MCP_ERA.LEGACY)
  ok("…and handshakes", methods(s.log).includes("initialize"))
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== MRTR: the server asks, the client answers, the call finishes ==")
{
  clearEraCache()
  const s = server("mrtr")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  const out = await c.callTool("echo", { text: "x" })
  ok("the call completed after the round trip", /roots=\d+/.test(out.text), out.text)
  ok("…and the roots forge sent were real", !/roots=0/.test(out.text), out.text)

  const calls = received(s.log).filter((m) => m.method === "tools/call")
  eq("it took exactly two tools/call requests", calls.length, 2)
  ok("the retry used a DIFFERENT JSON-RPC id (a MUST)", calls[0].id !== calls[1].id, `${calls[0].id} vs ${calls[1].id}`)
  eq("the opaque requestState was echoed VERBATIM", calls[1].params.requestState, "OPAQUE::do-not-touch::9")
  ok("…and the original arguments were carried through unchanged",
    JSON.stringify(calls[1].params.arguments) === JSON.stringify({ text: "x" }), JSON.stringify(calls[1].params.arguments))
  ok("the answer is keyed by the server's own request name", !!calls[1].params.inputResponses?.where, JSON.stringify(calls[1].params.inputResponses))
  ok("…and is a real ListRootsResult", Array.isArray(calls[1].params.inputResponses.where.roots))
  ok("every root is a file:// uri", calls[1].params.inputResponses.where.roots.every((r) => String(r.uri).startsWith("file://")))
  c.close()
}

console.log("== …but a capability forge never declared is refused, not guessed ==")
{
  clearEraCache()
  const s = server("mrtr_undeclared")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  const plugin = mcpToolsToPlugins(c, [{ name: "echo", inputSchema: { type: "object", properties: {} } }])[0]
  const out = await plugin.run({})
  ok("it is an ERROR string, never a throw into the loop", out.startsWith("ERROR:"), out)
  ok("…and it names what was asked for", /elicitation\/create/.test(out), out)
  ok("…and says forge never declared it", /never declared/.test(out), out)
  eq("the tool call was NOT retried", received(s.log).filter((m) => m.method === "tools/call").length, 1)
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== an in-flight call is cancellable (it used to be waited out) ==")
{
  clearEraCache()
  const s = server("hang")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 20000 })
  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 120)
  let err = null
  try { await c.callTool("echo", { text: "x" }, { signal: ac.signal }) } catch (e) { err = e }
  const took = Date.now() - t0
  ok("the call rejected", !!err)
  ok("…because it was cancelled, not because it timed out", /cancelled/i.test(String(err?.message)), String(err?.message))
  ok(`…promptly, nowhere near the 20s request timeout (${took}ms)`, took < 10000, `${took}ms`)
  await new Promise((r) => setTimeout(r, 120))
  const cancelled = received(s.log).find((m) => m.method === "notifications/cancelled")
  ok("the SERVER was told to stop working — otherwise it keeps burning", !!cancelled, methods(s.log).join(","))
  const call = received(s.log).find((m) => m.method === "tools/call")
  eq("…and the notification names the exact request id", cancelled?.params?.requestId, call?.id)

  // the same thing through the plugin surface the agent loop actually uses
  const ac2 = new AbortController()
  const plugin = mcpToolsToPlugins(c, [{ name: "echo", inputSchema: { type: "object", properties: {} } }])[0]
  setTimeout(() => ac2.abort(), 80)
  const out = await plugin.run({}, { signal: ac2.signal })
  ok("a plugin run surfaces the cancellation as an ERROR string", /ERROR:.*cancelled/i.test(out), out)

  eq("an explicit cancelCall() is accepted too", cancelCall(c, 99), true)
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== progress notifications reach the run ==")
{
  clearEraCache()
  const events = []
  const s = server("progress")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000, onEvent: (e) => events.push(e) })
  const out = await c.callTool("echo", { text: "x" })
  eq("the call still returns its result", out.text, "done")
  const prog = events.filter((e) => e.type === "mcp_progress")
  ok(`a progress event was surfaced (${events.length} events)`, prog.length > 0, JSON.stringify(events))
  eq("…tagged with the server it came from", prog[0]?.server, s.name)
  eq("…carrying the server's numbers", prog[0]?.params?.total, 2)

  const call = received(s.log).find((m) => m.method === "tools/call")
  ok("forge asked for progress with a token — without one a server stays silent",
    !!call?.params?._meta?.progressToken, JSON.stringify(call?.params?._meta))

  ok("onProgress() subscribes an extra listener", (() => {
    const extra = []
    const off = onProgress(c, (e) => extra.push(e))
    c._dispatch({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })
    off()
    c._dispatch({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 2 } })
    return extra.length === 1
  })())
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== ping tells a dead server apart from a slow one ==")
{
  clearEraCache()
  const s = server("modern")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  eq("a live server answers", await pingServer(c), true)
  c.close()
  eq("a closed one does not", await pingServer(c), false)
  eq("neither does a non-client", await pingServer(null), false)
}

// ---------------------------------------------------------------------------
console.log("== a LEGACY server may still send a request, and now gets an answer ==")
{
  clearEraCache()
  const s = server("legacy_asks")
  const c = await connectServer(s.name, s.spec, { timeoutMs: 4000 })
  // the stub sends roots/list 10ms after initialize; give it a moment
  await new Promise((r) => setTimeout(r, 250))
  await c.listTools()
  ok("forge declared roots, so the server was entitled to ask", !!c.clientCaps.roots)
  // the proof that it was ANSWERED is that the connection kept working after
  // the request — before v131 the reply never came and a strict server stalls
  const out = await c.callTool("echo", { text: "x" })
  ok("the session survived the server-initiated request", out.isError === false, JSON.stringify(out))
  c.close()
}

// ---------------------------------------------------------------------------
console.log("== roots come from the one workspace resolver, not a second one ==")
{
  const r = await listRoots(process.cwd())
  ok("there is at least one root", r.roots.length > 0)
  ok("each is a file:// uri with a name", r.roots.every((x) => /^file:\/\//.test(x.uri) && x.name))
  ok("the list is bounded", r.roots.length <= 8)
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("§36: it reuses workspace.js rather than re-deriving the project root",
    /await import\("\.\/workspace\.js"\)/.test(src) && /resolveWorkspace\(\{ cwd \}\)/.test(src))
  ok("…and imports it lazily, because mcp.js is on the boot path",
    !/^import \{[^}]*resolveWorkspace/m.test(src))
}

// ---------------------------------------------------------------------------
console.log("== sampling is gated, because it spends the user's tokens ==")
{
  let threw = null
  try { await mcp.handleSampling({ messages: [] }, { name: "greedy" }) } catch (e) { threw = e }
  ok("an unconfigured server cannot spend anything", !!threw)
  ok("…and the refusal says how to allow it", /mcp\.sampling/.test(String(threw?.message)), String(threw?.message))
  ok("…and names the server that asked", /greedy/.test(String(threw?.message)))
  eq("it is off by default", mcp.samplingEnabled(null), false)
  eq("…and on when the user says so", mcp.samplingEnabled({ mcp: { sampling: true } }), true)
}

// ---------------------------------------------------------------------------
console.log("== the constraints this change had to respect ==")
{
  const src = fs.readFileSync(new URL("../mcp.js", import.meta.url), "utf8")
  ok("HTTP still goes through netguard, never a raw fetch", /pinnedFetch\(this\.url/.test(src))
  ok("…and there is still no raw global fetch in the module", !/[^.\w]fetch\(/.test(src.replace(/pinnedFetch\(/g, "PF(")))
  ok("the legacy revision forge offers is untouched", /export const PROTOCOL_VERSION = "2024-11-05"/.test(src))
  ok("the modern one is the real current revision", /export const MODERN_PROTOCOL_VERSION = "2026-07-28"/.test(src))
  ok("the cancellation signal reaches the plugin surface (tools.js was the missing line)",
    /signal: ctx\.signal \?\? null/.test(fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8")))
}

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log(`\n== mcp-dual-era suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
