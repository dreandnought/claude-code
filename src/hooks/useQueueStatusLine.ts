/**
 * useQueueStatusLine — Spinner 底部行订阅 vLLM 排队提示（方案 v2.1 批次3 UI 接线）
 * active=false（空闲）恒返回 null；事件源 = statusStore（gate 服务层 publish）。
 */
import { useSyncExternalStore } from 'react'
import {
  getQueueStatusSnapshot,
  subscribeQueueStatus,
} from '../services/api/vllmQueue/statusStore.js'

export function useQueueStatusLine(active: boolean): string | null {
  const snap = useSyncExternalStore(
    subscribeQueueStatus,
    getQueueStatusSnapshot,
    () => null,
  )
  return active && snap ? snap.line : null
}
