/**
 * forge — combine step (Phase 3, zero dependencies)
 *
 * Arena's orchestrator ends every delegated run with a synthesis: it
 * reconciles what the workers did into one answer. forge's controller
 * already merges worker FINDINGS into one apply list (integrate.js), but the
 * person's final answer was only the last segment's text — what the other
 * nodes did, which model did it, which acceptance criteria hold and what was
 * left unchecked never reached them.
 *
 * This module builds that final report:
 *   checkAcceptance()  each acceptance criterion of the goal contract, checked
 *                      one by one against the verification ledger — MET,
 *                      FAILED or UNCHECKED, with the evidence. Prose that names
 *                      no command, test or file stays UNCHECKED: a rule that
 *                      could misread prose must not be able to claim it.
 *   combineReport()    the deterministic "stitch": the answer, then one line
 *                      per plan node (status, role, model), changed files,
 *                      acceptance, conflicts. No model call — always works.
 *   synthesize()       optional (agent.synthesis: "model"): one read-only
 *                      model pass turns the report into a short answer. Any
 *                      failure falls back to the stitch.
 */
import fs from "node:fs"
import path from "node:path"

export const ACCEPTANCE = Object.freeze({ MET: "MET", FAILED: "FAILED", UNCHECKED: "UNCHECKED" })

const RUNNER_RE = /\b(?:npm (?:run )?test|npm run [\w:-]+|yarn (?:run )?[\w:-]+|pnpm (?:run )?[\w:-]+|npx [\w@/.-]+(?: [\w./-]+)*|node --test|pytest(?: [\w./:-]+)*|python -m [\w.]+(?: [\w./-]+)*|go test(?: [\w./-]+)*|cargo (?:test|build|check|clippy)|make (?:test|check|build|lint|all)|gradle(?:w)? [\w:-]+|mvn [\w:-]+|tsc(?: --noEmit)?|eslint(?: [\w./-]+)*)\b/g
const PATH_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|md|json|ya?ml|sh|toml|css|html))\b/g
const TESTS_PASS_RE = /\b(?:all )?tests? (?:should |must )?(?:pass|passes|passing|green|stay green)\b|\btest suite (?:passes|is green)\b/i

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase()

/** Commands a criterion names: backticked spans first, then known runners. */
export function commandsIn(text) {
  const out = new Set()
  for (const m of String(text ?? "").matchAll(/`([^`]{2,160})`/g)) if (/\s|^(?:make|tsc|pytest)$/.test(m[1]) && !/\.\w{1,5}$/.test(m[1].trim())) out.add(m[1].trim())
  for (const m of String(text ?? "").matchAll(RUNNER_RE)) out.add(m[0].trim())
  return [...out]
}

export function pathsIn(text) {
  const out = new Set()
  for (const m of String(text ?? "").matchAll(PATH_RE)) out.add(m[1])
  return [...out]
}

/** The latest ledger record whose command contains `cmd` (normalized). */
function latestFor(records, cmd) {
  const want = norm(cmd)
  let hit = null
  for (const r of records) if (r && r.command && norm(r.command).includes(want) && !r.invalidated) hit = r
  return hit
}

/**
 * @param {object} o
 * @param {string[]} o.acceptance     goal contract acceptance sentences
 * @param {object[]} o.records        verification ledger records (in order)
 * @param {string[]} [o.changedFiles] files the run changed (relative or absolute)
 * @param {string}   [o.cwd]
 * @returns {{ criterion, status, evidence }[]}
 */
export function checkAcceptance({ acceptance = [], records = [], changedFiles = [], cwd = process.cwd() } = {}) {
  const changed = new Set(changedFiles.map((f) => path.relative(cwd, path.resolve(cwd, f))))
  return acceptance.map((criterion) => {
    const cmds = commandsIn(criterion)
    if (cmds.length) {
      const rows = cmds.map((c) => ({ c, r: latestFor(records, c) }))
      const failed = rows.find((x) => x.r && !x.r.passed)
      if (failed) return { criterion, status: ACCEPTANCE.FAILED, evidence: `\`${failed.c}\` failed (exit ${failed.r.exitCode ?? "?"})` }
      const missing = rows.filter((x) => !x.r)
      if (missing.length) return { criterion, status: ACCEPTANCE.UNCHECKED, evidence: `\`${missing[0].c}\` was never run` }
      return { criterion, status: ACCEPTANCE.MET, evidence: rows.map((x) => `\`${x.c}\` passed`).join(", ") }
    }
    if (TESTS_PASS_RE.test(criterion)) {
      const tests = records.filter((r) => r && !r.invalidated && /test/.test(String(r.type ?? "")))
      const last = tests[tests.length - 1]
      if (!last) return { criterion, status: ACCEPTANCE.UNCHECKED, evidence: "no test run was recorded" }
      return last.passed
        ? { criterion, status: ACCEPTANCE.MET, evidence: `\`${String(last.command ?? last.type).slice(0, 80)}\` passed` }
        : { criterion, status: ACCEPTANCE.FAILED, evidence: `\`${String(last.command ?? last.type).slice(0, 80)}\` failed` }
    }
    const files = pathsIn(criterion)
    if (files.length) {
      const touched = files.filter((f) => changed.has(f) || [...changed].some((c) => c.endsWith(`/${f}`)))
      const exists = files.filter((f) => fs.existsSync(path.resolve(cwd, f)))
      return { criterion, status: ACCEPTANCE.UNCHECKED, evidence: `names ${files.join(", ")} — ${touched.length ? `changed: ${touched.join(", ")}` : "not changed by this run"}${exists.length < files.length ? `; missing: ${files.filter((f) => !exists.includes(f)).join(", ")}` : ""} (a file is not proof of the behaviour)` }
    }
    return { criterion, status: ACCEPTANCE.UNCHECKED, evidence: "prose — no command, test or file to check it against" }
  })
}

/**
 * The deterministic final report. `nodes`: [{ id, title, status, role, model }].
 * Only adds sections that have content; a one-node run with nothing else to
 * say returns the answer unchanged.
 */
export function combineReport({ answer = "", nodes = [], changedFiles = [], acceptance = [], conflicts = [], cwd = process.cwd() } = {}) {
  const parts = []
  const a = String(answer ?? "").trim()
  if (a) parts.push(a)
  const multi = nodes.length >= 2
  if (multi) {
    const done = nodes.filter((n) => /^completed$/i.test(n.status ?? "")).length
    const lines = nodes.map((n) => `- ${statusMark(n.status)} **${String(n.title || n.id).slice(0, 90)}**${n.role ? ` · ${n.role}` : ""}${n.model ? ` · ${n.model}` : ""}${/^completed$/i.test(n.status ?? "") ? "" : ` · ${String(n.status ?? "?").toLowerCase()}`}`)
    parts.push(`**Plan (${done}/${nodes.length} steps completed)**\n${lines.join("\n")}`)
  }
  if (multi && changedFiles.length) {
    const rel = changedFiles.map((f) => path.relative(cwd, path.resolve(cwd, f)) || f)
    parts.push(`**Changed files (${rel.length})**: ${rel.slice(0, 12).join(", ")}${rel.length > 12 ? `, +${rel.length - 12} more` : ""}`)
  }
  if (acceptance.length) {
    const lines = acceptance.map((x) => `- ${x.status === ACCEPTANCE.MET ? "✓" : x.status === ACCEPTANCE.FAILED ? "✗" : "?"} ${x.status}: ${String(x.criterion).slice(0, 120)} — ${x.evidence}`)
    parts.push(`**Acceptance**\n${lines.join("\n")}`)
  }
  if (conflicts.length) {
    parts.push(`**Conflicts between workers (${conflicts.length})**\n${conflicts.slice(0, 6).map((c) => `- ${c.file ?? "?"}: ${String(c.resolution ?? "later report wins").slice(0, 100)}`).join("\n")}`)
  }
  return parts.join("\n\n")
}

function statusMark(s) {
  const v = String(s ?? "").toLowerCase()
  return v === "completed" ? "✓" : v === "failed" ? "✗" : v === "skipped" ? "–" : "…"
}

/**
 * Optional model synthesis. `run(prompt)` is a read-only model pass that
 * returns { text } (the controller's own agent with no write tools).
 * Returns the synthesized answer, or null — the caller keeps the stitch.
 */
export async function synthesize({ objective = "", report = "", run } = {}) {
  if (typeof run !== "function" || !report) return null
  const prompt = [
    "Write the final answer to the person who asked for this task.",
    "Use ONLY the facts in the run report below. Do not claim anything the report does not show.",
    "Say what was done, what was verified, and what is still unchecked or failed. Be brief.",
    "", `Task: ${String(objective).slice(0, 800)}`, "", "--- run report ---", report,
  ].join("\n")
  try {
    const r = await run(prompt)
    const text = String(r?.text ?? "").trim()
    if (!text || r?.answered === false || r?.status === "ERROR") return null
    return text
  } catch { return null }
}
