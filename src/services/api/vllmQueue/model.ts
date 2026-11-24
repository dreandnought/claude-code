/**
 * vllmQueue model — 位次估算（方案 v2.2；ETA 能力已下线，全部火力在「前面 X 个」）
 * 纯函数：输入快照/差分/本地位次，输出 {ahead, uncertainty, kind}。
 *
 * 位次口径（v2.2 修正，替代 v2.1 的 Σ+aheadLocal 叠加）：
 *  ① 服务端精确信号：ahead = running + waiting − 1。
 *     ccb 挂 gate 时请求已发出，本机 vLLM 毫秒级将其准入 waiting，
 *     故 running+waiting 含我自己，减 1 得真实身位。
 *  ② 本地记账下界：aheadLocal（同进程 FIFO）。快照过期/上游有持留代理时
 *     服务端计数看不到我刚发的请求，取 max(①, ②) 保底，绝不重复叠加
 *     （v2.1 的 +aheadLocal 会把同时在 waiting 里的同进程请求数两次）。
 * 冷启动/无数据不影响位次——位次永远由 gauge 直接给出，不再有"先验/预测"分支。
 */
import type { VllmSnapshot } from './types.js'
import type { ThroughputDiffs } from './probe.js'

export interface ModelInputs {
  snapshot: VllmSnapshot
  diffs: ThroughputDiffs
  /** 本地 FIFO：同端点早于我且未完成的请求数（快照过期时的下界） */
  aheadLocal: number
  /** 快照年龄 ms（抖动路径放粗） */
  snapshotAgeMs: number
}

export interface ModelEstimate {
  ahead: number
  /** 0 低 / 1 中 / 2 高（驱动 estimate.ts 措辞分档） */
  uncertainty: 0 | 1 | 2
  kind: 'queued' | 'endpoint_full' | 'deferred_backlog' | 'near_full'
  /** 我已准入且无人在等 → 属于推理中，不弹排队行（硬规则 3） */
  selfLikelyRunning: boolean
}

const SNAPSHOT_STALE_MS = 6000 // 超过则视为抖动 → u 至少 1

export function estimateQueue(inp: ModelInputs): ModelEstimate {
  const s = inp.snapshot
  const serverAhead = Math.max(0, s.running + s.waiting - 1)
  const ahead = Math.max(serverAhead, inp.aheadLocal)

  // ---- kind：特殊态优先 ----
  let kind: ModelEstimate['kind'] = 'queued'
  if (inp.diffs.admissionRejectionDelta > 0 && ahead === 0 && s.running === 0) {
    kind = 'endpoint_full' // 503 有界队列语义侧证
  } else if (
    s.waiting > 0 &&
    s.waitingByReason.deferred / Math.max(1, s.waiting) > 0.5
  ) {
    kind = 'deferred_backlog'
  } else if (s.kvCacheUsage > 0.9 && s.waiting === 0 && ahead > 0) {
    kind = 'near_full'
  }

  // ---- 不确定性信号计数（只保留位次相关项） ----
  let uSignals = 0
  if (inp.diffs.preemptionDelta > 0) uSignals++ // 抢占重排，位次可能劣化
  if (s.engineCount > 1) uSignals++ // 多 rank：位次为端点级聚合
  if (kind === 'deferred_backlog') uSignals++
  if (inp.snapshotAgeMs > SNAPSHOT_STALE_MS) uSignals++ // 抖动/过期快照
  if (s.waiting === 0 && s.running === 0 && inp.aheadLocal > 0) uSignals++ // 仅本地可见

  const uncertainty: 0 | 1 | 2 = uSignals === 0 ? 0 : uSignals <= 2 ? 1 : 2

  // 无容量等待且无本地在前请求 → 我已准入，属推理中非排队
  const selfLikelyRunning = s.waiting === 0 && inp.aheadLocal === 0

  return { ahead, uncertainty, kind, selfLikelyRunning }
}
