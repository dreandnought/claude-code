/**
 * 基础能力冒烟测试：vllmQueue 验收钉死项（方案 v2.1 §8 验收 12/13/14）
 *
 * 1. settings schema：queueDisplay 枚举只收 off|vllm，非法值拒绝；缺省=生效(vllm)
 * 2. vllmQueueHints 明细参数范围校验
 * 3. 行为矩阵行 1：off → 全链路零执行（fetch/事件/ledger）
 * 4. 行为矩阵行 3：vllm + 端点无 vllm:* 指标族 → 探测 1 次即摘牌、静默零显示、
 *    后续请求零 fetch（disable-log-stats / 反代 404 同型）
 * 5. 开关热切换：off→vllm 与 vllm→off 均在下一请求周期生效、无需重启
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../../src/utils/settings/types'
import {
  __resetProbeStateForTests,
  getStateForEndpoint,
  type ProbeFetch,
} from '../../src/services/api/vllmQueue/probe'
import {
  withQueueHints,
  type GateDeps,
} from '../../src/services/api/vllmQueue/gate'
import {
  __resetLedgerForTests,
  inflightCount,
} from '../../src/services/api/vllmQueue/ledger'
import {
  __resetQueueStatusForTests,
  getQueueStatusSnapshot,
} from '../../src/services/api/vllmQueue/statusStore'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'

const BASE = 'http://127.0.0.1:8000/v1'
const KEY = 'http://127.0.0.1:8000'

function setQD(v: 'off' | 'vllm' | undefined): void {
  setSessionSettingsCache({
    settings: v === undefined ? {} : { queueDisplay: v },
    errors: [],
  } as never)
}

const VLLM_METRICS = `vllm:num_requests_running{model_name="m"} 1
vllm:num_requests_waiting{model_name="m"} 2
`

let fetchCount = 0
let clock = 1_000_000
function fetcher(body: string, ok = true): ProbeFetch {
  return async () => {
    fetchCount++
    return {
      ok,
      status: ok ? 200 : 404,
      text: async () => body,
    }
  }
}
function deps(f: ProbeFetch): GateDeps {
  return { fetchImpl: f, now: () => ++clock }
}

beforeEach(() => {
  fetchCount = 0
  clock = 1_000_000
  setQD('vllm')
  __resetProbeStateForTests()
  __resetLedgerForTests()
  __resetQueueStatusForTests()
})

afterEach(() => resetSettingsCache())

// ---------- 1/2. schema 契约（验收14） ----------

describe('settings schema: queue display keys', () => {
  test('queueDisplay enum accepts off and vllm only', () => {
    expect(SettingsSchema().safeParse({ queueDisplay: 'off' }).success).toBe(
      true,
    )
    expect(SettingsSchema().safeParse({ queueDisplay: 'vllm' }).success).toBe(
      true,
    )
    expect(SettingsSchema().safeParse({ queueDisplay: 'always' }).success).toBe(
      false,
    )
    expect(SettingsSchema().safeParse({ queueDisplay: '' }).success).toBe(false)
    expect(SettingsSchema().safeParse({ queueDisplay: 1 }).success).toBe(false)
  })

  test('queueDisplay omitted = feature on (default vllm semantics)', () => {
    const r = SettingsSchema().safeParse({})
    expect(r.success).toBe(true)
    expect(
      (r as { data: { queueDisplay?: string } }).data.queueDisplay,
    ).toBeUndefined()
  })

  test('vllmQueueHints validates ranges and booleans', () => {
    const good = SettingsSchema().safeParse({
      vllmQueueHints: {
        pollMs: 1500,
        thresholdMs: 8000,
        uncertaintyHints: true,
        calibration: false,
        maxLocalConcurrency: 4,
      },
    })
    expect(good.success).toBe(true)

    expect(
      SettingsSchema().safeParse({ vllmQueueHints: { pollMs: 10 } }).success,
    ).toBe(false)
    expect(
      SettingsSchema().safeParse({ vllmQueueHints: { thresholdMs: -5 } })
        .success,
    ).toBe(false)
    expect(
      SettingsSchema().safeParse({
        vllmQueueHints: { uncertaintyHints: 'yes' },
      }).success,
    ).toBe(false)
  })
})

// ---------- 3. 行为矩阵行1：off 零执行（验收12） ----------

describe('behavior matrix row: off', () => {
  test('off short-circuits before any probe/ledger side effect', async () => {
    setQD('off')
    const h = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: deps(fetcher(VLLM_METRICS)),
    })
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0)
    expect(inflightCount(KEY)).toBe(0)
    expect(getQueueStatusSnapshot()).toBeNull()
    expect(getStateForEndpoint(BASE)).toBe('pending')
    h.dispose()
  })
})

// ---------- 4. 行为矩阵行3：不可达端点静默（验收13） ----------

describe('behavior matrix row: vllm + unreachable endpoint', () => {
  test('404 on /metrics: 3 probe attempts then unsupported, zero display, zero further fetch', async () => {
    const f = fetcher('', false)
    const d = deps(f)
    // 直接驱动 probe（gate 首拍有 ≤2s 延迟，这里用 probe 层 API 钉次数语义）
    const { getSnapshot } = await import(
      '../../src/services/api/vllmQueue/probe'
    )
    for (let k = 0; k < 3; k++) {
      expect(await getSnapshot(BASE, d)).toBeNull()
    }
    expect(fetchCount).toBe(3)
    expect(getStateForEndpoint(BASE)).toBe('unsupported')

    // 摘牌后：退避窗口内任何前台请求都零 fetch 零显示
    fetchCount = 0
    const h = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: d,
    })
    await new Promise(r => setTimeout(r, 2600))
    expect(fetchCount).toBe(0)
    expect(getQueueStatusSnapshot()).toBeNull()
    h.dispose()
  })

  test('metrics served but no vllm:* family (disable-log-stats) → unsupported immediately', async () => {
    const { getSnapshot } = await import(
      '../../src/services/api/vllmQueue/probe'
    )
    const d = deps(fetcher('node_exporter_buildinfo 1\n'))
    const s = await getSnapshot(BASE, d)
    expect(s).toBeNull()
    expect(getStateForEndpoint(BASE)).toBe('unsupported')
    expect(fetchCount).toBe(1) // 无需三次——整族缺失是确定性信号
  })
})

// ---------- 5. 热切换（验收14） ----------

describe('hot toggle without session restart', () => {
  test('off→vllm effective on next request cycle', async () => {
    setQD('off')
    const h1 = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: deps(fetcher(VLLM_METRICS)),
    })
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0)
    h1.dispose()

    setQD('vllm') // 热切换：下一请求即生效
    const h2 = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: deps(fetcher(VLLM_METRICS)),
    })
    await new Promise(r => setTimeout(r, 2600))
    expect(fetchCount).toBeGreaterThan(0)
    h2.dispose()
  })

  test('vllm→off stops everything on next cycle', async () => {
    setQD('vllm')
    const h1 = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: deps(fetcher(VLLM_METRICS)),
    })
    await new Promise(r => setTimeout(r, 2600))
    const onCount = fetchCount
    expect(onCount).toBeGreaterThan(0)
    h1.dispose()

    setQD('off')
    const h2 = withQueueHints({
      baseUrl: BASE,
      querySource: 'repl_main_thread',
      deps: deps(fetcher(VLLM_METRICS)),
    })
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(onCount) // 没有新增
    expect(getQueueStatusSnapshot()).toBeNull()
    h2.dispose()
  })
})
