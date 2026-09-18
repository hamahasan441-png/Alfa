#!/usr/bin/env node
/**
 * Forge live-agent benchmark harness.
 *
 * This is deliberately honest: hidden verification is the score. If no live
 * provider is configured, the command reports NOT_RUN rather than fabricating
 * a model result. CI uses the contract tests; live runs use `forge eval` or
 * this harness with a real provider.
 */
import { loadConfig } from './config.js'
import { buildProvider } from './providers.js'
import { runAgent } from './agent.js'
import { runEval, EVAL_TASKS } from './evalbench.js'

export async function runAgentBenchmark({ tasks = EVAL_TASKS, timeoutMs = 180000 } = {}) {
  const config = loadConfig()
  const active = config?.activeProvider || process.env.FORGE_PROVIDER || ''
  const provider = buildProvider(config, active)
  if (!provider) {
    return { status: 'NOT_RUN', reason: 'no usable live provider configured', tasks: tasks.length }
  }
  const summary = await runEval({ tasks, runAgent, provider, config, timeoutMs })
  return { status: 'MEASURED', provider: `${provider.name}/${provider.model}`, ...summary }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const one = process.env.FORGE_BENCH_TASK
  const tasks = one ? EVAL_TASKS.filter(t => t.id === one) : EVAL_TASKS
  if (!tasks.length) { console.error(`unknown task: ${one}`); process.exit(2) }
  const result = await runAgentBenchmark({ tasks })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.status === 'NOT_RUN' ? 2 : (result.falseCompletions || result.errored ? 1 : 0))
}
