/**
 * 基础能力冒烟测试：上下文窗口解析链路
 *
 * 覆盖（对应 commit 5e20fdd7 引入的自定义上下文窗口能力面）：
 * 1. 默认 200k 窗口
 * 2. `[1m]` 后缀显式 1M 与 CLAUDE_CODE_DISABLE_1M_CONTEXT 禁用
 * 3. settings.modelContextWindows 按模型覆盖（精确 + 最长子串匹配）
 * 4. settings.maxContextTokens 全局上限
 * 5. 运行期从 provider 413 错误自学习的 observed limit（取最严格值）
 * 6. clampMaxOutputTokensToWindow 输出预算防溢出
 * 7. CLAUDE_CODE_MAX_CONTEXT_TOKENS 环境变量覆盖
 * 8. estimateTokensFromPayload 粗估
 *
 * 任何一条失效都意味着 compact 预算 / 请求预算回归，第三方长上下文模型
 * （DeepSeek/GLM/Qwen 等）会直接退回 200k 误判或 413 报错。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clampMaxOutputTokensToWindow,
  estimateTokensFromPayload,
  getContextWindowForModel,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from '../../src/utils/context'
import {
  clearObservedContextLimits,
  getObservedContextLimit,
  recordObservedContextLimit,
} from '../../src/utils/contextLimitOverride'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'

const ENV_KEYS = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const

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

describe('context window: baseline resolution', () => {
  test('unknown model falls back to the 200k default', () => {
    expect(getContextWindowForModel('smoke-plain-model')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
    expect(MODEL_CONTEXT_WINDOW_DEFAULT).toBe(200_000)
  })

  test('[1m] suffix opts in to 1M', () => {
    expect(getContextWindowForModel('smoke-model-1m[1m]')).toBe(1_000_000)
  })

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT caps [1m] back to default', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(getContextWindowForModel('smoke-model-1m-disabled[1m]')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
  })

  test('CLAUDE_CODE_MAX_CONTEXT_TOKENS env override wins over raw detection', () => {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '50000'
    expect(getContextWindowForModel('smoke-env-cap-model')).toBe(50_000)
  })
})

describe('context window: settings overrides', () => {
  test('modelContextWindows exact key applies', () => {
    setSessionSettingsCache({
      settings: { modelContextWindows: { 'smoke-glm-a': 131_072 } } as never,
      errors: [],
    })
    expect(getContextWindowForModel('smoke-glm-a')).toBe(131_072)
  })

  test('modelContextWindows longest-substring match applies', () => {
    setSessionSettingsCache({
      settings: { modelContextWindows: { 'glm-4.6': 200_000 } } as never,
      errors: [],
    })
    expect(getContextWindowForModel('bigmodel/GLM-4.6-air')).toBe(200_000)
  })

  test('maxContextTokens caps every resolved window', () => {
    setSessionSettingsCache({
      settings: { maxContextTokens: 100_000 } as never,
      errors: [],
    })
    expect(getContextWindowForModel('smoke-capped-1m[1m]')).toBe(100_000)
  })
})

describe('context window: self-calibrated provider limits', () => {
  test('recorded observed limit is used when no config exists', () => {
    recordObservedContextLimit('smoke-observed-a', 131_072)
    expect(getObservedContextLimit('smoke-observed-a')).toBe(131_072)
    expect(getContextWindowForModel('smoke-observed-a')).toBe(131_072)
  })

  test('configured and observed are combined with min()', () => {
    setSessionSettingsCache({
      settings: {
        modelContextWindows: { 'smoke-observed-b': 200_000 },
      } as never,
      errors: [],
    })
    recordObservedContextLimit('smoke-observed-b', 131_072)
    expect(getContextWindowForModel('smoke-observed-b')).toBe(131_072)
  })

  test('keeps the most restrictive observation', () => {
    recordObservedContextLimit('smoke-observed-c', 131_072)
    recordObservedContextLimit('smoke-observed-c', 65_536)
    recordObservedContextLimit('smoke-observed-c', 262_144)
    expect(getContextWindowForModel('smoke-observed-c')).toBe(65_536)
  })

  test('sane-range filter ignores nonsense limits', () => {
    recordObservedContextLimit('smoke-observed-d', 100)
    recordObservedContextLimit('smoke-observed-e', Number.NaN)
    expect(getObservedContextLimit('smoke-observed-d')).toBeUndefined()
    expect(getObservedContextLimit('smoke-observed-e')).toBeUndefined()
  })

  test('model key normalization merges provider-prefixed ids', () => {
    recordObservedContextLimit('Provider/Smoke-Model-F', 131_072)
    expect(getObservedContextLimit('provider/smoke-model-f')).toBe(131_072)
  })
})

describe('context window: output clamp', () => {
  test('passes through when the window has room', () => {
    expect(
      clampMaxOutputTokensToWindow('smoke-clamp-room', 64_000, 50_000),
    ).toBe(64_000)
  })

  test('clamps to window minus input minus safety buffer', () => {
    recordObservedContextLimit('smoke-clamp-tight', 65_536)
    // 65536 - 60000 - 1024 = 4512
    expect(
      clampMaxOutputTokensToWindow('smoke-clamp-tight', 64_000, 60_000),
    ).toBe(4_512)
  })

  test('floor of 512 output tokens even when input already exceeds window', () => {
    recordObservedContextLimit('smoke-clamp-floor', 65_536)
    expect(
      clampMaxOutputTokensToWindow('smoke-clamp-floor', 64_000, 70_000),
    ).toBe(512)
  })
})

describe('context window: token estimation', () => {
  test('estimateTokensFromPayload uses chars/4', () => {
    expect(estimateTokensFromPayload('a'.repeat(40))).toBe(10)
    expect(estimateTokensFromPayload('abc')).toBe(1)
  })

  test('estimateTokensFromPayload serializes objects', () => {
    const payload = { role: 'user', content: 'x'.repeat(36) }
    expect(estimateTokensFromPayload(payload)).toBe(
      Math.ceil(JSON.stringify(payload).length / 4),
    )
  })
})
