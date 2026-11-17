/**
 * vllmQueue metrics — Prometheus 文本解析 + vLLM 快照构建 + 分位数插值
 * （方案 v2.1 §1.1 / §4 批次1：纯函数、可离线测，无任何 IO）
 *
 * 容错要求（方案 §9）：
 * - 指标名代际差异：gpu_cache_usage_perc → kv_cache_usage_perc、
 *   counter 带/不带 _total 后缀都接受；
 * - 直方图三件套 *_bucket{le}/_sum/_count 全解析；缺族置 null 不报错；
 * - 主链路永不因解析崩：任何单样本畸形只丢该样本。
 */
import type { RawSample, VllmHistogram, VllmSnapshot } from './types.js'

// ---------- Prometheus 文本解析 ----------

/**
 * 解析 Prometheus  exposition format 的样本行。
 * 忽略 # 注释/TYPE/HELP；跳过无法转成有限数字的行。
 */
export function parsePrometheusText(text: string): RawSample[] {
  const out: RawSample[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const sample = parseSampleLine(line)
    if (sample !== null) out.push(sample)
  }
  return out
}

function parseSampleLine(line: string): RawSample | null {
  const braceStart = line.indexOf('{')
  let name: string
  let labels: Record<string, string> = {}
  let valueStr: string

  if (braceStart === -1) {
    const parts = line.split(/\s+/)
    if (parts.length < 2) return null
    name = parts[0]!
    valueStr = parts[1]!
  } else {
    const braceEnd = findClosingBrace(line, braceStart)
    if (braceEnd === -1) return null
    name = line.slice(0, braceStart).trim()
    labels = parseLabels(line.slice(braceStart + 1, braceEnd))
    const rest = line.slice(braceEnd + 1).trim()
    const parts = rest.split(/\s+/)
    valueStr = parts[0]!
  }

  if (!name) return null
  const value = parsePromNumber(valueStr)
  if (value === null) return null
  return { name, labels, value }
}

/** 找到与 braceStart 处 '{' 配对的 '}'（跳过引号内的括号） */
function findClosingBrace(line: string, braceStart: number): number {
  let inQuote: string | null = null
  for (let i = braceStart + 1; i < line.length; i++) {
    const ch = line[i]
    if (inQuote !== null) {
      if (ch === '\\')
        i++ // 跳过转义字符
      else if (ch === inQuote) inQuote = null
    } else if (ch === '"' || ch === "'") inQuote = ch
    else if (ch === '}') return i
  }
  return -1
}

function parseLabels(src: string): Record<string, string> {
  const labels: Record<string, string> = {}
  let i = 0
  while (i < src.length) {
    // 跳过分隔空白/逗号
    while (i < src.length && /[\s,]/.test(src[i]!)) i++
    const eq = src.indexOf('=', i)
    if (eq === -1) break
    const key = src.slice(i, eq).trim()
    if (src[eq + 1] !== '"') {
      // 非引号值（不合规但偶见），读到逗号/空白
      let j = eq + 1
      while (j < src.length && !/[\s,]/.test(src[j]!)) j++
      if (key) labels[key] = src.slice(eq + 1, j)
      i = j
      continue
    }
    let j = eq + 2
    let value = ''
    while (j < src.length) {
      const ch = src[j]!
      if (ch === '\\') {
        const next = src[j + 1]
        if (next === 'n') value += '\n'
        else if (next === undefined) break
        else value += next
        j += 2
        continue
      }
      if (ch === '"') break
      value += ch
      j++
    }
    if (key) labels[key] = value
    i = j + 1
  }
  return labels
}

/** Prometheus 特殊数值：NaN / +Inf / -Inf / 科学计数。非有限值返回 null。 */
export function parsePromNumber(s: string | undefined): number | null {
  if (s === undefined || s === '') return null
  if (s === 'NaN' || s === '+Inf' || s === 'Inf') return null
  if (s === '-Inf') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// ---------- 指标族查找（多代名字容错） ----------

function sumByNames(samples: RawSample[], names: string[]): number {
  let total = 0
  for (const s of samples) {
    if (names.includes(s.name)) total += s.value
  }
  return total
}

function firstPresent(samples: RawSample[], names: string[]): number {
  for (const n of names) {
    if (samples.some(s => s.name === n)) {
      return sumByNames(samples, [n])
    }
  }
  return 0
}

/** counter 族：先试带 _total，再试不带 */
function counterSum(samples: RawSample[], base: string): number {
  return firstPresent(samples, [`${base}_total`, base])
}

/** gauge 族：候选名按优先级取第一个出现的 */
function gaugeSum(samples: RawSample[], candidates: string[]): number {
  return firstPresent(samples, candidates)
}

// ---------- histogram 构建与分位数 ----------

/**
 * 从样本流中抽取一个 histogram 族；跨 engine/label 合并（求和）。
 * 缺 _bucket 或无有效桶时返回 null。
 */
export function buildHistogram(
  samples: RawSample[],
  base: string,
): VllmHistogram | null {
  const bucketName = `${base}_bucket`
  const sumName = `${base}_sum`
  const countName = `${base}_count`

  const perLe = new Map<number, number>()
  let sawBucket = false
  for (const s of samples) {
    if (s.name !== bucketName) continue
    sawBucket = true
    const leStr = s.labels['le']
    if (leStr === undefined) continue
    const le = leStr === '+Inf' ? Infinity : Number(leStr)
    if (!Number.isFinite(le) && le !== Infinity) continue
    if (le === Infinity) continue // +Inf 桶由 _count 收尾补
    perLe.set(le, (perLe.get(le) ?? 0) + s.value)
  }
  if (!sawBucket || perLe.size === 0) return null

  const sum = sumByNames(samples, [sumName])
  const count = sumByNames(samples, [countName])

  const buckets = [...perLe.entries()]
    .filter(([, v]) => v >= 0)
    .sort((a, b) => a[0] - b[0])
    .map(([le, cumulative]) => ({ le, cumulative }))

  // 强制累积单调（畸形输入兜底）
  let running = 0
  for (const b of buckets) {
    running = Math.max(running, b.cumulative)
    b.cumulative = running
  }
  buckets.push({ le: Infinity, cumulative: Math.max(running, count) })

  return { buckets, sum, count: Math.max(running, count) }
}

/**
 * 分位数线性插值（与 PromQL histogram_quantile 同法）。
 * count 为 0 返回 null。
 */
export function histogramQuantile(
  h: VllmHistogram | null,
  q: number,
): number | null {
  if (h === null || h.count <= 0) return null
  const qq = Math.min(Math.max(q, 0), 1)
  const target = qq * h.count
  let prevCum = 0
  let prevLe = 0
  for (const b of h.buckets) {
    if (b.cumulative >= target) {
      if (b.le === Infinity) return prevLe // 最高有限边界
      const span = b.cumulative - prevCum
      if (span <= 0 || prevLe === b.le) return b.le
      // 桶内线性插值
      return prevLe + (b.le - prevLe) * ((target - prevCum) / span)
    }
    prevCum = b.cumulative
    prevLe = b.le
  }
  const lastFinite = h.buckets.filter(b => b.le !== Infinity).pop()
  return lastFinite ? lastFinite.le : null
}

/** 直方图均值 = sum/count；无数据返回 null */
export function histogramMean(h: VllmHistogram | null): number | null {
  if (h === null || h.count <= 0) return null
  return h.sum / h.count
}

// ---------- 快照构建 ----------

/**
 * 把样本流装配成端点快照。fetchedAt 由调用方传入保持纯函数。
 * hasVllmMetrics=false 时其余字段全零/空（probe 层据此判 unsupported）。
 */
export function buildVllmSnapshot(
  samples: RawSample[],
  fetchedAt: number,
): VllmSnapshot {
  const vllmSamples = samples.filter(s => s.name.startsWith('vllm:'))
  const hasVllmMetrics = vllmSamples.length > 0

  // engine 数：running 族的 engine 标签去重；无该标签视为单 engine
  const engineIds = new Set<string>()
  for (const s of vllmSamples) {
    if (
      s.name === 'vllm:num_requests_running' ||
      s.name === 'vllm:num_requests_running_total'
    ) {
      engineIds.add(s.labels['engine'] ?? '0')
    }
  }

  let modelName = ''
  for (const s of vllmSamples) {
    if (s.labels['model_name']) {
      modelName = s.labels['model_name']!
      break
    }
  }

  const waiting = gaugeSum(vllmSamples, [
    'vllm:num_requests_waiting',
    'vllm:num_requests_waiting_gpu', // 旧版 per-GPU 命名
  ])
  const reasonSamples = vllmSamples.filter(
    s => s.name === 'vllm:num_requests_waiting_by_reason',
  )
  let capacity = 0
  let deferred = 0
  for (const s of reasonSamples) {
    if (s.labels['reason'] === 'deferred') deferred += s.value
    else capacity += s.value
  }
  const waitingByReason =
    reasonSamples.length > 0
      ? { capacity, deferred }
      : { capacity: waiting, deferred: 0 }

  return {
    fetchedAt,
    hasVllmMetrics,
    engineCount: Math.max(engineIds.size, hasVllmMetrics ? 1 : 0),
    modelName,

    running: gaugeSum(vllmSamples, ['vllm:num_requests_running']),
    waiting,
    waitingByReason,
    kvCacheUsage: gaugeSum(vllmSamples, [
      'vllm:kv_cache_usage_perc',
      'vllm:gpu_cache_usage_perc', // 旧版命名
    ]),

    requestSuccess: counterSum(vllmSamples, 'vllm:request_success'),
    preemptions: counterSum(vllmSamples, 'vllm:num_preemptions'),
    promptTokens: counterSum(vllmSamples, 'vllm:prompt_tokens'),
    generationTokens: counterSum(vllmSamples, 'vllm:generation_tokens'),
    prefixCacheQueries: counterSum(vllmSamples, 'vllm:prefix_cache_queries'),
    prefixCacheHits: counterSum(vllmSamples, 'vllm:prefix_cache_hits'),
    admissionRejections: counterSum(vllmSamples, 'vllm:admission_rejections'),

    queueTimeHist: buildHistogram(
      vllmSamples,
      'vllm:request_queue_time_seconds',
    ),
    prefillTimeHist: buildHistogram(
      vllmSamples,
      'vllm:request_prefill_time_seconds',
    ),
    decodeTimeHist: buildHistogram(
      vllmSamples,
      'vllm:request_decode_time_seconds',
    ),
    ttftHist: buildHistogram(vllmSamples, 'vllm:time_to_first_token_seconds'),
    itlHist: buildHistogram(vllmSamples, 'vllm:inter_token_latency_seconds'),
    promptTokensHist: buildHistogram(vllmSamples, 'vllm:request_prompt_tokens'),
    maxGenTokensHist: buildHistogram(
      vllmSamples,
      'vllm:request_max_num_generation_tokens',
    ),
  }
}

/** 一步到位：文本 → 快照 */
export function parseVllmMetrics(
  text: string,
  fetchedAt: number,
): VllmSnapshot {
  return buildVllmSnapshot(parsePrometheusText(text), fetchedAt)
}
