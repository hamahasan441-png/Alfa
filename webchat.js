/**
 * forge — the web chat's conversation engine (used by web.js).
 *
 * ONE conversation, three ways to answer a message:
 *
 *   chat    a streamed answer, no tools — questions, explanations, writing,
 *           reading attached files
 *   agent   the full agent: tools, files, commands, the orchestrator for big
 *           tasks (runtask.js) — with the activity shown live
 *   auto    forge decides per message (chooseMode) and says which it chose
 *
 * Conversations are ordinary forge sessions (sessions.js), so `forge chat
 * --continue` and `/resume` see a web conversation and the web sees terminal
 * ones. The model's messages are the session's `messages`; what only the
 * page needs (attachments, mode, activity, changed files) is `meta.web`.
 *
 * Attachments are saved under <project>/.forge/uploads/<id>/ — inside the
 * project, so an agent turn can open them with its own tools — and turned into
 * model input by docextract.js.
 */
import path from "node:path"
import { loadBuiltin } from "./lazybuiltin.js"
import { saveSession, loadSession, sessionsForCwd, projectSessionFile } from "./sessions.js"
import { describeFileIsolated, MAX_TEXT_CHARS } from "./docextract.js"

const fs = loadBuiltin("fs")

export const WEB_MODES = Object.freeze(["auto", "chat", "agent"])
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS = 12
const MAX_HISTORY = 40
/** All attachment text in one message, together (12 files × the per-file cap would be ~1.4M chars). */
export const MAX_MESSAGE_ATTACHMENT_CHARS = 240_000
const KEEP_FULL_TURNS = 2           // the last two of your messages keep their attachments whole
const OLD_ATTACHMENT_CHARS = 6000   // older ones are trimmed to this, per file
const MAX_HISTORY_CHARS = 400_000
const MAX_ACTIVITY = 200

// ---- auto mode -----------------------------------------------------------------

const ACT = /\b(create|build|implement|fix|refactor|add|remove|delete|rename|move|write|edit|update|modify|change|install|run|execute|test|debug|deploy|commit|push|generate|scaffold|set ?up|convert|migrate|format|lint|compile|make|bump|upgrade|replace|patch|apply|save|restructure|clean ?up|optimi[sz]e)\b/i
const ON_CODE = /\b(file|files|folder|directory|dir|code|codebase|function|class|method|module|component|repo|repository|project|test|tests|bug|app|website|site|script|api|endpoint|database|schema|config|package|dependency|dependencies|readme|branch|pr|commit|build|server|page|feature|cli|flag|html|css)\b|\.[a-z]{1,5}\b|[\w-]+\/[\w./-]+/i
const POLITE = /^\s*(please\s+)?(can|could|would|will)\s+you\b/i
const EXPLAIN = /^\s*(please\s+)?(can|could|would|will)\s+you\s+(please\s+)?(explain|tell|describe|show me how|help me understand|summari[sz]e|clarify|walk me through|teach)\b/i
const ASKING = /^\s*(what|why|how|when|where|who|which|is|are|can|could|should|would|does|do|explain|summari[sz]e|describe|tell me|translate|compare|define|list|show me|help me understand)\b|\?\s*$/i

/**
 * Chat or agent for one message. Deterministic, and it says why.
 *  - "/agent …" and "/chat …" force a mode
 *  - an instruction to change, make or run something in the project → agent
 *  - a question, or anything about attached files without such an
 *    instruction → chat
 */
export function chooseMode(text, { attachments = 0, lastMode = null } = {}) {
  const t = String(text ?? "").trim()
  if (/^\/agent\b/i.test(t)) return { mode: "agent", why: "you asked for the agent (/agent)" }
  if (/^\/chat\b/i.test(t)) return { mode: "chat", why: "you asked for a plain answer (/chat)" }
  if (/^(yes|ok|okay|go|go ahead|do it|continue|proceed|sure|please do)\b[.!]?$/i.test(t) && lastMode === "agent") return { mode: "agent", why: "continuing the agent's work" }
  // the agent (tools, shell, file writes) only for an instruction about the
  // project: "write a poem" or "make a list of gift ideas" is writing, not work
  // on files; "can you explain how to run the tests?" is a question
  const act = ACT.test(t), code = ON_CODE.test(t), asking = ASKING.test(t)
  const request = POLITE.test(t) && !EXPLAIN.test(t)
  if (act && code && (!asking || request)) return { mode: "agent", why: "an instruction to change or run something in the project" }
  return { mode: "chat", why: attachments ? "a question about the attached files" : asking ? "a question" : "conversation" }
}

// ---- uploads -------------------------------------------------------------------------

export function uploadsRoot(cwd) { return path.join(cwd, ".forge", "uploads") }

const safeName = (n) => {
  let b = path.basename(String(n ?? "file")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").replace(/^\.+/, "_")
  // file systems limit a name to 255 BYTES; keep the extension when cutting
  if (Buffer.byteLength(b) > 180) {
    const ext = /\.[\w]{1,10}$/.exec(b)?.[0] ?? ""
    let stem = [...b.slice(0, b.length - ext.length)]
    while (stem.length && Buffer.byteLength(stem.join("") + ext) > 180) stem.pop()
    b = stem.join("") + ext
  }
  return b || "file"
}

/** Save an uploaded file. Returns { id, name, bytes, path }. */
export function saveUpload(cwd, { name, data }) {
  if (!Buffer.isBuffer(data)) throw new Error("no file data")
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`the file is larger than ${MAX_UPLOAD_BYTES / 1048576} MB`)
  const id = loadBuiltin("crypto").randomBytes(9).toString("hex")
  const dir = path.join(uploadsRoot(cwd), id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, safeName(name))
  try { fs.writeFileSync(file, data, { mode: 0o600 }) } catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } throw e }
  return { id, name: path.basename(file), bytes: data.length, path: file }
}

/** An upload by id, or null. Ids are hex: no path can be smuggled in. */
export function findUpload(cwd, id) {
  if (!/^[0-9a-f]{18}$/.test(String(id ?? ""))) return null
  const dir = path.join(uploadsRoot(cwd), id)
  try {
    const name = fs.readdirSync(dir)[0]
    if (!name) return null
    const file = path.join(dir, name)
    return { id, name, bytes: fs.statSync(file).size, path: file }
  } catch { return null }
}

/** The text of a user message with its attachments, and any image parts. */
export async function composeUserMessage(text, files = [], { provider = null, agent = false, describe = describeFileIsolated, budget = MAX_MESSAGE_ATTACHMENT_CHARS } = {}) {
  const blocks = []
  const images = []
  const shown = []
  let room = budget
  for (const f of files) {
    const d = await describe(f.path, { name: f.name, provider, maxChars: Math.max(2000, Math.min(MAX_TEXT_CHARS, room)) })
    if (d.text) room = Math.max(0, room - d.text.length)
    shown.push({ id: f.id, name: f.name, bytes: f.bytes, kind: d.kind, mime: d.mime, note: d.note, truncated: d.truncated })
    const attrs = `name="${f.name.replace(/"/g, "'")}" type="${d.kind}" bytes="${f.bytes}" saved="${f.path}"`
    if (d.imagePart && !agent) { images.push(d.imagePart); blocks.push(`<attachment ${attrs}>(image attached${d.note ? `: ${d.note}` : ""})</attachment>`); continue }
    if (d.text) blocks.push(`<attachment ${attrs}${d.truncated ? ' truncated="yes"' : ""}>\n${d.text}\n</attachment>`)
    else blocks.push(`<attachment ${attrs}>(${d.note ?? "binary file"}${agent ? " — open it from the saved path with your tools" : ""})</attachment>`)
  }
  const body = [String(text ?? "").trim(), ...blocks].filter(Boolean).join("\n\n")
  const content = images.length ? [{ type: "text", text: body }, ...images] : body
  return { content, shown }
}

// ---- conversations ---------------------------------------------------------------------

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : ""

const deriveView = (msgs) => msgs
  .filter((m) => (m.role === "user" || m.role === "assistant") && textOf(m.content).trim())
  .map((m) => ({ role: m.role, text: textOf(m.content), at: null, from: "terminal" }))

/**
 * What the page shows for a session: meta.web when it has it, else derived.
 * Turns the terminal added after the page last saved (forge chat --continue)
 * are appended, so both see the whole conversation.
 */
export function displayMessages(session) {
  const msgs = session?.messages ?? []
  const web = session?.meta?.web?.messages
  if (!Array.isArray(web)) return deriveView(msgs)
  const seen = session.meta.web.modelCount
  if (Number.isInteger(seen) && msgs.length > seen) return [...web, ...deriveView(msgs.slice(seen))]
  return web
}

/** Cut each <attachment> body to n chars (older turns keep the gist, not the whole file). */
export function trimAttachments(text, n) {
  let out = "", i = 0
  for (;;) {
    const a = text.indexOf("<attachment ", i)
    if (a < 0) break
    const gt = text.indexOf(">", a)
    const end = gt < 0 ? -1 : text.indexOf("</attachment>", gt)
    if (end < 0) break
    out += text.slice(i, gt + 1)
    const body = text.slice(gt + 1, end)
    out += body.length > n ? `${body.slice(0, n)}\n… (trimmed — sent in full earlier; the file is at its saved path)\n` : body
    i = end
  }
  return out + text.slice(i)
}

/**
 * The conversation as a model accepts it: user and assistant text only,
 * alternating, starting with you. The terminal stores tool calls and their
 * results; a tool call without its result is rejected by providers, so a
 * tool-only step is dropped and its text kept. Older attachments are trimmed
 * and the whole history fits a budget.
 */
export function chatHistory(messages, { max = MAX_HISTORY, maxChars = MAX_HISTORY_CHARS } = {}) {
  const out = []
  for (const m of messages ?? []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue
    const text = textOf(m.content).trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content += "\n\n" + text
    else out.push({ role: m.role, content: text })
  }
  let h = out.slice(-max)
  while (h.length && h[0].role !== "user") h.shift()
  while (h.length && h[h.length - 1].role !== "assistant") h.pop() // a question that never got an answer
  let users = 0
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].role === "user" && ++users > KEEP_FULL_TURNS) h[i] = { ...h[i], content: trimAttachments(h[i].content, OLD_ATTACHMENT_CHARS) }
  }
  let total = h.reduce((n, m) => n + m.content.length, 0)
  while (h.length > 2 && total > maxChars) {
    total -= h.shift().content.length
    while (h.length && h[0].role !== "user") total -= h.shift().content.length
  }
  return h
}

/**
 * @param o.config       the live config (settings change it)
 * @param o.getProvider  () → the provider to answer with now
 * @param o.cwd          the project
 * @param o.stream       providers.streamChatResilient (injectable)
 * @param o.systemPrompt (config, opts) → string — chat.js chatSystemPrompt
 * @param o.runAgentTurn ({ task, deep, onEvent, signal }) → { res, mode }
 * @param o.gitStatus    async (cwd) → Map(path → status) | null
 */
export function createWebChat(o) {
  const { cwd } = o
  // conversations started in the page and not saved yet; everything else is
  // read from disk each time, so a turn taken in the terminal meanwhile
  // (forge chat --continue) is never overwritten by a stale copy
  const fresh = new Map()
  const okId = (id) => /^[\w.-]{1,80}$/.test(String(id ?? "")) && !/^last$/i.test(String(id))

  const read = (id) => {
    if (!okId(id)) return null
    const s = loadSession(projectSessionFile(id))
    if (s) { fresh.delete(id); return s }
    return fresh.get(id) ?? null
  }

  function list() {
    return sessionsForCwd(cwd, { max: 100, scan: 600 }).map((s) => ({
      id: s.id, title: s.title ?? "New chat", updatedAt: s.updatedAt ?? s.ts ?? 0,
      turns: displayMessages(s).filter((m) => m.role === "user").length,
      from: s.meta?.web ? "web" : "terminal",
    }))
  }

  function get(id) {
    const s = read(id)
    if (!s) return null
    return { id: s.id, title: s.title ?? "New chat", updatedAt: s.updatedAt ?? 0, model: s.model ?? null, messages: displayMessages(s) }
  }

  function persist(s) {
    const p = o.getProvider()
    if (s.meta?.web) s.meta.web.modelCount = s.messages.length
    saveSession({ provider: p?.name, model: p?.model, messages: s.messages, id: s.id, cwd, title: s.title ?? undefined, meta: s.meta })
    s.updatedAt = Date.now()
    fresh.delete(s.id)
  }

  function create() {
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + loadBuiltin("crypto").randomBytes(3).toString("hex")
    const s = { id, title: null, messages: [], meta: { web: { messages: [] } }, cwd }
    fresh.set(id, s)
    return { id, title: "New chat", messages: [] }
  }

  function remove(id) {
    if (!okId(id)) return false
    fresh.delete(id)
    try { fs.unlinkSync(projectSessionFile(id)); return true } catch { return false }
  }

  function rename(id, title) {
    const s = read(id)
    if (!s) return false
    s.title = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || s.title
    persist(s)
    return true
  }

  /**
   * Answer one message. onEvent receives, in order: { type: "mode" },
   * then "delta" / "thinking" (chat) or "activity" (agent), then "done".
   */
  async function send({ id, text, attachments = [], mode = "auto", deep = false }, { onEvent = () => {}, signal = null } = {}) {
    let s = read(id)
    if (!s) {
      // a conversation the page started (create) and has not saved yet, or a
      // new id it chose itself — ids are plain names, never paths
      if (!okId(id)) throw new Error("bad conversation id")
      s = { id, title: null, messages: [], meta: { web: { messages: [] } }, cwd }
      fresh.set(id, s)
    }
    s.meta ??= {}
    // the view absorbs any turns the terminal added since the page last saved
    s.meta.web = { ...(s.meta.web ?? {}), messages: displayMessages(s), modelCount: s.messages.length }
    const web = s.meta.web.messages
    const files = attachments.slice(0, MAX_ATTACHMENTS).map((a) => findUpload(cwd, a)).filter(Boolean)
    const lastMode = [...web].reverse().find((m) => m.role === "assistant")?.mode ?? null
    const decided = WEB_MODES.includes(mode) && mode !== "auto" ? { mode, why: "you chose it" } : chooseMode(text, { attachments: files.length, lastMode })
    const clean = String(text ?? "").replace(/^\/(agent|chat)\b\s*/i, "").trim()
    if (!clean && !files.length) throw new Error("the message is empty")
    onEvent({ type: "mode", mode: decided.mode, why: decided.why })

    const p = o.getProvider()
    const user = await composeUserMessage(clean, files, { provider: p, agent: decided.mode === "agent" })
    const userView = { role: "user", text: clean, attachments: user.shown, at: Date.now() }
    web.push(userView)
    if (!s.title) s.title = (clean || files[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60)
    const reply = { role: "assistant", text: "", mode: decided.mode, why: decided.why, model: `${p?.name}/${p?.model}`, at: Date.now(), activity: [], files: [] }

    try {
      if (decided.mode === "chat") {
        const history = chatHistory(s.messages)
        const system = await o.systemPrompt(o.config, { toolsEnabled: false, deep, query: clean.slice(0, 400) })
        const wire = [{ role: "system", content: system }, ...history, { role: "user", content: user.content }]
        let cut = false, dropped = false
        for await (const ev of o.stream(
          { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, providerName: p.name, messages: wire, maxTokens: deep ? 16384 : 8192, deep, signal, connectMs: o.config?.retry?.connectMs, firstByteMs: o.config?.retry?.firstByteMs },
          { attempts: o.config?.retry?.attempts ?? 3, backoffMs: o.config?.retry?.backoffMs ?? 1500, onRetry: (r) => onEvent({ type: "notice", text: `retrying (${r.attempt}/${r.attempts})…` }) },
        )) {
          if (ev.type === "text") { reply.text += ev.text; onEvent({ type: "delta", text: ev.text }) }
          else if (ev.type === "reasoning") onEvent({ type: "thinking", text: String(ev.text ?? "").slice(0, 4000) })
          else if (ev.type === "usage") reply.usage = ev.usage
          else if (ev.type === "incomplete") dropped = true
          else if (ev.type === "error") throw new Error(String(ev.error))
          else if (ev.type === "done" && /^(length|max_tokens)$/i.test(String(ev.finishReason ?? ""))) cut = true
        }
        if (cut) reply.note = "cut off at the output limit — say \"continue\" for the rest"
        if (dropped) reply.note = "the connection ended before the answer finished — it may be incomplete"
        // stored as text: images and long files are not re-sent forever (or kept
        // as base64 in the session file); the attachment block says what it was
        s.messages.push({ role: "user", content: textOf(user.content) }, { role: "assistant", content: reply.text })
      } else {
        const history = chatHistory(s.messages)
        let task = textOf(user.content)
        try {
          const { conversationBrief } = await import("./taskbrief.js")
          const brief = conversationBrief({ line: task, messages: history })
          if (brief?.composed) { task = brief.objective; onEvent({ type: "notice", text: `carried from this conversation: ${brief.summary}` }) }
        } catch { /* the line runs as written */ }
        const before = await o.gitStatus?.(cwd).catch(() => null)
        const out = await o.runAgentTurn({
          task, deep, signal,
          onEvent: (ev) => {
            const a = activityOf(ev)
            if (!a) return
            if (reply.activity.length < MAX_ACTIVITY) reply.activity.push(a)
            onEvent({ type: "activity", item: a })
          },
        })
        const res = out?.res ?? {}
        reply.text = String(res.text ?? "").trim() || "(the agent finished without a written answer)"
        reply.status = String(res.taskStatus ?? res.status ?? "COMPLETED")
        reply.engine = out?.mode ?? null
        const after = await o.gitStatus?.(cwd).catch(() => null)
        const diff = changedBetween(before, after)
        reply.files = diff?.length ? diff : (Array.isArray(res.created) ? res.created.map((f) => ({ path: String(f), status: "added" })) : (diff ?? []))
        onEvent({ type: "delta", text: reply.text })
        const filesLine = reply.files.length ? `\n\n(files changed: ${reply.files.map((f) => f.path).join(", ")})` : ""
        s.messages.push({ role: "user", content: textOf(user.content) }, { role: "assistant", content: reply.text + filesLine })
      }
    } catch (e) {
      const aborted = e?.name === "AbortError" || signal?.aborted
      reply.error = aborted ? "stopped" : String(e?.message ?? e).slice(0, 600)
      if (reply.text) s.messages.push({ role: "user", content: textOf(user.content) }, { role: "assistant", content: reply.text + "\n\n[stopped]" })
    }
    web.push(reply)
    persist(s)
    onEvent({ type: "done", message: reply, conversation: { id: s.id, title: s.title } })
    return reply
  }

  /** The conversation as a file: md, json or html. */
  function exportAs(id, format = "md") {
    const s = read(id)
    if (!s) return null
    const msgs = displayMessages(s)
    const title = s.title ?? "Conversation"
    const base = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "conversation"
    const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "")
    if (format === "json") return { filename: `${base}.json`, type: "application/json", body: JSON.stringify({ id: s.id, title, model: s.model ?? null, exportedAt: new Date().toISOString(), messages: msgs, modelMessages: s.messages }, null, 2) }
    if (format === "html") {
      const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]))
      const body = msgs.map((m) => `<section class="${m.role}"><h3>${m.role === "user" ? "You" : "Forge"} <small>${esc(when(m.at))}${m.mode ? ` · ${esc(m.mode)}` : ""}</small></h3>${(m.attachments ?? []).map((a) => `<div class="att">📎 ${esc(a.name)} (${esc(a.kind)})</div>`).join("")}<div class="text">${esc(m.text)}</div>${(m.files ?? []).length ? `<div class="files">files changed: ${m.files.map((f) => esc(f.path)).join(", ")}</div>` : ""}</section>`).join("\n")
      return { filename: `${base}.html`, type: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 16px;color:#1b1b1b}h1{font-size:22px}section{border-top:1px solid #ddd;padding:12px 0}h3{margin:0 0 6px;font-size:14px}small{color:#777;font-weight:400}.text{white-space:pre-wrap}.att,.files{color:#555;font-size:13px}.user h3{color:#2f5fb3}@media print{body{margin:0}}</style><h1>${esc(title)}</h1>\n${body}` }
    }
    const md = [`# ${title}`, "", ...msgs.flatMap((m) => [
      `### ${m.role === "user" ? "You" : "Forge"}${m.at ? ` · ${when(m.at)}` : ""}${m.mode ? ` · ${m.mode}` : ""}`, "",
      ...(m.attachments ?? []).map((a) => `> 📎 ${a.name} (${a.kind})`), (m.attachments ?? []).length ? "" : null,
      m.text ?? "", "",
      ...((m.files ?? []).length ? [`_files changed: ${m.files.map((f) => f.path).join(", ")}_`, ""] : []),
    ].filter((x) => x !== null))].join("\n")
    return { filename: `${base}.md`, type: "text/markdown; charset=utf-8", body: md }
  }

  return { list, get, create, remove, rename, send, exportAs }
}

/** The part of a tool call a person wants to see: the command, the path, the query. */
export function toolSummary(args) {
  let a = args
  if (typeof a === "string") { try { a = JSON.parse(a) } catch { return a } }
  if (!a || typeof a !== "object") return ""
  const pick = a.command ?? a.cmd ?? a.path ?? a.file ?? a.pattern ?? a.query ?? a.url ?? a.task ?? a.name ?? null
  const extra = a.path && (a.old_string != null || a.content != null) ? (a.content != null ? ` (${String(a.content).length} chars)` : " (edit)") : ""
  return pick != null ? String(pick) + extra : JSON.stringify(a)
}

/** A display line for one agent event, or null for events the page skips. */
export function activityOf(ev) {
  const t = ev?.type
  const short = (x, n = 240) => (typeof x === "string" ? x.replace(/\s+/g, " ").slice(0, n) : undefined)
  const who = ev?.sub ? `${ev.role ?? "helper"} · ` : ""
  if (t === "tool_start") return { kind: "tool", name: ev.name, detail: who + (short(toolSummary(ev.args), 200) ?? ""), at: Date.now() }
  if (t === "tool_result") {
    const r = String(ev.result ?? ev.preview ?? "")
    return { kind: "result", name: ev.name ?? null, ok: !/^(ERROR|BLOCKED)/.test(r), detail: short(r.split("\n").slice(0, 3).join(" ⏎ "), 240), ms: ev.ms ?? null, at: Date.now() }
  }
  // forge's own bookkeeping ("lsp tool available", "ROUTE SMALL…") is not the
  // work: the page shows what the agent did and anything it needs you to know
  if (t === "NOTICE") return { kind: "info", detail: short(ev.message ?? ev.text), at: Date.now() }
  if (t === "MODEL_SELECTED") return { kind: "info", detail: `model ${ev.provider}/${ev.model}${ev.reason ? ` — ${short(ev.reason, 120)}` : ""}`, at: Date.now() }
  if (t === "DAG_BUILT") return { kind: "plan", detail: `plan: ${ev.nodes ?? ev.nodeCount ?? "?"} step(s)`, at: Date.now() }
  if (t === "WORKER_STARTED" || t === "SEGMENT_STARTED") return { kind: "step", detail: short(ev.objective ?? ev.role ?? t, 160), at: Date.now() }
  if (t === "retry" || t === "failover") return { kind: "info", detail: short(ev.text ?? ev.message ?? t), at: Date.now() }
  return null
}

/** Files whose git status changed between two snapshots. */
export function changedBetween(before, after) {
  if (!after) return null
  const out = []
  for (const [p, sig] of after) {
    const st = String(sig).slice(0, 2)
    if (!before || before.get(p) !== sig) out.push({ path: p, status: st.includes("?") || st.includes("A") ? "added" : st.includes("D") ? "deleted" : "modified" })
  }
  if (before) for (const [p] of before) if (!after.has(p)) out.push({ path: p, status: "reverted" })
  return out
}

/**
 * path → its two-letter git status plus size and mtime, for the project
 * (null when not a git repo). The size/mtime part makes a second edit to an
 * already-modified file (" M" before and after) count as a change.
 */
export function gitStatusMap(cwd) {
  return new Promise((resolve) => {
    loadBuiltin("child_process").execFile("git", ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".", ":(exclude).forge", ":(exclude).forge/**"], { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null)
      const m = new Map()
      const parts = String(out).split("\0")
      for (let i = 0; i < parts.length && m.size < 5000; i++) {
        const l = parts[i]
        if (l.length < 4) continue
        const st = l.slice(0, 2), p = l.slice(3)
        if (st[0] === "R" || st[0] === "C") i++ // -z: the old path follows a rename
        let sig = ""
        try { const f = fs.statSync(path.join(cwd, p)); sig = `\u0000${f.size}:${f.mtimeMs}` } catch { }
        m.set(p, st + sig)
      }
      resolve(m)
    })
  })
}
