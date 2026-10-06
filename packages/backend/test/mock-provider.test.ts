import { afterEach, describe, expect, it } from 'vitest'
import { defineTool, type GenerateOptions, type JsonValue } from '@alvin0/ai-agent-sdk-core'
import { readConfig } from '../src/config.ts'
import { LlmConfigError, createLlmRuntime, describeLlmConfig, type LlmRuntime } from '../src/llm/runtime.ts'
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from '../src/llm/mock-provider.ts'

const runtimes: LlmRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
})

async function mockRuntime(onRequest?: (request: GenerateOptions) => void): Promise<LlmRuntime> {
  const llm = await createLlmRuntime(readConfig({ LLM_PROVIDER: 'mock' }), onRequest === undefined ? {} : { mock: { onRequest } })
  runtimes.push(llm)
  return llm
}

/** Stand-ins for the coordinator toolkit, so the mock's script is tested on its own. */
function stubTools(calls: string[], loadResult: JsonValue) {
  const record = (name: string, value: JsonValue) => defineTool<Record<string, unknown>>({
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    isConcurrencySafe: () => true,
    execute: async args => {
      calls.push(`${name} ${JSON.stringify(args)}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      return value
    },
  })
  return [
    record('load_messages', loadResult),
    record('summarize_messages', 'Tóm tắt giả (#3).'),
    record('extract_action_items', '- Huy sửa lỗi (#7).'),
    record('answer_question', 'Có, đã chốt (#9).'),
  ]
}

const SYSTEM_TIME = '- Current time: 2026-10-06T11:00:00+07:00 (Thứ Ba, 06/10/2026 11:00)'
const STATS = { transcriptId: 't_abc', messageCount: 12, since: '2026-09-29T11:00:00+07:00', until: '2026-10-06T11:00:00+07:00', clamped: false, notes: [] }

describe('describeLlmConfig', () => {
  it('needs nothing for the mock provider', () => {
    expect(describeLlmConfig(readConfig({ LLM_PROVIDER: 'mock' }))).toEqual({ provider: 'mock', model: MOCK_MODEL_ID, configured: true })
  })

  it('names the missing variables in Vietnamese', () => {
    const openai = describeLlmConfig(readConfig({ LLM_PROVIDER: 'openai' }))
    expect(openai.configured).toBe(false)
    expect(openai.problem).toContain('OPENAI_API_KEY')
    expect(openai.problem).toContain('OPENAI_MODEL')
    const gemini = describeLlmConfig(readConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }))
    expect(gemini.problem).toContain('GEMINI_MODEL')
    expect(gemini.problem).not.toContain('GEMINI_API_KEY')
    expect(describeLlmConfig(readConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x' })).configured).toBe(true)
  })

  it('refuses to build a runtime without a key', async () => {
    await expect(createLlmRuntime(readConfig({ LLM_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-x' }))).rejects.toBeInstanceOf(LlmConfigError)
  })
})

describe('real providers (fake fetch, no network)', () => {
  function recordingFetch(status: number, calls: { url: string; body: string }[]): typeof fetch {
    return async (input, init) => {
      calls.push({ url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  it('wires OpenAI with the configured model and does not retry a rejected key', async () => {
    const calls: { url: string; body: string }[] = []
    const llm = await createLlmRuntime(
      readConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-test', OPENAI_REASONING_EFFORT: 'low' }),
      { fetch: recordingFetch(401, calls), retry: { initialDelayMs: 1 } },
    )
    runtimes.push(llm)
    expect(llm).toMatchObject({ provider: 'openai', model: 'gpt-test', workerModel: 'gpt-test', effort: 'low' })
    const agent = llm.runtime.agent({ id: 'probe', model: { provider: 'openai', id: 'gpt-test' }, instructions: 'probe', effort: 'low' })
    await expect(agent.generate('hi')).rejects.toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toContain('gpt-test')
  })

  it('retries throttled Gemini calls before giving up', async () => {
    const calls: { url: string; body: string }[] = []
    const llm = await createLlmRuntime(
      readConfig({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-test', OPENAI_REASONING_EFFORT: 'high' }),
      { fetch: recordingFetch(429, calls), retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 } },
    )
    runtimes.push(llm)
    expect(llm.effort).toBeUndefined()
    const agent = llm.runtime.agent({ id: 'probe', model: { provider: 'gemini', id: 'gemini-test' }, instructions: 'probe' })
    await expect(agent.generate('hi')).rejects.toBeDefined()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.body).toContain('gemini-test')
  })
})

describe('mock provider', () => {
  it('runs the coordinator script: load → two specialists in one step → final answer', async () => {
    const requests: GenerateOptions[] = []
    const llm = await mockRuntime(request => requests.push(request))
    const calls: string[] = []
    const coordinator = llm.runtime.agent({
      id: 'coordinator',
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
      instructions: 'test',
      tools: stubTools(calls, STATS),
    })
    const response = await coordinator.generate('Tóm tắt 7 ngày qua', { additionalInstructions: SYSTEM_TIME })

    expect(response.completed).toBe(true)
    expect(calls[0]).toBe(`load_messages ${JSON.stringify({ since: '2026-09-29T04:00:00.000Z' })}`)
    expect(calls.slice(1).sort()).toEqual([
      'extract_action_items {"transcriptId":"t_abc"}',
      'summarize_messages {"transcriptId":"t_abc"}',
    ])
    // The two specialists were requested by ONE assistant message.
    const step = requests[2]?.messages.at(-3)
    expect(step?.content.filter(block => block.type === 'tool-call')).toHaveLength(2)
    expect(requests).toHaveLength(3)
    expect(response.text).toContain('12 tin nhắn')
    expect(response.text).toContain('Tóm tắt giả (#3).')
    expect(response.text).toContain('- Huy sửa lỗi (#7).')
  })

  it('asks the QA specialist for a question and answers directly when there are no messages', async () => {
    const llm = await mockRuntime()
    const calls: string[] = []
    const coordinator = (stats: JsonValue) => llm.runtime.agent({
      id: 'coordinator',
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
      instructions: 'test',
      tools: stubTools(calls, stats),
    })
    const answer = await coordinator(STATS).generate('Hôm qua đã chốt ngày release chưa?', { additionalInstructions: SYSTEM_TIME })
    expect(calls[0]).toBe(`load_messages ${JSON.stringify({ since: '2026-10-05T00:00:00+07:00', until: '2026-10-06T00:00:00+07:00' })}`)
    expect(calls[1]).toContain('answer_question')
    expect(answer.text).toContain('Có, đã chốt (#9).')

    calls.length = 0
    const empty = await coordinator({ ...STATS, messageCount: 0 }).generate('Có gì mới không', { additionalInstructions: SYSTEM_TIME })
    expect(calls).toEqual(['load_messages {}'])
    expect(empty.text).toContain('Không có tin nhắn')
  })

  it('digests transcripts and notes without repeating whole messages', async () => {
    const llm = await mockRuntime()
    const worker = llm.runtime.agent({ id: 'worker', model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID }, instructions: 'test' })
    const transcript = [
      '[#1 05/10 09:00] Lan: Em sẽ gửi bản thiết kế dark mode cuối cùng trước thứ Sáu nhé',
      '  ↳ [#2 05/10 09:05] Huy: Ok',
      '[#3 05/10 10:00] Lan: Đã gửi',
    ].join('\n')
    const digest = await worker.generate(`Nhiệm vụ: tóm tắt\n\n<transcript>\n${transcript}\n</transcript>`)
    expect(digest.text).toContain('3 tin nhắn #1–#3 của 2 người: Lan (2), Huy (1)')
    expect(digest.text).toContain('(#1): "Em sẽ gửi bản thiết…"')
    expect(digest.text).not.toContain('dark mode cuối cùng trước thứ Sáu')

    const merged = await worker.generate('Nhiệm vụ: x\n\n<notes>\n### Phần 1\n- Lan (#1): gửi thiết kế\n- Huy (#2): ok\n</notes>')
    expect(merged.text).toContain('Gộp 2 ghi chú, trích dẫn: #1, #2')
  })
})
