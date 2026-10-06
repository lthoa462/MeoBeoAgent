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
}

const MAX_PARTICIPANTS = 30

/** Stable key of a source for caching, e.g. "chat:19:abc@thread.v2". */
export function sourceKey(source: ConversationSource): string {
  if (source.kind === 'chat') return `chat:${source.chatId}`
  if (source.kind === 'channel') return `channel:${source.teamId}:${source.channelId}`
  return 'demo'
}

/**
 * Fetch with `turn.fetcher` (forwarding signal, reporting `fetch` progress via
 * turn.onProgress), normalize (selfAppId = turn.selfAppId), chunk in
 * turn.timeZone. Transcript id: "t_" + 10 random base36/hex chars.
 */
export async function buildTranscript(turn: TurnContext, range: ResolvedRange, options: BuildOptions): Promise<Transcript> {
  const { signal, onProgress } = turn
  const fetched = await turn.fetcher.fetch(turn.source, { since: range.since, until: range.until }, {
    maxMessages: options.maxMessages,
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onPage: (count: number) => onProgress({ kind: 'fetch', fetched: count }) }),
  })
  signal?.throwIfAborted()
  const messages = normalizeMessages(fetched.messages, { range, selfAppId: turn.selfAppId })
  return {
    id: `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    source: turn.source,
    range,
    timeZone: turn.timeZone,
    messages,
    truncated: fetched.truncated,
    chunks: chunkTranscript(messages, { timeZone: turn.timeZone, chunkTokens: options.chunkTokens }),
  }
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
  if (messages.length === 0) notes.push('Không có tin nhắn nào trong khoảng thời gian này.')
  if (transcript.truncated) {
    const from = messages.length === 0 ? '' : ` (từ ${formatInZone(first, timeZone)})`
    notes.push(`Đã chạm giới hạn số tin nhắn được đọc; chỉ có các tin mới nhất${from}, các tin cũ hơn trong khoảng thời gian bị bỏ qua.`)
  }
  return {
    transcriptId: transcript.id,
    messageCount: messages.length,
    participants,
    since: toZonedIso(range.since, timeZone),
    until: toZonedIso(range.until, timeZone),
    ...(messages.length === 0 ? {} : { firstMessageAt: toZonedIso(first, timeZone), lastMessageAt: toZonedIso(last, timeZone) }),
    chunkCount: transcript.chunks.length,
    truncated: transcript.truncated,
    clamped: range.clamped,
    notes,
  }
}
