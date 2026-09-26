import { VERSION } from "./version.js"
import { MODEL_CAPABILITY_REGISTRY, lookupRegistry } from "./modelregistry.js"
import { toAnthropicContent } from "./vision.js"
import crypto from "node:crypto"
import { sleepAbortable } from "./retry-policy.js"
import { rateLimitKey, storedRateLimit, storeRateLimit, forgetRateLimit } from "./ratelimits.js"
import { readModelCache, writeModelCache, rankForAgent } from "./modelcache.js"
/**
 * forge — provider catalog + direct HTTP clients (zero dependencies)
 *
 * Two wire protocols:
 *   "openai"    POST {baseUrl}/chat/completions  (Bearer)     — 22 providers
 *   "anthropic" POST {baseUrl}/v1/messages       (x-api-key)  — anthropic
 *
 * streamChat()          → SSE streaming: text / reasoning / tool_calls / usage / done events
 * streamChatResilient() → streamChat + transient retry (429/5xx/network) with backoff
 * chatOnce()            → non-streaming with tool-calls (agent mode), both protocols
 * probe()               → connectivity + latency probe (forge doctor)
 */
export const CATALOG = [
  { name: "openai",        label: "OpenAI",                   protocol: "openai",    baseUrl: "https://api.openai.com/v1",                               envKey: "OPENAI_API_KEY",     needsKey: true,  models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"], contextWindow: 128000,  keyUrl: "https://platform.openai.com/api-keys" },
  { name: "anthropic",     label: "Anthropic Claude",         protocol: "anthropic", baseUrl: "https://api.anthropic.com",                               envKey: "ANTHROPIC_API_KEY",  needsKey: true,  models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"], contextWindow: 200000, keyUrl: "https://console.anthropic.com/settings/keys" },
  { name: "zai",           label: "Z.ai (GLM)",               protocol: "openai",    baseUrl: "https://api.z.ai/api/paas/v4",                            envKey: "ZAI_API_KEY",        needsKey: true,  models: ["glm-5.3-flash", "glm-5.2", "glm-4.6"], contextWindow: 1048576, keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  { name: "deepseek",      label: "DeepSeek",                 protocol: "openai",    baseUrl: "https://api.deepseek.com/v1",                             envKey: "DEEPSEEK_API_KEY",   needsKey: true,  models: ["deepseek-chat", "deepseek-reasoner"], contextWindow: 1000000, keyUrl: "https://platform.deepseek.com/api_keys" },
  { name: "groq",          label: "Groq (fastest)",           protocol: "openai",    baseUrl: "https://api.groq.com/openai/v1",                          envKey: "GROQ_API_KEY",       needsKey: true,  models: ["llama-3.3-70b-versatile", "llama-4-scout", "gpt-oss-120b", "llama-3.1-8b-instant"], contextWindow: 128000, keyUrl: "https://console.groq.com/keys" },
  { name: "openrouter",    label: "OpenRouter (400+ models)", protocol: "openai",    baseUrl: "https://openrouter.ai/api/v1",                            envKey: "OPENROUTER_API_KEY", needsKey: true,  models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"], contextWindow: 128000, keyUrl: "https://openrouter.ai/keys" },
  { name: "gemini",        label: "Google Gemini",            protocol: "openai",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY",     needsKey: true,  models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"], contextWindow: 1048576, keyUrl: "https://aistudio.google.com/apikey" },
  { name: "mistral",       label: "Mistral",                  protocol: "openai",    baseUrl: "https://api.mistral.ai/v1",                               envKey: "MISTRAL_API_KEY",    needsKey: true,  models: ["mistral-large-latest", "mistral-small-latest"], contextWindow: 256000, keyUrl: "https://console.mistral.ai/api-keys" },
  { name: "xai",           label: "xAI Grok",                 protocol: "openai",    baseUrl: "https://api.x.ai/v1",                                     envKey: "XAI_API_KEY",        needsKey: true,  models: ["grok-4.6", "grok-4.5", "grok-3-mini"], contextWindow: 500000, keyUrl: "https://console.x.ai" },
  { name: "together",      label: "Together AI",              protocol: "openai",    baseUrl: "https://api.together.xyz/v1",                             envKey: "TOGETHER_API_KEY",   needsKey: true,  models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"], contextWindow: 128000, keyUrl: "https://api.together.ai/settings/api-keys" },
  { name: "cerebras",      label: "Cerebras",                 protocol: "openai",    baseUrl: "https://api.cerebras.ai/v1",                              envKey: "CEREBRAS_API_KEY",   needsKey: true,  models: ["gpt-oss-120b", "zai-glm-4.7"], contextWindow: 131072, keyUrl: "https://cloud.cerebras.ai" },
  { name: "nvidia",        label: "NVIDIA NIM",               protocol: "openai",    baseUrl: "https://integrate.api.nvidia.com/v1",                     envKey: "NVIDIA_API_KEY",     needsKey: true,  models: ["meta/llama-3.3-70b-instruct"], contextWindow: 128000, keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { name: "siliconflow",   label: "SiliconFlow",              protocol: "openai",    baseUrl: "https://api.siliconflow.cn/v1",                           envKey: "SILICONFLOW_API_KEY", needsKey: true, models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.5-397B-A17B"], contextWindow: 128000, keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  { name: "qwen",          label: "Qwen (DashScope)",         protocol: "openai",    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",       envKey: "QWEN_API_KEY",       needsKey: true,  models: ["qwen3-max", "qwen-plus"], contextWindow: 131072, keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  { name: "github-models", label: "GitHub Models",            protocol: "openai",    baseUrl: "https://models.github.ai/inference",                      envKey: "GITHUB_TOKEN",       needsKey: true,  models: ["openai/gpt-4o", "openai/gpt-4o-mini"], contextWindow: 128000, keyUrl: "https://github.com/settings/tokens" },
  { name: "huggingface",   label: "Hugging Face",             protocol: "openai",    baseUrl: "https://router.huggingface.co/v1",                        envKey: "HF_TOKEN",           needsKey: true,  models: ["meta-llama/Llama-3.3-70B-Instruct"], contextWindow: 128000, keyUrl: "https://huggingface.co/settings/tokens" },
  { name: "ollama",        label: "Ollama (local, no key)",   protocol: "openai",    baseUrl: "http://localhost:11434/v1",                               envKey: "",                   needsKey: false, models: ["llama3.2", "qwen2.5-coder"], contextWindow: 128000, keyUrl: "" },
  { name: "custom",        label: "Custom OpenAI-compatible", protocol: "openai",    baseUrl: "",                                                        envKey: "CUSTOM_API_KEY",     needsKey: true,  models: [], contextWindow: 128000, keyUrl: "" },
  { name: "apinex",        label: "APInex (all models)",      protocol: "openai",    baseUrl: "https://api.apinex.bond/v1",                             envKey: "APINEX_API_KEY",     needsKey: true,  models: ["gpt-5.6-luna", "grok-4.6", "claude-sonnet-5", "free/gemini-3.8-flash"], contextWindow: 1048576, keyUrl: "https://apinex.bond" },
  // v86: two more OpenAI-compatible routers, verified against their own docs.
  // GonkaRouter — base_url https://api.gonkarouter.io/v1, Bearer key, keys at
  // the dashboard (gonkarouter.io). UnoRouter — base_url
  // https://api.unorouter.com/v1, Bearer key, automatic upstream failover.
  { name: "gonkarouter",   label: "GonkaRouter (Gonka Network)", protocol: "openai", baseUrl: "https://api.gonkarouter.io/v1",                          envKey: "GONKAROUTER_API_KEY", needsKey: true, models: ["deepseek-ai/DeepSeek-V4-Flash-0731", "moonshotai/Kimi-K2.6"], contextWindow: 1000000, keyUrl: "https://gonkarouter.io/dashboard" },
  { name: "unorouter",     label: "UnoRouter (300+ models)",  protocol: "openai",    baseUrl: "https://api.unorouter.com/v1",                           envKey: "UNOROUTER_API_KEY",  needsKey: true,  models: ["claude-sonnet-5", "deepseek-chat", "gemini-3.5-flash"], contextWindow: 128000, keyUrl: "https://unorouter.com" },
  // v94b: TokenRouter — one OpenAI-compatible /v1 gateway, one API key, 300+
  // upstream models (verified live: GET /v1/models → 401 "Token not provided"
  // without a Bearer key; Bearer auth; served at api.tokenrouter.com). The
  // documented free tier exposes DeepSeek / Qwen / NVIDIA models — those are
  // the catalog defaults; `listModels()` still returns the LIVE /v1/models
  // list once TOKENROUTER_API_KEY is set, so defaults are only fallbacks.
  { name: "tokenrouter",   label: "TokenRouter (300+ models)", protocol: "openai",    baseUrl: "https://api.tokenrouter.com/v1",                         envKey: "TOKENROUTER_API_KEY", needsKey: true, models: ["deepseek-chat", "deepseek-reasoner", "qwen-plus", "meta/llama-3.3-70b-instruct"], contextWindow: 128000, keyUrl: "https://www.tokenrouter.com" },
  // v145: SeekAI — an OpenAI-compatible relay, VERIFIED LIVE rather than from
  // the request that asked for it:
  //   GET  https://seekai.cc/v1/models            → 401 {"error":{"message":
  //        "Invalid token …","type":"new_api_error"}}
  //   POST https://seekai.cc/v1/chat/completions  → the same 401
  //   Authorization: Bearer <token> is the auth path (a dummy Bearer is read
  //        as a token and rejected as invalid, not as a missing header)
  //   https://seekai.cc/ serves <title>New API</title>
  // So this is a New API gateway: standard /v1 surface, Bearer auth, and a
  // live /v1/models list — which is why the models below are only fallbacks.
  // `listModels()` returns what the account can actually reach once
  // SEEKAI_API_KEY is set.
  //
  // contextWindow is the CONSERVATIVE relay default, as with unorouter and
  // tokenrouter. A relay fronts many upstreams and forge cannot know which
  // one a given key reaches; overstating it would have forge pack a prompt
  // the upstream then refuses.
  { name: "seekai",        label: "SeekAI (OpenAI-compatible)", protocol: "openai",   baseUrl: "https://seekai.cc/v1",                                   envKey: "SEEKAI_API_KEY",     needsKey: true,  models: ["deepseek-ai/DeepSeek-V4-Flash-0731"], contextWindow: 128000, keyUrl: "https://seekai.cc/console/token" },
]

export function getCatalog(name) {
  return CATALOG.find((p) => p.name === name) || null
}

export function envKeyFor(name) {
  const c = getCatalog(name)
  if (!c || !c.envKey) return null
  return process.env[c.envKey] || null
}

/**
 * Build a runnable provider object from config + catalog for a given name,
 * WITHOUT any CLI flags (used for failover, where the target is not the one the
 * user named on the command line). Returns null when the provider is not usable
 * (no base URL, or a key is required but missing). Mirrors resolveProvider() in
 * forge.js minus the flag overrides.
 */
export function buildProvider(config, name) {
  if (!name) return null
  const cat = getCatalog(name)
  const conf = config?.providers?.[name] || null
  if (!cat && !conf) return null
  const c = conf || {}
  const protocol = cat?.protocol ?? c.protocol ?? "openai"
  const baseUrl = c.baseUrl || cat?.baseUrl || ""
  const apiKey = c.apiKey || envKeyFor(name) || ""
  const model = c.model || cat?.models?.[0] || ""
  if (!baseUrl) return null
  if (!apiKey && name !== "ollama") return null
  return {
    name, label: cat?.label ?? name, protocol, baseUrl, apiKey, model,
    contextWindow: c.contextWindow ?? lookupRegistry(model)?.contextWindow ?? cat?.contextWindow ?? 128000, keyUrl: cat?.keyUrl ?? "",
    configuredContextWindow: c.contextWindow ?? null, // v21.1: what the USER declared (null = derived)
  }
}

/**
 * Whether a provider error should trigger failover to another provider:
 * a transient error (429/408/5xx/network — but NOT a context-overflow, which is
 * handled by compaction) or a hard auth/not-found (401/403/404). Shared by the
 * agent loop and the interactive chat loop so both classify failures alike.
 */
export function isFailoverWorthy(e) {
  // v165: 402 — this provider's balance is spent; a tested fallback's is not
  return e instanceof ProviderError && !e.contextOverflow &&
    (e.retryable || e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404)
}

/**
 * Ordered list of usable fallback providers (excluding `activeName`), for
 * automatic failover. v86 "auto strategy": any CATALOG provider whose API key
 * is in the environment AND whose health probe came back green joins the chain
 * automatically — zero-config failover, but never a blind switch: an env key
 * alone (CI often sets GITHUB_TOKEN for git auth!) is not consent to send your
 * conversation there. Run `forge provider test` / `forge doctor --all` once;
 * after that the provider is a first-class fallback. Tested providers come
 * first (fastest probed latency first), then the rest in config order.
 */
export function fallbackChain(config, activeName, { health = {} } = {}) {
  const names = [...Object.keys(config?.providers || {})]
  // v86: env-keyed catalog providers join once they have a green probe
  for (const c of CATALOG) {
    if (c.envKey && process.env[c.envKey] && health[c.name]?.ok && !names.includes(c.name)) names.push(c.name)
  }
  const built = []
  const seen = new Set()
  for (const n of names) {
    if (seen.has(n)) continue
    if (n === activeName) continue
    const p = buildProvider(config, n)
    if (p) { built.push(p); seen.add(n) }
  }
  // stable partition: tested-ok providers first, fastest first; the rest keep
  // config order
  const tested = built
    .filter((p) => health[p.name]?.ok)
    .sort((a, b) => (health[a.name]?.ms ?? Infinity) - (health[b.name]?.ms ?? Infinity))
  const rest = built.filter((p) => !health[p.name]?.ok)
  return [...tested, ...rest]
}

/**
 * v21.1 P1 — is `candidate` able to take over the CURRENT request?
 * Failover used to switch to whatever provider came next in config order. A
 * request in flight has hard requirements: the conversation must fit the
 * model's context window, and if the run uses tools the target protocol must
 * support tool calls. Switching to an incompatible model does not "fail
 * over", it fails differently — with a context-overflow or a model that
 * silently ignores tools and answers in prose. Returns { ok, reason }.
 *
 * @param need { promptTokens, tools, capabilities? } — what the request needs
 * @param registry optional model→{capabilities,contextWindow} map (modelstrategy)
 */
export function providerCompatible(candidate, need = {}, { registry = MODEL_CAPABILITY_REGISTRY } = {}) {
  if (!candidate) return { ok: false, reason: "no provider" }
  const reg = registry ? (registry[candidate.model] ?? registry[String(candidate.model ?? "").split("/").pop()] ?? null) : null
  // an explicit per-provider window (user config) wins over the registry —
  // self-hosted / proxied deployments often serve a model with a different
  // window than the vendor default; the registry fills in what the config omits.
  const window = candidate.configuredContextWindow ?? reg?.contextWindow ?? candidate.contextWindow ?? 128000
  const promptTokens = Number(need.promptTokens ?? 0)
  // leave headroom for the reply: ≥ 12.5 % of the window or 2k tokens
  const headroom = Math.max(2048, Math.floor(window / 8))
  if (promptTokens && promptTokens + headroom > window) {
    return { ok: false, reason: `context ${promptTokens} tokens does not fit ${candidate.name}/${candidate.model} (window ${window})` }
  }
  if (need.tools && !["openai", "anthropic"].includes(candidate.protocol)) {
    return { ok: false, reason: `${candidate.name} (${candidate.protocol}) cannot carry tool calls` }
  }
  if (Array.isArray(need.capabilities) && need.capabilities.length && reg?.capabilities) {
    const missing = need.capabilities.filter((c) => !reg.capabilities.includes(c))
    if (missing.length) return { ok: false, reason: `${candidate.name}/${candidate.model} lacks required capability ${missing.join(", ")}` }
  }
  return { ok: true, reason: null }
}

/**
 * Pick the first compatible fallback from `chain` starting at `fromIdx`.
 * Returns { next, idx, skipped:[{name,model,reason}] } — `next` is null when
 * NO remaining provider is compatible (the caller must stop, not guess).
 */
export function nextCompatibleFallback(chain, fromIdx, need, opts = {}) {
  const skipped = []
  for (let i = fromIdx; i < chain.length; i++) {
    const c = providerCompatible(chain[i], need, opts)
    if (c.ok) return { next: chain[i], idx: i + 1, skipped }
    skipped.push({ name: chain[i].name, model: chain[i].model, reason: c.reason })
  }
  return { next: null, idx: chain.length, skipped }
}

export class ProviderError extends Error {
  constructor(message, { status, retryable, contextOverflow, retryAfterMs, kind, affordableTokens, rateLimit } = {}) {
    super(message)
    this.status = status
    this.contextOverflow = Boolean(contextOverflow)
    this.retryAfterMs = retryAfterMs ?? null
    this.retryable = retryable ?? (status === 429 || status === 408 || status >= 500)
    // v89: "connect" = the connect-guard expired (endpoint accepted nothing
    // for connectMs). Retrying the SAME provider then just stacks dead waits —
    // streamChatResilient short-circuits these straight to failover.
    this.kind = kind ?? null
    // v163: a 402 that names how many output tokens the account can pay for
    this.affordableTokens = affordableTokens ?? null
    // v167: a 429 that says what the limit is ("at most N requests per minute")
    this.rateLimit = rateLimit ?? null
  }
}

/** v20: recognize "context too large" rejections across providers so callers
 *  can compress and retry instead of failing the task. Checked against the
 *  error body BEFORE the ProviderError is thrown (see httpError()). */
const CONTEXT_OVERFLOW_RE = /context (?:length|window)|prompt is too long|too long|exceed(?:s|ed)?.{0,24}(?:context|token|prompt|maximum)|maximum.{0,24}(?:context|token|prompt)|token limit|reduce.{0,24}prompt|input length|input tokens?.{0,20}(?:exceed|limit|long)|context_length_exceeded|prompt_tokens.{0,30}max/i

function isContextOverflow(status, bodyText) {
  if (status !== 400 && status !== 413 && status !== 422) return false
  return CONTEXT_OVERFLOW_RE.test(String(bodyText ?? "").slice(0, 800))
}

/** Build a ProviderError from an HTTP response (shared by both protocols,
 *  streaming and non-streaming). Marks context-overflow + captures
 *  Retry-After for polite backoff. */
async function httpError(res, providerName) {
  const body = await readErrorBody(res)
  const overflow = isContextOverflow(res.status, body)
  const retryAfter = res.headers?.get?.("retry-after")
  let retryAfterMs = null
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec)) retryAfterMs = Math.min(60, Math.max(0, sec)) * 1000
    else {
      const at = Date.parse(retryAfter)
      if (!Number.isNaN(at)) retryAfterMs = Math.min(60_000, Math.max(0, at - Date.now()))
    }
  }
  const affordableTokens = res.status === 402 ? affordableFrom(body) : null
  const rateLimit = res.status === 429 ? rateLimitFrom(body) : null
  const e = new ProviderError(
    res.status === 402
      // v165: what to do comes FIRST. A reported run's card read "provider
      // HTTP 402: This request would exceed your available credits …" — the
      // provider's sentence filled the row and the fix was cut off after it.
      ? `provider HTTP 402 — ${outOfCredits(providerName, affordableTokens)}: ${body}`
      : `provider HTTP ${res.status}: ${body}${overflow ? " [context too large]" : ""}${hintFor(res.status, providerName, affordableTokens)}`,
    { status: res.status, contextOverflow: overflow, retryAfterMs, affordableTokens, rateLimit },
  )
  return e
}

/**
 * v163 — A GATEWAY THAT BILLS BY THE CEILING.
 *
 * OpenRouter-style gateways (and the New API resellers in front of them)
 * reserve credit for the request's max_tokens before running it, and on
 * the OpenAI wire forge sends none, so the model's whole output ceiling
 * is reserved. A modest balance then refuses EVERY request with
 * "402 This request requires more credits, or fewer max_tokens. You
 * requested up to 65536 tokens, but can only afford 5241", although an
 * agent step needs a few hundred. The body names the amount; forge asks
 * for that instead.
 */
export const MIN_AFFORDABLE_TOKENS = 512
const AFFORD_MARGIN = 0.9
const outputCaps = new Map() // baseUrl \n model -> the max_tokens this account could last pay for

export function affordableFrom(body) {
  const m = /can only afford\s+(\d+)/i.exec(String(body ?? ""))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) ? n : null
}

const capKey = (opts) => `${String(opts?.baseUrl ?? "").replace(/\/$/, "")}\n${opts?.model ?? ""}`

/** The request as this account can pay for it: max_tokens no higher than the last affordable amount. */
function withOutputCap(opts) {
  const cap = outputCaps.get(capKey(opts))
  if (!cap) return opts
  return { ...opts, maxTokens: Math.min(opts.maxTokens || cap, cap) }
}

/**
 * A 402 that names what the account can afford lowers the cap, once per
 * amount: true when the request is worth retrying. Too little to do useful
 * work is not retried, and the error says to top up.
 */
function lowerOutputCap(e, opts) {
  const n = e instanceof ProviderError ? e.affordableTokens : null
  if (!Number.isFinite(n)) return false
  const cap = Math.floor(n * AFFORD_MARGIN)
  if (cap < MIN_AFFORDABLE_TOKENS) return false
  const key = capKey(opts)
  const prev = outputCaps.get(key)
  if (prev && prev <= cap) return false // already asking for no more than this: retrying cannot help
  outputCaps.set(key, cap)
  try { opts?.onBudget?.({ affordable: n, maxTokens: cap, previous: prev ?? null }) } catch { /* a listener must never break the call */ }
  return true
}

/** What happened, in words: shown whenever the cap is lowered. */
export function budgetText({ affordable, maxTokens } = {}) {
  return `the provider's balance covers ${affordable} output tokens, not the model's full ceiling — asking for up to ${maxTokens} per reply and retrying`
}

/** The current cap for a provider/model, or null. */
export function outputCapFor(opts) { return outputCaps.get(capKey(opts)) ?? null }
export function resetOutputCaps() { outputCaps.clear() }

/**
 * v167 — A LIMIT PER MINUTE IS WAITED OUT, NOT RETRIED INTO.
 *
 * Reported from a real run on SeekAI: "429 您已达到总请求数限制：1分钟内最多…"
 * ("you have reached the request limit: at most N per minute"). The agent's
 * retries waited 2s, 4s, 6s — inside the same minute, so each one hit the same
 * limit — and three of them in a whole run ended it. What the 429 says is
 * read: whether the window is a minute, and how many requests fit in it.
 */
export function rateLimitFrom(body) {
  const t = String(body ?? "")
  const perMinuteWindow = /分钟|\bmin(?:ute)?s?\b|\bRPM\b|\/\s*min\b|per\s+min/i.test(t)
  const pats = [
    /分钟内?(?:最多|最大)?(?:请求|调用|访问)?\s*(\d+)\s*次/,
    /(\d+)\s*(?:requests?|calls?|reqs?|times)\s*(?:per|\/|each|every|a|in\s+(?:a|one|1))\s*min(?:ute)?\b/i,
    /\bRPM\b\D{0,12}(\d+)/i,
    /(\d+)\s*RPM\b/i,
    /limit\D{0,24}?(\d+)\D{0,24}?(?:per|\/)\s*min(?:ute)?\b/i,
  ]
  let perMinute = null
  if (perMinuteWindow) for (const re of pats) { const m = re.exec(t); if (m && Number(m[1]) > 0) { perMinute = Number(m[1]); break } }
  return { windowMs: perMinuteWindow ? 60000 : null, perMinute }
}

/** v167: the waits that leave a per-minute window, attempt by attempt. */
export const MINUTE_WINDOW_WAITS_MS = Object.freeze([20000, 40000, 60000])

/**
 * How long the agent waits before retry number `attempt` (1-based) after `e`.
 * A server's positive Retry-After is used as given. A 429 that says its
 * window is a minute waits long enough to leave it (20s, 40s, 60s). Anything
 * else keeps the old steps (2s, 4s, 6s) — a Retry-After of 0 included.
 */
export function retryWaitMs(e, attempt = 1) {
  if (Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0) return e.retryAfterMs
  const n = Math.max(1, Math.floor(attempt))
  if (minuteWindow(e)) return MINUTE_WINDOW_WAITS_MS[Math.min(n, MINUTE_WINDOW_WAITS_MS.length) - 1]
  return 2000 * n
}

/** A 429 whose own words say the limit is per minute. */
export function minuteWindow(e) {
  return e instanceof ProviderError && e.status === 429 && e.rateLimit?.windowMs >= 60000
}

// Once a 429 names its limit, requests to that provider are spaced to fit
// it — the run slows to the allowed pace instead of hitting the limit again.
// v169: per account (base URL + a hash of the key), and remembered across
// runs (ratelimits.js) — a new run keeps the pace from its first request.
const paces = new Map() // account -> { intervalMs, perMinute, next }
const loadedPaces = new Set() // accounts whose stored limit was looked up this process
const paceKey = (opts) => rateLimitKey(opts?.baseUrl, opts?.apiKey)
const intervalFor = (perMinute) => Math.ceil(60000 / perMinute) + 50

/**
 * v182 — A LIMIT THAT WENT UP.
 *
 * v169 paces every run to a limit the provider stated, for a day, and never
 * sends faster than it — so it could not see the limit go up: a plan upgraded
 * in the morning was still paced to the old limit at night, every request
 * waiting for nothing. After PACE_PROBE_EVERY requests in a row succeed at the
 * kept pace, the pace is doubled (and stored, so the next run starts there);
 * once it would be faster than PACE_DROP_MS apart, the provider evidently
 * does not limit at this rate and pacing stops (the stored limit is
 * forgotten). A 429 while probing sets the pace from what the provider says,
 * as before, and ends probing for that account in this process — a limit
 * that did not change costs one 429, not one every few requests.
 */
export const PACE_PROBE_EVERY = 5
export const PACE_DROP_MS = 100
const probeEnded = new Set() // accounts whose raised pace drew a 429 this process

function notePaceSuccess(opts) {
  const key = paceKey(opts)
  const p = paces.get(key)
  if (!p || probeEnded.has(key)) return
  p.okStreak = (p.okStreak ?? 0) + 1
  if (p.okStreak < PACE_PROBE_EVERY) return
  const perMinute = p.perMinute * 2
  const intervalMs = intervalFor(perMinute)
  if (intervalMs < PACE_DROP_MS) {
    paces.delete(key)
    forgetRateLimit(key)
    try { opts?.onPace?.({ perMinute, intervalMs: 0, raised: true, unpaced: true }) } catch { /* a listener must never break the call */ }
    return
  }
  paces.set(key, { intervalMs, perMinute, next: Math.min(p.next, Date.now() + intervalMs), okStreak: 0, raised: true })
  storeRateLimit(key, perMinute)
  try { opts?.onPace?.({ perMinute, intervalMs, raised: true }) } catch { /* a listener must never break the call */ }
}

function learnPace(e, opts) {
  const n = e instanceof ProviderError && e.status === 429 ? e.rateLimit?.perMinute : null
  if (!Number.isFinite(n) || n <= 0) return
  const intervalMs = intervalFor(n)
  const key = paceKey(opts)
  const prev = paces.get(key)
  if (prev?.raised) probeEnded.add(key) // a raised pace was too fast: stop probing
  paces.set(key, { intervalMs, perMinute: n, next: Math.max(prev?.next ?? 0, Date.now() + intervalMs) })
  loadedPaces.add(key)
  storeRateLimit(key, n)
  try { opts?.onPace?.({ perMinute: n, intervalMs, remembered: false }) } catch { /* a listener must never break the call */ }
}

/** A limit this account stated in an earlier run, once per process. */
function recallPace(opts) {
  const key = paceKey(opts)
  if (loadedPaces.has(key)) return
  loadedPaces.add(key)
  const s = storedRateLimit(key)
  if (!s || paces.has(key)) return
  paces.set(key, { intervalMs: intervalFor(s.perMinute), perMinute: s.perMinute, next: 0 })
  try { opts?.onPace?.({ perMinute: s.perMinute, intervalMs: intervalFor(s.perMinute), remembered: true, learnedAt: s.at }) } catch { /* a listener must never break the call */ }
}

async function waitPace(opts) {
  recallPace(opts)
  const p = paces.get(paceKey(opts))
  if (!p) return
  const now = Date.now()
  const at = Math.max(now, p.next)
  p.next = at + p.intervalMs
  if (at > now) await sleepAbortable(at - now, opts?.signal)
}

/** v167: one wording for a retry, wherever it is shown. */
export function retryText({ error = "", waitMs = null, left = null, rateLimited = false, perMinute = null } = {}) {
  const secs = Number.isFinite(waitMs) ? ` — waiting ${Math.max(1, Math.round(waitMs / 1000))}s, then continuing` : " — retrying"
  const more = Number.isFinite(left) ? ` (${left} more ${left === 1 ? "try" : "tries"} if it fails again)` : ""
  if (rateLimited) return `the provider's rate limit${Number.isFinite(perMinute) ? ` (${perMinute} requests/min)` : ""} was reached${secs}${more}`
  return `transient provider error (${String(error).slice(0, 120)})${secs}${more}`
}

/** The pace kept for a provider, or null. */
export function paceFor(opts) { const p = paces.get(paceKey(opts)); return p ? { intervalMs: p.intervalMs } : null }
export function resetPaces() { paces.clear(); loadedPaces.clear(); probeEnded.clear() }

/** v169: what a pace notice says. */
export function paceText({ perMinute, remembered = false, learnedAt = null, raised = false, unpaced = false } = {}) {
  if (unpaced) return "the provider no longer limits requests at the kept pace — no longer spacing them (the stored limit is forgotten)"
  if (raised) return `the provider accepted faster requests — now spacing them to ${perMinute} requests/min`
  const ago = Number.isFinite(learnedAt) ? ` (it said so ${Math.max(1, Math.round((Date.now() - learnedAt) / 60000))} min ago)` : ""
  return remembered
    ? `keeping this provider's stated limit of ${perMinute} requests/min${ago} — requests are spaced to fit`
    : `the provider allows ${perMinute} requests/min — spacing requests to fit (remembered for the next run)`
}

/** Human-friendly hint appended to provider HTTP errors. providerName (when
 *  known) adds the exact `forge config set` line + where to get a valid key. */
function hintFor(status, providerName, affordableTokens = null) {
  const cat = providerName ? getCatalog(providerName) : null
  const keyHint = cat?.keyUrl ? ` get a valid key: ${cat.keyUrl}` : ""
  const setLine = providerName ? ` forge config set providers.${providerName}.apiKey <KEY>` : " /key"
  if (status === 401 || status === 403) return ` — API key rejected (${providerName ?? "provider"}).${keyHint} fix:${setLine}`
  if (status === 404) return ` — model or URL not found on ${providerName ?? "provider"} (run: forge models, check providers.${providerName ?? "<name>"}.baseUrl)`
  if (status === 429) return " — rate limited, forge retries automatically"
  if (status === 408) return " — provider timeout, forge retries automatically"
  return ""
}

/**
 * v170 — AN ERROR SENT WITH HTTP 200.
 *
 * OpenAI-compatible gateways (New API resellers among them) often answer
 * `200 {"error": {"message": "上游负载已饱和…"}}`, or put `data: {"error":…}`
 * into a stream. forge read the first as an empty model response — it
 * nudged the model ("your last response was empty") and never showed the
 * error — and dropped the second: chat showed the partial text, or nothing,
 * as the answer. An error body is now an error, classified into the flows
 * that already exist: out of credits (402), rate limit (429), a busy
 * upstream (retried), anything else shown as it is.
 */
export function bodyError(j, providerName) {
  const e = j?.error
  if (!e) return null
  const msg = providerMessage(typeof e === "string" ? e : String(e.message ?? e.msg ?? JSON.stringify(e)))
  const code = typeof e === "object" ? `${e.code ?? ""} ${e.type ?? ""}` : ""
  const t = `${code} ${msg}`
  if (/quota|insufficient|balance|credit|余额|额度|欠费/i.test(t)) {
    const affordableTokens = affordableFrom(msg)
    return new ProviderError(`provider HTTP 402 — ${outOfCredits(providerName, affordableTokens)}: ${msg}`, { status: 402, affordableTokens })
  }
  if (/rate.?limit|too many requests|请求数|频率|\b429\b/i.test(t)) {
    return new ProviderError(`provider HTTP 429: ${msg}${hintFor(429, providerName)}`, { status: 429, rateLimit: rateLimitFrom(msg) })
  }
  if (/timeout|timed out|overload|saturat|upstream|temporar|unavailable|busy|负载|超时|繁忙|稍后/i.test(t)) {
    return new ProviderError(`provider error (sent with HTTP 200): ${msg} — a temporary error on the provider's side`, { status: 503 })
  }
  return new ProviderError(`provider error (sent with HTTP 200): ${msg}`, { status: 500, retryable: false })
}

/**
 * v165 — a 402 that reaches the person, in the words they need: out of
 * credits, where to top up, and that /retry continues. A 402 naming an
 * affordable amount was already retried at that amount (v163); one that
 * reaches here could not be.
 */
export function outOfCredits(providerName, affordableTokens = null) {
  const who = providerName ?? "the provider"
  const url = (providerName ? getCatalog(providerName) : null)?.keyUrl
  const left = Number.isFinite(affordableTokens)
    ? ` (${affordableTokens} output tokens left${Math.floor(affordableTokens * AFFORD_MARGIN) < MIN_AFFORDABLE_TOKENS ? ", too few to work with" : ""})`
    : ""
  // v180: what happened and where to top up — the NEXT STEP is the surface's
  // to say. "then /retry" reached one-shot runs too, where /retry is a chat
  // command that does not exist; chat's card and v175's line still name it.
  return `out of credits on ${who}${left}; top up${url ? ` (${url})` : ""}`
}

/**
 * Phase guard for one request: aborts if the provider never returns headers
 * (connect) or never sends the first byte (firstbyte), so a dead endpoint
 * can NEVER hang forge forever. Also chains the user's Ctrl+C signal.
 * Node >= 18 compatible (no AbortSignal.any needed).
 */
function makeGuard(signal, connectMs, nextMs, nextName, { idleMs = 0 } = {}) {
  const ctrl = new AbortController()
  let phase = 0 // 0=connect 1=next 2=done
  let timer = null
  let fired = null
  const arm = (ms, name) => {
    clearTimeout(timer)
    // v20: a 0/undefined/negative guard value would fire instantly — clamp
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 60000
    timer = setTimeout(() => {
      if (phase < 2) { phase = 2; fired = name; try { ctrl.abort(new Error(name)) } catch {} }
    }, safe)
  }
  if (signal) {
    if (signal.aborted) { try { ctrl.abort(signal.reason) } catch {} }
    else signal.addEventListener("abort", () => { try { ctrl.abort(signal.reason) } catch {} }, { once: true })
  }
  arm(connectMs, "connect")
  return {
    signal: ctrl.signal,
    gotHeaders() { if (phase === 0) { phase = 1; if (nextMs) arm(nextMs, nextName || "first-byte"); else { phase = 2; clearTimeout(timer) } } },
    // v199: with idleMs, every chunk re-arms an idle timer — a stream that
    // goes silent mid-answer is stopped instead of waiting forever. Before,
    // the first chunk cleared the only timer and nothing watched the rest.
    gotData() { if (phase < 2) { if (idleMs > 0) { phase = 1; arm(idleMs, "idle") } else { phase = 2; clearTimeout(timer) } } },
    timedOut() { return phase >= 2 },
    fired() { return fired },
    idleMs,
    dispose() { clearTimeout(timer) },
  }
}

/** Map an abort during a guarded request to a friendly ProviderError. */
function abortToError(e, guard, connectMs, nextMs, nextName, userAborted) {
  if (userAborted) return e // genuine user Ctrl+C — propagate as-is
  const reason = e?.cause?.message ?? e?.message ?? ""
  if (reason === "connect") return new ProviderError(`provider did not respond within ${connectMs / 1000}s (connect guard)`, { retryable: true, kind: "connect" })
  if (reason && reason === nextName) {
    return nextName === "request"
      ? new ProviderError(`provider request exceeded ${nextMs / 1000}s (request guard)`, { retryable: true })
      : new ProviderError(`provider sent no data within ${nextMs / 1000}s (first-byte guard)`, { retryable: true })
  }
  // v20.0.1: a raw `TypeError: fetch failed` (offline, DNS, TLS, connection
  // reset) is the single most common provider failure and it used to reach the
  // user verbatim. Report it as what it is, with something to check.
  const cause = e?.cause
  const detail = [cause?.code, cause?.message].filter(Boolean).join(" — ") || reason || e?.name || "network error"
  return new ProviderError(`could not reach the provider (${detail}) — check the base URL, your connection, DNS and TLS`, { retryable: true })
}

/** v20.0.1: an HTML page (wrong base URL, captive portal, proxy interstitial)
 *  answers with HTTP 200 — build an honest, non-retryable error for it. */
function nonJsonError(res, rawText, providerName) {
  const ct = String(res?.headers?.get?.("content-type") ?? "").split(";")[0].trim() || "unknown content-type"
  const sniff = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 100)
  const where = providerName ? `providers.${providerName}.baseUrl` : "the provider baseUrl"
  // v170: a gateway's own error page ("502 Bad Gateway") is a hiccup, not a
  // wrong URL — retried; anything else still stops with the URL advice
  if (/\b(502|503|504)\b|bad gateway|service unavailable|gateway time-?out|temporarily unavailable/i.test(sniff)) {
    return new ProviderError(`provider's gateway answered with an error page (HTTP ${res?.status ?? "?"}): ${sniff} — forge retries`, { status: 502, retryable: true })
  }
  return new ProviderError(
    `provider returned a non-JSON response (HTTP ${res?.status ?? "?"}, ${ct}): ${sniff || "(empty body)"} — check ${where}. A wrong URL, a proxy, or a captive portal looks exactly like this.`,
    { status: res?.status ?? 0, retryable: false },
  )
}

/** v20.0.1: a stream that dies mid-answer used to surface as "terminated". */
/** v199: how long a stream may go silent mid-answer before it is stopped. */
export const STREAM_IDLE_MS = 120000

/** v199: the error for a stream that went silent (retryable — ask again). */
function idleError(guard) {
  return new ProviderError(`provider went silent for ${Math.round(guard.idleMs / 1000)}s mid-answer (stream idle guard)`, { retryable: true, kind: "idle" })
}

function streamError(e, guard = null) {
  if (guard?.fired?.() === "idle") return idleError(guard)
  if (e instanceof ProviderError || e?.name === "AbortError") return e
  return new ProviderError(`stream interrupted before the answer completed (${String(e?.message ?? e)}) — check your connection or the provider`, { retryable: true })
}

async function readErrorBody(res) {
  try {
    return providerMessage(await res.text())
  } catch {
    return ""
  }
}

/** The message field of a parsed error body, whatever shape the provider uses. */
function messageOf(j) {
  if (j == null) return null
  if (typeof j === "string") return j
  const e = j.error ?? j
  if (typeof e === "string") return e
  const m = e?.message ?? e?.msg ?? e?.detail ?? j.message ?? j.detail ?? j.errors?.[0]?.message
  if (typeof m === "string") return m
  if (m && typeof m === "object") return messageOf(m)
  return null
}

/**
 * v180 — the provider's own sentence, not the envelope around it.
 *
 * A gateway that forwards an upstream failure often wraps the upstream's JSON
 * inside its own message: a reported seekai 400 read `Resource error. Error
 * message: {"error":{"message":…` — and the card, cut at the terminal width,
 * ended exactly where the reason began. Nested JSON (up to three levels, as
 * text or already parsed) is replaced by the message inside it, keeping the
 * gateway's own prefix. Bounded: 600 characters.
 */
export function providerMessage(raw, max = 600) {
  let text = String(raw ?? "")
  try { const m = messageOf(JSON.parse(text)); if (m) text = m } catch { /* not JSON — as is */ }
  for (let depth = 0; depth < 3; depth++) {
    const i = text.indexOf("{")
    const k = text.lastIndexOf("}")
    if (i < 0 || k <= i) break
    let inner = null
    try { inner = messageOf(JSON.parse(text.slice(i, k + 1))) } catch { break }
    if (!inner) break
    const prefix = text.slice(0, i).replace(/[\s:—-]*(error message|message|details?)?[\s:]*$/i, "").trim()
    text = prefix ? `${prefix}${/[.:;!?]$/.test(prefix) ? " " : ": "}${inner}` : inner
  }
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}

function headersFor(proto, apiKey) {
  if (proto === "anthropic") {
    const h = { "content-type": "application/json", "anthropic-version": "2023-06-01" }
    if (apiKey) h["x-api-key"] = apiKey
    return h
  }
  const h = { "content-type": "application/json" }
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`
  return h
}

// ---------------------------------------------------------------------------
// Models listing (live fetch, catalog fallback)
// v18: listModels also returns `entries` — full metadata when the provider
// sends it (id, name, context, free) — so pickers can badge FREE models.
// ---------------------------------------------------------------------------
export async function listModels({ protocol, baseUrl, apiKey, catalog, extraModels, publicUrl } = {}) {
  const extras = Array.isArray(extraModels) ? extraModels : []
  const proto = protocol || "openai"
  const base = (baseUrl || catalog?.baseUrl || "").replace(/\/$/, "")
  const finish = (models, live, extra = {}) => {
    const ids = unionModelIds(models, extras)
    const entries = Array.isArray(extra.entries) ? extra.entries.slice() : []
    const have = new Set(entries.map((e) => e && e.id))
    for (const id of extras) {
      const s = String(id || "").trim()
      if (s && !have.has(s)) entries.push({ id: s, name: "", context: null, free: isFreeModelId(s) })
    }
    const out = { models: ids, live: Boolean(live), entries }
    if (extra.warning) out.warning = extra.warning
    if (extra.source) out.source = extra.source
    return out
  }
  if (isApinexProvider(catalog, base)) {
    const r = await listApinexModels({ baseUrl: base, apiKey, publicUrl, timeoutMs: 8000 })
    if (r.live && r.all.length) return finish(r.all.map((e) => e.id), true, { entries: r.all, source: r.source })
    return finish(
      [...(catalog?.models ?? []), ...APINEX_FREE_FALLBACK.map((e) => e.id)],
      false,
      { warning: r.warning, entries: r.free?.length ? r.free : APINEX_FREE_FALLBACK, source: "offline" },
    )
  }
  if (!base) return finish(catalog?.models ?? [], false)
  try {
    const url = proto === "anthropic" ? `${base}/v1/models?limit=100` : `${base}/models`
    const res = await fetch(url, { headers: headersFor(proto, apiKey), signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const arr = j?.data ?? j?.models ?? []
    const entries = arr
      .map((m) => normalizeModelEntry(m))
      .filter((m) => m && m.id)
    const ids = entries.map((m) => m.id).sort()
    if (!ids.length) throw new Error("empty model list")
    return finish(ids, true, { entries })
  } catch (e) {
    return finish(catalog?.models ?? [], false, { warning: e.message })
  }
}

/** Normalize one /models entry from any OpenAI-compatible, OpenRouter-style,
 *  or APInex public catalog payload. Free = :free suffix, free/ prefix,
 *  both prices exactly 0, or dollarsPer1M === 0. */
/**
 * v195: does a listed model take tool calls? OpenRouter says it in
 * `supported_parameters` (v188); other gateways in `capabilities`
 * (`function_calling`, `tools`, `tool_use`) or a flat flag (`supports_tools`,
 * `tool_call`, `function_calling`). null when the provider does not say.
 */
export function modelTakesTools(m) {
  if (!m || typeof m !== "object") return null
  if (Array.isArray(m.supported_parameters)) return m.supported_parameters.includes("tools")
  const cap = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {}
  for (const v of [cap.function_calling, cap.tools, cap.tool_use, cap.tool_calling, m.supports_tools, m.supportsTools, m.tool_call, m.function_calling, m.tools]) {
    if (typeof v === "boolean") return v
  }
  return null
}

function normalizeModelEntry(m) {
  if (!m || typeof m !== "object") return null
  const id = String(m.id || m.name || "").trim()
  if (!id) return null
  const ctxRaw = m.context_length ?? m.context ?? m.contextWindow ?? m.top_provider?.context_length
  let context = Number.isFinite(Number(ctxRaw)) && Number(ctxRaw) > 1000 ? Number(ctxRaw) : null
  if (context == null && typeof ctxRaw === "string") {
    const n = parseFloat(ctxRaw)
    if (Number.isFinite(n)) {
      if (/m$/i.test(ctxRaw.trim())) context = Math.round(n * 1_000_000)
      else if (/k$/i.test(ctxRaw.trim())) context = Math.round(n * 1000)
    }
  }
  const price = m.pricing ?? {}
  const pZero = (v) => v !== undefined && Number(v) === 0
  const dollars = Number(m.dollarsPer1M)
  const free = id.endsWith(":free") || id.startsWith("free/")
    || (pZero(price.prompt) && pZero(price.completion))
    || (Number.isFinite(dollars) && dollars === 0)
  return {
    id,
    name: typeof m.name === "string" ? m.name : "",
    context,
    free,
    dollarsPer1M: Number.isFinite(dollars) ? dollars : null,
    provider: typeof m.provider === "string" ? m.provider : "",
    // v188: does the model take tool calls? OpenRouter lists it in
    // supported_parameters; null when the provider does not say
    tools: modelTakesTools(m),
  }
}

/**
 * v175: out of credits, and "top up" was the only way forward the card
 * offered — shortened in the UI to just that. What the person can do NOW,
 * named concretely: a free model on OpenRouter (free variants spend no
 * credits; OpenRouter limits them per day), or another provider they have a
 * key for. "" when there is nothing to suggest.
 */
/**
 * v184: a free model OpenRouter lists NOW. v175 named one fixed id — a model
 * OpenRouter may have retired — even when forge's own model cache (filled from
 * OpenRouter's live list by /models, `forge models` and the setup wizard) said
 * which free models exist. The cache is read under the provider's own name,
 * then under "openrouter"; the biggest context wins; never the model that
 * just failed. null when no cache lists a free model.
 */
/**
 * v195: fetch a provider's live model list and keep it in the model cache —
 * the one way every caller refreshes it (chat's start, `/models`). Returns
 * { refreshed, count, warning }; never throws.
 */
export async function refreshModelCache({ name, protocol, baseUrl, apiKey, catalog, extraModels } = {}) {
  try {
    const { live, entries, warning } = await listModels({ protocol, baseUrl, apiKey, catalog, extraModels })
    if (live && entries?.length) {
      writeModelCache(name, entries)
      return { refreshed: true, count: entries.length, warning: null }
    }
    return { refreshed: false, count: 0, warning: warning ?? "no live list" }
  } catch (e) {
    return { refreshed: false, count: 0, warning: String(e?.message ?? e) }
  }
}

export function liveFreeModel(active) {
  for (const name of [active?.name, "openrouter"]) {
    if (!name) continue
    const entries = readModelCache(name)?.entries ?? []
    // v188: never one listed without tool support — the run it rescues is tool calls
    const pick = rankForAgent(entries.filter((m) => m?.id && m.id !== active?.model && isFreeModelId(m.id, m) && m.tools !== false))[0]
    if (pick) return pick.id
  }
  return null
}

export function outOfCreditsOptions(config, active, env = process.env, { oneShot = false, task = "" } = {}) {
  const others = []
  const seen = new Set([active?.name])
  for (const [name, pc] of Object.entries(config?.providers ?? {})) {
    if (seen.has(name)) continue
    const cat = CATALOG.find((c) => c.name === name)
    const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(String(pc?.baseUrl ?? cat?.baseUrl ?? ""))
    if (pc?.apiKey || (cat?.envKey && env[cat.envKey]) || local) { others.push(name); seen.add(name) }
  }
  for (const c of CATALOG) if (!seen.has(c.name) && c.envKey && env[c.envKey]) { others.push(c.name); seen.add(c.name) }
  const ways = []
  // v180: a one-shot run is not a chat — /model, /provider and /retry do not
  // exist there. It gets the command that re-runs the task elsewhere.
  const q = (t) => JSON.stringify(String(t ?? "").split("\n")[0].slice(0, 120) || "…")
  const rerun = (flag) => `forge agent ${flag} ${q(task)}`
  if (/openrouter\.ai/i.test(String(active?.baseUrl ?? "")) && !isFreeModelId(active?.model)) {
    const free = liveFreeModel(active) ?? OPENROUTER_FREE_FALLBACK[0].id
    ways.push(oneShot
      ? `${rerun(`--model ${free}`)} — free OpenRouter models spend no credits (forge models marks the FREE ones)`
      : `/model ${free} — free OpenRouter models spend no credits (/models marks the FREE ones)`)
  }
  if (others.length) {
    const more = others.length > 1 ? ` (or ${others.slice(1, 4).join(", ")})` : ""
    ways.push(oneShot ? `${rerun(`--provider ${others[0]}`)}${more} — another provider you have set up` : `/provider ${others[0]}${more} — another provider you have set up`)
  }
  if (!ways.length) return ""
  const head = `out of credits on ${active?.name ?? "this provider"} — to keep going without topping up: ${ways.join("; or ")}.`
  return oneShot
    ? `${head} To fail over by itself next time: forge config set failover true`
    : `${head} Then /retry continues from where it stopped.`
}

export function isFreeModelId(id, entry) {
  if (entry && entry.free) return true
  const s = String(id || "")
  return s.endsWith(":free") || s.startsWith("free/")
}

function unionModelIds(primary, extra) {
  const out = []
  const seen = new Set()
  for (const id of [...(extra || []), ...(primary || [])]) {
    const s = String(id || "").trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function isApinexProvider(catalog, baseUrl) {
  if (catalog?.name === "apinex") return true
  return /apinex\.bond/i.test(String(baseUrl || catalog?.baseUrl || ""))
}

// ---------------------------------------------------------------------------
// v18 OpenRouter free-models detection — the /models endpoint on OpenRouter is
// PUBLIC (works without an API key), so the wizard can list every free model
// BEFORE the key step. Never throws; 8s guard; falls back to the caller.
// ---------------------------------------------------------------------------
export const OPENROUTER_FREE_FALLBACK = [
  { id: "deepseek/deepseek-chat-v3-0324:free", name: "DeepSeek V3 (free tier)", context: 163840, free: true },
  { id: "deepseek/deepseek-r1-0528:free", name: "DeepSeek R1 reasoning (free tier)", context: 163840, free: true },
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free tier)", context: 131072, free: true },
  { id: "qwen/qwen3-235b-a22b:free", name: "Qwen3 235B (free tier)", context: 131072, free: true },
  { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free tier)", context: 96000, free: true },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", name: "Mistral Small 3.1 (free tier)", context: 128000, free: true },
]

export async function listOpenRouterModels({ baseUrl, apiKey, timeoutMs = 8000 } = {}) {
  const base = (baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "")
  try {
    const res = await fetch(`${base}/models`, {
      headers: headersFor("openai", apiKey || ""),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const entries = (j?.data ?? j?.models ?? []).map(normalizeModelEntry).filter((m) => m && m.id)
    if (!entries.length) throw new Error("empty model list")
    const free = rankForAgent(entries.filter((m) => m.free))
    return { live: true, free, all: entries, total: entries.length }
  } catch (e) {
    return { live: false, free: [], all: [], warning: String(e?.message ?? e) }
  }
}

// ---------------------------------------------------------------------------
// APInex — OpenAI-compatible gateway (https://api.apinex.bond/v1).
// Authenticated GET /v1/models when a key is set. Public live catalog
// (no key) at https://apinex.bond/api/public/models. Custom model ids
// still work: listModels extraModels / wizard [m] / `forge use --model`.
// ---------------------------------------------------------------------------
export const APINEX_PUBLIC_MODELS_URL = "https://apinex.bond/api/public/models"

export const APINEX_FREE_FALLBACK = [
  { id: "free/gemini-3.8-flash", name: "Gemini 3.8 Flash", context: 1_000_000, free: true },
  { id: "free/muse-spark-1.3", name: "Muse Spark 1.3", context: 1_000_000, free: true },
  { id: "free/glm-5.3-flash", name: "GLM-5.3 Flash", context: 1_000_000, free: true },
  { id: "free/gemini-3.1-pro", name: "Gemini 3.1 Pro", context: 1_000_000, free: true },
  { id: "free/gpt-5.6-luna", name: "Gpt 5.6 Luna", context: 1_000_000, free: true },
  { id: "free/qwen-3.8-max", name: "Qwen 3.8 MAX", context: 1_000_000, free: true },
  { id: "free/deepseek-v4.1-flash", name: "Deepseek V4.1 Flash", context: 1_000_000, free: true },
]

export async function listApinexModels({ baseUrl, apiKey, timeoutMs = 8000, publicUrl } = {}) {
  const base = (baseUrl || "https://api.apinex.bond/v1").replace(/\/$/, "")
  if (apiKey) {
    try {
      const res = await fetch(`${base}/models`, {
        headers: headersFor("openai", apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) {
        const j = await res.json()
        const entries = (j?.data ?? j?.models ?? []).map(normalizeModelEntry).filter((m) => m && m.id)
        if (entries.length) {
          const free = entries.filter((m) => m.free).sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
          return { live: true, source: "auth", free, all: entries, total: entries.length }
        }
      }
    } catch { /* public catalog still works without a key */ }
  }
  const pub = publicUrl || APINEX_PUBLIC_MODELS_URL
  try {
    const res = await fetch(pub, {
      headers: { "user-agent": `forge-agent/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const entries = (j?.models ?? j?.data ?? []).map(normalizeModelEntry).filter((m) => m && m.id)
    if (!entries.length) throw new Error("empty model list")
    const free = entries.filter((m) => m.free).sort((a, b) => (b.context ?? 0) - (a.context ?? 0))
    return { live: true, source: "public", free, all: entries, total: entries.length }
  } catch (e) {
    return {
      live: false,
      source: "offline",
      free: APINEX_FREE_FALLBACK,
      all: APINEX_FREE_FALLBACK,
      warning: String(e?.message ?? e),
      total: APINEX_FREE_FALLBACK.length,
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming chat — yields {type:"text"|"reasoning"|"usage"|"done", ...}
// ---------------------------------------------------------------------------

/** v176: the finishReason of a stream whose body closed before it said it
 *  was done ([DONE], a finish_reason, a stop_reason or message_stop). */
export const STREAM_INCOMPLETE = "incomplete"
export async function* streamChat(opts) {
  const { protocol = "openai", baseUrl } = opts
  const base = (baseUrl || "").replace(/\/$/, "")
  if (!base) throw new ProviderError("no baseUrl configured for this provider")
  const run = (o) => protocol === "anthropic" ? streamAnthropic(o, base) : streamOpenAI(o, base)
  let emitted = false
  await waitPace(opts)
  try {
    for await (const ev of run(withOutputCap(opts))) { emitted = true; yield ev }
    notePaceSuccess(opts)
    return
  } catch (e) {
    learnPace(e, opts)
    // v163: a 402 arrives as the response status, before anything streamed
    if (emitted || !lowerOutputCap(e, opts)) throw e
  }
  await waitPace(opts)
  yield* run(withOutputCap(opts))
  notePaceSuccess(opts)
}

const BASE_HEADERS = { "user-agent": `forge-agent/${VERSION}` }

function mergeHeaders(proto, apiKey, baseUrl) {
  const h = { ...BASE_HEADERS, ...headersFor(proto, apiKey) }
  if (/openrouter\.ai/.test(baseUrl || "")) { h["http-referer"] = "https://github.com/forge-cli"; h["x-title"] = "forge" }
  return h
}

/**
 * Resilient wrapper: retries on transient failures (429 / 5xx / network)
 * BEFORE any text was emitted, so retries never duplicate output.
 */
export async function* streamChatResilient(opts, { attempts = 3, backoffMs = 1500, onRetry } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let emitted = false
    try {
      for await (const ev of streamChat(opts)) {
        if (ev.type === "text" || ev.type === "reasoning" || ev.type === "tool_calls") emitted = true
        yield ev
      }
      return
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : (e?.name === "AbortError" ? false : true)
      if (!retryable || emitted || attempt >= attempts) throw e
      // v89 perf: a connect-guard expiry means the endpoint accepted NOTHING
      // for connectMs — retrying the same provider stacks attempts×connectMs
      // of dead waiting (was ~94s worst case at 30s×3). Throw immediately:
      // callers classify it as failover-worthy and switch providers; without
      // a fallback chain it surfaces to the user unchanged.
      if (e instanceof ProviderError && e.kind === "connect") throw e
      // v20: honor the provider's Retry-After when present (bounded, polite)
      // v167: a 429 that says "per minute" waits out its window; the rest as before
      const wait = minuteWindow(e) ? Math.max(retryWaitMs(e, attempt), backoffMs * attempt) : Math.max(backoffMs * attempt, e instanceof ProviderError ? (e.retryAfterMs ?? 0) : 0)
      onRetry?.({ attempt, attempts, error: e.message, waitMs: wait, rateLimited: e instanceof ProviderError && e.status === 429, perMinute: e?.rateLimit?.perMinute ?? null })
      // abortable: a Ctrl+C during the backoff must not wait out the timer
      await sleepAbortable(wait, opts?.signal)
      if (opts?.signal?.aborted) throw e
    }
  }
}

async function* streamOpenAI(opts, base) {
  const { apiKey, model, messages, tools, system, temperature, maxTokens, signal, connectMs = 8000, firstByteMs = 120000, streamIdleMs = STREAM_IDLE_MS } = opts
  // v199: the tool definitions go on the wire. They never did on this path —
  // streamAnthropic sent them, streamOpenAI dropped them — so chat on every
  // OpenAI-protocol provider (OpenRouter included) offered its model no tools
  // at all while the start screen said "22 tools on".
  const msgs = system ? [{ role: "system", content: system }, ...(messages ?? [])] : (messages ?? [])
  const body = { model, messages: msgs, stream: true }
  if (tools?.length) body.tools = tools
  if (temperature !== undefined) body.temperature = temperature
  if (maxTokens) body.max_tokens = maxTokens
  // v19 deep think: provider-correct reasoning params, opt-in (deep mode only)
  applyReasoning(body, opts, model, base)
  const guard = makeGuard(signal, connectMs, firstByteMs, "first-byte", { idleMs: streamIdleMs })
  let res
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: mergeHeaders("openai", apiKey, base),
      body: JSON.stringify(body),
      signal: guard.signal,
    })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, firstByteMs, "first-byte", signal?.aborted)
  }
  if (!res.ok) { guard.dispose(); throw await httpError(res, opts.providerName) }
  guard.gotHeaders()
  const tcAcc = new Map() // index -> {id, name, args} — streaming tool-call assembly
  let ended = false // v176: [DONE] or a finish_reason — the stream said it was done
  try {
    yield* parseSSE(res, (data) => {
    if (data === "[DONE]") { ended = true; return [{ type: "done", finishReason: "stop" }, { type: "__stop__" }] }
    let j
    try { j = JSON.parse(data) } catch { return null }
    // v170: `data: {"error": …}` is an error, not an event to skip
    if (j?.error && !j?.choices?.length) throw bodyError(j, opts.providerName)
    const evs = []
    const choice = j?.choices?.[0]
    const d = choice?.delta ?? {}
    const rc = d.reasoning_content ?? d.reasoning
    if (rc) evs.push({ type: "reasoning", text: rc })
    if (d.content) evs.push({ type: "text", text: d.content })
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const i = t.index ?? 0
        const cur = tcAcc.get(i) ?? { id: "", name: "", args: "" }
        if (t.id) cur.id = t.id
        if (t.function?.name) cur.name = t.function.name
        if (t.function?.arguments) cur.args += t.function.arguments
        tcAcc.set(i, cur)
      }
    }
    if (choice?.finish_reason) { ended = true; evs.push({ type: "done", finishReason: choice.finish_reason }) }
    if (j?.usage) evs.push({ type: "usage", usage: normalizeOpenAIUsage(j.usage) })
    return evs
  }, guard)
    // v176: the body closed without the stream saying it was done — a
    // gateway or proxy dropped it mid-answer, cleanly. Not a whole answer,
    // and a tool call whose arguments were still arriving is not handed on.
    if (!ended) { yield { type: "done", finishReason: STREAM_INCOMPLETE, droppedToolCalls: tcAcc.size }; return }
    if (tcAcc.size) {
      const calls = [...tcAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
      yield { type: "tool_calls", calls }
    }
  } catch (e) {
    // v20.0.1: a stream cut mid-answer surfaced as a bare "terminated"
    throw streamError(e, guard)
  } finally { guard.dispose() }
}

/**
 * The extended-thinking parameter for a given Anthropic model — v137.
 *
 * THE BUG THIS FIXES. `streamAnthropic` sent, unconditionally:
 *
 *     body.thinking = { type: "enabled", budget_tokens: N }
 *
 * That is the PRE-4.6 form. From Claude 4.7 onward `budget_tokens` is not
 * merely deprecated, it is REJECTED WITH A 400 — and forge's own default
 * Anthropic model list is `claude-sonnet-5`, `claude-opus-4-8`,
 * `claude-haiku-4-5`, two of which reject it. So deep mode, the mode forge
 * escalates INTO for complex work, sent a request its own defaults refuse:
 * the harder the task, the likelier the run died at the first model call.
 *
 * The version is parsed rather than table-matched because the table goes
 * stale by design — a new model ships and the table does not know it. The
 * rule is the one the API documents: 4.6 and later take `{type:"adaptive"}`,
 * earlier ones take a budget.
 *
 *     claude-opus-5      -> 5.0  adaptive
 *     claude-fable-5-1   -> 5.1  adaptive
 *     claude-opus-4-8    -> 4.8  adaptive
 *     claude-sonnet-4-6  -> 4.6  adaptive
 *     claude-haiku-4-5   -> 4.5  budget_tokens
 *     claude-opus-4-1    -> 4.1  budget_tokens
 *     claude-3-5-sonnet  -> 3.5  budget_tokens
 *
 * An id that does not parse gets `adaptive`: every currently-served model
 * accepts it, unrecognised ids are overwhelmingly NEWER than this code
 * rather than older, and the failure it avoids (a hard 400 on every deep
 * request) is worse than the one it risks.
 */
export const ADAPTIVE_THINKING_MIN_VERSION = 4.6
// The same boundary as integers, which is what the comparison actually uses.
const ADAPTIVE_MAJOR = 4
const ADAPTIVE_MINOR = 6

/**
 * The numeric version of an Anthropic model id, or null if it is not one.
 *
 * Handles both naming schemes: `claude-3-5-sonnet-latest` (version first) and
 * `claude-opus-4-8` / `claude-sonnet-5` (family first). A missing minor reads
 * as `.0`, so `claude-opus-5` is 5, not 5.undefined.
 */
/**
 * The major and minor of an Anthropic model id, as INTEGERS.
 *
 * The boundary comparison must not go through a decimal. `Number("4.10")` is
 * 4.1, so a hypothetical `claude-opus-4-10` — newer than the 4.6 boundary —
 * would compare as OLDER and be sent the rejected `budget_tokens` shape. The
 * entire reason this parses instead of matching a table is to be right about
 * models that do not exist yet, so getting the tenth minor wrong would defeat
 * the point.
 */
function anthropicModelParts(model) {
  const s = String(model ?? "").toLowerCase()
  // Old naming put the version BEFORE the family: claude-3-5-sonnet-latest.
  const old = s.match(/claude-(\d+)-(\d+)-(?:opus|sonnet|haiku)/)
  if (old) return { major: Number(old[1]), minor: Number(old[2]) }
  // Current naming puts it after: claude-opus-4-8, claude-sonnet-5.
  const cur = s.match(/claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/)
  if (cur) return { major: Number(cur[1]), minor: Number(cur[2] ?? 0) }
  return null
}

/**
 * The numeric version of an Anthropic model id, or null if it is not one.
 *
 * Handles both naming schemes: `claude-3-5-sonnet-latest` (version first) and
 * `claude-opus-4-8` / `claude-sonnet-5` (family first). A missing minor reads
 * as `.0`, so `claude-opus-5` is 5, not 5.undefined.
 *
 * REPORTING ONLY. This is a decimal, so it cannot order 4.10 against 4.6 —
 * `thinkingParamFor` compares `anthropicModelParts` instead.
 */
export function anthropicModelVersion(model) {
  const v = anthropicModelParts(model)
  return v === null ? null : Number(`${v.major}.${v.minor}`)
}

/**
 * The `thinking` request field for this model, in the shape it accepts.
 *
 * 4.6 and later take `{type:"adaptive"}`; earlier models take an explicit
 * `budget_tokens`, floored at 1024 and capped at 8000 so the budget cannot
 * crowd out the answer. See the block above for why an unknown id gets
 * adaptive rather than a budget.
 */
export function thinkingParamFor(model, maxTokens) {
  const v = anthropicModelParts(model)
  // Integer comparison against the boundary — see anthropicModelParts.
  if (v === null || v.major > ADAPTIVE_MAJOR || (v.major === ADAPTIVE_MAJOR && v.minor >= ADAPTIVE_MINOR)) return { type: "adaptive" }
  // Pre-4.6: a budget, and it must leave room for the answer itself.
  return { type: "enabled", budget_tokens: Math.min(8000, Math.max(1024, (maxTokens || 16384) >> 2)) }
}

const EPHEMERAL = Object.freeze({ type: "ephemeral" })

/**
 * Normalize an Anthropic `usage` block — v139.
 *
 * WHY THIS EXISTS. Anthropic splits input tokens across THREE fields once
 * caching is on:
 *
 *   input_tokens                 the uncached tail only
 *   cache_read_input_tokens      served from cache (~0.1x price)
 *   cache_creation_input_tokens  written to cache (~1.25x price)
 *
 * forge mapped `prompt_tokens = input_tokens` and dropped the other two. That
 * was harmless while nothing cached — and v138 turned caching on for the
 * agent's own path, which silently made every prompt-token number forge
 * reports a small FRACTION of the real input. The better the cache worked,
 * the more wrong the accounting looked.
 *
 * `prompt_tokens` therefore stays what every consumer already believes it is
 * — the whole input — and the breakdown rides alongside it. Fixing the
 * meaning at the source beats auditing `agent.js`, `chat.js` and `meta.js`
 * for a field whose definition moved under them.
 */
/**
 * One usage field, or `null` if the provider sent something untrustworthy.
 *
 * ABSENT is not the same as INVALID. An absent cache field genuinely means
 * "nothing cached", so it counts as 0. A field that is PRESENT but is null, a
 * boolean, a string, negative, or fractional means the provider said
 * something this code cannot interpret — and `Number()` would quietly turn
 * most of those into a plausible-looking number ('100' -> 100, true -> 1,
 * -50 -> -50) or into NaN, which is worse: `agent.js` does
 * `tokenUsage.prompt += pin`, so a single NaN poisons the run's entire token
 * accounting permanently, with no error and no way back.
 */
function tokenField(v) {
  if (v === undefined) return 0
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return null
  return v
}

export function normalizeAnthropicUsage(u) {
  if (!u || typeof u !== "object") return { prompt_tokens: undefined, completion_tokens: undefined }
  const fresh = tokenField(u.input_tokens)
  const read = tokenField(u.cache_read_input_tokens)
  const written = tokenField(u.cache_creation_input_tokens)
  const outTok = tokenField(u.output_tokens)
  // Any invalid field makes the whole block untrustworthy. Reporting
  // `undefined` rather than throwing is deliberate: the model's ANSWER is
  // fine, and discarding a good response over a bad counter would be the
  // worse failure. `agent.js` already has the honest fallback — with no
  // usable numbers it sets `estimated = true` and estimates from the wire,
  // which the UI shows. A silently wrong total has no such tell.
  if (fresh === null || read === null || written === null || outTok === null) {
    return { prompt_tokens: undefined, completion_tokens: undefined, invalid: true }
  }
  const out = {
    prompt_tokens: fresh + read + written,
    completion_tokens: outTok,
  }
  // Only reported when the provider actually said something about caching, so
  // a non-caching provider is not made to look like a 0% cache.
  if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    out.cache_read_tokens = read
    out.cache_write_tokens = written
    out.uncached_tokens = fresh
  }
  return out
}

/**
 * v153: the OpenAI-protocol usage block, with its cache reads.
 *
 * Until v153 this path passed `usage` through untouched, and a TODO note said
 * the protocol "returns none of these fields … and always will". Checked
 * against primary sources, it does: OpenAI's OpenAPI spec gives Chat
 * Completions usage `prompt_tokens_details.cached_tokens`, and DeepSeek
 * documents `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. So every
 * OpenAI, DeepSeek or OpenRouter run said its cache was "unknown".
 *
 * What differs from Anthropic, and must not be papered over:
 *   - `prompt_tokens` already INCLUDES the cached part (it is the whole
 *     prompt), so it is kept as the total and the cache is a breakdown of it;
 *   - WRITES ARE NOT REPORTED. OpenAI caches automatically and bills no
 *     separate write, so `cache_write_tokens` stays undefined — never 0. A 0
 *     would claim "nothing was written", and `cacheHealth`'s Anthropic
 *     reasoning (writes-but-no-reads = an invalidated prefix; the per-model
 *     minimum table) would then misdiagnose every OpenAI run.
 *
 * Conservative on purpose: prompt/completion pass through exactly as before
 * (this path never validated them, and some compatible providers are loose).
 * Only the NEW field is checked — a cached count that is not a safe
 * non-negative integer, or exceeds the prompt, is dropped rather than trusted.
 */
export function normalizeOpenAIUsage(u) {
  if (!u || typeof u !== "object") return u
  const out = { ...u }
  const raw = u.prompt_tokens_details?.cached_tokens !== undefined
    ? u.prompt_tokens_details.cached_tokens
    : u.prompt_cache_hit_tokens
  if (raw === undefined) return out
  const cached = tokenField(raw)
  const prompt = typeof u.prompt_tokens === "number" && Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0 ? u.prompt_tokens : null
  if (cached === null || prompt === null || cached > prompt) return out
  out.cache_read_tokens = cached
  out.uncached_tokens = prompt - cached
  out.cache_writes_reported = false
  return out
}

/**
 * Attach prompt-cache breakpoints to an Anthropic request body — v138.
 *
 * ONE implementation, called by BOTH request builders. v89 added caching to
 * `streamAnthropic` only, and the agent's own model call goes through
 * `chatOnce` -> `chatOnceInner`, which had none: the comment promising "the
 * static prefix is served from cache on EVERY step of a multi-step run" was
 * true of a function the agent loop never calls. That is the same shape of
 * bug as v137's thinking parameter — an Anthropic change applied to one of
 * two builders — so this time the behaviour lives in one place and both
 * builders call it.
 *
 * Anthropic renders `tools` -> `system` -> `messages`, and caching is a
 * PREFIX match, so three breakpoints are placed (the limit is four):
 *
 *   1. the last TOOL. Redundant within a run, since the system breakpoint
 *      below already covers tools+system — but it is the only one that
 *      survives ACROSS runs, where the task changes the system prompt and
 *      the tool list does not.
 *   2. the last SYSTEM block, which caches tools+system together.
 *   3. the last content block of the last MESSAGE — the conversation tail.
 *      Without this the growing history is re-sent at full price on every
 *      step; a long run pays for the same bytes dozens of times.
 *
 * The tail breakpoint is placed only once the exchange IS a conversation
 * (an assistant turn exists). A cache WRITE costs 1.25x and only pays back
 * when something reads it, so marking the tail of a genuine one-shot call —
 * mcp.js and the chat one-offs both reach this path — would be a pure
 * surcharge on bytes no later request will ever read.
 */
/** Every block in a request body that already carries a cache breakpoint.
 *  Counts the caller's, not just ours — `toAnthropicMessages` preserves
 *  `cache_control` on replayed tool_use / tool_result / thinking blocks, and
 *  `applyAnthropicSystem` sets one on the stable system block before this
 *  function runs. */
function countBreakpoints(body) {
  let n = 0
  const mark = (b) => { if (b && typeof b === "object" && b.cache_control) n++ }
  if (Array.isArray(body?.tools)) body.tools.forEach(mark)
  if (Array.isArray(body?.system)) body.system.forEach(mark)
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) if (Array.isArray(m?.content)) m.content.forEach(mark)
  }
  return n
}

/** Anthropic's hard limit. A fifth breakpoint fails the whole request. */
export const MAX_CACHE_BREAKPOINTS = 4

/**
 * How far back a breakpoint looks for a prior cache entry.
 *
 * Anthropic's number, not forge's: each `cache_control` walks backward AT MOST
 * 20 positions looking for the previous request's entry. Past that it finds
 * nothing and silently misses — no error, just a full-price rewrite of the
 * whole conversation on every subsequent request.
 */
export const CACHE_LOOKBACK_POSITIONS = 20

/**
 * Where to put an intermediate breakpoint in a long turn.
 *
 * Under the 20 above, with room for the turn to grow before the next request
 * is built. The documented fix is "every ~15 positions".
 */
export const CACHE_STRIDE_POSITIONS = 15

/**
 * The minimum cacheable prefix, per model. BELOW THIS A MARKER DOES NOTHING —
 * no error, no warning, just `cache_creation_input_tokens: 0` — so a
 * breakpoint spent under the minimum is a breakpoint spent on nothing.
 *
 * NOT MONOTONIC across generations, which is the trap: 512 on the newest
 * models but 4096 on Opus 4.6 and Haiku 4.5, so a 3K-token prefix that caches
 * on Opus 5 silently will not on Opus 4.6. Ordered most specific first,
 * because "opus-4-6" must not match the "opus" family default.
 */
const CACHE_MINIMUMS = Object.freeze([
  [/opus-4-(6|5)|haiku-4-5/i, 4096],
  [/opus-4-7|haiku-3-5|mythos-preview/i, 2048],
  [/opus-4-8|sonnet-5|sonnet-4-(6|5)|opus-4(-1)?$|sonnet-4$/i, 1024],
  [/opus-5|fable-5|mythos-5/i, 512],
])

/** The most conservative minimum forge knows of, for an unrecognized model. */
export const CACHE_MINIMUM_DEFAULT = 4096

/**
 * Tokens a prefix must reach before `cache_control` on it does anything.
 *
 * An unknown model gets the WORST case (4096), deliberately. Guessing low
 * would have forge mark a prefix that silently does not cache and spend a
 * breakpoint it could have used elsewhere; guessing high only costs a caching
 * opportunity forge would otherwise have taken on faith.
 */
export function cacheMinimumFor(model) {
  const m = String(model ?? "")
  for (const [re, min] of CACHE_MINIMUMS) if (re.test(m)) return min
  return CACHE_MINIMUM_DEFAULT
}

/**
 * Count cache POSITIONS the way the lookback does.
 *
 * The rule that matters, and the one forge's own TODO had wrong: a run of
 * consecutive `tool_use` blocks counts as ONE position, and so does a run of
 * consecutive `tool_result` blocks. So a turn with many PARALLEL tool calls —
 * forge's normal shape — costs one position and never threatens the window.
 * What does threaten it is sequential depth: a long tool loop, or many text
 * and image blocks, each of which is its own position.
 *
 * Counted over `messages` only. `tools` and `system` render before them and
 * are not what a growing conversation pushes out of range.
 */
export function cachePositions(messages) {
  let n = 0
  let prevRun = null
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = m?.content
    if (!Array.isArray(content)) {
      // A plain string message is one position, and it ends any run.
      n += 1
      prevRun = null
      continue
    }
    for (const b of content) {
      const t = b?.type
      const runnable = t === "tool_use" || t === "tool_result"
      if (runnable && t === prevRun) continue // same run, still one position
      n += 1
      prevRun = runnable ? t : null
    }
  }
  return n
}

export function applyAnthropicCaching(body, { cacheTail = true, model = null } = {}) {
  if (!body || typeof body !== "object") return body

  // v146: below the model's minimum, `cache_control` does NOTHING — no error,
  // no warning, `cache_creation_input_tokens: 0`.
  //
  // The first cut of this SKIPPED marking under the minimum. That was wrong,
  // and v89's suite caught it. Marking below the minimum is free: the API
  // ignores it. Skipping is not free, because the only size forge has is
  // bytes/4 — it cannot know the real token count without a `count_tokens`
  // round trip it would pay for on every step — and that estimate UNDERSTATES
  // tokens for code, JSON and CJK, which is most of what forge sends. An
  // underestimate would drop a marker from a prompt that would have cached,
  // silently costing real money. Exactly the failure this release exists to
  // remove.
  //
  // So: mark regardless, and record the estimate for `cacheHealth` to read.
  // A cache that was never CREATED and a cache that is failing to be READ look
  // identical in the usage counters, and only this number tells them apart.

  // Never exceed four, and never overwrite a breakpoint the caller placed.
  // Two ways a body arrives here already carrying them: replayed assistant
  // turns keep their `cache_control` through `toAnthropicMessages`, and
  // `applyAnthropicSystem` deliberately marks the STABLE system block — if
  // this function then re-marked the LAST system block it would move the
  // breakpoint onto the volatile tail, caching the one part that changes
  // every task and defeating the split entirely.
  let budget = MAX_CACHE_BREAKPOINTS - countBreakpoints(body)
  const take = () => (budget > 0 ? (budget--, true) : false)

  if (Array.isArray(body.tools) && body.tools.length) {
    const last = body.tools[body.tools.length - 1]
    if (!last.cache_control && take()) last.cache_control = EPHEMERAL
  }

  if (typeof body.system === "string" && body.system) {
    if (take()) body.system = [{ type: "text", text: body.system, cache_control: EPHEMERAL }]
  } else if (Array.isArray(body.system) && body.system.length) {
    // Only when NO system block is already a breakpoint — see above.
    const already = body.system.some((b) => b?.cache_control)
    if (!already && take()) body.system[body.system.length - 1].cache_control = EPHEMERAL
  }

  if (cacheTail && budget > 0 && Array.isArray(body.messages) && body.messages.length) {
    // "Is this a conversation yet?" — an assistant turn means the model has
    // already answered once, so another request carrying this tail as its
    // prefix is coming.
    const isConversation = body.messages.some((m) => m?.role === "assistant")
    if (isConversation) {
      // Mark the last message whose content is ALREADY a block array, and
      // never rewrite a plain string into one. Two reasons, both learned the
      // hard way:
      //
      // 1. SHAPE. A string content is part of the wire contract other code
      //    reads. forge's own governor turn is identified by
      //    `typeof content === "string"`, so converting it to a block array
      //    to carry the mark made that turn unrecognisable — the e2e agent
      //    loop on the Anthropic wire stopped seeing its own tool result.
      // 2. VALUE. The string tails here are short and VOLATILE — the
      //    governor rewrites its directive in place between steps. A
      //    breakpoint on content that changes every step writes an entry the
      //    next step immediately invalidates: the "unique per-request tail"
      //    that costs 1.25x and is never read back.
      //
      // The last block array in an agent loop is the tool_result, which is
      // where the bytes actually are.
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const c = body.messages[i]?.content
        if (!Array.isArray(c) || !c.length) continue
        const last = c[c.length - 1]
        // Already marked by the caller (a replayed turn) — nothing to add,
        // and nothing to overwrite.
        if (!last.cache_control && take()) last.cache_control = EPHEMERAL
        break
      }

      // v146 — THE INTERMEDIATE BREAKPOINT.
      //
      // The tail marker above is written for the NEXT request to read. That
      // read walks back at most 20 positions, so once a turn grows by more
      // than that between requests, it finds nothing: every request then
      // rewrites the whole conversation at 1.25x and reads none of it back,
      // silently and forever. Long sequential tool loops are exactly the shape
      // that does it, and exactly what forge does.
      //
      // So when the conversation is already past the window, plant a second
      // marker about a stride back from the end. It gives the next request's
      // lookback something to land on whatever happens in between.
      //
      // Runs collapse: many PARALLEL tool calls are one position and never
      // trigger this. Sequential depth does.
      if (budget > 0 && cachePositions(body.messages) > CACHE_LOOKBACK_POSITIONS) {
        markIntermediate(body.messages, take)
      }
    }
  }
  return body
}

/**
 * Mark the block ~CACHE_STRIDE_POSITIONS back from the end.
 *
 * Walks the same way the lookback does, so the position it counts back over
 * is the position the API counts. Marks the first eligible block at or past
 * the stride and stops: one bridge is what the budget affords once tools,
 * system and the tail have taken their slots, and it is the one that matters.
 */
function markIntermediate(messages, take) {
  let back = 0
  let prevRun = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content
    if (!Array.isArray(c)) { back += 1; prevRun = null; continue }
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j]
      const t = b?.type
      const runnable = t === "tool_use" || t === "tool_result"
      if (!(runnable && t === prevRun)) { back += 1; prevRun = runnable ? t : null }
      if (back < CACHE_STRIDE_POSITIONS) continue
      // Never overwrite, and never double-mark the block the tail already took.
      if (b && typeof b === "object" && !b.cache_control && take()) {
        b.cache_control = EPHEMERAL
        return true
      }
    }
  }
  return false
}

/**
 * Is the prompt cache actually working? — v139.
 *
 * Placing breakpoints is not the same as getting hits, and the failure is
 * SILENT: a single byte moving inside the cached prefix (a timestamp entering
 * the system prompt, a tool list that reorders, a rewritten history) produces
 * no error at all — just full-price input on every step forever. The only
 * signal the provider gives is that `cache_read_input_tokens` stays zero.
 *
 * So this reads the accumulated counters and names the state:
 *
 *   unknown     the provider never mentioned caching. Not a fault.
 *   cold        too few steps to judge — step 1 can only ever write.
 *   never-read  the cache is being WRITTEN and never READ across several
 *               steps. That is the silent invalidator, and it costs 1.25x
 *               for nothing.
 *   ok          reads are happening; `ratio` is the share of input served
 *               from cache.
 *
 * `minSteps` is 3 deliberately: step 1 writes, step 2 is the first that could
 * read, and a run that ends at two steps should not be accused of a fault it
 * never had the chance to show.
 */
export function cacheHealth({ steps = 0, read = 0, written = 0, uncached = 0, sawCacheFields = false, model = null, writesReported = true } = {}) {
  if (!sawCacheFields) return { state: "unknown", ratio: null, why: "provider reported no cache fields" }
  const total = read + written + uncached
  const ratio = total > 0 ? read / total : 0
  if (read > 0) return { state: "ok", ratio, why: `${Math.round(ratio * 100)}% of input served from cache` }
  if (steps < 3) return { state: "cold", ratio, why: `only ${steps} step(s) — the first can only write` }
  // v153: a provider that reports reads but not writes (the OpenAI protocol)
  // gives nothing the two diagnoses below need — "written but never read" has
  // no writes to count, and the minimum table is Anthropic's. Saying either
  // would be a guess dressed as a finding.
  if (!writesReported) return { state: "unread", ratio, why: `no cached tokens reported over ${steps} steps — this provider reports cache reads but not writes, so why cannot be told from the counters` }
  // v146: nothing written AND nothing read, on a model with a high minimum, is
  // most likely a prompt that never qualified — not a prefix being broken.
  // The two are indistinguishable in the counters and the advice is opposite:
  // one says "find your invalidator", the other says "there is nothing to
  // find". `uncached` is the whole prompt in this case, so it is the size to
  // compare against.
  if (written === 0 && model) {
    const min = cacheMinimumFor(model)
    if (uncached > 0 && uncached < min) {
      return {
        state: "too-small", ratio,
        why: `the prompt is ~${uncached} tokens and ${model} caches nothing under ${min} — no entry was ever created, so there is no invalidator to hunt`,
      }
    }
  }
  if (written > 0) {
    return {
      state: "never-read", ratio,
      why: `${written} tokens written to cache over ${steps} steps and none read back — the cached prefix is being invalidated between steps`,
    }
  }
  return { state: "cold", ratio, why: "nothing written or read" }
}

/**
 * Split Anthropic `body.system` into a cached stable prefix and an uncached
 * volatile tail. The split comes FROM the prompt builder
 * (`opts.systemStable`); this helper never searches the prompt for a marker,
 * because a second search would be a second source of truth for where the
 * boundary is (§36).
 *
 * `applyAnthropicCaching` runs after this and deliberately leaves the
 * breakpoint where this put it: on the STABLE block. Marking the last system
 * block instead would cache the volatile tail — the one part that changes
 * every task — and the split would buy nothing.
 */
export function applyAnthropicSystem(body, opts, convSystem) {
  const stable = typeof opts?.systemStable === "string" ? opts.systemStable : ""
  if (stable) {
    body.system = [{ type: "text", text: stable, cache_control: EPHEMERAL }]
    if (opts.systemVolatile) body.system.push({ type: "text", text: opts.systemVolatile })
    return body
  }
  const system = opts?.system || convSystem
  if (system) body.system = system
  return body
}

async function* streamAnthropic(opts, base) {
  const { apiKey, model, temperature, maxTokens, signal, connectMs = 8000, firstByteMs = 120000, streamIdleMs = STREAM_IDLE_MS } = opts
  const conv = toAnthropicMessages(opts.messages ?? [])
  const system = opts.system || conv.system
  const messages = conv.messages
  const body = { model, messages, max_tokens: maxTokens || 8192, stream: true }
  // v89 perf: prompt caching. The static prefix (tool schemas + system
  // prompt ≈ 16 KB / 4 k tokens on a stock agent) is re-sent on EVERY step of
  // a multi-step run; telling the provider the prefix is stable serves it
  // from cache instead. Content is unchanged.
  // v138: the placement moved into applyAnthropicCaching so this path and
  // chatOnceInner cannot drift apart again.
  applyAnthropicSystem(body, opts, conv.system)
  if (Array.isArray(opts.tools) && opts.tools.length) body.tools = opts.tools.map(toAnthropicTool)
  applyAnthropicCaching(body, { model })
  if (temperature !== undefined) body.temperature = temperature
  // v19 deep think: extended thinking (deep mode only).
  // v137: the SHAPE depends on the model — see thinkingParamFor. Sending the
  // pre-4.6 `budget_tokens` form to a 4.7+ model is a 400, not a warning.
  if (opts.deep) body.thinking = thinkingParamFor(model, maxTokens)
  const guard = makeGuard(signal, connectMs, firstByteMs, "first-byte", { idleMs: streamIdleMs })
  let res
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: mergeHeaders("anthropic", apiKey, base),
      body: JSON.stringify(body),
      signal: guard.signal,
    })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, firstByteMs, "first-byte", signal?.aborted)
  }
  if (!res.ok) { guard.dispose(); throw await httpError(res, opts.providerName) }
  guard.gotHeaders()
  const tcAcc = new Map() // block index -> {id, name, args}
  let ended = false // v176: a stop_reason or message_stop — the stream said it was done
  try {
    yield* parseSSE(res, (data) => {
    let j
    try { j = JSON.parse(data) } catch { return null }
    const evs = []
    if (j?.type === "message_stop") ended = true
    if (j?.type === "content_block_start" && j?.content_block?.type === "tool_use") {
      tcAcc.set(j.index ?? 0, { id: j.content_block.id ?? "", name: j.content_block.name ?? "", args: "" })
    } else if (j?.type === "content_block_delta") {
      const d = j.delta || {}
      if (d.type === "text_delta" && d.text) evs.push({ type: "text", text: d.text })
      if (d.type === "thinking_delta" && d.thinking) evs.push({ type: "reasoning", text: d.thinking })
      if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        const cur = tcAcc.get(j.index ?? 0)
        if (cur) cur.args += d.partial_json
      }
    } else if (j?.type === "message_delta") {
      if (j?.usage) evs.push({ type: "usage", usage: normalizeAnthropicUsage(j.usage) })
      if (j?.delta?.stop_reason) { ended = true; evs.push({ type: "done", finishReason: j.delta.stop_reason }) }
    } else if (j?.type === "message_start" && j?.message?.usage) {
      evs.push({ type: "usage", usage: normalizeAnthropicUsage(j.message.usage) })
    } else if (j?.type === "error") {
      // v170: thrown like any provider error, so an overloaded_error is
      // retried and a real one stops the answer instead of trailing it
      throw bodyError({ error: { message: j?.error?.message || "provider error", type: j?.error?.type } }, opts.providerName)
    }
    return evs
  }, guard)
    if (!ended) { yield { type: "done", finishReason: STREAM_INCOMPLETE, droppedToolCalls: tcAcc.size }; return }
    if (tcAcc.size) {
      const calls = [...tcAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
      yield { type: "tool_calls", calls }
    }
  } catch (e) {
    throw streamError(e, guard)
  } finally { guard.dispose() }
}

/** Generic SSE reader — parseLine(data) returns an array of events (or null). */
async function* parseSSE(res, parseLine, guard) {
  if (!res.body) throw new ProviderError("provider returned empty body")
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of res.body) {
    guard?.gotData()
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      if (!line.startsWith("data:")) continue
      const events = parseLine(line.slice(5).trim())
      if (events && events.length) {
        for (const ev of events) {
          if (ev.type === "__stop__") return
          yield ev
        }
      }
    }
  }
}

/**
 * Convert internal (OpenAI wire format) message history to the Anthropic wire:
 *  - role:"system"  -> top-level system string (the real API rejects system
 *    roles inside the messages array — a latent v14 bug this fixes)
 *  - assistant {tool_calls:[...]} -> content blocks [{type:"tool_use",...}]
 *  - role:"tool" -> user message with [{type:"tool_result",...}]
 *  - drops empty text blocks (Anthropic rejects them)
 *  - already-anthropic-shaped blocks pass through unchanged
 *  - OpenAI-shaped user image parts (image_url data: URLs) become Anthropic
 *    image blocks; remote http(s) image_url is stubbed, never fetched
 */
export function toAnthropicMessages(messages) {
  let system = ""
  const out = []
  for (const m of messages) {
    if (!m) continue
    if (m.role === "system") {
      system = system ? system + "\n\n" + String(m.content ?? "") : String(m.content ?? "")
      continue
    }
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: String(m.content ?? "") }] })
      continue
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = []
      const text = String(m.content ?? "")
      if (text) blocks.push({ type: "text", text })
      for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(tc.function?.arguments ?? "{}") } catch {}
        blocks.push({ type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input })
      }
      out.push({ role: "assistant", content: blocks })
      continue
    }
    if (Array.isArray(m.content)) {
      const converted = toAnthropicContent(m.content)
      out.push({ role: m.role === "user" ? "user" : "assistant", content: converted })
      continue
    }
    out.push({ role: m.role === "user" ? "user" : "assistant", content: String(m.content ?? "") })
  }
  return { system, messages: out }
}

// ---------------------------------------------------------------------------
// Non-streaming chat with tool support (agent mode)
// Returns { content, reasoning, toolCalls:[{id,name,args}], usage, finishReason }
// ---------------------------------------------------------------------------
// v97 §49 (zero-waste): IN-FLIGHT REQUEST COALESCING. Two IDENTICAL requests
// (same provider/model/prompt/tools) issued CONCURRENTLY — e.g. parallel
// workers summarizing the same context, or a fan-out hitting the same
// sub-question — share ONE network call. Strictly in-flight: nothing is
// cached after completion (a model call is not a pure function of its
// prompt), and the entry is dropped the moment the call settles.
const inflightRequests = new Map()
const INFLIGHT_MAX = 64

export async function chatOnce(opts) {
  await waitPace(opts)
  try {
    const r = await chatOnceShared(withOutputCap(opts))
    notePaceSuccess(opts)
    return r
  } catch (e) {
    learnPace(e, opts)
    if (!lowerOutputCap(e, opts)) throw e
  }
  await waitPace(opts)
  const r = await chatOnceShared(withOutputCap(opts))
  notePaceSuccess(opts)
  return r
}

async function chatOnceShared(opts) {
  let key = null
  // audit A13: a request carrying its OWN abort signal never coalesces — one
  // caller's cancellation must never reject another caller's shared promise.
  if (opts?.signal) return chatOnceInner(opts)
  try {
    const kb = [String(opts?.baseUrl ?? ""), String(opts?.model ?? ""), opts?.system ?? "", JSON.stringify(opts?.messages ?? []), JSON.stringify(opts?.tools ?? []), opts?.maxTokens ?? null, opts?.temperature ?? null, opts?.deep ?? null]
    key = crypto.createHash("sha1").update(JSON.stringify(kb)).digest("hex")
  } catch { key = null }
  if (!key || inflightRequests.size >= INFLIGHT_MAX) return chatOnceInner(opts)
  const existing = inflightRequests.get(key)
  if (existing) return existing
  const p = chatOnceInner(opts)
  inflightRequests.set(key, p)
  try { return await p } finally { inflightRequests.delete(key) }
}

async function chatOnceInner(opts) {
  // v128: connectMs defaulted to 30000 here while its two siblings
  // (streamChat at :582, the non-tool path at :640) and the shipped config
  // (config.js defaultConfig -> retry.connectMs) all say 8000. Any caller that
  // omitted it silently bought a 30-SECOND connect guard instead of an 8-second
  // one — and two callers did omit it. v120 attributed a user's 30s guards
  // entirely to a stale config; that was incomplete, because this default
  // produces exactly the same 30s on a perfectly current config.
  const { protocol = "openai", baseUrl, apiKey, model, messages, tools, temperature, maxTokens, signal, system, connectMs = 8000, requestTimeoutMs = 180000, firstByteMs = 120000, streamIdleMs = STREAM_IDLE_MS } = opts
  const _deep = opts.deep
  const base = (baseUrl || "").replace(/\/$/, "")
  if (!base) throw new ProviderError("no baseUrl configured for this provider")
  const isAnthropic = protocol === "anthropic"
  // v199: the agent's calls stream on the OpenAI protocol (opts.stream). A
  // non-streamed answer had to arrive whole inside requestTimeoutMs (180s),
  // so a slow model writing a long file was cut off at 180s and the retry
  // asked for the same thing again. Streamed, the answer may take as long as
  // it takes while bytes keep coming; a stream that goes silent for
  // streamIdleMs is stopped and retried.
  const streamed = !isAnthropic && opts.stream === true && !NO_STREAM_BASES.has(base)

  let url, body
  if (isAnthropic) {
    const conv = toAnthropicMessages(messages ?? [])
    url = `${base}/v1/messages`
    body = { model, messages: conv.messages, max_tokens: maxTokens || 8192 }
    applyAnthropicSystem(body, opts, conv.system)
    if (tools?.length) body.tools = tools.map(toAnthropicTool)
    if (temperature !== undefined) body.temperature = temperature
    // v137: the NON-STREAMING path had the same pre-4.6 shape as
    // streamAnthropic, and fixing only the streaming one left deep mode
    // 400ing here instead. Both paths resolve it the same way now, from the
    // same function — there is no second place to forget.
    if (_deep) body.thinking = thinkingParamFor(model, maxTokens)
    // v138: THIS is the path the agent loop actually uses (agent.js calls
    // chatOnce, not streamChat), and it carried no cache_control at all — so
    // v89's prompt caching, and its comment about multi-step runs, applied
    // only to a function the agent never calls.
    applyAnthropicCaching(body, { model })
  } else {
    url = `${base}/chat/completions`
    // v17 fix: the OpenAI wire dropped the separate `system` opt entirely —
    // compaction summaries were sent WITHOUT their instruction on this protocol.
    const msgs = system ? [{ role: "system", content: system }, ...(messages ?? [])] : (messages ?? [])
    body = { model, messages: msgs }
    if (tools?.length) body.tools = tools
    if (temperature !== undefined) body.temperature = temperature
    if (maxTokens) body.max_tokens = maxTokens
    applyReasoning(body, { deep: _deep }, model, base)
    if (streamed) { body.stream = true; body.stream_options = { include_usage: true } }
  }

  // guard: connect phase + overall request phase — never hang forever
  // (streamed: connect, first byte, then an idle timer re-armed per chunk)
  const guard = streamed
    ? makeGuard(signal, connectMs, firstByteMs, "first-byte", { idleMs: streamIdleMs })
    : makeGuard(signal, connectMs, requestTimeoutMs, "request")
  const nextMs = streamed ? firstByteMs : requestTimeoutMs, nextName = streamed ? "first-byte" : "request"
  let res
  try {
    res = await fetch(url, { method: "POST", headers: mergeHeaders(protocol, apiKey, base), body: JSON.stringify(body), signal: guard.signal })
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, nextMs, nextName, signal?.aborted)
  }
  if (!res.ok) {
    guard.dispose()
    const err = await httpError(res, opts.providerName)
    // v199: a provider that refuses streaming (or its stream_options) is
    // asked again without it, and not asked to stream again this process
    if (streamed && res.status === 400 && /stream/i.test(String(err?.message ?? ""))) {
      NO_STREAM_BASES.add(base)
      return chatOnceInner({ ...opts, stream: false })
    }
    throw err
  }
  guard.gotHeaders()
  if (streamed && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
    try { return await collectOpenAIStream(res, guard, opts.providerName) } catch (e) { throw streamError(e, guard) } finally { guard.dispose() }
  }

  // v20.0.1: read the body as TEXT first. `res.json()` used to throw a bare
  // SyntaxError on an HTML error page (proxy / captive portal / wrong base URL),
  // which surfaced to the user as "Unexpected token '<'". Now the response is
  // inspected and reported as an honest, actionable provider error.
  let raw
  try {
    raw = await res.text()
  } catch (e) {
    guard.dispose()
    throw abortToError(e, guard, connectMs, nextMs, nextName, signal?.aborted)
  }
  guard.dispose()
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw nonJsonError(res, raw, opts.providerName)
  }
  // v170: an error body sent with HTTP 200 is an error, not an empty answer
  if (j?.error && !(isAnthropic ? j?.content?.length : j?.choices?.length)) throw bodyError(j, opts.providerName)
  if (isAnthropic) {
    let content = "", reasoning = ""
    const toolCalls = []
    for (const block of j?.content ?? []) {
      if (block.type === "text") content += block.text
      else if (block.type === "thinking") reasoning += block.thinking ?? ""
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: JSON.stringify(block.input ?? {}) })
    }
    return { content, reasoning, toolCalls, usage: normalizeAnthropicUsage(j?.usage), finishReason: j?.stop_reason }
  }
  const m = j?.choices?.[0]?.message ?? {}
  return {
    content: m.content ?? "",
    reasoning: m.reasoning_content ?? m.reasoning ?? "",
    toolCalls: (m.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc?.function?.name, args: tc?.function?.arguments ?? "{}" })),
    usage: normalizeOpenAIUsage(j?.usage),
    finishReason: j?.choices?.[0]?.finish_reason,
  }
}

/** v199: base URLs that refused a streamed request this process. */
const NO_STREAM_BASES = new Set()
export function resetStreamRefusals() { NO_STREAM_BASES.clear() }

/**
 * v199: one streamed OpenAI answer, collected into chatOnce's shape. A stream
 * that closes before it says it is done ([DONE] or a finish_reason) is not a
 * whole answer — and a tool call whose arguments were still arriving must not
 * run — so it is a retryable error, never a partial result.
 */
async function collectOpenAIStream(res, guard, providerName) {
  let content = "", reasoning = "", finishReason = null, usage = null, ended = false
  const acc = new Map()
  for await (const ev of parseSSE(res, (data) => {
    if (data === "[DONE]") { ended = true; return [{ type: "__stop__" }] }
    let j
    try { j = JSON.parse(data) } catch { return null }
    if (j?.error && !j?.choices?.length) throw bodyError(j, providerName)
    if (j?.usage) usage = normalizeOpenAIUsage(j.usage)
    const choice = j?.choices?.[0]
    const d = choice?.delta ?? choice?.message ?? {}
    const rc = d.reasoning_content ?? d.reasoning
    if (typeof rc === "string") reasoning += rc
    if (typeof d.content === "string") content += d.content
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const i = t.index ?? acc.size
      const cur = acc.get(i) ?? { id: "", name: "", args: "" }
      if (t.id) cur.id = t.id
      if (t.function?.name) cur.name = t.function.name
      if (t.function?.arguments) cur.args += t.function.arguments
      acc.set(i, cur)
    }
    if (choice?.finish_reason) { ended = true; finishReason = choice.finish_reason }
    return null
  }, guard)) { /* events are folded above */ }
  if (!ended) throw new ProviderError(`stream ended before the answer was complete${acc.size ? ` (${acc.size} tool call${acc.size === 1 ? "" : "s"} still arriving)` : ""} — asking again`, { retryable: true, kind: "incomplete" })
  const toolCalls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, name: v.name, args: v.args || "{}" }))
  return { content, reasoning, toolCalls, usage: usage ?? undefined, finishReason: finishReason ?? "stop" }
}

/**
 * v19 deep think — wire-correct reasoning params, applied ONLY when the caller
 * opts in (deep mode). OpenRouter gets `reasoning.effort`, OpenAI o-series/gpt-5
 * style models get `reasoning_effort`; everyone else just gets the deep system
 * directives (harmless, no unknown-field rejections).
 */
function applyReasoning(body, opts, model, base) {
  if (!opts.deep) return
  if (/openrouter\.ai/i.test(base || "")) body.reasoning = { effort: "high" }
  else if (/^(o\d|gpt-5)/i.test(model || "")) body.reasoning_effort = "high"
}

/** Convert OpenAI tool def → anthropic tool def. */
function toAnthropicTool(t) {
  const f = t.function ?? t
  return { name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object", properties: {} } }
}

// ---------------------------------------------------------------------------
// Doctor probe — measure TTFB against a provider (tiny "ping" completion)
// ---------------------------------------------------------------------------
export async function probe({ protocol, baseUrl, apiKey, model, signal }) {
  const base = (baseUrl || "").replace(/\/$/, "")
  const t0 = Date.now()
  try {
    let res
    if (protocol === "anthropic") {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: headersFor("anthropic", apiKey),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: signal ?? AbortSignal.timeout(12000),
      })
    } else {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: headersFor("openai", apiKey),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: signal ?? AbortSignal.timeout(12000),
      })
    }
    const raw = await res.text().catch(() => "")
    const ms = Date.now() - t0
    if (!res.ok) {
      const detail = await readErrorBody(res).catch(() => "")
      return { ok: false, ms, status: res.status, error: (detail || raw).slice(0, 120) }
    }
    // v20.0.1: an HTML page (wrong baseUrl / captive portal / proxy) answers
    // HTTP 200 — doctor used to report that as a WORKING provider and stamped
    // a "✓ tested" badge on it. Verify the body really is a provider response.
    const body = String(raw ?? "").trim()
    if (body.startsWith("data:")) return { ok: true, ms } // SSE provider
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    if (!parsed || typeof parsed !== "object") {
      const sniff = body.replace(/\s+/g, " ").slice(0, 80)
      return { ok: false, ms, status: res.status, error: `unexpected response (${sniff || "empty body"}) — check baseUrl, it did not answer like a chat-completions API` }
    }
    if (parsed.error) {
      return { ok: false, ms, status: res.status, error: String(parsed.error?.message ?? parsed.error).slice(0, 120) }
    }
    return { ok: true, ms }
  } catch (e) {
    // v20.0.1: "fetch failed" / "The operation was aborted due to timeout" are
    // not actionable — name the real cause.
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return { ok: false, ms: Date.now() - t0, error: `no response within 12s — check the base URL and your connection` }
    }
    const cause = e?.cause
    const detail = [cause?.code, cause?.message].filter(Boolean).join(" — ") || String(e?.message ?? e)
    return { ok: false, ms: Date.now() - t0, error: detail.slice(0, 120) }
  }
}
