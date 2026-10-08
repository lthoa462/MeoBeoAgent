/**
 * Pure text helpers for the Teams bot: the progress line shown on the
 * placeholder message, edit throttling, size capping, and the help texts.
 * Group chats and channels do not support streaming, so progress is a single
 * line that the bot rewrites at most every few seconds.
 *
 * A long period is read month by month, so one turn may hold several reads
 * and transcripts: the line lists each segment, the footer sums them.
 */

import { TOOL_NAMES } from '../agents/tools.ts'
import { zonedParts } from '../transcript/range.ts'
import type { SpecialistKind, TranscriptStats } from '../types.ts'
import type { WireEvent } from '../wire.ts'

export const PLACEHOLDER_TEXT = '⏳ MeoBeo đang đọc cuộc trò chuyện…'
export const BUSY_TEXT = 'Mình đang xử lý yêu cầu trước trong cuộc trò chuyện này, đợi chút nhé.'
export const MISSING_APP_CREDENTIALS_TEXT =
  'MeoBeo chưa được cấu hình đầy đủ (thiếu CLIENT_ID/CLIENT_SECRET) nên chưa đọc được tin nhắn. Hãy báo quản trị viên.'
export const UNSUPPORTED_TEXT = 'MeoBeo chỉ tóm tắt được group chat và kênh (channel) của Microsoft Teams.'
export const NO_TENANT_TEXT = 'Không xác định được tổ chức (tenant) của cuộc trò chuyện này nên chưa đọc được tin nhắn.'
export const FOREIGN_TENANT_TEXT = 'MeoBeo chỉ đọc được cuộc trò chuyện của tổ chức (tenant) đã cài đặt nó.'
export const NO_TEAM_TEXT = 'Không xác định được nhóm (team) chứa kênh này; hãy thử lại sau ít phút.'
export const FAILED_TEXT = 'Xin lỗi, MeoBeo gặp lỗi khi xử lý yêu cầu này. Hãy thử lại sau.'

/** Minimum gap between two edits of the placeholder. */
export const PROGRESS_EDIT_INTERVAL_MS = 3_000
/**
 * Teams rejects activities over ~28 KB (the whole payload, in bytes). Vietnamese
 * text is up to 3 bytes per character in UTF-8, so the cap is in bytes.
 */
export const MAX_REPLY_BYTES = 24_000
/** Nobody reads more than this in a chat bubble even when it is all ASCII. */
export const MAX_REPLY_CHARS = 25_000

const AGENT_LABEL: Readonly<Record<SpecialistKind, string>> = {
  summarizer: 'Tóm tắt',
  'action-tracker': 'Việc cần làm',
  qa: 'Trả lời câu hỏi',
}
const AGENT_ORDER: readonly SpecialistKind[] = ['summarizer', 'action-tracker', 'qa']
const TOOL_AGENT: Readonly<Record<string, SpecialistKind>> = {
  [TOOL_NAMES.summarize]: 'summarizer',
  [TOOL_NAMES.actions]: 'action-tracker',
  [TOOL_NAMES.ask]: 'qa',
}

interface AgentProgress {
  readonly stage?: 'map' | 'reduce' | 'single'
  readonly done: number
  readonly total: number
}

/** A read in flight; `segment` is set while a long period is read month by month. */
interface Reading {
  readonly segment: string | undefined
  readonly fetched: number
  /** ISO time the scan has reached (channels page back from now). */
  readonly scannedBackTo?: string
}

export interface ProgressState {
  /** Reads in flight, one per segment (one without a segment for a plain window). */
  readonly reading: readonly Reading[]
  /** load_messages calls still running; when none is left, no read is in flight. */
  readonly loads: number
  /** Transcripts loaded this turn in arrival order, one per transcriptId (a split period has several). */
  readonly transcripts: readonly TranscriptStats[]
  /** A read named its segment: list transcripts per segment, even before the second one arrives. */
  readonly split?: boolean
  /** Latest map/reduce progress per specialist (parallel calls of one specialist share it). */
  readonly agents: Readonly<Partial<Record<SpecialistKind, AgentProgress>>>
  /** Specialist tool calls by call id, so a tool-result can close the right one. */
  readonly calls: Readonly<Record<string, { readonly agent: SpecialistKind; readonly finished: boolean }>>
  /** The coordinator has started writing the final answer. */
  readonly writing?: boolean
}

export const INITIAL_PROGRESS: ProgressState = { reading: [], loads: 0, transcripts: [], agents: {}, calls: {} }

/** More segments than this are summed up instead of listed one by one. */
const MAX_LISTED_SEGMENTS = 4
/** Shown while a split period is being read: Teams users see no commentary, only this line. */
export const SPLIT_SLOW_HINT = 'Khoảng dài được đọc lần lượt từng phần nên sẽ lâu hơn'

/** Fold one wire event into the progress state; events that change nothing return the same object. */
export function reduceProgress(state: ProgressState, event: WireEvent): ProgressState {
  switch (event.t) {
    case 'fetch-progress': {
      const next: Reading = {
        segment: event.segment,
        fetched: event.fetched,
        ...(event.scannedBackTo === undefined ? {} : { scannedBackTo: event.scannedBackTo }),
      }
      const index = state.reading.findIndex(reading => reading.segment === event.segment)
      return {
        ...state,
        ...(event.segment === undefined ? {} : { split: true }),
        reading: index === -1 ? [...state.reading, next] : state.reading.map((reading, at) => at === index ? next : reading),
      }
    }
    case 'transcript': {
      const { stats } = event
      // The read this transcript ends: its segment, else the plain (unsegmented) read.
      const own = state.reading.findIndex(reading => reading.segment === stats.label)
      const done = own === -1 ? state.reading.findIndex(reading => reading.segment === undefined) : own
      const known = state.transcripts.findIndex(item => item.transcriptId === stats.transcriptId)
      return {
        ...state,
        reading: done === -1 ? state.reading : state.reading.filter((_reading, at) => at !== done),
        transcripts: known === -1 ? [...state.transcripts, stats] : state.transcripts.map((item, at) => at === known ? stats : item),
      }
    }
    case 'tool-call': {
      if (event.name === TOOL_NAMES.load) return { ...state, loads: state.loads + 1 }
      const agent = TOOL_AGENT[event.name]
      if (agent === undefined) return state
      return {
        ...state,
        calls: { ...state.calls, [event.callId]: { agent, finished: false } },
        agents: { ...state.agents, [agent]: state.agents[agent] ?? { done: 0, total: 0 } },
      }
    }
    case 'agent-progress':
      return { ...state, agents: { ...state.agents, [event.agent]: { stage: event.stage, done: event.done, total: event.total } } }
    case 'text-delta':
      return state.writing === true ? state : { ...state, writing: true }
    case 'tool-result': {
      if (event.name === TOOL_NAMES.load) {
        const loads = Math.max(0, state.loads - 1)
        // A failed read sends no transcript: once no load is running, nothing is being read.
        return { ...state, loads, reading: loads === 0 ? [] : state.reading }
      }
      const call = Object.hasOwn(state.calls, event.callId) ? state.calls[event.callId] : undefined
      if (call === undefined || call.finished) return state
      return { ...state, calls: { ...state.calls, [event.callId]: { ...call, finished: true } } }
    }
    default:
      return state
  }
}

/**
 * One line such as
 * "⏳ Đã đọc 340 tin nhắn — Tháng 9/2026 · Tóm tắt 3/8 phần · Việc cần làm 2/8 phần", or for a
 * split period "⏳ Tháng 7/2026 ✓ 340 tin · Đang đọc Tháng 8/2026… (đã tải 150 · đang quét tới 20/08) ·
 * Khoảng dài được đọc lần lượt từng phần nên sẽ lâu hơn".
 */
export function progressText(state: ProgressState, timeZone: string): string {
  const parts = readParts(state, timeZone)
  if (parts.length === 0) parts.push('MeoBeo đang đọc cuộc trò chuyện…')
  for (const agent of AGENT_ORDER) {
    const label = agentLabel(agent, state)
    if (label !== undefined) parts.push(label)
  }
  if (state.writing === true) parts.push('Đang viết câu trả lời…')
  return `⏳ ${parts.join(' · ')}`
}

function readParts(state: ProgressState, timeZone: string): string[] {
  const { transcripts, reading } = state
  const split = state.split === true || transcripts.length > 1
  const parts: string[] = []
  const [only] = transcripts
  if (!split && only !== undefined) {
    // A dash, not parentheses: labels often end in their own "(…)".
    parts.push(`${only.messageCount === 0 ? 'Không có tin nhắn nào' : `Đã đọc ${only.messageCount} tin nhắn`} — ${windowLabel(only, timeZone)}`)
  } else if (transcripts.length > MAX_LISTED_SEGMENTS) {
    parts.push(`Đã đọc ${totalMessages(transcripts)} tin nhắn từ ${transcripts.length} khoảng`)
  } else {
    for (const stats of chronological(transcripts)) parts.push(`${windowLabel(stats, timeZone)} ✓ ${stats.messageCount} tin`)
  }
  for (const item of reading) {
    const scanned = scannedLabel(item.scannedBackTo, timeZone)
    const detail = `(đã tải ${item.fetched}${scanned === undefined ? '' : ` · đang quét tới ${scanned}`})`
    parts.push(item.segment === undefined ? `Đang đọc tin nhắn… ${detail}` : `Đang đọc ${item.segment}… ${detail}`)
  }
  if (split && reading.length > 0) parts.push(SPLIT_SLOW_HINT)
  return parts
}

function agentLabel(agent: SpecialistKind, state: ProgressState): string | undefined {
  const label = AGENT_LABEL[agent]
  const calls = Object.values(state.calls).filter(call => call.agent === agent)
  const finished = calls.filter(call => call.finished).length
  if (calls.length > 0 && finished === calls.length) return `${label} ✓`
  // Parallel calls (one per segment of a split period) interleave their progress: count calls instead.
  if (calls.length > 1) return `${label}: xong ${finished}/${calls.length}`
  const progress = state.agents[agent]
  if (progress === undefined) return undefined
  if (progress.stage === 'map' && progress.total > 0) return `${label} ${progress.done}/${progress.total} phần`
  if (progress.stage === 'reduce') return `${label}: đang tổng hợp`
  return `${label}…`
}

/** The server's label of the window, or its bounds when a stats object carries none. */
function windowLabel(stats: TranscriptStats, timeZone: string): string {
  return stats.label.trim() !== '' ? stats.label : dateSpan(stats, timeZone)
}

/** "01/10 → 06/10" in the reader's zone; `until` is exclusive, so a midnight end shows the day before. */
function dateSpan(stats: TranscriptStats, timeZone: string): string {
  const since = Date.parse(stats.since)
  const until = Date.parse(stats.until)
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) return '?'
  const from = dayMonth(since, timeZone)
  const to = dayMonth(until - 1, timeZone)
  return from === to ? from : `${from} → ${to}`
}

function scannedLabel(iso: string | undefined, timeZone: string): string | undefined {
  const epochMs = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isFinite(epochMs) ? dayMonth(epochMs, timeZone) : undefined
}

function dayMonth(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone)
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`
}

function chronological(transcripts: readonly TranscriptStats[]): TranscriptStats[] {
  return [...transcripts].sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0))
}

function totalMessages(transcripts: readonly TranscriptStats[]): number {
  return transcripts.reduce((sum, stats) => sum + stats.messageCount, 0)
}

export interface EditThrottle {
  /** True when `text` differs from the last shown text and the interval has passed. */
  ready(text: string): boolean
  /** Record that `text` is now shown. */
  shown(text: string): void
}

export function createEditThrottle(options: { readonly intervalMs?: number; readonly now?: () => number } = {}): EditThrottle {
  const intervalMs = options.intervalMs ?? PROGRESS_EDIT_INTERVAL_MS
  const now = options.now ?? Date.now
  let lastText: string | undefined
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    ready: text => text !== lastText && now() - lastAt >= intervalMs,
    shown(text) {
      lastText = text
      lastAt = now()
    },
  }
}

const TRUNCATED_NOTE = '\n\n… _(Câu trả lời quá dài nên đã được rút gọn.)_'

/** Cap a reply for a Teams message, cutting at a line break when one is near the limit. */
export function truncateForTeams(text: string, maxBytes = MAX_REPLY_BYTES, maxChars = MAX_REPLY_CHARS): string {
  const encoder = new TextEncoder()
  if (text.length <= maxChars && encoder.encode(text).length <= maxBytes) return text
  const budgetBytes = maxBytes - encoder.encode(TRUNCATED_NOTE).length
  const budgetChars = maxChars - TRUNCATED_NOTE.length
  // Code points, not UTF-16 units, so a surrogate pair is never split.
  let bytes = 0
  let cut = ''
  for (const char of text) {
    const size = encoder.encode(char).length
    if (bytes + size > budgetBytes || cut.length + char.length > budgetChars) break
    bytes += size
    cut += char
  }
  const lineBreak = cut.lastIndexOf('\n')
  if (lineBreak > cut.length * 0.8) cut = cut.slice(0, lineBreak)
  return cut.trimEnd() + TRUNCATED_NOTE
}

/**
 * The final message: the answer plus a one-line note of what was read, e.g.
 * "Dựa trên 340 tin nhắn — Tháng 9/2026" or, for a split period,
 * "Dựa trên 1020 tin nhắn — Tháng 7/2026: 340 · Tháng 8/2026: 500 · Tháng 9/2026: 180".
 */
export function finalText(answer: string, transcripts: readonly TranscriptStats[], timeZone: string): string {
  const footer = readFooter(transcripts, timeZone)
  return truncateForTeams(withoutRemoteImages(answer.trim()), MAX_REPLY_BYTES - new TextEncoder().encode(footer).length) + footer
}

/** HTML elements Teams could fetch while rendering a message. */
const RESOURCE_TAG = /<\/?\s*(?:img|image|picture|source|video|audio|iframe|frame|embed|object|link|svg|style|input|meta|base)\b[^>]*(?:>|$)/gim

/**
 * The answer is derived from untrusted chat content, and Teams renders Markdown
 * and some HTML: an injected image URL would be fetched by every reader's client
 * the moment the reply is shown (a beacon that can carry stolen text). As on the
 * web, images become plain links (`![a](u)` → `[a](u)`, opened only on a click)
 * and resource-loading tags are dropped.
 */
export function withoutRemoteImages(text: string): string {
  return text.replace(/!\[/g, '[').replace(RESOURCE_TAG, '')
}

function readFooter(transcripts: readonly TranscriptStats[], timeZone: string): string {
  const total = totalMessages(transcripts)
  if (total === 0) return ''
  const ordered = chronological(transcripts)
  const first = ordered[0]
  const last = ordered.at(-1)
  if (first === undefined || last === undefined) return ''
  const single = ordered.length === 1
  const what = single
    ? windowLabel(first, timeZone)
    : ordered.length > MAX_LISTED_SEGMENTS
      ? `${ordered.length} khoảng, ${windowLabel(first, timeZone)} → ${windowLabel(last, timeZone)}`
      : ordered.map(stats => `${windowLabel(stats, timeZone)}: ${stats.messageCount}`).join(' · ')
  // Which windows were not read to their start, by reason; a single window is "khoảng thời gian".
  const names = (items: readonly TranscriptStats[]): string => single ? 'khoảng thời gian' : items.map(stats => windowLabel(stats, timeZone)).join(', ')
  const scanLimited = ordered.filter(stats => stats.scanLimited)
  const cut = ordered.filter(stats => stats.truncated && !stats.scanLimited)
  const gaps = [
    ...(cut.length === 0 ? [] : [`chưa đọc hết ${names(cut)} vì quá nhiều tin nhắn`]),
    ...(scanLimited.length === 0 ? [] : [`chưa quét tới đầu ${names(scanLimited)} (chạm giới hạn quét)`]),
  ]
  return `\n\n_Dựa trên ${total} tin nhắn — ${what}${gaps.map(gap => `; ${gap}`).join('')}._`
}

export interface HelpOptions {
  readonly botName: string
  /** Longest single read (MAX_RANGE_DAYS). */
  readonly maxRangeDays: number
  /** Longest period, split per month (MAX_PERIOD_DAYS). */
  readonly maxPeriodDays: number
  readonly webUrl?: string | undefined
}

/** What can be read: any past date, one window per read, longer periods split per month. */
function readingRules({ maxRangeDays, maxPeriodDays }: HelpOptions): string {
  const split = maxPeriodDays > maxRangeDays
    ? `; khoảng dài hơn (tối đa ${maxPeriodDays} ngày) được chia theo từng tháng, đọc và tóm tắt từng phần rồi gộp lại nên sẽ lâu hơn`
    : ''
  return 'Mình đọc được bất kỳ ngày, tuần hay tháng nào trong quá khứ (ngày viết theo kiểu ngày/tháng: 6/9 là ngày 6 tháng 9; ' +
    `tuần tính từ Thứ Hai đến Chủ Nhật). Mỗi lần đọc tối đa ${maxRangeDays} ngày${split}.`
}

/** Example requests; the quarter only when a quarter fits in MAX_PERIOD_DAYS. */
function examples(options: HelpOptions, first: string): string[] {
  const { botName, maxPeriodDays } = options
  return [
    first,
    'tóm tắt ngày 6/9',
    'tuần thứ 2 tháng 8 có quyết định gì?',
    ...(maxPeriodDays >= 92 ? ['tóm tắt quý 3'] : []),
  ].map(example => `- \`@${botName} ${example}\``)
}

/** Reply in a 1:1 chat: RSC cannot read personal chats, so explain where MeoBeo works. */
export function personalHelpText(options: HelpOptions): string {
  const { botName, webUrl } = options
  const lines = [
    `👋 Xin chào! Mình là **${botName}**, trợ lý tóm tắt cuộc trò chuyện Microsoft Teams.`,
    '',
    `**Cách dùng:** thêm ${botName} vào một group chat hoặc một nhóm (team) có kênh, rồi @nhắc tên mình kèm yêu cầu, ví dụ:`,
    ...examples(options, 'tóm tắt 3 ngày qua'),
    `- \`@${botName} ai đang phụ trách việc deploy?\``,
    '',
    readingRules(options),
    'Mình chỉ đọc tin nhắn khi được @nhắc tên, đúng khoảng thời gian bạn hỏi, và không lưu lại nội dung tin nhắn.',
    '',
    'Trong cuộc trò chuyện riêng (1:1) này mình không đọc được lịch sử tin nhắn của các nhóm.',
  ]
  if (webUrl !== undefined) {
    lines.push(`Muốn tóm tắt một group chat hay kênh mà không cần thêm bot, hãy mở ứng dụng web: ${webUrl}`)
  }
  return lines.join('\n')
}

/** Reply to a bare @mention with no request. */
export function shortHelpText(options: HelpOptions): string {
  return [
    'Bạn muốn mình làm gì? Ví dụ:',
    ...examples(options, 'tóm tắt 24 giờ qua'),
    `- \`@${options.botName} tuần này có việc gì cần làm?\``,
    '',
    readingRules(options),
  ].join('\n')
}

/** Posted when the app is added to a group chat or team. */
export function welcomeText(options: HelpOptions): string {
  const { botName } = options
  return [
    `👋 Chào mọi người! Mình là **${botName}**, trợ lý tóm tắt cuộc trò chuyện.`,
    `@nhắc tên mình kèm yêu cầu, ví dụ \`@${botName} tóm tắt hôm qua\`, \`@${botName} tóm tắt ngày 6/9\` hoặc \`@${botName} tuần thứ 2 tháng 8 có quyết định gì?\`.`,
    readingRules(options),
    'Mình chỉ đọc tin nhắn khi được nhắc tên và không lưu lại nội dung.',
  ].join('\n')
}

export function errorText(message: string): string {
  return `⚠️ ${message}`
}
