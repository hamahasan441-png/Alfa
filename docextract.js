/**
 * forge — what a file says, for a model (zero dependencies).
 *
 * The web chat lets you attach any file. A model cannot read bytes, so each
 * file becomes what the model can use:
 *
 *   text / code / data      the text itself (csv, json, md, html, source, logs…)
 *   images                  an image part when the model can see, otherwise a
 *                           description (never invented pixels: vision.js)
 *   PDF                     its text: pdftotext when installed, else a built-in
 *                           reader for ordinary text PDFs; a scanned PDF with no
 *                           text layer says so
 *   Word / PowerPoint /     their text, read from the ZIP+XML inside
 *   Excel / OpenDocument    (docx pptx xlsx odt odp ods); sheets as rows
 *   archives                the list of files inside (zip, tar, gz)
 *   anything else           name, type and size — and the saved path, so an
 *                           agent turn can open it with its own tools
 *
 * Every reader is bounded: an archive cannot inflate past its cap, a PDF tool
 * cannot run forever, and text longer than the cap is cut with a note saying so.
 */
import path from "node:path"
import { loadBuiltin } from "./lazybuiltin.js"
import { loadLocalImage, openaiImagePart, providerSupportsVision } from "./vision.js"

const fs = loadBuiltin("fs")

export const MAX_TEXT_CHARS = 120_000
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_ZIP_TOTAL = 96 * 1024 * 1024
const MAX_ZIP_ENTRIES = 5000
const MAX_SHEET_ROWS = 400
const MAX_PDF_TOTAL = 64 * 1024 * 1024
const PDFTOTEXT_TIMEOUT_MS = 20_000

const TEXT_EXT = new Set(("txt md markdown rst adoc csv tsv json jsonl ndjson yaml yml toml ini cfg conf env log xml html htm css scss less " +
  "js mjs cjs jsx ts tsx vue svelte py rb go rs java kt kts scala c h cc cpp hpp cs swift m mm php pl pm r jl lua sh bash zsh fish ps1 bat cmd " +
  "sql graphql gql proto tf hcl dockerfile makefile mk gradle cmake nix tex bib srt vtt diff patch gitignore editorconfig properties").split(" "))
const MIME = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", html: "text/html", htm: "text/html",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
  patch: "text/x-diff", diff: "text/x-diff",
}

const extOf = (name) => {
  const b = path.basename(String(name)).toLowerCase()
  if (b === "dockerfile" || b === "makefile") return b
  const i = b.lastIndexOf(".")
  return i > 0 ? b.slice(i + 1) : (b.startsWith(".") ? b.slice(1) : "")
}

/** A content type for a file name (for downloads). */
export function mimeFor(name) {
  const e = extOf(name)
  return MIME[e] ?? (TEXT_EXT.has(e) ? "text/plain" : "application/octet-stream")
}

const cap = (s, max = MAX_TEXT_CHARS) => {
  const t = String(s ?? "")
  return t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false }
}

/** Valid UTF-8 with no NUL bytes in the head → text. */
export function looksLikeText(buf) {
  if (!buf?.length) return true
  const head = buf.subarray(0, Math.min(buf.length, 8192))
  if (head.includes(0)) return false
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf.length > 4 * 1024 * 1024 ? buf.subarray(0, 4 * 1024 * 1024 - 4) : buf); return true } catch { return false }
}

// ---- ZIP (central directory: works for Office files that use data descriptors)

/** The entries of a ZIP buffer: { name, method, comp, uncomp, offset }. */
export function zipEntries(buf) {
  const b = buf
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count && n < MAX_ZIP_ENTRIES && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break
    const method = b.readUInt16LE(p + 10), comp = b.readUInt32LE(p + 20), uncomp = b.readUInt32LE(p + 24)
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), offset = b.readUInt32LE(p + 42)
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8")
    out.push({ name, method, comp, uncomp, offset })
    p += 46 + nlen + elen + clen
  }
  return out
}

/** One entry's bytes, bounded. null when it cannot be read safely. */
export function zipRead(buf, entry, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  const zlib = loadBuiltin("zlib")
  const p = entry.offset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const data = buf.subarray(start, start + entry.comp)
  if (entry.uncomp > maxBytes) return null
  try {
    if (entry.method === 0) return Buffer.from(data)
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes })
  } catch { return null }
  return null
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return "" } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return "" } })
  .replace(/&amp;/g, "&")

/** Remove <tags> in one pass (a regex like /<[^>]+>/ is quadratic on "<<<<…"). */
export function stripTags(s, mapTag = null) {
  s = String(s)
  let out = "", i = 0
  for (;;) {
    const lt = s.indexOf("<", i)
    if (lt < 0) { out += s.slice(i); break }
    out += s.slice(i, lt)
    const gt = s.indexOf(">", lt + 1)
    if (gt < 0) break // an unclosed tag: the rest is markup
    if (mapTag) out += mapTag(s.slice(lt, gt + 1)) ?? ""
    i = gt + 1
  }
  return out
}

/**
 * The substrings from each `open` to the next `close` (inclusive), in one
 * pass. `open` must be followed by one of `after` (so "<c" does not match
 * "<col"). A block with no close ends the scan — a lazy regex would instead
 * rescan to the end of the input for every opening it finds.
 */
export function blocks(s, open, close, { after = null, max = Infinity } = {}) {
  const out = []
  let i = 0
  while (out.length < max) {
    const a = s.indexOf(open, i)
    if (a < 0) break
    if (after && !after.includes(s[a + open.length] ?? "")) { i = a + open.length; continue }
    const b = s.indexOf(close, a + open.length)
    if (b < 0) break
    out.push(s.slice(a, b + close.length))
    i = b + close.length
  }
  return out
}

const xmlToText = (xml, { para, tab = null, br = null } = {}) => {
  let s = String(xml)
  if (tab) s = s.replace(tab, "\t")
  if (br) s = s.replace(br, "\n")
  if (para) s = s.replace(para, "\n")
  return decodeXml(stripTags(s)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function readZipDoc(buf, ext) {
  const entries = zipEntries(buf)
  if (!entries) return null
  // the cap counts bytes actually inflated (a declared size can lie), and two
  // entries may not share data (one deflate stream named a thousand times)
  let total = 0
  const used = new Set()
  const get = (name) => {
    const e = entries.find((x) => x.name === name)
    if (!e || used.has(e.offset) || total >= MAX_ZIP_TOTAL) return null
    used.add(e.offset)
    const b = zipRead(buf, e, { maxBytes: Math.min(MAX_ENTRY_BYTES, MAX_ZIP_TOTAL - total) })
    if (!b) return null
    total += b.length
    return b.toString("utf8")
  }
  const byNum = (re) => entries.map((e) => e.name).filter((n) => re.test(n)).sort((a, b) => Number(a.match(/(\d+)/g)?.pop()) - Number(b.match(/(\d+)/g)?.pop()))

  if (ext === "docx") {
    const parts = ["word/document.xml", ...byNum(/^word\/(header|footer)\d+\.xml$/), "word/footnotes.xml"]
    const text = parts.map((n) => get(n)).filter(Boolean).map((x) => xmlToText(x, { para: /<\/w:p>/g, tab: /<w:tab\/>/g, br: /<w:br\/>/g })).join("\n\n")
    return { kind: "document", text }
  }
  if (ext === "pptx") {
    const slides = byNum(/^ppt\/slides\/slide\d+\.xml$/)
    const text = slides.map((n, i) => `--- slide ${i + 1} ---\n${xmlToText(get(n) ?? "", { para: /<\/a:p>/g, br: /<a:br\/>/g })}`).join("\n\n")
    return { kind: "slides", text }
  }
  if (ext === "xlsx") {
    const shared = []
    const ss = get("xl/sharedStrings.xml")
    if (ss) for (const si of blocks(ss, "<si", "</si>", { after: "> " })) shared.push(decodeXml(blocks(si, "<t", "</t>", { after: "> " }).map(stripTags).join("")))
    const wb = get("xl/workbook.xml") ?? ""
    const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]))
    const sheets = byNum(/^xl\/worksheets\/sheet\d+\.xml$/)
    const out = []
    sheets.forEach((n, i) => {
      const xml = get(n) ?? ""
      const rows = blocks(xml, "<row", "</row>", { after: "> \t\r\n" })
      out.push(`--- sheet ${names[i] ?? i + 1} (${rows.length} rows) ---`)
      for (const row of rows.slice(0, MAX_SHEET_ROWS)) {
        const cells = []
        for (const c of cellsOf(row)) {
          const tag = c.slice(0, c.indexOf(">") + 1)
          const t = /\bt="([^"]*)"/.exec(tag)?.[1]
          const v = between(c, "<v>", "</v>")
          const inline = between(c, "<is>", "</is>")
          cells.push(t === "s" ? (shared[Number(v)] ?? "") : t === "inlineStr" ? decodeXml(stripTags(inline ?? "")) : decodeXml(v ?? ""))
        }
        out.push(cells.join("\t"))
      }
      if (rows.length > MAX_SHEET_ROWS) out.push(`… ${rows.length - MAX_SHEET_ROWS} more rows`)
    })
    return { kind: "spreadsheet", text: out.join("\n") }
  }
  if (ext === "odt" || ext === "odp" || ext === "ods") {
    const xml = get("content.xml") ?? ""
    const cellTabs = stripTags(xml, (tag) => (/^<table:table-cell[\s/>]/.test(tag) && tag.endsWith("/>")) || tag === "</table:table-cell>" ? "\t" : tag)
    const text = xmlToText(cellTabs, { para: /<\/text:(?:p|h)>|<\/table:table-row>/g, tab: /<text:tab\/>/g, br: /<text:line-break\/>/g })
    return { kind: ext === "ods" ? "spreadsheet" : ext === "odp" ? "slides" : "document", text }
  }
  // any other zip: list it
  const list = entries.filter((e) => !e.name.endsWith("/")).map((e) => `${e.name}  (${e.uncomp} bytes)`)
  return { kind: "archive", text: `${list.length} file(s):\n${list.slice(0, 500).join("\n")}${list.length > 500 ? `\n… ${list.length - 500} more` : ""}` }
}

/** The text between the first `a` and the next `b`, or null. */
function between(s, a, b) {
  const i = s.indexOf(a)
  if (i < 0) return null
  const j = s.indexOf(b, i + a.length)
  return j < 0 ? null : s.slice(i + a.length, j)
}

/** The <c …/> and <c …>…</c> cells of one sheet row, in one pass. */
function cellsOf(row) {
  const out = []
  let i = 0
  for (;;) {
    const a = row.indexOf("<c", i)
    if (a < 0) break
    const nx = row[a + 2]
    if (nx !== " " && nx !== ">" && nx !== "/") { i = a + 2; continue }
    const gt = row.indexOf(">", a)
    if (gt < 0) break
    if (row[gt - 1] === "/") { out.push(row.slice(a, gt + 1)); i = gt + 1; continue }
    const end = row.indexOf("</c>", gt)
    if (end < 0) break
    out.push(row.slice(a, end + 4))
    i = end + 4
  }
  return out
}

// ---- PDF -------------------------------------------------------------------

function pdftotext(abs) {
  try {
    const { spawnSync } = loadBuiltin("child_process")
    const r = spawnSync("pdftotext", ["-layout", "-q", "-enc", "UTF-8", abs, "-"], { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" })
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout
  } catch { }
  return null
}

/** ASCII85 (PDF /ASCII85Decode) → bytes, at most maxBytes of them. */
function ascii85(data, maxBytes = MAX_ENTRY_BYTES) {
  const s = data.toString("latin1")
  let i = s.startsWith("<~") ? 2 : 0
  const end = s.indexOf("~>", i)
  const stop = end >= 0 ? end : s.length
  const out = Buffer.alloc(Math.min(maxBytes, Math.ceil((stop - i) * 4) + 4))
  let n = 0
  let group = [], v = 0
  const put = (bytes, count) => { for (let k = 0; k < count && n < out.length; k++) out[n++] = bytes[k] }
  const flush = (count) => {
    v = 0
    for (let k = 0; k < 5; k++) v = v * 85 + (group[k] ?? 84)
    put([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], count)
    group = []
  }
  for (; i < stop && n < out.length; i++) {
    const ch = s.charCodeAt(i)
    if (ch === 122 /* z */ && group.length === 0) { put([0, 0, 0, 0], 4); continue }
    const c = ch - 33
    if (c < 0 || c > 84) continue
    group.push(c)
    if (group.length === 5) flush(4)
  }
  if (group.length > 1 && n < out.length) flush(group.length - 1)
  return out.subarray(0, n)
}

/**
 * The text a PDF content stream shows, in one pass: strings in (…) are
 * collected and kept when a show operator (Tj TJ ' ") follows; T* Td TD Tm
 * and ET end a line. Linear on any input — no backtracking regex.
 */
export function pdfShownText(s, out = [], maxChars = MAX_TEXT_CHARS * 2) {
  let line = "", pending = "", inText = false, size = 0
  const endLine = () => { if (line) { out.push(line); size += line.length; line = "" } }
  const n = s.length
  let i = 0
  while (i < n) {
    if (size >= maxChars) break // enough text from this stream
    const c = s[i]
    if (c === "(") {
      // a literal string: balanced parentheses, backslash escapes
      let depth = 1, j = i + 1, raw = ""
      while (j < n && depth > 0) {
        const d = s[j]
        if (d === "\\") { raw += s.slice(j, j + 2); j += 2; continue }
        if (d === "(") depth++
        else if (d === ")") { depth--; if (depth === 0) break }
        raw += d
        j++
      }
      if (inText) pending += pdfString(raw)
      i = j + 1
      continue
    }
    if (c === "%") { const e = s.indexOf("\n", i); i = e < 0 ? n : e + 1; continue }
    if (/[A-Za-z'"*]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z*]/.test(s[j])) j++
      const op = s.slice(i, j)
      i = j
      if (op === "BT") { inText = true; pending = ""; continue }
      if (op === "ET") { endLine(); inText = false; pending = ""; continue }
      if (!inText) continue
      if (op === "Tj" || op === "TJ" || op === "'" || op === "\"") { line += pending; pending = "" }
      else if (op === "T*" || op === "Td" || op === "TD" || op === "Tm") { endLine(); pending = "" }
      continue
    }
    i++
  }
  endLine()
  return out
}

/** Built-in reader for ordinary text PDFs: decode content streams, read Tj/TJ. */
export function pdfTextBuiltin(buf) {
  const zlib = loadBuiltin("zlib")
  const src = buf.toString("latin1")
  const out = []
  const re = /\bstream\r?\n/g
  let m
  let streams = 0
  let inflated = 0
  while ((m = re.exec(src)) && streams < 4000 && inflated < MAX_PDF_TOTAL && out.length < 200_000) {
    streams++
    const win = src.slice(Math.max(0, m.index - 2000), m.index)
    const head = win.slice(Math.max(0, win.lastIndexOf(" obj")))
    const start = m.index + m[0].length
    const end = src.indexOf("endstream", start)
    if (end < 0) break
    re.lastIndex = end
    // the stream's filters, applied in order; every stream counts against one
    // total, so a PDF of many small bombs stops as early as one big one
    const fm = /\/Filter\s*(\[[^\]]{0,400}\]|\/\w+)/.exec(head)
    const filters = fm ? [...fm[1].matchAll(/\/(\w+)/g)].map((x) => x[1]) : []
    let data = buf.subarray(start, end)
    let ok = true
    for (const f of filters) {
      const room = Math.max(1, Math.min(MAX_ENTRY_BYTES, MAX_PDF_TOTAL - inflated))
      try {
        if (f === "FlateDecode" || f === "Fl") data = zlib.inflateSync(data, { maxOutputLength: room })
        else if (f === "ASCII85Decode" || f === "A85") data = ascii85(data, room)
        else { ok = false; break }
      } catch { ok = false; break }
    }
    if (!ok) continue
    inflated += data.length
    const s = data.toString("latin1")
    if (s.indexOf("BT") < 0) continue
    pdfShownText(s, out)
  }
  return out.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[e] ?? e
  })
}

// ---- tar / gz ----------------------------------------------------------------

function tarList(buf) {
  const names = []
  for (let p = 0; p + 512 <= buf.length && names.length < 2000;) {
    const name = buf.subarray(p, p + 100).toString("utf8").replace(/\0.*$/s, "")
    if (!name) break
    const size = parseInt(buf.subarray(p + 124, p + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8) || 0
    names.push(`${name}  (${size} bytes)`)
    p += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

// ---- the one entry point -------------------------------------------------------

/**
 * Describe a saved file for a model.
 * @param abs       absolute path of the saved file
 * @param provider  the model that will read it (decides image parts)
 * @returns {{ name, bytes, mime, kind, text: string|null, truncated: boolean,
 *             imagePart: object|null, note: string|null }}
 */
export function describeFile(abs, { name = path.basename(abs), provider = null, maxChars = MAX_TEXT_CHARS } = {}) {
  const ext = extOf(name)
  let bytes = 0
  try { bytes = fs.statSync(abs).size } catch { return { name, bytes: 0, mime: mimeFor(name), kind: "missing", text: null, truncated: false, imagePart: null, note: "the file is gone" } }
  const base = { name, bytes, mime: mimeFor(name), kind: "binary", text: null, truncated: false, imagePart: null, note: null }
  const withText = (kind, text, note = null) => {
    const t = String(text ?? "").trim()
    if (!t) return { ...base, kind, note: note ?? "no text could be read from it" }
    const c = cap(t, maxChars)
    return { ...base, kind, text: c.text, truncated: c.truncated, note }
  }

  // images: an image part for a model that can see; a description otherwise
  if (/^(png|jpe?g|gif|webp)$/.test(ext)) {
    const img = loadLocalImage(abs)
    if (img.ok) {
      const dims = img.width && img.height ? `${img.width}×${img.height}` : null
      const desc = ["image", img.kind, dims].filter(Boolean).join(" ")
      if (img.tooBig) return { ...base, kind: "image", mime: img.mime, note: `${desc} — too large to send to the model (limit ${Math.round(768)} KB)` }
      if (provider && !providerSupportsVision(provider)) return { ...base, kind: "image", mime: img.mime, note: `${desc} — ${provider.model ?? "this model"} cannot see images` }
      return { ...base, kind: "image", mime: img.mime, imagePart: openaiImagePart(img), note: desc }
    }
  }
  if (ext === "svg") {
    const buf = fs.readFileSync(abs)
    return withText("code", buf.toString("utf8"), "SVG is read as text (it is XML)")
  }

  let buf
  try { buf = fs.readFileSync(abs) } catch (e) { return { ...base, note: `could not read it: ${e?.code ?? e?.message ?? e}` } }

  if (ext === "pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    const t = pdftotext(abs) ?? pdfTextBuiltin(buf)
    return withText("pdf", t, String(t ?? "").trim() ? null : "this PDF has no text layer (a scan?) — its text could not be read")
  }
  if (["docx", "pptx", "xlsx", "odt", "odp", "ods", "zip", "jar", "epub"].includes(ext) || (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
    const doc = readZipDoc(buf, ext)
    if (doc) return withText(doc.kind, doc.text)
  }
  if (ext === "tar") return withText("archive", `${tarList(buf).length} file(s):\n${tarList(buf).join("\n")}`)
  if (ext === "gz" || ext === "tgz") {
    try {
      const inner = loadBuiltin("zlib").gunzipSync(buf, { maxOutputLength: MAX_ENTRY_BYTES })
      if (ext === "tgz" || /\.tar\.gz$/i.test(name)) return withText("archive", `${tarList(inner).length} file(s):\n${tarList(inner).join("\n")}`)
      if (looksLikeText(inner)) return withText("text", inner.toString("utf8"), "decompressed from gzip")
    } catch { }
    return { ...base, kind: "archive", note: "gzip data (not text)" }
  }
  if (TEXT_EXT.has(ext) || looksLikeText(buf)) {
    const code = TEXT_EXT.has(ext) && !["txt", "md", "markdown", "rst", "adoc", "log", "csv", "tsv"].includes(ext)
    return withText(code ? "code" : "text", buf.toString("utf8"))
  }
  return { ...base, note: `${base.mime} — not readable as text; the agent can open it at its saved path` }
}

/**
 * describeFile in a worker thread with a deadline and a heap limit, so a file
 * built to be slow or huge cannot stall or kill the process that asked. Any
 * failure becomes an ordinary "could not be read" description.
 */
export async function describeFileIsolated(abs, { name = path.basename(abs), provider = null, maxChars = MAX_TEXT_CHARS, timeoutMs = 30_000, heapMb = 384 } = {}) {
  // the provider object carries functions; the worker needs only what decides vision
  const prov = provider ? { name: provider.name, model: provider.model, protocol: provider.protocol, baseUrl: provider.baseUrl, vision: provider.vision } : null
  let bytes = 0
  try { bytes = fs.statSync(abs).size } catch { }
  const failed = (why) => ({ name, bytes, mime: mimeFor(name), kind: "binary", text: null, truncated: false, imagePart: null, note: why })
  let Worker
  try { ({ Worker } = loadBuiltin("worker_threads")) } catch { return describeFile(abs, { name, provider: prov, maxChars }) }
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v) }
    let w
    try {
      w = new Worker(new URL("./docextract-worker.js", import.meta.url), { workerData: { abs, opts: { name, provider: prov, maxChars } }, resourceLimits: { maxOldGenerationSizeMb: heapMb } })
    } catch (e) { return finish(failed(`could not be read: ${String(e?.message ?? e).slice(0, 120)}`)) }
    const timer = setTimeout(() => { finish(failed(`reading it took longer than ${Math.round(timeoutMs / 1000)} s — skipped`)); w.terminate().catch(() => {}) }, timeoutMs)
    w.once("message", (m) => { finish(m?.error ? failed(`could not be read: ${m.error}`) : m); w.terminate().catch(() => {}) })
    w.once("error", (e) => finish(failed(/memory|heap/i.test(String(e?.message ?? e)) ? "too large to read here — skipped" : `could not be read: ${String(e?.message ?? e).slice(0, 120)}`)))
    w.once("exit", () => finish(failed("could not be read")))
  })
}
