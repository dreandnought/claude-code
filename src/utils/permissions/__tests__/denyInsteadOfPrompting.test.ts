import { describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const { hasPermissionsToUseTool } = await import('../permissions.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function makeContext(overrides: Partial<Ctx> = {}): Ctx {
  return { ...getEmptyToolPermissionContext(), ...overrides } as Ctx
}

const passthroughTool = {
  name: 'SomeTool',
  inputSchema: z.object({ value: z.string() }),
  checkPermissions: async () => ({ behavior: 'passthrough' as const }),
} as any

function makeToolUseContext(ctx: Ctx) {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: ctx,
    }),
    options: { isNonInteractiveSession: true },
  } as any
}

async function decide(ctx: Ctx) {
  return hasPermissionsToUseTool(
    passthroughTool,
    { value: 'x' },
    makeToolUseContext(ctx),
    undefined as any,
    'tool-use-id',
  )
}

describe('denyInsteadOfPrompting', () => {
  test('an ask becomes a deny when permission prompts are disabled', async () => {
    const ctx = makeContext({ denyInsteadOfPrompting: true })
    const result = await decide(ctx)
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('permission prompts are disabled')
    }
  })

  test('the ask is left alone when the setting is off', async () => {
    const ctx = makeContext()
    const result = await decide(ctx)
    expect(result.behavior).toBe('ask')
  })

  test('dontAsk mode still denies with its own message', async () => {
    const ctx = makeContext({ mode: 'dontAsk' as const })
    const result = await decide(ctx)
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain("don't ask mode")
    }
  })

  test('the denial is auditable through decisionReason', async () => {
    const ctx = makeContext({ denyInsteadOfPrompting: true })
    const result = await decide(ctx)
    expect(result.decisionReason?.type).toBe('other')
    if (result.decisionReason?.type === 'other') {
      expect(result.decisionReason.reason).toBe(
        'permission prompts are disabled',
      )
    }
  })
})
