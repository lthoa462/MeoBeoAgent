import { describe, expect, it } from 'vitest'
import { formatInZone, parseDateTime, resolveRange, toZonedIso, type RangeOptions } from '../src/transcript/range.ts'

const VN = 'Asia/Ho_Chi_Minh'
const NY = 'America/New_York'
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 06/10/2026 11:00 in Vietnam. */
const NOW = Date.parse('2026-10-06T04:00:00Z')
const OPTIONS: RangeOptions = { now: NOW, timeZone: VN, maxLookbackDays: 30, defaultLookbackHours: 24 }

const ok = (input: Parameters<typeof resolveRange>[0], options: RangeOptions = OPTIONS) => {
  const result = resolveRange(input, options)
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
  return result.range
}

const error = (input: Parameters<typeof resolveRange>[0], options: RangeOptions = OPTIONS): string => {
  const result = resolveRange(input, options)
  if (result.ok) throw new Error('expected an error')
  return result.error
}

describe('resolveRange', () => {
  it('defaults to the last 24 hours ending now', () => {
    const range = ok({})
    expect(range).toMatchObject({ since: NOW - DAY, until: NOW, defaulted: true, clamped: false })
    expect(range.notes.join(' ')).toMatch(/mặc định 24 giờ/)
    expect(ok({ since: ' ', until: '' })).toMatchObject({ since: NOW - DAY, until: NOW, defaulted: true })
  })

  it('defaults `since` relative to an explicit `until`', () => {
    const range = ok({ until: '2026-10-05T18:00' })
    expect(range.until).toBe(Date.parse('2026-10-05T11:00:00Z'))
    expect(range.since).toBe(range.until - DAY)
  })

  it('moves a future `until` back to now with a note', () => {
    const range = ok({ since: '2026-10-06', until: '2026-10-07T12:00:00Z' })
    expect(range.until).toBe(NOW)
    expect(range.since).toBe(Date.parse('2026-10-05T17:00:00Z'))
    expect(range.notes.join(' ')).toMatch(/tương lai.*06\/10\/2026 11:00/)
  })

  it('clamps `since` to the 30-day limit and says so in Vietnamese', () => {
    const range = ok({ since: '2026-08-01' })
    expect(range.clamped).toBe(true)
    expect(range.since).toBe(NOW - 30 * DAY)
    expect(range.notes).toContain('Chỉ hỗ trợ đọc tối đa 30 ngày gần nhất; đã đổi thời điểm bắt đầu thành 06/09/2026 11:00.')
  })

  it('moves a start just past the limit silently (rounding, not a real clamp)', () => {
    const range = ok({ since: new Date(NOW - 30 * DAY - 59_000).toISOString() })
    expect(range).toMatchObject({ since: NOW - 30 * DAY, clamped: false, notes: [] })
  })

  it('never exceeds the hard 30-day ceiling even if configured higher', () => {
    const range = ok({ since: '2026-01-01' }, { ...OPTIONS, maxLookbackDays: 365 })
    expect(range.since).toBe(NOW - 30 * DAY)
    const shorter = ok({ since: '2026-09-01' }, { ...OPTIONS, maxLookbackDays: 7 })
    expect(shorter.since).toBe(NOW - 7 * DAY)
    expect(shorter.notes.join(' ')).toMatch(/7 ngày/)
  })

  it('rejects windows entirely outside the limit, inverted windows, future starts and garbage', () => {
    expect(error({ since: '2026-07-01', until: '2026-07-15' })).toMatch(/30 ngày/)
    expect(error({ since: '2026-10-05T10:00', until: '2026-10-05T09:00' })).toMatch(/phải trước/)
    expect(error({ since: '2026-10-08' })).toMatch(/tương lai/)
    expect(error({ since: 'hôm qua' })).toMatch(/Không hiểu thời điểm bắt đầu "hôm qua".*ISO 8601/)
    expect(error({ until: '2026-13-01' })).toMatch(/kết thúc/)
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
