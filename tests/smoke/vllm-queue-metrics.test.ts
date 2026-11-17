/**
 * 基础能力冒烟测试：vllmQueue metrics 解析层（方案 v2.1 批次1）
 *
 * 覆盖：
 * 1. Prometheus 文本解析（标签/引号转义/时间戳行/NaN±Inf/畸形行）
 * 2. histogram 三件套 + 跨 engine 合并 + 分位数线性插值
 * 3. 指标名代际容错（gpu_cache_usage_perc、waiting_gpu、_total 后缀）
 * 4. waiting_by_reason 拆分、model_name/engine 标签提取
 * 5. 非 vLLM 响应 → hasVllmMetrics=false（probe 层静默降级依据）
 * 6. 全链路永不抛异常（方案 §9：解析崩主链路是必须避免的回归）
 */
import { describe, expect, test } from 'bun:test'
import {
  buildHistogram,
  histogramMean,
  histogramQuantile,
  parsePromNumber,
  parsePrometheusText,
  parseVllmMetrics,
} from '../../src/services/api/vllmQueue/metrics'

// ---------- fixtures：贴近真实 vLLM /metrics 输出 ----------

const VLLM_MODERN = `# HELP vllm:num_requests_running Number of requests currently running on GPU.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="deepseek-v4-flash"} 3
vllm:num_requests_running{engine="1",model_name="deepseek-v4-flash"} 2
# HELP vllm:num_requests_waiting Number of requests waiting to be processed.
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine="0",model_name="deepseek-v4-flash"} 7
vllm:num_requests_waiting{engine="1",model_name="deepseek-v4-flash"} 5
vllm:num_requests_waiting_by_reason{engine="0",model_name="m",reason="capacity"} 6
vllm:num_requests_waiting_by_reason{engine="0",model_name="m",reason="deferred"} 6
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine="0",model_name="deepseek-v4-flash"} 0.42
# TYPE vllm:request_queue_time_seconds histogram
vllm:request_queue_time_seconds_bucket{engine="0",le="0.1"} 10
vllm:request_queue_time_seconds_bucket{engine="0",le="0.5"} 30
vllm:request_queue_time_seconds_bucket{engine="0",le="1"} 45
vllm:request_queue_time_seconds_bucket{engine="0",le="+Inf"} 50
vllm:request_queue_time_seconds_sum{engine="0"} 40
vllm:request_queue_time_seconds_count{engine="0"} 50
vllm:request_queue_time_seconds_bucket{engine="1",le="0.1"} 2
vllm:request_queue_time_seconds_bucket{engine="1",le="0.5"} 6
vllm:request_queue_time_seconds_bucket{engine="1",le="1"} 8
vllm:request_queue_time_seconds_bucket{engine="1",le="+Inf"} 10
vllm:request_queue_time_seconds_sum{engine="1"} 8
vllm:request_queue_time_seconds_count{engine="1"} 10
# TYPE vllm:prompt_tokens counter
vllm:prompt_tokens_total{model_name="deepseek-v4-flash"} 123456
vllm:generation_tokens_total{model_name="deepseek-v4-flash"} 654321
vllm:num_preemptions_total{model_name="deepseek-v4-flash"} 4
vllm:request_success_total{model_name="deepseek-v4-flash",finished_reason="stop"} 100
vllm:request_success_total{model_name="deepseek-v4-flash",finished_reason="length"} 20
vllm:prefix_cache_queries_total 1000
vllm:prefix_cache_hits_total 400
vllm:admission_rejections_total 2
`

const VLLM_LEGACY = `vllm:num_requests_running{model_name="qwen3-coder"} 1
vllm:num_requests_waiting_gpu{model_name="qwen3-coder",gpu="0"} 3
vllm:num_requests_waiting_gpu{model_name="qwen3-coder",gpu="1"} 2
vllm:gpu_cache_usage_perc{model_name="qwen3-coder"} 0.91
vllm:request_queue_time_seconds_bucket{le="1"} 5
vllm:request_queue_time_seconds_bucket{le="+Inf"} 5
vllm:request_queue_time_seconds_sum 2.5
vllm:request_queue_time_seconds_count 5
vllm:prompt_tokens{model_name="qwen3-coder"} 999
`

const NON_VLLM_PROMETHEUS = `# something like a LiteLLM / nginx exporter
http_requests_total{code="200"} 12
process_cpu_seconds_total 345.6
node_memory_MemAvailable_bytes 8.1e+09
`

// ---------- 1. Prometheus 文本解析 ----------

describe('parsePrometheusText', () => {
  test('parses labeled samples and strips comments', () => {
    const samples = parsePrometheusText(VLLM_MODERN)
    const running = samples.filter(s => s.name === 'vllm:num_requests_running')
    expect(running.length).toBe(2)
    expect(running[0]!.labels['engine']).toBe('0')
    expect(running[0]!.value).toBe(3)
  })

  test('handles no-label lines and trailing timestamps', () => {
    const samples = parsePrometheusText(
      'metric_a 1\nmetric_b 2 1700000000000\nmetric_c{le="1"} 3 1700000000000',
    )
    expect(samples.map(s => s.value)).toEqual([1, 2, 3])
  })

  test('skips NaN / Inf / malformed values', () => {
    const samples = parsePrometheusText('x 1\ny NaN\nz +Inf\nw -Inf\nbroken\n')
    expect(samples.map(s => s.name)).toEqual(['x'])
    expect(parsePromNumber('NaN')).toBeNull()
    expect(parsePromNumber('1e3')).toBe(1000)
  })

  test('unescapes quoted label values with braces/commas inside', () => {
    const samples = parsePrometheusText('m{reason="a{b",model_name="x,y"} 7\n')
    expect(samples[0]!.labels).toEqual({ reason: 'a{b', model_name: 'x,y' })
    expect(samples[0]!.value).toBe(7)
  })
})

// ---------- 2. histogram 合并与分位数 ----------

describe('histogram', () => {
  const samples = parsePrometheusText(VLLM_MODERN)
  const h = buildHistogram(samples, 'vllm:request_queue_time_seconds')!

  test('merges engines and keeps cumulative monotonic', () => {
    expect(h).not.toBeNull()
    expect(h.count).toBe(60) // 50 + 10
    expect(h.sum).toBe(48)
    const le1 = h.buckets.find(b => b.le === 1)!
    expect(le1.cumulative).toBe(53) // 45 + 8
    expect(h.buckets[h.buckets.length - 1]!.le).toBe(Infinity)
  })

  test('quantile interpolates within bucket (PromQL semantics)', () => {
    // P50 target=30 → le=0.5 桶（cum 30→53 之间已含）：prev(0.1,12) cum=12?
    // 合并后：le0.1=12, le0.5=36, le1=53
    const p50 = histogramQuantile(h, 0.5)!
    expect(p50).toBeGreaterThan(0.1)
    expect(p50).toBeLessThanOrEqual(0.5)
    const p90 = histogramQuantile(h, 0.9)!
    expect(p90).toBeGreaterThan(0.5)
    expect(p90).toBeLessThanOrEqual(1)
  })

  test('quantile of empty histogram is null; mean uses sum/count', () => {
    expect(histogramQuantile(null, 0.5)).toBeNull()
    expect(histogramQuantile({ buckets: [], sum: 0, count: 0 }, 0.5)).toBeNull()
    expect(histogramMean(h)).toBeCloseTo(48 / 60)
  })

  test('missing buckets → null (older deployments without histogram)', () => {
    expect(
      buildHistogram(samples, 'vllm:request_decode_time_seconds'),
    ).toBeNull()
  })
})

// ---------- 3/4/5. 快照：代际容错 + 拆分 + 能力判定 ----------

describe('parseVllmMetrics snapshot', () => {
  test('modern: gauges summed across engines, reasons split', () => {
    const s = parseVllmMetrics(VLLM_MODERN, 1000)
    expect(s.hasVllmMetrics).toBe(true)
    expect(s.engineCount).toBe(2)
    expect(s.modelName).toBe('deepseek-v4-flash')
    expect(s.running).toBe(5)
    expect(s.waiting).toBe(12)
    // by_reason 存在 → 用它拆 capacity/deferred（求和跨 engine）
    expect(s.waitingByReason.capacity).toBe(6)
    expect(s.waitingByReason.deferred).toBe(6)
    expect(s.kvCacheUsage).toBeCloseTo(0.42)
    expect(s.promptTokens).toBe(123456)
    expect(s.preemptions).toBe(4)
    expect(s.requestSuccess).toBe(120) // finished_reason 多标签求和
    expect(s.admissionRejections).toBe(2)
    expect(s.fetchedAt).toBe(1000)
  })

  test('legacy names: gpu_cache_usage_perc / waiting_gpu / no _total suffix', () => {
    const s = parseVllmMetrics(VLLM_LEGACY, 1)
    expect(s.hasVllmMetrics).toBe(true)
    expect(s.waiting).toBe(5)
    expect(s.kvCacheUsage).toBeCloseTo(0.91)
    expect(s.waitingByReason).toEqual({ capacity: 5, deferred: 0 })
    expect(s.promptTokens).toBe(999)
    expect(s.engineCount).toBe(1) // 无 engine 标签视为单 engine
  })

  test('non-vLLM metrics → hasVllmMetrics false, all-zero snapshot', () => {
    const s = parseVllmMetrics(NON_VLLM_PROMETHEUS, 1)
    expect(s.hasVllmMetrics).toBe(false)
    expect(s.running).toBe(0)
    expect(s.queueTimeHist).toBeNull()
    expect(s.engineCount).toBe(0)
  })

  test('garbage input never throws (parse must never break the main path)', () => {
    for (const junk of ['', '{{{', 'vllm:', 'vllm:x{ 1\n🔥', 'vllm:x 1e999']) {
      expect(() => parseVllmMetrics(junk, 0)).not.toThrow()
    }
  })
})
