/**
 * Composition root, a process-wide singleton on globalThis (survives Next.js
 * hot reloads, as in the chat-agents sample).
 */

import { readConfig, type AppConfig } from './config.ts'
import { createAppTokenProvider } from './graph/app-token.ts'
import type { AccessTokenProvider } from './graph/client.ts'
import { createLlmRuntime, describeLlmConfig, type CreateLlmRuntimeOptions, type LlmRuntime } from './llm/runtime.ts'
import { ConversationManager } from './agents/session.ts'
import { createAgentTeam } from './agents/team.ts'
import { TranscriptCache } from './transcript/cache.ts'

export interface AppServices {
  readonly config: AppConfig
  /** Undefined when the selected provider is not configured; see llmProblem. */
  readonly llm: LlmRuntime | undefined
  readonly llmProblem: string | undefined
  readonly conversations: ConversationManager | undefined
  readonly cache: TranscriptCache
  /** App-only Graph tokens per tenant for the Teams bot (RSC); undefined without CLIENT_ID/SECRET. */
  readonly appTokens: ((tenantId: string) => AccessTokenProvider) | undefined
  /** Fetch used for Graph calls (overridable in tests). */
  readonly graphFetch: typeof fetch
  close(): Promise<void>
}

export interface CreateServicesOptions {
  readonly config?: AppConfig
  readonly graphFetch?: typeof fetch
  readonly llmFetch?: typeof fetch
  readonly now?: () => number
  /** Extra runtime options (mock latency, retry tuning); `llmFetch` wins over `llm.fetch`. */
  readonly llm?: CreateLlmRuntimeOptions
}

/** Sessions and cached transcripts are swept this often; both also expire lazily. */
const PRUNE_INTERVAL_MS = 60_000

/**
 * Work that must stop before the services it uses (e.g. the Teams bot's
 * background replies). Kept out of AppServices so modules that are loaded
 * lazily (the Teams SDK) can hook in without services.ts importing them.
 */
const cleanups = new WeakMap<AppServices, Set<() => Promise<void> | void>>()

/** Run `cleanup` first when `services.close()` is called. Returns an unregister function. */
export function onServicesClose(services: AppServices, cleanup: () => Promise<void> | void): () => void {
  let set = cleanups.get(services)
  if (set === undefined) {
    set = new Set()
    cleanups.set(services, set)
  }
  set.add(cleanup)
  return () => { set.delete(cleanup) }
}

export async function createServices(options: CreateServicesOptions = {}): Promise<AppServices> {
  const config = options.config ?? readConfig()
  const graphFetch = options.graphFetch ?? globalThis.fetch
  const cache = new TranscriptCache({
    ttlMs: config.limits.transcriptCacheTtlMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const status = describeLlmConfig(config)
  let llm: LlmRuntime | undefined
  let llmProblem = status.problem
  if (status.configured) {
    try {
      const llmFetch = options.llmFetch ?? options.llm?.fetch
      llm = await createLlmRuntime(config, { ...options.llm, ...(llmFetch === undefined ? {} : { fetch: llmFetch }) })
    } catch (error) {
      // The provider's own message can echo request details; people get a fixed sentence.
      console.error('[meobeo] LLM runtime failed to start:', error instanceof Error ? error.name : typeof error)
      llmProblem = `Không khởi tạo được mô hình ngôn ngữ (LLM_PROVIDER=${config.llm.provider}); xem log của server.`
    }
  }

  const conversations = llm === undefined
    ? undefined
    : new ConversationManager({
        llm,
        team: createAgentTeam(llm),
        cache,
        config,
        ...(options.now === undefined ? {} : { now: options.now }),
      })

  const { clientId, clientSecret } = config.teams
  const appTokens = clientId !== undefined && clientSecret !== undefined
    ? createAppTokenProvider({ clientId, clientSecret, fetch: graphFetch, ...(options.now === undefined ? {} : { now: options.now }) })
    : undefined

  const sweep = setInterval(() => {
    conversations?.prune()
    cache.prune()
  }, PRUNE_INTERVAL_MS)
  // Housekeeping must never keep a process (or a test run) alive.
  sweep.unref?.()

  let closing: Promise<void> | undefined
  const services: AppServices = {
    config,
    llm,
    llmProblem,
    conversations,
    cache,
    appTokens,
    graphFetch,
    close() {
      closing ??= (async () => {
        clearInterval(sweep)
        const hooks = [...cleanups.get(services) ?? []]
        cleanups.delete(services)
        await Promise.allSettled(hooks.map(async hook => { await hook() }))
        await conversations?.close()
        cache.clear()
        await llm?.close()
      })()
      return closing
    },
  }
  return services
}

const SINGLETON = Symbol.for('meobeo.services')

type SingletonHolder = Record<symbol, Promise<AppServices> | undefined>

/** Lazily created process singleton. */
export function getServices(): Promise<AppServices> {
  const holder = globalThis as unknown as SingletonHolder
  let pending = holder[SINGLETON]
  if (pending === undefined) {
    pending = createServices()
    holder[SINGLETON] = pending
    // A failed start must not stick: the next request tries again.
    pending.catch(() => {
      if (holder[SINGLETON] === pending) holder[SINGLETON] = undefined
    })
  }
  return pending
}

/** Close the process singleton if it was ever created (graceful shutdown, tests). */
export async function closeServices(): Promise<void> {
  const holder = globalThis as unknown as SingletonHolder
  const pending = holder[SINGLETON]
  holder[SINGLETON] = undefined
  if (pending === undefined) return
  const services = await pending.catch(() => undefined)
  await services?.close()
}
