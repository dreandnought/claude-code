/**
 * vllmQueue visibility — querySource 前后台分类表（方案 v1 §4 / v2.1 沿用）
 *
 * 硬约束：前台（用户可感知等待）阻塞必有提示；后台静默请求零提示零轮询。
 * 表外新增 source 默认归后台 + 一次性 warning 便于补表。
 */
import type { QuerySource } from '../../../constants/querySource.js'
import { logForDebugging } from '../../../utils/debug.js'

/** 用户正在等结果的来源 —— 排队提示覆盖这些请求 */
const FOREGROUND_QUERY_SOURCES = new Set<string>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'side_question',
  'verification_agent',
])

/**
 * 后台但用户其实偶有感知的灰区（hooks 注入输出）：P0 归后台不提示，
 * 与方案 v1 §4.2 一致 —— 宁可漏提示也不到处弹。
 */
const KNOWN_BACKGROUND = new Set<string>([
  'hook_agent',
  'hook_prompt',
  'auto_mode',
  'bash_classifier',
  'title',
  'summary',
  'suggestion',
  'classifier',
])

const warned = new Set<string>()

export function isForegroundQuerySource(
  querySource: QuerySource | undefined,
): boolean {
  if (querySource === undefined) {
    // 未打标签的调用路径：保守归前台（漏提示比错归后台更糟的是
    // 用户干等无提示；v1 §4.1 同语义）
    return true
  }
  if (FOREGROUND_QUERY_SOURCES.has(querySource)) return true
  if (KNOWN_BACKGROUND.has(querySource)) return false
  // 表外新来源：默认后台 + 一次性 warning（方案 §4.2 保守条款）
  if (!warned.has(querySource)) {
    warned.add(querySource)
    logForDebugging(
      `[vllmQueue] unknown querySource "${querySource}" defaulted to background — add to visibility table if user-visible`,
    )
  }
  return false
}

export function __resetVisibilityWarnsForTests(): void {
  warned.clear()
}
