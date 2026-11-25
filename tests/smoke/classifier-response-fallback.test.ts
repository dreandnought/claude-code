/**
 * 冒烟测试：classifier 响应恢复层（classifierResponseFallback）
 *
 * 背景：auto mode classifier 单段模式硬依赖 tool_use 块、XML 两阶段硬依赖
 * <block> 标签；vLLM 类后端 forced tool_choice 不生效时 200 响应把判定写在
 * 纯文本里，原路径全部落 fail-closed（恒拒）。恢复层只允许在原误判分支
 * 生效——严格路径成功时零介入（与 2.8.4 行为一致）。
 *
 * 覆盖：
 * 1. 文本通道：裸 JSON / 围栏 JSON / 夹杂 prose / <block> XML（含缺闭合）
 * 2. 键名与值类型变体：should_block/block、字符串布尔、0/1
 * 3. 保守边界：无判定键、无法解析、allow 反向键、thinking 残留剥离
 * 4. normalizeClassifierFields 对 tool_use input 的宽松 schema 恢复
 */
import { describe, expect, test } from 'bun:test'
import {
  normalizeClassifierFields,
  parseClassifierDecisionFromText,
} from '../../src/utils/permissions/classifierResponseFallback'

describe('parseClassifierDecisionFromText — 文本通道恢复', () => {
  test('裸 JSON（vLLM 典型输出：shouldBlock 驼峰）', () => {
    const d = parseClassifierDecisionFromText(
      '{"thinking": "read-only listing", "shouldBlock": false, "reason": "ls is safe"}',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(false)
    expect(d!.reason).toBe('ls is safe')
    expect(d!.thinking).toBe('read-only listing')
  })

  test('JSON 夹杂在 prose 中（前后有解释文字）', () => {
    const d = parseClassifierDecisionFromText(
      'I analyzed the command.\n{"shouldBlock": true, "reason": "curl pipes remote code to bash"}\nHope this helps.',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(true)
    expect(d!.reason).toContain('curl')
  })

  test('```json 围栏代码块', () => {
    const d = parseClassifierDecisionFromText(
      '```json\n{"thinking": "t", "shouldBlock": false, "reason": "r"}\n```',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(false)
  })

  test('snake_case 键名 should_block + 字符串布尔 "false"', () => {
    const d = parseClassifierDecisionFromText(
      '{"should_block": "false", "reason": "harmless"}',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(false)
  })

  test('block 键 + 0/1 数值', () => {
    expect(parseClassifierDecisionFromText('{"block": 1}')?.shouldBlock).toBe(
      true,
    )
    expect(parseClassifierDecisionFromText('{"block": 0}')?.shouldBlock).toBe(
      false,
    )
  })

  test('<block>yes</block> XML（两阶段原生格式，含 reason）', () => {
    const d = parseClassifierDecisionFromText(
      '<block>yes</block><reason>deletes the home directory</reason>',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(true)
    expect(d!.reason).toBe('deletes the home directory')
  })

  test('<block>no 缺闭合标签（parseXmlBlock 同级容忍）', () => {
    const d = parseClassifierDecisionFromText('Reasoning here...\n<block>no')
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(false)
  })

  test('thinking 标签包裹内容被剥离后再解析', () => {
    const d = parseClassifierDecisionFromText(
      '<thinking>a\nmultiline\nreasoning</thinking>{"shouldBlock": false, "reason": "ok"}',
    )
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(false)
  })

  test('未闭合 thinking 吞掉后续内容时不误恢复', () => {
    // <thinking> 开标签未闭合 → stripThinking 把残留全删 → 无判定可恢复
    const d = parseClassifierDecisionFromText(
      '<thinking>rambles on forever {"shouldBlock": false}',
    )
    expect(d).toBeNull()
  })
})

describe('parseClassifierDecisionFromText — 保守边界（宁可回落 fail-closed）', () => {
  test('无判定键的普通 JSON → null', () => {
    expect(
      parseClassifierDecisionFromText('{"answer": "looks fine to me"}'),
    ).toBeNull()
  })

  test('判定键值类型不可 coerce → null', () => {
    expect(
      parseClassifierDecisionFromText('{"shouldBlock": "maybe"}'),
    ).toBeNull()
    expect(parseClassifierDecisionFromText('{"shouldBlock": 2}')).toBeNull()
  })

  test('反向键 allow/approve 不映射（不猜极性）', () => {
    expect(parseClassifierDecisionFromText('{"allow": true}')).toBeNull()
    expect(parseClassifierDecisionFromText('{"approve": false}')).toBeNull()
  })

  test('纯散文无结构 → null（维持原 fail-closed）', () => {
    expect(
      parseClassifierDecisionFromText('The command seems safe to run.'),
    ).toBeNull()
    expect(parseClassifierDecisionFromText('')).toBeNull()
  })

  test('截断的 JSON（无闭合括号）→ null', () => {
    expect(
      parseClassifierDecisionFromText('{"shouldBlock": false, "rea'),
    ).toBeNull()
  })

  test('XML 与 JSON 同时出现时 XML 优先', () => {
    const d = parseClassifierDecisionFromText(
      '{"shouldBlock": true, "reason": "stale"}\n<block>no</block>',
    )
    expect(d!.shouldBlock).toBe(false)
  })
})

describe('normalizeClassifierFields — tool_use input 宽松恢复', () => {
  test('严格 schema 的合法输入同样可通过（等价性）', () => {
    const d = normalizeClassifierFields({
      thinking: 'x',
      shouldBlock: false,
      reason: 'y',
    })
    expect(d).toEqual({ thinking: 'x', shouldBlock: false, reason: 'y' })
  })

  test('字符串布尔 shouldBlock:"true"（lossy parser 产物）', () => {
    const d = normalizeClassifierFields({
      thinking: 't',
      shouldBlock: 'true',
      reason: 'r',
    })
    expect(d).not.toBeNull()
    expect(d!.shouldBlock).toBe(true)
  })

  test('缺 thinking/reason 时补空串（zod required 不再卡死）', () => {
    const d = normalizeClassifierFields({ should_block: false })
    expect(d).toEqual({ thinking: '', shouldBlock: false, reason: '' })
  })

  test('非对象输入 → null', () => {
    expect(normalizeClassifierFields(null)).toBeNull()
    expect(normalizeClassifierFields('no')).toBeNull()
    expect(normalizeClassifierFields(42)).toBeNull()
  })
})
