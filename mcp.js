/**
 * forge — Model Context Protocol (MCP) client (v23, zero dependencies)
 *
 * MCP is the industry-standard way to give an agent tools and data from an
 * external process (a "server") — filesystems, databases, issue trackers,
 * browsers, company-internal APIs. Before this, forge could only be extended by
 * dropping a local `*.mjs` plugin in ~/.forge/tools (plugins.js). MCP opens the
 * whole ecosystem: any MCP server the user configures becomes a set of agent
 * tools, governed by the SAME capability registry, policy gate and safety
 * engine as the built-ins.
 *
 * This module is the transport + protocol client only. It deliberately does NOT
 * wire tools into the agent loop yet — `mcpToolsToPlugins()` returns tool
 * objects in the exact shape plugins.js already produces
 * (`{ name, readOnly, def, run, source }`), so the agent-loop integration is a
 * separate, small change that reuses the existing plugin choke point (output
 * redaction, write-class serialization, read-only sub-agent blocking).
 *
 * Transport: MCP stdio — newline-delimited JSON-RPC 2.0 over the child's
 * stdin/stdout (messages MUST NOT contain embedded newlines). Zero deps:
 * node:child_process + manual framing.
 *
 * Trust model (unchanged from plugins): a server is launched from a command in
 * the USER's config — never from model output — exactly like running any local
 * program the user chose. MCP is OFF by default (no servers configured). Tool
 * names are namespaced `mcp__<server>__<tool>` so they can never shadow a
 * built-in, and MCP tools are treated as WRITE-class by default (the protocol
 * does not reliably declare side-effect freedom, so we assume the unsafe case).
 */
import { backoffDelay, sleepAbortable } from "./retry-policy.js"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { pinnedFetch } from "./netguard.js"
import pathMod from "node:path"
import fsMod from "node:fs"
import { resolveDataDir } from "./config.js"
import { writeStateFile } from "./securefs.js"
import { childEnv } from "./childenv.js"
import { VERSION } from "./version.js"
import { askUntrusted, canAsk } from "./ask.js"
import { inspectUrl, describeUrl, openInBrowser, canOpenBrowser } from "./openurl.js"

export const PROTOCOL_VERSION = "2024-11-05"

/**
 * v131 — MCP split into TWO ERAS, and forge was on the wrong side of the line.
 *
 *   legacy  (<= 2025-11-25): an `initialize` handshake negotiates ONE version
 *                            for the session; discovery is `tools/list`; a
 *                            server may send JSON-RPC REQUESTS back.
 *   modern  (>= 2026-07-28): there is NO handshake. Every request declares its
 *                            version in `_meta`; discovery is
 *                            `server/discover`; a server MUST NOT send a
 *                            request — it returns an InputRequiredResult and
 *                            the client RETRIES with the answers (MRTR).
 *
 * The specification's own compatibility matrix is blunt about what forge's
 * pinned 2024-11-05 meant: "legacy client + modern server → fails. Legacy
 * clients have no fall-forward mechanism." So this was never a missing
 * feature, it was a cliff — as servers move to modern-only, forge stops being
 * able to speak to them at all.
 *
 * forge now PROBES each server once and speaks whichever era it answers in.
 * PROTOCOL_VERSION stays exactly as it was: it is the version forge offers on
 * the legacy path, and that path must stay byte-identical.
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28"
export const MCP_ERA = Object.freeze({ MODERN: "modern", LEGACY: "legacy" })
/** `_meta` keys are namespaced by the spec. Never invent a short form. */
const META = "io.modelcontextprotocol/"
/** UnsupportedProtocolVersionError: a MODERN server saying "not that revision". */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022
const DEFAULT_TIMEOUT_MS = 20000
/**
 * The era probe must be CHEAP. A legacy server answers instantly (with an
 * error), but a server that answers nothing at all would otherwise cost a full
 * request timeout twice — once for the probe and once for `initialize`.
 */
const PROBE_TIMEOUT_MS = 2000
const MAX_LINE_BYTES = 8 * 1024 * 1024 // guard against a runaway server flooding stdout
// v143: netguard streams the back-channel WITHOUT accumulating, so this is the
// only thing standing between a server that opens an SSE event and never
// terminates it and unbounded growth in this process. One frame, not one
// session — a channel open for an hour is fine; a single 1MB frame is not.
const MAX_SSE_FRAME_BYTES = 1024 * 1024
// v162: how long a legacy HTTP+SSE server may take to name its endpoint
export const SSE_ENDPOINT_TIMEOUT_MS = 5000
// v162: how long the SSE stream may sit silent. On that transport the stream
// IS the session, so a quiet stretch longer than one request's timeout must
// not end it (each call still has its own timeout for its answer).
export const SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000
// v162: the statuses on which the spec says to try the 2024-11-05 transport
const LEGACY_SSE_STATUSES = new Set([400, 404, 405])

/**
 * v150: re-opening a dropped back-channel. The spec lets a server close its
 * GET stream at any time ("The server MAY close the SSE stream at any time"),
 * and a proxy idle timeout does it without asking. Backoff comes from
 * retry-policy.js — one implementation of backoff, not a second — starting
 * at REOPEN_BASE_MS and bounded so a server that is gone for good costs about
 * a minute of background attempts, then is reported LOST rather than retried
 * forever.
 */
export const REOPEN_BASE_MS = 250
export const REOPEN_MAX_MS = 30000
export const REOPEN_MAX_ATTEMPTS = 8
/** A server's `retry:` above this is clamped — a hostile value must not park the client. */
export const REOPEN_RETRY_CAP_MS = 60000

/**
 * v152: how long close() waits for the server to acknowledge a session DELETE.
 * Short on purpose — it runs at the end of every agent run that used an HTTP
 * MCP server, and a server that does not answer must not hold the run open.
 */
export const SESSION_DELETE_TIMEOUT_MS = 2000
/** A server may legitimately ask for input twice. Never forever. */
const MAX_MRTR_ROUNDS = 8

/**
 * A JSON-RPC error from a server, with its `code` and `data` preserved.
 *
 * The message text is unchanged from v23 (`MCP error <code>: <message>`)
 * because callers and suites match on it — what is new is that the era probe
 * can now tell -32022 ("wrong revision, here are mine") apart from -32601
 * ("never heard of that method"), which is the whole difference between
 * negotiating and falling back.
 */
export class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(`MCP error ${code}: ${message || "unknown"}`)
    this.name = "McpProtocolError"
    this.code = Number(code)
    this.data = data ?? null
  }
}

/**
 * What forge tells a server it can do.
 *
 * Until v131 both transports sent `capabilities: {}` under the comment "a
 * minimal client: we consume tools, advertise nothing" — which is precisely
 * why no server ever asked forge for anything. Under the modern spec a server
 * MUST NOT send an inputRequest for a capability the client did not declare,
 * so this object is the thing that unlocks MRTR at all.
 *
 * Declare only what is IMPLEMENTED:
 *   roots       — answered from the resolved workspace. Always.
 *   sampling    — spends the USER's tokens on a server's behalf, so it is off
 *                 unless explicitly enabled. Never silently.
 *   elicitation — FORM mode when a human is reachable, URL mode when there is
 *                 also a browser to hand off to. Both, or one, or neither.
 *                 v131 could not declare this at all: chat.js owned the only
 *                 prompt and an MCP call runs inside a tool inside the agent,
 *                 with no way back to it. ask.js is that way back (v142), so
 *                 the gate is now `canAsk()` — a real question about this
 *                 process, not a config flag. Unattended runs still declare
 *                 nothing, which is the honest answer: a server that asks
 *                 them would get silence.
 *
 *                 v144: `url` mode ships. Its client MUSTs — show the full
 *                 URL, highlight the domain, warn on Punycode, never
 *                 pre-fetch, open it where neither forge nor the model can
 *                 read the page — live in openurl.js, and the gate is
 *                 `canOpenBrowser()`, because the spec lets a client support
 *                 either mode but not claim one it cannot honour.
 */
export function clientCapabilities(config = null) {
  const caps = { roots: { listChanged: false } }
  if (samplingEnabled(config)) caps.sampling = {}
  // Each mode is declared only when forge can honour it: form needs someone
  // to ask, url needs a browser to hand off to. A headless CI run declares
  // neither, which is the honest answer rather than a promise.
  if (canAsk()) {
    caps.elicitation = { form: {} }
    if (canOpenBrowser()) caps.elicitation.url = {}
  }
  return caps
}

/** Sampling is opt-in: it spends the user's tokens on the server's behalf. */
export function samplingEnabled(config = null) {
  if (process.env.FORGE_MCP_SAMPLING === "1") return true
  return config?.mcp?.sampling === true
}

/** The per-request `_meta` every MODERN request carries. */
export function clientMeta(protocolVersion, capabilities = null) {
  return {
    [`${META}protocolVersion`]: String(protocolVersion),
    [`${META}clientInfo`]: { name: "forge", version: VERSION },
    [`${META}clientCapabilities`]: capabilities ?? clientCapabilities(),
  }
}

/**
 * Choose a modern revision out of what a server offers. MCP revisions are
 * zero-padded YYYY-MM-DD, so lexical order IS chronological order.
 *
 * Returns null when nothing overlaps, and the caller then falls back to the
 * legacy handshake rather than asserting a version neither side agreed to —
 * that null is how a DUAL-ERA server offering only legacy revisions is handled
 * correctly instead of being mistaken for a modern one.
 */
export function pickProtocolVersion(offered, preferred = MODERN_PROTOCOL_VERSION) {
  const list = (Array.isArray(offered) ? offered : []).map((v) => String(v ?? "").trim()).filter(Boolean)
  if (!list.length) return null
  if (list.includes(preferred)) return preferred
  // A server that speaks only revisions NEWER than ours: take the OLDEST of
  // them — the closest to what forge understands. Anything older than our
  // preferred revision is legacy territory and is not this function's business.
  const newer = list.filter((v) => v > preferred).sort()
  return newer.length ? newer[0] : null
}

/**
 * A DiscoverResult identifies the MODERN era. Be strict about the shape: a
 * legacy server that answers an unknown method with `{}` instead of an error
 * must not be misread as modern, because everything after this branches on it.
 */
export function isDiscoverResult(res) {
  if (!res || typeof res !== "object") return false
  if (Array.isArray(res.supportedVersions) || Array.isArray(res.protocolVersions)) return true
  return Boolean(res.serverInfo && typeof res.serverInfo === "object")
}

/** The revisions a DiscoverResult offers, under either spelling. */
export function discoveredVersions(res) {
  const v = Array.isArray(res?.supportedVersions) ? res.supportedVersions
    : Array.isArray(res?.protocolVersions) ? res.protocolVersions : []
  return v.map((x) => String(x ?? "").trim()).filter(Boolean)
}

/** MRTR: the server cannot finish until the client answers something. */
export function isInputRequired(res) {
  if (!res || typeof res !== "object") return false
  if ((res.resultType ?? res.type) === "input_required") return true
  return Boolean(res.inputRequests && typeof res.inputRequests === "object" && Object.keys(res.inputRequests).length)
}

/**
 * The directories forge is willing to let a server reason about, as MCP roots.
 *
 * §36: the "which directory is this run about" question already has exactly one
 * answer in this codebase (workspace.js `resolveWorkspace`), and this reuses it
 * rather than inventing a second one. Imported lazily — roots are asked for
 * rarely, and mcp.js is on the agent's boot path.
 */
export async function listRoots(cwd = process.cwd()) {
  const dirs = []
  const add = (d) => { if (d && typeof d === "string" && !dirs.includes(d)) dirs.push(d) }
  try {
    const { resolveWorkspace } = await import("./workspace.js")
    const ws = resolveWorkspace({ cwd })
    add(ws?.targetWorkspace)
    add(ws?.repositoryRoot)
  } catch { /* an unreadable workspace still has a working directory */ }
  add(cwd)
  return { roots: dirs.slice(0, 8).map((d) => ({ uri: pathToFileURL(d).href, name: pathMod.basename(d) || d })) }
}

/**
 * Answer a server's `sampling/createMessage`: the request that turns an MCP
 * server from a remote function table into something that can think.
 *
 * It spends the USER's tokens, so it is gated twice over — the capability is
 * not declared unless enabled (a server may then not even ask), and this
 * throws rather than quietly spending if it is somehow reached anyway.
 */
export async function handleSampling(params, { config = null, name = "?", signal = null } = {}) {
  if (!samplingEnabled(config)) {
    throw new Error(`MCP server "${name}" asked forge to run a model completion, but sampling is off — enable it with \`forge config set mcp.sampling true\` (it spends your tokens on the server's behalf)`)
  }
  const { buildProvider, chatOnce } = await import("./providers.js")
  const provider = buildProvider(config, config?.activeProvider)
  if (!provider) throw new Error(`MCP server "${name}" asked for a completion, but no provider is configured`)
  const messages = (Array.isArray(params?.messages) ? params.messages : []).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: flattenContent(m?.content),
  }))
  const res = await chatOnce({
    protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model,
    messages, system: params?.systemPrompt ? String(params.systemPrompt) : undefined,
    maxTokens: Number(params?.maxTokens) > 0 ? Number(params.maxTokens) : 2048,
    temperature: typeof params?.temperature === "number" ? params.temperature : undefined,
    signal: signal ?? undefined,
  })
  const text = String(res?.content ?? res?.text ?? "")
  return { role: "assistant", content: { type: "text", text }, model: provider.model, stopReason: "endTurn" }
}

/**
 * The response actions of an ElicitResult. All three are real answers and the
 * server is required to handle each: `accept` carries data, `decline` is an
 * explicit no, `cancel` is a dismissal with no choice made.
 */
export const ELICIT_ACTION = Object.freeze({ ACCEPT: "accept", DECLINE: "decline", CANCEL: "cancel" })

/** The primitive property types a form-mode `requestedSchema` may contain. */
const ELICIT_TYPES = new Set(["string", "number", "integer", "boolean"])
/** A form the user would have to fill for a minute is not a prompt any more. */
export const MAX_ELICIT_FIELDS = 8

/**
 * One field of a form-mode schema, as a question and a parser.
 *
 * The schema comes from the server, so nothing here trusts it: an unknown
 * type, a missing `properties`, a nested object are all "not a field forge
 * will ask about" rather than errors, and the field is skipped. A required
 * field that cannot be rendered is what makes the whole form undisplayable —
 * see `elicitFields`.
 */
function elicitField(key, schema) {
  const type = String(schema?.type ?? "string")
  const enumVals = Array.isArray(schema?.enum) ? schema.enum.map((v) => String(v ?? "")).filter(Boolean) : []
  if (!ELICIT_TYPES.has(type)) return null
  const title = String(schema?.title ?? key)
  const desc = String(schema?.description ?? "")
  return {
    key,
    type,
    enumVals,
    label: desc ? `${title} (${desc})` : title,
    dflt: schema?.default,
    /** @returns {{ok: true, value: any} | {ok: false}} */
    parse(raw) {
      const s = String(raw ?? "").trim()
      if (!s) return schema?.default === undefined ? { ok: false } : { ok: true, value: schema.default }
      if (type === "boolean") {
        if (/^(y|yes|true|1)$/i.test(s)) return { ok: true, value: true }
        if (/^(n|no|false|0)$/i.test(s)) return { ok: true, value: false }
        return { ok: false }
      }
      if (type === "number" || type === "integer") {
        const n = Number(s)
        if (!Number.isFinite(n)) return { ok: false }
        if (type === "integer" && !Number.isInteger(n)) return { ok: false }
        return { ok: true, value: n }
      }
      if (enumVals.length && !enumVals.includes(s)) return { ok: false }
      return { ok: true, value: s }
    },
  }
}

/**
 * The askable fields of a form-mode `requestedSchema`, or null if forge cannot
 * present this form honestly.
 *
 * Null when a REQUIRED property is one forge cannot render (a nested object, an
 * array, an unknown type) — collecting the rest and calling it `accept` would
 * hand the server a form it did not ask for, which is worse than declining.
 */
export function elicitFields(requestedSchema) {
  const props = requestedSchema?.properties
  if (!props || typeof props !== "object") return []
  const required = new Set((Array.isArray(requestedSchema?.required) ? requestedSchema.required : []).map(String))
  const out = []
  for (const [key, schema] of Object.entries(props)) {
    const f = elicitField(key, schema)
    if (!f) { if (required.has(key)) return null; continue }
    f.required = required.has(key)
    out.push(f)
    if (out.length > MAX_ELICIT_FIELDS) return null
  }
  return out
}

/**
 * URL-mode elicitation: send the user somewhere forge will never look.
 *
 * This exists because form mode is forbidden from carrying the things servers
 * most often need. The spec is blunt: a server **MUST NOT** use form mode to
 * request passwords, API keys, access tokens or payment credentials, and
 * **MUST** use url mode for those. Without url mode a server that needs a
 * credential has no route to the user at all — which is what forge shipped
 * from v131 to v143.
 *
 * The order here is the whole point, and every step is a spec MUST:
 *
 *   1. parse and vet the url — NEVER fetch it, not even for a title;
 *   2. show the full url and its domain, and warn if the domain is Punycode;
 *   3. get explicit consent;
 *   4. hand it to the OPERATING SYSTEM, with no pipe back.
 *
 * `accept` means the user consented to the interaction — not that it
 * succeeded. The interaction happens out of band and forge is deliberately
 * not told the outcome; the server works that out from the `requestState` it
 * gets back on the retry. So there is nothing to read here, and no code that
 * could read it.
 */
async function handleUrlElicitation(params, { name = "?" } = {}) {
  const message = String(params?.message ?? "").trim()
  if (!message) return { action: ELICIT_ACTION.CANCEL }
  if (!canAsk() || !canOpenBrowser()) return { action: ELICIT_ACTION.CANCEL }

  const checked = inspectUrl(params?.url)
  // A url forge will not open is a DECLINE, not a cancel: cancel says the
  // user walked away, and here forge refused on their behalf and can say why.
  if (!checked.ok) return { action: ELICIT_ACTION.DECLINE }

  // The server's message first, clearly attributed and sanitized; then the
  // url, built from the PARSED form so nothing the server wrote can reach the
  // terminal as anything but text.
  const shown = [`${message} — forge will open:`, ...describeUrl(checked)].join("\n")
  const agreed = await askUntrusted(shown, { source: `MCP server "${name}"` })
  if (agreed === null) return { action: ELICIT_ACTION.CANCEL }
  if (!/^y(es)?$/i.test(agreed)) return { action: ELICIT_ACTION.DECLINE }

  const opened = await openInBrowser(checked.href)
  // Consent was given and forge could not honour it. Reporting `accept` would
  // tell the server a browser is open on a page nobody is looking at, and it
  // would then wait for an interaction that cannot happen.
  if (!opened.ok) return { action: ELICIT_ACTION.CANCEL }
  return { action: ELICIT_ACTION.ACCEPT }
}

/**
 * Answer a server's `elicitation/create` by asking the human.
 *
 * Both modes, each declared only when forge can actually honour it:
 *
 *   form — questions on the terminal, so it needs someone to ask (v142).
 *   url  — hand-off to the system browser, so it needs a browser (v144).
 *
 * A mode forge cannot honour is not declared and is declined if a server
 * sends it anyway, which is the same doctrine v131 set with `capabilities:
 * {}` — a server is entitled to ask for whatever the client declares.
 *
 * Every question goes through `askUntrusted`: the message and the field
 * labels are the SERVER's text, and the MCP spec requires the user be able to
 * see which server is asking. `null` — no human, or Ctrl-C — is `cancel`,
 * never a fabricated value.
 */
export async function handleElicitation(params, { name = "?" } = {}) {
  const mode = String(params?.mode ?? "form")
  if (mode === "url") return handleUrlElicitation(params, { name })
  if (mode !== "form") {
    return { action: ELICIT_ACTION.DECLINE }
  }
  const message = String(params?.message ?? "").trim()
  if (!message) return { action: ELICIT_ACTION.CANCEL }
  if (!canAsk()) return { action: ELICIT_ACTION.CANCEL }

  const fields = elicitFields(params?.requestedSchema)
  if (fields === null) return { action: ELICIT_ACTION.DECLINE }

  // Consent to the whole form FIRST: the user decides once, knowing who is
  // asking and what for, instead of discovering it field by field.
  const agreed = await askUntrusted(`${message} — answer? [y/N]`, { source: `MCP server "${name}"` })
  if (agreed === null) return { action: ELICIT_ACTION.CANCEL }
  if (!/^y(es)?$/i.test(agreed)) return { action: ELICIT_ACTION.DECLINE }

  const content = {}
  for (const f of fields) {
    const hint = f.enumVals.length ? ` one of: ${f.enumVals.join(", ")}` : f.type === "boolean" ? " [y/n]" : ""
    const dflt = f.dflt === undefined ? "" : ` [default ${JSON.stringify(f.dflt)}]`
    const raw = await askUntrusted(`${f.label}${hint}${dflt}:`, { source: `MCP server "${name}"` })
    if (raw === null) return { action: ELICIT_ACTION.CANCEL }
    const parsed = f.parse(raw)
    if (!parsed.ok) {
      // A required field forge could not get a valid value for means the form
      // is not filled. Sending a partial `accept` would be a lie.
      if (f.required) return { action: ELICIT_ACTION.DECLINE }
      continue
    }
    content[f.key] = parsed.value
  }
  return { action: ELICIT_ACTION.ACCEPT, content }
}

/**
 * Answer ONE server-initiated JSON-RPC request. Legacy era only — the modern
 * era replaced these with MRTR.
 *
 * v143: this used to be a method on the stdio client, which is why the HTTP
 * client could not have answered one even if it had a channel to answer on.
 * It is a function now, returning the JSON-RPC body rather than writing it,
 * so both transports serve the same set from the same code. The alternative
 * was a second copy that would drift the first time one gained a capability —
 * which had already happened: v142 taught MRTR about `elicitation/create` and
 * left the legacy dispatcher behind.
 *
 * Every branch mirrors `clientCapabilities` exactly. A method forge did not
 * declare gets an honest -32601 rather than the silence that used to leave a
 * server waiting forever.
 */
export async function serveServerRequest(msg, { cwd, config, name = "?" } = {}) {
  try {
    if (msg.method === "ping") return { result: {} }
    if (msg.method === "roots/list") return { result: await listRoots(cwd) }
    if (msg.method === "sampling/createMessage") {
      return { result: await handleSampling(msg.params, { config, name }) }
    }
    if (msg.method === "elicitation/create" && canAsk()) {
      return { result: await handleElicitation(msg.params, { name }) }
    }
    return { error: { code: -32601, message: `forge does not implement "${msg.method}"` } }
  } catch (e) {
    return { error: { code: -32603, message: String(e?.message ?? e).slice(0, 300) } }
  }
}

/**
 * Fulfil every entry of an InputRequiredResult's `inputRequests` map.
 *
 * A server MUST NOT ask for a capability the client did not declare, so an
 * unknown method here is the SERVER's protocol violation and is reported as
 * one — answering it with a guess would be worse than failing loudly.
 */
export async function fulfilInputRequests(requests, ctx = {}) {
  const out = {}
  for (const [key, req] of Object.entries(requests && typeof requests === "object" ? requests : {})) {
    const method = String(req?.method ?? req?.type ?? "")
    if (method === "roots/list") out[key] = await listRoots(ctx.cwd)
    else if (method === "sampling/createMessage") out[key] = await handleSampling(req?.params, ctx)
    // The guard mirrors `clientCapabilities` exactly, and must keep doing so:
    // with no human, forge declares no `elicitation`, so a server asking for
    // one has violated the spec's "MUST NOT ask for an undeclared capability"
    // and gets the loud error below rather than a polite `cancel`. Answering
    // an undeclared capability would teach servers to ask anyway.
    else if (method === "elicitation/create" && canAsk()) out[key] = await handleElicitation(req?.params, ctx)
    else throw new Error(`MCP server "${ctx.name ?? "?"}" asked for "${method || "an unnamed capability"}", which forge never declared`)
  }
  return out
}

/**
 * Run a request the server may answer with an InputRequiredResult instead of a
 * result. The rules are all MUSTs and every one of them is easy to get wrong:
 *
 *   - fulfil EVERY entry of `inputRequests` before retrying;
 *   - echo `requestState` VERBATIM — it is the server's own tamper-evident
 *     resume token and the client must never inspect or reshape it;
 *   - retry with a DIFFERENT JSON-RPC id (`send` allocates a fresh one);
 *   - and stop eventually.
 */
async function runWithInput(send, method, params, ctx) {
  let res = await send(method, params)
  for (let round = 0; isInputRequired(res); round++) {
    if (round >= MAX_MRTR_ROUNDS) {
      throw new Error(`MCP server "${ctx?.name ?? "?"}" asked for input ${MAX_MRTR_ROUNDS} times without finishing "${method}"`)
    }
    const inputResponses = await fulfilInputRequests(res.inputRequests, ctx)
    res = await send(method, { ...(params ?? {}), inputResponses, requestState: res.requestState })
  }
  return res
}

/**
 * Era is a property of the SERVER, so the spec directs caching it. Keyed by
 * name + launch shape so two servers sharing a command never collide.
 */
const ERA_CACHE = new Map()
export function clearEraCache() { ERA_CACHE.clear() }

/** Namespaced tool name, e.g. mcp__github__create_issue. Stable + collision-free. */
export function mcpToolName(server, tool) {
  return `mcp__${server}__${tool}`
}

/** Parse a namespaced name back to { server, tool }, or null if not one of ours. */
export function parseMcpToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ""))
  return m ? { server: m[1], tool: m[2] } : null
}

function resolvedBinding(binding, base, server, target) {
  if (binding === undefined || binding === null) return null
  if (typeof binding !== "object" || Array.isArray(binding)) return String(binding)
  const envName = typeof binding.env === "string" ? binding.env.trim() : ""
  if (!envName) return null
  const value = base?.[envName]
  if (value === undefined || value === "") {
    if (binding.required === true) throw new Error(`MCP server "${server}" requires environment variable ${envName} for ${target}`)
    return null
  }
  return `${String(binding.prefix ?? "")}${String(value)}${String(binding.suffix ?? "")}`
}

/** Resolve config environment references without persisting or logging values. */
export function resolveMcpEnvironment(declared = {}, base = process.env, server = "unknown") {
  const out = {}
  for (const [name, binding] of Object.entries(declared || {})) {
    const value = resolvedBinding(binding, base, server, `environment variable ${name}`)
    if (value !== null) out[name] = value
  }
  return out
}

/** Resolve HTTP header environment references immediately before a request. */
export function resolveMcpHeaders(declared = {}, base = process.env, server = "unknown") {
  const out = {}
  for (const [name, binding] of Object.entries(declared || {})) {
    const value = resolvedBinding(binding, base, server, `HTTP header ${name}`)
    if (value !== null) out[name] = value
  }
  return out
}

/**
 * One MCP server connection over stdio. Not exported as a class API surface to
 * keep churn low; use `connectServer()` which returns a ready client.
 */
class McpClient {
  constructor(name, { command, args = [], env = {}, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent = null, config = null, era = null } = {}) {
    this.name = name
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.env = resolveMcpEnvironment(env && typeof env === "object" ? env : {}, process.env, name)
    this.cwd = cwd
    this.timeoutMs = timeoutMs
    this.child = null
    this._buf = ""
    this._nextId = 1
    this._pending = new Map() // id -> { resolve, reject, timer, cleanup }
    this._closed = false
    this._exitReason = null
    this.serverInfo = null
    this.capabilities = null
    // v131 — dual era. `era` is null until start() probes; `forcedEra` lets a
    // config pin one so a known server never pays the probe.
    this.era = null
    this.forcedEra = era === MCP_ERA.MODERN || era === MCP_ERA.LEGACY ? era : null
    this.protocolVersion = MODERN_PROTOCOL_VERSION
    this.serverProtocolVersion = null
    this.config = config
    this.clientCaps = clientCapabilities(config)
    this.onEvent = typeof onEvent === "function" ? onEvent : null
    this.lastUsedAt = 0
  }

  /** Era is a property of the server, not of one connection. */
  _eraKey() { return `stdio|${this.name}|${this.command}|${this.args.join(" ")}` }

  _fail(reason) {
    this._closed = true
    this._exitReason = reason
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      p.cleanup?.()
      p.reject(new Error(`MCP server "${this.name}" ${reason}`))
    }
    this._pending.clear()
  }

  _onData(chunk) {
    this._buf += chunk
    if (this._buf.length > MAX_LINE_BYTES) {
      // a well-behaved server sends one JSON object per line; unbounded growth
      // with no newline means a broken/hostile server — cut it off.
      this._buf = ""
      this._fail("sent an over-long line with no message boundary")
      try { this.child?.kill("SIGKILL") } catch {}
      return
    }
    let nl
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl).trim()
      this._buf = this._buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue } // ignore non-JSON noise
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    if (!msg || typeof msg !== "object") return
    // A RESPONSE to something we asked.
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      p.cleanup?.()
      if (msg.error) p.reject(new McpProtocolError(msg.error.code, msg.error.message, msg.error.data))
      else p.resolve(msg.result)
      return
    }
    // v131: a NOTIFICATION. Until now every one of these was dropped on the
    // floor, which is why a forty-second server call and a hung one looked
    // exactly alike from the outside.
    if (msg.id === undefined && typeof msg.method === "string") {
      if (msg.method === "notifications/progress" || msg.method === "notifications/message") {
        const type = msg.method === "notifications/progress" ? "mcp_progress" : "mcp_log"
        try { this.onEvent?.({ type, server: this.name, params: msg.params ?? {} }) } catch { /* a listener must never break the transport */ }
      }
      return
    }
    // v131: a server-initiated REQUEST. Only the legacy era permits these (the
    // modern era replaced them with MRTR), and forge answers exactly the ones
    // it declared — anything else gets an honest "method not found" instead of
    // the silence that used to hang the server forever.
    if (msg.id !== undefined && typeof msg.method === "string") this._serve(msg).catch(() => {})
  }

  /** Write a response to a server-initiated request (legacy era only). */
  _reply(id, body) {
    if (this._closed) return
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n") } catch { /* the pipe is gone; _fail will speak */ }
  }

  async _serve(msg) {
    this._reply(msg.id, await serveServerRequest(msg, this))
  }

  /**
   * One JSON-RPC request.
   *
   * v131 adds three things and changes nothing else: `_meta` on the modern era
   * (the probe passes its own, because era is not decided yet when it runs), a
   * per-call timeout so the era probe is cheap, and a `signal` that turns a
   * user's Ctrl+C into a real `notifications/cancelled` rather than a wait.
   */
  _request(method, params, { timeoutMs, meta, signal, progress = false } = {}) {
    if (this._closed) return Promise.reject(new Error(`MCP server "${this.name}" is closed (${this._exitReason || "not connected"})`))
    const id = this._nextId++
    this.lastUsedAt = Date.now()
    const base = params ?? {}
    const extra = meta ?? (this.era === MCP_ERA.MODERN ? clientMeta(this.protocolVersion, this.clientCaps) : null)
    // A progressToken is what ENTITLES the server to send progress: without one
    // a well-behaved server stays silent. Only asked for when someone listens.
    const token = progress && this.onEvent ? { progressToken: `forge-${id}` } : null
    const body = extra || token ? { ...base, _meta: { ...(base._meta ?? {}), ...(extra ?? {}), ...(token ?? {}) } } : base
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: body })
    if (payload.includes("\n")) return Promise.reject(new Error("internal: request contained a newline"))
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    return new Promise((resolve, reject) => {
      const cleanup = () => { try { signal?.removeEventListener("abort", onAbort) } catch { /* not an AbortSignal */ } }
      const onAbort = () => {
        if (!this._pending.has(id)) return
        this._pending.delete(id)
        clearTimeout(timer)
        cleanup()
        // Tell the server to stop working; it owes us no reply to a notification.
        // Through `cancel()` rather than `_notify` directly, so there is exactly
        // one place that knows what cancelling an MCP request looks like.
        this.cancel(id)
        reject(new Error(`MCP request "${method}" to "${this.name}" was cancelled`))
      }
      const timer = setTimeout(() => {
        this._pending.delete(id)
        cleanup()
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out after ${waitMs}ms`))
      }, waitMs)
      this._pending.set(id, { resolve, reject, timer, cleanup })
      if (signal) {
        if (signal.aborted) { onAbort(); return }
        try { signal.addEventListener("abort", onAbort, { once: true }) } catch { /* not an AbortSignal */ }
      }
      try {
        this.child.stdin.write(payload + "\n")
      } catch (e) {
        this._pending.delete(id)
        clearTimeout(timer)
        cleanup()
        reject(new Error(`MCP write to "${this.name}" failed: ${e.message}`))
      }
    })
  }

  _notify(method, params) {
    if (this._closed) return
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n") } catch {}
  }

  async start() {
    if (!this.command || typeof this.command !== "string") throw new Error(`MCP server "${this.name}" has no command`)
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: childEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (d) => this._onData(d))
    this.child.on("error", (e) => this._fail(`could not launch (${e.message})`))
    this.child.on("exit", (code, sig) => this._fail(`exited (${sig || "code " + code})`))
    // stderr is the server's private log; drain it so the pipe never blocks.
    this.child.stderr.on("data", () => {})

    this.era = await this._probeEra()
    ERA_CACHE.set(this._eraKey(), this.era)
    // MODERN: there is no handshake at all. `server/discover` already returned
    // the serverInfo and capabilities the handshake used to carry.
    if (this.era === MCP_ERA.MODERN) return this

    // LEGACY: unchanged from v23, deliberately — every MCP server in the wild
    // today is on this path, and the probe above is the only thing that
    // precedes it.
    const init = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // v131: no longer `{}`. forge answers roots/list (and sampling when the
      // user enables it) on this transport, so declaring them is honest — and
      // an undeclared capability is one a server may never ask for.
      capabilities: this.clientCaps,
      clientInfo: { name: "forge", version: VERSION },
    })
    this.serverInfo = init?.serverInfo ?? null
    this.capabilities = init?.capabilities ?? null
    // The server's own protocolVersion was read and thrown away on both
    // transports since v23 — a latent bug, because it is the only place a
    // legacy server states what it actually speaks.
    this.serverProtocolVersion = typeof init?.protocolVersion === "string" ? init.protocolVersion : null
    this._notify("notifications/initialized")
    return this
  }

  /**
   * Which era does this server speak? Ask `server/discover` and read the
   * answer, with one rule that is easy to get wrong and fatal if you do:
   *
   *   the fallback MUST NOT be keyed to a specific error code.
   *
   * A legacy server meeting an unknown pre-`initialize` method may answer
   * -32601, or -32602, or nothing at all. Only a RECOGNIZED MODERN reply — a
   * DiscoverResult, or UnsupportedProtocolVersionError — means modern; every
   * other outcome means legacy.
   */
  async _probeEra() {
    if (this.forcedEra) return this.forcedEra
    const cached = ERA_CACHE.get(this._eraKey())
    if (cached) return cached
    const probeMs = Math.min(this.timeoutMs, PROBE_TIMEOUT_MS)
    let res
    try {
      res = await this._request("server/discover", {}, { timeoutMs: probeMs, meta: clientMeta(MODERN_PROTOCOL_VERSION, this.clientCaps) })
    } catch (e) {
      if (!(e instanceof McpProtocolError) || e.code !== UNSUPPORTED_PROTOCOL_VERSION) return MCP_ERA.LEGACY
      // A modern server saying "not that revision, here are mine". This is a
      // NEGOTIATION, not a fallback signal — retry, never downgrade.
      const offered = e.data?.supported ?? e.data?.supportedVersions
      const picked = pickProtocolVersion(offered)
      if (!picked) {
        throw new Error(`MCP server "${this.name}" speaks ${JSON.stringify(offered ?? [])}; forge speaks ${MODERN_PROTOCOL_VERSION} and ${PROTOCOL_VERSION}`)
      }
      this.protocolVersion = picked
      res = await this._request("server/discover", {}, { timeoutMs: probeMs, meta: clientMeta(picked, this.clientCaps) })
    }
    if (!isDiscoverResult(res)) return MCP_ERA.LEGACY
    const offered = discoveredVersions(res)
    if (offered.length) {
      const picked = pickProtocolVersion(offered)
      // A DUAL-ERA server that offers only legacy revisions: take it at its
      // word and handshake, rather than asserting a version it never claimed.
      if (!picked) return MCP_ERA.LEGACY
      this.protocolVersion = picked
    }
    this.serverInfo = res.serverInfo ?? null
    this.capabilities = res.capabilities ?? null
    this.serverProtocolVersion = this.protocolVersion
    return MCP_ERA.MODERN
  }

  /** Has this client been used recently, and is its child still there? */
  isAlive() { return this._closed !== true && this.child?.exitCode === null && this.child?.signalCode === null }

  /** A liveness check: a dead stdio server stops looking like a slow one. */
  async ping({ timeoutMs } = {}) {
    try { await this._request("ping", {}, { timeoutMs: timeoutMs ?? Math.min(this.timeoutMs, PROBE_TIMEOUT_MS) }); return true } catch { return false }
  }

  /** Ask the server to abandon an in-flight request. Fire-and-forget by spec. */
  cancel(requestId, reason = "cancelled by the user") {
    this._notify("notifications/cancelled", { requestId, reason })
  }

  /** @returns {Promise<Array<{name,description,inputSchema}>>} */
  async listTools() {
    const res = await this._request("tools/list", {})
    const tools = Array.isArray(res?.tools) ? res.tools : []
    return tools.filter((t) => t && typeof t.name === "string")
  }

  /** The three methods a server may answer with an InputRequiredResult. */
  _mrtr(opts) {
    return (method, params) => this._request(method, params, { ...opts, progress: true })
  }

  /** Call a tool. Returns { text, isError } — content flattened to text. */
  async callTool(tool, args, { signal } = {}) {
    const res = await runWithInput(this._mrtr({ signal }), "tools/call", { name: tool, arguments: args ?? {} },
      { name: this.name, config: this.config, cwd: this.cwd, signal })
    return { text: flattenContent(res?.content), isError: res?.isError === true }
  }

  async listResources() {
    const res = await this._request("resources/list", {})
    return normalizeResources(res)
  }

  async readResource(uri, { signal } = {}) {
    const res = await runWithInput(this._mrtr({ signal }), "resources/read", { uri },
      { name: this.name, config: this.config, cwd: this.cwd, signal })
    return flattenResourceContents(res)
  }

  async listPrompts() {
    const res = await this._request("prompts/list", {})
    return normalizePrompts(res)
  }

  async getPrompt(name, args, { signal } = {}) {
    const res = await runWithInput(this._mrtr({ signal }), "prompts/get", { name, arguments: args ?? {} },
      { name: this.name, config: this.config, cwd: this.cwd, signal })
    return flattenPromptMessages(res)
  }

  close() {
    if (this._closed) return
    this._closed = true
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.cleanup?.(); p.reject(new Error(`MCP server "${this.name}" closed`)) }
    this._pending.clear()
    // Graceful shutdown for the stdio transport: closing our stdin is the
    // conventional "you may exit now" signal, so a well-behaved server exits on
    // its own. A SIGKILL fallback (after a grace period) handles a stuck server
    // without ever leaking a child process. The timer is unref'd so it never
    // keeps forge's own process alive.
    const child = this.child
    try { child?.stdin?.end() } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      const t = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000)
      if (t.unref) t.unref()
      child.once?.("exit", () => clearTimeout(t))
    }
  }
}

/**
 * One MCP server reached over Streamable HTTP (spec 2025-03-26) instead of
 * stdio. Same public surface as the stdio client — name / serverInfo /
 * capabilities / listTools() / callTool() / close() — so everything downstream
 * (mcpToolsToPlugins, the inventory cache, the capability fabric) is unchanged.
 *
 * Why this exists: forge was stdio-only, which meant every HOSTED MCP server
 * (the bulk of the ecosystem — Linear, Notion, Sentry, remote GitHub) was
 * simply unreachable, no matter how it was configured.
 *
 * Every request goes through netguard.pinnedFetch, so a remote endpoint gets
 * the same DNS-pinning / private-address / redirect protection as any other
 * outbound URL. A server on a private address (a local dev stack) requires the
 * same explicit opt-in as any other private fetch — never an implicit one.
 *
 * The endpoint may answer a POST with either `application/json` (one response)
 * or `text/event-stream` (SSE frames); both are handled. We are a minimal
 * client: we issue requests and read responses, and ignore server-initiated
 * traffic, exactly like the stdio client.
 */
class McpHttpClient {
  constructor(name, { url, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, allowPrivate = false, onEvent = null, config = null, era = null, cwd } = {}) {
    this.name = name
    this.url = String(url || "")
    this.extraHeaders = headers && typeof headers === "object" ? headers : {}
    this.timeoutMs = timeoutMs
    this.allowPrivate = allowPrivate === true
    this._nextId = 1
    this._closed = false
    this._sessionId = null
    this.serverInfo = null
    this.capabilities = null
    this.cwd = cwd
    this.era = null
    this.forcedEra = era === MCP_ERA.MODERN || era === MCP_ERA.LEGACY ? era : null
    this.protocolVersion = MODERN_PROTOCOL_VERSION
    this.serverProtocolVersion = null
    this.config = config
    this.clientCaps = clientCapabilities(config)
    this.onEvent = typeof onEvent === "function" ? onEvent : null
    this.lastUsedAt = 0
    this._stream = null      // the open server→client SSE channel, if any
    this._streamBuf = ""     // bytes of a frame not yet terminated
    this._closing = null     // v152: the session DELETE close() started, if any
    // v150 — keeping the channel, not just opening it once:
    this._streamGen = 0      // which stream a chunk belongs to; stale ones are ignored
    this._lastEventId = null // the SSE cursor, sent back as Last-Event-ID on re-open
    this._retryMs = null     // the server's `retry:` — the spec says the client MUST wait it
    this._lastOpenStatus = null
    this._reopen = null      // AbortController of a re-open in progress
    this._renewing = null    // a session renewal in flight, shared by concurrent 404s
    /** none | open | reconnecting | lost — what the back-channel is right now. */
    this.backChannel = "none"
    // v162: "streamable" (2025-03-26+) or "sse" (2024-11-05 HTTP+SSE)
    this.transport = "streamable"
    this._sseEndpoint = null   // where an SSE-transport server takes our POSTs
    this._sseWaiters = []      // resolvers waiting for the `endpoint` event
    this._ssePending = new Map() // id → { resolve, reject } for answers on the stream
    this._sseReconnecting = null
    // The re-open bounds, per client so a test can shorten them on its own
    // instance instead of waiting out the real minute. Not configuration.
    this.reopenBaseMs = REOPEN_BASE_MS
    this.reopenMaxMs = REOPEN_MAX_MS
    this.reopenAttempts = REOPEN_MAX_ATTEMPTS
  }

  _eraKey() { return `http|${this.name}|${this.url}` }

  _headers(extra = {}) {
    const h = {
      "content-type": "application/json",
      // both response shapes are acceptable to us
      accept: "application/json, text/event-stream",
      "user-agent": `forge-agent/${VERSION}`,
      ...resolveMcpHeaders(this.extraHeaders, process.env, this.name),
      ...extra,
    }
    if (this._sessionId) h["mcp-session-id"] = this._sessionId
    // On HTTP the modern spec carries the revision in a HEADER as well as in
    // `_meta`, so a gateway can route on it without parsing the body.
    if (this.era === MCP_ERA.MODERN) h["mcp-protocol-version"] = this.protocolVersion
    return h
  }

  /** Pull the JSON-RPC payload out of an SSE stream: the first `data:` frame
   *  carrying a JSON object with our id. Non-data lines are protocol noise. */
  static parseSse(text) {
    const out = []
    for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      if (!data) continue
      try { out.push(JSON.parse(data)) } catch { /* a non-JSON frame is noise */ }
    }
    return out
  }

  async _rpc(method, params, { notify = false, meta, timeoutMs, signal, renewed = false } = {}) {
    if (this._closed) throw new Error(`MCP server "${this.name}" is closed`)
    if (this.transport === "sse") return this._sseRpc(method, params, { notify, timeoutMs, signal })
    const sentSession = this._sessionId
    const id = notify ? undefined : this._nextId++
    this.lastUsedAt = Date.now()
    const base = params ?? {}
    const extra = meta ?? (this.era === MCP_ERA.MODERN ? clientMeta(this.protocolVersion, this.clientCaps) : null)
    const body = extra ? { ...base, _meta: { ...(base._meta ?? {}), ...extra } } : base
    const payload = { jsonrpc: "2.0", method, params: body, ...(notify ? {} : { id }) }
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    let res
    try {
      res = await pinnedFetch(this.url, {
        method: "POST",
        headers: this._headers(meta ? { "mcp-protocol-version": String(meta[`${META}protocolVersion`] ?? this.protocolVersion) } : {}),
        body: Buffer.from(JSON.stringify(payload)),
        timeoutMs: waitMs,
        totalTimeoutMs: waitMs,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        maxBytes: MAX_LINE_BYTES,
        signal: signal ?? undefined,
      })
    } catch (e) {
      throw new Error(`MCP HTTP request "${method}" to "${this.name}" failed: ${e.message}`)
    }
    // the server may hand us a session id on initialize; echo it from then on
    const sid = res.headers?.["mcp-session-id"]
    if (sid && !this._sessionId) this._sessionId = String(sid)
    // v150: the server restarted and forgot us. The spec: a 404 in response
    // to a request carrying a session id means the client "MUST start a new
    // session". Before this, every call after a server restart failed with
    // "MCP HTTP 404" until forge itself was restarted. A 404 means the request
    // was not processed, so it is safe to send once more on the new session —
    // once: a second 404 is a real answer.
    if (res.status === 404 && sentSession && !renewed && method !== "initialize" && this.era === MCP_ERA.LEGACY) {
      try { res.close?.() } catch { /* body unread */ }
      await this._renewSession(`the session expired (HTTP 404 on ${method})`)
      return this._rpc(method, params, { notify, meta, timeoutMs, signal, renewed: true })
    }
    if (notify) return null
    const ctype = String(res.headers?.["content-type"] ?? "")
    const text = res.body?.toString("utf8") ?? ""
    let msg = null
    if (/text\/event-stream/i.test(ctype)) {
      msg = McpHttpClient.parseSse(text).find((m) => m && m.id === id) ?? null
    } else {
      try { msg = JSON.parse(text) } catch { msg = null }
      if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id) ?? null
    }
    // v131: a non-2xx used to be thrown on SIGHT, before the body was read. A
    // modern server answers an unsupported revision with a JSON-RPC -32022
    // inside a 400 — the one reply that must NOT be read as "this endpoint is
    // broken", because it is the server telling us how to talk to it.
    if (!res.ok) {
      if (msg?.error) throw new McpProtocolError(msg.error.code, msg.error.message, msg.error.data)
      const err = new Error(`MCP HTTP ${res.status} from "${this.name}" for "${method}"`)
      err.status = res.status
      throw err
    }
    if (!msg) throw new Error(`MCP HTTP response from "${this.name}" for "${method}" was not a JSON-RPC result`)
    if (msg.error) throw new McpProtocolError(msg.error.code, msg.error.message, msg.error.data)
    return msg.result
  }

  async start() {
    if (!/^https?:\/\//i.test(this.url)) throw new Error(`MCP server "${this.name}" has an invalid url`)
    this.era = await this._probeEra()
    ERA_CACHE.set(this._eraKey(), this.era)
    if (this.era === MCP_ERA.MODERN) return this
    await this._initializeSession()
    return this
  }

  /**
   * Open the back-channel, then initialize a session declaring what it allows.
   * Shared by start() and by _renewSession() after the server forgot us.
   */
  async _initializeSession() {
    // v143: the back-channel opens FIRST, and what it finds decides what forge
    // is entitled to declare. Until now this sent `capabilities: {}` because a
    // legacy server told forge supports roots or sampling may answer with a
    // server-initiated JSON-RPC REQUEST, and POST-only Streamable HTTP gave
    // forge nowhere to answer it. The GET stream IS that channel — so the
    // declaration follows the channel rather than the other way round, and a
    // server whose GET is refused still gets the honest `{}`.
    const streamed = await this._openBackChannel()
    const initParams = (withStream) => ({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: withStream ? this.clientCaps : {},
      clientInfo: { name: "forge", version: VERSION },
    })
    let init
    try {
      init = await this._rpc("initialize", initParams(streamed))
    } catch (e) {
      // v162 — THE 2024-11-05 HTTP+SSE TRANSPORT. The spec (2025-11-25,
      // Transports, Backwards Compatibility): a client supporting older
      // servers POSTs initialize and, if that fails with 400, 404 or 405,
      // "issue[s] a GET request to the server URL, expecting that this will
      // open an SSE stream and return an endpoint event as the first event".
      // It is the transport Harbor gives a task's server when only a url is
      // named. The stream IS the channel, so the full capabilities go with it.
      if (this.transport === "sse" || !LEGACY_SSE_STATUSES.has(e?.status)) throw e
      await this._useSseTransport(e.status)
      init = await this._rpc("initialize", initParams(true))
    }
    this.serverInfo = init?.serverInfo ?? null
    this.capabilities = init?.capabilities ?? null
    this.serverProtocolVersion = typeof init?.protocolVersion === "string" ? init.protocolVersion : null
    try { await this._rpc("notifications/initialized", {}, { notify: true }) } catch { /* best-effort, matches stdio */ }
  }

  /**
   * Open the server→client SSE stream (Streamable HTTP's GET).
   *
   * A server MAY refuse it — 405 is the spec's own "this server has no
   * back-channel" — so a refusal is a normal outcome, not an error, and the
   * caller then declares nothing. Only a 200 `text/event-stream` counts.
   *
   * @returns {Promise<boolean>} whether a channel is open.
   */
  async _openBackChannel() {
    if (this._stream) return true
    this._lastOpenStatus = null
    // Each stream gets its own generation, so a chunk still in flight from a
    // stream that ended cannot land on the one that replaced it.
    const gen = ++this._streamGen
    // Resuming, not restarting: the spec's cursor, so a server that keeps
    // history can replay what was sent while the channel was down.
    const resume = this._lastEventId != null ? { "last-event-id": this._lastEventId } : {}
    let res
    try {
      res = await pinnedFetch(this.url, {
        method: "GET",
        headers: this._headers({ accept: "text/event-stream", ...resume }),
        timeoutMs: this.timeoutMs,
        totalTimeoutMs: this.timeoutMs,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        // A stream open is not worth retrying: the retry cannot succeed where
        // the first attempt did not, and it doubles what a server that never
        // answers the GET costs at connect time.
        retries: 0,
        onChunk: (c) => this._onStreamChunk(c, gen),
      })
    } catch {
      // No channel is a supported configuration; it must never fail the
      // connection, because every legacy server worked without one.
      return false
    }
    this._lastOpenStatus = res.status ?? null
    if (!res.ok || !/text\/event-stream/i.test(String(res.headers?.["content-type"] ?? ""))) {
      try { res.close?.() } catch { /* nothing was opened */ }
      return false
    }
    const sid = res.headers?.["mcp-session-id"]
    if (sid && !this._sessionId) this._sessionId = String(sid)
    this._stream = res
    this._streamBuf = ""
    this.backChannel = "open"
    // A channel is quiet by design — the server speaks when it has something
    // to say. The socket's idle timeout is the REQUEST timeout, so without
    // this a quiet server's channel was dropped and re-opened every
    // timeoutMs (every 20s by default): churn, and a gap each time.
    res.setIdleTimeout?.(Math.max(this.timeoutMs, SSE_IDLE_TIMEOUT_MS))
    return true
  }

  _channelEvent(state, extra = {}) {
    try { this.onEvent?.({ type: "mcp_back_channel", server: this.name, state, ...extra }) } catch { /* a listener must never break the transport */ }
  }

  /**
   * The server ended the channel: open it again.
   *
   * This is what v143 left out. It opened the channel and declared roots and
   * sampling on the strength of it; when the stream then ended — a server
   * restart, a proxy's idle timeout — forge noticed and did nothing, so a long
   * session kept the declaration and lost the channel it was based on.
   *
   * Three outcomes, each from the spec: a 405 means the server no longer
   * offers a stream (LOST — retrying cannot help); a 404 on a request carrying
   * our session id means the session is gone, and the client MUST start a new
   * one; anything else is retried with backoff, never sooner than the
   * server's own `retry:`, until REOPEN_MAX_ATTEMPTS say it is gone.
   */
  async _reopenBackChannel(why) {
    if (this._reopen || this._closed) return
    const ctl = new AbortController()
    this._reopen = ctl
    this.backChannel = "reconnecting"
    this._channelEvent("dropped", { why })
    try {
      for (let attempt = 0; attempt < this.reopenAttempts; attempt++) {
        const wait = Math.max(this._retryMs ?? 0, backoffDelay(attempt, { baseMs: this.reopenBaseMs, maxMs: this.reopenMaxMs }))
        await sleepAbortable(wait, ctl.signal, { unref: true })
        if (ctl.signal.aborted || this._closed) return
        if (await this._openBackChannel()) {
          this._channelEvent("reopened", { attempts: attempt + 1, resumedFrom: this._lastEventId })
          return
        }
        if (ctl.signal.aborted || this._closed) return
        if (this._lastOpenStatus === 405) return this._channelLost("the server no longer offers a stream (HTTP 405)")
        if (this._lastOpenStatus === 404 && this._sessionId) {
          try { await this._renewSession("the session expired (HTTP 404 on re-open)") } catch (e) { this._channelLost(`the session expired and could not be renewed: ${String(e?.message ?? e).slice(0, 160)}`) }
          return
        }
      }
      this._channelLost(`${this.reopenAttempts} attempts to re-open failed`)
    } finally {
      if (this._reopen === ctl) this._reopen = null
    }
  }

  /**
   * Given up. The session's declaration is now wider than what forge can
   * serve, and legacy MCP has no way to narrow it mid-session — renewing the
   * session just to declare `{}` would discard server-side state over a
   * transport hiccup. So it is SAID, as an event and in `backChannel`, rather
   * than silently kept.
   */
  _channelLost(why) {
    this.backChannel = "lost"
    this._channelEvent("lost", { why })
  }

  /**
   * The server no longer knows our session (HTTP 404 with a session id). The
   * spec: "it MUST start a new session by sending a new InitializeRequest
   * without a session ID attached." Concurrent 404s share one renewal.
   */
  async _renewSession(why) {
    if (this._renewing) return this._renewing
    this._renewing = (async () => {
      this._channelEvent("session_expired", { why })
      this.closeStream()
      this._sessionId = null
      // The cursor belonged to the old session's streams.
      this._lastEventId = null
      await this._initializeSession()
      this._channelEvent("session_renewed", { backChannel: this.backChannel })
    })()
    try { return await this._renewing } finally { this._renewing = null }
  }

  /**
   * One chunk of the SSE channel.
   *
   * netguard streams without accumulating — deliberately, because a channel
   * held open for an hour exceeds any cap that could be written — so bounding
   * the buffer is THIS function's job. An event that never terminates is the
   * shape that would otherwise grow without limit, so a frame larger than
   * MAX_SSE_FRAME_BYTES closes the channel rather than being truncated into
   * something that might parse as a different message.
   */
  _onStreamChunk(chunk, gen = this._streamGen) {
    // A stream that has been replaced — or closed on purpose: closeStream()
    // advances the generation before it closes, so the end-of-stream a
    // deliberate close causes arrives stale and stops here. That is the ONE
    // thing separating a deliberate close from a drop. (A second check on
    // `_stream !== null` used to sit below as well; a mutation run showed no
    // input could ever make it matter, so it went.)
    if (gen !== this._streamGen) return
    if (chunk === null) {
      // Ended by the SERVER, or by the network in between.
      this._stream = null
      this._streamBuf = ""
      // v162: on the SSE transport the stream IS the session — its endpoint
      // dies with it. Calls waiting on it fail now; the next call reconnects.
      if (this.transport === "sse") return this._sseStreamLost("the server ended the SSE stream")
      if (!this._closed) this._reopenBackChannel("the server ended the stream")
      return
    }
    this._streamBuf += chunk.toString("utf8")
    let cut
    while ((cut = this._streamBuf.search(/\r?\n\r?\n/)) !== -1) {
      const block = this._streamBuf.slice(0, cut)
      this._streamBuf = this._streamBuf.slice(cut).replace(/^\r?\n\r?\n/, "")
      const lines = block.split(/\r?\n/)
      // `id` and `retry` count even on an event with no data — the spec's
      // "priming" event is exactly an id and an empty data field. Per the SSE
      // standard one leading space is stripped; an id containing NUL is ignored.
      for (const l of lines) {
        if (l.startsWith("id:")) {
          const v = l.slice(3).replace(/^ /, "")
          if (!v.includes("\0")) this._lastEventId = v
        } else if (l.startsWith("retry:")) {
          const v = l.slice(6).replace(/^ /, "")
          if (/^\d+$/.test(v)) this._retryMs = Math.min(Number(v), REOPEN_RETRY_CAP_MS)
        }
      }
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      if (!data) continue
      // v162: the 2024-11-05 transport's first event names where to POST
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim()
      if (event === "endpoint") { this._onSseEndpoint(data); continue }
      let msg = null
      try { msg = JSON.parse(data) } catch { continue } // a non-JSON frame is noise
      // …and every answer to forge's own requests arrives on the stream too
      if (this.transport === "sse" && msg && typeof msg.method !== "string" && msg.id !== undefined && this._ssePending.has(msg.id)) {
        this._ssePending.get(msg.id).resolve(msg)
        continue
      }
      this._dispatchStream(msg)
    }
    if (this._streamBuf.length > MAX_SSE_FRAME_BYTES) {
      // Deliberate, and NOT re-opened: a server that sends a frame this large
      // would send it again, and re-opening would turn a bound into a loop.
      this.closeStream()
      this._channelLost(`a frame exceeded ${MAX_SSE_FRAME_BYTES} bytes`)
    }
  }

  /**
   * A message arriving on the back-channel.
   *
   * Responses to forge's OWN requests are not routed here: those come back on
   * the POST that made them. What arrives here is what forge could never
   * receive before — the server's own notifications and requests.
   */
  _dispatchStream(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return
    if (msg.id === undefined) {
      if (msg.method === "notifications/progress" || msg.method === "notifications/message") {
        const type = msg.method === "notifications/progress" ? "mcp_progress" : "mcp_log"
        try { this.onEvent?.({ type, server: this.name, params: msg.params ?? {} }) } catch { /* a listener must never break the transport */ }
      }
      return
    }
    serveServerRequest(msg, this)
      .then((body) => this._replyOverHttp(msg.id, body))
      .catch(() => {})
  }

  /**
   * POST the answer to a server-initiated request.
   *
   * A JSON-RPC response carries no method, so this cannot go through `_rpc`,
   * which allocates an id and waits for one back. Failure is swallowed: the
   * server's own timeout is the backstop, and a dead answer must not take the
   * client down with it.
   */
  async _replyOverHttp(id, body) {
    if (this._closed) return
    try {
      await pinnedFetch(this.transport === "sse" && this._sseEndpoint ? this._sseEndpoint : this.url, {
        method: "POST",
        headers: this._headers(),
        body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body })),
        timeoutMs: this.timeoutMs,
        totalTimeoutMs: this.timeoutMs,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        maxBytes: MAX_LINE_BYTES,
      })
    } catch { /* the server times out on its own; this must not throw */ }
  }

  // ---- v162: the 2024-11-05 HTTP+SSE transport ----------------------------

  /** The `endpoint` event: where this session's POSTs go. Same origin only. */
  _onSseEndpoint(data) {
    let url
    try { url = new URL(String(data).trim(), this.url) } catch { return }
    // The endpoint is the server's own; a stream naming another host is not
    // an endpoint to send the session's traffic (and the user's headers) to.
    if (url.origin !== new URL(this.url).origin) return
    this._sseEndpoint = url.href
    for (const w of this._sseWaiters.splice(0)) w(url.href)
  }

  /** Switch to the SSE transport: a stream that names its endpoint, or fail saying why. */
  async _useSseTransport(status) {
    this.transport = "sse"
    if (!this._sseEndpoint) {
      const opened = this._stream ? true : await this._openBackChannel()
      const endpoint = opened ? await this._awaitSseEndpoint() : null
      if (!endpoint) {
        this.transport = "streamable"
        this.closeStream()
        throw new Error(`MCP server "${this.name}" refused initialize (HTTP ${status}) and its GET stream named no endpoint — neither Streamable HTTP nor the 2024-11-05 HTTP+SSE transport`)
      }
    }
    this.backChannel = "open"
    this._channelEvent("sse_transport", { endpoint: this._sseEndpoint })
  }

  _awaitSseEndpoint(ms = SSE_ENDPOINT_TIMEOUT_MS) {
    if (this._sseEndpoint) return Promise.resolve(this._sseEndpoint)
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._sseWaiters = this._sseWaiters.filter((w) => w !== done); resolve(null) }, Math.min(ms, this.timeoutMs))
      t.unref?.()
      const done = (href) => { clearTimeout(t); resolve(href) }
      this._sseWaiters.push(done)
    })
  }

  /** The stream ended: the session is gone with it. */
  _sseStreamLost(why) {
    this._sseEndpoint = null
    for (const [, p] of this._ssePending) p.reject(new Error(`MCP server "${this.name}": ${why}`))
    this._ssePending.clear()
    if (!this._closed) { this.backChannel = "none"; this._channelEvent("dropped", { why }) }
  }

  /** A new stream, a new endpoint, a new session — the next call's first step after a loss. */
  async _sseReconnect() {
    if (this._sseReconnecting) return this._sseReconnecting
    this._sseReconnecting = (async () => {
      this.closeStream()
      const opened = await this._openBackChannel()
      const endpoint = opened ? await this._awaitSseEndpoint() : null
      if (!endpoint) throw new Error(`MCP server "${this.name}": the SSE stream could not be re-opened`)
      const init = await this._sseRpc("initialize", {
        protocolVersion: PROTOCOL_VERSION, capabilities: this.clientCaps, clientInfo: { name: "forge", version: VERSION },
      }, { reconnecting: true })
      this.serverInfo = init?.serverInfo ?? this.serverInfo
      try { await this._sseRpc("notifications/initialized", {}, { notify: true, reconnecting: true }) } catch { /* best effort */ }
      this._channelEvent("reopened", { transport: "sse" })
    })()
    try { return await this._sseReconnecting } finally { this._sseReconnecting = null }
  }

  /**
   * One request on the SSE transport: POSTed to the endpoint, answered on
   * the stream (matched by id). A server that answers on the POST itself is
   * accepted too.
   */
  async _sseRpc(method, params, { notify = false, timeoutMs, signal, reconnecting = false } = {}) {
    if (this._closed) throw new Error(`MCP server "${this.name}" is closed`)
    if (!reconnecting && (!this._stream || !this._sseEndpoint)) await this._sseReconnect()
    const id = notify ? undefined : this._nextId++
    this.lastUsedAt = Date.now()
    const payload = { jsonrpc: "2.0", method, params: params ?? {}, ...(notify ? {} : { id }) }
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    let answered = null
    if (!notify) {
      answered = new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); this._ssePending.delete(id) }
        const timer = setTimeout(() => { finish(); reject(new Error(`MCP server "${this.name}" did not answer "${method}" within ${waitMs}ms`)) }, waitMs)
        timer.unref?.()
        const onAbort = () => { finish(); this.cancel(id); reject(new Error(`MCP call "${method}" to "${this.name}" was cancelled`)) }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener?.("abort", onAbort, { once: true })
        this._ssePending.set(id, { resolve: (m) => { finish(); resolve(m) }, reject: (e) => { finish(); reject(e) } })
      })
      answered.catch(() => {}) // observed below; never an unhandled rejection
    }
    let res
    try {
      res = await pinnedFetch(this._sseEndpoint, {
        method: "POST",
        headers: this._headers(),
        body: Buffer.from(JSON.stringify(payload)),
        timeoutMs: waitMs,
        totalTimeoutMs: waitMs,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        maxBytes: MAX_LINE_BYTES,
        signal: signal ?? undefined,
      })
    } catch (e) {
      this._ssePending.get(id)?.reject(new Error(`MCP HTTP request "${method}" to "${this.name}" failed: ${e.message}`))
      if (notify) throw new Error(`MCP HTTP request "${method}" to "${this.name}" failed: ${e.message}`)
      return this._sseAnswer(answered)
    }
    if (!res.ok) {
      const err = new Error(`MCP HTTP ${res.status} from "${this.name}" for "${method}" (SSE transport)`)
      err.status = res.status
      this._ssePending.get(id)?.reject(err)
      if (notify) throw err
      return this._sseAnswer(answered)
    }
    if (notify) return null
    // Some servers answer on the POST as well as (or instead of) the stream.
    try {
      const text = res.body?.toString("utf8") ?? ""
      const direct = text.trim().startsWith("{") ? JSON.parse(text) : null
      if (direct && direct.id === id) this._ssePending.get(id)?.resolve(direct)
    } catch { /* 202 Accepted with no body is the normal case */ }
    return this._sseAnswer(answered)
  }

  async _sseAnswer(answered) {
    const msg = await answered
    if (msg?.error) throw new McpProtocolError(msg.error.code, msg.error.message, msg.error.data)
    return msg?.result
  }

  /** Tear the back-channel down. Idempotent — close() and an ended stream both land here. */
  closeStream() {
    const s = this._stream
    this._stream = null   // cleared FIRST: the end-of-stream this causes is not a drop
    this._streamBuf = ""
    this._streamGen++     // any chunk still in flight belongs to a dead stream
    this._reopen?.abort() // a deliberate close also stops a re-open in progress
    this._reopen = null
    if (this.backChannel !== "lost") this.backChannel = "none"
    try { s?.close?.() } catch { /* already gone */ }
  }

  /** Same three-way rule as the stdio probe; see McpClient._probeEra. */
  async _probeEra() {
    if (this.forcedEra) return this.forcedEra
    const cached = ERA_CACHE.get(this._eraKey())
    if (cached) return cached
    const probeMs = Math.min(this.timeoutMs, PROBE_TIMEOUT_MS)
    let res
    try {
      res = await this._rpc("server/discover", {}, { timeoutMs: probeMs, meta: clientMeta(MODERN_PROTOCOL_VERSION, this.clientCaps) })
    } catch (e) {
      if (!(e instanceof McpProtocolError) || e.code !== UNSUPPORTED_PROTOCOL_VERSION) return MCP_ERA.LEGACY
      const offered = e.data?.supported ?? e.data?.supportedVersions
      const picked = pickProtocolVersion(offered)
      if (!picked) {
        throw new Error(`MCP server "${this.name}" speaks ${JSON.stringify(offered ?? [])}; forge speaks ${MODERN_PROTOCOL_VERSION} and ${PROTOCOL_VERSION}`)
      }
      this.protocolVersion = picked
      res = await this._rpc("server/discover", {}, { timeoutMs: probeMs, meta: clientMeta(picked, this.clientCaps) })
    }
    if (!isDiscoverResult(res)) return MCP_ERA.LEGACY
    const offered = discoveredVersions(res)
    if (offered.length) {
      const picked = pickProtocolVersion(offered)
      if (!picked) return MCP_ERA.LEGACY
      this.protocolVersion = picked
    }
    this.serverInfo = res.serverInfo ?? null
    this.capabilities = res.capabilities ?? null
    this.serverProtocolVersion = this.protocolVersion
    return MCP_ERA.MODERN
  }

  isAlive() { return this._closed !== true }

  async ping({ timeoutMs } = {}) {
    try { await this._rpc("ping", {}, { timeoutMs: timeoutMs ?? Math.min(this.timeoutMs, PROBE_TIMEOUT_MS) }); return true } catch { return false }
  }

  /** Over HTTP a cancellation is a notification POST like any other message. */
  cancel(requestId, reason = "cancelled by the user") {
    this._rpc("notifications/cancelled", { requestId, reason }, { notify: true }).catch(() => {})
  }

  async listTools() {
    const res = await this._rpc("tools/list", {})
    const tools = Array.isArray(res?.tools) ? res.tools : []
    return tools.filter((t) => t && typeof t.name === "string")
  }

  _mrtr(opts) {
    return (method, params) => this._rpc(method, params, opts)
  }

  async callTool(tool, args, { signal } = {}) {
    const res = await runWithInput(this._mrtr({ signal }), "tools/call", { name: tool, arguments: args ?? {} },
      { name: this.name, config: this.config, cwd: this.cwd, signal })
    return { text: flattenContent(res?.content), isError: res?.isError === true }
  }

  async listResources() { return normalizeResources(await this._rpc("resources/list", {})) }
  async readResource(uri, { signal } = {}) {
    return flattenResourceContents(await runWithInput(this._mrtr({ signal }), "resources/read", { uri },
      { name: this.name, config: this.config, cwd: this.cwd, signal }))
  }
  async listPrompts() { return normalizePrompts(await this._rpc("prompts/list", {})) }
  async getPrompt(name, args, { signal } = {}) {
    return flattenPromptMessages(await runWithInput(this._mrtr({ signal }), "prompts/get", { name, arguments: args ?? {} },
      { name: this.name, config: this.config, cwd: this.cwd, signal }))
  }

  close() {
    // Idempotent: a second close() must not send a second DELETE.
    if (this._closed) return this._closing ?? Promise.resolve()
    // HTTP is stateless per request: there is no child to reap. Marking closed
    // makes later calls fail honestly instead of silently reconnecting.
    this._closed = true
    // v162: calls waiting for an answer on an SSE stream about to close
    for (const [, p] of this._ssePending) p.reject(new Error(`MCP server "${this.name}" is closed`))
    this._ssePending.clear()
    // v143: except the back-channel, which is a held-open socket and the one
    // thing here that DOES leak if nobody closes it. Closed FIRST: a server
    // that ends the stream when its session is deleted must not look like a
    // drop to be re-opened (v150) — `_closed` is already set, and this makes
    // the ordering explicit rather than lucky.
    this.closeStream()
    this._closing = this._endSession()
    return this._closing
  }

  /**
   * End the session on the server (v152). The spec (2025-11-25, Session
   * Management): "Clients that no longer need a particular session ... SHOULD
   * send an HTTP DELETE to the MCP endpoint with the MCP-Session-Id header, to
   * explicitly terminate the session." Until v152 close() only marked the
   * client closed, so every server forge talked to kept the session — and
   * whatever it held for it — until its own timeout.
   *
   * Best effort by design: a 405 is the spec's "this server does not let
   * clients end sessions", a network failure changes nothing about the
   * client being closed, and neither may turn close() into an error. Bounded
   * by SESSION_DELETE_TIMEOUT_MS. Returns a promise so a caller about to exit
   * can wait for it; a caller that does not wait still gets it sent, because
   * the pending request keeps the event loop alive until it settles.
   */
  async _endSession() {
    const sid = this._sessionId
    if (!sid) return
    this._sessionId = null
    try {
      const res = await pinnedFetch(this.url, {
        method: "DELETE",
        headers: this._headers({ "mcp-session-id": sid }),
        timeoutMs: SESSION_DELETE_TIMEOUT_MS,
        totalTimeoutMs: SESSION_DELETE_TIMEOUT_MS,
        allowPrivate: this.allowPrivate ? "first-hop" : false,
        retries: 0,
        maxBytes: 64 * 1024,
      })
      try { res?.close?.() } catch { /* body unread */ }
    } catch { /* the session times out on the server instead; nothing else to do */ }
  }
}

/** `resources/list` → a bounded [{uri, name, description, mimeType}]. */
export function normalizeResources(res) {
  const list = Array.isArray(res?.resources) ? res.resources : []
  return list.filter((r) => r && typeof r.uri === "string").slice(0, 200).map((r) => ({
    uri: String(r.uri).slice(0, 500),
    name: String(r.name ?? "").slice(0, 200),
    description: String(r.description ?? "").slice(0, 300),
    mimeType: String(r.mimeType ?? "").slice(0, 100),
  }))
}

/** `prompts/list` → a bounded [{name, description}]. */
export function normalizePrompts(res) {
  const list = Array.isArray(res?.prompts) ? res.prompts : []
  return list.filter((p) => p && typeof p.name === "string").slice(0, 200).map((p) => ({
    name: String(p.name).slice(0, 200),
    description: String(p.description ?? "").slice(0, 300),
  }))
}

/** `resources/read` → the contents flattened to text, honestly labeled when a
 *  part is binary (blob) rather than silently dropped. */
export function flattenResourceContents(res) {
  const parts = Array.isArray(res?.contents) ? res.contents : []
  const out = []
  for (const c of parts) {
    if (!c || typeof c !== "object") continue
    if (typeof c.text === "string") out.push(c.text)
    else if (typeof c.blob === "string") out.push(`[binary resource ${c.mimeType || "data"}, ${c.blob.length} base64 chars — not inlined]`)
  }
  return out.join("\n")
}

/** `prompts/get` → the prompt's messages flattened to readable text. */
export function flattenPromptMessages(res) {
  const msgs = Array.isArray(res?.messages) ? res.messages : []
  const out = []
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue
    const body = typeof m.content === "string" ? m.content : flattenContent(m.content?.type ? [m.content] : m.content)
    out.push(`${String(m.role ?? "user")}: ${body}`)
  }
  return out.join("\n\n")
}

/**
 * One synthetic READ-ONLY tool per server that advertises resources and/or
 * prompts. MCP exposes three primitives — tools, resources, prompts — and forge
 * consumed only the first, so a server's documents, schemas and canned prompts
 * were invisible. Folding them into ONE tool per server (instead of one tool
 * per resource) keeps the context cost flat no matter how many resources a
 * server publishes, and read-only means the crew can use it too.
 */
export function mcpContextTool(client, caps) {
  const hasRes = Boolean(caps?.resources)
  const hasPrompts = Boolean(caps?.prompts)
  if (!hasRes && !hasPrompts) return null
  const name = mcpToolName(client.name, "context")
  const actions = [...(hasRes ? ["list_resources", "read_resource"] : []), ...(hasPrompts ? ["list_prompts", "get_prompt"] : [])]
  return {
    name,
    readOnly: true,
    annotations: { readOnlyHint: true },
    def: {
      type: "function",
      function: {
        name,
        description: `Read-only access to the documents and canned prompts published by MCP server "${client.name}". Actions: ${actions.join(", ")}.`,
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: actions },
            uri: { type: "string", description: "resource uri (read_resource)" },
            name: { type: "string", description: "prompt name (get_prompt)" },
          },
          required: ["action"],
        },
      },
    },
    source: `mcp:${client.name}`,
    async run(args) {
      const action = String(args?.action ?? "")
      try {
        if (action === "list_resources") {
          const r = await client.listResources()
          return r.length ? r.map((x) => `${x.uri}${x.name ? ` — ${x.name}` : ""}${x.mimeType ? ` [${x.mimeType}]` : ""}`).join("\n") : "(no resources published)"
        }
        if (action === "read_resource") {
          if (!args?.uri) return "ERROR: read_resource needs a uri"
          return (await client.readResource(String(args.uri))) || "(empty resource)"
        }
        if (action === "list_prompts") {
          const p = await client.listPrompts()
          return p.length ? p.map((x) => `${x.name}${x.description ? ` — ${x.description}` : ""}`).join("\n") : "(no prompts published)"
        }
        if (action === "get_prompt") {
          if (!args?.name) return "ERROR: get_prompt needs a name"
          return (await client.getPrompt(String(args.name), args?.arguments)) || "(empty prompt)"
        }
        return `ERROR: unknown action "${action}" — expected one of ${actions.join(", ")}`
      } catch (e) {
        return `ERROR: ${e.message}`
      }
    },
  }
}

/** Flatten an MCP content array (text/other parts) into a single string. */
export function flattenContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  const parts = []
  for (const c of content) {
    if (!c || typeof c !== "object") { parts.push(String(c)); continue }
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text)
    else if (c.type === "resource" && c.resource?.text) parts.push(String(c.resource.text))
    else if (c.type === "image") parts.push(`[image ${c.mimeType || "data"} omitted]`)
    else parts.push(JSON.stringify(c))
  }
  return parts.join("\n")
}

/** Connect and initialize a server. Caller owns close(). */
export async function connectServer(name, spec, { timeoutMs, onEvent = null, config = null } = {}) {
  // Transport is chosen by the SHAPE of the spec: a `url` is Streamable HTTP,
  // a `command` is stdio. Never guessed from anything else.
  const opts = { ...spec, timeoutMs: timeoutMs ?? spec?.timeoutMs, onEvent, config }
  const client = spec?.url
    ? new McpHttpClient(name, opts)
    : new McpClient(name, opts)
  await client.start()
  return client
}

/**
 * Is this server answering at all? A dead stdio child stops looking slow.
 *
 * v132 note on what is NOT here: v131 also shipped `cancelCall(client, id)` and
 * `onProgress(client, fn)` wrappers. Neither ever acquired a production caller,
 * and both duplicated something that already had exactly one implementation —
 * `client.cancel()` (which `_request`'s abort handler calls) and the `onEvent`
 * option on `connectServer`. §36: they are gone rather than wired, because
 * wiring a second way to do a thing is the failure the rule names.
 */
export async function pingServer(client, { timeoutMs } = {}) {
  try { return (await client?.ping?.({ timeoutMs })) === true } catch { return false }
}

/**
 * How long a memoized client may sit unused before it is pinged on reuse.
 *
 * A closed client is free to detect (`isAlive`), so the ping is only for the
 * case that costs something: a child still running but wedged, or a remote
 * endpoint that went away without telling us. Pinging on EVERY call would put
 * a round-trip in front of every MCP tool, which is a worse trade than the
 * failure it prevents.
 */
const MCP_IDLE_PING_MS = 30000

/**
 * Is this memoized client still worth reusing?
 *
 * Exported because it is the whole decision — "is the thing I cached still a
 * server?" — and a decision that only exists inside a closure cannot be tested
 * or benchmarked without spawning a real child and killing it.
 */
export async function clientReusable(client) {
  if (!client || client.isAlive?.() === false) return false
  if (Date.now() - Number(client.lastUsedAt ?? 0) < MCP_IDLE_PING_MS) return true
  return pingServer(client)
}

/**
 * v154 — MCP servers handed to ONE run (`forge agent --mcp-config FILE`).
 *
 * A harness gives the agent a task's MCP servers: Harbor tasks name them in
 * task.toml, and Harbor's BaseAgent says to "register the MCP servers in
 * self.mcp_servers with the agent". Until v154 forge took servers only from
 * the privileged `mcp` config section, so the one way to give a run its
 * servers was to edit the user's configuration, and the adapter dropped them.
 *
 * The file is the `.mcp.json` shape other agents already read and Harbor's
 * Claude Code agent writes: `{ "mcpServers": { name: { command, args, env } |
 * { type, url, headers } } }`. It comes from whoever runs forge, the same
 * person who could `forge mcp add` — never from the project, never from the
 * agent — and it is merged into this run's config in memory only.
 *
 * `${VAR}` and `${VAR:-default}` expand from the environment, as in those
 * other agents; values are resolved here and never written anywhere. A bad
 * FILE throws (the run cannot be what was asked); a bad ENTRY is skipped
 * with its reason, because the other servers and the task may still work.
 */
// v162: "sse" (the 2024-11-05 HTTP+SSE transport, Harbor's default) is an
// http url like the others — the HTTP client falls back to it on its own
export const RUN_MCP_TRANSPORTS = Object.freeze({ stdio: "stdio", http: "http", "streamable-http": "http", sse: "http" })
const RUN_MCP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_)){0,63}$/

function expandVars(value, env, missing) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, dflt) => {
    const v = env?.[name]
    if (v !== undefined && v !== "") return String(v)
    if (dflt !== undefined) return dflt
    missing.add(name)
    return ""
  })
}

function stringMap(obj, env, missing, what) {
  if (obj === undefined || obj === null) return {}
  if (typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${what} must be an object of strings`)
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`${what}.${k} must be a string`)
    out[k] = expandVars(v, env, missing)
  }
  return out
}

function runMcpSpec(entry, env) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("not an object")
  const declared = entry.type ?? entry.transport
  const type = declared === undefined ? (entry.url ? "http" : "stdio") : RUN_MCP_TRANSPORTS[declared]
  if (!type) {
    throw new Error(`unknown transport ${JSON.stringify(declared)} — use stdio, http, streamable-http or sse`)
  }
  const missing = new Set()
  let spec
  if (type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command.trim()) throw new Error("a stdio server needs a command")
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string" && typeof a !== "number"))) {
      throw new Error("args must be an array of strings")
    }
    spec = {
      command: expandVars(entry.command, env, missing),
      args: (entry.args ?? []).map((a) => expandVars(a, env, missing)),
      env: stringMap(entry.env, env, missing, "env"),
    }
  } else {
    if (typeof entry.url !== "string" || !entry.url.trim()) throw new Error("an http server needs a url")
    const url = expandVars(entry.url, env, missing)
    let parsed
    try { parsed = new URL(url) } catch { throw new Error(`url is not a URL: ${url.slice(0, 120)}`) }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`url must be http(s): ${url.slice(0, 120)}`)
    // The operator named this address, and a task's server is usually a
    // sidecar on a private network. First hop only: a redirect onward to a
    // private address is still refused by the network guard.
    spec = { url, headers: stringMap(entry.headers, env, missing, "headers"), allowPrivate: true }
  }
  if (missing.size) throw new Error(`needs ${[...missing].join(", ")} in the environment`)
  return spec
}

/** Parse a run's `.mcp.json`. Returns { servers: {name: spec}, skipped: [{name, reason}] }. */
export function parseRunMcpConfig(text, env = process.env) {
  let j
  try { j = JSON.parse(String(text)) } catch (e) { throw new Error(`not valid JSON: ${e.message}`) }
  const map = j && typeof j === "object" && !Array.isArray(j) ? j.mcpServers : undefined
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`expected { "mcpServers": { <name>: { … } } }`)
  const servers = {}
  const skipped = []
  for (const [name, entry] of Object.entries(map)) {
    if (!RUN_MCP_NAME.test(name)) { skipped.push({ name, reason: "a server name is 1-64 letters, digits, - or single _" }); continue }
    try { servers[name] = runMcpSpec(entry, env) } catch (e) { skipped.push({ name, reason: e.message }) }
  }
  return { servers, skipped }
}

/**
 * This run's config with the file's servers added. A new object at every
 * level it changes: the caller's config — the one `saveConfig` would write —
 * never holds them. A name the user already configured is replaced for this
 * run, because the file is the more specific instruction.
 */
export function withRunMcpServers(config, servers) {
  if (!servers || !Object.keys(servers).length) return config
  const mcp = config?.mcp && typeof config.mcp === "object" ? config.mcp : {}
  return { ...config, mcp: { ...mcp, servers: { ...(mcp.servers ?? {}), ...servers } } }
}

/** The configured, non-disabled servers as [name, spec] pairs. */
export function configuredServers(config) {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return []
  return Object.entries(servers).filter(([, s]) => s && typeof s === "object" && s.disabled !== true && (s.command || s.url))
}

/**
 * Adapt a connected client's tools into forge's plugin tool shape, so the agent
 * loop can treat them exactly like local plugins (same safety choke point).
 * Names are namespaced; an MCP tool is WRITE-class unless the server's own
 * ToolAnnotations declare `readOnlyHint: true` (absent hints stay WRITE).
 * The returned `run(args)` calls the server and returns a string; an MCP
 * `isError` result is surfaced as an "ERROR:" string, matching how the tool
 * layer marks failures (never thrown into the loop).
 */
/**
 * MCP `ToolAnnotations` (spec 2025-03-26), normalized and bounded.
 * Hints are the SERVER's own declaration about its tool: they are advisory
 * metadata, never a security boundary — an absent hint stays the safe default
 * (assume the tool mutates). Unknown/!== true values never widen anything.
 */
export function normalizeAnnotations(a) {
  if (!a || typeof a !== "object") return null
  const out = {}
  // Property ACCESS is the risk, not just the value: a getter can throw. This
  // object came off the wire, so reading it is the untrusted step — an
  // exception here would take down the whole tool-load for one bad server.
  try {
    if (typeof a.title === "string" && a.title) out.title = a.title.slice(0, 120)
  } catch { /* unreadable title → no title */ }
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    try { if (typeof a[k] === "boolean") out[k] = a[k] } catch { /* unreadable hint → absent, i.e. the safe default */ }
  }
  return Object.keys(out).length ? out : null
}

/** A tool is read-only ONLY when the server explicitly says so. Absent or
 *  malformed annotations keep the historical assumption (mutating), so this
 *  can never silently promote an unannotated tool into a read-only context. */
export function readOnlyHinted(t) {
  // Same untrusted-access rule as normalizeAnnotations: a throwing getter must
  // not escape. Anything unreadable falls back to the SAFE default (mutating),
  // so a hostile server can never promote its tool into a read-only context.
  try { return t?.annotations?.readOnlyHint === true } catch { return false }
}

export function mcpToolsToPlugins(client, tools) {
  return tools.map((t) => {
    const name = mcpToolName(client.name, t.name)
    const params = normalizeSchema(t.inputSchema)
    return {
      name,
      readOnly: readOnlyHinted(t),
      annotations: normalizeAnnotations(t.annotations),
      def: {
        type: "function",
        function: {
          name,
          description: String(t.description || `${t.name} (via MCP server ${client.name})`).slice(0, 500),
          parameters: params,
        },
      },
      source: `mcp:${client.name}`,
      // v131: `ctx.signal` is the user's Ctrl+C. It was never threaded past
      // this point, so an MCP call could only ever be WAITED OUT — to the 20s
      // request timeout, with the server still working the whole time.
      async run(args, ctx) {
        try {
          const r = await client.callTool(t.name, args, { signal: ctx?.signal ?? undefined })
          return r.isError ? `ERROR: ${r.text || "MCP tool reported an error"}` : (r.text || "(no output)")
        } catch (e) {
          return `ERROR: ${e.message}`
        }
      },
    }
  })
}

/** Coerce an MCP inputSchema into the JSON-schema object the tool layer expects. */
function normalizeSchema(schema) {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return { type: "object", properties: schema.properties ?? {}, ...(Array.isArray(schema.required) ? { required: schema.required } : {}) }
  }
  return { type: "object", properties: {} }
}

/**
 * Connect every configured server, collect their tools as plugin objects, and
 * return { tools, clients, errors }. Best-effort: a server that fails to start
 * is recorded in `errors`, never thrown. The caller closes `clients` when done.
 *
 * v96 unifywise — LAZY CONNECT (§28 "lazy load; do not load every MCP tool
 * into every model context"): by default (`config.mcp.lazy !== false`,
 * `FORGE_MCP_LAZY=0` opts out) a server with a FRESH cached tool inventory
 * (~/.forge/cache/mcp-tools.json, TTL 24h, keyed by name+command so configs
 * never collide) is NOT spawned at agent start — its tool defs are advertised
 * from the cache and the server connects on the FIRST tool call. A cold or
 * stale cache connects immediately (exactly the old eager behavior), lists,
 * and refreshes the cache — so a first run is byte-identical with before, and
 * every later run pays the server startup only if its tools are actually
 * used. On the first call the freshly connected server's listTools is checked
 * against the cached names: a tool that vanished is an honest ERROR, and the
 * cache entry is dropped (never serve a phantom capability).
 */
export async function loadMcpTools(config, { timeoutMs, cachedOnly = false, onEvent = null } = {}) {
  const lazy = lazyEnabled(config)
  const out = { tools: [], clients: [], errors: [] }
  // per-call memo of lazily-connected servers: name → Promise<McpClient>
  const lazyClients = new Map()
  const ensureConnected = async (name, spec) => {
    const memoized = lazyClients.get(name)
    if (memoized) {
      const client = await memoized.catch(() => null)
      if (await clientReusable(client)) return client
      // v132 — A DEAD SERVER USED TO BE MEMOIZED FOR THE WHOLE SESSION.
      //
      // v96 evicts a REJECTED connect, and named the reason: one transient
      // failure must not make every later call reuse it. A server that
      // connected fine and then DIED — crashed, was OOM-killed, restarted —
      // is the same bug one step further along, and it was not handled: the
      // memo kept the corpse, `_closed` was true, and every remaining tool
      // call in the session returned `is closed (exited …)`. Nothing retried,
      // because nothing had failed to *connect*.
      if (lazyClients.get(name) === memoized) lazyClients.delete(name)
      try { client?.close?.() } catch { /* already gone */ }
      onEvent?.({ type: "mcp_reconnect", server: name, params: { reason: "server was not answering" } })
      // another call may have raced us to the reconnect; never spawn twice
      const replacement = lazyClients.get(name)
      if (replacement) return replacement
    }
    // A cached era is the spec's own advice — era belongs to the server, not
    // to one connection — and it is what keeps the lazy path at exactly one
    // round-trip on a cold call instead of two.
    const known = freshInventory(name, spec)?.era
    const launch = known && !spec?.era ? { ...spec, era: known } : spec
    const p = connectServer(name, launch, { timeoutMs, onEvent, config }).then(async (client) => {
      // refresh the inventory from the live server (cheap: it just started)
      try {
        const tools = await client.listTools()
        saveInventory(cacheKey(name, launch), name, tools, client.capabilities, client.era)
      } catch { /* inventory refresh is best-effort; the call proceeds */ }
      return client
    })
    // v96: a REJECTED connect must not poison the memo for the whole session.
    p.catch(() => { if (lazyClients.get(name) === p) lazyClients.delete(name) })
    lazyClients.set(name, p)
    return p
  }
  const slots = [...configuredServers(config)].map(([name, spec]) => ({
    name, spec, inv: lazy ? freshInventory(name, spec) : null,
    tools: [], client: null, error: null,
  }))
  // v100: every COLD server handshakes in PARALLEL. These are independent child
  // processes, so the old sequential `await connectServer` per server made a
  // cold start pay the SUM of every server's startup (~300ms each → ~2.4s for
  // eight); it now costs the slowest one. Servers with a fresh cached inventory
  // are not spawned at all (v96 lazy connect), so they never enter this pass.
  await Promise.all(slots.filter((s) => !s.inv && !cachedOnly).map(async (s) => {
    let client
    try {
      client = await connectServer(s.name, s.spec, { timeoutMs, onEvent, config })
    } catch (e) { s.error = `${s.name}: ${e.message}`; return }
    try {
      const tools = await client.listTools()
      if (lazy) saveInventory(cacheKey(s.name, s.spec), s.name, tools, client.capabilities, client.era)
      s.client = client
      const ctx = mcpContextTool(client, client.capabilities)
      s.tools = [...mcpToolsToPlugins(client, tools), ...(ctx ? [ctx] : [])]
    } catch (e) {
      s.error = `${s.name}: tools/list failed — ${e.message}`
      client.close()
    }
  }))
  // Assemble in CONFIG order: parallelism must never reorder the tool list
  // (tool order is part of what the model sees, and tests pin it).
  for (const s of slots) {
    const sname = s.name
    if (s.inv) {
      out.tools.push(...inventoryToPlugins(sname, s.spec, s.inv.tools, { ensureConnected, timeoutMs }))
      if (s.inv.caps?.resources || s.inv.caps?.prompts) {
        // a lazy stand-in: the same read-only context tool, but it connects the
        // server on first use exactly like every other lazy stub
        const lazyClient = {
          name: sname,
          listResources: async () => (await ensureConnected(sname, s.spec)).listResources(),
          readResource: async (u) => (await ensureConnected(sname, s.spec)).readResource(u),
          listPrompts: async () => (await ensureConnected(sname, s.spec)).listPrompts(),
          getPrompt: async (n, a) => (await ensureConnected(sname, s.spec)).getPrompt(n, a),
        }
        const ctx = mcpContextTool(lazyClient, s.inv.caps)
        if (ctx) out.tools.push(ctx)
      }
      out.clients.push({
        name: sname,
        close() {
          const p = lazyClients.get(sname)
          if (!p) return
          lazyClients.delete(sname)
          // v152: returned, not dropped — the real client's close() may be a
          // session DELETE a caller about to exit wants to wait for.
          return Promise.resolve(p).then((c) => c.close()).catch(() => {})
        },
      })
      continue
    }
    if (cachedOnly) {
      // v100: cache-only callers (delegated sub-agents) never pay a server
      // handshake. A server with no fresh inventory is skipped HONESTLY rather
      // than spawned — the crew simply has fewer tools this run, never a stall.
      out.errors.push(`${sname}: skipped (cache-only: no fresh tool inventory)`)
      continue
    }
    if (s.error) { out.errors.push(s.error); continue }
    if (s.client) { out.clients.push(s.client); out.tools.push(...s.tools) }
  }
  return out
}

// --- v96 lazy-connect inventory cache --------------------------------------

const INVENTORY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHED_SERVERS = 64
const MAX_CACHED_TOOLS = 256

function lazyEnabled(config) {
  const env = String(process.env.FORGE_MCP_LAZY ?? "").toLowerCase()
  if (env === "0" || env === "false" || env === "off") return false
  if (config?.mcp && typeof config.mcp === "object" && config.mcp.lazy === false) return false
  return true
}

function inventoryPath() {
  return pathMod.join(resolveDataDir(), "cache", "mcp-tools.json")
}

/** Cache key = server name + command/args fingerprint: two configs that share
 *  a name but run different commands never collide (tests included). */
function cacheKey(name, spec) {
  // Include binding SHAPES so two accounts/configurations do not share an
  // inventory accidentally. Only the resulting hash is persisted; literal
  // credential values, when used by legacy configs, never leave memory.
  const shape = JSON.stringify({ url: spec.url || null, command: spec.command || null, args: spec.args || [], env: spec.env || {}, headers: spec.headers || {} })
  return `${name}:${createHash("sha256").update(shape).digest("hex").slice(0, 16)}`
}

function loadInventoryFile() {
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

function freshInventory(name, spec) {
  try {
    const entry = loadInventoryFile().servers[cacheKey(name, spec)]
    if (!entry || !Array.isArray(entry.tools)) return null
    const ttl = Number(process.env.FORGE_MCP_TTL_MS) > 0 ? Number(process.env.FORGE_MCP_TTL_MS) : INVENTORY_TTL_MS
    if (Date.now() - Number(entry.at ?? 0) >= ttl) return null
    return entry
  } catch { return null }
}

function saveInventory(key, name, tools, caps = null, era = null) {
  try {
    const file = loadInventoryFile()
    file.servers[key] = {
      at: Date.now(), name,
      // remember WHICH primitives the server offers, so the lazy path can
      // advertise the read-only context tool without a handshake
      // v131: this recorded only two of the server's primitives and discarded
      // the rest, so the lazy path could never know a cached server supported
      // tool-list change notifications, logging, or completions — and the ERA
      // was re-probed on every single cold call.
      caps: caps && typeof caps === "object"
        ? {
            resources: Boolean(caps.resources), prompts: Boolean(caps.prompts),
            tools: Boolean(caps.tools), logging: Boolean(caps.logging), completions: Boolean(caps.completions),
          }
        : undefined,
      era: era === MCP_ERA.MODERN || era === MCP_ERA.LEGACY ? era : undefined,
      tools: (tools ?? []).slice(0, MAX_CACHED_TOOLS).map((t) => ({
        name: String(t?.name ?? "").slice(0, 200),
        description: String(t?.description ?? "").slice(0, 500),
        inputSchema: t?.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : undefined,
        annotations: normalizeAnnotations(t?.annotations) ?? undefined,
      })),
    }
    const keys = Object.keys(file.servers)
    if (keys.length > MAX_CACHED_SERVERS) {
      // drop the oldest entries (bounded cache, never unbounded growth)
      const byAge = keys.sort((a, b) => (file.servers[a].at ?? 0) - (file.servers[b].at ?? 0))
      for (const k of byAge.slice(0, keys.length - MAX_CACHED_SERVERS)) delete file.servers[k]
    }
    writeStateFile(inventoryPath(), JSON.stringify(file))
  } catch { /* cache is a speedup, never a correctness dependency */ }
}

function dropInventory(key) {
  try {
    const file = loadInventoryFile()
    if (file.servers[key]) { delete file.servers[key]; writeStateFile(inventoryPath(), JSON.stringify(file)) }
  } catch { }
}

/** Build LAZY plugin stubs from a cached inventory: same shape as
 *  mcpToolsToPlugins, but run() connects the server on first call. */
function inventoryToPlugins(name, spec, tools, { ensureConnected, timeoutMs }) {
  return (tools ?? []).map((t) => {
    const name2 = mcpToolName(name, t.name)
    const params = normalizeSchema(t.inputSchema)
    return {
      name: name2,
      readOnly: readOnlyHinted(t),
      annotations: normalizeAnnotations(t.annotations),
      def: {
        type: "function",
        function: {
          name: name2,
          description: String(t.description || `${t.name} (via MCP server ${name})`).slice(0, 500),
          parameters: params,
        },
      },
      source: `mcp:${name}`,
      async run(args, ctx) {
        try {
          const client = await ensureConnected(name, spec)
          // honesty check: the cached def must still exist on the live server
          try {
            const live = await client.listTools()
            if (!live.some((x) => String(x?.name) === String(t.name))) {
              dropInventory(cacheKey(name, spec))
              return `ERROR: mcp tool ${t.name} no longer exists on server ${name} (cached inventory dropped — restart to re-advertise the real tool set)`
            }
          } catch { /* listing failed; let the call itself speak */ }
          const r = await client.callTool(t.name, args, { signal: ctx?.signal ?? undefined })
          return r.isError ? `ERROR: ${r.text || "MCP tool reported an error"}` : (r.text || "(no output)")
        } catch (e) {
          return `ERROR: ${e.message}`
        }
      },
    }
  })
}
