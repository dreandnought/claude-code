/**
 * 基础能力冒烟测试：输出预算闸门（批次 1）
 *
 * 覆盖 commit「上下文预算与压缩闭环」批次 1 的三条行为契约：
 * 1. 窗口不足时请求被判定为 starved，不再静默发一个几百 token 的请求
 * 2. 窗口钳制（windowLimited）与调用方自身上限可区分，报错文案指向正确旋钮
 * 3. maxContextTokens 在 240k / 262k 两种部署形态下产生同一套预算
 *
 * 任何一条失效，第三方长上下文模型在窗口边缘会退回「512 输出截断」死循环：
 * 一次无效请求 + 三次续写，每次重发整个上下文。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clampMaxOutputTokensToWindow,
  formatBudgetStarvationMessage,
  getContextWindowForModel,
  getContextWindowSource,
  getRequestBudget,
  MIN_USABLE_OUTPUT_TOKENS,
} from '../../src/utils/context'
import {
  clearObservedContextLimits,
  recordObservedContextLimit,
} from '../../src/utils/contextLimitOverride'
import {
  isBudgetStarvedMessage,
  isMaxOutputTokensMessage,
  isBudgetStarvation,
  isWindowLimitedOutputMessage,
  isWithheldMaxOutputTokens,
  OUTPUT_API_ERROR_BUDGET_STARVED,
  OUTPUT_API_ERROR_MAX_TOKENS,
  OUTPUT_API_ERROR_WINDOW_LIMITED,
} from '../../src/utils/outputBudget'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'

const ENV_KEYS = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  clearObservedContextLimits()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  clearObservedContextLimits()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

/** A payload whose JSON length yields exactly `tokens * 4` characters. */
function payloadOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

describe('output budget: starvation detection', () => {
  test('window with room passes the requested ceiling through', () => {
    recordObservedContextLimit('smoke-budget-room', 200_000)
    const budget = getRequestBudget(
      'smoke-budget-room',
      payloadOfTokens(50_000),
      16_384,
    )
    expect(budget.window).toBe(200_000)
    expect(budget.maxOutput).toBe(16_384)
    expect(budget.windowLimited).toBe(false)
    expect(budget.starved).toBe(false)
  })

  test('clamp bites but stays usable -> windowLimited, not starved', () => {
    recordObservedContextLimit('smoke-budget-tight', 65_536)
    const budget = getRequestBudget(
      'smoke-budget-tight',
      payloadOfTokens(60_000),
      16_384,
    )
    expect(budget.maxOutput).toBe(4_512)
    expect(budget.windowLimited).toBe(true)
    expect(budget.starved).toBe(false)
  })

  test('input past the window -> starved, never a silent 512', () => {
    recordObservedContextLimit('smoke-budget-full', 65_536)
    const budget = getRequestBudget(
      'smoke-budget-full',
      payloadOfTokens(70_000),
      16_384,
    )
    expect(budget.maxOutput).toBeLessThan(MIN_USABLE_OUTPUT_TOKENS)
    expect(budget.starved).toBe(true)
    expect(budget.windowLimited).toBe(true)
    expect(budget.availableOutput).toBeLessThan(0)
  })

  test('boundary at exactly the usable floor is not starved', () => {
    recordObservedContextLimit('smoke-budget-edge', 65_536)
    // 65_536 - input - 1024 = 4_096  =>  input = 60_416 tokens
    const budget = getRequestBudget(
      'smoke-budget-edge',
      payloadOfTokens(60_416),
      16_384,
    )
    expect(budget.maxOutput).toBe(MIN_USABLE_OUTPUT_TOKENS)
    expect(budget.starved).toBe(false)
  })

  test('a deliberate small requested ceiling is not reported as starved', () => {
    recordObservedContextLimit('smoke-budget-small-request', 200_000)
    const budget = getRequestBudget(
      'smoke-budget-small-request',
      payloadOfTokens(10_000),
      2_048,
    )
    expect(budget.maxOutput).toBe(2_048)
    expect(budget.starved).toBe(false)
  })

  test('getRequestBudget agrees with clampMaxOutputTokensToWindow', () => {
    recordObservedContextLimit('smoke-budget-agree', 65_536)
    const payload = payloadOfTokens(60_000)
    const budget = getRequestBudget('smoke-budget-agree', payload, 16_384)
    expect(budget.maxOutput).toBe(
      clampMaxOutputTokensToWindow('smoke-budget-agree', 16_384, 60_000),
    )
    expect(budget.window).toBe(getContextWindowForModel('smoke-budget-agree'))
  })
})

describe('output budget: window source attribution', () => {
  test('maxContextTokens cap is reported as settings-cap', () => {
    // The cap only becomes the source when it lowers the resolved window.
    setSessionSettingsCache({
      settings: { maxContextTokens: 100_000 } as never,
      errors: [],
    })
    expect(getContextWindowSource('smoke-source-model')).toBe('settings-cap')
  })

  test('modelContextWindows entry is reported as model-map', () => {
    setSessionSettingsCache({
      settings: {
        modelContextWindows: { 'smoke-source-map': 131_072 },
      } as never,
      errors: [],
    })
    expect(getContextWindowSource('smoke-source-map')).toBe('model-map')
  })

  test('self-calibrated limit is reported as observed', () => {
    recordObservedContextLimit('smoke-source-observed', 131_072)
    expect(getContextWindowSource('smoke-source-observed')).toBe('observed')
  })

  test('unknown model falls back to the default window source', () => {
    expect(getContextWindowSource('smoke-source-plain')).toBe('default')
  })
})

describe('output budget: dual deployment (240k / 262k)', () => {
  test('same settings yield the same budget on both deployments', () => {
    setSessionSettingsCache({
      settings: { maxContextTokens: 240_000 } as never,
      errors: [],
    })
    const payload = payloadOfTokens(100_000)

    // Deployment A: server advertises exactly 240k.
    clearObservedContextLimits()
    recordObservedContextLimit('qwen3.5-double', 240_000)
    const a = getRequestBudget('qwen3.5-double', payload, 16_384)

    // Deployment B: server advertises 262144.
    clearObservedContextLimits()
    recordObservedContextLimit('qwen3.5-double', 262_144)
    const b = getRequestBudget('qwen3.5-double', payload, 16_384)

    expect(a.window).toBe(240_000)
    expect(b.window).toBe(240_000)
    expect(a.maxOutput).toBe(b.maxOutput)
    expect(a.starved).toBe(false)
    expect(b.starved).toBe(false)
  })
})

describe('output budget: message text', () => {
  test('starvation message names the knobs that actually work', () => {
    recordObservedContextLimit('smoke-budget-text', 240_000)
    const budget = getRequestBudget(
      'smoke-budget-text',
      payloadOfTokens(239_000),
      16_384,
    )
    expect(budget.starved).toBe(true)
    const text = formatBudgetStarvationMessage(budget)
    expect(text).toContain('240000')
    expect(text).toContain('/compact')
    expect(text).toContain('maxContextTokens')
    // The env var cannot help: the clamp runs after it.
    expect(text).not.toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
  })
})

describe('output budget: error taxonomy routing', () => {
  const assistantWith = (apiError: string) =>
    ({ type: 'assistant', apiError, isApiErrorMessage: true }) as never

  test('caller-ceiling cuts stay on the continuation-retry path', () => {
    const msg = assistantWith(OUTPUT_API_ERROR_MAX_TOKENS)
    expect(isMaxOutputTokensMessage(msg)).toBe(true)
    expect(isWithheldMaxOutputTokens(msg)).toBe(true)
    expect(isBudgetStarvation(msg)).toBe(false)
  })

  test('window-limited cuts skip continuation and go to compaction', () => {
    const msg = assistantWith(OUTPUT_API_ERROR_WINDOW_LIMITED)
    expect(isWindowLimitedOutputMessage(msg)).toBe(true)
    expect(isWithheldMaxOutputTokens(msg)).toBe(true)
    expect(isBudgetStarvation(msg)).toBe(true)
  })

  test('refused-before-dispatch errors go to compaction', () => {
    const msg = assistantWith(OUTPUT_API_ERROR_BUDGET_STARVED)
    expect(isBudgetStarvedMessage(msg)).toBe(true)
    expect(isBudgetStarvation(msg)).toBe(true)
    // Refused requests never reached max_tokens handling.
    expect(isMaxOutputTokensMessage(msg)).toBe(false)
  })

  test('unrelated errors are not captured by any predicate', () => {
    const msg = assistantWith('rate_limit')
    expect(isWithheldMaxOutputTokens(msg)).toBe(false)
    expect(isBudgetStarvation(msg)).toBe(false)
  })
})
