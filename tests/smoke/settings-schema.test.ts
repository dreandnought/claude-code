/**
 * 基础能力冒烟测试：settings.json 关键配置键的 schema 契约
 *
 * 自定义上下文窗口（modelContextWindows / maxContextTokens）与无人值守安全
 * 边界（denyInsteadOfPrompting / blockReadsOutsideWorkingDirectories /
 * blockWritesOutsideWorkingDirectories）都依赖 settings 键能通过校验并
 * 保留数值。若某次重构把键名拼错、类型收紧或 passthrough 丢失，用户配置会
 * 被静默丢弃——这里在 CI 层直接失败，而不是等运行时行为回归。
 */
import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../../src/utils/settings/types'

function parse(obj: unknown) {
  return SettingsSchema().safeParse(obj)
}

describe('settings schema: context window keys', () => {
  test('modelContextWindows accepts per-model token overrides', () => {
    const result = parse({
      modelContextWindows: { 'glm-4.6': 200_000, 'qwen3-coder': 131_072 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.modelContextWindows?.['glm-4.6']).toBe(200_000)
      expect(result.data.modelContextWindows?.['qwen3-coder']).toBe(131_072)
    }
  })

  test('modelContextWindows coerces string numbers', () => {
    const result = parse({ modelContextWindows: { 'smoke-model': '131072' } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.modelContextWindows?.['smoke-model']).toBe(131_072)
    }
  })

  test('modelContextWindows rejects out-of-range values', () => {
    expect(parse({ modelContextWindows: { tiny: 1024 } }).success).toBe(false)
    expect(parse({ modelContextWindows: { huge: 20_000_000 } }).success).toBe(
      false,
    )
  })

  test('maxContextTokens accepts a sane global cap', () => {
    const result = parse({ maxContextTokens: 150_000 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.maxContextTokens).toBe(150_000)
    }
  })

  test('maxContextTokens rejects too-small values', () => {
    expect(parse({ maxContextTokens: 512 }).success).toBe(false)
  })
})

describe('settings schema: unattended safety keys', () => {
  test('permissions boundary booleans round-trip', () => {
    const result = parse({
      permissions: {
        denyInsteadOfPrompting: true,
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.permissions?.denyInsteadOfPrompting).toBe(true)
      expect(result.data.permissions?.blockReadsOutsideWorkingDirectories).toBe(
        true,
      )
      expect(
        result.data.permissions?.blockWritesOutsideWorkingDirectories,
      ).toBe(true)
    }
  })

  test('permissions reject non-boolean boundary values', () => {
    expect(
      parse({ permissions: { denyInsteadOfPrompting: 'yes' } }).success,
    ).toBe(false)
  })

  test('permissions passthrough keeps unknown future keys', () => {
    const result = parse({ permissions: { someFutureKey: 42 } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(
        (result.data.permissions as Record<string, unknown> | undefined)
          ?.someFutureKey,
      ).toBe(42)
    }
  })
})
