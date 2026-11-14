import { describe, expect, mock, test } from 'bun:test'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

// Cut the bootstrap/state dependency chain (mock.module requirement).
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

// Other test files in the suite replace slowOperations with a partial mock
// that lacks the `slowLogging` tag used by the fs layer. Restore a complete
// module so the permission path checks can run regardless of test order.
const realSlowOperations = await import('../../slowOperations.js')
mock.module('src/utils/slowOperations.ts', () => ({
  ...realSlowOperations,
  slowLogging: (): Disposable => ({
    [Symbol.dispose]: () => {},
  }),
}))

// MACRO is a build-time define injected by `bun --define` (see
// scripts/dev.ts → -d flags). Without it, `declare const MACRO` references
// in source code resolve to `undefined` at runtime and crash any function
// that touches `MACRO.VERSION`.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const { checkWorkingDirectoryBoundary } = await import(
  '../workingDirectoryBoundary.js'
)
const { hasPermissionsToUseTool } = await import('../permissions.js')
const { checkPathSafetyForAutoEdit } = await import('../filesystem.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { getClaudeConfigHomeDir } = await import('../../envUtils.js')
const { getOriginalCwd } = await import('../../../bootstrap/state.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function makeContext(overrides: Partial<Ctx> = {}): Ctx {
  return { ...getEmptyToolPermissionContext(), ...overrides } as Ctx
}

function makeFileTool(name: string, pathField: string) {
  return {
    name,
    getPath: (input: { [key: string]: unknown }) => input[pathField] as string,
  } as any
}

const READ_TOOL = makeFileTool('Read', 'file_path')
const WRITE_TOOL = makeFileTool('Write', 'file_path')
const GLOB_TOOL = makeFileTool('Glob', 'path')

// The session's working directory, not process.cwd(): other test files may
// have changed the process directory, and the boundary is defined against the
// directory the session started in.
const cwd = getOriginalCwd()
const INSIDE = join(cwd, 'src/utils/permissions/workingDirectoryBoundary.ts')
const OUTSIDE = join(cwd, '..', 'outside-the-project.txt')

describe('working directory boundary — reads', () => {
  test('allows reads inside the working directory when the boundary is on', () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: INSIDE },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('denies reads outside the working directory when the boundary is on', () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: OUTSIDE },
      ctx,
    )
    expect(decision?.behavior).toBe('deny')
    expect(decision?.decisionReason?.type).toBe('safetyCheck')
  })

  test('allows reads outside the working directory when the boundary is off', () => {
    const ctx = makeContext()
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: OUTSIDE },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('read boundary does not block writes when only reads are blocked', () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      WRITE_TOOL,
      { file_path: OUTSIDE },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('additional working directories are inside the boundary', () => {
    const additional = new Map([
      ['/tmp', { path: '/tmp', source: 'cliArg' as const }],
    ])
    const ctx = makeContext({
      blockReadsOutsideWorkingDirectories: true,
      additionalWorkingDirectories: additional,
    })
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: '/tmp/some-file.txt' },
      ctx,
    )
    expect(decision).toBeNull()
  })
})

describe('working directory boundary — writes', () => {
  test('denies writes outside the working directory when the boundary is on', () => {
    const ctx = makeContext({ blockWritesOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      WRITE_TOOL,
      { file_path: OUTSIDE },
      ctx,
    )
    expect(decision?.behavior).toBe('deny')
  })

  test('allows writes inside the working directory when the boundary is on', () => {
    const ctx = makeContext({ blockWritesOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      WRITE_TOOL,
      { file_path: INSIDE },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('write boundary does not block reads when only writes are blocked', () => {
    const ctx = makeContext({ blockWritesOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: OUTSIDE },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('relative paths are resolved against the working directory', () => {
    const ctx = makeContext({ blockWritesOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(
      WRITE_TOOL,
      { file_path: 'src/utils/permissions/workingDirectoryBoundary.ts' },
      ctx,
    )
    expect(decision).toBeNull()
  })
})

describe('session transcript protection', () => {
  const transcript = join(
    getClaudeConfigHomeDir(),
    'projects',
    'some-project',
    'session-id.jsonl',
  )

  test('denies writes to a session transcript even with no boundary configured', () => {
    const ctx = makeContext()
    const decision = checkWorkingDirectoryBoundary(
      WRITE_TOOL,
      { file_path: transcript },
      ctx,
    )
    expect(decision?.behavior).toBe('deny')
    expect(decision?.decisionReason?.type).toBe('safetyCheck')
  })

  test('does not block reads of a session transcript', () => {
    const ctx = makeContext()
    const decision = checkWorkingDirectoryBoundary(
      READ_TOOL,
      { file_path: transcript },
      ctx,
    )
    expect(decision).toBeNull()
  })
})

describe('non-file tools are not governed by the boundary', () => {
  test('bash is untouched', () => {
    const ctx = makeContext({
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    })
    const decision = checkWorkingDirectoryBoundary(
      { name: 'Bash' } as any,
      { command: 'cat /etc/passwd' },
      ctx,
    )
    expect(decision).toBeNull()
  })

  test('glob without a path defaults to the working directory', () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const decision = checkWorkingDirectoryBoundary(GLOB_TOOL, {}, ctx)
    expect(decision).toBeNull()
  })
})

describe('the boundary is not widened by the permission mode', () => {
  async function decideWithMode(ctx: Ctx, mode: string) {
    const context = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: { ...ctx, mode } }),
      options: { isNonInteractiveSession: true },
    } as any
    return hasPermissionsToUseTool(
      READ_TOOL,
      { file_path: OUTSIDE },
      context,
      undefined as any,
      'tool-use-id',
    )
  }

  test('bypassPermissions still cannot read outside the working directory', async () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const result = await decideWithMode(ctx, 'bypassPermissions')
    expect(result.behavior).toBe('deny')
  })

  test('acceptEdits still cannot read outside the working directory', async () => {
    const ctx = makeContext({ blockReadsOutsideWorkingDirectories: true })
    const result = await decideWithMode(ctx, 'acceptEdits')
    expect(result.behavior).toBe('deny')
  })
})

describe('shell startup file protection', () => {
  test('blocks editing shell startup files', () => {
    for (const file of [
      '/home/user/.zshenv',
      '/home/user/.zlogin',
      '/home/user/.bash_login',
      '/home/user/.bash_logout',
      '/home/user/.netrc',
      '/home/user/.npmrc',
    ]) {
      const result = checkPathSafetyForAutoEdit(file)
      expect(result.safe).toBe(false)
    }
  })

  test('blocks editing ~/.config/git/', () => {
    const result = checkPathSafetyForAutoEdit('/home/user/.config/git/config')
    expect(result.safe).toBe(false)
  })

  test('leaves ordinary project files alone', () => {
    const result = checkPathSafetyForAutoEdit(
      join(cwd, 'src/utils/permissions/filesystem.ts'),
    )
    expect(result.safe).toBe(true)
  })
})
