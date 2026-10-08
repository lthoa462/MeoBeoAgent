/** Vietnamese labels and browser-zone formatting for the chat view. */

import type { SpecialistKind, TranscriptStats } from '@meobeo/backend/wire'

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  load_messages: 'Đọc tin nhắn',
  summarize_messages: 'Agent tóm tắt',
  extract_action_items: 'Agent việc cần làm',
  answer_question: 'Agent hỏi đáp',
}

export const AGENT_LABELS: Readonly<Record<SpecialistKind, string>> = {
  summarizer: 'Agent tóm tắt',
  'action-tracker': 'Agent việc cần làm',
  qa: 'Agent hỏi đáp',
}

const numberFormat = new Intl.NumberFormat('vi-VN')

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

const dateTimeParts = new Intl.DateTimeFormat('vi-VN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/**
 * "03/10 09:30" in the browser's zone (same shape as the transcript lines the
 * agents cite), with the year only when it is not this year.
 */
export function formatDateTime(value: string | number): string | undefined {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const parts = dateTimeParts.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? ''
  const year = part('year')
  const day = `${part('day')}/${part('month')}${year === String(new Date().getFullYear()) ? '' : `/${year}`}`
  return `${day} ${part('hour')}:${part('minute')}`
}

/** "20/09" in the browser's zone ("20/09/2025" when not this year). */
export function formatDay(value: string | number): string | undefined {
  return formatDateTime(value)?.split(' ')[0]
}

export function formatRange(since: string | undefined, until: string | undefined): string | undefined {
  const from = since === undefined ? undefined : formatDateTime(since)
  const to = until === undefined ? undefined : formatDateTime(until)
  if (from !== undefined && to !== undefined) return `${from} → ${to}`
  if (from !== undefined) return `từ ${from}`
  if (to !== undefined) return `đến ${to}`
  return undefined
}

/** Compact elapsed time for the process summary: "8s", "1m 05s", "1h 02m". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * One-line summary of a tool's arguments. The model chooses only the window
 * and the question; the source never appears here because the host binds it.
 */
export function describeToolInput(name: string, input: unknown): string | undefined {
  const field = (key: string): string | undefined => {
    if (input === null || typeof input !== 'object') return undefined
    const value: unknown = Reflect.get(input, key)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  switch (name) {
    case 'load_messages':
      return describePeriod(field, input)
    case 'summarize_messages': {
      const focus = field('focus')
      return focus === undefined ? undefined : `trọng tâm: ${clip(focus, 120)}`
    }
    case 'answer_question': {
      const question = field('question')
      return question === undefined ? undefined : `“${clip(question, 160)}”`
    }
    case 'extract_action_items':
      return undefined
    default: {
      if (input === undefined) return undefined
      try {
        return clip(JSON.stringify(input), 120)
      } catch {
        return undefined
      }
    }
  }
}

const UNIT_NAMES: Readonly<Record<string, string>> = { hour: 'giờ', day: 'ngày', week: 'tuần', month: 'tháng' }

/** The window load_messages was asked for, in words (the server's exact label arrives with the transcript). */
function describePeriod(field: (key: string) => string | undefined, input: unknown): string {
  const number = (key: string): number | undefined => {
    const value: unknown = input !== null && typeof input === 'object' ? Reflect.get(input, key) : undefined
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    return Number.isInteger(parsed) ? parsed : undefined
  }
  const date = field('date')
  const month = field('month')
  const week = number('week')
  const amount = number('amount')
  const unitKey = field('unit') ?? ''
  const unit = Object.hasOwn(UNIT_NAMES, unitKey) ? UNIT_NAMES[unitKey] : undefined
  switch (field('period')) {
    case 'day':
      if (date !== undefined) return `ngày ${isoDay(date)}`
      break
    case 'week_containing':
      if (date !== undefined) return `tuần chứa ngày ${isoDay(date)}`
      break
    case 'week_of_month':
      if (month !== undefined && week !== undefined) return `tuần ${String(week)} tháng ${isoMonth(month)}`
      break
    case 'month':
      if (month !== undefined) return `tháng ${isoMonth(month)}`
      break
    case 'last':
      if (amount !== undefined && unit !== undefined) return `${String(amount)} ${unit} qua`
      break
  }
  const since = field('since')
  const until = field('until')
  return wholeDays(since, until) ?? formatRange(localDate(since), localDate(until)) ?? 'khoảng thời gian mặc định'
}

/**
 * Bare dates name whole days, and `until` is exclusive: "2026-07-01" → "2026-10-01"
 * is "01/07 – 30/09/2026", as the server labels it (not "01/07 00:00 → 01/10 00:00").
 */
function wholeDays(since: string | undefined, until: string | undefined): string | undefined {
  const first = since === undefined ? undefined : inputDay(since)
  if (first === undefined) return undefined
  if (until === undefined) return `từ ${dayText(first)}`
  const end = inputDay(until)
  if (end === undefined || end <= first) return undefined
  const last = end - DAY_MS
  if (last === first) return `ngày ${dayText(first)}`
  const sameYear = new Date(first).getUTCFullYear() === new Date(last).getUTCFullYear()
  return `${sameYear ? dayText(first).slice(0, 5) : dayText(first)} – ${dayText(last)}`
}

/** A bare "YYYY-MM-DD" means local midnight to the server, but UTC midnight to Date.parse. */
function localDate(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00` : value
}

/** "2026-09-06" → "06/09/2026", "09-06" → "06/09"; anything else unchanged. */
function isoDay(value: string): string {
  const match = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/u.exec(value)
  if (match === null) return value
  const [, year, month = '', day = ''] = match
  return `${day.padStart(2, '0')}/${month.padStart(2, '0')}${year === undefined ? '' : `/${year}`}`
}

/** "2026-08" → "8/2026", "08" → "8"; anything else unchanged. */
function isoMonth(value: string): string {
  const match = /^(?:(\d{4})-)?(\d{1,2})$/u.exec(value)
  if (match === null) return value
  const [, year, month = ''] = match
  return `${String(Number(month))}${year === undefined ? '' : `/${year}`}`
}

/** The live line of one read: "Đang đọc Tháng 8/2026: 150 tin nhắn · đã quét tới 20/08". */
export function describeFetch(step: { readonly fetched: number; readonly scannedBackTo?: string; readonly segment?: string }, live: boolean): string {
  const count = `${formatNumber(step.fetched)} tin nhắn`
  const main = step.segment === undefined
    ? `Đã tải ${count}${live ? '…' : ''}`
    : `${live ? 'Đang đọc' : 'Đã tải'} ${step.segment}: ${count}`
  const reached = step.scannedBackTo === undefined ? undefined : formatDay(step.scannedBackTo)
  return reached === undefined ? main : `${main} · đã quét tới ${reached}`
}

/** All transcripts of a turn (a split period has one per segment), for one card. */
export interface TranscriptSummary {
  readonly messageCount: number
  /** Everyone who wrote in any segment, first appearance first. */
  readonly participants: readonly string[]
  /** Oldest window first. */
  readonly segments: readonly TranscriptStats[]
  /** Server notes, each once; prefixed with its window's label when there are several. */
  readonly notes: readonly string[]
}

export function summarizeTranscripts(list: readonly TranscriptStats[]): TranscriptSummary {
  const segments = [...list].sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0))
  const several = segments.length > 1
  return {
    messageCount: segments.reduce((sum, stats) => sum + stats.messageCount, 0),
    participants: [...new Set(segments.flatMap(stats => stats.participants))],
    segments,
    notes: [...new Set(segments.flatMap(stats => stats.notes.map(note => several ? `${windowLabel(stats)}: ${note}` : note)))],
  }
}

/** The server's label of a window, or its bounds when a (older) stats object has none. */
export function windowLabel(stats: TranscriptStats): string {
  const label = typeof stats.label === 'string' ? stats.label.trim() : ''
  return label !== '' ? label : formatRange(stats.since, stats.until) ?? '—'
}

// ---------------------------------------------------------------------------
// "📅 Chọn ngày/khoảng": native date inputs fill the composer with a request.

const DAY_MS = 86_400_000

/** Today as a native date input value ('YYYY-MM-DD') in the browser's zone. */
export function todayInputValue(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export interface PickedDates {
  /** The request to put in the composer, when the choice can be sent. */
  readonly prompt?: string
  /** Why it cannot be sent, or what to expect (a long period is read month by month). */
  readonly note?: string
}

/**
 * One date → "Tóm tắt ngày 06/09/2026"; two → "Tóm tắt từ 01/08/2026 đến 15/08/2026"
 * (in either order). Dates are dd/MM/yyyy, as the agents read them.
 */
export function pickDates(
  from: string,
  to: string,
  limits: { readonly today: string; readonly maxRangeDays: number; readonly maxPeriodDays: number },
): PickedDates {
  const days = [inputDay(from), inputDay(to)].filter((day): day is number => day !== undefined)
  if (days.length === 0) return {}
  const start = Math.min(...days)
  const end = Math.max(...days)
  const today = inputDay(limits.today) ?? Number.POSITIVE_INFINITY
  if (start > today) return { note: 'Chỉ đọc được tin nhắn trong quá khứ: hãy chọn ngày từ hôm nay trở về trước.' }
  const span = Math.round((end - start) / DAY_MS) + 1
  if (span > limits.maxPeriodDays) {
    return { note: `Khoảng này dài ${String(span)} ngày, vượt giới hạn ${String(limits.maxPeriodDays)} ngày cho một yêu cầu.` }
  }
  const prompt = start === end ? `Tóm tắt ngày ${dayText(start)}` : `Tóm tắt từ ${dayText(start)} đến ${dayText(end)}`
  if (span > limits.maxRangeDays) {
    return { prompt, note: `Dài ${String(span)} ngày: MeoBeo sẽ đọc và tóm tắt từng tháng rồi gộp lại, nên sẽ lâu hơn.` }
  }
  return end > today ? { prompt, note: 'Phần sau hôm nay chưa có tin nhắn: chỉ đọc tới hiện tại.' } : { prompt }
}

/** 'YYYY-MM-DD' → UTC midnight of that calendar day (only used for day arithmetic). */
function inputDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (match === null) return undefined
  const [, year, month, day] = match.map(Number)
  if (year === undefined || month === undefined || day === undefined) return undefined
  const time = Date.UTC(year, month - 1, day)
  return new Date(time).getUTCDate() === day ? time : undefined
}

function dayText(time: number): string {
  const date = new Date(time)
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${String(date.getUTCFullYear())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
