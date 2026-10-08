/**
 * Shared domain types. Every module codes against these, so they stay small and
 * free of any SDK, Graph or Teams import.
 */

/** Where the messages to summarize live. Bound by the host per turn, never chosen by a model. */
export type ConversationSource =
  | { readonly kind: 'chat'; readonly chatId: string; readonly label?: string }
  | { readonly kind: 'channel'; readonly teamId: string; readonly channelId: string; readonly label?: string }
  /** Synthetic conversation for DEMO_MODE and tests; never touches Graph. */
  | { readonly kind: 'demo'; readonly label?: string }

/** A closed time window, both ends as epoch milliseconds (`since` inclusive, `until` exclusive). */
export interface TimeRange {
  readonly since: number
  readonly until: number
}

/**
 * A validated window (any date in the past; at most MAX_RANGE_DAYS long — longer
 * periods are split into several ResolvedRange segments by range.ts).
 */
export interface ResolvedRange extends TimeRange {
  /**
   * Vietnamese human label of the exact window in the user's zone, e.g.
   * "Chủ Nhật, 06/09/2026" or "Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)".
   * The coordinator repeats it so the user can spot a misread request.
   */
  readonly label: string
  /** True when the requested end lay in the future and was moved to "now". */
  readonly clamped: boolean
  /** True when no start was requested and the default window was used. */
  readonly defaulted: boolean
  /** Human-readable notes for the model (e.g. why the window changed). */
  readonly notes: readonly string[]
}

/** One normalized chat message. Lives only in RAM for the duration of a turn or cache TTL. */
export interface TranscriptMessage {
  /** Graph message id. */
  readonly id: string
  /** 1-based sequence number in chronological order; models cite messages as `#seq`. */
  readonly seq: number
  /** Epoch milliseconds of createdDateTime. */
  readonly time: number
  readonly author: string
  /** Plain text: HTML stripped, mentions rendered as `@Name`, attachments as `[tệp: name]`. */
  readonly text: string
  /** For channel replies: the root message id. */
  readonly replyToId?: string
}

/** Raw Graph `chatMessage` subset that the fetchers and normalizer read. */
export interface GraphChatMessage {
  readonly id: string
  readonly replyToId?: string | null
  readonly messageType?: string
  readonly createdDateTime: string
  readonly lastModifiedDateTime?: string | null
  readonly deletedDateTime?: string | null
  readonly subject?: string | null
  readonly from?: {
    readonly user?: { readonly id?: string | null; readonly displayName?: string | null } | null
    readonly application?: { readonly id?: string | null; readonly displayName?: string | null } | null
  } | null
  readonly body?: { readonly contentType?: string; readonly content?: string | null } | null
  readonly attachments?: ReadonlyArray<{
    readonly id?: string | null
    readonly contentType?: string | null
    readonly name?: string | null
    readonly contentUrl?: string | null
  }> | null
  readonly mentions?: ReadonlyArray<{
    readonly id?: number
    readonly mentionText?: string | null
  }> | null
  /** Present on channel root messages fetched with `$expand=replies`. */
  readonly replies?: readonly GraphChatMessage[]
  readonly 'replies@odata.nextLink'?: string
}

/** The fetched, normalized conversation for one window. */
export interface Transcript {
  /** Opaque id the coordinator passes to specialist tools. */
  readonly id: string
  readonly source: ConversationSource
  readonly range: ResolvedRange
  readonly timeZone: string
  readonly messages: readonly TranscriptMessage[]
  /** True when MAX_MESSAGES or the scan budget stopped the fetch before the window was exhausted. */
  readonly truncated: boolean
  /** True when the scan budget (MAX_SCAN_PAGES or the time limit) stopped the scan before it reached the window start. */
  readonly scanLimited: boolean
  /** Messages formatted and split by token budget, ready for map-reduce. */
  readonly chunks: readonly TranscriptChunk[]
}

export interface TranscriptChunk {
  readonly index: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly from: number
  readonly to: number
  readonly text: string
  readonly estimatedTokens: number
}

/** Statistics the coordinator sees instead of message content. */
export interface TranscriptStats {
  readonly transcriptId: string
  /** Same as Transcript.range.label. */
  readonly label: string
  readonly messageCount: number
  readonly participants: readonly string[]
  readonly since: string
  readonly until: string
  readonly firstMessageAt?: string
  readonly lastMessageAt?: string
  readonly chunkCount: number
  readonly truncated: boolean
  readonly scanLimited: boolean
  readonly clamped: boolean
  readonly notes: readonly string[]
}

/** Fetches raw messages for a source; implemented by Graph (delegated or app-only) and the demo fixture. */
export interface MessageFetcher {
  fetch(source: ConversationSource, range: TimeRange, options: FetchOptions): Promise<FetchResult>
}

export interface FetchOptions {
  readonly maxMessages: number
  /**
   * Upper bound on Graph requests for one window (MAX_SCAN_PAGES): list pages and
   * channel reply pages alike. Matters for channels, whose API has no date
   * filter: reading an old window means paging back from "now" through every
   * thread active since then.
   */
  readonly maxScanPages?: number
  /**
   * Epoch ms after which no further page is requested (a time budget next to
   * maxScanPages, so a slow scan ends with a partial, scanLimited result instead
   * of the caller's timeout).
   */
  readonly deadline?: number
  readonly signal?: AbortSignal
  /**
   * Called after each page so hosts can show progress: in-window messages kept
   * so far, and how far back (epoch ms) the scan has reached.
   */
  readonly onPage?: (fetchedSoFar: number, scannedBackTo?: number) => void
}

export interface FetchResult {
  /** Flat list (channel replies included), any order; normalization sorts. */
  readonly messages: readonly GraphChatMessage[]
  /** True when maxMessages or maxScanPages stopped the fetch early. */
  readonly truncated: boolean
  /** True when maxScanPages or the deadline stopped the scan before reaching range.since. */
  readonly scanLimited?: boolean
  /** Oldest point in time (epoch ms) the scan reached. */
  readonly scannedBackTo?: number
}

/** Progress reported by long steps so the web UI and the Teams placeholder can show it. */
export type ProgressEvent =
  | {
      readonly kind: 'fetch'
      readonly fetched: number
      /** Epoch ms the scan has reached (channels page back from now). */
      readonly scannedBackTo?: number
      /** Label of the segment being read when a long period is split. */
      readonly segment?: string
    }
  | { readonly kind: 'transcript'; readonly stats: TranscriptStats }
  | {
      readonly kind: 'specialist'
      readonly agent: SpecialistKind
      readonly stage: 'map' | 'reduce' | 'single'
      readonly done: number
      readonly total: number
      /** The coordinator's tool call this run belongs to: one specialist may run for several segments at once. */
      readonly callId?: string
    }

export type SpecialistKind = 'summarizer' | 'action-tracker' | 'qa'

/**
 * Everything a coordinator turn needs that must not be visible to (or chosen by)
 * the model: where to read from, with which credentials, in which time zone.
 * Rebound by the host before every turn.
 */
export interface TurnContext {
  readonly source: ConversationSource
  readonly fetcher: MessageFetcher
  readonly timeZone: string
  /** Epoch ms used as "now" for this turn (injectable for tests). */
  readonly now: number
  /** App id of this bot, so its own messages are excluded from summaries. */
  readonly selfAppId?: string
  readonly signal?: AbortSignal
  readonly onProgress?: (event: ProgressEvent) => void
}
