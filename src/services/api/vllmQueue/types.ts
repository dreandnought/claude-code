/**
 * vllmQueue 类型定义 — ccb 本地 vLLM 排队提示（方案 v2.1 §4）
 *
 * 本文件只放数据结构，不含 IO：解析层(metrics.ts)/估算层(model.ts)保持纯函数、
 * 可离线测试。
 */

/** 单条 Prometheus 样本（已拆出标签、值已转 number，非有限值已过滤） */
export interface RawSample {
  name: string
  labels: Record<string, string>
  value: number
}

/** 累积直方图（跨 engine 合并后的形态） */
export interface VllmHistogram {
  /** 按 le 升序排列的累积桶；+Inf 以 le=Infinity 收尾 */
  buckets: { le: number; cumulative: number }[]
  sum: number
  count: number
}

/** 一次 /metrics 拉取解析后的端点快照 */
export interface VllmSnapshot {
  /** 拉取时刻（epoch ms），由调用方传入，保持纯函数可测 */
  fetchedAt: number
  /** 响应里是否出现过任何 vllm:* 指标族（能力判定主信号） */
  hasVllmMetrics: boolean
  /** 观测到的 engine/DP rank 数（来自 running 族去重标签），多 rank 时位次语义降级 */
  engineCount: number
  /** 第一个看到的 model_name 标签（校准分桶用），无则空串 */
  modelName: string

  // ---- gauges（跨 engine 求和） ----
  running: number
  waiting: number
  /** waiting 按原因拆分；老版本无此族时 capacity=waiting、deferred=0 */
  waitingByReason: { capacity: number; deferred: number }
  /** KV cache 使用率 0–1（两代名字容错） */
  kvCacheUsage: number

  // ---- counters（跨 engine 求和；差分由 probe 层做） ----
  requestSuccess: number
  preemptions: number
  promptTokens: number
  generationTokens: number
  prefixCacheQueries: number
  prefixCacheHits: number
  admissionRejections: number

  // ---- histograms（缺族时为 null，调用方按 u=高 降级） ----
  queueTimeHist: VllmHistogram | null
  prefillTimeHist: VllmHistogram | null
  decodeTimeHist: VllmHistogram | null
  ttftHist: VllmHistogram | null
  itlHist: VllmHistogram | null
  promptTokensHist: VllmHistogram | null
  maxGenTokensHist: VllmHistogram | null
}

/** 排队状态事件（withRetry → REPL 渲染通道） */
export interface QueueStatus {
  endpoint: string
  querySource: string
  ahead: number
  etaSec: number | null
  /** 不确定性档位：0 低（报具体数）1 中（区间）2 高（放粗措辞） */
  uncertainty: 0 | 1 | 2
  /** 展示文案（estimate.ts 生成） */
  display: string
  /** 特殊态 */
  kind: 'queued' | 'endpoint_full' | 'deferred_backlog' | 'near_full'
}
