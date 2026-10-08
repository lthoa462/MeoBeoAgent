/**
 * Provider wiring. One AgentRuntime per process (via services.ts), with the
 * provider chosen by LLM_PROVIDER:
 * - openai: openAiPlugin({ apiKey, defaultModel, baseUrl? }) — ALWAYS pass
 *   defaultModel (a bare envCredential without it fails at startup).
 * - gemini: geminiPlugin({ apiKey, defaultModel, baseUrl? }); no effort.
 * - mock:   the offline scripted provider from mock-provider.ts.
 * Agents always set model { provider, id } explicitly, so the SDK never falls
 * back to its Codex default. Provider timeouts like the edge sample
 * (requestTimeoutMs 120s, streamIdleTimeoutMs 45s).
 *
 * Real providers are wrapped in withRetry: a map step fans out several model
 * calls at once, and a single 429 or 5xx should cost a short wait, not the
 * whole summary. Retry only happens before the first chunk is delivered.
 */

import { ReasoningEffortId, createAgentRuntime, withRetry } from '@alvin0/ai-agent-sdk-core'
import type { AgentRuntime, ModelProviderRegistrar } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin, type ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { geminiPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import type { AppConfig } from '../config.ts'
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID, mockProviderPlugin, type MockProviderOptions } from './mock-provider.ts'

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmConfigError'
  }
}

export interface LlmRuntime {
  readonly runtime: AgentRuntime
  /** Route name registered in the runtime ('openai' | 'gemini' | 'mock'). */
  readonly provider: string
  readonly model: string
  readonly workerModel: string
  readonly effort: string | undefined
  close(): Promise<void>
}

export interface LlmConfigStatus {
  readonly provider: string
  readonly model: string | undefined
  readonly configured: boolean
  /** Vietnamese explanation of what is missing, when not configured. */
  readonly problem?: string
}

/** Check keys/models without creating anything. */
export function describeLlmConfig(config: AppConfig): LlmConfigStatus {
  const { llm } = config
  if (llm.provider === 'mock') return { provider: MOCK_PROVIDER_ID, model: llm.model ?? MOCK_MODEL_ID, configured: true }
  const settings = llm.provider === 'openai' ? llm.openai : llm.gemini
  const prefix = llm.provider === 'openai' ? 'OPENAI' : 'GEMINI'
  const missing = [
    ...(settings.apiKey === undefined ? [`${prefix}_API_KEY`] : []),
    ...(llm.model === undefined ? [`${prefix}_MODEL`] : []),
  ]
  if (missing.length === 0) return { provider: llm.provider, model: llm.model, configured: true }
  return {
    provider: llm.provider,
    model: llm.model,
    configured: false,
    problem: `Chưa cấu hình mô hình ngôn ngữ: thiếu ${missing.join(' và ')} (LLM_PROVIDER=${llm.provider}). Có thể đặt LLM_PROVIDER=mock để chạy thử không cần khoá API.`,
  }
}

export interface CreateLlmRuntimeOptions {
  /** Custom fetch for provider HTTP (tests). */
  readonly fetch?: typeof fetch
  /** Retry tuning for real providers (tests shorten the backoff). */
  readonly retry?: ProviderRetryOptions
  /** Options for LLM_PROVIDER=mock (tests record requests, demos add latency). */
  readonly mock?: MockProviderOptions
}

export interface ProviderRetryOptions {
  /** Retries after the first attempt. Default 3. */
  readonly maxRetries?: number
  /** First backoff delay; doubles per retry up to maxDelayMs. Default 1000. */
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
}

const REQUEST_TIMEOUT_MS = 120_000
const STREAM_IDLE_TIMEOUT_MS = 45_000

/** Throws LlmConfigError when the selected provider lacks a key or model. */
export async function createLlmRuntime(config: AppConfig, options: CreateLlmRuntimeOptions = {}): Promise<LlmRuntime> {
  const status = describeLlmConfig(config)
  if (!status.configured || status.model === undefined) throw new LlmConfigError(status.problem ?? 'Chưa cấu hình mô hình ngôn ngữ.')
  const { llm } = config
  const model = status.model
  const workerModel = llm.workerModel ?? model
  // Gemini declares no reasoning efforts and rejects one; config already drops it, this keeps it that way.
  const effort = llm.provider === 'openai' ? llm.effort : undefined

  const runtime = await createAgentRuntime({
    providers: [providerPlugin(config, model, effort, options)],
    defaultProvider: status.provider,
    closeTimeoutMs: 5_000,
    resource: { serviceName: 'meobeo-summarizer' },
    // Spans carry metadata only: chat content must never reach telemetry.
    observability: { content: 'none' },
  })
  return {
    runtime,
    provider: status.provider,
    model,
    workerModel,
    effort,
    async close() {
      await runtime.close()
    },
  }
}

function providerPlugin(
  config: AppConfig,
  model: string,
  effort: string | undefined,
  options: CreateLlmRuntimeOptions,
): ComposableModelProviderPlugin {
  const { llm } = config
  const transport = {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
  if (llm.provider === 'openai') {
    const { apiKey, baseUrl } = llm.openai
    return withProviderRetry(openAiPlugin({
      apiKey: required(apiKey, 'OPENAI_API_KEY'),
      defaultModel: model,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      // The SDK refuses an effort the catalog does not declare for that exact model.
      ...(effort === undefined ? {} : {
        models: [{ id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId(effort), name: effort }] } }],
      }),
      ...transport,
    }), options.retry)
  }
  if (llm.provider === 'gemini') {
    const { apiKey, baseUrl } = llm.gemini
    return withProviderRetry(geminiPlugin({
      apiKey: required(apiKey, 'GEMINI_API_KEY'),
      defaultModel: model,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...transport,
    }), options.retry)
  }
  return mockProviderPlugin(options.mock)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new LlmConfigError(`Chưa cấu hình mô hình ngôn ngữ: thiếu ${name}.`)
  return value
}

/**
 * The same plugin with every adapter it registers wrapped in withRetry. The
 * provider packages build their adapter inside setup(), so the wrap happens at
 * registration rather than by constructing adapters ourselves.
 */
export function withProviderRetry(plugin: ComposableModelProviderPlugin, retry: ProviderRetryOptions = {}): ComposableModelProviderPlugin {
  const policy = {
    mode: 'normal' as const,
    maxRetries: retry.maxRetries ?? 3,
    backoff: { initialDelayMs: retry.initialDelayMs ?? 1_000, maxDelayMs: retry.maxDelayMs ?? 15_000 },
  }
  return defineModelProviderPlugin({
    id: plugin.id,
    displayName: plugin.displayName,
    routes: plugin.routes,
    ...(plugin.family === undefined ? {} : { family: plugin.family }),
    ...(plugin.defaultModel === undefined ? {} : { defaultModel: plugin.defaultModel }),
    setup(registrar) {
      const inner: ModelProviderRegistrar & { readonly logger: unknown } = {
        // The wrapped plugin's own setup asks for the runtime-bound logger.
        logger: registrar.logger,
        registerAdapter: (routes, adapter) => registrar.registerAdapter(withRetry(adapter, { policy }), routes),
        use: middleware => registrar.use(middleware),
      }
      const cleanup = plugin.setup(inner)
      return () => {
        if (typeof cleanup === 'function') cleanup()
        return undefined
      }
    },
  })
}
