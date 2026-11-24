/**
 * 批次 2 冒烟测试：CJK 估算 + 压缩摘要预算自愈。
 *
 * 契约：
 * 1. 估算口径对中文不再 4× 低估（否则压缩阈值/钳制与服务端真实用量对不上）
 * 2. CLAUDE_CODE_TOKEN_ESTIMATOR=legacy 一键回退旧口径（回归对照）
 * 3. 压缩摘要输入超预算时按 API-round 分组丢弃最旧段；截断的摘要响应
 *    （stop_reason=max_tokens）被识别、触发重试而不是当成正常摘要
 * 4. 工具结果按消息聚合预算改用 token 口径（50k tokens），与估算器一致
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createUserMessage,
  createAssistantMessage,
} from '../../src/utils/messages'
import type { Message } from '../../src/types/message'
import {
  estimateTokensFromPayload,
  getContextWindowForModel,
} from '../../src/utils/context'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../../src/services/tokenEstimation'
import {
  getCompactInputBudgetTokens,
  isTruncatedSummaryResponse,
  truncateHeadToTokenBudget,
  MIN_COMPACT_SUMMARY_TOKENS,
} from '../../src/services/compact/compact'
import { MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS } from '../../src/constants/toolLimits'
import { getPerMessageBudgetLimitTokens } from '../../src/utils/toolResultStorage'
import {
  clearObservedContextLimits,
  recordObservedContextLimit,
} from '../../src/utils/contextLimitOverride'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'

beforeEach(() => {
  delete process.env.CLAUDE_CODE_TOKEN_ESTIMATOR
  clearObservedContextLimits()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_TOKEN_ESTIMATOR
  clearObservedContextLimits()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

describe('CJK-aware token estimation', () => {
  test('pure Chinese text estimates ~1 token per character', () => {
    const text = '你好世界'.repeat(1_000) // 4000 chars
    expect(roughTokenCountEstimation(text)).toBe(4_000)
  })

  test('ascii prose keeps the 4-chars-per-token ratio', () => {
    expect(roughTokenCountEstimation('a'.repeat(4_000))).toBe(1_000)
  })

  test('mixed text splits by script', () => {
    // 2000 CJK + 4000 ascii => 2000 + 1000 = 3000
    const text = '你好'.repeat(1_000) + 'x'.repeat(4_000)
    expect(roughTokenCountEstimation(text)).toBe(3_000)
  })

  test('dense json ratio applies to non-CJK part only', () => {
    const json = JSON.stringify({ k: '你好世界' })
    const legacy = Math.ceil(json.length / 2)
    expect(roughTokenCountEstimation(json, 2)).toBeLessThanOrEqual(legacy + 4)
  })

  test('legacy estimator restores length/4 exactly', () => {
    process.env.CLAUDE_CODE_TOKEN_ESTIMATOR = 'legacy'
    const text = '你好世界'.repeat(1_000)
    expect(roughTokenCountEstimation(text)).toBe(1_000)
    // payload adds JSON framing ({"t":"..."} = 8 extra chars)
    expect(estimateTokensFromPayload({ t: 'a'.repeat(4_000) })).toBe(1_002)
  })

  test('payload estimate accounts for CJK', () => {
    const payload = { role: 'user', content: '你好'.repeat(2_000) }
    const est = estimateTokensFromPayload(payload)
    // 4000 CJK chars alone ≈ 4000 tokens; framing adds a bit.
    expect(est).toBeGreaterThanOrEqual(4_000)
    expect(est).toBeLessThan(4_300)
  })
})

describe('compact input budget', () => {
  test('budget = window − buffer − min summary reserve', () => {
    recordObservedContextLimit('b2-compact-model', 240_000)
    expect(getContextWindowForModel('b2-compact-model')).toBe(240_000)
    expect(getCompactInputBudgetTokens('b2-compact-model')).toBe(
      240_000 - 1_024 - MIN_COMPACT_SUMMARY_TOKENS,
    )
  })

  test('maxContextTokens cap flows into the compact budget', () => {
    setSessionSettingsCache({
      settings: { maxContextTokens: 240_000 } as never,
      errors: [],
    })
    recordObservedContextLimit('b2-cap-model', 262_144)
    expect(getCompactInputBudgetTokens('b2-cap-model')).toBe(
      240_000 - 1_024 - MIN_COMPACT_SUMMARY_TOKENS,
    )
  })
})

/** Build `rounds` API-round groups of ~tokensPerRound tokens each. */
function makeRounds(rounds: number, tokensPerRound: number): Message[] {
  const msgs: Message[] = []
  const filler = 'x'.repeat(tokensPerRound * 4)
  for (let i = 0; i < rounds; i++) {
    msgs.push(
      createUserMessage({ content: `round-${i} ${filler}` }) as Message,
      createAssistantMessage({ content: `answer-${i} ${filler}` }) as Message,
    )
  }
  return msgs
}

describe('truncateHeadToTokenBudget', () => {
  test('under-budget input is returned unchanged', () => {
    const messages = makeRounds(2, 1_000)
    const out = truncateHeadToTokenBudget(messages, 100_000)
    expect(out).toBe(messages)
  })

  test('over-budget input drops oldest API-round groups', () => {
    const messages = makeRounds(10, 10_000) // ~200k tokens total
    const out = truncateHeadToTokenBudget(messages, 100_000)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThan(messages.length)
    // Oldest content is gone; newest survives.
    const flat = JSON.stringify(out)
    expect(flat).toContain('answer-9')
    expect(flat).not.toContain('round-0')
  })

  test('always keeps at least one group', () => {
    const messages = makeRounds(3, 50_000)
    const out = truncateHeadToTokenBudget(messages, 1_000)
    expect(out).not.toBeNull()
    expect(out!.length).toBeGreaterThan(0)
    expect(JSON.stringify(out)).toContain('answer-2')
  })

  test('single-group input cannot be truncated', () => {
    // One user message only → groupMessagesByApiRound yields <2 groups
    const messages = [
      createUserMessage({ content: 'x'.repeat(200_000) }) as Message,
    ]
    const out = truncateHeadToTokenBudget(messages, 1_000)
    expect(out).toBeNull()
  })

  test('estimate used for budgeting is CJK-aware', () => {
    const cn = '你好'.repeat(40_000) // 80k chars => ~80k tokens, legacy said 20k
    const messages = [
      createUserMessage({ content: cn }) as Message,
      createAssistantMessage({ content: 'ok' }) as Message,
    ]
    expect(roughTokenCountEstimationForMessages(messages)).toBeGreaterThan(
      70_000,
    )
  })
})

describe('isTruncatedSummaryResponse', () => {
  test('stop_reason=max_tokens flags truncation', () => {
    const msg = {
      type: 'assistant',
      message: { stop_reason: 'max_tokens', content: [] },
    } as never
    expect(isTruncatedSummaryResponse(msg)).toBe(true)
  })

  test('window-exceeded stop reason flags truncation', () => {
    const msg = {
      type: 'assistant',
      message: { stop_reason: 'model_context_window_exceeded', content: [] },
    } as never
    expect(isTruncatedSummaryResponse(msg)).toBe(true)
  })

  test('normal end_turn is not truncation', () => {
    const msg = {
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [] },
    } as never
    expect(isTruncatedSummaryResponse(msg)).toBe(false)
  })
})

describe('tool result message budget in token units', () => {
  test('default budget is 50k tokens', () => {
    expect(getPerMessageBudgetLimitTokens()).toBe(
      MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS,
    )
    expect(MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS).toBe(50_000)
  })
})
