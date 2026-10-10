#!/usr/bin/env node
/**
 * forge web — the chat app: conversations, streamed chat, agent turns,
 * attachments of any type, export, downloads, settings, and the page itself.
 *
 * The real server (web.js) with the real chat engine (webchat.js), settings
 * (websettings.js) and file reading (docextract.js), against a mock model over
 * HTTP and a temporary git project. Only the agent turn is scripted (it writes
 * a file and reports tool events like the agent does); the agent itself has
 * its own suites.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import zlib from "node:zlib"
import { execFileSync } from "node:child_process"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 500) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-webchat-"))
process.env.FORGE_HOME = path.join(TMP, "home")
fs.mkdirSync(process.env.FORGE_HOME, { recursive: true })
const PROJ = path.join(TMP, "proj")
fs.mkdirSync(PROJ)
const git = (...a) => execFileSync("git", a, { cwd: PROJ, encoding: "utf8" })
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t")
fs.writeFileSync(path.join(PROJ, "README.md"), "# demo\n"); git("add", "-A"); git("commit", "-qm", "init")

const D = await import("../docextract.js")
const W = await import("../webchat.js")
const { createWebSettings } = await import("../websettings.js")
const { createWebServer, parsePorcelainZ } = await import("../web.js")
const { appHtml } = await import("../webui.js")
const { streamChatResilient } = await import("../providers.js")
const { makeStoreZip } = await import("../zipingest.js")
const { loadSession, projectSessionFile, saveSession } = await import("../sessions.js")

// ---- a mock model -------------------------------------------------------------
let lastWire = null
let slow = false
const model = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    let j = {}; try { j = JSON.parse(b) } catch { }
    if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] })) }
    lastWire = j
    const user = (j.messages ?? []).filter((m) => m.role === "user").at(-1)
    const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ")
    const att = /<attachment[^>]*>\n?([\s\S]*?)\n?<\/attachment>/.exec(text)?.[1]
    const answer = att ? `READ:${att.trim().slice(0, 80)}` : `ECHO:${text.slice(0, 40)}`
    res.writeHead(200, { "content-type": "text/event-stream" })
    const parts = answer.match(/[\s\S]{1,6}/g) ?? [""]
    let i = 0
    const tick = () => {
      if (res.destroyed) return
      if (i < parts.length) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i++] } }] })}\n\n`); return setTimeout(tick, slow ? 200 : 2) }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); res.end("data: [DONE]\n\n")
    }
    tick()
  })
})
await new Promise((r) => model.listen(0, "127.0.0.1", r))

const config = {
  activeProvider: "mock",
  providers: { mock: { protocol: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "sk-mock-123456789", model: "m-1" } },
  retry: { attempts: 1 },
}
let provider = { name: "mock", protocol: "openai", baseUrl: config.providers.mock.baseUrl, apiKey: config.providers.mock.apiKey, model: "m-1" }
const saved = []
const agentTasks = []
const chat = W.createWebChat({
  config, cwd: PROJ, getProvider: () => provider, stream: streamChatResilient,
  systemPrompt: async () => "You are forge (test).",
  gitStatus: W.gitStatusMap,
  runAgentTurn: async ({ task, onEvent, signal }) => {
    agentTasks.push(task)
    onEvent({ type: "tool_start", name: "write_file", args: JSON.stringify({ path: "greet.txt", content: "hi" }), step: 1 })
    onEvent({ type: "info", text: "lsp tool available: lsp_hover" })
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" })
    fs.writeFileSync(path.join(PROJ, "greet.txt"), "hi\n")
    onEvent({ type: "tool_result", name: "write_file", result: "wrote greet.txt" })
    return { mode: "single", res: { text: "Wrote greet.txt.", taskStatus: "COMPLETED" } }
  },
})
const settings = createWebSettings({ config, providerRef: { get: () => provider, set: (p) => { provider = p } }, save: (c) => saved.push(JSON.parse(JSON.stringify(c))), version: "test" })
const TOKEN = "tok_" + "x".repeat(20)
const web = createWebServer({ cwd: PROJ, info: {}, run: async () => ({}), token: TOKEN, chat, settings, appHtml })
await web.listen(0)
const PORT = web.port
const H = { "x-forge-token": TOKEN }

const req = (method, p, { body, headers = {}, raw = null } = {}) => new Promise((resolve) => {
  const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : null)
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: { host: `127.0.0.1:${PORT}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
      const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString("utf8")) } catch { }
      resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString("utf8"), json })
    })
  })
  r.on("error", (e) => resolve({ status: 0, error: e }))
  if (data) r.write(data); r.end()
})
const ndjson = (text) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
const fixture = (name, buf) => { const f = path.join(TMP, name); fs.writeFileSync(f, buf); return f }

try {
  console.log("== reading files of every kind (docextract.js) ==")
  {
    const docx = fixture("a.docx", makeStoreZip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>" }))
    eq("Word: paragraphs, entities decoded", D.describeFile(docx).text, "Hello & welcome\nSecond")
    const pptx = fixture("a.pptx", makeStoreZip({ "ppt/slides/slide2.xml": "<a:p><a:t>Two</a:t></a:p>", "ppt/slides/slide10.xml": "<a:p><a:t>Ten</a:t></a:p>", "ppt/slides/slide1.xml": "<a:p><a:t>One</a:t></a:p>" }))
    ok("PowerPoint: slides in their real order (1, 2, 10)", /slide 1 ---\nOne[\s\S]*slide 2 ---\nTwo[\s\S]*slide 3 ---\nTen/.test(D.describeFile(pptx).text ?? ""), D.describeFile(pptx).text)
    const xlsx = fixture("a.xlsx", makeStoreZip({ "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Ali</t></si></sst>", "xl/workbook.xml": '<workbook><sheets><sheet name="People"/></sheets></workbook>', "xl/worksheets/sheet1.xml": '<sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>Age</t></is></c></row><row><c t="s"><v>1</v></c><c><v>42</v></c></row></sheetData>' }))
    const xs = D.describeFile(xlsx)
    ok("Excel: sheet name, shared and inline strings, numbers", xs.kind === "spreadsheet" && /sheet People \(2 rows\)[\s\S]*Name\tAge\nAli\t42/.test(xs.text), xs.text)
    eq("OpenDocument text", D.describeFile(fixture("a.odt", makeStoreZip({ "content.xml": "<text:p>Open</text:p><text:h>Head</text:h>" }))).text, "Open\nHead")
    ok("a zip is listed", /2 file\(s\)[\s\S]*one\.txt/.test(D.describeFile(fixture("b.zip", makeStoreZip({ "one.txt": "1", "dir/two.txt": "22" }))).text ?? ""))
    const deflated = (() => { // a real deflate entry, sizes in the central directory
      const data = zlib.deflateRawSync(Buffer.from("<w:p><w:t>Deflated text</w:t></w:p>"))
      const name = Buffer.from("word/document.xml"), crc = 0
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(35, 22); lh.writeUInt16LE(name.length, 26)
      const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(35, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42)
      const local = Buffer.concat([lh, name, data]), central = Buffer.concat([cd, name])
      const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16)
      return Buffer.concat([local, central, eocd])
    })()
    eq("a deflated entry, read through the central directory", D.describeFile(fixture("c.docx", deflated)).text, "Deflated text")
    const stream = zlib.deflateSync(Buffer.from("BT /F1 12 Tf 72 720 Td (Built-in PDF reader) Tj ET"))
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + stream.length + " /Filter /FlateDecode >>\nstream\n"), stream, Buffer.from("\nendstream\nendobj\n%%EOF\n")])
    eq("PDF: the built-in reader inflates and reads Tj", D.pdfTextBuiltin(pdf), "Built-in PDF reader")
    ok("PDF through describeFile (pdftotext when installed, else built-in)", /Built-in PDF reader/.test(D.describeFile(fixture("p.pdf", pdf)).text ?? ""), D.describeFile(fixture("p.pdf", pdf)).note)
    ok("a PDF with no text layer says so", /no text layer/.test(D.describeFile(fixture("scan.pdf", Buffer.from("%PDF-1.4\n%%EOF\n"))).note ?? ""))
    eq("CSV is text", D.describeFile(fixture("t.csv", "a,b\n1,2\n")).kind, "text")
    eq("source code is code", D.describeFile(fixture("x.py", "print(1)\n")).kind, "code")
    const big = D.describeFile(fixture("big.txt", "x".repeat(D.MAX_TEXT_CHARS + 50)))
    ok("long text is cut to fit, and says so", big.truncated === true && big.text.length === D.MAX_TEXT_CHARS)
    const bin = D.describeFile(fixture("blob.bin", Buffer.from([0, 1, 2, 3, 255, 0, 7])))
    ok("a binary file is described, never dumped", bin.kind === "binary" && bin.text === null && /saved path/.test(bin.note))
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000", "hex"), Buffer.alloc(40)])
    const img = fixture("pic.png", png)
    ok("an image becomes an image part for a model that can see", D.describeFile(img, { provider: { name: "x", model: "gpt-4o", protocol: "openai" } }).imagePart?.type === "image_url")
    const blind = D.describeFile(img, { provider: { name: "x", model: "text-only-1", protocol: "openai", vision: false } })
    ok("…and a description for one that cannot", blind.imagePart === null && /cannot see images/.test(blind.note))
    eq("download types", [D.mimeFor("a.pdf"), D.mimeFor("b.docx").slice(0, 26), D.mimeFor("c.unknownext")], ["application/pdf", "application/vnd.openxmlfor", "application/octet-stream"])
  }

  console.log("== hostile files cannot stall or exhaust the server ==")
  {
    // a deflated zip whose central directory can lie about sizes and point
    // many names at one deflate stream
    const zipDeflate = (files, { lie = false, extraNames = [] } = {}) => {
      const locals = [], cds = []; let off = 0, first = null
      const central = (name, comp, size, at) => { const nb = Buffer.from(name), cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(at, 42); cds.push(cd, nb) }
      for (const [name, data] of Object.entries(files)) {
        const comp = zlib.deflateRawSync(data), nb = Buffer.from(name), lh = Buffer.alloc(30)
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(lie ? 0 : data.length, 22); lh.writeUInt16LE(nb.length, 26)
        locals.push(lh, nb, comp); central(name, comp.length, lie ? 0 : data.length, off)
        first ??= { comp: comp.length, at: off }
        off += 30 + nb.length + comp.length
      }
      for (const n of extraNames) central(n, first.comp, 0, first.at)
      const cdb = Buffer.concat(cds), e = Buffer.alloc(22), n = cds.length / 2
      e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(n, 8); e.writeUInt16LE(n, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16)
      return Buffer.concat([...locals, cdb, e])
    }
    const timed = (f) => { const t = Date.now(); const r = f(); return { r, ms: Date.now() - t } }
    const lt = timed(() => D.describeFile(fixture("lt.docx", zipDeflate({ "word/document.xml": Buffer.alloc(8 * 1024 * 1024, "<") }, { lie: true }))))
    ok("8 MB of \"<\" in a docx reads in linear time (a backtracking regex took minutes)", lt.ms < 5000, `${lt.ms} ms`)
    const rows = timed(() => D.describeFile(fixture("rows.xlsx", zipDeflate({ "xl/worksheets/sheet1.xml": Buffer.from("<row ".repeat(400_000)), "xl/sharedStrings.xml": Buffer.from("<si><t>".repeat(200_000)) }))))
    ok("unclosed <row and <si in a sheet read in linear time", rows.ms < 5000, `${rows.ms} ms`)
    const shared = timed(() => D.describeFile(fixture("shared.docx", zipDeflate({ "word/document.xml": Buffer.alloc(16 * 1024 * 1024, "a") }, { lie: true, extraNames: Array.from({ length: 200 }, (_, i) => `word/header${i + 1}.xml`) }))))
    ok("200 names for one deflate stream (declared size 0) inflate it once, not 200 times", shared.ms < 5000 && shared.r.truncated === true, `${shared.ms} ms`)
    const a85 = timed(() => D.pdfTextBuiltin(Buffer.from("%PDF-1.4\n1 0 obj <</Filter /ASCII85Decode>> stream\n" + "z".repeat(64 * 1024) + "\nendstream\n")))
    ok("an ASCII85 \"z\" bomb in a PDF is bounded", a85.ms < 3000, `${a85.ms} ms`)
    const bt = timed(() => D.pdfTextBuiltin(Buffer.from("%PDF-1.4\n1 0 obj <<>> stream\n" + "BT [ ( ".repeat(300_000) + "\nendstream\n")))
    ok("unclosed BT / [ / ( in a PDF read in linear time", bt.ms < 3000, `${bt.ms} ms`)
    eq("the PDF reader still reads Tj, TJ and escapes", D.pdfTextBuiltin(Buffer.from("%PDF\n1 0 obj <<>> stream\nBT /F1 12 Tf 72 700 Td (Hello \\(world\\)) Tj T* [(A) -20 (B)] TJ ET\nendstream\n")), "Hello (world)\nAB")
    eq("tags are stripped in one pass", D.stripTags("a<b>c</b>d<<<"), "acd")
    // the server reads uploads in a worker: a slow file costs its deadline, not the server
    let worst = 0, last = Date.now()
    const iv = setInterval(() => { worst = Math.max(worst, Date.now() - last - 20); last = Date.now() }, 20)
    const iso = await D.describeFileIsolated(path.join(TMP, "rows.xlsx"))
    clearInterval(iv)
    ok("an upload is read off the server's thread", iso.kind === "spreadsheet" && worst < 400, `stall ${worst} ms`)
    const late = await D.describeFileIsolated(path.join(TMP, "lt.docx"), { timeoutMs: 1 })
    ok("…and a file that takes too long is skipped with a note, not an error", late.text === null && /longer than|could not be read/.test(late.note), JSON.stringify(late.note))
  }

  console.log("== Auto: chat or agent ==")
  {
    const cases = [
      ["What does the parser do?", "chat"], ["Explain monads", "chat"], ["summarize the attached report", "chat"],
      ["Fix the failing test in parser.js", "agent"], ["Create a README for this project", "agent"], ["add a --verbose flag to the cli", "agent"],
      ["run the tests", "agent"], ["/agent tell me about it", "agent"], ["/chat fix the bug in app.js", "chat"],
      ["Can you refactor utils.js to use async/await?", "agent"], ["how do I fix a merge conflict?", "chat"],
      // writing is not work on the project: no tools, no shell
      ["Write a short poem about autumn", "chat"], ["Make a list of birthday gift ideas", "chat"], ["Generate 5 names for my cat", "chat"],
      ["Can you explain how to run the tests?", "chat"], ["build a landing page for the app", "agent"],
    ]
    for (const [t, want] of cases) eq(`"${t}"`, W.chooseMode(t).mode, want)
    eq("\"yes, go ahead\" after the agent continues with the agent", W.chooseMode("go ahead", { lastMode: "agent" }).mode, "agent")
  }

  console.log("== the page ==")
  {
    const page = await req("GET", `/?t=${TOKEN}`)
    ok("/ is the chat app, with the token", page.status === 200 && /What are we working on\?/.test(page.text) && page.text.includes(JSON.stringify(TOKEN)))
    ok("…and a strict content policy (only this server, no outside requests)", /default-src 'none'/.test(page.headers["content-security-policy"] ?? "") && /connect-src 'self'/.test(page.headers["content-security-policy"]))
    ok("…self-contained: no external scripts, styles or URLs", !/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!127\.0\.0\.1)/.test(page.text))
    const js = page.text.slice(page.text.indexOf("<script>") + 8, page.text.lastIndexOf("</script>"))
    let parses = true; try { new Function(js) } catch (e) { parses = e.message }
    ok("…its script parses", parses === true, parses)
    ok("the workspace page moved to /workspace", (await req("GET", `/workspace?t=${TOKEN}`)).text.includes("prefers-color-scheme:dark"))
    eq("the browser's favicon request needs no token", (await req("GET", "/favicon.ico")).status, 204)
    // the page's own Markdown renderer, run here: everything is escaped first
    const src = js.slice(js.indexOf("function esc("), js.indexOf("// ---- conversations list"))
    const md = new Function(src.replace(/^function esc/, "function esc") + "\nreturn md")()
    ok("markdown: raw HTML is shown, never run", !/<img|<script/i.test(md("<img src=x onerror=alert(1)> <script>alert(1)</script>")) && /&lt;img/.test(md("<img src=x>")))
    ok("markdown: a javascript: link is not a link", !/href=/.test(md("[click](javascript:alert(1))")))
    ok("markdown: an http link opens safely", /<a href="https:\/\/x\.example\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">x<\/a>/.test(md("[x](https://x.example/a?b=1&c=2)")))
    ok("markdown: an attribute cannot be broken out of", !/onmouseover=/.test(md('[x](https://a.example/"onmouseover="alert(1))').replace(/&quot;/g, "")) || !/"onmouseover/.test(md('[x](https://a.example/"onmouseover="alert(1))')))
    ok("markdown: code blocks are escaped", /<pre><code>&lt;b&gt;bold&lt;\/b&gt;<\/code><\/pre>/.test(md("\x60\x60\x60html\n<b>bold</b>\n\x60\x60\x60")))
    ok("markdown: headings, lists, tables, inline code", /<h2>T<\/h2>/.test(md("## T")) && /<ul><li>a<\/li><li>b<\/li><\/ul>/.test(md("- a\n- b")) && /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>1<\/td>/.test(md("| A |\n|---|\n| 1 |")) && /<code>x &lt; y<\/code>/.test(md("\x60x < y\x60")))
    ok("markdown: a nested list", /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/.test(md("- a\n  - b")), md("- a\n  - b"))
    let deep = true; try { md("> ".repeat(20000) + "x") } catch (e) { deep = e.message }
    ok("markdown: 20,000 nested quotes render (no stack overflow)", deep === true, deep)
    ok("markdown: emphasis marks inside a URL do not break the link", /<a href="https:\/\/x\.example\/a\*b\*c"/.test(md("[x](https://x.example/a*b*c) and *em*")) && /<em>em<\/em>/.test(md("[x](https://x.example/a*b*c) and *em*")))
  }

  console.log("== conversations and chat ==")
  let convId
  {
    const c = await req("POST", "/api/conversations", { headers: H, body: {} })
    convId = c.json?.id
    ok("a new conversation", c.status === 201 && /^[\w.-]+$/.test(convId ?? ""))
    const r = await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "What is a monad?" } })
    const evs = ndjson(r.text)
    ok("the answer streams as NDJSON: mode, deltas, done", r.status === 200 && /ndjson/.test(r.headers["content-type"]) && evs[0].type === "mode" && evs.filter((e) => e.type === "delta").length > 1 && evs.at(-1).type === "done", r.text.slice(0, 300))
    eq("Auto chose chat for a question", evs[0].mode, "chat")
    eq("the streamed text is the answer", evs.filter((e) => e.type === "delta").map((e) => e.text).join(""), "ECHO:What is a monad?")
    ok("the model got the system prompt", lastWire?.messages?.[0]?.role === "system")
    const list = (await req("GET", `/api/conversations?t=${TOKEN}`)).json.conversations
    ok("it is listed, titled by its first message", list.some((x) => x.id === convId && x.title === "What is a monad?"))
    const s = loadSession(projectSessionFile(convId))
    ok("it is an ordinary forge session (forge chat --continue / resume see it)", s?.messages?.length === 2 && s.messages[1].content === "ECHO:What is a monad?" && s.cwd === PROJ)
    await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "And a functor?" } })
    ok("a follow-up carries the conversation", lastWire.messages.some((m) => m.content === "What is a monad?"))
    const got = (await req("GET", `/api/conversations/${convId}?t=${TOKEN}`)).json
    eq("the conversation reads back", got.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"])
  }

  console.log("== attachments ==")
  {
    const up = await req("POST", "/api/upload", { headers: { ...H, "x-filename": encodeURIComponent("report Q3.docx") }, raw: makeStoreZip({ "word/document.xml": "<w:p><w:t>Revenue grew 12%</w:t></w:p>" }) })
    ok("a file uploads", up.status === 201 && /^[0-9a-f]{18}$/.test(up.json?.id ?? "") && up.json.name === "report Q3.docx", up.text)
    ok("…into the project's .forge/uploads, where an agent can open it", fs.existsSync(path.join(PROJ, ".forge", "uploads", up.json.id, "report Q3.docx")))
    const r = ndjson((await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "What does it say?", attachments: [up.json.id] } })).text)
    eq("the model read the Word file's text", r.filter((e) => e.type === "delta").map((e) => e.text).join(""), "READ:Revenue grew 12%")
    ok("the message records the attachment for the page", r.at(-1).type === "done" && (await req("GET", `/api/conversations/${convId}?t=${TOKEN}`)).json.messages.at(-2).attachments?.[0]?.kind === "document")
    const back = await req("GET", `/api/upload/${up.json.id}?t=${TOKEN}`)
    ok("the original downloads back", back.status === 200 && /attachment; filename=/.test(back.headers["content-disposition"]) && back.buf.length === up.json.bytes)
    eq("an unknown or malformed upload id is a 404", [(await req("GET", `/api/upload/aaaaaaaaaaaaaaaaaa?t=${TOKEN}`)).status, (await req("GET", `/api/upload/..%2F..?t=${TOKEN}`)).status], [404, 404])
    eq("an empty file is refused", (await req("POST", "/api/upload", { headers: { ...H, "x-filename": "e.txt" }, raw: Buffer.alloc(0) })).status, 400)
    const huge = await req("POST", "/api/upload", { headers: { ...H, "x-filename": "big.bin" }, raw: Buffer.alloc(W.MAX_UPLOAD_BYTES + 1) })
    ok("a file over 50 MB is refused (413)", huge.status === 413 || huge.status === 0, huge.status)
    const evil = await req("POST", "/api/upload", { headers: { ...H, "x-filename": encodeURIComponent("../../etc/passwd") }, raw: Buffer.from("x") })
    ok("a path in the file name is flattened", evil.status === 201 && evil.json.name === "passwd" && fs.existsSync(path.join(PROJ, ".forge", "uploads", evil.json.id, "passwd")))
  }

  console.log("== an agent turn ==")
  {
    const r = ndjson((await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "Create greet.txt with a greeting" } })).text)
    eq("Auto chose the agent for an instruction", r[0].mode, "agent")
    const acts = r.filter((e) => e.type === "activity").map((e) => e.item)
    ok("the work streams as activity: the tool, its target, its result", acts[0]?.kind === "tool" && acts[0].detail === "greet.txt (2 chars)" && acts.some((a) => a.kind === "result" && a.ok))
    ok("…without forge's own bookkeeping lines", !acts.some((a) => /lsp tool available/.test(a.detail ?? "")))
    const done = r.at(-1).message
    ok("the answer, and the file it changed", done.text === "Wrote greet.txt." && done.files.length === 1 && done.files[0].path === "greet.txt" && done.files[0].status === "added", JSON.stringify(done.files))
    ok("the agent was given the conversation's context", /greet\.txt/.test(agentTasks.at(-1)))
    const f = await req("GET", `/api/file?path=greet.txt&t=${TOKEN}`)
    ok("the changed file downloads", f.status === 200 && f.text === "hi\n")
    const patch = await req("GET", `/api/changes.patch?t=${TOKEN}`)
    ok("all changes download as a .patch", patch.status === 200 && /\+\+\+ b\/greet\.txt/.test(patch.text) && !/\.forge\/uploads/.test(patch.text))
    const zip = await req("GET", `/api/changes.zip?t=${TOKEN}`)
    const names = D.zipEntries(zip.buf)?.map((e) => e.name) ?? []
    ok("…or as a .zip of the changed files", zip.status === 200 && names.includes("greet.txt") && !names.some((n) => n.startsWith(".forge")), names.join(","))
    const evl = ndjson((await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "/chat fix the bug in app.js" } })).text)
    eq("/chat forces a plain answer even for an instruction", evl[0].mode, "chat")
  }

  console.log("== downloads stay inside the project ==")
  {
    fs.writeFileSync(path.join(TMP, "secret.txt"), "outside")
    fs.symlinkSync(path.join(TMP, "secret.txt"), path.join(PROJ, "link.txt"))
    eq("../ is refused", (await req("GET", `/api/file?path=../secret.txt&t=${TOKEN}`)).status, 404)
    eq("an absolute path is refused", (await req("GET", `/api/file?path=${encodeURIComponent(path.join(TMP, "secret.txt"))}&t=${TOKEN}`)).status, 404)
    eq("a symlink pointing outside is refused", (await req("GET", `/api/file?path=link.txt&t=${TOKEN}`)).status, 404)
    eq("a directory is refused", (await req("GET", `/api/file?path=.git&t=${TOKEN}`)).status, 404)
    fs.unlinkSync(path.join(PROJ, "link.txt"))
  }

  console.log("== export ==")
  {
    const md = await req("GET", `/api/export?id=${convId}&format=md&t=${TOKEN}`)
    ok("Markdown, as a download named after the chat", md.status === 200 && /attachment; filename="What-is-a-monad\.md"/.test(md.headers["content-disposition"]) && /^# What is a monad\?/.test(md.text) && /📎 report Q3\.docx/.test(md.text) && /files changed: greet\.txt/.test(md.text))
    const js = await req("GET", `/api/export?id=${convId}&format=json&t=${TOKEN}`)
    ok("JSON with the page's view and the model's messages", js.json?.messages?.length >= 8 && Array.isArray(js.json.modelMessages))
    const html = await req("GET", `/api/export?id=${convId}&format=html&inline=1&t=${TOKEN}`)
    ok("HTML for printing to PDF: inline, escaped, no scripts allowed", /inline/.test(html.headers["content-disposition"]) && /default-src 'none'/.test(html.headers["content-security-policy"]) && !/script-src/.test(html.headers["content-security-policy"]) && /<h1>What is a monad\?<\/h1>/.test(html.text))
  }

  console.log("== stop, and one answer at a time ==")
  {
    slow = true
    const c = (await req("POST", "/api/conversations", { headers: H, body: {} })).json.id
    const p = req("POST", "/api/chat", { headers: H, body: { id: c, text: "Tell me a long story about forges" } })
    await new Promise((r) => setTimeout(r, 300))
    eq("a second message while one is answered is a 409", (await req("POST", "/api/chat", { headers: H, body: { id: c, text: "hi" } })).status, 409)
    eq("a workspace run while the chat answers is a 409", (await req("POST", "/run", { headers: H, body: { task: "x" } })).status, 409)
    eq("stop", (await req("POST", "/api/chat/stop", { headers: H, body: {} })).status, 200)
    const r = ndjson((await p).text)
    ok("the stopped answer ends, marked stopped, partial text kept", r.at(-1).type === "done" && r.at(-1).message.error === "stopped", JSON.stringify(r.at(-1)).slice(0, 200))
    eq("nothing left to stop", (await req("POST", "/api/chat/stop", { headers: H, body: {} })).status, 409)
    slow = false
  }

  console.log("== settings ==")
  {
    const s = (await req("GET", `/api/settings?t=${TOKEN}`)).json
    ok("settings show the model in use", s.active.provider === "mock" && s.active.model === "m-1")
    ok("an API key is never sent to the page — only its last four", !JSON.stringify(s).includes("sk-mock-123456789") && s.providers[0].keyHint === "…6789")
    const m = await req("POST", "/api/settings", { headers: H, body: { activeProvider: "mock", model: "m-2" } })
    ok("switching the model takes effect now and is saved", m.status === 200 && provider.model === "m-2" && saved.at(-1).providers.mock.model === "m-2")
    ndjson((await req("POST", "/api/chat", { headers: H, body: { id: convId, text: "which model?" } })).text)
    eq("…the next answer uses it", lastWire.model, "m-2")
    eq("a key that is not a key is refused", (await req("POST", "/api/settings", { headers: H, body: { apiKey: { provider: "mock", key: "no" } } })).status, 400)
    const k = await req("POST", "/api/settings", { headers: H, body: { apiKey: { provider: "mock", key: "sk-new-abcdefgh" } } })
    ok("a new key is saved through the config (keys file) and used", k.status === 200 && saved.at(-1).providers.mock.apiKey === "sk-new-abcdefgh" && provider.apiKey === "sk-new-abcdefgh")
    const add = await req("POST", "/api/settings", { headers: H, body: { addProvider: { name: "lab", baseUrl: "https://lab.example/v1", model: "lab-1", key: "sk-lab-12345678" } } })
    ok("a custom provider can be added", add.status === 200 && add.json.providers.some((p) => p.name === "lab" && p.usable))
    eq("a custom provider without a base URL is refused", (await req("POST", "/api/settings", { headers: H, body: { addProvider: { name: "nourl" } } })).status, 400)
    eq("the provider in use cannot be removed", (await req("POST", "/api/settings", { headers: H, body: { removeProvider: "mock" } })).status, 400)
    const beh = await req("POST", "/api/settings", { headers: H, body: { web: { defaultMode: "agent", deep: true }, failover: true, tries: 3 } })
    ok("behaviour settings save", beh.status === 200 && beh.json.web.defaultMode === "agent" && beh.json.web.deep === true && beh.json.failover === true && beh.json.tries === 3)
    eq("tries out of range is refused", (await req("POST", "/api/settings", { headers: H, body: { tries: 9 } })).status, 400)
    eq("an unknown mode is refused", (await req("POST", "/api/settings", { headers: H, body: { web: { defaultMode: "yolo" } } })).status, 400)
    const ml = (await req("GET", `/api/models?provider=mock&t=${TOKEN}`)).json
    ok("the provider's model list loads", ml.ok === true && ml.models.includes("m-2"), JSON.stringify(ml))
    const was = JSON.stringify({ web: config.web, failover: config.failover, agent: config.agent }), n0 = saved.length
    eq("a change with one bad part is refused whole", (await req("POST", "/api/settings", { headers: H, body: { web: { defaultMode: "chat" }, failover: false, tries: 0 } })).status, 400)
    ok("…and none of it was applied or saved", JSON.stringify({ web: config.web, failover: config.failover, agent: config.agent }) === was && saved.length === n0)
    eq("switching to a provider that cannot work is refused", (await req("POST", "/api/settings", { headers: H, body: { activeProvider: "ghost", model: "g-1" } })).status, 400)
    ok("…and leaves no empty entry behind", !("ghost" in config.providers) && provider.name === "mock")
    eq("a new provider's key gets the same checks as any key", (await req("POST", "/api/settings", { headers: H, body: { addProvider: { name: "lab2", baseUrl: "https://lab.example/v1", key: "has space in it" } } })).status, 400)
  }

  console.log("== the terminal and the page share conversations ==")
  {
    const tid = "term-chat-1"
    saveSession({ provider: "mock", model: "m-1", id: tid, cwd: PROJ, messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "list the files" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "assistant", content: "There is a.txt." },
    ] })
    ndjson((await req("POST", "/api/chat", { headers: H, body: { id: tid, text: "/chat and what is in it?" } })).text)
    const wire = lastWire.messages.filter((m) => m.role !== "system")
    ok("a terminal conversation reaches the model without tool calls that lack their results", wire.every((m) => !m.tool_calls && m.role !== "tool") && wire.every((m, i) => i === 0 || m.role !== wire[i - 1].role) && wire[0].role === "user", JSON.stringify(wire.map((m) => m.role)))
    const s1 = loadSession(projectSessionFile(tid))
    saveSession({ provider: "mock", model: "m-1", id: tid, cwd: PROJ, messages: [...s1.messages, { role: "user", content: "from the terminal" }, { role: "assistant", content: "the terminal's answer" }] })
    ok("a turn taken in the terminal afterwards shows in the page", (await req("GET", `/api/conversations/${tid}?t=${TOKEN}`)).json.messages.some((m) => m.text === "the terminal's answer"))
    ndjson((await req("POST", "/api/chat", { headers: H, body: { id: tid, text: "/chat thanks" } })).text)
    ok("…and the next turn in the page keeps it (no stale copy overwrites it)", loadSession(projectSessionFile(tid)).messages.some((m) => m.content === "the terminal's answer"))
    eq("\"last\" (the store's pointer) is never a conversation", (await req("GET", `/api/conversations/last?t=${TOKEN}`)).status, 404)

    const big = (n) => `q${n}\n\n<attachment name="f${n}.txt" type="text" bytes="1" saved="/x">\n${"y".repeat(20000)}\n</attachment>`
    const h = W.chatHistory([1, 2, 3].flatMap((n) => [{ role: "user", content: big(n) }, { role: "assistant", content: `a${n}` }]))
    ok("older attachments are trimmed in the history; the last two turns keep theirs", h[0].content.length < 7000 && h[2].content.length > 20000 && h[4].content.length > 20000)
    const calls = []
    await W.composeUserMessage("q", ["a", "b", "c"].map((n) => ({ id: n, name: `${n}.txt`, bytes: 1, path: `/${n}` })), { describe: async (_, o) => { calls.push(o.maxChars); return { kind: "text", text: "x".repeat(o.maxChars), truncated: true } }, budget: 5000 })
    eq("the files of one message share one text budget", calls, [5000, 2000, 2000])
    eq("a second edit to an already-modified file is a change", W.changedBetween(new Map([["a.js", " M\u000010:1"]]), new Map([["a.js", " M\u000012:2"]])), [{ path: "a.js", status: "modified" }])
    eq("git -z names: renames and non-ASCII are exact", parsePorcelainZ("R  new.txt\0old.txt\0?? caf\u00e9.txt\0"), [{ status: "R", path: "new.txt" }, { status: "??", path: "caf\u00e9.txt" }])
  }

  console.log("== the same locks as the rest of forge web ==")
  {
    eq("no token → 401", (await req("GET", "/api/conversations")).status, 401)
    eq("a POST with the token only in the query → 401", (await req("POST", `/api/chat?t=${TOKEN}`, { body: { id: convId, text: "x" } })).status, 401)
    eq("a foreign Origin → 403", (await req("POST", "/api/settings", { headers: { ...H, origin: "https://evil.example" }, body: { failover: false } })).status, 403)
    eq("a foreign Host → 403", (await req("GET", `/api/settings?t=${TOKEN}`, { headers: { host: "evil.example" } })).status, 403)
    eq("delete needs the header token too", (await req("DELETE", `/api/conversations/${convId}?t=${TOKEN}`)).status, 401)
    eq("a bad conversation id is a 404", (await req("GET", `/api/conversations/..%2Fx?t=${TOKEN}`)).status, 404)
  }

  console.log("== rename and delete ==")
  {
    eq("rename", (await req("POST", `/api/conversations/${convId}/rename`, { headers: H, body: { title: "Monads, explained" } })).status, 200)
    ok("…the new title is kept", (await req("GET", `/api/conversations?t=${TOKEN}`)).json.conversations.some((c) => c.id === convId && c.title === "Monads, explained"))
    eq("delete", (await req("DELETE", `/api/conversations/${convId}`, { headers: H })).status, 200)
    ok("…gone from the list and from the session store", !(await req("GET", `/api/conversations?t=${TOKEN}`)).json.conversations.some((c) => c.id === convId) && !fs.existsSync(projectSessionFile(convId)))
  }
} finally {
  await web.close()
  model.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== webchat suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
