/**
 * vllmQueue statusStore — QueueStatus 发布/订阅通道（方案 v2.1 §4 事件通道）
 *
 * gate（服务层）publish，REPL/Spinner（UI 层）经 useQueueStatusLine 订阅。
 * 单槽 + 归属 key：最后写入者获胜；其请求 dispose 时清行，
 * 其他仍在排队的请求下一拍重新 publish —— P0 可接受的收敛行为。
 */

export interface QueueStatusEntry {
  line: string
  key: string
  publishedAt: number
}

let current: QueueStatusEntry | null = null
const listeners = new Set<() => void>()

export function publishQueueStatus(entry: QueueStatusEntry): void {
  current = entry
  notify()
}

/** key 匹配当前行拥有者才清除（避免误伤其他在排队的请求） */
export function clearQueueStatus(key: string): void {
  if (current !== null && current.key === key) {
    current = null
    notify()
  }
}

export function getQueueStatusSnapshot(): QueueStatusEntry | null {
  return current
}

export function subscribeQueueStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      // UI 订阅异常不能拖垮服务层
    }
  }
}

export function __resetQueueStatusForTests(): void {
  current = null
  listeners.clear()
}
