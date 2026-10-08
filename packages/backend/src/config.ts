/**
 * Environment configuration, read on every call (like the edge sample's
 * config.ts) so tests can change `process.env` between cases. An out-of-range
 * or malformed value falls back to its default instead of crashing the server.
 *
 * The SDK never reads the environment itself; this module is the only place
 * that does.
 */

export type LlmProvider = 'openai' | 'gemini' | 'mock'

/**
 * Product rule: one read covers at most one month (any month in the past —
 * there is no lookback limit). Longer periods are split into segments of at
 * most this many days and summarized per segment, up to HARD_MAX_PERIOD_DAYS.
 */
export const HARD_MAX_RANGE_DAYS = 31
/** Upper bound for a whole (split) period, e.g. a quarter by default, a year at most. */
export const HARD_MAX_PERIOD_DAYS = 366

export interface AppConfig {
  readonly llm: {
    readonly provider: LlmProvider
    /** Model for the coordinator and specialists (reduce step). */
    readonly model: string | undefined
    /** Optional cheaper model for chunk-reader map workers; defaults to `model`. */
    readonly workerModel: string | undefined
    /** OpenAI reasoning effort (ignored for Gemini, which rejects effort). */
    readonly effort: string | undefined
    readonly openai: { readonly apiKey: string | undefined; readonly model: string | undefined; readonly baseUrl: string | undefined }
    readonly gemini: { readonly apiKey: string | undefined; readonly model: string | undefined; readonly baseUrl: string | undefined }
  }
  readonly teams: {
    /** Entra app (bot) id; also used to skip the bot's own messages. */
    readonly clientId: string | undefined
    readonly clientSecret: string | undefined
    readonly tenantId: string | undefined
    /** True when CLIENT_ID and CLIENT_SECRET are set, or unauthenticated local testing is allowed. */
    readonly enabled: boolean
  }
  readonly web: {
    /** Public URL of the web app, used in the bot's help message. */
    readonly url: string | undefined
  }
  readonly limits: {
    /** Longest single window read at once (≤ HARD_MAX_RANGE_DAYS). */
    readonly maxRangeDays: number
    /** Longest period accepted overall; longer than maxRangeDays → split into segments. */
    readonly maxPeriodDays: number
    /** Default window when the user names none. */
    readonly defaultLookbackHours: number
    /** Max Graph list pages per window (bounds channel scans back to old dates). */
    readonly maxScanPages: number
    readonly maxMessages: number
    /** Estimated tokens per transcript chunk handed to one map worker. */
    readonly chunkTokens: number
    /** Parallel map workers per specialist. */
    readonly mapConcurrency: number
    /** RAM-only transcript cache TTL; 0 keeps a transcript only for the current turn. */
    readonly transcriptCacheTtlMs: number
    /** Idle time after which a conversation's agent session is dropped. */
    readonly sessionTtlMs: number
    readonly maxSessions: number
  }
  readonly defaultTimeZone: string
  /** Serve a synthetic conversation and skip Microsoft sign-in (local demo only). */
  readonly demoMode: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = oneOf(env.LLM_PROVIDER, ['openai', 'gemini', 'mock'] as const, 'openai')
  const openaiModel = text(env.OPENAI_MODEL)
  const geminiModel = text(env.GEMINI_MODEL)
  const model = provider === 'openai' ? openaiModel : provider === 'gemini' ? geminiModel : 'mock-model'
  const clientId = text(env.CLIENT_ID)
  const clientSecret = text(env.CLIENT_SECRET)
  const unauthenticated = flag(env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS)
  const maxRangeDays = int(env.MAX_RANGE_DAYS, HARD_MAX_RANGE_DAYS, 1, HARD_MAX_RANGE_DAYS)
  return {
    llm: {
      provider,
      model,
      workerModel: text(env.WORKER_MODEL) ?? model,
      effort: provider === 'openai' ? text(env.OPENAI_REASONING_EFFORT) : undefined,
      openai: { apiKey: text(env.OPENAI_API_KEY), model: openaiModel, baseUrl: text(env.OPENAI_BASE_URL) },
      gemini: { apiKey: text(env.GEMINI_API_KEY), model: geminiModel, baseUrl: text(env.GEMINI_BASE_URL) },
    },
    teams: {
      clientId,
      clientSecret,
      tenantId: text(env.TENANT_ID),
      enabled: (clientId !== undefined && clientSecret !== undefined) || unauthenticated,
    },
    web: { url: text(env.WEB_URL) },
    limits: {
      maxRangeDays,
      maxPeriodDays: Math.max(maxRangeDays, int(env.MAX_PERIOD_DAYS, 92, 1, HARD_MAX_PERIOD_DAYS)),
      defaultLookbackHours: int(env.DEFAULT_LOOKBACK_HOURS, 24, 1, maxRangeDays * 24),
      maxScanPages: int(env.MAX_SCAN_PAGES, 200, 5, 5_000),
      maxMessages: int(env.MAX_MESSAGES, 3000, 50, 20_000),
      chunkTokens: int(env.CHUNK_TOKENS, 12_000, 1_000, 200_000),
      mapConcurrency: int(env.MAP_CONCURRENCY, 4, 1, 16),
      transcriptCacheTtlMs: int(env.TRANSCRIPT_CACHE_TTL_MS, 10 * 60_000, 0, 60 * 60_000),
      sessionTtlMs: int(env.SESSION_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000),
      maxSessions: int(env.MAX_SESSIONS, 200, 1, 10_000),
    },
    defaultTimeZone: timeZone(env.DEFAULT_TIMEZONE) ?? 'Asia/Ho_Chi_Minh',
    demoMode: flag(env.DEMO_MODE),
  }
}

/** True when `zone` is an IANA time zone this runtime understands. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function timeZone(value: string | undefined): string | undefined {
  const zone = text(value)
  return zone !== undefined && isValidTimeZone(zone) ? zone : undefined
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function oneOf<const T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const normalized = value?.trim().toLowerCase()
  return allowed.find(option => option === normalized) ?? fallback
}
