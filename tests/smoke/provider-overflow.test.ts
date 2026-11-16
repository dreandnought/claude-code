/**
 * 基础能力冒烟测试：provider 上下文溢出错误识别与自学习解析
 *
 * 这是自定义上下文窗口（5e20fdd7）闭环的输入端：第三方 OpenAI 兼容端点在
 * 请求超长时返回各家不同文案，系统必须①认出这是溢出错误（触发 reactive
 * compact 重试）②从中解析出真实上限（remember per model）。文案匹配表是
 * 纯字符串契约，重构时最容易被改坏，这里逐 provider 钉住。
 */
import { describe, expect, test } from 'bun:test'
import {
  detectContextOverflowError,
  parseAdvertisedContextLimit,
} from '../../src/services/api/errors'

describe('overflow detection: cross-provider message corpus', () => {
  const overflowCases: Array<[string, string, number | undefined]> = [
    [
      'openai',
      "This model's maximum context length is 131072 tokens. Your request has 150000 input tokens.",
      131_072,
    ],
    ['qwen-dashscope', 'Range of input length should be [1, 129024]', 129_024],
    [
      'generic-too-long',
      'Input messages are too long for this model.',
      undefined,
    ],
    [
      'exceeds-maximum',
      "Your input exceeds the model's maximum context window.",
      undefined,
    ],
    [
      'anthropic-style',
      'input length and `max_tokens` exceed context limit',
      undefined,
    ],
    ['glm-zhipu-cn', '错误：输入内容过长，请缩短后重试', undefined],
    ['context-length-exceeded', 'context_length_exceeded', undefined],
  ]

  for (const [name, message, limit] of overflowCases) {
    test(`recognizes ${name} overflow`, () => {
      const detected = detectContextOverflowError(new Error(message))
      expect(detected, message).not.toBeNull()
      expect(detected?.limit).toBe(limit)
    })
  }

  test('does not misclassify unrelated errors as overflow', () => {
    for (const message of [
      'invalid api key provided',
      '429 rate limit exceeded',
      '502 bad gateway',
      'insufficient credits',
    ]) {
      expect(detectContextOverflowError(new Error(message)), message).toBeNull()
    }
  })

  test('media-size 413 keeps its own recovery path', () => {
    const detected = detectContextOverflowError(
      new Error('The image is too large, maximum size is 5MB'),
    )
    expect(detected).toBeNull()
  })
})

describe('advertised limit parsing', () => {
  test('parses X tokens > Y maximum form (limit is second number)', () => {
    expect(
      parseAdvertisedContextLimit(
        'prompt is too long: 137500 tokens > 135000 maximum',
      ),
    ).toBe(135_000)
  })

  test('parses range form', () => {
    expect(
      parseAdvertisedContextLimit('Range of input length should be [1, 32768]'),
    ).toBe(32_768)
  })

  test('rejects implausible numbers (<4096)', () => {
    expect(
      parseAdvertisedContextLimit('maximum context length is 100 tokens'),
    ).toBeUndefined()
  })

  test('returns undefined when no number present', () => {
    expect(parseAdvertisedContextLimit('input is too long')).toBeUndefined()
  })
})
