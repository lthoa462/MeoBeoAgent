import type { EmbeddingAdapter, ModelAdapter } from '../core/types.ts'
import { geminiAdapter, geminiEmbedding } from './gemini.ts'
import { openAiAdapter, openAiEmbedding } from './openai.ts'
import { openAiResponsesAdapter } from './openai-responses.ts'

export type ProviderName = 'openai' | 'gemini'

export type ProviderConfig = {
  adapter: ModelAdapter
  model: string
  /** Mức suy nghĩ mặc định lấy từ .env (bỏ trống = để model tự quyết). */
  reasoningEffort?: string
  /** Mô tả ngắn để hiện trong CLI, vd. "openai · Responses API". */
  label: string
}

/** Tạo adapter + model từ biến môi trường (.env). */
export function providerFromEnv(name: ProviderName, env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  if (name === 'openai') {
    const options = { apiKey: required(env, 'OPENAI_API_KEY'), baseUrl: env.OPENAI_BASE_URL || undefined }
    // Mặc định dùng Responses API (thấy được suy nghĩ). "chat" cho các gateway chỉ hỗ trợ Chat Completions.
    const chat = env.OPENAI_API_STYLE === 'chat'
    return {
      adapter: chat ? openAiAdapter(options) : openAiResponsesAdapter(options),
      model: required(env, 'OPENAI_MODEL'),
      reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined,
      label: `openai · ${chat ? 'Chat Completions' : 'Responses API'}`,
    }
  }
  return {
    adapter: geminiAdapter({ apiKey: required(env, 'GEMINI_API_KEY'), baseUrl: env.GEMINI_BASE_URL || undefined }),
    model: required(env, 'GEMINI_MODEL'),
    reasoningEffort: env.GEMINI_THINKING_LEVEL || undefined,
    label: 'gemini',
  }
}

/** Model embedding cho RAG. Mỗi provider có kho (index) riêng vì vector của hai bên không so sánh được với nhau. */
export function embedderFromEnv(name: ProviderName, env: NodeJS.ProcessEnv = process.env): EmbeddingAdapter {
  if (name === 'openai') {
    return openAiEmbedding({
      apiKey: required(env, 'OPENAI_API_KEY'),
      baseUrl: env.OPENAI_BASE_URL || undefined,
      model: env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    })
  }
  return geminiEmbedding({
    apiKey: required(env, 'GEMINI_API_KEY'),
    baseUrl: env.GEMINI_BASE_URL || undefined,
    model: env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
  })
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Thiếu biến môi trường ${key} (xem .env.example)`)
  return value
}
