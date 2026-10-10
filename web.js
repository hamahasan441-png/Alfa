/**
 * forge — `forge web`: a local workspace page (Phase 6, zero dependencies)
 *
 * Arena's Agent Mode shows the work while it happens: the plan with each
 * step's status and model on one side, the changed lines on the other. This
 * is that view for forge, served from your own machine:
 *
 *   forge web            → http://127.0.0.1:<port>/?t=<token>
 *
 *   left    the task box (run now, or add to the queue) and the queue
 *   middle  the plan — each node's status, role, model and time — then the
 *           live activity (tool calls) and the final answer
 *   right   the changes: files changed in the checkout and their diff
 *
 * Security — this page can start an agent on your machine, so:
 *  - it listens on 127.0.0.1 only (never 0.0.0.0)
 *  - every request needs the per-launch random token (query `t` or header
 *    `x-forge-token`); without it: 401. A web page elsewhere cannot guess it.
 *  - the Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS
 *    rebinding); a POST must carry the header token and, if the browser sends
 *    an Origin, it must be this server's (blocks cross-site requests)
 *  - one run at a time; a second POST /run is 409
 *
 * The run itself is the same `runTask` every other entry point uses
 * (runtask.js): mode chosen by runmode.js, model chain, combine step, etc.
 */
import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { saveUpload, findUpload, MAX_UPLOAD_BYTES } from "./webchat.js"
import { mimeFor } from "./docextract.js"

const MAX_BODY = 64 * 1024
const MAX_CHAT_BODY = 512 * 1024
const MAX_DOWNLOAD = 200 * 1024 * 1024
// the pages run only their own inline code and talk only to this server
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"
const MAX_EVENTS = 400
const MAX_DIFF = 400 * 1024

/** Build the plan view from controller events. Pure; exported for tests. */
export function applyEvent(state, ev) {
  const now = Date.now()
  const node = (id) => state.plan.find((n) => n.id === String(id))
  switch (ev?.type) {
    case "TASK_CLASSIFIED": state.klass = ev.class ?? ev.klass ?? state.klass; break
    case "MODEL_SELECTED": state.model = ev.provider && ev.model ? `${ev.provider}/${ev.model}` : state.model; break
    case "DAG_BUILT": {
      const nodes = ev.graph?.nodes ?? []
      state.plan = nodes.map((n) => ({ id: String(n.id), title: String(n.title || n.objective || n.id).slice(0, 160), role: n.role ?? null, status: "pending", model: null, startedAt: null, endedAt: null }))
      break
    }
    case "DAG_NODE_STARTED": { const n = node(ev.nodeId); if (n) { n.status = "running"; n.startedAt ??= now } break }
    case "DAG_NODE_COMPLETED": { const n = node(ev.nodeId); if (n) { n.status = "completed"; n.endedAt = now } break }
    case "WORKER_STARTED": { const n = node(ev.nodeId); if (n && n.status === "pending") { n.status = "running"; n.startedAt ??= now } break }
    case "WORKER_COMPLETED": { const n = node(ev.nodeId); if (n && ev.ok === false && n.status !== "completed") { n.status = "failed"; n.endedAt = now } break }
    case "CREW_MODEL_ROUTED": { const n = node(ev.nodeId); if (n) n.model = `${ev.provider}/${ev.model}`; break }
    case "ACCEPTANCE_CHECKED": state.acceptance = Array.isArray(ev.items) ? ev.items : null; break
    // controller segments and workers report their tools with a `sub` label;
    // they are the activity of an orchestrated run, so they are kept, tagged
    case "tool_start": state.activity.push({ step: ev.step ?? null, name: ev.name, who: ev.sub ? String(ev.sub).slice(0, 40) : null, args: String(ev.args ?? "").slice(0, 200), startedAt: now, ok: null, ms: null }); break
    case "tool_result": {
      const who = ev.sub ? String(ev.sub).slice(0, 40) : null
      const a = [...state.activity].reverse().find((x) => x.ok === null && x.who === who)
      if (a) { const r = String(ev.result ?? ""); a.ok = !/^(ERROR|BLOCKED)/.test(r); a.ms = ev.ms ?? now - a.startedAt; a.result = r.split("\n")[0].slice(0, 200) }
      break
    }
  }
  if (state.activity.length > 200) state.activity.splice(0, state.activity.length - 200)
  return state
}

export function freshRunState(task = "", mode = null, why = null) {
  return { task, mode, why, klass: null, model: null, plan: [], activity: [], acceptance: null, status: "running", answer: null, startedAt: Date.now(), endedAt: null, error: null }
}

/**
 * `git status --porcelain -z` → [{ status, path }]. -z keeps names exact (no
 * quoting or octal escapes for non-ASCII) and gives a rename as its new path.
 */
export function parsePorcelainZ(out, { max = 5000 } = {}) {
  const parts = String(out ?? "").split("\0")
  const files = []
  for (let i = 0; i < parts.length && files.length < max; i++) {
    const l = parts[i]
    if (l.length < 4) continue
    const status = l.slice(0, 2)
    files.push({ status: status.trim() || "?", path: l.slice(3) })
    if (status[0] === "R" || status[0] === "C") i++ // the next field is the old path
  }
  return files
}

function gitDiffOf(cwd, base = null) {
  // `git diff --no-index` exits 1 when the files differ — that is its answer, not a failure
  const run = (args, okCodes = [0]) => new Promise((resolve) => execFile("git", args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err && !okCodes.includes(err.code) ? null : String(out ?? ""))))
  return (async () => {
    const st = await run(["status", "--porcelain", "-z", "--untracked-files=all", "--", ".", ":(exclude).forge", ":(exclude).forge/**"])
    if (st === null) return { git: false, files: [], diff: "" }
    const files = parsePorcelainZ(st)
    // for a repo run: everything on the work branch since origin/<base>, committed or not
    const since = base ? ((await run(["merge-base", "HEAD", `origin/${base}`])) ?? "").trim() : ""
    let diff = (await run(["diff", "--no-color", ...(since ? [since] : []), "--", ".", ":(exclude).forge", ":(exclude).forge/**"])) ?? ""
    if (since) {
      const names = (await run(["diff", "--name-status", since, "--", ".", ":(exclude).forge", ":(exclude).forge/**"])) ?? ""
      for (const l of names.split("\n").filter(Boolean)) { const [st, ...rest] = l.split("\t"); const pth = rest.join("\t"); if (pth && !files.some((f) => f.path === pth)) files.push({ status: st, path: pth }) }
    }
    // untracked files show as additions, so a new file is visible too
    for (const f of files.filter((x) => x.status === "??").slice(0, 20)) {
      const d = await run(["diff", "--no-color", "--no-index", "--", "/dev/null", f.path], [0, 1])
      if (d) diff += d
    }
    const truncated = diff.length > MAX_DIFF
    return { git: true, files, diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated }
  })()
}

/** Changed + new files (git), and the full binary-safe patch of them. */
export function changedFiles(cwd) {
  const run = (args, okCodes = [0]) => new Promise((resolve) => execFile("git", args, { cwd, timeout: 30000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" }, (err, out) => resolve(err && !okCodes.includes(err.code) ? null : Buffer.from(out ?? ""))))
  const EX = ["--", ".", ":(exclude).forge", ":(exclude).forge/**"]
  return (async () => {
    const st = await run(["status", "--porcelain", "-z", "--untracked-files=all", ...EX])
    if (st === null) return { git: false, files: [], patch: Buffer.alloc(0) }
    const files = parsePorcelainZ(st.toString("utf8"))
    const parts = []
    const tracked = await run(["diff", "--binary", "--no-color", "HEAD", ...EX])
    if (tracked) parts.push(tracked)
    // one git process per new file: a bounded number of them
    for (const f of files.filter((x) => x.status === "??").slice(0, 500)) {
      const d = await run(["diff", "--binary", "--no-color", "--no-index", "--", "/dev/null", f.path], [0, 1])
      if (d) parts.push(d)
    }
    return { git: true, files, patch: Buffer.concat(parts) }
  })()
}

/**
 * @param {object} o
 * @param {string}   [o.cwd]
 * @param {object}   [o.info]      { provider, model, version } shown in the header
 * @param {Function} o.run         async ({ task, mode, onEvent, signal }) → { mode, why, res }
 * @param {object}   [o.queue]     { list(), add(task, {mode}), runAll({ parallel, onItem }) }
 * @param {Function} [o.diff]      async () → { git, files, diff } (default: git in cwd)
 * @param {string}   [o.token]     fixed token (tests); default random
 * @param {object}   [o.chat]      webchat.js createWebChat(): the chat app at /
 *                                 (without it, / is the workspace page)
 * @param {object}   [o.settings]  websettings.js createWebSettings()
 * @param {Function} [o.appHtml]   ({ token }) → the chat app page
 */
export function createWebServer({ cwd = process.cwd(), info = {}, run, runRepo = null, queue = null, diff = null, token = null, chat = null, settings = null, appHtml = null } = {}) {
  const TOKEN = token ?? crypto.randomBytes(18).toString("base64url")
  const clients = new Set()
  const events = []
  let current = null // run state
  let abort = null
  let queueRunning = false
  let port = 0
  let chatTurn = null // { abort, id } while a message is being answered

  const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...(/^text\/html/.test(type) ? { "content-security-policy": PAGE_CSP } : {}), ...extra })
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }
  /** A file for the browser to save (or, inline, to show). */
  const sendFile = (res, name, body, type, { inline = false } = {}) => {
    const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
    res.writeHead(200, {
      "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // a downloaded HTML/SVG file must never run as this page
      "content-security-policy": /html|svg|xml/.test(type) ? DOC_CSP : "default-src 'none'; sandbox",
    })
    res.end(body)
  }
  /** A file on disk, streamed (a big download does not block the server). */
  const sendPath = (res, name, abs, type, { inline = false } = {}) => {
    const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
    let size = 0
    try { size = fs.statSync(abs).size } catch { return send(res, 404, { error: "the file is gone" }) }
    res.writeHead(200, {
      "content-type": type, "content-length": size, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-security-policy": /html|svg|xml/.test(type) ? DOC_CSP : "default-src 'none'; sandbox",
    })
    const rs = fs.createReadStream(abs)
    rs.on("error", () => res.destroy())
    res.on("close", () => rs.destroy())
    rs.pipe(res)
  }
  const broadcast = (ev) => {
    const rec = { ...ev, at: Date.now() }
    events.push(rec); if (events.length > MAX_EVENTS) events.shift()
    const line = `data: ${JSON.stringify(rec).replace(/\n/g, "\\n")}\n\n`
    for (const c of clients) { try { c.write(line) } catch { clients.delete(c) } }
  }
  const snapshot = () => ({ cwd, info, run: current, queueRunning, queue: queue ? queue.list() : null })

  const startRun = (task, mode, repo = null) => {
    current = freshRunState(task, mode)
    if (repo) current.repo = { slug: repo.repo, base: repo.base ?? null, pr: repo.pr === true, dir: null, branch: null, delivery: null }
    abort = new AbortController()
    broadcast({ type: "web_run_start", task, mode })
    const onEvent = (ev) => {
      try { applyEvent(current, ev) } catch { }
      // forward a bounded, display-only subset (no full tool payloads)
      const slim = { type: ev?.type, nodeId: ev?.nodeId, name: ev?.name, step: ev?.step, ok: ev?.ok, model: ev?.model, provider: ev?.provider, text: typeof ev?.text === "string" ? ev.text.slice(0, 300) : undefined, message: typeof ev?.message === "string" ? ev.message.slice(0, 300) : undefined }
      if (slim.type === "FILE_CHANGED" || slim.type === "tool_result" || slim.type === "DAG_BUILT" || /^DAG_|^WORKER_|^TASK_|^MODEL_|^CREW_|^ACCEPTANCE|^NOTICE$|^tool_start$|^info$/.test(String(slim.type))) broadcast(slim)
    }
    Promise.resolve()
      .then(() => repo
        ? runRepo({ task, repo: repo.repo, base: repo.base ?? null, pr: repo.pr === true, onEvent, signal: abort.signal, onPrepared: (p) => { if (current.repo) Object.assign(current.repo, { dir: p.dir, branch: p.branch, base: p.base }) } })
        : run({ task, mode, onEvent, signal: abort.signal }))
      .then((out) => {
        if (repo && out && out.ok === false) throw new Error(out.reason || "repo run failed")
        if (repo && current.repo && out) Object.assign(current.repo, { dir: out.dir ?? current.repo.dir, branch: out.branch ?? current.repo.branch, base: out.base ?? current.repo.base, delivery: out.delivery ?? null })
        current.mode = out?.mode ?? current.mode; current.why = out?.why ?? current.why
        current.status = String(out?.res?.taskStatus ?? out?.res?.status ?? "COMPLETED")
        current.answer = String(out?.res?.text ?? "").slice(0, 20000)
      })
      .catch((e) => { current.status = e?.name === "AbortError" ? "ABORTED" : "ERROR"; current.error = String(e?.message ?? e).slice(0, 500) })
      .finally(() => {
        current.endedAt = Date.now(); abort = null
        // a node still "running" when the run ended did not finish: freeze it
        for (const nd of current.plan) if (nd.status === "running" || nd.status === "pending") { nd.status = nd.status === "running" ? "stopped" : "pending"; nd.endedAt ??= nd.startedAt ? current.endedAt : null }
        broadcast({ type: "web_run_end", status: current.status })
      })
  }

  const hostOk = (req) => {
    const h = String(req.headers.host ?? "")
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`
  }
  const tokenOf = (req, url) => String(req.headers["x-forge-token"] ?? url.searchParams.get("t") ?? "")
  const sameToken = (a) => { const x = Buffer.from(String(a)), y = Buffer.from(TOKEN); return x.length === y.length && crypto.timingSafeEqual(x, y) }
  const readBody = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
    let n = 0; const chunks = []
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy() } else chunks.push(c) })
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) } catch { reject(new Error("body is not JSON")) } })
    req.on("error", reject)
  })
  const readRaw = (req, limit) => new Promise((resolve, reject) => {
    let n = 0; const chunks = []
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error(`the file is larger than ${Math.round(limit / 1048576)} MB`), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
  /** A path inside the project, resolved through symlinks — or null. */
  const projectFile = (rel) => {
    try {
      const root = fs.realpathSync(cwd)
      const abs = fs.realpathSync(path.resolve(root, String(rel ?? "")))
      if (abs !== root && !abs.startsWith(root + path.sep)) return null
      const st = fs.statSync(abs)
      return st.isFile() && st.size <= MAX_DOWNLOAD ? abs : null
    } catch { return null }
  }

  const server = http.createServer(async (req, res) => {
    let url
    try { url = new URL(req.url, `http://127.0.0.1:${port}`) } catch { return send(res, 400, { error: "bad url" }) }
    if (!hostOk(req)) return send(res, 403, { error: "host not allowed" })
    // the browser asks for this on its own, without the token: nothing to give it
    if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204, { "cache-control": "max-age=86400" }); return res.end() }
    if (!sameToken(tokenOf(req, url))) return send(res, 401, { error: "missing or wrong token" })
    if (req.method !== "GET") {
      // POSTs carry the token in a header (never only the query), and a
      // browser's Origin, when sent, must be this page
      if (!sameToken(String(req.headers["x-forge-token"] ?? ""))) return send(res, 401, { error: "POST needs the x-forge-token header" })
      const origin = req.headers.origin
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "cross-origin request refused" })
    }
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, chat && appHtml ? appHtml({ token: TOKEN }) : pageHtml({ token: TOKEN }), "text/html; charset=utf-8")
      if (req.method === "GET" && url.pathname === "/workspace") return send(res, 200, pageHtml({ token: TOKEN }), "text/html; charset=utf-8")
      if (url.pathname.startsWith("/api/")) {
        const out = await api(req, res, url)
        if (out !== undefined) return
      }
      if (req.method === "GET" && url.pathname === "/state") return send(res, 200, snapshot())
      if (req.method === "GET" && url.pathname === "/diff") {
        // a repo run works in its own clone: show that clone's work branch
        if (current?.repo?.dir) return send(res, 200, { ...(await gitDiffOf(current.repo.dir, current.repo.base)), where: current.repo.dir })
        return send(res, 200, await (diff ?? (() => gitDiffOf(cwd)))())
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
        res.write(`data: ${JSON.stringify({ type: "web_hello", state: snapshot() })}\n\n`)
        clients.add(res)
        req.on("close", () => clients.delete(res))
        return
      }
      if (req.method === "POST" && url.pathname === "/run") {
        const body = await readBody(req)
        const task = String(body.task ?? "").trim()
        if (!task) return send(res, 400, { error: "task is empty" })
        if (current && !current.endedAt) return send(res, 409, { error: "a task is already running" })
        if (queueRunning) return send(res, 409, { error: "the queue is running" })
        if (chatTurn) return send(res, 409, { error: "the chat is answering a message" })
        const mode = body.mode === "single" || body.mode === "meta" ? body.mode : null
        let repo = null
        if (body.repo) {
          if (!runRepo) return send(res, 404, { error: "repo runs are unavailable here" })
          const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(body.repo).trim())
          if (!m || m[1].startsWith(".") || m[2].startsWith(".")) return send(res, 400, { error: "repo must be owner/name" })
          if (body.base != null && body.base !== "" && !/^[\w./-]{1,200}$/.test(String(body.base))) return send(res, 400, { error: "bad base branch" })
          repo = { repo: `${m[1]}/${m[2]}`, base: body.base ? String(body.base) : null, pr: body.pr === true }
        }
        startRun(task.slice(0, 8000), repo ? "meta" : mode, repo)
        return send(res, 202, { ok: true })
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        if (abort) { abort.abort(); return send(res, 200, { ok: true }) }
        return send(res, 409, { error: "nothing is running" })
      }
      if (req.method === "POST" && url.pathname === "/queue") {
        if (!queue) return send(res, 404, { error: "queue unavailable" })
        const body = await readBody(req)
        const mode = body.mode === "single" ? "single" : body.mode === "meta" ? "meta" : "auto"
        const item = queue.add(String(body.task ?? ""), { mode, repo: body.repo ? String(body.repo) : null, base: body.base ? String(body.base) : null, pr: body.pr === true })
        broadcast({ type: "web_queue" })
        return send(res, 201, { item })
      }
      if (req.method === "POST" && url.pathname === "/queue/run") {
        if (!queue) return send(res, 404, { error: "queue unavailable" })
        if (queueRunning || (current && !current.endedAt)) return send(res, 409, { error: "something is already running" })
        if (chatTurn) return send(res, 409, { error: "the chat is answering a message" })
        const body = await readBody(req)
        const parallel = Math.max(1, Math.min(8, Number(body.parallel) || 1))
        queueRunning = true
        broadcast({ type: "web_queue", running: true })
        Promise.resolve(queue.runAll({ parallel, onItem: (e) => broadcast({ type: "web_queue", phase: e.phase, id: e.item?.id, status: e.item?.status }) }))
          .catch((e) => broadcast({ type: "NOTICE", message: `queue: ${String(e?.message ?? e).slice(0, 200)}` }))
          .finally(() => { queueRunning = false; broadcast({ type: "web_queue", running: false }) })
        return send(res, 202, { ok: true, parallel })
      }
      return send(res, 404, { error: "not found" })
    } catch (e) {
      return send(res, 400, { error: String(e?.message ?? e).slice(0, 200) })
    }
  })

  // ---- the chat app's API (/api/…) -------------------------------------------
  // Returns undefined when the path is not one of these (→ 404 below).
  async function api(req, res, url) {
    const m = req.method, p = url.pathname
    const need = (x, what) => { if (!x) { send(res, 404, { error: `${what} is not available here` }); return false } return true }
    // "last" is the store's pointer file, never a conversation
    const conv = /^\/api\/conversations\/(?!last(?:\/|$))([\w.-]{1,80})(\/rename)?$/.exec(p)

    if (p === "/api/conversations" && m === "GET") { if (!need(chat, "chat")) return true; return send(res, 200, { conversations: chat.list() }), true }
    if (p === "/api/conversations" && m === "POST") { if (!need(chat, "chat")) return true; return send(res, 201, chat.create()), true }
    if (conv && !conv[2] && m === "GET") { if (!need(chat, "chat")) return true; const c = chat.get(conv[1]); return send(res, c ? 200 : 404, c ?? { error: "no such conversation" }), true }
    if (conv && !conv[2] && m === "DELETE") { if (!need(chat, "chat")) return true; if (chatTurn?.id === conv[1]) return send(res, 409, { error: "it is answering a message" }), true; return send(res, chat.remove(conv[1]) ? 200 : 404, { ok: true }), true }
    if (conv && conv[2] && m === "POST") { if (!need(chat, "chat")) return true; const b = await readBody(req); return send(res, chat.rename(conv[1], b.title) ? 200 : 404, { ok: true }), true }

    if (p === "/api/chat" && m === "POST") {
      if (!need(chat, "chat")) return true
      const body = await readBody(req, MAX_CHAT_BODY)
      if (chatTurn) return send(res, 409, { error: "a message is already being answered — stop it or wait" }), true
      if (current && !current.endedAt) return send(res, 409, { error: "a workspace task is running" }), true
      // queue items with parallel 1 work in this checkout: never both at once
      if (queueRunning) return send(res, 409, { error: "the workspace queue is running" }), true
      const ac = new AbortController()
      chatTurn = { abort: ac, id: String(body.id ?? "") }
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
      // the page went away mid-answer: stop the work it was waiting for
      res.on("close", () => { if (!res.writableEnded) ac.abort() })
      const write = (ev) => { try { res.write(JSON.stringify(ev) + "\n") } catch { } }
      try {
        await chat.send({ id: String(body.id ?? ""), text: String(body.text ?? "").slice(0, 200_000), attachments: Array.isArray(body.attachments) ? body.attachments.map(String) : [], mode: String(body.mode ?? "auto"), deep: body.deep === true }, { onEvent: write, signal: ac.signal })
      } catch (e) { write({ type: "error", error: String(e?.message ?? e).slice(0, 400) }) }
      finally { chatTurn = null; try { res.end() } catch { } }
      return true
    }
    if (p === "/api/chat/stop" && m === "POST") { if (!chatTurn) return send(res, 409, { error: "nothing is being answered" }), true; chatTurn.abort.abort(); return send(res, 200, { ok: true }), true }

    if (p === "/api/upload" && m === "POST") {
      let name = "file"
      try { name = decodeURIComponent(String(req.headers["x-filename"] ?? "file")) } catch { }
      try {
        const data = await readRaw(req, MAX_UPLOAD_BYTES)
        if (!data.length) return send(res, 400, { error: "the file is empty" }), true
        const up = saveUpload(cwd, { name, data })
        return send(res, 201, { id: up.id, name: up.name, bytes: up.bytes, mime: mimeFor(up.name) }), true
      } catch (e) { return send(res, e?.status ?? 400, { error: String(e?.message ?? e).slice(0, 200) }), true }
    }
    const upl = /^\/api\/upload\/([0-9a-f]{18})$/.exec(p)
    if (upl && m === "GET") {
      const f = findUpload(cwd, upl[1])
      if (!f) return send(res, 404, { error: "no such upload" }), true
      return sendPath(res, f.name, f.path, mimeFor(f.name), { inline: url.searchParams.get("inline") === "1" && /^image\/(png|jpeg|gif|webp)$/.test(mimeFor(f.name)) }), true
    }

    if (p === "/api/export" && m === "GET") {
      if (!need(chat, "chat")) return true
      const fmt = ["md", "json", "html"].includes(url.searchParams.get("format")) ? url.searchParams.get("format") : "md"
      const ex = chat.exportAs(String(url.searchParams.get("id") ?? ""), fmt)
      if (!ex) return send(res, 404, { error: "no such conversation" }), true
      return sendFile(res, ex.filename, ex.body, ex.type, { inline: url.searchParams.get("inline") === "1" && fmt === "html" }), true
    }

    if (p === "/api/file" && m === "GET") {
      const abs = projectFile(url.searchParams.get("path"))
      if (!abs) return send(res, 404, { error: "no such file in this project" }), true
      return sendPath(res, path.basename(abs), abs, mimeFor(abs)), true
    }
    if (p === "/api/changes" && m === "GET") return send(res, 200, await (diff ?? (() => gitDiffOf(cwd)))()), true
    if ((p === "/api/changes.patch" || p === "/api/changes.zip") && m === "GET") {
      const ch = await changedFiles(cwd)
      if (!ch.git) return send(res, 404, { error: "not a git repository — there are no changes to export" }), true
      if (!ch.files.length) return send(res, 404, { error: "no changes" }), true
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
      if (p.endsWith(".patch")) return sendFile(res, `forge-changes-${stamp}.patch`, ch.patch, "text/x-diff; charset=utf-8"), true
      const { makeStoreZip } = await import("./zipingest.js")
      const files = {}
      let total = 0
      for (const f of ch.files) {
        if (f.status === "D") continue
        const abs = projectFile(f.path)
        if (!abs) continue
        total += fs.statSync(abs).size
        if (total > MAX_DOWNLOAD) break
        files[f.path] = fs.readFileSync(abs)
      }
      return sendFile(res, `forge-changes-${stamp}.zip`, makeStoreZip(files), "application/zip"), true
    }

    if (p === "/api/settings" && m === "GET") { if (!need(settings, "settings")) return true; return send(res, 200, settings.get()), true }
    if (p === "/api/settings" && m === "POST") {
      if (!need(settings, "settings")) return true
      if (chatTurn) return send(res, 409, { error: "wait until the current message is answered" }), true
      const r = settings.set(await readBody(req))
      if (r.ok) broadcast({ type: "web_settings", active: r.settings.active })
      return send(res, r.ok ? 200 : 400, r.ok ? r.settings : { error: r.error }), true
    }
    if (p === "/api/models" && m === "GET") { if (!need(settings, "settings")) return true; return send(res, 200, await settings.models(String(url.searchParams.get("provider") ?? ""))), true }
    return undefined
  }

  return {
    token: TOKEN,
    get port() { return port },
    get url() { return `http://127.0.0.1:${port}/?t=${TOKEN}` },
    listen(p = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(p, "127.0.0.1", () => { port = server.address().port; resolve(this) })
      })
    },
    close() { for (const c of clients) { try { c.end() } catch { } } clients.clear(); return new Promise((r) => server.close(() => r())) },
    broadcast,
    state: snapshot,
  }
}

/** The page: one self-contained HTML document, no external requests. */
export function pageHtml({ token }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>forge workspace</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--accent:#2f5bd3;--ok:#1f7a3f;--fail:#b3261e;--warn:#9a6a00;--add:#e6f4ea;--del:#fdecea;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--panel:#1b1b19;--ink:#ecebe6;--muted:#9a9993;--line:#2c2b28;--accent:#7d9cff;--ok:#5cc184;--fail:#ff8a80;--warn:#e6b450;--add:#16301f;--del:#3a1a18}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
header b{font-weight:650}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.pill.run{color:var(--accent);border-color:var(--accent)}.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--fail);border-color:var(--fail)}
main{display:grid;grid-template-columns:300px minmax(0,1fr) minmax(0,1.1fr);gap:12px;padding:12px;height:calc(100vh - 52px)}
@media (max-width:1000px){main{grid-template-columns:1fr;height:auto}}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;min-height:0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
textarea{width:100%;min-height:110px;resize:vertical;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap;align-items:center}
button,select{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
ul{list-style:none;margin:0;padding:0}li{padding:6px 0;border-bottom:1px dashed var(--line)}li:last-child{border:0}
.node{display:grid;grid-template-columns:18px 1fr auto;gap:6px;align-items:start}.mark{font-weight:700}
.completed .mark{color:var(--ok)}.failed .mark{color:var(--fail)}.running .mark{color:var(--accent)}.pending .mark{color:var(--muted)}
.meta{color:var(--muted);font-size:12px}.mono{font-family:var(--mono);font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
.diff{font-family:var(--mono);font-size:12px;line-height:1.4}.diff div{white-space:pre-wrap;word-break:break-all}.stopped .mark{color:var(--warn)}.diff .a{background:var(--add)}.diff .d{background:var(--del)}.diff .h{color:var(--accent)}
.answer{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}
.files li{display:flex;gap:8px}.empty{color:var(--muted)}
</style></head><body>
<header><b>forge</b><span id="where" class="meta"></span><span id="status" class="pill">idle</span><span id="mode" class="pill" hidden></span><span id="model" class="meta"></span></header>
<main>
<section aria-label="Task and queue">
<h2>Task</h2>
<textarea id="task" placeholder="Describe the change you want…"></textarea>
<div class="row"><input id="repo" placeholder="GitHub repo (optional) owner/name" aria-label="GitHub repo" style="flex:1;min-width:0;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"><input id="base" placeholder="base" aria-label="base branch" style="width:80px;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)"></div>
<div class="row"><label class="meta"><input type="checkbox" id="pr"> push and open a PR (your gh)</label></div>
<div class="row"><select id="mode-sel" aria-label="mode"><option value="">auto</option><option value="single">single loop</option><option value="meta">orchestrator</option></select>
<button class="primary" id="run">Run</button><button id="stop" disabled>Stop</button><button id="enqueue">Add to queue</button></div>
<h2 style="margin-top:16px">Queue</h2>
<div class="row"><label class="meta">parallel <select id="par"><option>1</option><option>2</option><option>3</option><option>4</option></select></label><button id="qrun">Run queue</button></div>
<ul id="queue"><li class="empty">empty</li></ul>
</section>
<section aria-label="Plan and activity">
<h2>Plan</h2><ul id="plan"><li class="empty">No plan yet — small tasks run as a single loop.</li></ul>
<h2 style="margin-top:14px">Activity</h2><ul id="act" class="mono"><li class="empty">—</li></ul>
<div id="answer" class="answer" hidden><h2>Answer</h2><pre id="answer-text"></pre></div>
</section>
<section aria-label="Changes">
<h2>Changes</h2><ul id="files" class="files mono"><li class="empty">no changes</li></ul>
<div id="diff" class="diff" style="margin-top:10px"></div>
</section>
</main>
<script>
const T=${JSON.stringify(token)};const $=(id)=>document.getElementById(id);
const api=(p,o={})=>fetch(p+(p.includes("?")?"&":"?")+"t="+encodeURIComponent(T),{...o,headers:{"content-type":"application/json","x-forge-token":T,...(o.headers||{})}}).then(r=>r.json().catch(()=>({})))
const esc=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))
const ms=(a,b)=>a?((((b||Date.now())-a)/1000).toFixed(1)+"s"):""
let state=null
function render(){if(!state)return;const r=state.run;$("where").textContent=state.cwd+(state.info?.model?" · "+state.info.provider+"/"+state.info.model:"")
const st=$("status");const s=r?(r.endedAt?r.status:"running"):(state.queueRunning?"queue running":"idle");st.textContent=s;st.className="pill "+(s==="running"||s==="queue running"?"run":s==="COMPLETED"?"ok":/ERROR|FAILED|ABORT/.test(s)?"bad":"")
const busy=(r&&!r.endedAt)||state.queueRunning;$("run").disabled=busy;$("qrun").disabled=busy;$("stop").disabled=!(r&&!r.endedAt)
const m=$("mode");if(r&&r.mode){m.hidden=false;m.textContent=r.mode==="meta"?"orchestrator":"single loop"}else m.hidden=true;$("model").textContent=r&&r.model?r.model:""
const plan=$("plan");if(r&&r.plan&&r.plan.length){plan.innerHTML=r.plan.map(n=>'<li class="node '+n.status+'"><span class="mark">'+({completed:"✓",failed:"✗",running:"●",pending:"○",stopped:"■"}[n.status]||"○")+'</span><span>'+esc(n.title)+'<div class="meta">'+[n.role,n.model].filter(Boolean).map(esc).join(" · ")+'</div></span><span class="meta">'+ms(n.startedAt,n.endedAt)+'</span></li>').join("")}else plan.innerHTML='<li class="empty">'+(r&&r.mode==="single"?"Single loop — no plan graph for this task.":"No plan yet — small tasks run as a single loop.")+'</li>'
const act=$("act");const a=(r&&r.activity)||[];act.innerHTML=a.length?a.slice(-40).map(x=>'<li>'+(x.ok===null?"●":x.ok?"✓":"✗")+" "+esc(x.name)+' <span class="meta">'+(x.who?esc(x.who)+" · ":"")+esc(String(x.args).slice(0,90))+(x.ms!=null?" · "+x.ms+"ms":"")+'</span></li>').join(""):'<li class="empty">—</li>'
const ans=$("answer");if(r&&r.endedAt&&(r.answer||r.error)){ans.hidden=false;const rp=r.repo;const dl=rp&&rp.delivery;const tail=rp?("\n\n"+rp.slug+" · branch "+(rp.branch||"?")+(dl&&dl.pr?" · PR "+dl.pr:dl&&dl.committed?" · commit "+(dl.sha||"")+(dl.pushed?" (pushed)":" (local)"):" · nothing delivered"+(dl&&dl.reason?": "+dl.reason:""))):"";$("answer-text").textContent=(r.error?("Error: "+r.error):r.answer)+tail}else ans.hidden=true
const q=$("queue");const items=state.queue&&state.queue.items||[];q.innerHTML=items.length?items.map((it,i)=>'<li><b>'+(i+1)+".</b> "+esc(String(it.task).slice(0,120))+' <span class="meta">'+(it.repo?esc(it.repo)+(it.pr?" +PR":"")+" · ":"")+esc(it.status)+(it.result&&it.result.merge?" · "+esc(it.result.merge.merge):"")+'</span></li>').join(""):'<li class="empty">empty</li>'}
async function refresh(){state=await api("/state");render()}
async function refreshDiff(){const d=await api("/diff");const f=$("files");if(!d.git){f.innerHTML='<li class="empty">not a git repository — no diff view</li>';$("diff").innerHTML="";return}
f.innerHTML=d.files.length?d.files.map(x=>'<li><b>'+esc(x.status)+"</b> "+esc(x.path)+"</li>").join(""):'<li class="empty">no changes</li>'
$("diff").innerHTML=(d.diff||"").split("\\n").map(l=>'<div class="'+(l.startsWith("+")&&!l.startsWith("+++")?"a":l.startsWith("-")&&!l.startsWith("---")?"d":l.startsWith("@@")?"h":"")+'">'+(esc(l)||"&nbsp;")+"</div>").join("")+(d.truncated?'<div class="meta">… diff truncated</div>':"")}
const repoBody=()=>{const repo=$("repo").value.trim();return repo?{repo,base:$("base").value.trim()||null,pr:$("pr").checked}:{}}
$("run").onclick=async()=>{const task=$("task").value.trim();if(!task)return;const rb=repoBody();if(rb.pr&&!confirm("Push the work branch and open a pull request on "+rb.repo+" with your gh?"))return;const r=await api("/run",{method:"POST",body:JSON.stringify({task,mode:$("mode-sel").value||null,...rb})});if(r.error)alert(r.error);refresh()}
$("stop").onclick=()=>api("/stop",{method:"POST"}).then(refresh)
$("enqueue").onclick=async()=>{const task=$("task").value.trim();if(!task)return;const r=await api("/queue",{method:"POST",body:JSON.stringify({task,mode:$("mode-sel").value==="single"?"single":$("mode-sel").value==="meta"?"meta":"auto",...repoBody()})});if(r.error)alert(r.error);else $("task").value="";refresh()}
$("qrun").onclick=async()=>{const r=await api("/queue/run",{method:"POST",body:JSON.stringify({parallel:Number($("par").value)})});if(r.error)alert(r.error);refresh()}
let pending=null;const soon=(fn)=>{clearTimeout(pending);pending=setTimeout(fn,250)}
const es=new EventSource("/events?t="+encodeURIComponent(T));es.onmessage=(m)=>{let ev;try{ev=JSON.parse(m.data)}catch{return}
if(ev.type==="web_hello"){state=ev.state;render();return}
soon(refresh);if(ev.type==="tool_result"||ev.type==="web_run_end"||ev.type==="DAG_NODE_COMPLETED"||ev.type==="web_queue")setTimeout(refreshDiff,300)}
refresh();refreshDiff();setInterval(()=>{if(state&&state.run&&!state.run.endedAt)render()},1000)
</script></body></html>`
}
