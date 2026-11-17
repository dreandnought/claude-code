/**
 * vllmQueue ledger — 本地 FIFO 位次记账（方案 v2.1 §2.3，P0 单进程形态）
 *
 * 记录本进程内「已入队且未完成」的请求，给 model.ts 提供 aheadLocal。
 * P0 只记本进程；跨进程票据是 P1（~/.claude/vllm-queue-<hash>.json）。
 * queueDisplay=off 时调用方（gate）保证本模块零读写。
 */
import { getSessionSettingsCache } from '../../../utils/settings/settingsCache.js'

export interface LedgerEntry {
  id: number
  endpoint: string
  enqueuedAt: number
  ownerKind: 'main' | 'subagent' | 'compact' | 'unknown'
  ownerId: string
}

let nextId = 1
const entries = new Map<number, LedgerEntry>()

export function isQueueDisplayEnabledForTests(): boolean {
  return (getSessionSettingsCache() as any)?.settings?.queueDisplay !== 'off'
}

/** 入队登记，返回票据号（完成时用于销账） */
export function enqueue(
  endpoint: string,
  ownerKind: LedgerEntry['ownerKind'],
  ownerId: string,
  now: number,
): number {
  const id = nextId++
  entries.set(id, { id, endpoint, enqueuedAt: now, ownerKind, ownerId })
  return id
}

/** 请求进入运行/结束：销账（任何终态都调，幂等） */
export function complete(ticket: number): void {
  entries.delete(ticket)
}

/** 同端点中早于 ticket 对应请求且未完成的数量 */
export function aheadLocalFor(ticket: number): number {
  const me = entries.get(ticket)
  if (!me) return 0
  let n = 0
  for (const e of entries.values()) {
    if (e.endpoint !== me.endpoint) continue
    if (
      e.enqueuedAt < me.enqueuedAt ||
      (e.enqueuedAt === me.enqueuedAt && e.id < me.id)
    ) {
      n++
    }
  }
  return n
}

/** 该端点我方在途总数（供 maxLocalConcurrency 本地限流，P1 用） */
export function inflightCount(endpoint: string): number {
  let n = 0
  for (const e of entries.values()) {
    if (e.endpoint === endpoint) n++
  }
  return n
}

export function __resetLedgerForTests(): void {
  entries.clear()
  nextId = 1
}
