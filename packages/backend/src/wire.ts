/**
 * The browser protocol: one JSON object per SSE `data:` frame on POST /api/chat,
 * plus the bodies of the small JSON endpoints. The web UI imports these types
 * from `@meobeo/backend/wire` and never from the SDK, as in the samples.
 *
 * This module must stay type-only plus tiny pure helpers: it is bundled into
 * the browser.
 */

import type { ConversationSource, SpecialistKind, TranscriptStats } from './types.ts'

export type { ConversationSource, SpecialistKind, TranscriptStats }

export interface WireUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export type WireEvent =
  | { readonly t: 'run-start'; readonly runId: string; readonly conversationId: string }
  /** Final-answer text from the coordinator. */
  | { readonly t: 'text-delta'; readonly text: string; readonly blockId: string }
  /** Public narration the coordinator writes before calling tools. */
  | { readonly t: 'commentary'; readonly text: string; readonly blockId: string }
  | { readonly t: 'reasoning-delta'; readonly text: string }
  | { readonly t: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly t: 'tool-result'; readonly callId: string; readonly name: string; readonly status: string; readonly isError: boolean }
  | {
      readonly t: 'fetch-progress'
      readonly fetched: number
      /** ISO time (user's zone offset) the scan has reached, when known. */
      readonly scannedBackTo?: string
      /** Segment label while a long period is read month by month. */
      readonly segment?: string
    }
  | { readonly t: 'transcript'; readonly stats: TranscriptStats }
  | {
      readonly t: 'agent-progress'
      readonly agent: SpecialistKind
      readonly stage: 'map' | 'reduce' | 'single'
      readonly done: number
      readonly total: number
      /** The tool-call this progress belongs to (parallel calls of one specialist run for different segments). */
      readonly callId?: string
    }
  | { readonly t: 'done'; readonly text: string; readonly completed: boolean; readonly usage: WireUsage }
  | { readonly t: 'error'; readonly code: string; readonly message: string }

/** POST /api/chat body. */
export interface ChatRequest {
  readonly conversationId: string
  readonly source: ConversationSource
  readonly message: string
  /** IANA zone from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  readonly timeZone?: string
}

/** POST /api/reset body. */
export interface ResetRequest {
  readonly conversationId: string
}

/** GET /api/sources response: what the signed-in user can summarize. */
export interface SourcesResponse {
  readonly chats: ReadonlyArray<{
    readonly chatId: string
    readonly chatType: string
    readonly label: string
    readonly lastUpdated?: string
  }>
  readonly teams: ReadonlyArray<{
    readonly teamId: string
    readonly label: string
    readonly channels: ReadonlyArray<{ readonly channelId: string; readonly label: string }>
    /** Set when channels of this team could not be listed (e.g. missing consent). */
    readonly error?: string
  }>
  /** Partial failures worth showing (e.g. "ChannelMessage.Read.All needs admin consent"). */
  readonly warnings: readonly string[]
}

/** GET /api/health response. */
export interface HealthResponse {
  readonly ok: true
  readonly provider: string
  readonly model: string | undefined
  readonly providerConfigured: boolean
  readonly teamsBot: boolean
  readonly demoMode: boolean
  /** Longest single window (days); longer periods are split per month. */
  readonly maxRangeDays: number
  /** Longest period accepted overall (days). */
  readonly maxPeriodDays: number
}

/** Parse one `data:` payload; returns undefined for anything that is not a known frame. */
export function parseWireEvent(payload: string): WireEvent | undefined {
  try {
    const value: unknown = JSON.parse(payload)
    if (value !== null && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string') {
      return value as WireEvent
    }
  } catch {
    // ignore malformed frames
  }
  return undefined
}
