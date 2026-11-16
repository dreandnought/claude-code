/**
 * 基础能力冒烟测试：Bash 退出码解释语义（真实回归场景）
 *
 * 回归来源（commit 9be2d214）：`cd /missing && rg needle .` 的聚合退出码 1
 * 来自 `cd`，若按 rg 的「1 = 无匹配」语义解释会把真实失败误判为成功。
 * 规则：&& 短路列表使「最后执行的命令」不可判定 → 一律回退保守默认语义；
 * 管道（无 pipefail）安全，末命令决定聚合状态。
 *
 * 另覆盖 grep/diff/find/test 的信息型退出码语义，这些是模型读 Bash 结果时
 * 的既成约定，改动解释规则会直接误导 agent。
 */
import { describe, expect, test } from 'bun:test'

const { interpretCommandResult } = await import(
  '@claude-code-best/builtin-tools/tools/BashTool/commandSemantics'
)

describe('bash semantics: AND-list short-circuit (regression 9be2d214)', () => {
  test('cd failure inside && list is an error, not grep-style success', () => {
    const r = interpretCommandResult(
      'cd /missing-dir && rg needle .',
      1,
      '',
      '',
    )
    expect(r.isError).toBe(true)
  })

  test('&& list never inherits last-command informational semantics', () => {
    for (const cmd of [
      'true && grep nomatch file',
      'false && diff a b',
      'cd x && test -f y',
    ]) {
      const r = interpretCommandResult(cmd, 1, '', '')
      expect(r.isError, cmd).toBe(true)
    }
  })

  test('exit 0 in && list remains success', () => {
    expect(
      interpretCommandResult('cd ok-dir && rg found .', 0, 'match', '').isError,
    ).toBe(false)
  })

  test('pipes keep last-command semantics (no pipefail assumption)', () => {
    const r = interpretCommandResult(
      'cat missing.txt | grep nomatch',
      1,
      '',
      '',
    )
    expect(r.isError).toBe(false)
    expect(r.message).toBe('No matches found')
  })
})

describe('bash semantics: informational exit codes', () => {
  test('grep/rg: 1 = no matches (ok), 2+ = error', () => {
    expect(interpretCommandResult('grep a f', 1, '', '').isError).toBe(false)
    expect(interpretCommandResult('rg a f', 1, '', '').isError).toBe(false)
    expect(interpretCommandResult('grep a f', 2, '', 'bad regex').isError).toBe(
      true,
    )
  })

  test('diff: 1 = files differ (ok), 2 = error', () => {
    expect(interpretCommandResult('diff a b', 1, '', '').isError).toBe(false)
    expect(interpretCommandResult('diff a b', 2, '', '').isError).toBe(true)
  })

  test('find: 1 = partial success (ok), 2 = error', () => {
    expect(interpretCommandResult('find . -name x', 1, '', '').isError).toBe(
      false,
    )
    expect(interpretCommandResult('find . -name x', 2, '', '').isError).toBe(
      true,
    )
  })

  test('test/[: 1 = condition false (ok), 2 = error', () => {
    expect(interpretCommandResult('test -f x', 1, '', '').isError).toBe(false)
    expect(interpretCommandResult('[ -f x ]', 1, '', '').isError).toBe(false)
    expect(interpretCommandResult('test -f x', 2, '', '').isError).toBe(true)
  })

  test('unknown commands: only 0 is success', () => {
    expect(interpretCommandResult('python x.py', 0, '', '').isError).toBe(false)
    expect(interpretCommandResult('python x.py', 1, '', '').isError).toBe(true)
    expect(interpretCommandResult('node y.js', 127, '', '').isError).toBe(true)
  })
})
