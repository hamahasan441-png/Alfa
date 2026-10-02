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
  const orchestrate = ORCHESTRATED_CLASSES.includes(c.class)
  return pick(
    orchestrate ? RUN_MODE.META : RUN_MODE.SINGLE,
    orchestrate ? `${c.class} task — orchestrator plans, splits and verifies` : `${c.class} task — single loop is enough`,
    c.class,
    false,
  )
}
