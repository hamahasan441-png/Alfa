/**
 * forge — run mode: single loop or orchestrator (zero dependencies)
 *
 * Before this module the orchestrator (core → meta controller → DAG, workers,
 * crew model routing, verification ledger) only ran when asked for by name:
 * `forge agent --auto`, `agent.autonomous: "meta"`, a resume, or a chat with
 * no terminal. Every ordinary `forge agent "task"` and every interactive chat
 * task went through the single agent loop, however big the task was.
 *
 * chooseRunMode() is the one place that decides. The rule is the one the
 * classifier was written for ("every autonomous run must pick the smallest
 * sufficient workflow"): MICRO and SMALL tasks keep the fast single loop;
 * MEDIUM, LARGE and ARCHITECTURAL tasks go to the orchestrator.
 *
 * An explicit choice always wins over the classifier, in this order:
 *   1. plan-only runs are single (plan mode is a read-only pass)
 *   2. a resume is the orchestrator (only it reconciles persisted DAG state)
 *   3. `--single` / `--auto` on the command line
 *   4. FORGE_RUN_MODE=single|meta|auto in the environment
 *   5. agent.autonomous in config: false or "single" → single, "meta" → meta
 *   6. headless runs stay single unless 1–5 said otherwise, so a benchmark
 *      harness keeps scoring the path it has always scored
 *   7. otherwise ("auto", or the legacy default `true`): the task's class
 *
 * Pure: no I/O, no imports beyond the classifier. The caller prints `why`.
 */
import { classifyTask, TASK_CLASS } from "./classify.js"

export const RUN_MODE = Object.freeze({ SINGLE: "single", META: "meta" })

/** Task classes that go to the orchestrator when nothing explicit decides. */
export const ORCHESTRATED_CLASSES = Object.freeze([TASK_CLASS.MEDIUM, TASK_CLASS.LARGE, TASK_CLASS.ARCHITECTURAL])

function fromSetting(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : v
  if (s === false || s === "single" || s === "off" || s === "false") return RUN_MODE.SINGLE
  if (s === "meta" || s === "orchestrator") return RUN_MODE.META
  return null // true, "auto", undefined, anything unknown → let the next rule decide
}

/**
 * @param {object} o
 * @param {string}  o.task
 * @param {object}  [o.config]   forge config (reads agent.autonomous)
 * @param {object}  [o.flags]    parsed CLI flags (reads auto, single)
 * @param {object}  [o.env]      environment (reads FORGE_RUN_MODE)
 * @param {boolean} [o.planOnly]
 * @param {boolean} [o.resume]
 * @param {boolean} [o.headless]
 * @returns {{ mode: "single"|"meta", why: string, class: string|null, explicit: boolean }}
 */
export function chooseRunMode({ task = "", config = {}, flags = {}, env = {}, planOnly = false, resume = false, headless = false } = {}) {
  const pick = (mode, why, klass = null, explicit = true) => ({ mode, why, class: klass, explicit })
  if (planOnly) return pick(RUN_MODE.SINGLE, "plan mode is a read-only single pass")
  if (resume) return pick(RUN_MODE.META, "resuming a task — only the orchestrator restores its plan")
  if (flags?.single === true && flags?.auto === true) return pick(RUN_MODE.META, "--auto and --single both given — --auto wins")
  if (flags?.single === true) return pick(RUN_MODE.SINGLE, "--single")
  if (flags?.auto === true) return pick(RUN_MODE.META, "--auto")
  const envMode = fromSetting(env?.FORGE_RUN_MODE)
  if (envMode) return pick(envMode, `FORGE_RUN_MODE=${env.FORGE_RUN_MODE}`)
  const cfgMode = fromSetting(config?.agent?.autonomous)
  if (cfgMode) return pick(cfgMode, `agent.autonomous = ${JSON.stringify(config.agent.autonomous)}`)
  if (headless) return pick(RUN_MODE.SINGLE, "headless runs stay on the single loop (pass --auto to orchestrate)")
  const c = classifyTask(task)
  const scope = scopeOf(task, c.class)
  const klass = scope.class
  const orchestrate = ORCHESTRATED_CLASSES.includes(klass)
  return pick(
    orchestrate ? RUN_MODE.META : RUN_MODE.SINGLE,
    orchestrate
      ? `${klass} task${scope.bumped ? ` (${scope.why})` : ""} — orchestrator plans, splits and verifies`
      : `${klass} task — single loop is enough`,
    klass,
    false,
  )
}

// Phase 3 — task sizing beyond keywords. classify.js scores words like
// "refactor" and "failing" and is frozen by its own tests; it reads "add a
// login page with tests" as SMALL. These signals only ever RAISE a SMALL
// task to MEDIUM, never lower anything, and never touch MICRO-strong text
// ("typo", "explain this"): building a feature, several deliverables in one
// request, or several files named.
const BUILD_VERB = /\b(add|build|create|implement|introduce|support|wire up|integrate)\b/i
const FEATURE_NOUN = /\b(page|screen|feature|endpoint|api|route|component|module|service|command|subcommand|integration|dashboard|form|workflow|pipeline|plugin|auth(?:entication)?|login|signup|database|migration)\b/i
const MICRO_TEXT = /\b(typo|one line|explain|what is|summari[sz]e|rename this)\b/i
const FILE_TOKEN = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:js|mjs|ts|tsx|jsx|py|go|rs|java|kt|rb|css|html|json|ya?ml|md)\b/g

export function scopeOf(task, klass) {
  const t = String(task ?? "")
  if (klass !== "SMALL" || MICRO_TEXT.test(t)) return { class: klass, bumped: false, why: null }
  const files = new Set(t.match(FILE_TOKEN) ?? [])
  const deliverables = t.split(/\b(?:and then|then|and also|also|plus)\b|[;\n]|,\s*(?=(?:add|build|create|implement|fix|update|write|remove|refactor)\b)/i).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 2)
  const feature = BUILD_VERB.test(t) && FEATURE_NOUN.test(t)
  const why = feature ? "builds a feature" : deliverables.length >= 3 ? `${deliverables.length} deliverables` : files.size >= 3 ? `${files.size} files named` : null
  return why ? { class: "MEDIUM", bumped: true, why } : { class: klass, bumped: false, why: null }
}

/**
 * Phase 1 (measurement): a runAgent-compatible runner that routes each task
 * the way `forge agent` would — so `forge eval --mode auto|meta` measures the
 * orchestrator, not only the single loop. `single` returns runAgent itself.
 *
 * The orchestrator's result is mapped onto the fields eval reads from a
 * runAgent result: status, steps, usage {promptTokens, completionTokens,
 * toolCalls}. Its `trace` is null (model-call counting is a single-loop
 * figure), and `runMode` says which path ran.
 */
export function makeModeRunner({ runAgent, mode = "single", createForgeCore } = {}) {
  if (mode === "single") return runAgent
  if (mode !== "meta" && mode !== "auto") throw new Error(`unknown eval mode "${mode}" — use single, meta or auto`)
  return async (args = {}) => {
    const { config = {}, provider, task, signal, onEvent } = args
    const rm = mode === "meta"
      ? { mode: RUN_MODE.META, why: "--mode meta" }
      : chooseRunMode({ task, config: { ...config, agent: { ...(config.agent ?? {}), autonomous: "auto" } }, env: {} })
    if (rm.mode !== RUN_MODE.META) {
      const r = await runAgent(args)
      return { ...r, runMode: RUN_MODE.SINGLE }
    }
    const core = createForgeCore({ config, provider, onEvent: onEvent ?? null, signal })
    const m = await core.run(task)
    const u = m?.task?.resource_usage ?? {}
    return {
      status: String(m?.status ?? "UNKNOWN"),
      steps: Number(m?.segments ?? 0),
      usage: { promptTokens: Number(u.tokens_in ?? 0), completionTokens: Number(u.tokens_out ?? 0), toolCalls: Number(m?.toolCalls ?? u.tool_calls ?? 0) },
      trace: null,
      text: m?.text ?? "",
      runMode: RUN_MODE.META,
    }
  }
}
