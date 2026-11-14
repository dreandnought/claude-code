import { isAbsolute, resolve } from 'path'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { detectSessionFileType } from '../memoryFileDetection.js'
import { expandPath } from '../path.js'
import type { PermissionDecision } from './PermissionResult.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  pathInAllowedWorkingPath,
} from './filesystem.js'
import { isPathInSandboxWriteAllowlist } from './pathValidation.js'

/**
 * Hard boundaries for unattended / hardened deployments.
 *
 * Two independent controls live here:
 *
 * 1. Working-directory boundaries (`permissions.blockReadsOutsideWorkingDirectories`
 *    / `permissions.blockWritesOutsideWorkingDirectories`). When enabled, file
 *    tools may only touch paths inside the working directory (plus explicitly
 *    added directories). The check runs before any allow-rule evaluation, so
 *    `bypassPermissions` cannot widen it — the boundary is a property of the
 *    deployment, not of the permission mode.
 *
 * 2. Session transcript protection. The transcript is the audit trail for the
 *    session and the source of truth for rewind; an agent that can rewrite it
 *    can erase evidence of what it did. Writes to transcript files are denied
 *    unconditionally.
 */

export type BoundaryOperation = 'read' | 'write'

type BoundaryTarget = {
  operation: BoundaryOperation
  path: string
}

const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
])

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

/**
 * Extract the path a tool would touch, if it is a file-oriented tool.
 * Uses the tool's own `getPath` when available so the tool stays the single
 * source of truth for "which path does this call operate on".
 */
export function getBoundaryTarget(
  tool: Tool,
  input: { [key: string]: unknown },
): BoundaryTarget | null {
  const name = tool.name

  let operation: BoundaryOperation | null = null
  if (READ_TOOL_NAMES.has(name)) {
    operation = 'read'
  } else if (WRITE_TOOL_NAMES.has(name)) {
    operation = 'write'
  }
  if (!operation) {
    return null
  }

  let path: string | undefined
  if (typeof tool.getPath === 'function') {
    try {
      path = tool.getPath(input)
    } catch {
      path = undefined
    }
  }
  if (typeof path !== 'string' || path.length === 0) {
    // Glob/Grep default to the working directory when no path is given.
    path =
      typeof input.path === 'string' && input.path.length > 0
        ? input.path
        : typeof input.file_path === 'string'
          ? input.file_path
          : undefined
  }
  if (typeof path !== 'string' || path.length === 0) {
    return null
  }

  return { operation, path }
}

/**
 * Paths that are legitimately outside the working directory:
 * - Claude's own internal editable files (plan file, scratchpad, agent memory)
 * - Claude's own internal readable files (project temp dir, session memory)
 * - Sandbox write allowlist entries (the user explicitly declared them writable)
 */
function isInternalOrSandboxAllowed(
  resolvedPath: string,
  operation: BoundaryOperation,
): boolean {
  if (operation === 'write') {
    if (checkEditableInternalPath(resolvedPath, {}).behavior === 'allow') {
      return true
    }
    if (isPathInSandboxWriteAllowlist(resolvedPath)) {
      return true
    }
  }
  if (checkReadableInternalPath(resolvedPath, {}).behavior === 'allow') {
    return true
  }
  return false
}

/**
 * Deny writes that would tamper with the session transcript.
 */
function checkTranscriptProtection(
  resolvedPaths: readonly string[],
  operation: BoundaryOperation,
): PermissionDecision | null {
  if (operation !== 'write') {
    return null
  }
  for (const path of resolvedPaths) {
    if (detectSessionFileType(path) === 'session_transcript') {
      return {
        behavior: 'deny',
        message:
          'Permission to modify the session transcript has been denied. The transcript is the audit record for this session and cannot be edited by tools.',
        decisionReason: {
          type: 'safetyCheck',
          reason: 'Session transcript write blocked',
          classifierApprovable: false,
        },
      }
    }
  }
  return null
}

/**
 * Evaluate the working-directory boundary for a tool call.
 * Returns a deny decision when the call must be blocked, or null when the
 * call is not governed by these boundaries.
 */
export function checkWorkingDirectoryBoundary(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolPermissionContext,
): PermissionDecision | null {
  const target = getBoundaryTarget(tool, input)
  if (!target) {
    return null
  }

  const absolutePath = isAbsolute(target.path)
    ? expandPath(target.path)
    : resolve(getCwd(), expandPath(target.path))

  const resolvedPaths = getPathsForPermissionCheck(absolutePath)

  const transcriptDecision = checkTranscriptProtection(
    resolvedPaths,
    target.operation,
  )
  if (transcriptDecision) {
    return transcriptDecision
  }

  const blockReads = context.blockReadsOutsideWorkingDirectories === true
  const blockWrites = context.blockWritesOutsideWorkingDirectories === true
  if (!blockReads && !blockWrites) {
    return null
  }

  const blocked =
    (target.operation === 'read' && blockReads) ||
    (target.operation === 'write' && blockWrites)
  if (!blocked) {
    return null
  }

  if (pathInAllowedWorkingPath(absolutePath, context, resolvedPaths)) {
    return null
  }

  if (isInternalOrSandboxAllowed(absolutePath, target.operation)) {
    return null
  }

  const verb = target.operation === 'read' ? 'read from' : 'write to'
  return {
    behavior: 'deny',
    message: `Permission to ${verb} ${target.path} has been denied. This path is outside the working directory and ${target.operation === 'read' ? 'reads' : 'writes'} outside the working directory are blocked by configuration.`,
    decisionReason: {
      type: 'safetyCheck',
      reason: `Path outside working directory (${target.operation})`,
      classifierApprovable: false,
    },
  }
}
