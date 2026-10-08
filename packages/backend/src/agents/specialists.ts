/**
 * Map-reduce over transcript chunks, orchestrated by the host (Promise.all with
 * a concurrency cap), as the SDK docs recommend for deterministic fan-out:
 *
 * - 1 chunk  → specialists[kind].generate(task + transcript)           stage 'single'
 * - n chunks → chunkReader.generate(task + chunk i) for all i (≤ concurrency
 *   at a time)                                                          stage 'map'
 *            → specialists[kind].generate(task + all notes)             stage 'reduce'
 *              (if notes exceed ~chunkTokens*1.5, reduce in groups first)
 *
 * Every generate() forwards `signal`. Progress is reported after each unit of
 * work. An incomplete specialist response is returned with a short warning
 * prefix instead of throwing, so the coordinator can still answer.
 *
 * Failure policy: an abort always propagates. Any other failure of one map or
 * merge call is recorded in the notes ("(phần i lỗi)") so the rest of the
 * summary survives; only when every map call fails does the run throw.
 */

import type { RuntimeAgent } from '@alvin0/ai-agent-sdk-core'
import { estimateTextTokens } from '@alvin0/ai-agent-sdk-core/tools'
import { formatInZone } from '../transcript/range.ts'
import type { ProgressEvent, SpecialistKind, Transcript, TranscriptChunk } from '../types.ts'
import type { AgentTeam } from './team.ts'

export interface SpecialistRunOptions {
  readonly team: AgentTeam
  readonly kind: SpecialistKind
  readonly transcript: Transcript
  /** What to produce: a focus for the summary, or the user's question. */
  readonly task: string
  readonly concurrency: number
  /** Budget used to group notes in the reduce step. */
  readonly chunkTokens: number
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined
  /** The coordinator's tool call running this specialist; tags every progress event. */
  readonly callId?: string | undefined
}

const NO_MESSAGES = 'Không có tin nhắn nào trong khoảng thời gian này.'
const INCOMPLETE = '_(Lưu ý: mô hình dừng sớm nên kết quả có thể chưa đầy đủ.)_'
const KIND_LABEL: Readonly<Record<SpecialistKind, string>> = {
  summarizer: 'chuyên gia tóm tắt',
  'action-tracker': 'chuyên gia theo dõi việc cần làm',
  qa: 'chuyên gia trả lời câu hỏi',
}

export async function runSpecialist(options: SpecialistRunOptions): Promise<string> {
  const { team, kind, transcript, signal } = options
  const report = (stage: 'map' | 'reduce' | 'single', done: number, total: number): void => {
    options.onProgress?.({ kind: 'specialist', agent: kind, stage, done, total, ...(options.callId === undefined ? {} : { callId: options.callId }) })
  }
  const chunks = transcript.chunks
  const only = chunks.length === 1 ? chunks[0] : undefined
  if (chunks.length === 0) return NO_MESSAGES

  if (only !== undefined) {
    report('single', 0, 1)
    const text = await generate(team.specialists[kind], singlePrompt(options, only), signal)
    report('single', 1, 1)
    return text
  }

  let mapped = 0
  let failed = 0
  report('map', 0, chunks.length)
  const notes = await mapLimit(chunks, options.concurrency, async (chunk): Promise<Notes> => {
    try {
      return notesOf(chunk, await generate(team.chunkReader, chunkPrompt(options, chunk), signal))
    } catch (error) {
      if (isAbort(error, signal)) throw error
      failed++
      // Nothing but a marker: one unreadable part should not sink the summary.
      return notesOf(chunk, `(phần ${chunk.index + 1} lỗi)`)
    } finally {
      report('map', ++mapped, chunks.length)
    }
  })
  if (failed === chunks.length) throw new Error('Không đọc được phần nào của cuộc trò chuyện.')

  const condensed = await condense(options, notes, report)
  report('reduce', 0, 1)
  const text = await generate(team.specialists[kind], reducePrompt(options, condensed), signal)
  report('reduce', 1, 1)
  return text
}

/** Notes extracted from consecutive chunks, with the span they cover. */
interface Notes {
  readonly first: TranscriptChunk
  readonly last: TranscriptChunk
  readonly text: string
}

function notesOf(chunk: TranscriptChunk, text: string): Notes {
  return { first: chunk, last: chunk, text }
}

/**
 * Merge notes in groups (with the cheap worker) until they fit the final
 * reducer's budget. Every group holds at least two notes, so each level at
 * least halves the count and the loop always ends.
 */
async function condense(
  options: SpecialistRunOptions,
  notes: readonly Notes[],
  report: (stage: 'reduce', done: number, total: number) => void,
): Promise<readonly Notes[]> {
  const budget = Math.max(1, Math.floor(options.chunkTokens * 1.5))
  let parts = notes
  while (parts.length > 1 && estimateTextTokens(renderNotes(options.transcript, parts)) > budget) {
    const groups = groupNotes(options.transcript, parts, Math.max(1, options.chunkTokens))
    let merged = 0
    report('reduce', 0, groups.length)
    parts = await mapLimit(groups, options.concurrency, async (group): Promise<Notes> => {
      const first = group[0]
      const last = group.at(-1)
      if (first === undefined || last === undefined) throw new Error('empty group')
      try {
        const text = await generate(options.team.chunkReader, mergePrompt(options, group), options.signal)
        return { first: first.first, last: last.last, text }
      } catch (error) {
        if (isAbort(error, options.signal)) throw error
        // Keep the unmerged notes: bigger, but nothing is lost.
        return { first: first.first, last: last.last, text: renderNotes(options.transcript, group) }
      } finally {
        report('reduce', ++merged, groups.length)
      }
    })
  }
  return parts
}

function groupNotes(transcript: Transcript, parts: readonly Notes[], budget: number): Notes[][] {
  const groups: Notes[][] = []
  let current: Notes[] = []
  let used = 0
  for (const part of parts) {
    const cost = estimateTextTokens(renderNotes(transcript, [part]))
    if (current.length >= 2 && used + cost > budget) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(part)
    used += cost
  }
  // A lone trailing note joins the previous group, so no group is a no-op.
  const previous = groups.at(-1)
  if (current.length === 1 && previous !== undefined) previous.push(...current)
  else if (current.length > 0) groups.push(current)
  return groups
}

// ---------------------------------------------------------------------------
// Prompts. Task text first (it sets the output language), data last, fenced.

function singlePrompt(options: SpecialistRunOptions, chunk: TranscriptChunk): string {
  return [
    `Nhiệm vụ: ${options.task}`,
    describeTranscript(options.transcript),
    fence('transcript', chunk.text),
  ].join('\n\n')
}

function chunkPrompt(options: SpecialistRunOptions, chunk: TranscriptChunk): string {
  const { transcript } = options
  return [
    `Nhiệm vụ cuối cùng (do ${KIND_LABEL[options.kind]} thực hiện): ${options.task}`,
    `Đây là phần ${chunk.index + 1}/${transcript.chunks.length} của cuộc trò chuyện: ${spanOf(transcript, chunk, chunk)}. Chỉ ghi lại những gì liên quan đến nhiệm vụ.`,
    fence('transcript', chunk.text),
  ].join('\n\n')
}

function mergePrompt(options: SpecialistRunOptions, group: readonly Notes[]): string {
  return [
    `Nhiệm vụ cuối cùng (do ${KIND_LABEL[options.kind]} thực hiện): ${options.task}`,
    'Dưới đây là ghi chú trích từ nhiều phần liên tiếp của một cuộc trò chuyện. Hãy gộp thành một bản ghi chú gọn theo thứ tự thời gian, bỏ trùng lặp, giữ mọi trích dẫn #n.',
    fence('notes', renderNotes(options.transcript, group)),
  ].join('\n\n')
}

function reducePrompt(options: SpecialistRunOptions, parts: readonly Notes[]): string {
  const { transcript } = options
  return [
    `Nhiệm vụ: ${options.task}`,
    `${describeTranscript(transcript)} Cuộc trò chuyện dài nên đã được đọc thành ${transcript.chunks.length} phần; dưới đây là ghi chú trích từ từng phần theo thứ tự thời gian, kèm trích dẫn #n tới tin nhắn gốc.`,
    fence('notes', renderNotes(transcript, parts)),
  ].join('\n\n')
}

function describeTranscript(transcript: Transcript): string {
  const { range, timeZone, messages } = transcript
  const truncated = transcript.scanLimited
    ? ' Việc quét dừng sớm (chạm giới hạn quét) nên có thể thiếu các tin cũ hơn trong khoảng này.'
    : transcript.truncated ? ' Đã chạm giới hạn số tin nhắn nên chỉ có các tin mới nhất trong khoảng này.' : ''
  return `Cuộc trò chuyện từ ${formatInZone(range.since, timeZone)} đến ${formatInZone(range.until, timeZone)} (${range.label}, múi giờ ${timeZone}), ${messages.length} tin nhắn.${truncated}`
}

function renderNotes(transcript: Transcript, parts: readonly Notes[]): string {
  const total = transcript.chunks.length
  return parts.map(part => {
    const which = part.first === part.last ? `${part.first.index + 1}` : `${part.first.index + 1}–${part.last.index + 1}`
    return `### Phần ${which}/${total} (${spanOf(transcript, part.first, part.last)})\n${part.text}`
  }).join('\n\n')
}

function spanOf(transcript: Transcript, first: TranscriptChunk, last: TranscriptChunk): string {
  const zone = transcript.timeZone
  return `tin #${first.firstSeq}–#${last.lastSeq}, ${formatInZone(first.from, zone)} → ${formatInZone(last.to, zone)}, múi giờ ${zone}`
}

/**
 * Wrap data in a tag, neutralizing any tag of ours inside it: a chat message
 * containing "</transcript>" must not be able to end the data block early.
 */
export function fence(tag: 'transcript' | 'notes', text: string): string {
  return `<${tag}>\n${text.replace(/<(\s*\/?\s*(?:transcript|notes))/gi, '‹$1')}\n</${tag}>`
}

// ---------------------------------------------------------------------------

async function generate(agent: RuntimeAgent, prompt: string, signal: AbortSignal | undefined): Promise<string> {
  const response = await agent.generate(prompt, signal === undefined ? {} : { signal })
  const text = response.text.trim()
  return response.completed ? text : `${INCOMPLETE}\n\n${text}`.trim()
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORTED'
}

/**
 * Promise.all with at most `limit` tasks in flight, results in input order.
 * After the first rejection no new task starts.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  let stopped = false
  const lane = async (): Promise<void> => {
    while (!stopped && next < items.length) {
      const index = next++
      try {
        results[index] = await task(items[index] as T, index)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  const width = Math.min(Math.max(1, Math.floor(limit) || 1), items.length)
  await Promise.all(Array.from({ length: width }, lane))
  return results
}
