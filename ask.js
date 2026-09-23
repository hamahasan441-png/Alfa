/**
 * forge — the ONE way to ask a human a question (zero dependencies)
 *
 * Before v142 "ask the user something" was implemented five times:
 *
 *   terminal.js:ask       the real one — inline in the fullscreen editor,
 *                         Ctrl-C → null, single-keypress mode, masking
 *   agentview.js:ask      term.ask when TTY, else its own readline/promises
 *   chat.js:confirmPrompt term.ask when a UI exists, else its own callback
 *                         readline — and no check that a human is there
 *   chat.js:2301          its own readline, guarded by process.stdin.isTTY
 *   forge.js:291          its own readline/promises, errors swallowed
 *
 * Five spellings of one question, and they did not agree on the case that
 * matters. Three of them build a readline on whatever stdin happens to be. On
 * a pipe that is not a fallback, it is a HANG: the interface waits for a line
 * from a stream that will never send one, and forge stops with no output and
 * no error. The others each guessed differently about what to do instead.
 *
 * So the contract here is the one thing they were missing, stated once:
 *
 *   **A question with no human to answer it returns `null` immediately.**
 *
 * `null` is "nobody was asked" and is never confusable with an answer — not
 * with `""` (someone pressed Enter) and not with `"no"`. Every caller must
 * decide what a run without a human does, and now every caller is handed the
 * same fact to decide on.
 *
 * ── Why a module-level asker ────────────────────────────────────────────────
 * The interactive surface installs itself here with `setAsker`, and code deep
 * inside a tool call reaches the human by calling `askUser`. That indirection
 * is the point: `chat.js` owns the terminal, `agent.js` does not, and an MCP
 * server asking for a value runs inside a tool inside the agent. TODO.md has
 * recorded that gap since v131 as the reason `elicitation` was never declared.
 *
 * The singleton models a real singleton — one terminal, one human — and it is
 * the only global state here. `clearAsker()` restores the default, and tests
 * do exactly that.
 *
 * ── Untrusted questions ─────────────────────────────────────────────────────
 * A question can come from an MCP server, which is neither forge nor the user.
 * `askUntrusted` is the door for those: it sanitizes the text before a byte of
 * it is printed, so a "question" carrying ANSI and a newline cannot paint a
 * second line that looks like forge's own, and it names the source, because
 * "make clear which server is requesting" is the MCP spec's own MUST.
 *
 * `askUser` deliberately does NOT sanitize — its strings are forge's, and a
 * confirmation stripped of its colour has lost the warning. Two functions
 * rather than one flag: a flag can be forgotten at one call site.
 */

/** A question is one line on someone's screen; anything longer is a payload. */
export const MAX_QUESTION = 300
/** Who is asking, shown verbatim-safe before the question. */
export const MAX_SOURCE = 60

let asker = null
let _render = null
const loadRender = async () => (_render ??= await import("./render.js"))

/**
 * Install the interactive surface's own prompt.
 *
 * `fn(promptText, opts)` resolves with the typed string, or `null` when the
 * user cancelled (Ctrl-C / Esc). Anything it throws is treated as a cancel:
 * a question that failed to reach a human did not reach a human.
 */
export function setAsker(fn) {
  asker = typeof fn === "function" ? fn : null
  return asker
}

/** Restore the default (stdio) asker. Tests call this; so does shutdown. */
export function clearAsker() {
  asker = null
}

/** True when stdin AND stdout are a terminal — the only case readline works. */
export function stdioIsInteractive() {
  return process.stdin?.isTTY === true && process.stdout?.isTTY === true
}

/**
 * Is there a human forge can reach right now?
 *
 * This is the question a CAPABILITY must be gated on. Declaring a capability
 * forge cannot honour is worse than not having it — the other side is then
 * entitled to ask, and gets silence.
 */
export function canAsk() {
  return typeof asker === "function" || stdioIsInteractive()
}

/**
 * One readline question on the given streams. The ONLY `createInterface` for
 * a question in the tree — five modules each had their own.
 *
 * It takes its streams rather than reading `process`, because `terminal.js`
 * is constructed with injectable ones and must be able to reuse this without
 * calling back into `askUser` (which would re-enter the asker it installed —
 * `term.ask` → `askUser` → `term.ask` → …). Passing streams instead of going
 * through the registry is what keeps that loop impossible.
 */
export async function readLineFrom(input, output, promptText, { mask = false } = {}) {
  const { default: rlp } = await import("node:readline/promises")
  const rl = rlp.createInterface({ input, output })
  // Masked input mutes the output stream rather than handing the terminal to
  // raw mode — the same trick onboard.js uses, for the same reason: a raw-mode
  // handoff that fails leaves the user's shell broken.
  const realWrite = typeof output?.write === "function" ? output.write.bind(output) : null
  if (mask && realWrite) {
    let shown = 0
    output.write = (chunk, ...rest) => (shown++ === 0 ? realWrite(chunk, ...rest) : true)
  }
  try {
    return String(await rl.question(promptText) ?? "").trim()
  } finally {
    if (mask && realWrite) { output.write = realWrite; realWrite("\n") }
    try { rl.close() } catch { /* a closed interface must not fail the answer */ }
  }
}

/**
 * Ask the human one question, in forge's OWN words.
 *
 * The prompt is printed as given, styling included — these strings are
 * forge's, and a confirmation that loses its colour loses the warning. Text
 * forge did not write goes through `askUntrusted` instead; see there for why
 * that is a separate function and not a `trusted: false` option.
 *
 * @returns {Promise<string|null>} the trimmed answer, or `null` when there is
 *   no human to ask or the user cancelled. Never throws.
 */
export async function askUser(promptText, { mask = false } = {}) {
  const prompt = String(promptText ?? "")
  if (!prompt.trim()) return null
  if (typeof asker === "function") {
    try {
      const a = await asker(prompt, { mask })
      return a === null || a === undefined ? null : String(a).trim()
    } catch {
      // The surface failed mid-question. That is a cancel, not an answer.
      return null
    }
  }
  if (!stdioIsInteractive()) return null
  try { return await readLineFrom(process.stdin, process.stdout, prompt, { mask }) } catch { return null }
}

/**
 * Ask on behalf of something that is NOT forge — an MCP server, a plugin.
 *
 * Two things happen here that must never be optional, which is exactly why
 * this is a function and not a flag on `askUser`: a flag can be forgotten at
 * one call site, a function cannot be reached without them.
 *
 *   1. The question is sanitized. Untrusted text with ANSI and a newline in
 *      it can otherwise paint a second line that looks like forge's own, and
 *      ask the user for something forge never asked for.
 *   2. `source` is printed. "Make clear which server is requesting" is the
 *      MCP spec's own MUST, and it is the only thing standing between a
 *      helpful prompt and a convincing one.
 */
export async function askUntrusted(question, { source = "", mask = false } = {}) {
  // render.js is loaded HERE, not at module scope: mcp.js imports ask.js on
  // the agent's boot path, and a static edge to render.js put its Unicode
  // width tables on that path for every run — measured at ~3ms on a graph
  // that is already over its budget. An untrusted question is rare; the boot
  // is every time. Same shape as osc.js in v140, memoized the same way.
  const { terminalSafe } = await loadRender()
  const q = terminalSafe(question, MAX_QUESTION)
  if (!q) return null
  const who = terminalSafe(source, MAX_SOURCE)
  return askUser(`${who || "an external tool"} asks: ${q} `, { mask })
}

/**
 * Ask a yes/no question.
 *
 * `dflt` is what a bare Enter means AND what no-human means, so a caller
 * states its unattended policy in one place instead of re-deriving it. It
 * defaults to `false`, because the questions forge asks are "may I do the
 * risky thing?" and the safe unattended answer to that is no.
 */
export async function confirmUser(question, { dflt = false } = {}) {
  const a = await askUser(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)
  if (a === null || !a) return dflt
  if (/^y(es)?$/i.test(a)) return true
  if (/^n(o)?$/i.test(a)) return false
  return dflt
}

/**
 * Ask the human to pick one of `choices`.
 *
 * Returns the chosen VALUE, or `null` when nobody was asked. An answer that
 * matches no choice is not silently coerced to the first one — it re-asks
 * once, then gives up, because a wrong pick here can be a wrong action.
 */
export async function askChoice(question, choices, { dflt = null } = {}) {
  const list = (Array.isArray(choices) ? choices : []).map((c) => String(c ?? "")).filter(Boolean)
  if (!list.length) return null
  const menu = list.map((c, i) => `${i + 1}) ${c}`).join("  ")
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await askUser(`${question} ${menu} `)
    if (a === null) return null
    if (!a) return dflt
    const n = Number.parseInt(a, 10)
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1]
    const hit = list.find((c) => c.toLowerCase() === a.toLowerCase())
    if (hit) return hit
  }
  return dflt
}
