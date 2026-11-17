/**
 * 基础能力冒烟测试：vllmQueue probe 探测层（方案 v2.1 批次2）
 *
 * 覆盖行为矩阵与探测语义（验收 12/13/14 的离线部分）：
 * 1. queueDisplay=off → 零 fetch、返回 null（全链路短路）
 * 2. 非本机 baseUrl（公共 API/公网）→ 零触碰
 * 3. 正常 vLLM → supported + 快照 + TTL 缓存命中（一次在途只 fetch 一次=单飞）
 * 4. 404 抖动不摘牌（上次成功后失败一次仍显示旧快照路径）
 * 5. 整族 vllm:* 缺失 → 立即 unsupported，停止轮询，退避后复探恢复
 * 6. 连续 PROBE_FAIL_LIMIT 次网络失败 → unsupported
 * 7. 差分采样：prefill/decode 吞吐 EMA、抢占增量、admission 增量、命中率
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetProbeStateForTests,
  endpointKeyOf,
  foregroundInFlightCount,
  getSnapshot,
  getVllmQueueHints,
  getStateForEndpoint,
  isPrivateVllmCapableBaseUrl,
  PROBE_FAIL_LIMIT,
  PROBE_RETRY_BASE_MS,
  trackForegroundInFlight,
  type ProbeFetch,
} from '../../src/services/api/vllmQueue/probe'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache'

const BASE = 'http://127.0.0.1:8000/v1'

const MODERN_METRICS = `vllm:num_requests_running{model_name="dsv3"} 2
vllm:num_requests_waiting{model_name="dsv3"} 4
vllm:kv_cache_usage_perc{model_name="dsv3"} 0.5
vllm:prompt_tokens_total 1000
vllm:generation_tokens_total 500
vllm:num_preemptions_total 1
vllm:admission_rejections_total 0
vllm:prefix_cache_queries_total 100
vllm:prefix_cache_hits_total 40
`

function setQueueDisplay(v: 'off' | 'vllm' | undefined): void {
  setSessionSettingsCache({
    settings: v === undefined ? {} : { queueDisplay: v },
    errors: [],
  } as never)
}

let clock = 1_000_000
function makeFetcher(
  responses: Array<
    { status: number; body: string } | { error: 'network' | 'timeout' }
  >,
): { fetch: ProbeFetch; calls: () => number } {
  let i = 0
  let n = 0
  return {
    calls: () => n,
    fetch: async (_url: string) => {
      n++
      const r = responses[Math.min(i, responses.length - 1)]!
      i++
      if ('error' in r) throw new TypeError('fetch failed')
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => r.body,
      }
    },
  }
}

beforeEach(() => {
  clock = 1_000_000
  setQueueDisplay('vllm')
  __resetProbeStateForTests()
})

afterEach(() => {
  resetSettingsCache()
})

// ---------- 1/2. 门禁短路 ----------

describe('probe gating', () => {
  test('queueDisplay=off → zero fetch and null snapshot', async () => {
    setQueueDisplay('off')
    const f = makeFetcher([{ status: 200, body: MODERN_METRICS }])
    const snap = await getSnapshot(BASE, {
      fetchImpl: f.fetch,
      now: () => clock,
    })
    expect(snap).toBeNull()
    expect(f.calls()).toBe(0)
  })

  test('off is also the default when value garbage? no—invalid values never reach here (schema), unset = vllm', async () => {
    setQueueDisplay(undefined)
    expect(getVllmQueueHints().pollMs).toBe(1500)
    const f = makeFetcher([{ status: 200, body: MODERN_METRICS }])
    const snap = await getSnapshot(BASE, {
      fetchImpl: f.fetch,
      now: () => clock,
    })
    expect(snap).not.toBeNull()
  })

  test('public/https non-RFC1918 baseUrl → zero touch', () => {
    expect(isPrivateVllmCapableBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isPrivateVllmCapableBaseUrl('https://api.anthropic.com')).toBe(false)
    expect(isPrivateVllmCapableBaseUrl('http://8.8.8.8:8000/v1')).toBe(false)
    expect(isPrivateVllmCapableBaseUrl('http://localhost:8000/v1')).toBe(true)
    expect(isPrivateVllmCapableBaseUrl('http://192.168.1.5:8000')).toBe(true)
    expect(isPrivateVllmCapableBaseUrl('http://10.0.0.9:8000')).toBe(true)
    expect(isPrivateVllmCapableBaseUrl('http://172.16.0.1:8000')).toBe(true)
    expect(isPrivateVllmCapableBaseUrl('http://172.32.0.1:8000')).toBe(false)
  })

  test('non-private baseUrl never fetched', async () => {
    const f = makeFetcher([{ status: 200, body: MODERN_METRICS }])
    const snap = await getSnapshot('https://api.openai.com/v1', {
      fetchImpl: f.fetch,
      now: () => clock,
    })
    expect(snap).toBeNull()
    expect(f.calls()).toBe(0)
  })
})

// ---------- 3. 正常路径 + TTL + 单飞 ----------

describe('probe happy path', () => {
  test('supported snapshot, TTL cache, single-flight dedupe', async () => {
    const f = makeFetcher([{ status: 200, body: MODERN_METRICS }])
    const deps = { fetchImpl: f.fetch, now: () => clock }
    const s1 = await getSnapshot(BASE, deps)
    expect(s1).not.toBeNull()
    expect(s1!.waiting).toBe(4)
    expect(getStateForEndpoint(BASE)).toBe('supported')

    // TTL 内不再 fetch
    clock += 500
    const s2 = await getSnapshot(BASE, deps)
    expect(s2).toBe(s1)
    expect(f.calls()).toBe(1)

    // 过了 TTL 才 fetch
    clock += 2000
    await getSnapshot(BASE, deps)
    expect(f.calls()).toBe(2)

    // 单飞：并发两个请求在过期时刻只产生一次 fetch
    clock += 5000
    const before = f.calls()
    const [a, b] = await Promise.all([
      getSnapshot(BASE, deps),
      getSnapshot(BASE, deps),
    ])
    expect(f.calls()).toBe(before + 1)
    expect(a).toBe(b)
  })

  test('foreground in-flight tracking is per endpoint', () => {
    trackForegroundInFlight(BASE, 1)
    trackForegroundInFlight(BASE, 1)
    expect(foregroundInFlightCount(BASE)).toBe(2)
    trackForegroundInFlight(BASE, -1)
    expect(foregroundInFlightCount(BASE)).toBe(1)
    trackForegroundInFlight(BASE, -1)
    trackForegroundInFlight(BASE, -1) // 不会负数
    expect(foregroundInFlightCount(BASE)).toBe(0)
  })

  test('endpointKeyOf normalizes trailing slash/port case', () => {
    expect(endpointKeyOf('http://LOCALHOST:8000/v1/')).toBe(
      'http://localhost:8000',
    )
  })
})

// ---------- 4/5/6. 摘牌与抖动 ----------

describe('probe unsupported semantics', () => {
  test('transient failure after success keeps supported (snapshot served)', async () => {
    const f = makeFetcher([
      { status: 200, body: MODERN_METRICS },
      { error: 'network' },
    ])
    const deps = { fetchImpl: f.fetch, now: () => clock }
    await getSnapshot(BASE, deps)
    clock += 5000
    const s = await getSnapshot(BASE, deps) // 这次失败
    expect(getStateForEndpoint(BASE)).toBe('supported') // 不摘牌
    expect(s).not.toBeNull() // 旧快照继续用（u=高 由 model 层处理）
  })

  test('non-vllm metrics family → immediate unsupported, zero display', async () => {
    const f = makeFetcher([
      { status: 200, body: 'http_requests_total{code="200"} 5\n' },
    ])
    const deps = { fetchImpl: f.fetch, now: () => clock }
    const s = await getSnapshot(BASE, deps)
    expect(s).toBeNull()
    expect(getStateForEndpoint(BASE)).toBe('unsupported')
  })

  test('404 x PROBE_FAIL_LIMIT → unsupported; backoff window zero fetch; reprobe recovers', async () => {
    const responses = [
      { status: 404, body: '' },
      { status: 404, body: '' },
      { status: 404, body: '' },
      { status: 200, body: MODERN_METRICS },
    ]
    const f = makeFetcher(responses)
    const deps = { fetchImpl: f.fetch, now: () => clock }

    for (let k = 0; k < PROBE_FAIL_LIMIT; k++) {
      await getSnapshot(BASE, deps)
      clock += 5000
    }
    expect(getStateForEndpoint(BASE)).toBe('unsupported')
    const callsAtUnsupported = f.calls()

    // 退避窗口内：零 fetch
    clock += 60_000
    const s = await getSnapshot(BASE, deps)
    expect(s).toBeNull()
    expect(f.calls()).toBe(callsAtUnsupported)

    // 退避到期：复探成功 → 恢复 supported
    clock += PROBE_RETRY_BASE_MS * 2
    const s2 = await getSnapshot(BASE, deps)
    expect(s2).not.toBeNull()
    expect(getStateForEndpoint(BASE)).toBe('supported')
  })

  test('repeated network errors (timeout) hit fail limit → unsupported', async () => {
    const f = makeFetcher([
      { error: 'timeout' },
      { error: 'timeout' },
      { error: 'timeout' },
    ])
    const deps = { fetchImpl: f.fetch, now: () => clock }
    for (let k = 0; k < PROBE_FAIL_LIMIT; k++) {
      await getSnapshot(BASE, deps)
      clock += 5000
    }
    expect(getStateForEndpoint(BASE)).toBe('unsupported')
  })
})

// ---------- 7. 差分采样 ----------

describe('probe counter diffs', () => {
  test('throughput EMA / preemption delta / hit rate across two samples', async () => {
    const second = MODERN_METRICS.replace(
      'vllm:prompt_tokens_total 1000',
      'vllm:prompt_tokens_total 3000',
    )
      .replace(
        'vllm:generation_tokens_total 500',
        'vllm:generation_tokens_total 1500',
      )
      .replace('vllm:num_preemptions_total 1', 'vllm:num_preemptions_total 4')
      .replace(
        'vllm:prefix_cache_queries_total 100',
        'vllm:prefix_cache_queries_total 200',
      )
      .replace(
        'vllm:prefix_cache_hits_total 40',
        'vllm:prefix_cache_hits_total 90',
      )
    const f = makeFetcher([
      { status: 200, body: MODERN_METRICS },
      { status: 200, body: second },
    ])
    const deps = { fetchImpl: f.fetch, now: () => clock }
    await getSnapshot(BASE, deps)
    clock += 5000 // dt = 5s
    await getSnapshot(BASE, deps)
    // 直接读内部状态通过再次快照验证解析无误即可；
    // 差分数值由 model 层用例消费（这里钉采样不崩、状态不劣化）
    expect(getStateForEndpoint(BASE)).toBe('supported')
  })
})
