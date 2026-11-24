/**
 * vllmQueue estimate — 不确定性感知分档文案（方案 v2.2）
 * 纯函数。v2.2：ETA 分档下线；rankBucket 改为精确优先
 * （u0 报准数、u1 约数、u2 才放粗——位次源是 vLLM gauge，本就精确）。
 */
import type { ModelEstimate } from './model.js'

export interface DisplayParts {
  /** 是否值得显示排队行（推理中/无队可排 → false） */
  show: boolean
  text: string
}

/** 位次分档：数据源为精确 gauge，默认报准数，仅高不确定时放粗 */
export function rankBucket(ahead: number, u: 0 | 1 | 2): string {
  if (ahead <= 0) return '前面 0 个'
  switch (u) {
    case 0:
      return `前面 ${ahead} 个`
    case 1:
      return ahead <= 10
        ? `前面约 ${ahead} 个`
        : `前面约 ${Math.ceil(ahead / 5) * 5} 个`
    case 2:
      if (ahead <= 3) return '前面没几个'
      if (ahead <= 10) return `前面 ${ahead} 个上下`
      return '前面十几个起'
  }
}

export function renderQueueLine(
  est: ModelEstimate,
  opts: { uncertaintyHints: boolean; suffix?: string },
): DisplayParts {
  const { ahead, kind, selfLikelyRunning } = est
  const u = opts.uncertaintyHints ? est.uncertainty : 0

  if (kind === 'endpoint_full') {
    return { show: true, text: '⛔ 端点队列已满（503），已自动退避' }
  }

  // 我已准入（waiting=0 且本地无在前请求）→ 推理中，恢复原始 spinner（§4.4-2）
  if (selfLikelyRunning) return { show: false, text: '' }
  if (ahead <= 0) return { show: false, text: '' }

  const parts = ['⏳ 排队中', rankBucket(ahead, u)]
  if (kind === 'deferred_backlog') {
    parts.push('⚠️ 排队请求受阻（资源延迟积压）')
  }
  if (kind === 'near_full') parts.push('🧊 KV 缓存接近满载')
  return { show: true, text: `${parts.join(' · ')}${tail(opts.suffix)}` }
}

function tail(suffix: string | undefined): string {
  return suffix ? `（${suffix}）` : ''
}
