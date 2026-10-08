/**
 * Time windows in the user's zone. There is no lookback limit: any past date
 * may be read. One window spans at most `maxRangeDays` (≤ HARD_MAX_RANGE_DAYS);
 * a longer period (≤ maxPeriodDays) is split into calendar-month segments that
 * are read and summarized one by one.
 *
 * resolvePeriod turns a structured period (a day, the ISO week of a month, the
 * week containing a date, a month, the last N units, an explicit range) into
 * exact epoch bounds plus a Vietnamese label, so the model never does date
 * arithmetic. Calendar math runs on "wall" values — local wall-clock time
 * encoded as if it were UTC — and boundaries go back through wallClockToEpoch,
 * so every day/week/month boundary is a local midnight even across DST.
 * Errors are Vietnamese and actionable for the model (each with an example).
 */

import { HARD_MAX_PERIOD_DAYS, HARD_MAX_RANGE_DAYS } from '../config.ts'
import type { ResolvedRange } from '../types.ts'

/**
 * How the coordinator names a window. Flat on purpose (no oneOf) so every
 * provider's function-calling schema subset accepts it.
 * - day             { date: 'YYYY-MM-DD' }                 that whole local day
 * - week_of_month   { month: 'YYYY-MM', week: 1..5 }       ISO rule: Monday–Sunday
 *                   weeks; week 1 is the week containing the month's first Thursday
 *                   (Aug 2026: week 1 = 03–09/08, week 2 = 10–16/08)
 * - week_containing { date: 'YYYY-MM-DD' }                 the Monday–Sunday week containing date
 * - month           { month: 'YYYY-MM' }                   the whole calendar month
 * - last            { amount: N, unit: hour|day|week|month } ending now ("3 ngày qua")
 * - range           { since, until? }                      explicit ISO 8601, until exclusive
 *                   (date-only until = START of that day; zone-less = wall clock in timeZone)
 * - omitted period with since/until → range; with nothing → last defaultLookbackHours.
 * The year may be left out of `date` ('MM-DD') and `month` ('MM'): it then means
 * the most recent occurrence that has started by now (6/9 asked in October 2026 → 2026-09-06).
 */
export type PeriodKind = 'day' | 'week_of_month' | 'week_containing' | 'month' | 'last' | 'range'
export type PeriodUnit = 'hour' | 'day' | 'week' | 'month'

export interface PeriodInput {
  readonly period?: PeriodKind | undefined
  readonly date?: string | undefined
  readonly month?: string | undefined
  readonly week?: number | undefined
  readonly amount?: number | undefined
  readonly unit?: PeriodUnit | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
}

export interface PeriodOptions {
  readonly now: number
  readonly timeZone: string
  readonly maxRangeDays: number
  readonly maxPeriodDays: number
  readonly defaultLookbackHours: number
}

/**
 * ok: `range` is the whole requested window (end moved to now if it lay in the
 * future → clamped + note; a window entirely in the future → error). `segments`
 * has exactly one element (equal to `range`) when the span ≤ maxRangeDays;
 * otherwise the window split at calendar-month boundaries in `timeZone`, each
 * piece further split so none exceeds maxRangeDays, each with its own label
 * ("Tháng 7/2026", or "01/08 – 15/08/2026" for partial months).
 * error (Vietnamese, actionable): unparseable/invalid input (e.g. week 6,
 * month "2026-13"), since ≥ until, span > maxPeriodDays or more than
 * MAX_SEGMENTS segments (suggest narrowing).
 */
export type PeriodResult =
  | { readonly ok: true; readonly range: ResolvedRange; readonly segments: readonly ResolvedRange[] }
  | { readonly ok: false; readonly error: string }

/**
 * Most segments one request may be split into: a year of months, read and then
 * summarized per segment, still fits the coordinator's tool-call budget. Only
 * reachable with a small MAX_RANGE_DAYS (e.g. 1 → a month is 30 segments).
 */
export const MAX_SEGMENTS = 13

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'] as const
const UNIT_NAMES: Readonly<Record<PeriodUnit, string>> = { hour: 'giờ', day: 'ngày', week: 'tuần', month: 'tháng' }
const NOW_SUFFIX = ' (đến hiện tại)'
/** Any `last` longer than this many units is too long whatever the unit (keeps the date math finite). */
const MAX_AMOUNT = HARD_MAX_PERIOD_DAYS * 24
const NO_YEAR_HINT = 'Nếu người dùng không nêu năm, hãy bỏ năm (date "MM-DD", month "MM") để server tự chọn lần gần nhất đã qua, hoặc dùng năm trước.'
const FORMAT_HINT = 'Dùng ISO 8601, ví dụ "2026-10-01", "2026-10-01T08:00" hoặc "2026-10-01T08:00:00+07:00".'
const HINT = {
  date: (period: PeriodKind) => `Dùng date dạng "YYYY-MM-DD", ví dụ { "period": "${period}", "date": "2026-09-06" } cho ngày 6/9/2026.`,
  month: 'Dùng month dạng "YYYY-MM", ví dụ { "period": "month", "month": "2026-08" } cho tháng 8/2026.',
  week: 'Ví dụ { "period": "week_of_month", "month": "2026-08", "week": 2 } cho tuần 2 tháng 8/2026 (tuần theo ISO: Thứ Hai – Chủ Nhật, tuần 1 chứa thứ Năm đầu tiên của tháng).',
  last: 'Cần amount là số nguyên dương và unit là "hour", "day", "week" hoặc "month", ví dụ { "period": "last", "amount": 3, "unit": "day" } cho 3 ngày qua.',
}

/** A named window before it is clamped to now; `label` undefined → describe the bounds generically. */
interface RequestedWindow {
  readonly since: number
  readonly until: number
  readonly label?: string
  readonly defaulted: boolean
  readonly notes: readonly string[]
}

export function resolvePeriod(input: PeriodInput, options: PeriodOptions): PeriodResult {
  const { now, timeZone } = options
  const at = (epochMs: number): string => formatInZone(epochMs, timeZone)
  // The hard ceilings win over any configured value: they are product rules, not tunables.
  const maxRangeDays = clampInt(options.maxRangeDays, 1, HARD_MAX_RANGE_DAYS)
  const maxPeriodDays = clampInt(options.maxPeriodDays, maxRangeDays, HARD_MAX_PERIOD_DAYS)
  const fail = (error: string): PeriodResult => ({ ok: false, error })
  const tooLong = (what: string): string =>
    `${what}, vượt giới hạn ${maxPeriodDays} ngày cho một yêu cầu (mỗi lần đọc tối đa ${maxRangeDays} ngày; khoảng dài hơn được chia theo tháng). ` +
    'Hãy chọn khoảng ngắn hơn, ví dụ từng tháng { "period": "month", "month": "2026-08" } hoặc một quý.'

  const window = requestedWindow(input, options, at, tooLong)
  if ('error' in window) return fail(window.error)

  if (window.since >= now) {
    const what = window.label === undefined ? `Thời điểm bắt đầu ${at(window.since)}` : window.label
    const hint = input.date !== undefined || input.month !== undefined ? ` ${NO_YEAR_HINT}` : ''
    return fail(`${what} chưa diễn ra (bây giờ là ${at(now)}); chỉ đọc được tin nhắn trong quá khứ.${hint}`)
  }
  if (window.since >= window.until) {
    return fail(`Thời điểm bắt đầu (${at(window.since)}) phải trước thời điểm kết thúc (${at(window.until)}).`)
  }

  const clamped = window.until > now
  const until = clamped ? now : window.until
  const { since } = window
  const notes = clamped
    ? [...window.notes, `Khoảng thời gian kéo dài tới tương lai nên chỉ đọc tới thời điểm hiện tại (${at(now)}).`]
    : window.notes
  const label = (window.label ?? windowLabel(since, until, timeZone)) + (clamped ? NOW_SUFFIX : '')

  // Measured on the wall clock, so a 31-day month stays 31 days across a DST change.
  const span = wallOf(until, timeZone) - wallOf(since, timeZone)
  if (span > maxPeriodDays * DAY_MS) return fail(tooLong(`${label} dài ${Math.ceil(span / DAY_MS)} ngày`))

  const range: ResolvedRange = { since, until, label, clamped, defaulted: window.defaulted, notes }
  const segments = span > maxRangeDays * DAY_MS ? splitSegments(range, timeZone, maxRangeDays) : [range]
  if (segments.length > MAX_SEGMENTS) {
    return fail(
      `${label} phải chia thành ${segments.length} đoạn (mỗi lần đọc tối đa ${maxRangeDays} ngày), vượt giới hạn ${MAX_SEGMENTS} đoạn cho một yêu cầu. ` +
      'Hãy chọn khoảng ngắn hơn rồi hỏi lần lượt từng phần.',
    )
  }
  return { ok: true, range, segments }
}

/** The window an input names, before clamping to now. */
function requestedWindow(
  input: PeriodInput,
  options: PeriodOptions,
  at: (epochMs: number) => string,
  tooLong: (what: string) => string,
): RequestedWindow | { readonly error: string } {
  const { now, timeZone } = options
  const sinceText = input.since?.trim()
  const untilText = input.until?.trim()
  const period = input.period ?? (sinceText || untilText ? 'range' : undefined)
  const defaultHours = clampInt(options.defaultLookbackHours, 1, HARD_MAX_RANGE_DAYS * 24)
  const days = (startWall: number, count: number, label: string): RequestedWindow => ({
    since: wallClockToEpoch(startWall, timeZone),
    until: wallClockToEpoch(startWall + count * DAY_MS, timeZone),
    label,
    defaulted: false,
    notes: [],
  })

  switch (period) {
    case undefined: {
      const since = now - defaultHours * HOUR_MS
      return {
        since,
        until: now,
        label: `${defaultHours} giờ qua (${at(since)} → ${at(now)})`,
        defaulted: true,
        notes: [`Không nêu khoảng thời gian nên dùng mặc định ${defaultHours} giờ qua.`],
      }
    }

    case 'day':
    case 'week_containing': {
      const day = parseDay(input.date, now, timeZone)
      if (day === undefined) return { error: `Ngày "${input.date ?? ''}" không hợp lệ. ${HINT.date(period)}` }
      if (period === 'day') return days(day, 1, dayLabel(day))
      const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS
      // Not "Tuần Thứ Hai …": that reads as "tuần thứ hai" (the second week).
      return days(monday, 7, `Tuần từ ${weekSpan(monday, ' đến ')}`)
    }

    case 'week_of_month': {
      const month = parseMonth(input.month, now, timeZone)
      if (month === undefined) return { error: `Tháng "${input.month ?? ''}" không hợp lệ. ${HINT.week}` }
      const week = input.week
      if (week === undefined || !Number.isInteger(week) || week < 1 || week > 5) {
        return { error: `Tuần phải là số nguyên từ 1 đến 5 (nhận được ${String(week)}). ${HINT.week}` }
      }
      const mondays = isoWeeksOfMonth(month.year, month.month)
      const monday = mondays[week - 1]
      if (monday === undefined) {
        const list = mondays.map((start, index) => `tuần ${index + 1} (${weekSpan(start)})`).join(', ')
        return { error: `Tháng ${month.month}/${month.year} chỉ có ${mondays.length} tuần theo cách tính ISO (tuần 1 là tuần chứa thứ Năm đầu tiên của tháng): ${list}.` }
      }
      return days(monday, 7, `Tuần ${week} tháng ${month.month}/${month.year} (${weekSpan(monday)})`)
    }

    case 'month': {
      const month = parseMonth(input.month, now, timeZone)
      if (month === undefined) return { error: `Tháng "${input.month ?? ''}" không hợp lệ. ${HINT.month}` }
      return {
        since: wallClockToEpoch(Date.UTC(month.year, month.month - 1, 1), timeZone),
        until: wallClockToEpoch(Date.UTC(month.year, month.month, 1), timeZone),
        label: `Tháng ${month.month}/${month.year}`,
        defaulted: false,
        notes: [],
      }
    }

    case 'last': {
      const { amount, unit } = input
      if (amount === undefined || !Number.isInteger(amount) || amount < 1 || unit === undefined || !Object.hasOwn(UNIT_NAMES, unit)) {
        return { error: `Không hiểu khoảng "${String(amount)} ${String(unit)}". ${HINT.last}` }
      }
      if (amount > MAX_AMOUNT) return { error: tooLong(`${amount} ${UNIT_NAMES[unit]} qua là quá dài`) }
      const wall = wallOf(now, timeZone)
      const since = unit === 'hour'
        ? now - amount * HOUR_MS
        : wallClockToEpoch(unit === 'month' ? addMonths(wall, -amount) : wall - amount * (unit === 'week' ? 7 : 1) * DAY_MS, timeZone)
      return { since, until: now, label: `${amount} ${UNIT_NAMES[unit]} qua (${at(since)} → ${at(now)})`, defaulted: false, notes: [] }
    }

    case 'range': {
      let until = now
      if (untilText) {
        const parsed = parseDateTime(untilText, timeZone)
        if (parsed === undefined) return { error: `Không hiểu thời điểm kết thúc "${untilText}". ${FORMAT_HINT}` }
        until = parsed
      }
      if (sinceText) {
        const since = parseDateTime(sinceText, timeZone)
        if (since === undefined) return { error: `Không hiểu thời điểm bắt đầu "${sinceText}". ${FORMAT_HINT}` }
        return { since, until, defaulted: false, notes: [] }
      }
      return {
        since: until - defaultHours * HOUR_MS,
        until,
        defaulted: true,
        notes: [`Không nêu thời điểm bắt đầu nên dùng mặc định ${defaultHours} giờ trước thời điểm kết thúc.`],
      }
    }

    default:
      return { error: `Không hiểu period "${String(period)}". Dùng một trong: day, week_of_month, week_containing, month, last, range.` }
  }
}

/**
 * Split at local month starts, then cut any piece longer than maxRangeDays into
 * consecutive pieces of at most that many days. The outer ends keep their exact
 * instants; the last segment inherits the clamp (and the window's notes).
 */
function splitSegments(range: ResolvedRange, timeZone: string, maxRangeDays: number): ResolvedRange[] {
  const start = wallOf(range.since, timeZone)
  const end = wallOf(range.until, timeZone)
  const segments: ResolvedRange[] = []
  let cursor = start
  while (cursor < end) {
    const date = new Date(cursor)
    const monthEnd = Math.min(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), end)
    while (cursor < monthEnd) {
      const pieceEnd = Math.min(cursor + maxRangeDays * DAY_MS, monthEnd)
      const since = cursor === start ? range.since : wallClockToEpoch(cursor, timeZone)
      const last = pieceEnd === end
      const until = last ? range.until : wallClockToEpoch(pieceEnd, timeZone)
      const clamped = last && range.clamped
      segments.push({
        since,
        until,
        label: windowLabel(since, until, timeZone) + (clamped ? NOW_SUFFIX : ''),
        clamped,
        defaulted: range.defaulted,
        notes: last ? range.notes : [],
      })
      cursor = pieceEnd
    }
  }
  return segments
}

/**
 * "Chủ Nhật, 06/09/2026" for one whole day, "Tháng 8/2026" for a whole month,
 * "01/08 – 15/08/2026" for whole days (end shown inclusive), otherwise
 * "dd/MM/yyyy HH:mm → dd/MM/yyyy HH:mm" — with a midnight end shown as the
 * inclusive day before ("06/07/2026 14:11 – 31/07/2026") and a midnight start
 * as its day ("01/10/2026 – 06/10/2026 14:11").
 */
function windowLabel(since: number, until: number, timeZone: string): string {
  const start = wallOf(since, timeZone)
  const end = wallOf(until, timeZone)
  if (isMidnight(start) && isMidnight(end)) {
    if (end - start === DAY_MS) return dayLabel(start)
    const first = new Date(start)
    if (first.getUTCDate() === 1 && end === Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)) {
      return `Tháng ${first.getUTCMonth() + 1}/${first.getUTCFullYear()}`
    }
    return daySpan(start, end - DAY_MS)
  }
  if (isMidnight(end)) return `${formatInZone(since, timeZone)} – ${dmy(end - DAY_MS)}`
  if (isMidnight(start)) return `${dmy(start)} – ${formatInZone(until, timeZone)}`
  return `${formatInZone(since, timeZone)} → ${formatInZone(until, timeZone)}`
}

/** Mondays (as wall midnights) of the month's ISO weeks: each week whose Thursday lies in the month. */
function isoWeeksOfMonth(year: number, month: number): number[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const mondays: number[] = []
  for (let thursday = 1 + ((4 - firstWeekday + 7) % 7); thursday <= daysInMonth(year, month); thursday += 7) {
    mondays.push(Date.UTC(year, month - 1, thursday - 3))
  }
  return mondays
}

const DAY_PATTERN = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/
const MONTH_PATTERN = /^(?:(\d{4})-)?(\d{1,2})$/

/** 'YYYY-MM-DD' (or 'MM-DD' = latest occurrence that has started) → wall midnight. */
function parseDay(value: string | undefined, now: number, timeZone: string): number | undefined {
  const match = DAY_PATTERN.exec(value?.trim() ?? '')
  if (match === null) return undefined
  const [, y, m, d] = match
  const month = Number(m)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1) return undefined
  if (y !== undefined) {
    const year = Number(y)
    return day <= daysInMonth(year, month) ? Date.UTC(year, month - 1, day) : undefined
  }
  const today = startOfDay(wallOf(now, timeZone))
  // Eight years always reach a 29 February.
  for (let year = new Date(today).getUTCFullYear(); year > new Date(today).getUTCFullYear() - 8; year--) {
    const candidate = Date.UTC(year, month - 1, day)
    if (day <= daysInMonth(year, month) && candidate <= today) return candidate
  }
  return undefined
}

/** 'YYYY-MM' (or 'MM' = latest month that has started). */
function parseMonth(value: string | undefined, now: number, timeZone: string): { readonly year: number; readonly month: number } | undefined {
  const match = MONTH_PATTERN.exec(value?.trim() ?? '')
  if (match === null) return undefined
  const [, y, m] = match
  const month = Number(m)
  if (month < 1 || month > 12) return undefined
  if (y !== undefined) return { year: Number(y), month }
  const current = new Date(wallOf(now, timeZone))
  const year = current.getUTCFullYear()
  return { year: month > current.getUTCMonth() + 1 ? year - 1 : year, month }
}

/** The instant's local wall-clock time, encoded as if it were UTC. */
function wallOf(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((epochMs % 1000) + 1000) % 1000)
}

/** Same day-of-month `months` later (or earlier), clamped to the target month's length; time of day kept. */
function addMonths(wall: number, months: number): number {
  const date = new Date(wall)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const target = new Date(Date.UTC(year, month, 1))
  const day = Math.min(date.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1))
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day) + (wall - startOfDay(wall))
}

function startOfDay(wall: number): number {
  return Math.floor(wall / DAY_MS) * DAY_MS
}

function isMidnight(wall: number): boolean {
  return wall === startOfDay(wall)
}

function dayLabel(wall: number): string {
  return `${WEEKDAYS[new Date(wall).getUTCDay()] ?? ''}, ${dmy(wall)}`
}

/** "Thứ Hai 10/08 – Chủ Nhật 16/08/2026" (both years shown when they differ). */
function weekSpan(monday: number, separator = ' – '): string {
  const sunday = monday + 6 * DAY_MS
  return `Thứ Hai ${sameYear(monday, sunday) ? dm(monday) : dmy(monday)}${separator}Chủ Nhật ${dmy(sunday)}`
}

/** "01/08 – 15/08/2026", both ends inclusive. */
function daySpan(first: number, last: number): string {
  return `${sameYear(first, last) ? dm(first) : dmy(first)} – ${dmy(last)}`
}

function sameYear(a: number, b: number): boolean {
  return new Date(a).getUTCFullYear() === new Date(b).getUTCFullYear()
}

function dm(wall: number): string {
  const date = new Date(wall)
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}`
}

function dmy(wall: number): string {
  return `${dm(wall)}/${new Date(wall).getUTCFullYear()}`
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, Math.floor(value) || min), max)
}

// ---------------------------------------------------------------------------
// ISO parsing and zone-aware formatting.
// ---------------------------------------------------------------------------

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
