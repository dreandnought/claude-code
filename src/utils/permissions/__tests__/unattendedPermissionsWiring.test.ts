import { describe, expect, mock, test } from 'bun:test'
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

let settings: Record<string, unknown> = {}

const realSettings = await import('../../settings/settings.js')
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettings,
  getSettings_DEPRECATED: () => settings,
}))

const { initializeToolPermissionContext } = await import(
  '../permissionSetup.js'
)

async function init(permissionPrompts?: 'ask' | 'none') {
  const result = await initializeToolPermissionContext({
    allowedToolsCli: [],
    disallowedToolsCli: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    addDirs: [],
    permissionPrompts,
  })
  return result.toolPermissionContext
}

describe('unattended permission wiring', () => {
  test('settings.denyInsteadOfPrompting reaches the context', async () => {
    settings = { permissions: { denyInsteadOfPrompting: true } }
    const ctx = await init()
    expect(ctx.denyInsteadOfPrompting).toBe(true)
  })

  test('the CLI flag turns the behaviour on', async () => {
    settings = {}
    const ctx = await init('none')
    expect(ctx.denyInsteadOfPrompting).toBe(true)
  })

  test('an explicit --permission-prompts ask overrides the setting', async () => {
    settings = { permissions: { denyInsteadOfPrompting: true } }
    const ctx = await init('ask')
    expect(ctx.denyInsteadOfPrompting).toBe(false)
  })

  test('nothing is enabled by default', async () => {
    settings = {}
    const ctx = await init()
    expect(ctx.denyInsteadOfPrompting).toBe(false)
    expect(ctx.blockReadsOutsideWorkingDirectories).toBe(false)
    expect(ctx.blockWritesOutsideWorkingDirectories).toBe(false)
  })

  test('working directory boundaries reach the context', async () => {
    settings = {
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
      },
    }
    const ctx = await init()
    expect(ctx.blockReadsOutsideWorkingDirectories).toBe(true)
    expect(ctx.blockWritesOutsideWorkingDirectories).toBe(true)
  })
})
