/**
 * 基础性能基线守卫
 *
 * 目的：变更（新 helper、新配置读取、日志埋点）混进热路径时，这里在 CI
 * 阶段就报回归，而不是等用户感觉到卡顿。阈值 = 2026-11-16 实测校准值的
 * 数量级放宽（本机：火山引擎 4C/3.8G，Xeon 8336C），容忍 CI 噪声但抓住
 * 「热路径里多出一次同步 IO / 全量扫描」级别的劣化。
 *
 * 校准方法：min-of-3 次运行取最优，单次运行内先预热。
 *
 * 重校命令（性能基线本身变化时执行并更新阈值/日期）：
 *   bun test tests/smoke/perf-baseline.test.ts --verbose
 */
import { describe, expect, test } from 'bun:test'
import {
  estimateTokensFromPayload,
  getContextWindowForModel,
} from '../../src/utils/context'
import { recordObservedContextLimit } from '../../src/utils/contextLimitOverride'

/** min-of-3 bench：返回单次操作毫秒数（取 3 次总时间的最小值）。 */
function bench(fn: () => void, iters: number): number {
  fn() // warmup（JIT / memo 填充）
  let best = Number.POSITIVE_INFINITY
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    const t1 = performance.now()
    best = Math.min(best, (t1 - t0) / iters)
  }
  return best
}

const REPORT = process.env.CCB_SMOKE_PERF_VERBOSE === '1'

function check(name: string, actualMs: number, budgetMs: number): void {
  if (REPORT) {
    console.log(
      `[perf-baseline] ${name}: ${actualMs.toFixed(4)} ms/op (budget ${budgetMs})`,
    )
  }
  expect(
    actualMs,
    `${name} regressed: ${actualMs.toFixed(4)} ms/op > budget ${budgetMs} ms/op（重跑校准：见文件头注释）`,
  ).toBeLessThanOrEqual(budgetMs)
}

describe('perf baseline: context budgeting hot paths', () => {
  // 这些函数在每轮请求 / 每次渲染 / 每次 compaction 判定里被反复调用，
  // 单次 0.01ms 的劣化在大上下文会话里会被放大成可感知延迟。

  test('getContextWindowForModel (memo hit) stays sub-µs', () => {
    recordObservedContextLimit('perf-model', 131_072)
    const ms = bench(() => getContextWindowForModel('perf-model'), 100_000)
    // 校准 2026-11-16: ~0.0001 ms/op → 预算 0.005（50×，防同步IO混入）
    check('context-window-memo-hit', ms, 0.005)
  })

  test('getContextWindowForModel (cache miss) stays cheap', () => {
    let n = 0
    const ms = bench(
      () => getContextWindowForModel('perf-model-' + (n++ % 1000)),
      10_000,
    )
    // 校准 2026-11-16: ~0.0053 ms/op → 预算 0.05
    check('context-window-cache-miss', ms, 0.05)
  })

  test('estimateTokensFromPayload (2KB payload) stays cheap', () => {
    const ms = bench(
      () =>
        estimateTokensFromPayload({ role: 'user', content: 'x'.repeat(2_000) }),
      10_000,
    )
    // 校准 2026-11-16: ~0.0052 ms/op → 预算 0.05
    check('estimate-tokens-2kb', ms, 0.05)
  })
})

describe('perf baseline: message & tool surface assembly', () => {
  test('getAllBaseTools assembly is sub-millisecond', async () => {
    const { getAllBaseTools } = await import('../../src/tools')
    getAllBaseTools() // warmup
    const ms = bench(() => getAllBaseTools(), 2_000)
    // 工具池每次 API 请求组装一次；校准数量级 0.01–0.1ms → 预算 1ms
    check('get-all-base-tools', ms, 1)
  })

  test('getTools with default context is sub-millisecond', async () => {
    const { getTools } = await import('../../src/tools')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool')
    const ctx = getEmptyToolPermissionContext()
    getTools(ctx)
    const ms = bench(() => getTools(ctx), 1_000)
    check('get-tools-empty-ctx', ms, 2)
  })
})

describe('perf baseline: CLI cold start (built bundle)', () => {
  test('`--version` process wall time stays under budget', async () => {
    const { existsSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const root = resolve(import.meta.dir, '../..')
    const entry = join(root, 'dist/cli.js')
    if (!existsSync(entry)) return // 未构建时跳过，由 cli-boot.test.ts 提示

    const runOnce = async () => {
      const t0 = performance.now()
      const proc = Bun.spawn([process.execPath, entry, '--version'], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      })
      await proc.exited
      return performance.now() - t0
    }

    await runOnce() // warmup（文件系统缓存）
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      best = Math.min(best, await runOnce())
    }
    // 校准 2026-11-16: ~30ms → 预算 1500ms（容忍 CI 冷 FS / 并发负载）
    check('cli-version-wall', best, 1_500)
  }, 30_000)
})
