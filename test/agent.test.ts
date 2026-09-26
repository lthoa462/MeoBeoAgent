import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/core/agent.ts'
import { defineTool } from '../src/core/tool.ts'
import type { Message, ModelAdapter, ModelRequest, StreamEvent } from '../src/core/types.ts'
import { collect } from './helpers.ts'

/** Adapter giả: phát lần lượt các "kịch bản" đã định sẵn cho mỗi lần gọi model. */
function scriptedAdapter(script: StreamEvent[][]) {
  const requests: ModelRequest[] = []
  const adapter: ModelAdapter = {
    name: 'fake',
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      yield* script[requests.length - 1] ?? [{ type: 'finish', reason: 'stop' }]
    },
  }
  return { adapter, requests }
}

const add = defineTool<{ a: number; b: number }>({
  name: 'add',
  description: 'Cộng hai số',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  execute: ({ a, b }) => a + b,
})

describe('runAgent', () => {
  it('gọi tool, gửi kết quả lại cho model rồi kết thúc khi model trả lời', async () => {
    const { adapter, requests } = scriptedAdapter([
      [
        { type: 'text-delta', text: 'Để tôi tính.' },
        { type: 'tool-call', call: { type: 'tool-call', id: 'c1', name: 'add', args: { a: 2, b: 3 } } },
        { type: 'finish', reason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [
        { type: 'text-delta', text: 'Kết quả là 5.' },
        { type: 'finish', reason: 'stop', usage: { inputTokens: 20, outputTokens: 4 } },
      ],
    ])
    const history: Message[] = [{ role: 'user', parts: [{ type: 'text', text: '2 + 3?' }] }]

    const events = await collect(runAgent({ adapter, model: 'm', history, tools: [add] }))

    expect(events.find(e => e.type === 'tool-result')).toMatchObject({ result: { callId: 'c1', result: 5 } })
    expect(events.at(-1)).toEqual({
      type: 'done', text: 'Kết quả là 5.', reason: 'completed', usage: { inputTokens: 30, outputTokens: 9, reasoningTokens: 0 },
    })
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // Lần gọi thứ hai phải thấy kết quả tool trong history.
    expect(requests[1]!.messages[2]).toEqual({
      role: 'tool', parts: [{ type: 'tool-result', callId: 'c1', name: 'add', result: 5 }],
    })
  })

  it('trả lỗi về cho model thay vì làm sập vòng lặp', async () => {
    const { adapter } = scriptedAdapter([
      [
        { type: 'tool-call', call: { type: 'tool-call', id: 'c1', name: 'add', args: { a: 1 } } },
        { type: 'tool-call', call: { type: 'tool-call', id: 'c2', name: 'nope', args: {} } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: 'stop' }],
    ])
    const history: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]
    await collect(runAgent({ adapter, model: 'm', history, tools: [add] }))

    const toolMessage = history[2]!
    expect(toolMessage.role).toBe('tool')
    expect(toolMessage.parts).toMatchObject([
      { callId: 'c1', isError: true, result: 'Thiếu tham số bắt buộc: b' },
      { callId: 'c2', isError: true, result: 'Không có tool tên "nope"' },
    ])
  })

  it('bước cuối cấm gọi tool và dừng với reason max-steps nếu model vẫn gọi', async () => {
    const loop: StreamEvent[] = [
      { type: 'tool-call', call: { type: 'tool-call', id: 'c', name: 'add', args: { a: 1, b: 1 } } },
      { type: 'finish', reason: 'tool-calls' },
    ]
    const { adapter, requests } = scriptedAdapter([loop, loop, loop])
    const history: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]
    const events = await collect(runAgent({ adapter, model: 'm', history, tools: [add], maxSteps: 3 }))

    expect(requests.map(r => r.toolChoice)).toEqual(['auto', 'auto', 'none'])
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'max-steps' })
  })
})
