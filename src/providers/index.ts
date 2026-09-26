import type { ModelAdapter } from '../core/types.ts'
import { geminiAdapter } from './gemini.ts'
import { openAiAdapter } from './openai.ts'

export type ProviderName = 'openai' | 'gemini'

export type ProviderConfig = { adapter: ModelAdapter; model: string }

/** Tạo adapter + model từ biến môi trường (.env). */
export function providerFromEnv(name: ProviderName, env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  if (name === 'openai') {
    return {
      adapter: openAiAdapter({ apiKey: required(env, 'OPENAI_API_KEY'), baseUrl: env.OPENAI_BASE_URL || undefined }),
      model: required(env, 'OPENAI_MODEL'),
    }
  }
  return {
    adapter: geminiAdapter({ apiKey: required(env, 'GEMINI_API_KEY'), baseUrl: env.GEMINI_BASE_URL || undefined }),
    model: required(env, 'GEMINI_MODEL'),
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Thiếu biến môi trường ${key} (xem .env.example)`)
  return value
}
