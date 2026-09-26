/**
 * forge — Terminal-Bench results (v149, zero dependencies)
 *
 * Terminal-Bench is scored by Harbor, its official harness, running forge
 * through integrations/harbor/forge_harbor (a Harbor "installed agent"). This
 * module does not run anything. It reads what a Harbor job left on disk and
 * reports it — because the number that matters is the one the task's own
 * tests produced, not one forge computes about itself.
 *
 *   forge tbench                 how to run Terminal-Bench on forge
 *   forge tbench report <job>    read a Harbor job directory
 *
 * Read from the PER-TRIAL files, not the job's aggregate, for two reasons:
 * the aggregate cannot say which tasks failed, and it cannot count the one
 * failure that matters most for an agent — a FALSE COMPLETION, where forge
 * reported the task done and the task's tests said otherwise. That is the
 * headline number of forge's own eval (evalbench.js); here it comes from a
 * benchmark forge does not control.
 *
 * Format checked against real jobs written by harbor 0.23.0 (see
 * tests/test-tbench-report.mjs, whose fixture is a trimmed copy of one).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The adapter's import path, as `harbor run --agent` takes it. */
export const HARBOR_AGENT = "forge_harbor.agent:ForgeAgent"

/**
 * The public registry held terminal-bench@2.0 (89 tasks) when this was
 * written; @3.0 and @4.0 returned "not found". A newer version is a flag away.
 */
export const DEFAULT_DATASET = "terminal-bench@2.0"

/** Where the adapter's Python package lives in this checkout / install. */
export function harborAdapterDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations", "harbor")
}

/** The command that runs Terminal-Bench on forge. */
export function harborCommand({ model = "anthropic/claude-opus-5", dataset = DEFAULT_DATASET, concurrent = 4 } = {}) {
  return `PYTHONPATH=${harborAdapterDir()} harbor run --dataset ${dataset} --agent ${HARBOR_AGENT} --model ${model} --n-concurrent ${concurrent}`
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
// null stays null. Number(null) is 0, and the first cut reported a job whose
// every trial had an UNKNOWN cost as "$0.00" — an unknown read as free.
const num = (x) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null)

/** One trial directory → one row. Null when the directory is not a trial. */
export function readTrial(dir) {
  const r = readJson(path.join(dir, "result.json"))
  if (!r || typeof r !== "object" || !("task_name" in r)) return null
  const reward = num(r.verifier_result?.rewards?.reward)
  const ar = r.agent_result ?? {}
  const md = ar.metadata ?? {}
  const ex = r.exception_info ?? null
  return {
    trial: r.trial_name ?? path.basename(dir),
    task: r.task_name,
    reward,
    // Terminal-Bench rewards are 0/1. A trial that never produced a reward
    // (the agent crashed, the verifier timed out) is NOT solved — an error is
    // a failed task, never one left out of the denominator.
    solved: reward !== null && reward >= 1,
    error: ex ? String(ex.exception_type ?? "error") : null,
    errorMessage: ex ? String(ex.exception_message ?? "").slice(0, 300) : null,
    forgeStatus: md.forge_status ?? null,
    forgeSteps: num(md.forge_steps),
    forgeToolCalls: num(md.forge_tool_calls),
    inputTokens: num(ar.n_input_tokens),
    outputTokens: num(ar.n_output_tokens),
    cacheTokens: num(ar.n_cache_tokens),
    costUsd: num(ar.cost_usd),
    forgeMcp: md.forge_mcp && typeof md.forge_mcp === "object" ? md.forge_mcp : null,
  }
}

/** v200: "mcp: 2 servers (1 offered nothing: github — no token), 1 skipped" — or "" when there is nothing to say. */
export function mcpTrialText(m) {
  if (!m || typeof m !== "object") return ""
  const servers = Array.isArray(m.servers) ? m.servers : []
  const skipped = Array.isArray(m.skipped) ? m.skipped : []
  if (!servers.length && !skipped.length) return ""
  const dead = servers.filter((x) => !(Number(x?.tools) > 0))
  const parts = []
  if (servers.length) parts.push(`${servers.length} server${servers.length === 1 ? "" : "s"}${dead.length ? ` (${dead.length} offered nothing: ${dead.slice(0, 2).map((x) => `${x.name}${x.error ? ` — ${String(x.error).slice(0, 60)}` : ""}`).join("; ")})` : ""}`)
  if (skipped.length) parts.push(`${skipped.length} skipped (${skipped.slice(0, 2).map((x) => `${x.name}: ${String(x.reason ?? "").slice(0, 60)}`).join("; ")})`)
  return `mcp: ${parts.join(", ")}`
}

/** A whole Harbor job directory → trials plus the numbers worth reading. */
export function readHarborJob(dir) {
  const abs = path.resolve(dir)
  const config = readJson(path.join(abs, "config.json"))
  const job = readJson(path.join(abs, "result.json"))
  if (!config || !job) throw new Error(`${abs} is not a Harbor job directory (no config.json/result.json)`)
  const trials = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readTrial(path.join(abs, e.name)))
    .filter(Boolean)
    .sort((a, b) => a.task.localeCompare(b.task) || a.trial.localeCompare(b.trial))

  const byTask = new Map()
  for (const t of trials) byTask.set(t.task, [...(byTask.get(t.task) ?? []), t])
  const tasks = [...byTask.entries()].map(([task, ts]) => ({
    task, attempts: ts.length, solved: ts.some((t) => t.solved),
  }))
  const sum = (k) => trials.reduce((a, t) => (t[k] == null ? a : a + t[k]), 0)
  const agent = config.agents?.[0] ?? {}
  // A registry run records {name, version}; a local `-p` run records only a
  // path, under `datasets` for a directory of tasks or `tasks` for one task.
  const ds = config.datasets?.[0] ?? config.tasks?.[0] ?? null
  return {
    dir: abs,
    job: config.job_name ?? path.basename(abs),
    agent: agent.name ?? null,
    isForge: String(agent.name ?? "") === HARBOR_AGENT,
    model: agent.model_name ?? null,
    dataset: ds?.name ? `${ds.name}${ds.version ? `@${ds.version}` : ""}` : ds?.path ? `local:${ds.path}` : null,
    finished: Boolean(job.finished_at),
    trials,
    tasks,
    summary: {
      trials: trials.length,
      solvedTrials: trials.filter((t) => t.solved).length,
      // Mean reward over ALL trials, errors included as unsolved.
      meanReward: trials.length ? Math.round((trials.reduce((a, t) => a + (t.reward ?? 0), 0) / trials.length) * 1000) / 1000 : null,
      tasks: tasks.length,
      // Solved in at least one attempt: pass@k when run with -k > 1.
      tasksSolved: tasks.filter((t) => t.solved).length,
      errors: trials.filter((t) => t.error).length,
      // forge said COMPLETED; the task's own tests said no.
      // v202: COMPLETED_UNVERIFIED is still forge saying "done" — counted the same, never kinder
      falseCompletions: trials.filter((t) => (t.forgeStatus === "COMPLETED" || t.forgeStatus === "COMPLETED_UNVERIFIED") && !t.solved && !t.error).length,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheTokens: sum("cacheTokens"),
      // Unknown unless every trial knew it; a partial sum would read as a total.
      costUsd: trials.length && trials.every((t) => t.costUsd != null) ? sum("costUsd") : null,
    },
  }
}

export function formatHarborJob(r, { json = false } = {}) {
  if (json) return JSON.stringify(r, null, 1)
  const s = r.summary
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—")
  const out = []
  out.push(`TERMINAL-BENCH  ${r.dataset ?? "?"}  •  ${r.model ?? "?"}  •  job ${r.job}${r.finished ? "" : "  (NOT FINISHED — numbers are partial)"}`)
  if (!r.isForge) out.push(`agent: ${r.agent ?? "?"} — not forge's adapter; reported as-is`)
  out.push("")
  // The MOST attempts any task got, not trials/tasks: with uneven attempts
  // (one task retried, others not) the average rounded 4/3 to "any of 1".
  const maxAttempts = Math.max(1, ...r.tasks.map((t) => t.attempts))
  out.push(`tasks solved     ${s.tasksSolved}/${s.tasks}  (${pct(s.tasksSolved, s.tasks)})${maxAttempts > 1 ? `  — solved in any of up to ${maxAttempts} attempts per task` : ""}`)
  out.push(`mean reward      ${s.meanReward ?? "—"}  over ${s.trials} trial(s), errors counted as 0`)
  out.push(`errors           ${s.errors}${s.errors ? "  — the agent or harness failed to run; counted as unsolved" : ""}`)
  if (r.isForge) out.push(`false completions ${s.falseCompletions}  — forge said COMPLETED, the task's tests said no`)
  out.push(`tokens           in ${s.inputTokens.toLocaleString("en-US")} (cache read ${s.cacheTokens.toLocaleString("en-US")}) • out ${s.outputTokens.toLocaleString("en-US")}`)
  out.push(`cost             ${s.costUsd == null ? "unknown (forge carries no price table)" : `$${s.costUsd.toFixed(2)}`}`)
  out.push("")
  const w = Math.min(40, Math.max(12, ...r.trials.map((t) => t.task.length)))
  for (const t of r.trials) {
    const mark = t.error ? "ERR " : t.solved ? "PASS" : "fail"
    // v151: a trial that errored can still say how far forge got — on a
    // timeout the adapter stops forge and its final record carries the steps
    // and tokens, which used to be lost entirely.
    const reached = t.forgeStatus ? ` — forge ${t.forgeStatus}${t.forgeSteps != null ? ` after ${t.forgeSteps} steps` : ""}` : ""
    const why = t.error ? `${t.error}${t.errorMessage ? `: ${t.errorMessage.slice(0, 80)}` : ""}${reached}`
      : r.isForge ? `forge ${t.forgeStatus ?? "?"}${t.forgeSteps != null ? `, ${t.forgeSteps} steps` : ""}${(t.forgeStatus === "COMPLETED" || t.forgeStatus === "COMPLETED_UNVERIFIED") && !t.solved ? "  ← false completion" : ""}` : ""
    const mcp = mcpTrialText(t.forgeMcp)
    out.push(`  ${mark}  ${t.task.padEnd(w)}  ${why}${mcp ? `  • ${mcp}` : ""}`)
  }
  return out.join("\n")
}

export function formatHowTo() {
  return [
    "Terminal-Bench runs forge through Harbor, its official harness (Python ≥ 3.12, Docker):",
    "",
    "  uv tool install harbor        # or: pip install harbor",
    "  export ANTHROPIC_API_KEY=…    # the key for the model you are scoring",
    `  ${harborCommand()}`,
    "",
    "The adapter installs THIS forge checkout into each task container (a pinned,",
    "hash-checked Node is uploaded when the image has none — the task needs no network),",
    "runs `forge agent --headless`, and Harbor scores it with the task's own tests.",
    "",
    "Then:  forge tbench report jobs/<job-name>",
    "",
    "Every full run spends real tokens: 89 tasks × a long agent loop each. Try one first:",
    `  … --include-task-name fix-git`,
  ].join("\n")
}
