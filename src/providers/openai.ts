// Adapter cho OpenAI Chat Completions API (POST /chat/completions, stream SSE).
// Chat Completions cũng được nhiều gateway khác hỗ trợ (OpenRouter, Groq,
// Ollama, LM Studio...), chỉ cần đổi baseUrl.

import { readSse } from '../core/sse.ts'
import {
  ProviderError,
  type FinishReason,
  type Message,
  type EmbeddingAdapter,
  type ModelAdapter,
  type ModelRequest,
  type StreamEvent,
} from '../core/types.ts'

export type OpenAiOptions = {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
}

export function openAiAdapter(options: OpenAiOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch

  return {
    name: 'openai',
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(buildBody(request)),
        signal: request.signal,
      })
      if (!response.ok) throw new ProviderError('openai', response.status, await response.text())
      yield* translate(readSse(response))
    },
  }
}

// ---- neutral → wire -------------------------------------------------------

export function buildBody(request: ModelRequest) {
  const messages: unknown[] = []
  if (request.system) messages.push({ role: 'system', content: request.system })
  for (const message of request.messages) messages.push(...toWireMessages(message))

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = request.toolChoice ?? 'auto'
  }
  return body
}

function toWireMessages(message: Message): unknown[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.parts.map(part => part.text).join('') }]
    case 'assistant': {
      const text = message.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
      const toolCalls = message.parts.flatMap(part =>
        part.type === 'tool-call'
          ? [{
              id: part.id,
              type: 'function',
              function: {
                name: part.name,
                arguments: typeof part.args === 'string' ? part.args : JSON.stringify(part.args),
              },
            }]
          : [],
      )
      return [{
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      }]
    }
    case 'tool':
      // OpenAI: mỗi kết quả tool là một message role "tool" riêng.
      return message.parts.map(part => ({
        role: 'tool',
        tool_call_id: part.callId,
        content: JSON.stringify(part.isError ? { error: part.result } : part.result),
      }))
  }
}

// ---- wire → neutral -------------------------------------------------------

type ChunkToolCall = { index: number; id?: string; function?: { name?: string; arguments?: string } }
type Chunk = {
  choices?: { delta?: { content?: string | null; tool_calls?: ChunkToolCall[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export async function* translate(data: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  // Tham số của tool call đến từng mẩu JSON, phải nối lại theo `index`.
  const pending = new Map<number, { id: string; name: string; args: string }>()
  let finish: FinishReason = 'other'
  let usage: { inputTokens?: number; outputTokens?: number } | undefined

  for await (const raw of data) {
    if (raw === '[DONE]') break
    const chunk = JSON.parse(raw) as Chunk
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue

    if (choice.delta?.content) yield { type: 'text-delta', text: choice.delta.content }
    for (const delta of choice.delta?.tool_calls ?? []) {
      const entry = pending.get(delta.index) ?? { id: '', name: '', args: '' }
      if (delta.id) entry.id = delta.id
      if (delta.function?.name) entry.name += delta.function.name
      if (delta.function?.arguments) entry.args += delta.function.arguments
      pending.set(delta.index, entry)
    }
    if (choice.finish_reason) finish = mapFinish(choice.finish_reason)
  }

  for (const [, entry] of [...pending].sort(([a], [b]) => a - b)) {
    yield { type: 'tool-call', call: { type: 'tool-call', id: entry.id, name: entry.name, args: parseArgs(entry.args) } }
  }
  yield { type: 'finish', reason: finish, usage }
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function mapFinish(reason: string): FinishReason {
  if (reason === 'stop') return 'stop'
  if (reason === 'tool_calls') return 'tool-calls'
  if (reason === 'length') return 'length'
  return 'other'
}

// ---- Embeddings (POST /embeddings) ------------------------------------------

export function openAiEmbedding(options: OpenAiOptions & { model: string }): EmbeddingAdapter {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const BATCH = 100

  return {
    provider: 'openai',
    model: options.model,
    async embed(texts, _purpose, signal) {
      const vectors: number[][] = []
      for (let i = 0; i < texts.length; i += BATCH) {
        const response = await doFetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, input: texts.slice(i, i + BATCH) }),
          signal,
        })
        if (!response.ok) throw new ProviderError('openai', response.status, await response.text())
        const json = await response.json() as { data: { index: number; embedding: number[] }[] }
        // Sắp theo index cho chắc thứ tự khớp với input.
        vectors.push(...json.data.sort((a, b) => a.index - b.index).map(item => item.embedding))
      }
      return vectors
    },
  }
}
