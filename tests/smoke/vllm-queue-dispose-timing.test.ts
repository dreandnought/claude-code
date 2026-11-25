/**
 * 排队行 dispose 触发点测试（v2.2 真机 bug 回归）
 *
 * 真机事实：vLLM（Anthropic/OpenAI 兼容端点）在请求仍处于 waiting 时就回
 * 200 + 响应头（实测 +0.15s），body 首块要等准入后才到（排队 100s+ 的请求
 * 首块在 +103s）。旧接线「响应头到达即 dispose」导致排队行刚出现就被撕掉。
 *
 * 本测试钉死新语义：dispose 必须发生在
 *   ① 首个 body 数据块到达时
 *   ② 流正常结束且无任何数据时
 *   ③ 流被取消 / 读取出错时
 * 而在「响应头到达但 body 未产出」的窗口内必须保持存活（排队行持续显示）。
 */
import { describe, expect, test } from 'bun:test'
import { attachQueueDisposeToBody } from '../../src/services/api/client'
import { gateStreamUntilFirstChunk } from '../../src/services/api/openai/index'

function counter() {
  let n = 0
  return { dispose: () => n++, count: () => n }
}

/** 造一个 body：调用 read() 后由 push() 手动投喂，模拟"头先回、body 后到" */
function controlledBody() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    body,
    push(data: string) {
      ctrl.enqueue(new TextEncoder().encode(data))
    },
    close() {
      ctrl.close()
    },
    error(e: unknown) {
      ctrl.error(e)
    },
  }
}

describe('attachQueueDisposeToBody (anthropic path)', () => {
  test('headers arrived but no body yet → gate stays alive (queue line persists)', async () => {
    const c = counter()
    const src = controlledBody()
    const res = new Response(src.body)
    attachQueueDisposeToBody(res, c.dispose)

    // 头已到、body 尚未产出：模拟排队窗口
    await new Promise(r => setTimeout(r, 30))
    expect(c.count()).toBe(0)

    // 首个数据块 = 开始产出 → dispose 且仅一次
    src.push('event: message_start\n\n')
    await new Promise(r => setTimeout(r, 30))
    expect(c.count()).toBe(1)
  })

  test('first chunk is forwarded intact to downstream consumer', async () => {
    const c = counter()
    const src = controlledBody()
    const res = new Response(src.body)
    attachQueueDisposeToBody(res, c.dispose)

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const pending = reader.read()
    src.push('hello')
    const { value } = await pending
    expect(new TextDecoder().decode(value)).toBe('hello')
    expect(c.count()).toBe(1)

    src.close()
    expect((await reader.read()).done).toBe(true)
    expect(c.count()).toBe(1) // 幂等：关闭不再重复 dispose
  })

  test('stream closed with zero data → dispose on close', async () => {
    const c = counter()
    const src = controlledBody()
    const res = new Response(src.body)
    attachQueueDisposeToBody(res, c.dispose)

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const pending = reader.read()
    src.close()
    expect((await pending).done).toBe(true)
    expect(c.count()).toBe(1)
  })

  test('body read error → dispose (never leaves gate polling)', async () => {
    const c = counter()
    const src = controlledBody()
    const res = new Response(src.body)
    attachQueueDisposeToBody(res, c.dispose)

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const pending = reader.read().catch(() => 'err')
    src.error(new Error('boom'))
    expect(await pending).toBe('err')
    expect(c.count()).toBe(1)
  })

  test('consumer cancels → dispose immediately', async () => {
    const c = counter()
    const src = controlledBody()
    const res = new Response(src.body)
    attachQueueDisposeToBody(res, c.dispose)

    await (res.body as ReadableStream<Uint8Array>).cancel('user aborted')
    expect(c.count()).toBe(1)
  })

  test('response without body → dispose immediately (no leak)', () => {
    const c = counter()
    const res = new Response(null)
    attachQueueDisposeToBody(res, c.dispose)
    expect(c.count()).toBe(1)
  })

  // 回归：非流式 JSON（sideQuery/classifier）绝不能被排队包装锁住 body。
  // 旧实现在 attach 时就 body.getReader()，导致 res.json() 抛
  // "Body already used"，classifier 表现为 unavailable。
  test('non-stream JSON body stays readable after attach (lazy reader)', async () => {
    const c = counter()
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
    attachQueueDisposeToBody(res, c.dispose)

    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
  })
})

describe('gateStreamUntilFirstChunk (openai path)', () => {
  function fakeStream(chunks: string[], mode: 'ok' | 'throw' = 'ok') {
    return {
      controller: { abort: () => {} },
      async *[Symbol.asyncIterator]() {
        for (const ch of chunks) {
          if (mode === 'throw') throw new Error('stream boom')
          yield ch
        }
      },
    }
  }

  test('not disposed before first chunk arrives (queue window keeps polling)', () => {
    const c = counter()
    gateStreamUntilFirstChunk(fakeStream(['a']), c.dispose)
    expect(c.count()).toBe(0)
  })

  test('disposed on first yielded chunk, not on creation', async () => {
    const c = counter()
    const wrapped = gateStreamUntilFirstChunk(fakeStream(['a', 'b']), c.dispose)
    const it = wrapped[Symbol.asyncIterator]()
    expect(c.count()).toBe(0)
    expect(await it.next()).toEqual({ done: false, value: 'a' })
    expect(c.count()).toBe(1)
    await it.next()
    expect(c.count()).toBe(1)
  })

  test('stream throws → dispose and error propagates', async () => {
    const c = counter()
    const wrapped = gateStreamUntilFirstChunk(
      fakeStream(['a'], 'throw'),
      c.dispose,
    )
    const it = wrapped[Symbol.asyncIterator]()
    await expect(it.next()).rejects.toThrow('stream boom')
    expect(c.count()).toBe(1)
  })

  test('early return (break) → dispose', async () => {
    const c = counter()
    const wrapped = gateStreamUntilFirstChunk(fakeStream(['a', 'b']), c.dispose)
    const it = wrapped[Symbol.asyncIterator]()
    await it.next()
    expect(c.count()).toBe(1)
    await it.return?.()
    expect(c.count()).toBe(1) // 幂等
  })

  test('non-iterator props pass through (SDK controller.abort intact)', () => {
    const c = counter()
    const src = fakeStream([])
    const wrapped = gateStreamUntilFirstChunk(src, c.dispose) as typeof src
    expect(typeof wrapped.controller.abort).toBe('function')
    wrapped.controller.abort()
    expect(c.count()).toBe(0)
  })
})
