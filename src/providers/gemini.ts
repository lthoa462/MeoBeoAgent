// Adapter cho Gemini API (models/{model}:streamGenerateContent?alt=sse).
// Khác biệt chính so với OpenAI:
//  - role của model là "model"; system prompt nằm ở systemInstruction
//  - tool call/result là các "part" functionCall / functionResponse
//  - functionCall có thể kèm thoughtSignature, phải gửi lại nguyên vẹn
//  - suy nghĩ: bật includeThoughts, các part có thought: true là bản tóm tắt tư duy

import { readSse } from '../core/sse.ts'
import {
  ProviderError,
  type FinishReason,
  type Message,
  type EmbeddingAdapter,
  type ModelAdapter,
  type ModelRequest,
  type StreamEvent,
  type ToolCallPart,
  type Usage,
} from '../core/types.ts'

export type GeminiOptions = {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
}

export function geminiAdapter(options: GeminiOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch

  return {
    name: 'gemini',
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify(buildBody(request)),
        signal: request.signal,
      })
      if (!response.ok) throw new ProviderError('gemini', response.status, await response.text())
      yield* translate(readSse(response))
    },
  }
}

// ---- neutral → wire -------------------------------------------------------

type WirePart = Record<string, unknown>
type WireContent = { role: 'user' | 'model'; parts: WirePart[] }

export function buildBody(request: ModelRequest) {
  // Id do Gemini cấp thì gửi lại; id do mình tự sinh thì không.
  const nativeIds = new Set<string>()
  const contents: WireContent[] = []
  const push = (role: WireContent['role'], parts: WirePart[]) => {
    const last = contents.at(-1)
    // Gộp các content liên tiếp cùng role để hội thoại luôn xen kẽ user/model.
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of request.messages) push(...toWireContent(message, nativeIds))

  const body: Record<string, unknown> = { contents }
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] }
  if (request.tools?.length) {
    body.tools = [{
      functionDeclarations: request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    }]
    body.toolConfig = { functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' } }
  }
  if (request.reasoning) {
    body.generationConfig = {
      thinkingConfig: {
        includeThoughts: true,
        // thinkingLevel dành cho Gemini 3 ("low" | "high"...); Gemini 2.5 tự quyết mức suy nghĩ.
        ...(request.reasoning.effort ? { thinkingLevel: request.reasoning.effort } : {}),
      },
    }
  }
  return body
}

function toWireContent(message: Message, nativeIds: Set<string>): [WireContent['role'], WirePart[]] {
  switch (message.role) {
    case 'user':
      return ['user', message.parts.map(part => ({ text: part.text }))]
    case 'assistant':
      // Không gửi lại bản tóm tắt suy nghĩ: Gemini tự nối mạch tư duy qua thoughtSignature.
      return ['model', message.parts.flatMap((part): WirePart[] => {
        if (part.type === 'reasoning') return []
        if (part.type === 'text') return [{ text: part.text }]
        const meta = part.providerMeta ?? {}
        if (meta.nativeId) nativeIds.add(part.id)
        return [{
          functionCall: { ...(meta.nativeId ? { id: part.id } : {}), name: part.name, args: part.args },
          ...(meta.thoughtSignature ? { thoughtSignature: meta.thoughtSignature } : {}),
        }]
      })]
    case 'tool':
      // Gemini: kết quả tool là part functionResponse trong một content role "user".
      return ['user', message.parts.map(part => ({
        functionResponse: {
          ...(nativeIds.has(part.callId) ? { id: part.callId } : {}),
          name: part.name,
          // response phải là object.
          response: part.isError ? { error: part.result } : { result: part.result },
        },
      }))]
  }
}

// ---- wire → neutral -------------------------------------------------------

type Chunk = {
  candidates?: {
    content?: { parts?: {
      text?: string
      thought?: boolean
      functionCall?: { id?: string; name: string; args?: unknown }
      thoughtSignature?: string
    }[] }
    finishReason?: string
  }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

export async function* translate(data: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  let finish: FinishReason = 'other'
  let usage: Usage | undefined
  let sawToolCall = false

  for await (const raw of data) {
    const chunk = JSON.parse(raw) as Chunk
    if (chunk.usageMetadata) {
      const meta = chunk.usageMetadata
      usage = {
        inputTokens: meta.promptTokenCount,
        outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        ...(meta.thoughtsTokenCount ? { reasoningTokens: meta.thoughtsTokenCount } : {}),
      }
    }
    const candidate = chunk.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought) {
        if (part.text) yield { type: 'reasoning-delta', text: part.text }
        continue
      }
      if (part.text) yield { type: 'text-delta', text: part.text }
      if (part.functionCall) {
        sawToolCall = true
        // Gemini trả nguyên một functionCall trong một chunk, không cần nối.
        const call: ToolCallPart = {
          type: 'tool-call',
          id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          providerMeta: {
            ...(part.functionCall.id ? { nativeId: true } : {}),
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          },
        }
        yield { type: 'tool-call', call }
      }
    }
    if (candidate?.finishReason) finish = mapFinish(candidate.finishReason)
  }

  yield { type: 'finish', reason: sawToolCall ? 'tool-calls' : finish, usage }
}

function mapFinish(reason: string): FinishReason {
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  return 'other'
}

// ---- Embeddings (models/{model}:batchEmbedContents) -------------------------

export function geminiEmbedding(options: GeminiOptions & { model: string }): EmbeddingAdapter {
  const baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const BATCH = 100

  return {
    provider: 'gemini',
    model: options.model,
    async embed(texts, purpose, signal) {
      const vectors: number[][] = []
      for (let i = 0; i < texts.length; i += BATCH) {
        const response = await doFetch(`${baseUrl}/models/${encodeURIComponent(options.model)}:batchEmbedContents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
          body: JSON.stringify({
            requests: texts.slice(i, i + BATCH).map(text => ({
              model: `models/${options.model}`,
              content: { parts: [{ text }] },
              taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            })),
          }),
          signal,
        })
        if (!response.ok) throw new ProviderError('gemini', response.status, await response.text())
        const json = await response.json() as { embeddings: { values: number[] }[] }
        vectors.push(...json.embeddings.map(item => item.values))
      }
      return vectors
    },
  }
}
