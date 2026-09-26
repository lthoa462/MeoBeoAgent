import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/core/agent.ts'
import { defineTool } from '../src/core/tool.ts'
import type { Message } from '../src/core/types.ts'
import { geminiAdapter } from '../src/providers/gemini.ts'
import { openAiAdapter } from '../src/providers/openai.ts'
import { collect, fakeFetch } from './helpers.ts'

const square = defineTool<{ x: number }>({
  name: 'square',
  description: 'Bình phương',
  parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  execute: ({ x }) => x * x,
})

const question = (): Message[] => [{ role: 'user', parts: [{ type: 'text', text: '7 bình phương?' }] }]

describe('OpenAI adapter', () => {
  it('nối tham số tool call bị chia nhỏ và gửi kết quả đúng định dạng', async () => {
    const { fetch, requests } = fakeFetch([
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'square', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x"' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':7}' } }] }, finish_reason: 'tool_calls' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }),
        '[DONE]',
      ],
      [
        JSON.stringify({ choices: [{ delta: { content: '7² = ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '49' }, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 70, completion_tokens: 5 } }),
        '[DONE]',
      ],
    ])
    const adapter = openAiAdapter({ apiKey: 'sk-test', fetch })
    const history = question()

    const events = await collect(runAgent({ adapter, model: 'gpt-test', system: 'Bạn là MeoBeo', history, tools: [square] }))

    expect(events.at(-1)).toEqual({ type: 'done', text: '7² = 49', reason: 'completed', usage: { inputTokens: 120, outputTokens: 15, reasoningTokens: 0 } })
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-test')
    expect(requests[0]!.body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      tool_choice: 'auto',
      messages: [{ role: 'system', content: 'Bạn là MeoBeo' }, { role: 'user', content: '7 bình phương?' }],
      tools: [{ type: 'function', function: { name: 'square' } }],
    })
    expect(requests[1]!.body.messages.slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'square', arguments: '{"x":7}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '49' },
    ])
  })

  it('báo lỗi HTTP kèm nội dung', async () => {
    const fetch = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof globalThis.fetch
    const adapter = openAiAdapter({ apiKey: 'x', fetch })
    await expect(collect(adapter.stream({ model: 'm', messages: question() }))).rejects.toThrow(/HTTP 401.*bad key/)
  })
})

describe('Gemini adapter', () => {
  it('gửi lại functionCall kèm thoughtSignature và trả functionResponse', async () => {
    const { fetch, requests } = fakeFetch([
      [
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'square', args: { x: 7 } }, thoughtSignature: 'sig-abc' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, thoughtsTokenCount: 12 },
        }),
      ],
      [
        JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '7² = ' }] } }] }),
        JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '49' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 4 } }),
      ],
    ])
    const adapter = geminiAdapter({ apiKey: 'g-test', fetch })
    const history = question()

    const events = await collect(runAgent({ adapter, model: 'gemini-test', system: 'Bạn là MeoBeo', history, tools: [square] }))

    expect(events.at(-1)).toEqual({ type: 'done', text: '7² = 49', reason: 'completed', usage: { inputTokens: 100, outputTokens: 24, reasoningTokens: 12 } })
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse')
    expect(requests[0]!.headers['x-goog-api-key']).toBe('g-test')
    expect(requests[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Bạn là MeoBeo' }] },
      contents: [{ role: 'user', parts: [{ text: '7 bình phương?' }] }],
      tools: [{ functionDeclarations: [{ name: 'square', parametersJsonSchema: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    })
    expect(requests[1]!.body.contents.slice(1)).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'square', args: { x: 7 } }, thoughtSignature: 'sig-abc' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'square', response: { result: 49 } } }] },
    ])
  })

  it('gửi lại id của functionCall khi Gemini có cấp id', async () => {
    const { fetch, requests } = fakeFetch([
      [JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'fc-9', name: 'square', args: { x: 2 } } }] } }] })],
      [JSON.stringify({ candidates: [{ content: { parts: [{ text: '4' }] }, finishReason: 'STOP' }] })],
    ])
    await collect(runAgent({ adapter: geminiAdapter({ apiKey: 'k', fetch }), model: 'g', history: question(), tools: [square] }))

    expect(requests[1]!.body.contents.slice(1)).toEqual([
      { role: 'model', parts: [{ functionCall: { id: 'fc-9', name: 'square', args: { x: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'fc-9', name: 'square', response: { result: 4 } } }] },
    ])
  })
})
