/**
 * Pure text helpers for the Teams bot: the progress line shown on the
 * placeholder message, edit throttling, size capping, and the help texts.
 * Group chats and channels do not support streaming, so progress is a single
 * line that the bot rewrites at most every few seconds.
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
  readonly finished: boolean
}

export interface ProgressState {
  readonly fetched?: number
  readonly stats?: TranscriptStats
  readonly agents: Readonly<Partial<Record<SpecialistKind, AgentProgress>>>
  /** Specialist tool calls by call id, so a tool-result can close the right agent. */
  readonly calls: Readonly<Record<string, SpecialistKind>>
  /** The coordinator has started writing the final answer. */
  readonly writing?: boolean
}

export const INITIAL_PROGRESS: ProgressState = { agents: {}, calls: {} }

/** Fold one wire event into the progress state; events that change nothing return the same object. */
export function reduceProgress(state: ProgressState, event: WireEvent): ProgressState {
  switch (event.t) {
    case 'fetch-progress':
      return { ...state, fetched: event.fetched }
    case 'transcript':
      return { ...state, stats: event.stats }
    case 'tool-call': {
      const agent = TOOL_AGENT[event.name]
      if (agent === undefined) return state
      const current = state.agents[agent]
      return {
        ...state,
        calls: { ...state.calls, [event.callId]: agent },
        agents: { ...state.agents, [agent]: { done: 0, total: 0, ...current, finished: false } },
      }
    }
    case 'agent-progress': {
      const current = state.agents[event.agent]
      return {
        ...state,
        agents: { ...state.agents, [event.agent]: { stage: event.stage, done: event.done, total: event.total, finished: current?.finished ?? false } },
      }
    }
    case 'text-delta':
      return state.writing === true ? state : { ...state, writing: true }
    case 'tool-result': {
      const agent = state.calls[event.callId]
      const current = agent === undefined ? undefined : state.agents[agent]
      if (agent === undefined || current === undefined) return state
      return { ...state, agents: { ...state.agents, [agent]: { ...current, finished: true } } }
    }
    default:
      return state
  }
}

/**
 * One line such as
 * "⏳ Đã đọc 340 tin nhắn (01/10 → 06/10) · Tóm tắt 3/8 phần · Việc cần làm 2/8 phần".
 */
export function progressText(state: ProgressState, timeZone: string): string {
  const parts: string[] = []
  const { stats } = state
  if (stats !== undefined) {
    parts.push(stats.messageCount === 0
      ? `Không có tin nhắn nào${rangeLabel(stats, timeZone)}`
      : `Đã đọc ${stats.messageCount} tin nhắn${rangeLabel(stats, timeZone)}`)
  } else if (state.fetched !== undefined) {
    parts.push(`Đang đọc tin nhắn… (đã tải ${state.fetched})`)
  } else {
    parts.push('MeoBeo đang đọc cuộc trò chuyện…')
  }
  for (const agent of AGENT_ORDER) {
    const progress = state.agents[agent]
    if (progress !== undefined) parts.push(agentLabel(agent, progress))
  }
  if (state.writing === true) parts.push('Đang viết câu trả lời…')
  return `⏳ ${parts.join(' · ')}`
}

function agentLabel(agent: SpecialistKind, progress: AgentProgress): string {
  const label = AGENT_LABEL[agent]
  if (progress.finished) return `${label} ✓`
  if (progress.stage === 'map' && progress.total > 0) return `${label} ${progress.done}/${progress.total} phần`
  if (progress.stage === 'reduce') return `${label}: đang tổng hợp`
  return `${label}…`
}

/** " (01/10 → 06/10)" in the reader's zone; `until` is exclusive, so a midnight end shows the day before. */
function rangeLabel(stats: TranscriptStats, timeZone: string): string {
  const since = Date.parse(stats.since)
  const until = Date.parse(stats.until)
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) return ''
  const from = dayMonth(since, timeZone)
  const to = dayMonth(until - 1, timeZone)
  return from === to ? ` (${from})` : ` (${from} → ${to})`
}

function dayMonth(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone)
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`
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

/** The final message: the answer plus a one-line note of what was read. */
export function finalText(answer: string, stats: TranscriptStats | undefined, timeZone: string): string {
  const footer = stats === undefined || stats.messageCount === 0
    ? ''
    : `\n\n_Dựa trên ${stats.messageCount} tin nhắn${rangeLabel(stats, timeZone)}${stats.truncated ? ', chưa đọc hết khoảng thời gian vì quá nhiều tin nhắn' : ''}._`
  return truncateForTeams(answer.trim(), MAX_REPLY_BYTES - new TextEncoder().encode(footer).length) + footer
}

export interface HelpOptions {
  readonly botName: string
  readonly maxLookbackDays: number
  readonly webUrl?: string | undefined
}

/** Reply in a 1:1 chat: RSC cannot read personal chats, so explain where MeoBeo works. */
export function personalHelpText({ botName, maxLookbackDays, webUrl }: HelpOptions): string {
  const lines = [
    `👋 Xin chào! Mình là **${botName}**, trợ lý tóm tắt cuộc trò chuyện Microsoft Teams.`,
    '',
    `**Cách dùng:** thêm ${botName} vào một group chat hoặc một nhóm (team) có kênh, rồi @nhắc tên mình kèm yêu cầu, ví dụ:`,
    `- \`@${botName} tóm tắt 3 ngày qua\``,
    `- \`@${botName} hôm qua có quyết định gì?\``,
    `- \`@${botName} ai đang phụ trách việc deploy?\``,
    '',
    `Mình chỉ đọc tin nhắn khi được @nhắc tên, trong khoảng thời gian bạn hỏi (tối đa ${maxLookbackDays} ngày gần nhất), và không lưu lại nội dung tin nhắn.`,
    '',
    'Trong cuộc trò chuyện riêng (1:1) này mình không đọc được lịch sử tin nhắn của các nhóm.',
  ]
  if (webUrl !== undefined) {
    lines.push(`Muốn tóm tắt một group chat hay kênh mà không cần thêm bot, hãy mở ứng dụng web: ${webUrl}`)
  }
  return lines.join('\n')
}

/** Reply to a bare @mention with no request. */
export function shortHelpText({ botName, maxLookbackDays }: HelpOptions): string {
  return [
    'Bạn muốn mình làm gì? Ví dụ:',
    `- \`@${botName} tóm tắt 24 giờ qua\``,
    `- \`@${botName} tuần này có việc gì cần làm?\``,
    `- \`@${botName} hôm qua có quyết định gì?\``,
    '',
    `Mình đọc được tối đa ${maxLookbackDays} ngày gần nhất.`,
  ].join('\n')
}

/** Posted when the app is added to a group chat or team. */
export function welcomeText({ botName, maxLookbackDays }: HelpOptions): string {
  return [
    `👋 Chào mọi người! Mình là **${botName}**, trợ lý tóm tắt cuộc trò chuyện.`,
    `@nhắc tên mình kèm yêu cầu, ví dụ \`@${botName} tóm tắt 3 ngày qua\` hoặc \`@${botName} ai đang phụ trách việc deploy?\`.`,
    `Mình chỉ đọc tin nhắn khi được nhắc tên, tối đa ${maxLookbackDays} ngày gần nhất, và không lưu lại nội dung.`,
  ].join('\n')
}

export function errorText(message: string): string {
  return `⚠️ ${message}`
}
