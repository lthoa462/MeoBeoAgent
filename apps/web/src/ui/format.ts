/** Vietnamese labels and browser-zone formatting for the chat view. */

import type { SpecialistKind } from '@meobeo/backend/wire'

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
      return formatRange(field('since'), field('until')) ?? 'khoảng thời gian mặc định'
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

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
