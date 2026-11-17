/**
 * 基础能力冒烟测试：vllmQueue 估算与显示层（方案 v2.1 批次3）
 *
 * 覆盖：
 * 1. model.ts 融合估算：位次合成、先验/预测权重、特殊态（队满/deferred/KV满载）
 * 2. estimate.ts 分档：不确定性放粗、ETA 分档、"推理中不显示排队行"防误报
 * 3. visibility.ts 前后台分类表：表外默认后台+warning、undefined 归前台
 * 4. ledger.ts FIFO 位次：入队/销账/同端点隔离
 * 5. gate.ts 编排：off 零执行、公共端点零执行、首拍发布→dispose 清行
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetProbeStateForTests,
  getSnapshot,
  type ProbeFetch,
} from '../../src/services/api/vllmQueue/probe'
import {
  blendWeight,
  estimateQueue,
  type ModelInputs,
} from '../../src/services/api/vllmQueue/model'
import {
  etaBucket,
  rankBucket,
  renderQueueLine,
} from '../../src/services/api/vllmQueue/estimate'
import {
  __resetVisibilityWarnsForTests,
  isForegroundQuerySource,
} from '../../src/services/api/vllmQueue/visibility'
import {
  __resetLedgerForTests,
  aheadLocalFor,
  complete,
  enqueue,
  inflightCount,
} from '../../src/services/api/vllmQueue/ledger'
import {
  withQueueHints,
  type GateDeps,
} from '../../src/services/api/vllmQueue/gate'
import {
  __resetQueueStatusForTests,
  getQueueStatusSnapshot,
} from '../../src/services/api/vllmQueue/statusStore'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'
import type { VllmSnapshot } from '../../src/services/api/vllmQueue/types'
import { parseVllmMetrics } from '../../src/services/api/vllmQueue/metrics'

const BASE = 'http://127.0.0.1:8000/v1'

function snap(partial: Partial<VllmSnapshot> = {}): VllmSnapshot {
  return {
    fetchedAt: 1_000_000,
    hasVllmMetrics: true,
    engineCount: 1,
    modelName: 'test-model',
    running: 0,
    waiting: 0,
    waitingByReason: { capacity: 0, deferred: 0 },
    kvCacheUsage: 0.3,
    requestSuccess: 0,
    preemptions: 0,
    promptTokens: 0,
    generationTokens: 0,
    prefixCacheQueries: 0,
    prefixCacheHits: 0,
    admissionRejections: 0,
    queueTimeHist: null,
    prefillTimeHist: null,
    decodeTimeHist: null,
    ttftHist: null,
    itlHist: null,
    promptTokensHist: null,
    maxGenTokensHist: null,
    ...partial,
  }
}

function inputs(partial: Partial<ModelInputs> = {}): ModelInputs {
  return {
    snapshot: snap(),
    diffs: {
      prefillTokPerSecEma: null,
      decodeTokPerSecEma: null,
      preemptionDelta: 0,
      admissionRejectionDelta: 0,
      prefixHitRate: null,
    },
    aheadLocal: 0,
    selfPromptTokens: 0,
    calibrationK: 1,
    localSampleCount: 0,
    snapshotAgeMs: 0,
    ...partial,
  }
}

// ---------- 1. model.ts ----------

describe('vllmQueue model estimate', () => {
  test('ahead = running + waiting + aheadLocal', () => {
    const est = estimateQueue(
      inputs({
        snapshot: snap({ running: 3, waiting: 7 }),
        aheadLocal: 2,
      }),
    )
    expect(est.ahead).toBe(12)
    expect(est.kind).toBe('queued')
  })

  test('queue-time histogram prior drives ETA when model leg is cold', () => {
    const hist = parseVllmMetrics(
      `vllm:num_requests_waiting 4
vllm:request_queue_time_seconds_bucket{le="30"} 10
vllm:request_queue_time_seconds_bucket{le="60"} 30
vllm:request_queue_time_seconds_bucket{le="+Inf"} 40
vllm:request_queue_time_seconds_sum 1600
vllm:request_queue_time_seconds_count 40
`,
      1_000_000,
    )
    const est = estimateQueue(inputs({ snapshot: hist, aheadLocal: 0 }))
    expect(est.etaSec).not.toBeNull()
    expect(est.etaSec!).toBeGreaterThan(0)
    expect(est.etaSec!).toBeLessThan(300)
  })

  test('endpoint_full kind from admission rejections with empty queue', () => {
    const est = estimateQueue(
      inputs({
        snapshot: snap({ running: 0, waiting: 0 }),
        diffs: {
          prefillTokPerSecEma: null,
          decodeTokPerSecEma: null,
          preemptionDelta: 0,
          admissionRejectionDelta: 3,
          prefixHitRate: null,
        },
      }),
    )
    expect(est.kind).toBe('endpoint_full')
    expect(est.etaSec).toBeNull()
  })

  test('deferred backlog when >50% waiting deferred', () => {
    const est = estimateQueue(
      inputs({
        snapshot: snap({
          waiting: 8,
          waitingByReason: { capacity: 3, deferred: 5 },
        }),
      }),
    )
    expect(est.kind).toBe('deferred_backlog')
  })

  test('near_full flag when KV >0.9 and nothing waiting', () => {
    const est = estimateQueue(
      inputs({
        snapshot: snap({ running: 4, waiting: 0, kvCacheUsage: 0.95 }),
        aheadLocal: 1,
      }),
    )
    expect(est.kind).toBe('near_full')
  })

  test('self running with empty queue → selfLikelyRunning (推理中非排队)', () => {
    const est = estimateQueue(inputs({ snapshot: snap({ running: 2 }) }))
    expect(est.selfLikelyRunning).toBe(true)
  })

  test('blend weight climbs 0.3→0.7 with local samples', () => {
    expect(blendWeight(0)).toBeCloseTo(0.3)
    expect(blendWeight(10)).toBeCloseTo(0.5)
    expect(blendWeight(20)).toBeCloseTo(0.7)
    expect(blendWeight(100)).toBeCloseTo(0.7)
  })

  test('no data anywhere → conservative cold estimate, uncertainty raised', () => {
    const est = estimateQueue(inputs({ snapshot: snap({ waiting: 9 }) }))
    expect(est.ahead).toBe(9)
    expect(est.uncertainty).toBeGreaterThanOrEqual(1)
    // 保守预测仍给得出（30s 冷经验值），直方图缺失计入不确定性
    expect(est.etaSec).not.toBeNull()
  })

  test('stale snapshot and multi-engine raise uncertainty to 2', () => {
    const est = estimateQueue(
      inputs({
        snapshot: snap({ waiting: 3, engineCount: 4 }),
        snapshotAgeMs: 60_000,
      }),
    )
    expect(est.uncertainty).toBe(2)
  })
})

// ---------- 2. estimate.ts 分档 ----------

describe('vllmQueue display buckets', () => {
  test('rank buckets per spec: 1 / N / round5 / 20+ / 50+', () => {
    expect(rankBucket(1, 0)).toBe('前面 1 个')
    expect(rankBucket(3, 0)).toBe('前面 3 个')
    expect(rankBucket(8, 0)).toBe('前面约 10 个')
    expect(rankBucket(30, 0)).toBe('前面 20+ 个')
    expect(rankBucket(60, 0)).toBe('排队较多（50+）')
  })

  test('uncertainty coarsens one tier per level', () => {
    expect(rankBucket(8, 1)).toBe('前面 20+ 个') // round5→twenty
    expect(rankBucket(3, 2)).toBe('前面 20+ 个') // few→round5→twenty
  })

  test('eta buckets: <30s / ~1min / N min / >10min', () => {
    expect(etaBucket(12)).toBe('预计 12s')
    expect(etaBucket(40)).toBe('预计 ~1min')
    expect(etaBucket(180)).toBe('预计 3min')
    expect(etaBucket(900)).toBe('预计 >10min')
  })

  test('u=2 renders coarse line without concrete rank', () => {
    const r = renderQueueLine(
      {
        ahead: 12,
        etaSec: 90,
        uncertainty: 2,
        kind: 'queued',
        selfLikelyRunning: false,
      },
      { showEta: true, uncertaintyHints: true },
    )
    expect(r.show).toBe(true)
    expect(r.text).toContain('队列较长')
    expect(r.text).not.toContain('12')
  })

  test('inference-not-queue case suppresses the line (防长思考误报)', () => {
    const r = renderQueueLine(
      {
        ahead: 1,
        etaSec: null,
        uncertainty: 0,
        kind: 'queued',
        selfLikelyRunning: true,
      },
      { showEta: true, uncertaintyHints: true },
    )
    expect(r.show).toBe(false)
  })

  test('endpoint_full renders ⛔ line', () => {
    const r = renderQueueLine(
      {
        ahead: 0,
        etaSec: null,
        uncertainty: 1,
        kind: 'endpoint_full',
        selfLikelyRunning: false,
      },
      { showEta: true, uncertaintyHints: true },
    )
    expect(r.text).toContain('端点队列已满')
  })
})

// ---------- 3. visibility.ts ----------

describe('vllmQueue visibility table', () => {
  beforeEach(() => __resetVisibilityWarnsForTests())

  test('foreground sources get hints', () => {
    expect(isForegroundQuerySource('repl_main_thread')).toBe(true)
    expect(isForegroundQuerySource('agent:custom')).toBe(true)
    expect(isForegroundQuerySource('compact')).toBe(true)
    expect(isForegroundQuerySource('side_question')).toBe(true)
  })

  test('background sources stay silent', () => {
    expect(isForegroundQuerySource('title')).toBe(false)
    expect(isForegroundQuerySource('auto_mode')).toBe(false)
    expect(isForegroundQuerySource('hook_prompt')).toBe(false)
  })

  test('undefined conservatively counts as foreground (用户干等最糟)', () => {
    expect(isForegroundQuerySource(undefined)).toBe(true)
  })

  test('unknown new source defaults to background', () => {
    expect(isForegroundQuerySource('brand_new_pipeline')).toBe(false)
  })
})

// ---------- 4. ledger.ts ----------

describe('vllmQueue ledger FIFO', () => {
  beforeEach(() => __resetLedgerForTests())

  test('aheadLocal counts earlier unfinished same-endpoint entries only', () => {
    const t1 = enqueue('a', 'main', 'k1', 100)
    const t2 = enqueue('a', 'subagent', 'k2', 200)
    const t3 = enqueue('b', 'main', 'k3', 300) // 不同端点
    expect(aheadLocalFor(t2)).toBe(1)
    expect(aheadLocalFor(t3)).toBe(0)
    complete(t1)
    expect(aheadLocalFor(t2)).toBe(0)
  })

  test('inflightCount per endpoint; complete idempotent', () => {
    const t1 = enqueue('a', 'main', 'k1', 1)
    enqueue('a', 'main', 'k2', 2)
    expect(inflightCount('a')).toBe(2)
    complete(t1)
    complete(t1)
    expect(inflightCount('a')).toBe(1)
  })
})

// ---------- 5. gate.ts 编排（验收12/13 的单元形态） ----------

describe('vllmQueue gate orchestration', () => {
  let clock = 1_000_000
  function setQD(v: 'off' | 'vllm'): void {
    setSessionSettingsCache({
      settings: { queueDisplay: v },
      errors: [],
    } as never)
  }

  const METRICS = `vllm:num_requests_running{model_name="m"} 1
vllm:num_requests_waiting{model_name="m"} 5
vllm:kv_cache_usage_perc{model_name="m"} 0.5
vllm:request_queue_time_seconds_bucket{le="30"} 5
vllm:request_queue_time_seconds_bucket{le="+Inf"} 10
vllm:request_queue_time_seconds_sum 200
vllm:request_queue_time_seconds_count 10
`

  let fetchCount = 0
  const fakeFetch: ProbeFetch = async () => {
    fetchCount++
    return { ok: true, status: 200, text: async () => METRICS }
  }
  const deps: GateDeps = { fetchImpl: fakeFetch, now: () => clock }

  beforeEach(() => {
    clock = 1_000_000
    fetchCount = 0
    setQD('vllm')
    __resetProbeStateForTests()
    __resetLedgerForTests()
    __resetQueueStatusForTests()
    __resetVisibilityWarnsForTests()
  })

  afterEach(() => resetSettingsCache())

  test('off: zero fetch, zero status, NOOP handle', async () => {
    setQD('off')
    const h = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps,
    })
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(0)
    expect(getQueueStatusSnapshot()).toBeNull()
    h.dispose()
  })

  test('public baseUrl: zero fetch even when vllm mode on', async () => {
    const h = withQueueHints({
      baseUrl: 'https://api.openai.com/v1',
      querySource: 'repl_main_thread',
      deps,
    })
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(0)
    expect(getQueueStatusSnapshot()).toBeNull()
    h.dispose()
  })

  test('background source: zero fetch, zero display', async () => {
    const h = withQueueHints({ baseUrl: BASE, querySource: 'title', deps })
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(0)
    h.dispose()
  })

  test('foreground blocked request publishes queue line then clears on dispose', async () => {
    const h = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      suffix: undefined,
      deps,
    })
    // gate 首拍 min(threshold,2000)≤2s；真实定时器 2s 后触发
    await new Promise(r => setTimeout(r, 2600))
    const snap = getQueueStatusSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.line).toContain('排队中')
    expect(snap!.line).toContain('前面')
    h.dispose()
    expect(getQueueStatusSnapshot()).toBeNull()
  })
})
