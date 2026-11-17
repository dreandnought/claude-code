/**
 * vllmQueue estimate — 不确定性感知分档文案（方案 v2.1 §3）
 * 纯函数。措辞分级：u 低报具体数；u 中给区间；u 高放粗到「队列较长 · 开始时间待定」。
 */
import type { ModelEstimate } from './model.js'

export interface DisplayParts {
  /** 是否值得显示排队行（推理中/无队可排 → false） */
  show: boolean
  text: string
}

/** 位次分档（u 每升一级把当前档再放粗一级） */
export function rankBucket(ahead: number, u: 0 | 1 | 2): string {
  let tier = rankTier(ahead)
  for (let k = 0; k < u; k++) tier = coarsenTier(tier)
  return renderRankTier(tier, ahead)
}

type RankTier = 'one' | 'few' | 'round5' | 'twenty' | 'fifty'

function rankTier(ahead: number): RankTier {
  if (ahead <= 1) return 'one'
  if (ahead <= 5) return 'few'
  if (ahead <= 20) return 'round5'
  if (ahead <= 50) return 'twenty'
  return 'fifty'
}

function coarsenTier(t: RankTier): RankTier {
  switch (t) {
    case 'one':
      return 'few'
    case 'few':
      return 'round5'
    case 'round5':
      return 'twenty'
    case 'twenty':
    case 'fifty':
      return 'fifty'
  }
}

function renderRankTier(t: RankTier, ahead: number): string {
  switch (t) {
    case 'one':
      return '前面 1 个'
    case 'few':
      return `前面 ${ahead} 个`
    case 'round5':
      return `前面约 ${Math.round(ahead / 5) * 5} 个`
    case 'twenty':
      return '前面 20+ 个'
    case 'fifty':
      return '排队较多（50+）'
  }
}

/** ETA 分档：<30s / ~1min / N min / >10min */
export function etaBucket(etaSec: number): string {
  if (etaSec < 30) return `预计 ${Math.max(1, Math.round(etaSec))}s`
  if (etaSec < 75) return '预计 ~1min'
  if (etaSec <= 600) return `预计 ${Math.round(etaSec / 60)}min`
  return '预计 >10min'
}

export function renderQueueLine(
  est: ModelEstimate,
  opts: { showEta: boolean; uncertaintyHints: boolean; suffix?: string },
): DisplayParts {
  const { ahead, etaSec, uncertainty: uRaw, kind } = est

  if (kind === 'endpoint_full') {
    return { show: true, text: '⛔ 端点队列已满（503），已自动退避' }
  }

  const u = opts.uncertaintyHints ? uRaw : (Math.min(uRaw, 1) as 0 | 1 | 2)

  // 无队可排且我在跑 → 推理中，不显示排队行（防长思考误报，方案 §4.4-2）
  if (est.selfLikelyRunning && ahead <= 1 && etaSec === null) {
    return { show: false, text: '' }
  }
  if (ahead <= 0) return { show: false, text: '' }

  if (u === 2) {
    const kv = kind === 'near_full' ? ' · KV 接近满载' : ''
    return {
      show: true,
      text: `⏳ 排队中 · 队列较长 · 开始时间待定${kv}${tail(opts.suffix)}`,
    }
  }

  const rank = rankBucket(ahead, u)
  const parts = ['⏳ 排队中', rank]
  if (kind === 'deferred_backlog') {
    parts.push('⚠️ 排队请求受阻（资源延迟积压），恢复时间不确定')
  } else if (opts.showEta && etaSec !== null) {
    parts.push(etaBucket(etaSec))
  }
  if (kind === 'near_full') parts.push('🧊 KV 缓存接近满载')
  return { show: true, text: `${parts.join(' · ')}${tail(opts.suffix)}` }
}

function tail(suffix: string | undefined): string {
  return suffix ? `（${suffix}）` : ''
}

/**
 * 退避时长建议（P0 简单形态：有 ETA → 半程等待，夹在 [500ms, 30s]；
 * ETA 指导的完整退避策略在 P1 接线时精调）。
 */
export function suggestedBackoffMs(
  etaSec: number | null,
  fallbackMs: number,
): number {
  if (etaSec === null || etaSec <= 0) return fallbackMs
  const half = Math.min(etaSec * 0.5, 30) * 1000
  return Math.max(500, Math.min(fallbackMs, half))
}
