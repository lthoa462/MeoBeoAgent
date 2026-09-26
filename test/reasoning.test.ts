import { describe, expect, it } from 'vitest'
import { runAgent, type AgentEvent } from '../src/core/agent.ts'
import { defineTool } from '../src/core/tool.ts'
import type { Message, ModelAdapter, StreamEvent } from '../src/core/types.ts'
import { geminiAdapter } from '../src/providers/gemini.ts'
import { openAiAdapter } from '../src/providers/openai.ts'
import { openAiResponsesAdapter } from '../src/providers/openai-responses.ts'
import { TurnRenderer } from '../src/render.ts'
import { collect, fakeFetch } from './helpers.ts'

const square = defineTool<{ x: number }>({
  name: 'square',
  description: 'Bình phương',
  parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  execute: ({ x }) => x * x,
})

const question = (): Message[] => [{ role: 'user', parts: [{ type: 'text', text: '7 bình phương?' }] }]
const ev = (type: string, rest: Record<string, unknown> = {}) => JSON.stringify({ type, ...rest })

describe('OpenAI Responses API', () => {
  const reasoningItem = {
    type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC',
    summary: [{ type: 'summary_text', text: 'Cần tính 7². Dùng tool.' }],
  }

  it('stream tóm tắt suy nghĩ, gọi tool và gửi lại item suy nghĩ đã mã hoá', async () => {
    const { fetch, requests } = fakeFetch([
      [
        ev('response.reasoning_summary_part.added', { summary_index: 0 }),
        ev('response.reasoning_summary_text.delta', { delta: 'Cần tính 7². ' }),
        ev('response.reasoning_summary_part.added', { summary_index: 1 }),
        ev('response.reasoning_summary_text.delta', { delta: 'Dùng tool.' }),
        ev('response.output_item.done', { item: reasoningItem }),
        ev('response.output_text.delta', { delta: 'Mình tính nhé.' }),
        ev('response.output_item.done', { item: { type: 'message' } }),
        ev('response.output_item.done', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'square', arguments: '{"x":7}' } }),
        ev('response.completed', { response: { usage: { input_tokens: 50, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } } } }),
      ],
      [
        ev('response.output_text.delta', { delta: '7² = 49' }),
        ev('response.completed', { response: { usage: { input_tokens: 90, output_tokens: 5 } } }),
      ],
    ])
    const adapter = openAiResponsesAdapter({ apiKey: 'sk', fetch })
    const history = question()
    const events = await collect(runAgent({
      adapter, model: 'o-test', system: 'Bạn là MeoBeo', history, tools: [square], reasoning: { effort: 'low' },
    }))

    expect(events.filter(e => e.type === 'reasoning-delta').map(e => (e as { text: string }).text).join(''))
      .toBe('Cần tính 7². \n\nDùng tool.')
    expect(events.at(-1)).toEqual({
      type: 'done', text: '7² = 49', reason: 'completed', usage: { inputTokens: 140, outputTokens: 35, reasoningTokens: 20 },
    })

    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(requests[0]!.body).toMatchObject({
      model: 'o-test',
      instructions: 'Bạn là MeoBeo',
      input: [{ role: 'user', content: '7 bình phương?' }],
      store: false,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'square' }],
    })
    // Lượt 2: gửi lại đúng thứ tự: suy nghĩ (mã hoá) → lời dẫn → function_call → kết quả.
    expect(requests[1]!.body.input).toEqual([
      { role: 'user', content: '7 bình phương?' },
      reasoningItem,
      { role: 'assistant', content: 'Mình tính nhé.' },
      { type: 'function_call', call_id: 'call_1', name: 'square', arguments: '{"x":7}' },
      { type: 'function_call_output', call_id: 'call_1', output: '49' },
    ])
  })

  it('không gửi tham số reasoning khi tắt suy nghĩ', async () => {
    const { fetch, requests } = fakeFetch([[ev('response.output_text.delta', { delta: 'hi' }), ev('response.completed', { response: {} })]])
    await collect(runAgent({ adapter: openAiResponsesAdapter({ apiKey: 'k', fetch }), model: 'm', history: question(), tools: [] }))
    expect(requests[0]!.body.reasoning).toBeUndefined()
    expect(requests[0]!.body.include).toBeUndefined()
  })

  it('báo lỗi khi stream trả event error', async () => {
    const { fetch } = fakeFetch([[ev('error', { message: 'Unsupported parameter: reasoning.effort' })]])
    const adapter = openAiResponsesAdapter({ apiKey: 'k', fetch })
    await expect(collect(adapter.stream({ model: 'm', messages: question() }))).rejects.toThrow(/reasoning\.effort/)
  })
})

describe('Chat Completions (gateway)', () => {
  it('đọc reasoning_content, gửi reasoning_effort và không gửi lại suy nghĩ', async () => {
    const { fetch, requests } = fakeFetch([
      [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'Nghĩ ' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'một chút.' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Xong' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ],
      [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'],
    ])
    const adapter = openAiAdapter({ apiKey: 'k', fetch })
    const history = question()
    const events = await collect(runAgent({ adapter, model: 'm', history, tools: [], reasoning: { effort: 'high' } }))

    expect(events.map(e => e.type)).toEqual(['step-start', 'reasoning-delta', 'reasoning-delta', 'reasoning-end', 'text-delta', 'step-end', 'done'])
    expect(requests[0]!.body.reasoning_effort).toBe('high')
    expect(history[1]).toEqual({ role: 'assistant', parts: [{ type: 'reasoning', text: 'Nghĩ một chút.' }, { type: 'text', text: 'Xong' }] })

    history.push({ role: 'user', parts: [{ type: 'text', text: 'tiếp' }] })
    await collect(runAgent({ adapter, model: 'm', history, tools: [] }))
    expect(requests[1]!.body.messages[1]).toEqual({ role: 'assistant', content: 'Xong' })
  })
})

describe('Gemini thinking', () => {
  it('bật includeThoughts, hiện part thought và không gửi lại bản tóm tắt', async () => {
    const { fetch, requests } = fakeFetch([
      [
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Cần bình phương 7.', thought: true }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'square', args: { x: 7 } }, thoughtSignature: 'SIG' }] } }] }),
      ],
      [JSON.stringify({ candidates: [{ content: { parts: [{ text: '49' }] }, finishReason: 'STOP' }] })],
    ])
    const history = question()
    const events = await collect(runAgent({
      adapter: geminiAdapter({ apiKey: 'k', fetch }), model: 'g', history, tools: [square], reasoning: { effort: 'high' },
    }))

    expect(events.filter(e => e.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', text: 'Cần bình phương 7.' }])
    expect(requests[0]!.body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } })
    expect(requests[1]!.body.contents[1]).toEqual({
      role: 'model', parts: [{ functionCall: { name: 'square', args: { x: 7 } }, thoughtSignature: 'SIG' }],
    })
  })
})

describe('TurnRenderer', () => {
  const events: AgentEvent[] = [
    { type: 'step-start', step: 1 },
    { type: 'reasoning-delta', text: 'Dòng 1\nDòng 2' },
    { type: 'reasoning-end' },
    { type: 'tool-call', call: { type: 'tool-call', id: 'c', name: 'square', args: { x: 7 } } },
    { type: 'tool-result', result: { type: 'tool-result', callId: 'c', name: 'square', result: 49 } },
    { type: 'step-start', step: 2 },
    { type: 'text-delta', text: '49' },
    { type: 'done', text: '49', reason: 'completed', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 } },
  ]
  const render = (showThinking: boolean) => {
    let out = ''
    const renderer = new TurnRenderer({ label: 'test', showThinking, write: t => (out += t) })
    events.forEach(e => renderer.handle(e))
    return out.replace(/\x1b\[[\d;]*m/g, '')
  }

  it('vẽ dòng thời gian: suy nghĩ → tool → bước 2 → trả lời', () => {
    const out = render(true)
    expect(out).toMatch(/💭 Suy nghĩ\n│ Dòng 1\n│ Dòng 2\n└ \d+\.\d giây\n⚙ square\(\{"x":7\}\)\n✓ 49\n── Bước 2 ──\n🐱 49/)
    expect(out).toContain('vào 1 / ra 2, suy nghĩ 3 tokens')
  })

  it('chế độ ẩn: chỉ báo đang suy nghĩ, không in nội dung', () => {
    const out = render(false)
    expect(out).toContain('💭 Suy nghĩ …')
    expect(out).not.toContain('Dòng 1')
  })
})

describe('runAgent + reasoning', () => {
  it('chốt khối suy nghĩ ở cuối stream khi provider không báo reasoning-end', async () => {
    const script: StreamEvent[] = [
      { type: 'reasoning-delta', text: 'a' },
      { type: 'reasoning-delta', text: 'b' },
      { type: 'finish', reason: 'stop' },
    ]
    const adapter: ModelAdapter = { name: 'x', async *stream() { yield* script } }
    const history = question()
    const events = await collect(runAgent({ adapter, model: 'm', history, tools: [] }))
    expect(events.map(e => e.type)).toContain('reasoning-end')
    expect(history[1]).toEqual({ role: 'assistant', parts: [{ type: 'reasoning', text: 'ab' }] })
  })
})
