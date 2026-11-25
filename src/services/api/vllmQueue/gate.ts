/**
 * vllmQueue gate — 请求级编排入口（方案 v2.1 §4，批次3接线）
 *
 * 单点承担：queueDisplay 门禁短路 → 前后台判定 → ledger 记账 → 前台在途计数
 * → metrics 轮询 → 估算 → QueueStatus 发布（statusStore）。
 *
 * 调用方（openai 客户端处）包一层 withQueueHints；queueDisplay=off 或非本机
 * 端点时本函数原样快速返回，零 fetch 零落盘（验收12 的钉点）。
 */
import { logForDebugging } from '../../../utils/debug.js'
import type { QuerySource } from '../../../constants/querySource.js'
import {
  diffsForEndpoint,
  endpointKeyOf,
  getQueueDisplayMode,
  getSnapshot,
  getVllmQueueHints,
  isPrivateVllmCapableBaseUrl,
  trackForegroundInFlight,
  type ProbeFetch,
} from './probe.js'
import { isForegroundQuerySource } from './visibility.js'
import { aheadLocalFor, complete, enqueue } from './ledger.js'
import { estimateQueue, type ModelEstimate } from './model.js'
import { renderQueueLine } from './estimate.js'
import { clearQueueStatus, publishQueueStatus } from './statusStore.js'

export interface GateDeps {
  fetchImpl: ProbeFetch
  now: () => number
}

export interface GateOptions {
  baseUrl: string
  querySource?: QuerySource
  /** 展示后缀，如 subagent 名称 */
  suffix?: string
  /** 测试注入；默认 globalThis.fetch + Date.now */
  deps?: GateDeps
}

export interface QueueHandle {
  /**
   * 本句柄是否真的启动了排队观察。false 的句柄只用于让调用方统一 dispose，
   * 调用方不得据此改动请求/响应对象（排队机制必须保持纯外挂，零侵入）。
   */
  active: boolean
  dispose: () => void
}

const NOOP: QueueHandle = { active: false, dispose: () => {} }

let keySeq = 0

const defaultDeps: GateDeps = {
  fetchImpl: ((url: string, init: { signal: AbortSignal }) =>
    globalThis.fetch(url, {
      signal: init.signal,
      headers: { accept: 'text/plain' },
    })) as unknown as ProbeFetch,
  now: () => Date.now(),
}

/**
 * 开始一次排队观察。返回 dispose：调用方在拿到首 token / 请求终止时必须调用。
 * off / 非本机 / 后台请求 → 立即返回 NOOP，零执行。
 */
export function withQueueHints(opts: GateOptions): QueueHandle {
  if (getQueueDisplayMode() === 'off') return NOOP
  if (!isPrivateVllmCapableBaseUrl(opts.baseUrl)) return NOOP
  if (!isForegroundQuerySource(opts.querySource)) return NOOP

  const deps = opts.deps ?? defaultDeps
  const hints = getVllmQueueHints()
  const endpointKey = endpointKeyOf(opts.baseUrl)
  const key = `q${keySeq++}`

  const ticket = enqueue(
    endpointKey,
    ownerKindOf(opts.querySource),
    key,
    deps.now(),
  )
  trackForegroundInFlight(opts.baseUrl, 1)

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastAhead: number | null = null

  const publishTick = async (): Promise<void> => {
    if (stopped) return
    try {
      const snap = await getSnapshot(opts.baseUrl, deps)
      if (snap !== null && !stopped) {
        const est = estimateQueue({
          snapshot: snap,
          diffs: diffsForEndpoint(opts.baseUrl),
          aheadLocal: aheadLocalFor(ticket),
          snapshotAgeMs: Math.max(0, deps.now() - snap.fetchedAt),
        })
        const rendered = renderQueueLine(est, {
          uncertaintyHints: hints.uncertaintyHints,
          suffix: opts.suffix,
        })
        if (rendered.show && acceptable(est, lastAhead)) {
          publishQueueStatus({
            line: rendered.text,
            key,
            publishedAt: deps.now(),
          })
          lastAhead = est.ahead
        }
      }
    } catch (err) {
      logForDebugging(`[vllmQueue] poll tick failed: ${String(err)}`)
    }
    if (!stopped) {
      timer = setTimeout(() => void publishTick(), hints.pollMs)
    }
  }

  // thresholdMs 内正常推理不打扰；超时后先立即一拍，再按 pollMs 轮询（§4.4-2）
  timer = setTimeout(
    () => void publishTick(),
    Math.max(0, Math.min(hints.thresholdMs, 2000)),
  )

  return {
    active: true,
    dispose: () => {
      if (stopped) return // 幂等：头/首块/错误多路径都可能触发
      stopped = true
      if (timer !== null) clearTimeout(timer)
      trackForegroundInFlight(opts.baseUrl, -1)
      complete(ticket)
      clearQueueStatus(key)
    },
  }
}

/** 位次单调性：同一请求内「前面 N 个」跳升 >1.6× 视为快照抖动，吞一拍防闪烁 */
function acceptable(est: ModelEstimate, lastAhead: number | null): boolean {
  if (lastAhead === null) return true
  return est.ahead <= Math.max(lastAhead * 1.6, lastAhead + 2)
}

function ownerKindOf(
  qs: QuerySource | undefined,
): 'main' | 'subagent' | 'compact' | 'unknown' {
  if (qs === undefined) return 'unknown'
  if (qs.startsWith('repl_main_thread') || qs === 'sdk') return 'main'
  if (qs === 'compact') return 'compact'
  if (qs.startsWith('agent:') || qs.startsWith('hook_')) return 'subagent'
  return 'unknown'
}
