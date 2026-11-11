// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { getObservedContextLimit } from './contextLimitOverride.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { resolveAntModel } from './model/antModels.js'
import {
  CHATGPT_CODEX_MAX_OUTPUT_TOKENS,
  getChatGPTModelContextWindow,
} from './model/chatgptModels.js'
import { getModelCapability } from './model/modelCapabilities.js'
// NOTE: settingsCache.ts is type-only at runtime (zero imports), so reading the
// merged settings snapshot from here does NOT create the
// context → settings → growthbook → betas → context import cycle.
import { getSessionSettingsCache } from './settings/settingsCache.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('opus-4-7')
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // 1) Per-model override from settings.json / observed server limit.
  //    Both are "what the endpoint really has", so take the most restrictive.
  const configured = getSettingsContextWindowOverride(model)
  const observed = getObservedContextLimit(model)
  let resolved: number
  if (configured !== undefined && observed !== undefined) {
    resolved = Math.min(configured, observed)
  } else if (configured !== undefined) {
    resolved = configured
  } else if (observed !== undefined) {
    resolved = observed
  } else {
    resolved = resolveContextWindowRaw(model, betas)
  }

  // 2) Optional global cap (e.g. keep a 1M model compacting at 150k).
  const cap = getSettingsMaxContextCap()
  if (cap !== undefined) {
    resolved = Math.min(resolved, cap)
  }
  return resolved
}

const overrideMemo = new Map<string, number | undefined>()

function matchModelKey(
  map: Record<string, number>,
  model: string,
): number | undefined {
  const m = model.toLowerCase()
  const canonical = getCanonicalName(model).toLowerCase()
  const keys = Object.keys(map).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )
  for (const probe of canonical === m ? [m] : [m, canonical]) {
    const exact = keys.find(k => k.toLowerCase() === probe)
    if (exact !== undefined) return map[exact]
  }
  for (const probe of canonical === m ? [m] : [m, canonical]) {
    const partial = keys.find(k => probe.includes(k.toLowerCase()))
    if (partial !== undefined) return map[partial]
  }
  return undefined
}

function getSettingsContextWindowOverride(model: string): number | undefined {
  const merged = getSessionSettingsCache()?.settings
  const map = merged?.modelContextWindows
  if (map) {
    // A loaded cache always writes a value (possibly undefined) for the model,
    // so removing the key from settings.json also clears the memo.
    overrideMemo.set(model, matchModelKey(map, model))
  }
  // Cold cache / mid-reset: reuse the last known value instead of flashing
  // back to the 200k default for one render or one compaction decision.
  return overrideMemo.get(model)
}

function getSettingsMaxContextCap(): number | undefined {
  return getSessionSettingsCache()?.settings?.maxContextTokens
}

/** Rough token estimate for a request payload (chars / 4). */
export function estimateTokensFromPayload(payload: unknown): number {
  try {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return Math.ceil(json.length / 4)
  } catch {
    return 0
  }
}

/**
 * Clamp an output-token budget so that `input + max_tokens` cannot exceed the
 * model's effective context window. This is the main defense against
 * "input length and max_tokens exceed context limit" / "maximum context length
 * is N tokens" errors on OpenAI-compatible endpoints, which otherwise get a
 * fixed 64k max_tokens request regardless of their window.
 */
export function clampMaxOutputTokensToWindow(
  model: string,
  configuredMaxTokens: number,
  estimatedInputTokens: number,
): number {
  const MIN_OUTPUT_TOKENS = 512
  const SAFETY_BUFFER_TOKENS = 1_024
  const window = getContextWindowForModel(model)
  if (!Number.isFinite(window) || window <= 0) return configuredMaxTokens
  const available = window - estimatedInputTokens - SAFETY_BUFFER_TOKENS
  if (available >= configuredMaxTokens) return configuredMaxTokens
  return Math.max(MIN_OUTPUT_TOKENS, Math.floor(available))
}

function resolveContextWindowRaw(model: string, betas?: string[]): number {
  // Allow override via environment variable (available to everyone; the old
  // USER_TYPE=ant gate is intentionally removed so third-party users can cap
  // the effective window too). This takes precedence over all detection below.
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  // GPT-5.6 family: OAuth/Codex ≈ 272k; API key path ≈ 1.05M (model card).
  // Used for UI %, auto-compact thresholds, and local budgeting — not sent
  // as a request field (Codex Responses does not take max_input_tokens).
  const chatgptContextWindow = getChatGPTModelContextWindow(model)
  if (chatgptContextWindow !== undefined) {
    if (
      is1mContextDisabled() &&
      chatgptContextWindow > MODEL_CONTEXT_WINDOW_DEFAULT
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return chatgptContextWindow
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  // Treat zero input tokens the same as no usage data — avoids flashing
  // "ctx:0%" when a third-party API omits usage from message_start.
  if (totalInputTokens === 0) {
    return { used: null, remaining: null }
  }

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  // GPT-5.6 family: official 128k max output (OpenAI model card).
  if (getChatGPTModelContextWindow(model) !== undefined) {
    defaultTokens = 32_000
    upperLimit = CHATGPT_CODEX_MAX_OUTPUT_TOKENS
  } else if (m.includes('opus-4-7')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
