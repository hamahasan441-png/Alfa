/**
 * forge — ONE entry point for running a task (Phase 4, zero dependencies)
 *
 * Before this module, "how does a task run?" was answered in four places,
 * each with its own copy of the rule and of the result adapter:
 *   forge.js `agent`   chose single loop vs controller, built the core,
 *                      adapted the controller's result
 *   chat.js            the same, with a different rule (piped vs TTY)
 *   runmode.js         makeModeRunner, for `forge eval --mode`
 *   forge.js `tasks`   --resume, its own core + adapter
 *
 * runTask() is now the single path: choose the mode (runmode.chooseRunMode,
 * unless the caller already decided), run it, and return ONE result shape —
 * the agent-result shape every renderer already reads (text, steps,
 * toolLog, wrote, status …) plus the controller's fields when it ran
 * (taskStatus, taskId, segments, repairs, verification).
 *
 * The two engines themselves (agent.js single loop, meta.js controller) are
 * unchanged here; this is the seam the rest of the "one brain" merge
 * (ARCHITECTURE.md) goes through.
 */
import { chooseRunMode, RUN_MODE } from "./runmode.js"

/** The controller's result in the agent-result shape. Pure. */
export function adaptMetaResult(m) {
  const status = String(m?.status ?? "UNKNOWN")
  const u = m?.task?.resource_usage ?? {}
  const res = {
    text: m?.text || `Task ${status.toLowerCase()}.`,
    steps: m?.segments ?? 0,
    toolLog: [],
    runId: m?.task?.run_id || null,
    wrote: (m?.filesChanged || []).length > 0,
    taskStatus: status,
    taskId: m?.taskId ?? null,
    segments: m?.segments ?? 0,
    repairs: m?.repairs ?? 0,
    toolCallsTotal: m?.toolCalls ?? 0,
    verification: m?.verification ?? null,
    usage: { promptTokens: Number(u.tokens_in ?? 0), completionTokens: Number(u.tokens_out ?? 0), toolCalls: Number(m?.toolCalls ?? u.tool_calls ?? 0) },
    runMode: RUN_MODE.META,
  }
  if (status === "WAITING") res.waiting = true
  return res
}

/**
 * @param {object}   o
 * @param {string}   o.task
 * @param {object}   o.config
 * @param {object}   o.provider
 * @param {Function} o.runAgent            agent.js runAgent
 * @param {Function} o.createForgeCore     core.js createForgeCore
 * @param {string}   [o.mode]              "single" | "meta" — skip the chooser
 * @param {object}   [o.flags] [o.env] [o.planOnly] [o.headless]   chooser inputs
 * @param {string}   [o.resumeTaskId]      resume always runs on the controller
 * @param {Function} [o.onEvent] [o.signal] [o.deep]
 * @param {object}   [o.agentOpts]         extra runAgent options (single loop)
 * @param {object}   [o.coreOpts]          extra core.run options (controller)
 * @returns {Promise<{ mode, why, class, res, meta }>}  meta = raw controller result
 */
export async function runTask({ task, config = {}, provider, runAgent, createForgeCore, mode = null, flags = {}, env = process.env, planOnly = false, headless = false, resumeTaskId = null, onEvent = null, signal = null, deep, agentOpts = {}, coreOpts = {} } = {}) {
  const decided = mode
    ? { mode, why: "decided by the caller", class: null }
    : chooseRunMode({ task, config, flags, env, planOnly, resume: resumeTaskId != null, headless })
  if (decided.mode === RUN_MODE.META) {
    if (typeof createForgeCore !== "function") throw new Error("runTask: the controller was chosen but no createForgeCore was given")
    const core = createForgeCore({ config, provider, onEvent, signal })
    const m = await core.run(task, { deep, resumeTaskId, ...coreOpts })
    return { mode: RUN_MODE.META, why: decided.why, class: decided.class ?? null, res: adaptMetaResult(m), meta: m }
  }
  if (typeof runAgent !== "function") throw new Error("runTask: the single loop was chosen but no runAgent was given")
  const r = await runAgent({ config, provider, task, onEvent, deep, signal, planOnly, ...agentOpts })
  return { mode: RUN_MODE.SINGLE, why: decided.why, class: decided.class ?? null, res: { ...r, runMode: RUN_MODE.SINGLE }, meta: null }
}

/**
 * `forge eval --mode single|meta|auto`: a runAgent-compatible runner that
 * routes each task through runTask. `single` returns runAgent itself, so an
 * eval in single mode is byte-for-byte the eval it always was.
 */
export function makeModeRunner({ runAgent, mode = "single", createForgeCore } = {}) {
  if (mode === "single") return runAgent
  if (mode !== "meta" && mode !== "auto") throw new Error(`unknown eval mode "${mode}" — use single, meta or auto`)
  return async (args = {}) => {
    const { config = {}, provider, task, signal, onEvent } = args
    // auto routes by the task alone: an eval config's autonomous:false must
    // not silently turn "measure the orchestrator" into "measure the loop"
    const forced = mode === "meta" ? RUN_MODE.META : chooseRunMode({ task, config: { ...config, agent: { ...(config.agent ?? {}), autonomous: "auto" } }, env: {} }).mode
    if (forced !== RUN_MODE.META) {
      const r = await runAgent(args)
      return { ...r, runMode: RUN_MODE.SINGLE }
    }
    const out = await runTask({ task, config, provider, createForgeCore, mode: RUN_MODE.META, onEvent: onEvent ?? null, signal })
    return { ...out.res, status: out.res.taskStatus, trace: null }
  }
}
