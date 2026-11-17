/**
 * vllmQueue probe — 端点探测 / TTL 缓存 / 单飞轮询 / 差分采样 / 开关门禁
 * （方案 v2.1 §4 批次2；IO 全部走注入的 fetchImpl，离线可测）
 *
 * 关键不变量（验收 12/13/14 对应）：
 * - queueDisplay=off：本模块入口单点短路，零 fetch、零 ledger/校准读写。
 * - 连续 PROBE_FAIL_LIMIT 次拉取失败或整族 vllm:* 缺失 → unsupported，
 *   停止轮询；退避复探 PROBE_RETRY_BASE_MS → PROBE_RETRY_MAX_MS 指数增长。
 * - 瞬时抖动（上次成功本次失败）不摘牌，由调用方按 u=高 处理。
 * - 仅前台在途请求存在时才轮询。
 */
import { getSessionSettingsCache } from '../../../utils/settings/settingsCache.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { VllmSnapshot } from './types.js'
import { parseVllmMetrics } from './metrics.js'

export type ProbeFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export type EndpointState = 'pending' | 'supported' | 'unsupported'

interface PerEndpoint {
  state: EndpointState
  consecutiveFailures: number
  lastSnapshot: VllmSnapshot | null
  lastSuccessAt: number
  lastFailureAt: number
  nextProbeAllowedAt: number
  inflight: Promise<void> | null
  /** 前台在途请求计数（>0 才轮询） */
  foregroundInFlight: number
  /** 差分采样基线（吞吐/抢占/拒绝率） */
  prevCounters: {
    at: number
    promptTokens: number
    generationTokens: number
    preemptions: number
    admissionRejections: number
    prefixQueries: number
    prefixHits: number
  } | null
  diffs: ThroughputDiffs
}

export interface ThroughputDiffs {
  /** EMA 后的 prefill token 吞吐（tok/s），null=尚无差分 */
  prefillTokPerSecEma: number | null
  decodeTokPerSecEma: number | null
  /** 上次快照以来抢占增量（位次可信度信号） */
  preemptionDelta: number
  /** 上次快照以来准入拒绝增量（503 队满侧证） */
  admissionRejectionDelta: number
  /** 累计 prefix 命中率（0–1），样本 0 时 null */
  prefixHitRate: number | null
}

// ---- 常量（pollMs/thresholdMs 可被 settings.vllmQueueHints 覆盖） ----
export const PROBE_DEFAULT_POLL_MS = 1500
export const PROBE_FAIL_LIMIT = 3
export const PROBE_RETRY_BASE_MS = 5 * 60_000
export const PROBE_RETRY_MAX_MS = 30 * 60_000
const PROBE_FETCH_TIMEOUT_MS = 2000
const EMA_ALPHA = 0.3

const endpoints = new Map<string, PerEndpoint>()

function getEp(endpoint: string): PerEndpoint {
  let ep = endpoints.get(endpoint)
  if (!ep) {
    ep = {
      state: 'pending',
      consecutiveFailures: 0,
      lastSnapshot: null,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      nextProbeAllowedAt: 0,
      inflight: null,
      foregroundInFlight: 0,
      prevCounters: null,
      diffs: {
        prefillTokPerSecEma: null,
        decodeTokPerSecEma: null,
        preemptionDelta: 0,
        admissionRejectionDelta: 0,
        prefixHitRate: null,
      },
    }
    endpoints.set(endpoint, ep)
  }
  return ep
}

// ---- queueDisplay 门禁（§6 行为矩阵的入口单点判断） ----

export type QueueDisplayMode = 'off' | 'vllm'

export function getQueueDisplayMode(): QueueDisplayMode {
  const raw = getSessionSettingsCache()?.settings?.queueDisplay
  return raw === 'off' ? 'off' : 'vllm' // 默认 vllm
}

export function getVllmQueueHints(): {
  pollMs: number
  thresholdMs: number
  showEta: boolean
  uncertaintyHints: boolean
  calibration: boolean
  maxLocalConcurrency: number
} {
  const h =
    getSessionSettingsCache()?.settings?.vllmQueueHints ??
    ({} as Record<string, unknown>)
  return {
    pollMs: numberOr(h.pollMs, PROBE_DEFAULT_POLL_MS),
    thresholdMs: numberOr(h.thresholdMs, 8000),
    showEta: h.showEta !== false,
    uncertaintyHints: h.uncertaintyHints !== false,
    calibration: h.calibration !== false,
    maxLocalConcurrency: numberOr(h.maxLocalConcurrency, 0),
  }
}

function numberOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

// ---- 门禁：仅本机/RFC1918 的 OpenAI 兼容 baseUrl（方案 §6 生效范围） ----

export function isPrivateVllmCapableBaseUrl(baseUrl: string): boolean {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true
  // RFC1918: 10/8, 172.16/12, 192.168/16；外加 link-local 169.254/16
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 归一化端点 key（scheme://host:port，小写，去尾斜杠） */
export function endpointKeyOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    const port = u.port ? `:${u.port}` : ''
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}`
  } catch {
    return baseUrl
  }
}

/**
 * vLLM 的 /metrics 挂在服务根路径（不在 /v1 下）：用 origin 拼。
 * baseUrl 解析失败时退回去尾斜杠拼接。
 */
export function metricsUrlFor(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}/metrics`
  } catch {
    return `${baseUrl.replace(/\/+$/, '')}/metrics`
  }
}

// ---- 核心：探测 + 单飞 + TTL ----

export interface ProbeDeps {
  fetchImpl: ProbeFetch
  now: () => number
}

/**
 * 取快照。返回 null 的含义分层：
 * - null + state=unsupported → 静默零显示（验收13）
 * - null + state=supported → 瞬时抖动（u=高路径，仍显示排队中）
 * queueDisplay=off 时本函数永远立即返回 null 且零 fetch（验收12）。
 */
export async function getSnapshot(
  baseUrl: string,
  deps: ProbeDeps,
): Promise<VllmSnapshot | null> {
  if (getQueueDisplayMode() === 'off') return null
  if (!isPrivateVllmCapableBaseUrl(baseUrl)) return null

  const ep = getEp(endpointKeyOf(baseUrl))
  const now = deps.now()

  if (ep.state === 'unsupported') {
    // 退避窗口内：静默零显示；窗口到期后落到下面的单次复探
    if (now < ep.nextProbeAllowedAt) return null
  }

  // TTL 新鲜：前台在途且未过 poll 窗口 → 用缓存
  const ttl = getVllmQueueHints().pollMs
  if (
    ep.lastSnapshot !== null &&
    now - ep.lastSnapshot.fetchedAt < ttl &&
    ep.state === 'supported'
  ) {
    return ep.lastSnapshot
  }

  // 单飞：已有在途拉取则等它
  if (ep.inflight !== null) {
    await ep.inflight
    return resultFor(ep, deps.now())
  }

  ep.inflight = probeOnce(ep, baseUrl, deps).finally(() => {
    ep.inflight = null
  })
  await ep.inflight
  return resultFor(ep, deps.now())
}

async function probeOnce(
  ep: PerEndpoint,
  baseUrl: string,
  deps: ProbeDeps,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_FETCH_TIMEOUT_MS)
  try {
    const resp = await deps.fetchImpl(metricsUrlFor(baseUrl), {
      signal: controller.signal,
    })
    const now = deps.now()
    if (!resp.ok) {
      registerFailure(ep, now, `http ${resp.status}`)
      return
    }
    const text = await resp.text()
    const snap = parseVllmMetrics(text, now)
    if (!snap.hasVllmMetrics) {
      // 整族 vllm:* 缺失 → 直接摘牌（disable-log-stats / 非 vLLM exporter）
      registerUnsupported(ep, now, 'no vllm:* metric family')
      return
    }
    ep.state = 'supported'
    ep.consecutiveFailures = 0
    ep.lastSuccessAt = now
    updateDiffs(ep, snap)
    ep.lastSnapshot = snap
  } catch (err) {
    registerFailure(ep, deps.now(), String((err as Error)?.name ?? err))
  } finally {
    clearTimeout(timer)
  }
}

function registerFailure(ep: PerEndpoint, now: number, reason: string): void {
  ep.consecutiveFailures += 1
  ep.lastFailureAt = now
  if (ep.state === 'supported' && ep.lastSnapshot !== null) {
    // 抖动：保留快照与 supported 态，由 model.ts 依 fetchedAt 新鲜度放粗措辞
    return
  }
  if (ep.consecutiveFailures >= PROBE_FAIL_LIMIT) {
    registerUnsupported(ep, now, `probe failures: ${reason}`)
  }
}

function registerUnsupported(
  ep: PerEndpoint,
  now: number,
  reason: string,
): void {
  if (ep.state !== 'unsupported') {
    logForDebugging(`[vllmQueue] endpoint marked unsupported: ${reason}`)
  }
  ep.state = 'unsupported'
  ep.consecutiveFailures = 0
  ep.lastSnapshot = null
  ep.prevCounters = null
  // 指数退避：5min → 30min（vLLM 热重启后自动恢复）
  const backoff = Math.min(
    PROBE_RETRY_BASE_MS * 2 ** unsupportedBackoffStep(ep, now),
    PROBE_RETRY_MAX_MS,
  )
  ep.nextProbeAllowedAt = now + backoff
}

/** 依据距离上次失败的时间间隔粗略估计已经退避了几轮 */
function unsupportedBackoffStep(ep: PerEndpoint, now: number): number {
  const sincePrev = now - ep.lastFailureAt
  if (ep.lastFailureAt === 0 || sincePrev > PROBE_RETRY_MAX_MS * 2) return 0
  if (sincePrev > PROBE_RETRY_BASE_MS * 4) return 2
  if (sincePrev > PROBE_RETRY_BASE_MS) return 1
  return 0
}

function resultFor(ep: PerEndpoint, now: number): VllmSnapshot | null {
  if (ep.state === 'unsupported') return null
  return ep.lastSnapshot
}

function updateDiffs(ep: PerEndpoint, snap: VllmSnapshot): void {
  const prev = ep.prevCounters
  if (prev !== null) {
    const dt = (snap.fetchedAt - prev.at) / 1000
    if (dt > 0) {
      const prefillRate = (snap.promptTokens - prev.promptTokens) / dt
      const decodeRate = (snap.generationTokens - prev.generationTokens) / dt
      ep.diffs.prefillTokPerSecEma = ema(
        ep.diffs.prefillTokPerSecEma,
        Math.max(prefillRate, 0),
      )
      ep.diffs.decodeTokPerSecEma = ema(
        ep.diffs.decodeTokPerSecEma,
        Math.max(decodeRate, 0),
      )
      ep.diffs.preemptionDelta = Math.max(
        0,
        snap.preemptions - prev.preemptions,
      )
      ep.diffs.admissionRejectionDelta = Math.max(
        0,
        snap.admissionRejections - prev.admissionRejections,
      )
    }
    const dq = snap.prefixCacheQueries - prev.prefixQueries
    const dh = snap.prefixCacheHits - prev.prefixHits
    if (dq > 0) {
      ep.diffs.prefixHitRate = Math.min(1, Math.max(0, dh / dq))
    }
  }
  ep.prevCounters = {
    at: snap.fetchedAt,
    promptTokens: snap.promptTokens,
    generationTokens: snap.generationTokens,
    preemptions: snap.preemptions,
    admissionRejections: snap.admissionRejections,
    prefixQueries: snap.prefixCacheQueries,
    prefixHits: snap.prefixCacheHits,
  }
}

function ema(prev: number | null, next: number): number {
  if (prev === null) return next
  return prev + EMA_ALPHA * (next - prev)
}

// ---- 前台在途计数（决定要不要轮询；后台-only 零轮询硬约束） ----

export function trackForegroundInFlight(baseUrl: string, delta: 1 | -1): void {
  const ep = getEp(endpointKeyOf(baseUrl))
  ep.foregroundInFlight = Math.max(0, ep.foregroundInFlight + delta)
}

export function foregroundInFlightCount(baseUrl: string): number {
  return getEp(endpointKeyOf(baseUrl)).foregroundInFlight
}

/** 读端点差分采样（model.ts 的吞吐/抢占/命中率信号） */
export function diffsForEndpoint(baseUrl: string): ThroughputDiffs {
  return getEp(endpointKeyOf(baseUrl)).diffs
}

// ---- 测试/会话复位 ----

export function __resetProbeStateForTests(): void {
  endpoints.clear()
}

export function getStateForEndpoint(baseUrl: string): EndpointState {
  return getEp(endpointKeyOf(baseUrl)).state
}
