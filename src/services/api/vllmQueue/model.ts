/**
 * vllmQueue model — 位次与 ETA 融合估算（方案 v2.1 §2，批次3 v1 形态）
 * 纯函数：输入快照/差分/本地位次/自校准系数，输出 {ahead, etaSec, uncertainty, kind}。
 *
 * P0 阶段的三级融合：
 *  ① 位次 ahead = Σ(running+waiting) + aheadLocal
 *  ② 模型预测 ETA（token 预算制：prefill 排空 / decode 残余取合成）
 *  ③ 经验先验（vllm:request_queue_time_seconds 直方图分位数）
 *  ④ 融合 eta = (w·predicted + (1−w)·prior) × k，w 随本地样本数 0.3→0.7 爬升
 * 冷启动无直方图且无本地样本 → u=高，只报"排队中"。
 */
import type { VllmSnapshot } from './types.js'
import { histogramMean, histogramQuantile } from './metrics.js'
import type { ThroughputDiffs } from './probe.js'

export interface ModelInputs {
  snapshot: VllmSnapshot
  diffs: ThroughputDiffs
  /** 本地 FIFO：同端点早于我且未完成的请求数（§2.3 自贡献位次） */
  aheadLocal: number
  /** 我这次请求的 prompt token 估算（usage/字符估算），0=未知 */
  selfPromptTokens: number
  /** 自观测校准系数（P1 落地前恒 1） */
  calibrationK: number
  /** calibration.json 本地样本数（决定融合权重 w） */
  localSampleCount: number
  /** 快照年龄 ms（抖动路径放粗） */
  snapshotAgeMs: number
}

export interface ModelEstimate {
  ahead: number
  /** 秒；null=无法可信估算 */
  etaSec: number | null
  /** 0 低 / 1 中 / 2 高（驱动 estimate.ts 措辞分档） */
  uncertainty: 0 | 1 | 2
  kind: 'queued' | 'endpoint_full' | 'deferred_backlog' | 'near_full'
  /** 端点是否可能把我算进 running（区分"推理中"与"排队中"，方案 §4.4-2） */
  selfLikelyRunning: boolean
}

const FLOOR_RATE_RPS = 0.2 // 完成率下限（方案 §3 v1 遗留：保守 0.2 req/s）
const COLD_REQUEST_SEC = 30 // 无数据时单请求保守经验耗时
const SNAPSHOT_STALE_MS = 6000 // 超过则视为抖动 → u 至少 1

export function estimateQueue(inp: ModelInputs): ModelEstimate {
  const s = inp.snapshot
  const ahead = s.running + s.waiting + inp.aheadLocal

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

  const selfLikelyRunning =
    s.running > 0 && s.waiting === 0 && inp.aheadLocal === 0

  // ---- 不确定性信号计数（u 初值） ----
  let uSignals = 0
  if (inp.diffs.preemptionDelta > 0) uSignals++ // 队列被打乱
  if (s.engineCount > 1) uSignals++ // 多 rank：位次端点级
  if (kind === 'deferred_backlog') uSignals++
  if (inp.snapshotAgeMs > SNAPSHOT_STALE_MS) uSignals++
  if (s.queueTimeHist === null) uSignals++

  // ---- ② 模型预测 ----
  const predicted = predictedEtaSec(inp)

  // ---- ③ 经验先验 ----
  const prior = priorEtaSec(inp)

  // ---- ④ 融合 + 校准 ----
  let etaSec: number | null
  if (predicted !== null && prior !== null) {
    const w = blendWeight(inp.localSampleCount)
    etaSec = (w * predicted + (1 - w) * prior) * clampK(inp.calibrationK)
  } else {
    etaSec = predicted ?? prior ?? null
    if (etaSec !== null) etaSec *= clampK(inp.calibrationK)
  }

  if (kind === 'endpoint_full') etaSec = null

  // ---- 不确定性终值 ----
  if (etaSec === null && ahead > 0) uSignals++ // 有队可排但说不清时间
  const uncertainty: 0 | 1 | 2 = uSignals === 0 ? 0 : uSignals <= 2 ? 1 : 2

  if (selfLikelyRunning && s.waiting === 0) {
    // 我在跑、没别人排队 → 属于"推理中"而非排队（调用方据此不显示排队行）
    return { ahead, etaSec, uncertainty, kind, selfLikelyRunning: true }
  }

  return { ahead, etaSec, uncertainty, kind, selfLikelyRunning: false }
}

/** 融合权重：本地样本 0→0.3，≥20→0.7 线性爬升 */
export function blendWeight(localSampleCount: number): number {
  const t = Math.min(1, localSampleCount / 20)
  return 0.3 + 0.4 * t
}

function clampK(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 1
  return Math.min(Math.max(k, 0.25), 4)
}

function priorEtaSec(inp: ModelInputs): number | null {
  const h = inp.snapshot.queueTimeHist
  if (h === null || h.count <= 0) return null
  const ahead = inp.snapshot.running + inp.snapshot.waiting + inp.aheadLocal
  if (ahead <= 0) return 0
  // 无历史并发规模信号 → 先验取中位数：我这类等待者的历史排队时长 P50
  const q = histogramQuantile(h, 0.5)
  if (q === null) return null
  // 先验覆盖"排到我"的时间；再叠加自己 prefill 准入时间的保守值
  const selfPrefill = selfPrefillSec(inp)
  return q + selfPrefill
}

function selfPrefillSec(inp: ModelInputs): number {
  if (inp.selfPromptTokens <= 0) return 0
  const rate = inp.diffs.prefillTokPerSecEma
  if (rate === null || rate <= 0) return 0
  const hitDiscount =
    inp.diffs.prefixHitRate === null
      ? 0
      : Math.min(0.6, inp.diffs.prefixHitRate) // 命中率折扣封顶 60%
  return (inp.selfPromptTokens * (1 - hitDiscount)) / rate
}

function predictedEtaSec(inp: ModelInputs): number | null {
  const s = inp.snapshot
  const ahead = s.running + s.waiting + inp.aheadLocal
  if (ahead <= 0) return 0
  if (s.waiting === 0 && s.running > 0 && inp.aheadLocal === 0) return null // 无排队主体，纯 decode 残余不可承诺

  // 前面 token 量 ≈ (waiting × E[prompt]) + running 中未准入部分
  const ePrompt =
    histogramMean(s.promptTokensHist) ??
    (inp.selfPromptTokens > 0 ? inp.selfPromptTokens : null)
  const prefillTokPerSec = inp.diffs.prefillTokPerSecEma
  const hitDiscount =
    inp.diffs.prefixHitRate === null
      ? 0
      : Math.min(0.6, inp.diffs.prefixHitRate)

  let prefillDrain: number | null = null
  if (ePrompt !== null && prefillTokPerSec !== null && prefillTokPerSec > 0) {
    const waitingTokens =
      (s.waiting + inp.aheadLocal) * ePrompt * (1 - hitDiscount)
    prefillDrain = waitingTokens / prefillTokPerSec
  }

  // decode 残余：running 并发下平均已跑一半假设 × E[decode]
  let decodeDrain: number | null = null
  const eDecode = histogramMean(s.decodeTimeHist)
  if (s.running > 0) {
    if (eDecode !== null) {
      decodeDrain = eDecode * 0.5 * (1 + 0.3 * (s.kvCacheUsage > 0.9 ? 1 : 0))
    } else {
      decodeDrain = COLD_REQUEST_SEC * 0.5
    }
  }

  // 排空速率兜底：完成率 EMA → 每请求保守 30s
  if (prefillDrain === null && decodeDrain === null) {
    return Math.max(ahead * COLD_REQUEST_SEC * 0.5, 0)
  }
  const waitingShare = prefillDrain ?? ahead * COLD_REQUEST_SEC * 0.5
  const decodeShare = decodeDrain ?? 0
  // 我准入需要：排空 waiting 的 prefill 份额，与 running decode 释放 KV 的较优条件合成
  return Math.max(waitingShare, decodeShare) + selfPrefillSec(inp)
}
