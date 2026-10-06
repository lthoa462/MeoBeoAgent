/**
 * Coordinator tools. They close over the CURRENT TurnContext, which the host
 * rebinds before every turn — so the model can choose WHEN (the time window)
 * and WHAT (focus / question) but never WHERE (which chat) or WITH WHAT
 * CREDENTIALS. Message content never enters the coordinator's history:
 * load_messages returns statistics only; specialists read the transcript from
 * RAM by id.
 *
 * - load_messages { since?, until? }  (ISO 8601, see range.ts)
 *     → TranscriptStats JSON (transcriptId, counts, participants, clamped/notes)
 *       or a Vietnamese error the model can correct.
 * - summarize_messages { transcriptId, focus? }        → summarizer output
 * - extract_action_items { transcriptId }              → action-tracker output
 * - answer_question { transcriptId, question }         → qa output
 * Specialist tools set isConcurrencySafe: () => true (run in parallel when the
 * model calls several in one step), forward ctx.signal, timeoutMs ~10 min.
 * Transcripts are looked up in this turn's map, then in the TTL cache;
 * unknown/expired id → error telling the model to call load_messages again.
 *
 * Isolation: cache keys start with `cacheScope` (who is reading), and an id is
 * honored only if this toolkit loaded it and it belongs to the turn's current
 * source, so a guessed or stale id can never reach another reader's messages.
 * Failures the model can act on come back as `{ error }` results, not throws;
 * only cancellation propagates.
 */

import { defineTool, type JsonValue, type ToolDefinition, type ToolRunContext } from '@alvin0/ai-agent-sdk-core'
import type { AppConfig } from '../config.ts'
import { GraphError, describeGraphError } from '../graph/client.ts'
import { buildTranscript, sourceKey, transcriptStats } from '../transcript/build.ts'
import type { TranscriptCache } from '../transcript/cache.ts'
import { resolveRange } from '../transcript/range.ts'
import type { ConversationSource, SpecialistKind, Transcript, TurnContext } from '../types.ts'
import { runSpecialist } from './specialists.ts'
import type { AgentTeam } from './team.ts'

export const TOOL_NAMES = {
  load: 'load_messages',
  summarize: 'summarize_messages',
  actions: 'extract_action_items',
  ask: 'answer_question',
} as const

export interface CoordinatorToolDeps {
  readonly team: AgentTeam
  readonly cache: TranscriptCache
  readonly limits: AppConfig['limits']
  /** The context of the turn currently running on this session; undefined between turns. */
  readonly currentTurn: () => TurnContext | undefined
  /**
   * Who is reading, e.g. the session key "<userOid>:<conversationId>". Prefixes
   * every cache key so a transcript fetched with one person's token is never
   * served to another. Defaults to a per-toolkit random scope (no sharing).
   */
  readonly cacheScope?: string
}

export interface CoordinatorToolkit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools: readonly ToolDefinition<any>[]
  /** Drop this turn's transcript references (call when a turn ends). */
  endTurn(): void
}

interface LoadArgs {
  readonly since?: string
  readonly until?: string
}

interface SpecialistArgs {
  readonly transcriptId: string
  readonly focus?: string
  readonly question?: string
}

const LOAD_TIMEOUT_MS = 5 * 60_000
const SPECIALIST_TIMEOUT_MS = 10 * 60_000
/** Ids this session may still refer to; older ones have long expired from the cache anyway. */
const MAX_KNOWN_IDS = 50

const NO_TURN = 'Không có lượt hội thoại nào đang chạy; không thể đọc tin nhắn lúc này.'

export function createCoordinatorToolkit(deps: CoordinatorToolDeps): CoordinatorToolkit {
  const { limits } = deps
  const scope = deps.cacheScope ?? `anon-${crypto.randomUUID()}`
  /** This turn's transcripts: with cache TTL 0 they live only here. */
  const current = new Map<string, Transcript>()
  /** Every id this session loaded, oldest first. */
  const known = new Set<string>()

  const remember = (transcript: Transcript): void => {
    current.set(transcript.id, transcript)
    known.delete(transcript.id)
    known.add(transcript.id)
    for (const id of known) {
      if (known.size <= MAX_KNOWN_IDS) break
      known.delete(id)
    }
  }

  const lookup = (id: string, turn: TurnContext): Transcript | undefined => {
    if (!known.has(id)) return undefined
    const transcript = current.get(id) ?? deps.cache.get(id)
    return transcript !== undefined && sourceKey(transcript.source) === sourceKey(turn.source) ? transcript : undefined
  }

  const load = defineTool<LoadArgs>({
    name: TOOL_NAMES.load,
    description: [
      'Fetch the messages of the Teams conversation bound to this chat (you cannot choose another one) for a time window and keep them in server memory.',
      `At most the last ${limits.maxLookbackDays} days can be read; an earlier start is clamped and reported (clamped=true).`,
      'Returns statistics only — transcriptId, messageCount, participants, the actual window (since/until in the user\'s zone), firstMessageAt/lastMessageAt, truncated, clamped, notes — never message text.',
      'Pass transcriptId to summarize_messages, extract_action_items or answer_question.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: `Start of the window (inclusive), ISO 8601 with the user's UTC offset, e.g. "2026-10-05T00:00:00+07:00". A date alone means the start of that day in the user's zone. Omit for the default (the last ${limits.defaultLookbackHours} hours).`,
        },
        until: {
          type: 'string',
          description: 'End of the window (EXCLUSIVE), same format. Omit to read up to now. A date alone means the START of that day, so "only 5 October" is since "2026-10-05", until "2026-10-06".',
        },
      },
      required: [],
      additionalProperties: false,
    },
    parse: raw => {
      const since = optionalText(raw, 'since', 64)
      const until = optionalText(raw, 'until', 64)
      return { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) }
    },
    timeoutMs: LOAD_TIMEOUT_MS,
    async execute(args, ctx): Promise<JsonValue> {
      const turn = deps.currentTurn()
      if (turn === undefined) return { error: NO_TURN }
      const resolved = resolveRange(args, {
        now: turn.now,
        timeZone: turn.timeZone,
        maxLookbackDays: limits.maxLookbackDays,
        defaultLookbackHours: limits.defaultLookbackHours,
      })
      if (!resolved.ok) return { error: resolved.error }

      const { range } = resolved
      const signal = anySignal(turn.signal, ctx.signal)
      const key = [scope, sourceKey(turn.source), range.since, range.until].join('|')
      try {
        const transcript = await deps.cache.load(key, () => buildTranscript({ ...turn, signal }, range, {
          maxMessages: limits.maxMessages,
          chunkTokens: limits.chunkTokens,
        }))
        remember(transcript)
        const stats = transcriptStats(transcript)
        turn.onProgress?.({ kind: 'transcript', stats })
        return { ...stats }
      } catch (error) {
        if (signal.aborted) throw error
        return { error: describeLoadError(error, turn.source) }
      }
    },
  })

  const specialist = (
    name: string,
    kind: SpecialistKind,
    description: string,
    extra: { readonly key: 'focus' | 'question'; readonly description: string; readonly required: boolean } | undefined,
    task: (args: SpecialistArgs) => string,
  ): ToolDefinition<SpecialistArgs> => defineTool<SpecialistArgs>({
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        transcriptId: { type: 'string', description: 'The transcriptId returned by load_messages.' },
        ...(extra === undefined ? {} : { [extra.key]: { type: 'string', description: extra.description } }),
      },
      required: extra?.required === true ? ['transcriptId', extra.key] : ['transcriptId'],
      additionalProperties: false,
    },
    parse: raw => {
      const transcriptId = optionalText(raw, 'transcriptId', 64)
      if (transcriptId === undefined) throw new TypeError('transcriptId is required: call load_messages first and pass its transcriptId.')
      if (extra === undefined) return { transcriptId }
      const value = optionalText(raw, extra.key, 1_000)
      if (value === undefined && extra.required) throw new TypeError(`${extra.key} is required.`)
      return { transcriptId, ...(value === undefined ? {} : { [extra.key]: value }) }
    },
    isConcurrencySafe: () => true,
    timeoutMs: SPECIALIST_TIMEOUT_MS,
    async execute(args, ctx: ToolRunContext): Promise<JsonValue> {
      const turn = deps.currentTurn()
      if (turn === undefined) return { error: NO_TURN }
      const transcript = lookup(args.transcriptId, turn)
      if (transcript === undefined) {
        return {
          error: 'transcriptId không tồn tại hoặc đã hết hạn (tin nhắn chỉ được giữ tạm trong bộ nhớ). Hãy gọi load_messages lại với cùng khoảng thời gian rồi dùng transcriptId mới.',
        }
      }
      const signal = anySignal(turn.signal, ctx.signal)
      try {
        return await runSpecialist({
          team: deps.team,
          kind,
          transcript,
          task: task(args),
          concurrency: limits.mapConcurrency,
          chunkTokens: limits.chunkTokens,
          signal,
          onProgress: turn.onProgress,
        })
      } catch (error) {
        if (signal.aborted) throw error
        // Provider details stay out of the model's context; the run report keeps them for the host.
        return { error: 'Không đọc được tin nhắn do lỗi khi gọi mô hình ngôn ngữ. Có thể thử lại một lần; nếu vẫn lỗi, hãy báo cho người dùng.' }
      }
    },
  })

  const tools = [
    load,
    specialist(
      TOOL_NAMES.summarize,
      'summarizer',
      'Summarize the loaded messages (overview, main topics, decisions, open questions) with #n citations. Runs a specialist agent over the whole transcript; call it in the same step as extract_action_items for a general summary.',
      { key: 'focus', description: 'Optional focus in the user\'s words, e.g. "phần thảo luận về release". Omit for a general summary.', required: false },
      args => args.focus === undefined
        ? 'Tóm tắt cuộc trò chuyện cho người đã bỏ lỡ: tổng quan, chủ đề chính, quyết định, câu hỏi còn mở.'
        : `Tóm tắt cuộc trò chuyện, tập trung vào: ${args.focus}`,
    ),
    specialist(
      TOOL_NAMES.actions,
      'action-tracker',
      'Extract action items from the loaded messages: tasks, commitments and requests, with owner, deadline, status and #n citations.',
      undefined,
      () => 'Liệt kê các việc cần làm, cam kết và yêu cầu trong cuộc trò chuyện: việc gì, ai phụ trách, hạn khi nào, trạng thái.',
    ),
    specialist(
      TOOL_NAMES.ask,
      'qa',
      'Answer one specific question using only the loaded messages, with #n citations; says so when the messages do not contain the answer.',
      { key: 'question', description: 'The user\'s question, in their own words and language.', required: true },
      args => `Trả lời câu hỏi sau của người dùng, bằng ngôn ngữ của câu hỏi: ${args.question ?? ''}`,
    ),
  ]

  return {
    tools,
    endTurn() {
      current.clear()
    },
  }
}

/** A short, safe Vietnamese explanation the model can relay. */
function describeLoadError(error: unknown, source: ConversationSource): string {
  if (!(error instanceof GraphError)) return 'Không tải được tin nhắn do lỗi kết nối tới Microsoft Graph; hãy thử lại sau ít phút.'
  if (error.status === 403 || error.status === 404) return `${describeGraphError(error)} ${permissionHint(source)}`.trim()
  if (error.status === 429 || error.status === 503 || error.status === 504) {
    return 'Microsoft Graph đang bị giới hạn tần suất (hoặc tạm thời quá tải), thử lại sau ít phút.'
  }
  return describeGraphError(error)
}

function permissionHint(source: ConversationSource): string {
  if (source.kind === 'chat') {
    return 'Với bot trong Teams: ứng dụng MeoBeo phải được cài vào nhóm chat này (quyền RSC ChatMessage.Read.Chat được cấp khi cài). Với trang web: tài khoản cần quyền Chat.Read và phải là thành viên của nhóm chat.'
  }
  if (source.kind === 'channel') {
    return 'Với bot trong Teams: ứng dụng MeoBeo phải được cài vào nhóm (team) chứa kênh này (quyền RSC ChannelMessage.Read.Group được cấp khi cài). Với trang web: cần quyền ChannelMessage.Read.All đã được quản trị viên đồng ý (admin consent) và bạn phải là thành viên của kênh.'
  }
  return ''
}

/** A string argument, trimmed; undefined when absent or empty. Throws (→ INVALID_ARGUMENTS) on anything else. */
function optionalText(raw: unknown, key: string, maxLength: number): string | undefined {
  const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new TypeError(`${key} is too long (max ${maxLength} characters).`)
  return trimmed === '' ? undefined : trimmed
}

function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter(signal => signal !== undefined))
}
