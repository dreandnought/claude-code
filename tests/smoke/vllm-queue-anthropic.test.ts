/**
 * 基础能力冒烟测试：anthropic 路径排队接线（P0.5）
 *
 * 验证 buildFetch 包装层的行为边界（方案 v2.1 §6 行为矩阵在 anthropic 侧的延伸）：
 * 1. 官方 api.anthropic.com（非 RFC1918）→ gate 不启动，零 fetch /metrics
 * 2. 本机 ANTHROPIC_BASE_URL 风格端点 → 请求挂起期间轮询 /metrics，
 *    响应头到达即停（dispose 后零新增轮询）
 * 3. queueDisplay=off → 包装层零执行
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetProbeStateForTests,
  type ProbeFetch,
} from '../../src/services/api/vllmQueue/probe'
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

// 模拟 gate 的依赖注入路径：用 probe 直接验证端点级语义，
// buildFetch 接线本身以"官方域名零触碰 + off 零执行"两条红线为主。

function setQD(v: 'off' | 'vllm'): void {
  setSessionSettingsCache({
    settings: { queueDisplay: v },
    errors: [],
  } as never)
}

const ANTHROPIC_LOCAL = 'http://127.0.0.1:8000'
const KEY = 'http://127.0.0.1:8000'

const VLLM_METRICS = `vllm:num_requests_running{model_name="m"} 1
vllm:num_requests_waiting{model_name="m"} 3
`

let fetchCount = 0
let clock = 1_000_000
const fakeFetch: ProbeFetch = async () => {
  fetchCount++
  return { ok: true, status: 200, text: async () => VLLM_METRICS }
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

describe('anthropic path wiring semantics', () => {
  test('official anthropic host is NOT private → gate NOOP by baseUrl rule', async () => {
    const { isPrivateVllmCapableBaseUrl } = await import(
      '../../src/services/api/vllmQueue/probe'
    )
    // buildFetch 对官方域名传的 baseUrl=https://api.anthropic.com → 门禁拒绝
    expect(isPrivateVllmCapableBaseUrl('https://api.anthropic.com')).toBe(false)
    expect(
      isPrivateVllmCapableBaseUrl('https://api-staging.anthropic.com'),
    ).toBe(false)
  })

  test('local anthropic-format endpoint passes the gate baseUrl rule', async () => {
    const { isPrivateVllmCapableBaseUrl } = await import(
      '../../src/services/api/vllmQueue/probe'
    )
    // vLLM 根路径即 Anthropic 原生端点：host 判定只看 origin
    expect(isPrivateVllmCapableBaseUrl(ANTHROPIC_LOCAL)).toBe(true)
  })

  test('gate over local anthropic-format baseUrl polls and stops on dispose', async () => {
    const { withQueueHints } = await import(
      '../../src/services/api/vllmQueue/gate'
    )
    const h = withQueueHints({
      baseUrl: ANTHROPIC_LOCAL,
      querySource: 'repl_main_thread',
      deps: { fetchImpl: fakeFetch, now: () => ++clock },
    })
    // 等过首拍（≤2s）
    await new Promise(r => setTimeout(r, 2600))
    expect(fetchCount).toBeGreaterThan(0)
    expect(inflightCount(KEY)).toBe(1)
    const snap = getQueueStatusSnapshot()
    expect(snap?.line).toContain('排队中')

    h.dispose()
    const after = fetchCount
    await new Promise(r => setTimeout(r, 2100))
    expect(fetchCount).toBe(after) // 头到达 dispose 后零轮询
    expect(inflightCount(KEY)).toBe(0)
    expect(getQueueStatusSnapshot()).toBeNull()
  })

  test('off: no side effects on anthropic path either', async () => {
    setQD('off')
    const { withQueueHints } = await import(
      '../../src/services/api/vllmQueue/gate'
    )
    const h = withQueueHints({
      baseUrl: ANTHROPIC_LOCAL,
      querySource: 'repl_main_thread',
      deps: { fetchImpl: fakeFetch, now: () => ++clock },
    })
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0)
    expect(inflightCount(KEY)).toBe(0)
    h.dispose()
  })
})
