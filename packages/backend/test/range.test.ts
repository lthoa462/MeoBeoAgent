import { describe, expect, it } from 'vitest'
import { MAX_SEGMENTS, formatInZone, parseDateTime, resolvePeriod, toZonedIso, type PeriodInput, type PeriodOptions } from '../src/transcript/range.ts'
import type { ResolvedRange } from '../src/types.ts'

const VN = 'Asia/Ho_Chi_Minh'
const NY = 'America/New_York'
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Tuesday 06/10/2026 11:00 in Vietnam. */
const NOW = Date.parse('2026-10-06T04:00:00Z')
const OPTIONS: PeriodOptions = { now: NOW, timeZone: VN, maxRangeDays: 31, maxPeriodDays: 92, defaultLookbackHours: 24 }
/** Midnight of a Vietnam calendar day (UTC+7, no DST) as epoch ms. */
const vnDay = (year: number, month: number, day: number): number => Date.UTC(year, month - 1, day) - 7 * HOUR

const resolve = (input: PeriodInput, options: Partial<PeriodOptions> = {}) => {
  const result = resolvePeriod(input, { ...OPTIONS, ...options })
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
  return result
}
const ok = (input: PeriodInput, options: Partial<PeriodOptions> = {}): ResolvedRange => resolve(input, options).range
const error = (input: PeriodInput, options: Partial<PeriodOptions> = {}): string => {
  const result = resolvePeriod(input, { ...OPTIONS, ...options })
  if (result.ok) throw new Error(`expected an error, got: ${result.range.label}`)
  return result.error
}
const labels = (input: PeriodInput, options: Partial<PeriodOptions> = {}): string[] => resolve(input, options).segments.map(segment => segment.label)

describe('resolvePeriod: day', () => {
  it('reads one whole local day with exact bounds and a Vietnamese label', () => {
    const result = resolve({ period: 'day', date: '2026-09-06' })
    expect(result.range).toEqual({
      since: Date.UTC(2026, 8, 5, 17),
      until: Date.UTC(2026, 8, 6, 17),
      label: 'Chủ Nhật, 06/09/2026',
      clamped: false,
      defaulted: false,
      notes: [],
    })
    expect(result.segments).toEqual([result.range])
    expect(ok({ period: 'day', date: '2026-10-05' }).label).toBe('Thứ Hai, 05/10/2026')
  })

  it('clamps today to now and rejects future days', () => {
    const today = ok({ period: 'day', date: '2026-10-06' })
    expect(today).toMatchObject({ since: vnDay(2026, 10, 6), until: NOW, clamped: true, label: 'Thứ Ba, 06/10/2026 (đến hiện tại)' })
    expect(today.notes.join(' ')).toMatch(/tương lai.*06\/10\/2026 11:00/)
    expect(error({ period: 'day', date: '2026-10-07' })).toMatch(/^Thứ Tư, 07\/10\/2026 chưa diễn ra \(bây giờ là 06\/10\/2026 11:00\)/)
    // The model is pointed at the server's year-less form instead of guessing the year.
    expect(error({ period: 'day', date: '2026-11-06' })).toContain('hãy bỏ năm (date "MM-DD", month "MM")')
    expect(ok({ period: 'day', date: '11-06' }).label).toBe('Thứ Năm, 06/11/2025')
  })

  it('reads a date without a year as its most recent occurrence', () => {
    expect(ok({ period: 'day', date: '09-06' }).since).toBe(vnDay(2026, 9, 6))
    expect(ok({ period: 'day', date: '6-9' }).since).toBe(vnDay(2026, 6, 9))
    expect(ok({ period: 'day', date: '10-07' }).label).toBe('Thứ Ba, 07/10/2025')
    expect(ok({ period: 'day', date: '02-29' }).label).toBe('Thứ Năm, 29/02/2024')
    expect(ok({ period: 'day', date: '10-06' }).clamped).toBe(true)
  })

  it('has no lookback limit: any past day can be read', () => {
    expect(ok({ period: 'day', date: '2024-02-29' })).toMatchObject({ since: vnDay(2024, 2, 29), until: vnDay(2024, 3, 1), clamped: false })
    expect(ok({ period: 'day', date: '2019-01-01' }).label).toBe('Thứ Ba, 01/01/2019')
  })

  it('rejects malformed dates with an example', () => {
    for (const date of ['2026-02-30', '2026-13-01', '06/09/2026', '2026-09-06T00:00', 'hôm qua', '']) {
      expect(error({ period: 'day', date }), date).toMatch(/không hợp lệ.*"date": "2026-09-06"/)
    }
    expect(error({ period: 'day' })).toMatch(/YYYY-MM-DD/)
  })
})

describe('resolvePeriod: weeks', () => {
  it('numbers weeks of a month the ISO way (week 1 holds the first Thursday)', () => {
    // August 2026 starts on a Saturday: week 1 is 03–09/08, not 27/07–02/08.
    const week1 = ok({ period: 'week_of_month', month: '2026-08', week: 1 })
    expect(week1).toMatchObject({ since: vnDay(2026, 8, 3), until: vnDay(2026, 8, 10), label: 'Tuần 1 tháng 8/2026 (Thứ Hai 03/08 – Chủ Nhật 09/08/2026)' })
    const week2 = ok({ period: 'week_of_month', month: '2026-08', week: 2 })
    expect(week2).toMatchObject({ since: vnDay(2026, 8, 10), until: vnDay(2026, 8, 17), label: 'Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)' })
    expect(ok({ period: 'week_of_month', month: '2026-08', week: 4 }).label).toBe('Tuần 4 tháng 8/2026 (Thứ Hai 24/08 – Chủ Nhật 30/08/2026)')
  })

  it('lists the valid weeks when the month has no such week', () => {
    expect(error({ period: 'week_of_month', month: '2026-08', week: 5 })).toBe(
      'Tháng 8/2026 chỉ có 4 tuần theo cách tính ISO (tuần 1 là tuần chứa thứ Năm đầu tiên của tháng): ' +
      'tuần 1 (Thứ Hai 03/08 – Chủ Nhật 09/08/2026), tuần 2 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026), ' +
      'tuần 3 (Thứ Hai 17/08 – Chủ Nhật 23/08/2026), tuần 4 (Thứ Hai 24/08 – Chủ Nhật 30/08/2026).',
    )
  })

  it('handles February and weeks that cross into a neighbouring month', () => {
    // February 2026 starts on a Sunday: four weeks, the last one ends in March.
    expect(ok({ period: 'week_of_month', month: '2026-02', week: 1 })).toMatchObject({ since: vnDay(2026, 2, 2), until: vnDay(2026, 2, 9) })
    expect(ok({ period: 'week_of_month', month: '2026-02', week: 4 }).label).toBe('Tuần 4 tháng 2/2026 (Thứ Hai 23/02 – Chủ Nhật 01/03/2026)')
    expect(error({ period: 'week_of_month', month: '2026-02', week: 5 })).toMatch(/^Tháng 2\/2026 chỉ có 4 tuần/)
  })

  it('starts week 1 in the previous month when the 1st is a Thursday, and finds week 5 when present', () => {
    // 1 October 2026 and 1 January 2026 are Thursdays.
    expect(ok({ period: 'week_of_month', month: '2026-10', week: 1 })).toMatchObject({
      since: vnDay(2026, 9, 28), until: vnDay(2026, 10, 5), clamped: false, label: 'Tuần 1 tháng 10/2026 (Thứ Hai 28/09 – Chủ Nhật 04/10/2026)',
    })
    expect(ok({ period: 'week_of_month', month: '2026-01', week: 1 }).label).toBe('Tuần 1 tháng 1/2026 (Thứ Hai 29/12/2025 – Chủ Nhật 04/01/2026)')
    expect(ok({ period: 'week_of_month', month: '2026-01', week: 5 }).label).toBe('Tuần 5 tháng 1/2026 (Thứ Hai 26/01 – Chủ Nhật 01/02/2026)')
    expect(ok({ period: 'week_of_month', month: '2026-07', week: 5 })).toMatchObject({ since: vnDay(2026, 7, 27), until: vnDay(2026, 8, 3) })
  })

  it('clamps the current week, rejects future weeks and invalid week numbers', () => {
    expect(ok({ period: 'week_of_month', month: '2026-10', week: 2 })).toMatchObject({
      since: vnDay(2026, 10, 5), until: NOW, clamped: true, label: 'Tuần 2 tháng 10/2026 (Thứ Hai 05/10 – Chủ Nhật 11/10/2026) (đến hiện tại)',
    })
    expect(error({ period: 'week_of_month', month: '2026-10', week: 3 })).toMatch(/chưa diễn ra/)
    for (const week of [0, 6, 2.5, undefined]) {
      expect(error({ period: 'week_of_month', month: '2026-08', week }), String(week)).toMatch(/từ 1 đến 5.*"week": 2/)
    }
    expect(error({ period: 'week_of_month', month: 'tháng 8', week: 2 })).toMatch(/Tháng "tháng 8" không hợp lệ/)
  })

  it('finds the Monday–Sunday week containing a date', () => {
    expect(ok({ period: 'week_containing', date: '2026-10-01' })).toMatchObject({
      since: vnDay(2026, 9, 28), until: vnDay(2026, 10, 5), label: 'Tuần từ Thứ Hai 28/09 đến Chủ Nhật 04/10/2026',
    })
    expect(ok({ period: 'week_containing', date: '2026-09-06' }).label).toBe('Tuần từ Thứ Hai 31/08 đến Chủ Nhật 06/09/2026') // a Sunday
    expect(ok({ period: 'week_containing', date: '2026-08-10' }).since).toBe(vnDay(2026, 8, 10)) // a Monday
    expect(ok({ period: 'week_containing', date: '2026-01-01' }).label).toBe('Tuần từ Thứ Hai 29/12/2025 đến Chủ Nhật 04/01/2026')
    expect(error({ period: 'week_containing', date: '1/10' })).toMatch(/"period": "week_containing"/)
  })
})

describe('resolvePeriod: months and last N', () => {
  it('reads whole calendar months, clamping the current one to now', () => {
    expect(ok({ period: 'month', month: '2026-08' })).toEqual({
      since: vnDay(2026, 8, 1), until: vnDay(2026, 9, 1), label: 'Tháng 8/2026', clamped: false, defaulted: false, notes: [],
    })
    const current = ok({ period: 'month', month: '2026-10' })
    expect(current).toMatchObject({ since: vnDay(2026, 10, 1), until: NOW, clamped: true, label: 'Tháng 10/2026 (đến hiện tại)' })
    expect(current.notes).toEqual(['Khoảng thời gian kéo dài tới tương lai nên chỉ đọc tới thời điểm hiện tại (06/10/2026 11:00).'])
    expect(ok({ period: 'month', month: '2025-03' }).label).toBe('Tháng 3/2025')
    expect(ok({ period: 'month', month: '11' }).label).toBe('Tháng 11/2025')
    expect(ok({ period: 'month', month: '9' }).label).toBe('Tháng 9/2026')
    expect(error({ period: 'month', month: '2026-11' })).toMatch(/^Tháng 11\/2026 chưa diễn ra/)
    for (const month of ['2026-13', '2026/08', 'August', undefined]) {
      expect(error({ period: 'month', month }), String(month)).toMatch(/không hợp lệ.*"month": "2026-08"/)
    }
  })

  it('counts the last N hours, days, weeks and calendar months back from now', () => {
    expect(ok({ period: 'last', amount: 6, unit: 'hour' })).toMatchObject({
      since: NOW - 6 * HOUR, until: NOW, clamped: false, defaulted: false, label: '6 giờ qua (06/10/2026 05:00 → 06/10/2026 11:00)',
    })
    const afternoon = Date.parse('2026-10-06T07:05:00Z')
    expect(ok({ period: 'last', amount: 3, unit: 'day' }, { now: afternoon }).label).toBe('3 ngày qua (03/10/2026 14:05 → 06/10/2026 14:05)')
    expect(ok({ period: 'last', amount: 2, unit: 'week' }).since).toBe(NOW - 14 * DAY)
    expect(ok({ period: 'last', amount: 1, unit: 'month' }).since).toBe(Date.parse('2026-09-06T04:00:00Z'))
    // Same day of month, clamped to a shorter month.
    const endOfMarch = Date.parse('2026-03-31T05:00:00Z')
    expect(ok({ period: 'last', amount: 1, unit: 'month' }, { now: endOfMarch }).label).toBe('1 tháng qua (28/02/2026 12:00 → 31/03/2026 12:00)')
  })

  it('rejects malformed or overlong `last` requests', () => {
    for (const input of [{ amount: 0, unit: 'day' }, { amount: -2, unit: 'day' }, { amount: 1.5, unit: 'day' }, { amount: 2 }, { amount: 2, unit: 'year' }]) {
      expect(error({ period: 'last', ...input } as PeriodInput), JSON.stringify(input)).toMatch(/số nguyên dương.*"unit": "day"/)
    }
    expect(error({ period: 'last', amount: 4, unit: 'month' })).toMatch(/^4 tháng qua \(06\/06\/2026 11:00 → 06\/10\/2026 11:00\) dài 122 ngày, vượt giới hạn 92 ngày/)
    expect(error({ period: 'last', amount: 1e9, unit: 'month' })).toMatch(/quá dài, vượt giới hạn 92 ngày/)
  })
})

describe('resolvePeriod: explicit ranges and defaults', () => {
  it('defaults to the last 24 hours ending now', () => {
    const range = ok({})
    expect(range).toMatchObject({ since: NOW - DAY, until: NOW, defaulted: true, clamped: false, label: '24 giờ qua (05/10/2026 11:00 → 06/10/2026 11:00)' })
    expect(range.notes.join(' ')).toMatch(/mặc định 24 giờ/)
    expect(ok({ since: ' ', until: '' })).toMatchObject({ since: NOW - DAY, until: NOW, defaulted: true })
    expect(ok({ period: 'range' })).toMatchObject({ since: NOW - DAY, defaulted: true })
    expect(ok({}, { defaultLookbackHours: 6 }).since).toBe(NOW - 6 * HOUR)
  })

  it('reads explicit bounds with an exclusive, date-only `until`', () => {
    const range = ok({ since: '2026-08-01', until: '2026-08-16' })
    expect(range).toMatchObject({ since: vnDay(2026, 8, 1), until: vnDay(2026, 8, 16), label: '01/08 – 15/08/2026', defaulted: false })
    expect(ok({ period: 'range', since: '2026-08-01T08:30', until: '2026-08-02T17:00:00+07:00' }).label).toBe('01/08/2026 08:30 → 02/08/2026 17:00')
    expect(ok({ since: '2026-09-06', until: '2026-09-07' }).label).toBe('Chủ Nhật, 06/09/2026')
    expect(ok({ since: '2026-09-01', until: '2026-10-01' }).label).toBe('Tháng 9/2026')
    expect(ok({ since: '2025-12-20', until: '2026-01-10' }).label).toBe('20/12/2025 – 09/01/2026')
    expect(ok({ since: '2026-10-01' })).toMatchObject({ until: NOW, clamped: false, label: '01/10/2026 – 06/10/2026 11:00' })
  })

  it('defaults `since` relative to an explicit `until`', () => {
    const range = ok({ until: '2026-10-05T18:00' })
    expect(range.until).toBe(Date.parse('2026-10-05T11:00:00Z'))
    expect(range).toMatchObject({ since: range.until - DAY, defaulted: true })
    expect(range.notes.join(' ')).toMatch(/24 giờ trước thời điểm kết thúc/)
  })

  it('moves a future `until` back to now with a note and a label suffix', () => {
    const range = ok({ since: '2026-10-01', until: '2026-10-10' })
    expect(range).toMatchObject({ since: vnDay(2026, 10, 1), until: NOW, clamped: true, label: '01/10/2026 – 06/10/2026 11:00 (đến hiện tại)' })
    expect(range.notes.join(' ')).toMatch(/tương lai.*06\/10\/2026 11:00/)
  })

  it('rejects inverted windows, future starts and garbage', () => {
    expect(error({ since: '2026-10-05T10:00', until: '2026-10-05T09:00' })).toMatch(/phải trước/)
    expect(error({ since: '2026-10-08' })).toMatch(/^Thời điểm bắt đầu 08\/10\/2026 00:00 chưa diễn ra/)
    expect(error({ since: 'hôm qua' })).toMatch(/Không hiểu thời điểm bắt đầu "hôm qua".*ISO 8601/)
    expect(error({ until: '2026-13-01' })).toMatch(/kết thúc/)
    expect(error({ period: 'quarter' as never })).toMatch(/Không hiểu period "quarter"/)
  })

  it('has no 30-day limit but caps the whole period at maxPeriodDays', () => {
    expect(ok({ since: '2025-05-01', until: '2025-05-20' })).toMatchObject({ since: vnDay(2025, 5, 1), clamped: false, notes: [] })
    expect(error({ since: '2026-01-01', until: '2026-06-01' })).toMatch(/dài 151 ngày, vượt giới hạn 92 ngày.*"period": "month"/)
    expect(error({ since: '2025-01-01', until: '2026-03-01' }, { maxPeriodDays: 1000 })).toMatch(/vượt giới hạn 366 ngày/)
  })
})

describe('resolvePeriod: segments', () => {
  it('keeps a window up to maxRangeDays as one segment, even across months', () => {
    const result = resolve({ since: '2026-07-20', until: '2026-08-20' })
    expect(result.segments).toEqual([result.range])
  })

  it('splits a quarter into calendar months', () => {
    const { range, segments } = resolve({ since: '2026-07-01', until: '2026-10-01' })
    expect(range).toMatchObject({ since: vnDay(2026, 7, 1), until: vnDay(2026, 10, 1), label: '01/07 – 30/09/2026', clamped: false })
    expect(segments).toEqual([
      { since: vnDay(2026, 7, 1), until: vnDay(2026, 8, 1), label: 'Tháng 7/2026', clamped: false, defaulted: false, notes: [] },
      { since: vnDay(2026, 8, 1), until: vnDay(2026, 9, 1), label: 'Tháng 8/2026', clamped: false, defaulted: false, notes: [] },
      { since: vnDay(2026, 9, 1), until: vnDay(2026, 10, 1), label: 'Tháng 9/2026', clamped: false, defaulted: false, notes: [] },
    ])
  })

  it('labels partial months and carries the clamp to the last segment only', () => {
    const { range, segments } = resolve({ since: '2026-08-15', until: '2026-12-01' })
    expect(range.clamped).toBe(true)
    expect(segments.map(segment => segment.label)).toEqual(['15/08 – 31/08/2026', 'Tháng 9/2026', '01/10/2026 – 06/10/2026 11:00 (đến hiện tại)'])
    expect(segments.map(segment => segment.clamped)).toEqual([false, false, true])
    expect(segments.at(-1)?.notes).toEqual(range.notes)
    expect(segments[0]?.notes).toEqual([])
    expect(labels({ period: 'last', amount: 2, unit: 'month' })).toEqual(['06/08/2026 11:00 – 31/08/2026', 'Tháng 9/2026', '01/10/2026 – 06/10/2026 11:00'])
  })

  it('cuts months into pieces of at most maxRangeDays', () => {
    expect(labels({ period: 'month', month: '2026-08' }, { maxRangeDays: 7 })).toEqual([
      '01/08 – 07/08/2026', '08/08 – 14/08/2026', '15/08 – 21/08/2026', '22/08 – 28/08/2026', '29/08 – 31/08/2026',
    ])
    const { segments } = resolve({ since: '2026-07-25', until: '2026-08-12' }, { maxRangeDays: 7 })
    expect(segments.map(segment => segment.label)).toEqual(['25/07 – 31/07/2026', '01/08 – 07/08/2026', '08/08 – 11/08/2026'])
    for (const [index, segment] of segments.entries()) {
      if (index > 0) expect(segment.since).toBe(segments[index - 1]?.until)
    }
  })

  it('refuses a split into more than MAX_SEGMENTS pieces (a small MAX_RANGE_DAYS), but allows a whole year of months', () => {
    expect(MAX_SEGMENTS).toBe(13)
    expect(error({ period: 'month', month: '2026-09' }, { maxRangeDays: 1 })).toBe(
      'Tháng 9/2026 phải chia thành 30 đoạn (mỗi lần đọc tối đa 1 ngày), vượt giới hạn 13 đoạn cho một yêu cầu. Hãy chọn khoảng ngắn hơn rồi hỏi lần lượt từng phần.',
    )
    expect(labels({ period: 'month', month: '2026-09' }, { maxRangeDays: 3 })).toHaveLength(10)
    const year = { maxPeriodDays: 366, now: Date.parse('2027-03-01T00:00:00Z') }
    expect(labels({ since: '2026-01-01', until: '2027-01-01' }, year)).toHaveLength(12)
    expect(labels({ since: '2026-01-15', until: '2027-01-15' }, year)).toHaveLength(13)
  })

  it('never exceeds the hard 31-day window even if configured higher', () => {
    expect(labels({ since: '2026-07-01', until: '2026-09-01' }, { maxRangeDays: 365 })).toEqual(['Tháng 7/2026', 'Tháng 8/2026'])
  })
})

describe('resolvePeriod: daylight saving time', () => {
  const ny: Partial<PeriodOptions> = { timeZone: NY, now: Date.parse('2026-12-01T17:00:00Z') }

  it('puts every boundary on a local midnight (23- and 25-hour days)', () => {
    const spring = ok({ period: 'day', date: '2026-03-08' }, ny)
    expect(spring).toMatchObject({ since: Date.UTC(2026, 2, 8, 5), until: Date.UTC(2026, 2, 9, 4), label: 'Chủ Nhật, 08/03/2026' })
    expect(spring.until - spring.since).toBe(23 * HOUR)
    const fall = ok({ period: 'day', date: '2026-11-01' }, ny)
    expect(fall.until - fall.since).toBe(25 * HOUR)
    expect(ok({ period: 'week_containing', date: '2026-03-08' }, ny)).toMatchObject({ since: Date.UTC(2026, 2, 2, 5), until: Date.UTC(2026, 2, 9, 4) })
    // "1 ngày qua" means the same wall-clock time yesterday: 13:00 EST → 13:00 EDT is 23 real hours.
    expect(ok({ period: 'last', amount: 1, unit: 'day' }, { ...ny, now: Date.UTC(2026, 2, 8, 17) }).since).toBe(Date.UTC(2026, 2, 7, 18))
  })

  it('splits on local midnights and treats a 31-day month as one window across a DST change', () => {
    const { range, segments } = resolve({ period: 'month', month: '2026-03' }, { ...ny, maxRangeDays: 7 })
    expect(range).toMatchObject({ since: Date.UTC(2026, 2, 1, 5), until: Date.UTC(2026, 3, 1, 4), label: 'Tháng 3/2026' })
    expect(segments[1]).toMatchObject({ since: Date.UTC(2026, 2, 8, 5), until: Date.UTC(2026, 2, 15, 4), label: '08/03 – 14/03/2026' })
    // October in Berlin lasts 31 days and one hour: still a single window.
    const berlin = resolve({ period: 'month', month: '2026-10' }, { timeZone: 'Europe/Berlin', now: Date.parse('2026-12-01T00:00:00Z') })
    expect(berlin.range.until - berlin.range.since).toBe(31 * DAY + HOUR)
    expect(berlin.segments).toHaveLength(1)
  })
})

describe('parseDateTime', () => {
  it('reads explicit offsets and Z as absolute instants', () => {
    expect(parseDateTime('2026-10-06T08:00:00Z', VN)).toBe(Date.UTC(2026, 9, 6, 8))
    expect(parseDateTime('2026-10-06T08:00:00.250+07:00', NY)).toBe(Date.UTC(2026, 9, 6, 1, 0, 0, 250))
    expect(parseDateTime('2026-10-06T08:00-0530', VN)).toBe(Date.UTC(2026, 9, 6, 13, 30))
    expect(parseDateTime('2026-10-06 08:00z', VN)).toBe(Date.UTC(2026, 9, 6, 8))
  })

  it('reads zone-less values as wall-clock time in the given zone', () => {
    expect(parseDateTime('2026-10-06', VN)).toBe(Date.UTC(2026, 9, 5, 17))
    expect(parseDateTime('2026-10-06T08:30', VN)).toBe(Date.UTC(2026, 9, 6, 1, 30))
    expect(parseDateTime('2026-10-06T08:30:15.5', VN)).toBe(Date.UTC(2026, 9, 6, 1, 30, 15, 500))
  })

  it('handles daylight saving time in America/New_York', () => {
    expect(parseDateTime('2026-07-01T12:00', NY)).toBe(Date.UTC(2026, 6, 1, 16)) // EDT
    expect(parseDateTime('2026-12-01T12:00', NY)).toBe(Date.UTC(2026, 11, 1, 17)) // EST
    // Spring forward: 02:30 does not exist and moves forward to 03:30 EDT.
    expect(parseDateTime('2026-03-08T02:30', NY)).toBe(Date.UTC(2026, 2, 8, 7, 30))
    expect(parseDateTime('2026-03-08T01:30', NY)).toBe(Date.UTC(2026, 2, 8, 6, 30))
    // Fall back: 01:30 happens twice; the earlier (EDT) one wins.
    expect(parseDateTime('2026-11-01T01:30', NY)).toBe(Date.UTC(2026, 10, 1, 5, 30))
    expect(parseDateTime('2026-11-01T02:30', NY)).toBe(Date.UTC(2026, 10, 1, 7, 30))
  })

  it('rejects invalid dates and formats', () => {
    for (const value of ['', '2026-02-30', '2026-10-06T24:00', '2026-10-06T08:60', '06/10/2026', '2026-10-6', 'yesterday', '2026-10-06T08:00+25:00']) {
      expect(parseDateTime(value, VN), value).toBeUndefined()
    }
  })
})

describe('formatting', () => {
  it('formats in the zone', () => {
    const instant = Date.UTC(2026, 9, 5, 17, 5)
    expect(formatInZone(instant, VN)).toBe('06/10/2026 00:05')
    expect(formatInZone(instant, VN, 'date')).toBe('06/10/2026')
    expect(formatInZone(instant, VN, 'time')).toBe('00:05')
    expect(formatInZone(instant, NY)).toBe('05/10/2026 13:05')
  })

  it('writes ISO with the zone offset', () => {
    expect(toZonedIso(NOW, VN)).toBe('2026-10-06T11:00:00+07:00')
    expect(toZonedIso(NOW, NY)).toBe('2026-10-06T00:00:00-04:00')
    expect(toZonedIso(Date.UTC(2026, 11, 1, 17), NY)).toBe('2026-12-01T12:00:00-05:00')
    expect(toZonedIso(NOW, 'Asia/Kolkata')).toBe('2026-10-06T09:30:00+05:30')
    expect(toZonedIso(NOW, 'UTC')).toBe('2026-10-06T04:00:00+00:00')
  })

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(toZonedIso(NOW, 'Not/AZone')).toBe('2026-10-06T04:00:00+00:00')
  })
})
