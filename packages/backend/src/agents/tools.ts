/**
 * Coordinator tools. They close over the CURRENT TurnContext, which the host
 * rebinds before every turn — so the model can choose WHEN (the time window)
 * and WHAT (focus / question) but never WHERE (which chat) or WITH WHAT
 * CREDENTIALS. Message content never enters the coordinator's history:
 * load_messages returns statistics only; specialists read the transcript from
 * RAM by id.
 *
 * - load_messages { period?, date?, month?, week?, amount?, unit?, since?, until? }
 *     A structured period (see PeriodInput in range.ts) resolved on the server
 *     in the user's zone — the model does no date arithmetic.
 *     → one window: TranscriptStats JSON (transcriptId, label, counts,
 *       participants, truncated/scanLimited/clamped, notes);
 *     → a period longer than maxRangeDays: { label, split: true, segments:
 *       [TranscriptStats per calendar-month segment], hint }, the segments
 *       loaded one after another, sharing a time budget (scanBudgetMs) so a
 *       slow scan ends partial (scanLimited) instead of failing on the timeout;
 *     → or a Vietnamese error the model can correct.
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
 * Failures the model can act on come back as `{ error }` results (or, for
 * malformed arguments, as a thrown Vietnamese message), not crashes; only
 * cancellation propagates.
 */

import { defineTool, type JsonValue, type ToolDefinition, type ToolRunContext } from '@alvin0/ai-agent-sdk-core'
import type { AppConfig } from '../config.ts'
import { GraphError, describeGraphError } from '../graph/client.ts'
import { buildTranscript, sourceKey, transcriptStats } from '../transcript/build.ts'
import type { TranscriptCache } from '../transcript/cache.ts'
import { MAX_SEGMENTS, resolvePeriod, toZonedIso, type PeriodInput, type PeriodKind, type PeriodUnit } from '../transcript/range.ts'
import type { ConversationSource, ResolvedRange, SpecialistKind, Transcript, TranscriptStats, TurnContext } from '../types.ts'
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
  /**
   * Longest wall-clock time one of these tools may run. The SDK cuts every tool
   * call at its turn-level `maxToolDurationMs` (10 min by default) whatever the
   * tool's own timeout, so the session must raise that limit to this value.
   */
  readonly maxToolDurationMs: number
  /** Drop this turn's transcript references (call when a turn ends). */
  endTurn(): void
}

interface SpecialistArgs {
  readonly transcriptId: string
  readonly focus?: string
  readonly question?: string
}

const SPECIALIST_TIMEOUT_MS = 10 * 60_000
/** Budget per Graph page: the client's ~1.2 s pacing plus latency. */
const PAGE_BUDGET_MS = 1_500
const MIN_SCAN_BUDGET_MS = 5 * 60_000
const MAX_SCAN_BUDGET_MS = 2 * 60 * 60_000
/**
 * Room after the scan deadline: the page in flight may still wait out 429s
 * (up to 4 retries × 60 s Retry-After), then the transcript is normalized.
 */
const LOAD_GRACE_MS = 5 * 60_000
/** Ids this session may still refer to; older ones have long expired from the cache anyway. */
const MAX_KNOWN_IDS = 50

const NO_TURN = 'Không có lượt hội thoại nào đang chạy; không thể đọc tin nhắn lúc này.'
const SPLIT_HINT = 'Gọi summarize_messages / extract_action_items cho TỪNG transcriptId (song song trong cùng một bước), rồi gộp theo từng đoạn.'

const PERIODS: readonly PeriodKind[] = ['day', 'week_of_month', 'week_containing', 'month', 'last', 'range']
const UNITS: readonly PeriodUnit[] = ['hour', 'day', 'week', 'month']
const LOAD_FIELDS = ['period', 'date', 'month', 'week', 'amount', 'unit', 'since', 'until'] as const
type LoadField = (typeof LOAD_FIELDS)[number]
/** The parameters each period takes; any other one is a misunderstanding worth reporting. */
const PERIOD_FIELDS: Readonly<Record<PeriodKind, readonly LoadField[]>> = {
  day: ['date'],
  week_containing: ['date'],
  week_of_month: ['month', 'week'],
  month: ['month'],
  last: ['amount', 'unit'],
  range: ['since', 'until'],
}
const PERIOD_EXAMPLE = 'Ví dụ { "period": "day", "date": "2026-09-06" } hoặc { "period": "month", "month": "2026-08" }.'

/**
 * How long the reads of one load_messages call may scan: every segment of the
 * longest accepted period may page through maxScanPages. With the defaults
 * (92 days → up to 5 month segments, 200 pages, ~1.5 s a page) that is 25
 * minutes. Past it no page is requested and the read ends scanLimited.
 */
export function scanBudgetMs(limits: AppConfig['limits']): number {
  const segments = Math.min(MAX_SEGMENTS, Math.ceil(limits.maxPeriodDays / Math.min(28, limits.maxRangeDays)) + 1)
  const budget = segments * limits.maxScanPages * PAGE_BUDGET_MS
  return Math.min(MAX_SCAN_BUDGET_MS, Math.max(MIN_SCAN_BUDGET_MS, budget))
}

/** The tool's hard timeout: the scan budget plus room to finish the last page (30 minutes by default). */
export function loadTimeoutMs(limits: AppConfig['limits']): number {
  return scanBudgetMs(limits) + LOAD_GRACE_MS
}

export function createCoordinatorToolkit(deps: CoordinatorToolDeps): CoordinatorToolkit {
  const { limits } = deps
  const scope = deps.cacheScope ?? `anon-${crypto.randomUUID()}`
  const scanBudget = scanBudgetMs(limits)
  const loadTimeout = loadTimeoutMs(limits)
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

  /** Fetch (or reuse from the RAM cache) one window and report its statistics. */
  const loadWindow = async (
    turn: TurnContext, range: ResolvedRange, signal: AbortSignal, deadline: number, segmentLabel?: string,
  ): Promise<TranscriptStats> => {
    // Calendar periods resolve to the same bounds every time, so follow-ups hit the cache.
    const key = [scope, sourceKey(turn.source), range.since, range.until].join('|')
    const transcript = await deps.cache.load(key, () => buildTranscript({ ...turn, signal }, range, {
      maxMessages: limits.maxMessages,
      chunkTokens: limits.chunkTokens,
      maxScanPages: limits.maxScanPages,
      deadline,
      ...(segmentLabel === undefined ? {} : { segmentLabel }),
    }))
    remember(transcript)
    // A cached transcript may have been loaded under another name for the same bounds.
    const stats: TranscriptStats = { ...transcriptStats(transcript), label: range.label }
    turn.onProgress?.({ kind: 'transcript', stats })
    return stats
  }

  const load = defineTool<PeriodInput>({
    name: TOOL_NAMES.load,
    description: [
      'Fetch the messages of the Teams conversation bound to this chat (you cannot choose another one) for a time window and keep them in server memory.',
      'Name the window with a structured period; the server computes the exact bounds in the user\'s time zone and returns a Vietnamese `label` of the window, which you repeat to the user. Never compute timestamps yourself.',
      'Vietnamese dates are dd/MM ("6/9" = 6 September). When the user gives no year, OMIT it ("MM-DD", "MM"): the server picks the most recent past occurrence, so you never work out the year. Examples (today = Tuesday 2026-10-06):',
      '"hôm nay" → {"period":"day","date":"2026-10-06"}; "hôm qua" → {"period":"day","date":"2026-10-05"}; "ngày 6/9" → {"period":"day","date":"09-06"}; "ngày 6/11" → {"period":"day","date":"11-06"} (= 06/11/2025); "ngày 6/9/2025" → {"period":"day","date":"2025-09-06"};',
      '"tuần này" → {"period":"week_containing","date":"2026-10-06"}; "tuần trước" → {"period":"week_containing","date":"2026-09-29"};',
      '"tuần thứ 2 tháng 8" → {"period":"week_of_month","month":"08","week":2} (ISO rule: Monday–Sunday weeks, week 1 = the week containing the month\'s first Thursday, so 10–16/08/2026);',
      '"tháng 8" → {"period":"month","month":"08"}; "tháng trước" → {"period":"month","month":"2026-09"};',
      '"3 ngày qua" → {"period":"last","amount":3,"unit":"day"};',
      '"quý 3" → {"period":"range","since":"2026-07-01","until":"2026-10-01"}; "từ 1/8 đến 15/8" → {"period":"range","since":"2026-08-01","until":"2026-08-16"} (until is EXCLUSIVE; a date alone is the start of that day; add a time such as "2026-10-06T08:00" for parts of a day).',
      `No parameters: the last ${limits.defaultLookbackHours} hours (the default).`,
      `Any date in the past can be read — there is no lookback limit. One window covers at most ${limits.maxRangeDays} days; a longer period, up to ${limits.maxPeriodDays} days, is split automatically into calendar-month segments read one after another (this takes longer), and the result is { label, split: true, segments: [statistics per segment] }. A period longer than ${limits.maxPeriodDays} days is refused with an error: then propose narrower periods.`,
      'Returns statistics only — transcriptId, label, messageCount, participants, since/until, firstMessageAt/lastMessageAt, truncated, scanLimited, clamped, notes — never message text.',
      'Pass each transcriptId to summarize_messages, extract_action_items or answer_question.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: [...PERIODS],
          description: 'Kind of window. Omit (with no other parameter) for the default window; with only since/until it means "range".',
        },
        date: { type: 'string', description: 'For day / week_containing: "YYYY-MM-DD" in the user\'s calendar, or "MM-DD" when the user gave no year (the server picks the latest past one).' },
        month: { type: 'string', description: 'For month / week_of_month: "YYYY-MM", or "MM" when the user gave no year (the server picks the latest month that has started).' },
        week: { type: 'integer', description: 'For week_of_month: the ISO week number within the month, 1–5.' },
        amount: { type: 'integer', description: 'For last: how many units back from now (a positive integer).' },
        unit: { type: 'string', enum: [...UNITS], description: 'For last: the unit of amount.' },
        since: { type: 'string', description: 'For range: start (inclusive), ISO 8601, e.g. "2026-08-01" or "2026-10-06T08:00"; zone-less values are in the user\'s zone.' },
        until: { type: 'string', description: 'For range: end (EXCLUSIVE), same format; omit to read up to now. "Only 5 October" is since "2026-10-05", until "2026-10-06".' },
      },
      required: [],
      additionalProperties: false,
    },
    parse: parseLoadArgs,
    timeoutMs: loadTimeout,
    async execute(args, ctx): Promise<JsonValue> {
      const turn = deps.currentTurn()
      if (turn === undefined) return { error: NO_TURN }
      const resolved = resolvePeriod(args, {
        now: turn.now,
        timeZone: turn.timeZone,
        maxRangeDays: limits.maxRangeDays,
        maxPeriodDays: limits.maxPeriodDays,
        defaultLookbackHours: limits.defaultLookbackHours,
      })
      if (!resolved.ok) return { error: resolved.error }

      const { range, segments } = resolved
      const split = segments.length > 1
      const signal = anySignal(turn.signal, ctx.signal)
      const loaded: TranscriptStats[] = []
      const deadline = Date.now() + scanBudget
      // One segment at a time: Graph throttles per conversation, and every segment of a channel pages back from now.
      for (const [index, segment] of segments.entries()) {
        // An equal share of the time left, so one slow segment cannot starve the others.
        const share = (deadline - Date.now()) / (segments.length - index)
        try {
          loaded.push(await loadWindow(turn, segment, signal, Date.now() + share, split ? segment.label : undefined))
        } catch (error) {
          if (signal.aborted) throw error
          const where = split ? ` (lỗi khi đọc đoạn ${loaded.length + 1}/${segments.length}: ${segment.label})` : ''
          return { error: `${describeLoadError(error, turn.source)}${where}` }
        }
      }
      const [only] = loaded
      if (!split && only !== undefined) return { ...only }

      const labels = loaded.map(stats => stats.label).join('; ')
      return {
        label: range.label,
        split: true,
        since: toZonedIso(range.since, turn.timeZone),
        until: toZonedIso(range.until, turn.timeZone),
        messageCount: loaded.reduce((sum, stats) => sum + stats.messageCount, 0),
        clamped: range.clamped,
        notes: [
          `${range.label} dài hơn ${limits.maxRangeDays} ngày nên đã được chia thành ${loaded.length} đoạn: ${labels}.`,
          ...range.notes,
        ],
        segments: loaded.map(stats => ({ ...stats })),
        hint: SPLIT_HINT,
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
        transcriptId: { type: 'string', description: 'The transcriptId returned by load_messages (one segment\'s id for a split period).' },
        ...(extra === undefined ? {} : { [extra.key]: { type: 'string', description: extra.description } }),
      },
      required: extra?.required === true ? ['transcriptId', extra.key] : ['transcriptId'],
      additionalProperties: false,
    },
    parse: raw => {
      const transcriptId = optionalText(raw, 'transcriptId', 64)
      if (transcriptId === undefined) throw new TypeError('Thiếu transcriptId: hãy gọi load_messages trước rồi truyền transcriptId mà nó trả về.')
      if (extra === undefined) return { transcriptId }
      const value = optionalText(raw, extra.key, 1_000)
      if (value === undefined && extra.required) throw new TypeError(`Thiếu ${extra.key}.`)
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
          callId: ctx.callId,
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
      'Summarize the loaded messages (overview, main topics, decisions, open questions) with #n citations. Runs a specialist agent over the whole transcript; call it in the same step as extract_action_items for a general summary (for a split period: for every segment, all in one step).',
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
    maxToolDurationMs: Math.max(loadTimeout, SPECIALIST_TIMEOUT_MS),
    endTurn() {
      current.clear()
    },
  }
}

/**
 * Strict parse of load_messages arguments: known fields only, the right types
 * (integers may arrive as numeric strings), and only the fields the chosen
 * period takes. Throws a Vietnamese message the model can act on.
 */
export function parseLoadArgs(raw: unknown): PeriodInput {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`Tham số phải là một object JSON. ${PERIOD_EXAMPLE}`)
  const record = raw as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !(LOAD_FIELDS as readonly string[]).includes(key) && record[key] !== undefined && record[key] !== null)
  if (unknown.length > 0) throw new TypeError(`Tham số không hợp lệ: ${unknown.join(', ')}. Chỉ dùng: ${LOAD_FIELDS.join(', ')}.`)

  const args: PeriodInput = {
    period: choice(record, 'period', PERIODS),
    date: optionalText(record, 'date', 32),
    month: optionalText(record, 'month', 32),
    week: optionalInt(record, 'week', 5, 'Ví dụ { "period": "week_of_month", "month": "2026-08", "week": 2 }.'),
    amount: optionalInt(record, 'amount', Number.MAX_SAFE_INTEGER, 'Ví dụ { "period": "last", "amount": 3, "unit": "day" }; với khoảng lẻ hãy dùng đơn vị nhỏ hơn (36 giờ thay vì 1,5 ngày).'),
    unit: choice(record, 'unit', UNITS),
    since: optionalText(record, 'since', 64),
    until: optionalText(record, 'until', 64),
  }
  const given = LOAD_FIELDS.filter(key => key !== 'period' && args[key] !== undefined)
  const { period } = args
  if (period === undefined) {
    const stray = given.filter(key => key !== 'since' && key !== 'until')
    if (stray.length > 0) throw new TypeError(`Thiếu "period" cho ${stray.join(', ')}. ${PERIOD_EXAMPLE}`)
  } else {
    const allowed = PERIOD_FIELDS[period]
    const stray = given.filter(key => !allowed.includes(key))
    if (stray.length > 0) throw new TypeError(`period "${period}" chỉ dùng ${allowed.join(', ')}; hãy bỏ ${stray.join(', ')}.`)
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as PeriodInput
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

function field(raw: unknown, key: string): unknown {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
}

/** A string argument, trimmed; undefined when absent or empty. Throws (→ INVALID_ARGUMENTS) on anything else. */
function optionalText(raw: unknown, key: string, maxLength: number): string | undefined {
  const value = field(raw, key)
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} phải là chuỗi (nhận được ${JSON.stringify(value)}).`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new TypeError(`${key} quá dài (tối đa ${maxLength} ký tự).`)
  return trimmed === '' ? undefined : trimmed
}

/** One of `allowed` (case-insensitive); undefined when absent. */
function choice<const T extends string>(raw: unknown, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalText(raw, key, 32)
  if (value === undefined) return undefined
  const match = allowed.find(option => option === value.toLowerCase())
  if (match === undefined) throw new TypeError(`${key} "${value}" không hợp lệ; chỉ dùng một trong: ${allowed.join(', ')}.`)
  return match
}

/** A positive integer up to `max`; numeric strings ("2") are accepted, fractions and words are not. */
function optionalInt(raw: unknown, key: string, max: number, hint: string): number | undefined {
  const value = field(raw, key)
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(number) || number < 1 || number > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? 'số nguyên dương' : `số nguyên từ 1 đến ${max}`
    throw new TypeError(`${key} phải là ${range} (nhận được ${JSON.stringify(value)}). ${hint}`)
  }
  return number
}

function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter(signal => signal !== undefined))
}
