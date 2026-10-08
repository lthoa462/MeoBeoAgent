/**
 * fetch → normalize → chunk for one turn. Holds nothing after returning.
 */

import type { ConversationSource, ResolvedRange, Transcript, TranscriptStats, TurnContext } from '../types.ts'
import { chunkTranscript } from './chunk.ts'
import { normalizeMessages } from './normalize.ts'
import { formatInZone, toZonedIso } from './range.ts'

export interface BuildOptions {
  readonly maxMessages: number
  readonly chunkTokens: number
  /** MAX_SCAN_PAGES: Graph pages one window may request (unbounded when omitted). */
  readonly maxScanPages?: number
  /** Epoch ms after which no page is requested: the read ends partial (scanLimited) instead of timing out. */
  readonly deadline?: number
  /** Label of the segment being read when a long period is split; tags `fetch` progress. */
  readonly segmentLabel?: string
}

const MAX_PARTICIPANTS = 30

/** Stable key of a source for caching, e.g. "chat:19:abc@thread.v2". */
export function sourceKey(source: ConversationSource): string {
  if (source.kind === 'chat') return `chat:${source.chatId}`
  if (source.kind === 'channel') return `channel:${source.teamId}:${source.channelId}`
  return 'demo'
}

/**
 * Fetch with `turn.fetcher` (forwarding signal and maxScanPages, reporting
 * `fetch` progress — count, how far back the scan reached, segment label — via
 * turn.onProgress), normalize (selfAppId = turn.selfAppId), chunk in
 * turn.timeZone. When the scan budget (pages or deadline) cut the scan short, a
 * Vietnamese note saying how far back it got is appended to the range notes.
 * Transcript id: "t_" + 10 random base36/hex chars.
 */
export async function buildTranscript(turn: TurnContext, range: ResolvedRange, options: BuildOptions): Promise<Transcript> {
  const { signal, onProgress } = turn
  const { maxScanPages, deadline, segmentLabel } = options
  const onPage = (fetched: number, scannedBackTo?: number): void => onProgress?.({
    kind: 'fetch',
    fetched,
    ...(scannedBackTo === undefined ? {} : { scannedBackTo }),
    ...(segmentLabel === undefined ? {} : { segment: segmentLabel }),
  })
  const fetched = await turn.fetcher.fetch(turn.source, { since: range.since, until: range.until }, {
    maxMessages: options.maxMessages,
    ...(maxScanPages === undefined ? {} : { maxScanPages }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onPage }),
  })
  signal?.throwIfAborted()
  const messages = normalizeMessages(fetched.messages, { range, selfAppId: turn.selfAppId })
  const scanLimited = fetched.scanLimited === true
  const timedOut = deadline !== undefined && Date.now() >= deadline
  return {
    id: `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    source: turn.source,
    range: scanLimited ? { ...range, notes: [...range.notes, scanLimitNote(turn, fetched.scannedBackTo, timedOut ? undefined : maxScanPages)] } : range,
    timeZone: turn.timeZone,
    messages,
    truncated: fetched.truncated || scanLimited,
    scanLimited,
    chunks: chunkTranscript(messages, { timeZone: turn.timeZone, chunkTokens: options.chunkTokens }),
  }
}

/** For people, not admins: the env name lives in the README. `maxScanPages` undefined → the time limit stopped it. */
function scanLimitNote(turn: TurnContext, scannedBackTo: number | undefined, maxScanPages: number | undefined): string {
  const busy = turn.source.kind === 'channel' ? 'Kênh có nhiều hoạt động' : 'Cuộc trò chuyện có nhiều tin nhắn'
  const reached = scannedBackTo === undefined ? 'chỉ quét được một phần' : `chỉ quét được tới ${formatInZone(scannedBackTo, turn.timeZone)}`
  const limit = maxScanPages === undefined ? 'đã hết thời gian quét cho một lần đọc' : `đã chạm giới hạn quét ${maxScanPages} trang`
  return `${busy}: ${reached} (${limit}) nên có thể thiếu tin nhắn trước đó.`
}

/** What the coordinator sees: counts, participants (by message count desc, max 30), ISO times in the transcript zone. */
export function transcriptStats(transcript: Transcript): TranscriptStats {
  const { messages, range, timeZone } = transcript
  const counts = new Map<string, number>()
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const message of messages) {
    counts.set(message.author, (counts.get(message.author) ?? 0) + 1)
    first = Math.min(first, message.time)
    last = Math.max(last, message.time)
  }
  // Map keeps first-appearance order, which breaks count ties deterministically.
  const participants = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_PARTICIPANTS).map(([name]) => name)

  const notes = [...range.notes]
  if (messages.length === 0) {
    notes.push(transcript.scanLimited
      ? 'Chưa tìm thấy tin nhắn nào (việc quét dừng trước khi đọc hết khoảng thời gian này).'
      : 'Không có tin nhắn nào trong khoảng thời gian này.')
  }
  if (transcript.truncated && !transcript.scanLimited) {
    const from = messages.length === 0 ? '' : ` (từ ${formatInZone(first, timeZone)})`
    notes.push(`Đã chạm giới hạn số tin nhắn được đọc; chỉ có các tin mới nhất${from}, các tin cũ hơn trong khoảng thời gian bị bỏ qua.`)
  }
  return {
    transcriptId: transcript.id,
    label: range.label,
    messageCount: messages.length,
    participants,
    since: toZonedIso(range.since, timeZone),
    until: toZonedIso(range.until, timeZone),
    ...(messages.length === 0 ? {} : { firstMessageAt: toZonedIso(first, timeZone), lastMessageAt: toZonedIso(last, timeZone) }),
    chunkCount: transcript.chunks.length,
    truncated: transcript.truncated,
    scanLimited: transcript.scanLimited,
    clamped: range.clamped,
    notes,
  }
}
