/**
 * Validate and clamp a requested time window.
 *
 * - `since`/`until` are ISO 8601 strings. With an explicit offset/Z they are
 *   absolute; without one (e.g. "2026-10-01T08:00" or "2026-10-01") they are
 *   wall-clock times in `timeZone` (date-only = start of that day).
 * - Missing `until` → now. `until` in the future → now (note added).
 * - Missing `since` → until - defaultLookbackHours (defaulted = true).
 * - `since` earlier than now - maxLookbackDays → moved to that limit
 *   (clamped = true, note explains the 30-day limit in Vietnamese). A start
 *   only a few minutes past the limit is moved silently: "the last 30 days"
 *   computed from the minute-precision clock in the prompt is not a clamp.
 * - since >= until, or unparseable input → { ok: false, error } (Vietnamese,
 *   actionable for the model).
 */

import { HARD_MAX_LOOKBACK_DAYS } from '../config.ts'
import type { ResolvedRange } from '../types.ts'

export interface RangeInput {
  readonly since?: string | undefined
  readonly until?: string | undefined
}

export interface RangeOptions {
  readonly now: number
  readonly timeZone: string
  readonly maxLookbackDays: number
  readonly defaultLookbackHours: number
}

export type RangeResult =
  | { readonly ok: true; readonly range: ResolvedRange }
  | { readonly ok: false; readonly error: string }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Rounding slack for "the last N days" requests that land just before the limit. */
const CLAMP_GRACE_MS = 5 * 60_000
const FORMAT_HINT = 'Dùng ISO 8601, ví dụ "2026-10-01", "2026-10-01T08:00" hoặc "2026-10-01T08:00:00+07:00".'

export function resolveRange(input: RangeInput, options: RangeOptions): RangeResult {
  const { now, timeZone } = options
  const at = (epochMs: number): string => formatInZone(epochMs, timeZone)
  const notes: string[] = []
  // The hard ceiling wins over any configured value: this is a product rule, not a tunable.
  const lookbackDays = Math.min(Math.max(1, Math.floor(options.maxLookbackDays) || HARD_MAX_LOOKBACK_DAYS), HARD_MAX_LOOKBACK_DAYS)
  const earliest = now - lookbackDays * DAY_MS

  let until = now
  const untilText = input.until?.trim()
  if (untilText) {
    const parsed = parseDateTime(untilText, timeZone)
    if (parsed === undefined) return { ok: false, error: `Không hiểu thời điểm kết thúc "${untilText}". ${FORMAT_HINT}` }
    if (parsed > now) {
      notes.push(`Thời điểm kết thúc nằm trong tương lai; đã dùng thời điểm hiện tại (${at(now)}).`)
    } else {
      until = parsed
    }
  }

  let since: number
  let defaulted = false
  const sinceText = input.since?.trim()
  if (sinceText) {
    const parsed = parseDateTime(sinceText, timeZone)
    if (parsed === undefined) return { ok: false, error: `Không hiểu thời điểm bắt đầu "${sinceText}". ${FORMAT_HINT}` }
    if (parsed >= now) return { ok: false, error: `Thời điểm bắt đầu (${at(parsed)}) nằm trong tương lai; hãy chọn một thời điểm trước ${at(now)}.` }
    since = parsed
  } else {
    const hours = Math.max(1, options.defaultLookbackHours)
    since = until - hours * HOUR_MS
    defaulted = true
    notes.push(`Không nêu thời điểm bắt đầu nên dùng mặc định ${hours} giờ trước thời điểm kết thúc.`)
  }

  if (until <= earliest) {
    return {
      ok: false,
      error: `Chỉ hỗ trợ đọc tối đa ${lookbackDays} ngày gần nhất (từ ${at(earliest)} trở đi); khoảng thời gian yêu cầu kết thúc lúc ${at(until)} nên không thể đọc.`,
    }
  }

  let clamped = false
  if (since < earliest - CLAMP_GRACE_MS) {
    since = earliest
    clamped = true
    notes.push(`Chỉ hỗ trợ đọc tối đa ${lookbackDays} ngày gần nhất; đã đổi thời điểm bắt đầu thành ${at(since)}.`)
  } else if (since < earliest) {
    since = earliest
  }

  if (since >= until) {
    return { ok: false, error: `Thời điểm bắt đầu (${at(since)}) phải trước thời điểm kết thúc (${at(until)}).` }
  }
  return { ok: true, range: { since, until, clamped, defaulted, notes } }
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

/** Parse ISO 8601; zone-less values are wall-clock in `timeZone`. Undefined when invalid. */
export function parseDateTime(value: string, timeZone: string): number | undefined {
  const match = ISO_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', zone] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3))
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined

  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis)
  if (zone === undefined) return wallClockToEpoch(wall, timeZone)
  if (zone.toUpperCase() === 'Z') return wall
  const sign = zone.startsWith('-') ? -1 : 1
  const digits = zone.slice(1).replace(':', '')
  const offsetHours = Number(digits.slice(0, 2))
  const offsetMinutes = Number(digits.slice(2) || '0')
  if (offsetHours > 23 || offsetMinutes > 59) return undefined
  return wall - sign * (offsetHours * 60 + offsetMinutes) * 60_000
}

/** Format epoch ms in a zone: 'datetime' → "dd/MM/yyyy HH:mm", 'date' → "dd/MM/yyyy", 'time' → "HH:mm". */
export function formatInZone(epochMs: number, timeZone: string, style: 'datetime' | 'date' | 'time' = 'datetime'): string {
  const p = zonedParts(epochMs, timeZone)
  const date = `${pad(p.day)}/${pad(p.month)}/${p.year}`
  const time = `${pad(p.hour)}:${pad(p.minute)}`
  return style === 'date' ? date : style === 'time' ? time : `${date} ${time}`
}

/** ISO 8601 with the zone's UTC offset, e.g. "2026-10-06T11:05:00+07:00" (for prompts). */
export function toZonedIso(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone)
  const offset = Math.round(offsetMs(epochMs, timeZone) / 60_000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** Calendar fields of an instant as seen on a wall clock in `timeZone`. */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const fields: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  return {
    year: fields.year ?? 1970,
    month: fields.month ?? 1,
    day: fields.day ?? 1,
    // Some engines still print midnight as 24 even with h23.
    hour: (fields.hour ?? 0) % 24,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0,
  }
}

/** The zone's UTC offset at an instant (wall clock minus UTC), in ms. */
function offsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone)
  const wholeSecond = epochMs - (((epochMs % 1000) + 1000) % 1000)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond
}

/**
 * Wall-clock time (fields encoded as if UTC) → instant in `timeZone`.
 *
 * Try the offsets in force a day before and after; a candidate is right when
 * the zone really has that offset at the resulting instant. Two matches mean a
 * fall-back overlap (take the earlier, as Temporal's "compatible" does); none
 * means a spring-forward gap (shift forward by the gap, again like Temporal).
 */
function wallClockToEpoch(wall: number, timeZone: string): number {
  const before = offsetMs(wall - DAY_MS, timeZone)
  const after = offsetMs(wall + DAY_MS, timeZone)
  const matches = [...new Set([before, after])]
    .map(offset => wall - offset)
    .filter(candidate => wall - offsetMs(candidate, timeZone) === candidate)
  if (matches.length > 0) return Math.min(...matches)
  return wall - before
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const MAX_CACHED_FORMATTERS = 500
const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}

/** Cached per zone; an unknown zone falls back to UTC rather than failing a turn (hosts validate zones up front). */
function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  let created: Intl.DateTimeFormat
  try {
    created = new Intl.DateTimeFormat('en-US', { ...FORMAT_OPTIONS, timeZone })
  } catch {
    return formatter('UTC')
  }
  // Zone names arrive from browsers; never let them grow the cache without bound.
  if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear()
  formatters.set(timeZone, created)
  return created
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
