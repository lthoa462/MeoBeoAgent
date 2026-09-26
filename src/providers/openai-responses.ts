// Adapter cho OpenAI Responses API (POST /responses, stream SSE).
// Đây là API mới của OpenAI và là cách DUY NHẤT để thấy tiến trình suy nghĩ
// (reasoning summary) của các model reasoning của OpenAI.
//
// Khác Chat Completions:
//  - input là danh sách "item": message, function_call, function_call_output, reasoning
//  - stream là các event có tên: response.output_text.delta, response.reasoning_summary_text.delta...
//  - suy nghĩ đầy đủ được MÃ HOÁ (encrypted_content); ta chỉ đọc được bản tóm tắt,
//    nhưng phải gửi lại item mã hoá ở lượt sau để model giữ mạch suy nghĩ khi gọi tool.

import { readSse } from '../core/sse.ts'
import {
  ProviderError,
  type FinishReason,
  type Message,
  type ModelAdapter,
  type ModelRequest,
  type StreamEvent,
  type Usage,
} from '../core/types.ts'
import type { OpenAiOptions } from './openai.ts'

export function openAiResponsesAdapter(options: OpenAiOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch

  return {
    name: 'openai',
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      const response = await doFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
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
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.messages.flatMap(toInputItems),
    stream: true,
    // Không lưu hội thoại trên server OpenAI; mình tự giữ history.
    store: false,
  }
  if (request.system) body.instructions = request.system
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }))
    body.tool_choice = request.toolChoice ?? 'auto'
  }
  if (request.reasoning) {
    body.reasoning = {
      ...(request.reasoning.effort ? { effort: request.reasoning.effort } : {}),
      summary: 'auto', // yêu cầu bản tóm tắt suy nghĩ để hiển thị
    }
    // Vì store: false, phải xin suy nghĩ dạng mã hoá để tự gửi lại ở lượt sau.
    body.include = ['reasoning.encrypted_content']
  }
  return body
}

function toInputItems(message: Message): unknown[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.parts.map(part => part.text).join('') }]
    case 'assistant':
      return message.parts.flatMap(part => {
        if (part.type === 'reasoning') {
          // Chỉ gửi lại item suy nghĩ do chính OpenAI tạo ra (có dữ liệu mã hoá).
          return part.providerMeta?.openaiItem ? [part.providerMeta.openaiItem] : []
        }
        if (part.type === 'text') return [{ role: 'assistant', content: part.text }]
        return [{
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: typeof part.args === 'string' ? part.args : JSON.stringify(part.args),
        }]
      })
    case 'tool':
      return message.parts.map(part => ({
        type: 'function_call_output',
        call_id: part.callId,
        output: JSON.stringify(part.isError ? { error: part.result } : part.result),
      }))
  }
}

// ---- wire → neutral -------------------------------------------------------

type OutputItem =
  | { type: 'reasoning'; id?: string; summary?: { text: string }[]; encrypted_content?: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'message' }

type Event =
  | { type: 'response.reasoning_summary_part.added'; summary_index: number }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.output_item.done'; item: OutputItem }
  | { type: 'response.completed' | 'response.incomplete'; response: ResponseObject }
  | { type: 'response.failed'; response: ResponseObject }
  | { type: 'error'; message?: string; code?: string }
  | { type: string }

type ResponseObject = {
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }
}

export async function* translate(data: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  let finish: FinishReason = 'other'
  let usage: Usage | undefined
  let sawToolCall = false

  for await (const raw of data) {
    if (raw === '[DONE]') break
    const event = JSON.parse(raw) as Event
    switch (event.type) {
      case 'response.reasoning_summary_part.added':
        // Bản tóm tắt có thể gồm nhiều đoạn; cách dòng giữa các đoạn.
        if ((event as { summary_index: number }).summary_index > 0) yield { type: 'reasoning-delta', text: '\n\n' }
        break
      case 'response.reasoning_summary_text.delta':
        yield { type: 'reasoning-delta', text: (event as { delta: string }).delta }
        break
      case 'response.output_text.delta':
        yield { type: 'text-delta', text: (event as { delta: string }).delta }
        break
      case 'response.output_item.done': {
        const item = (event as { item: OutputItem }).item
        if (item.type === 'reasoning') {
          yield { type: 'reasoning-end', providerMeta: { openaiItem: item } }
        } else if (item.type === 'function_call') {
          sawToolCall = true
          yield {
            type: 'tool-call',
            call: { type: 'tool-call', id: item.call_id, name: item.name, args: parseArgs(item.arguments) },
          }
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = (event as { response: ResponseObject }).response
        finish = response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop'
        const u = response.usage
        if (u) {
          const reasoningTokens = u.output_tokens_details?.reasoning_tokens
          usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, ...(reasoningTokens ? { reasoningTokens } : {}) }
        }
        break
      }
      case 'response.failed':
        throw new ProviderError('openai', 200, (event as { response: ResponseObject }).response.error?.message ?? 'response.failed')
      case 'error':
        throw new ProviderError('openai', 200, (event as { message?: string }).message ?? raw)
    }
  }

  yield { type: 'finish', reason: sawToolCall ? 'tool-calls' : finish, usage }
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
