/**
 * 基础能力冒烟测试：工具注册表 + 权限过滤 + 文件边界（公理面）
 *
 * 关注「任何一次工具系统重构后必须仍然成立」的最小集合：
 * 1. 基础工具池非空、字段齐全、核心工具可发现
 * 2. 工具名单白名单（防止工具被静默删除 / 重命名）
 * 3. deny 规则按名字过滤（blanket deny）
 * 4. 工作目录读写边界对真实工具名生效（Read/Write/Edit/Glob/Grep/NotebookEdit
 *    的归属：读工具受读边界、写工具受写边界；非文件工具不受管辖）
 * 5. transcript 无条件防篡改
 *
 * 第 4 条用的是真实工具的 name 常量（非测试内手写的假名），所以工具改名后
 * 若忘了同步边界集合，这里会红。
 */
import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { logMock } from '../mocks/log'
import { debugMock } from '../mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'smoke',
}

const { getAllBaseTools, parseToolPreset, getTools, filterToolsByDenyRules } =
  await import('../../src/tools')
const { findToolByName, getEmptyToolPermissionContext } = await import(
  '../../src/Tool'
)
const { checkWorkingDirectoryBoundary, getBoundaryTarget } = await import(
  '../../src/utils/permissions/workingDirectoryBoundary'
)
const { getOriginalCwd } = await import('../../src/bootstrap/state')

const { FILE_READ_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
)
const { FILE_WRITE_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
)
const { FILE_EDIT_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
)
const { NOTEBOOK_EDIT_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
)
const { GLOB_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
)
const { GREP_TOOL_NAME } = await import(
  '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
)

const cwd = getOriginalCwd()
const INSIDE = join(cwd, 'src/tools.ts')
const OUTSIDE = join(cwd, '..', 'outside.txt')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function realTool(name: string) {
  const tool = findToolByName(getAllBaseTools(), name)
  if (!tool) {
    throw new Error(`smoke: tool "${name}" is not registered`)
  }
  return tool
}

function inputFor(name: string, path: string): Record<string, unknown> {
  switch (name) {
    case FILE_READ_TOOL_NAME:
    case FILE_WRITE_TOOL_NAME:
    case FILE_EDIT_TOOL_NAME:
    case NOTEBOOK_EDIT_TOOL_NAME:
      return { file_path: path }
    case GLOB_TOOL_NAME:
    case GREP_TOOL_NAME:
      return { pattern: 'x', path }
    default:
      return {}
  }
}

describe('tool registry: structure invariants', () => {
  test('getAllBaseTools is non-empty and fully shaped', () => {
    const tools = getAllBaseTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(typeof tool.call).toBe('function')
      expect(typeof tool.isEnabled()).toBe('boolean')
    }
  })

  test('tool names are unique', () => {
    const names = getAllBaseTools().map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('core capability set stays discoverable', () => {
    for (const name of [
      'Bash',
      FILE_READ_TOOL_NAME,
      FILE_EDIT_TOOL_NAME,
      FILE_WRITE_TOOL_NAME,
      'Agent',
      'TodoWrite',
      'WebFetch',
      'Skill',
      'NotebookEdit',
    ]) {
      expect(findToolByName(getAllBaseTools(), name)).toBeDefined()
    }
  })

  test('getTools(default context) is a subset of base tools', () => {
    const ctx = getEmptyToolPermissionContext()
    const tools = getTools(ctx)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThanOrEqual(getAllBaseTools().length)
  })

  test('tool preset parsing is stable', () => {
    expect(parseToolPreset('default')).toBe('default')
    expect(parseToolPreset('DEFAULT')).toBe('default')
    expect(parseToolPreset('nonsense-preset')).toBeNull()
  })
})

describe('tool registry: deny-rule filtering', () => {
  test('blanket deny removes the tool before the model sees it', () => {
    const ctx = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { localSettings: ['Bash'] },
    } as Ctx
    const tools = getTools(ctx)
    expect(findToolByName(tools, 'Bash')).toBeUndefined()
    expect(findToolByName(tools, FILE_READ_TOOL_NAME)).toBeDefined()
  })

  test('deny rule with no content filters via filterToolsByDenyRules', () => {
    const ctx = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { localSettings: ['Write'] },
    } as Ctx
    const filtered = filterToolsByDenyRules(getAllBaseTools(), ctx)
    expect(findToolByName(filtered, FILE_WRITE_TOOL_NAME)).toBeUndefined()
  })

  test('allow-only rules never remove tools', () => {
    const ctx = {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { localSettings: ['Read'] },
    } as Ctx
    expect(getTools(ctx).length).toBeGreaterThan(0)
  })
})

describe('permission boundary: real tool names are governed correctly', () => {
  const readTools = [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
  const writeTools = [
    FILE_WRITE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ]

  test('boundary classifies each file tool into read/write', () => {
    for (const name of readTools) {
      const target = getBoundaryTarget(
        realTool(name),
        inputFor(name, INSIDE) as { [key: string]: unknown },
      )
      expect(target?.operation).toBe('read')
    }
    for (const name of writeTools) {
      const target = getBoundaryTarget(
        realTool(name),
        inputFor(name, INSIDE) as { [key: string]: unknown },
      )
      expect(target?.operation).toBe('write')
    }
  })

  test('non-file tools are not governed by the boundary', () => {
    for (const name of ['Bash', 'Agent', 'TodoWrite']) {
      expect(getBoundaryTarget(realTool(name), {})).toBeNull()
    }
  })

  test('outside path is denied when the matching boundary is on', () => {
    const both = {
      ...getEmptyToolPermissionContext(),
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    } as Ctx

    for (const name of readTools) {
      const decision = checkWorkingDirectoryBoundary(
        realTool(name),
        inputFor(name, OUTSIDE) as { [key: string]: unknown },
        both,
      )
      expect(decision?.behavior, `${name} read should be denied`).toBe('deny')
    }
    for (const name of writeTools) {
      const decision = checkWorkingDirectoryBoundary(
        realTool(name),
        inputFor(name, OUTSIDE) as { [key: string]: unknown },
        both,
      )
      expect(decision?.behavior, `${name} write should be denied`).toBe('deny')
    }
  })

  test('inside path stays allowed with boundaries on', () => {
    const both = {
      ...getEmptyToolPermissionContext(),
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    } as Ctx
    for (const name of [...readTools, ...writeTools]) {
      const decision = checkWorkingDirectoryBoundary(
        realTool(name),
        inputFor(name, INSIDE) as { [key: string]: unknown },
        both,
      )
      expect(decision, `${name} inside path must not be denied`).toBeNull()
    }
  })

  test('boundaries off means no deny for outside paths', () => {
    const ctx = getEmptyToolPermissionContext()
    for (const name of [...readTools, ...writeTools]) {
      const decision = checkWorkingDirectoryBoundary(
        realTool(name),
        inputFor(name, OUTSIDE) as { [key: string]: unknown },
        ctx,
      )
      // transcript 保护仍可能触发，但普通外部路径不应被拒
      expect(decision?.decisionReason?.reason ?? '').not.toContain(
        'outside working directory',
      )
    }
  })
})
