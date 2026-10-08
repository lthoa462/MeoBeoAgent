import { describe, expect, it } from 'vitest'
import { DEMO_SOURCE, createDemoFetcher, demoMessages } from '../src/demo/fixture.ts'
import { buildTranscript, transcriptStats } from '../src/transcript/build.ts'
import { normalizeMessages } from '../src/transcript/normalize.ts'
import { resolvePeriod, type PeriodInput } from '../src/transcript/range.ts'
import type { GraphChatMessage, ResolvedRange, TimeRange } from '../src/types.ts'

const DAY = 86_400_000
const VN = 'Asia/Ho_Chi_Minh'
/** Tuesday 06/10/2026 11:00 in Vietnam. */
const NOW = Date.parse('2026-10-06T04:00:00Z')
const ALL: TimeRange = { since: NOW - 130 * DAY, until: NOW }
/** The dense recent part: from 24/09/2026 00:00 in Vietnam. */
const RECENT: TimeRange = { since: Date.parse('2026-09-23T17:00:00Z'), until: NOW }

const inRange = (messages: readonly GraphChatMessage[], range: TimeRange): GraphChatMessage[] =>
  messages.filter(item => Date.parse(item.createdDateTime) >= range.since && Date.parse(item.createdDateTime) < range.until)

const period = (input: PeriodInput): ResolvedRange => {
  const result = resolvePeriod(input, { now: NOW, timeZone: VN, maxRangeDays: 31, maxPeriodDays: 92, defaultLookbackHours: 24 })
  if (!result.ok) throw new Error(result.error)
  return result.range
}

const textOf = async (range: TimeRange): Promise<string> => {
  const fetched = await createDemoFetcher({ now: () => NOW }).fetch(DEMO_SOURCE, range, { maxMessages: 3000 })
  return normalizeMessages(fetched.messages, { range }).map(item => `${item.author}: ${item.text}`).join('\n')
}

describe('demo fixture', () => {
  it('is deterministic for a given now: dense last 12 days, sparser history back to ~120 days', () => {
    const messages = demoMessages(NOW)
    expect(demoMessages(NOW)).toEqual(messages)
    const recent = inRange(messages, RECENT)
    expect(recent.length).toBeGreaterThanOrEqual(110)
    expect(recent.length).toBeLessThanOrEqual(130)
    expect(messages.length - recent.length).toBeGreaterThanOrEqual(100)
    const times = messages.map(item => Date.parse(item.createdDateTime))
    expect(Math.max(...times)).toBeLessThan(NOW)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - 121 * DAY)
    expect(Math.min(...times)).toBeLessThan(NOW - 115 * DAY)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(new Set(messages.map(item => item.id)).size).toBe(messages.length)
    expect(new Set(messages.filter(item => item.from?.user).map(item => item.from?.user?.displayName)).size).toBe(5)
    // Another clock shifts the whole conversation but keeps its shape.
    const later = demoMessages(NOW + 40 * DAY)
    expect(later.length).toBeGreaterThan(200)
    expect(Date.parse(later[0]!.createdDateTime)).toBeGreaterThanOrEqual(NOW + 40 * DAY - 121 * DAY)
  })

  it('keeps every message in the past early in the morning too', () => {
    const early = Date.parse('2026-10-06T00:30:00Z') // 07:30 in Vietnam, before the scripted morning
    const times = demoMessages(early).map(item => Date.parse(item.createdDateTime))
    expect(Math.max(...times)).toBeLessThan(early)
    expect(Math.max(...times)).toBeGreaterThan(early - DAY)
  })

  it('exercises mentions, files, deletions, system events and HTML', () => {
    const messages = demoMessages(NOW)
    expect(messages.filter(item => item.body?.content?.includes('<at ')).length).toBe(1)
    expect(messages.filter(item => item.mentions?.length).length).toBe(1)
    expect(messages.filter(item => item.attachments?.some(attachment => attachment.contentType === 'reference')).length).toBe(1)
    expect(messages.filter(item => item.deletedDateTime).length).toBe(1)
    expect(messages.filter(item => item.messageType === 'systemEventMessage').length).toBe(1)
    expect(messages.some(item => /<br>/.test(item.body?.content ?? '') && /&amp;/.test(item.body?.content ?? ''))).toBe(true)

    const normalized = normalizeMessages(messages, { range: ALL })
    expect(normalized).toHaveLength(messages.length - 2)
    const text = normalized.map(item => item.text).join('\n')
    expect(text).toContain('@Phạm Đức Huy')
    expect(text).toContain('[tệp: KeHoach_Regression_v2.0.xlsx]')
    expect(text).toContain('Lan & Huy phối hợp')
    expect(text).toContain('chốt ngày release v2.0 là 15/10')
    expect(text).toContain('Thiết kế & test plan: 01/08 → 22/08')
    expect(text).not.toMatch(/<[a-z]|&amp;|\{[a-z+-]/)
  })

  it('has history in old windows: planning in July, a decision in week 2 of August, an incident on 06/09', async () => {
    const week = period({ period: 'week_of_month', month: '2026-08', week: 2 })
    expect(week.label).toBe('Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)')
    const weekText = await textOf(week)
    expect(weekText).toContain('Quyết định: chọn phương án B (đặt lịch 2 bước) và cổng thanh toán PayNow')
    expect(weekText).toMatch(/Việc cần làm sau buổi review:\n- Lan: hoàn thiện thiết kế phương án B – hạn 14\/08\n- Bảo: tích hợp sandbox PayNow – hạn 13\/08/)
    expect(weekText).toContain('Lê Thu Hà: Cho mình hỏi: thanh toán thất bại thì app hiển thị gì?')

    const sunday = await textOf(period({ period: 'day', date: '2026-09-06' }))
    expect(sunday.split('\n')).toHaveLength(4)
    expect(sunday).toContain('chứng chỉ SSL của API xác thực hết hạn')

    const july = await textOf(period({ period: 'month', month: '2026-07' }))
    expect(july).toContain('Kickoff v2.0')
    expect(july).toContain('Quyết định: v2.0 chỉ hỗ trợ iOS 16 và Android 10 trở lên')
    expect(july.split('\n').length).toBeGreaterThan(30)

    // Most working days have a few messages; weekends stay quiet unless something happened.
    for (const date of ['2026-06-09', '2026-08-20', '2026-09-08']) expect((await textOf(period({ period: 'day', date }))).length, date).toBeGreaterThan(0)
    expect(await textOf(period({ period: 'day', date: '2026-08-22' }))).toBe('')
  })

  it('honors the range, keeps the newest maxMessages and reports pages', async () => {
    const fetcher = createDemoFetcher({ now: () => NOW })
    const pages: Array<[number, number | undefined]> = []
    const window = await fetcher.fetch(DEMO_SOURCE, { since: NOW - 2 * DAY, until: NOW - DAY }, { maxMessages: 1000, onPage: (count, back) => pages.push([count, back]) })
    expect(window).toMatchObject({ truncated: false, scanLimited: false })
    expect(window.messages.length).toBeGreaterThan(0)
    for (const item of window.messages) {
      const time = Date.parse(item.createdDateTime)
      expect(time).toBeGreaterThanOrEqual(NOW - 2 * DAY)
      expect(time).toBeLessThan(NOW - DAY)
    }
    expect(pages).toHaveLength(1)
    expect(pages[0]?.[0]).toBe(window.messages.length)
    // The scan stopped at the first message before the window.
    expect(pages[0]?.[1]).toBe(window.scannedBackTo)
    expect(window.scannedBackTo).toBeLessThan(NOW - 2 * DAY)
    expect(window.scannedBackTo).toBeGreaterThan(NOW - 3 * DAY)

    const all = await fetcher.fetch(DEMO_SOURCE, ALL, { maxMessages: 1000 })
    expect(all.messages).toHaveLength(demoMessages(NOW).length)
    expect(all.scannedBackTo).toBe(ALL.since)

    const limited = await fetcher.fetch(DEMO_SOURCE, ALL, { maxMessages: 10 })
    expect(limited.truncated).toBe(true)
    expect(limited.messages.map(item => item.id)).toEqual(all.messages.slice(0, 10).map(item => item.id))
    const newest = Math.max(...demoMessages(NOW).map(item => Date.parse(item.createdDateTime)))
    expect(Date.parse(limited.messages[0]!.createdDateTime)).toBe(newest)
  })

  it('pages back from now and stops at maxScanPages before reaching an old window', async () => {
    const fetcher = createDemoFetcher({ now: () => NOW })
    const week = period({ period: 'week_of_month', month: '2026-08', week: 2 })
    const newestFirst = demoMessages(NOW).reverse()
    const pages: Array<[number, number | undefined]> = []

    const limited = await fetcher.fetch(DEMO_SOURCE, week, { maxMessages: 1000, maxScanPages: 2, onPage: (count, back) => pages.push([count, back]) })
    const at = (index: number): number => Date.parse(newestFirst[index]!.createdDateTime)
    expect(limited).toEqual({ messages: [], truncated: true, scanLimited: true, scannedBackTo: at(99) })
    expect(pages).toEqual([[0, at(49)], [0, at(99)]])

    const full = await fetcher.fetch(DEMO_SOURCE, week, { maxMessages: 1000, maxScanPages: 200 })
    expect(full).toMatchObject({ truncated: false, scanLimited: false })
    expect(full.messages.length).toBeGreaterThan(10)
    expect(full.scannedBackTo).toBeLessThan(week.since)
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    controller.abort(new Error('dừng'))
    await expect(createDemoFetcher({ now: () => NOW }).fetch(DEMO_SOURCE, ALL, { maxMessages: 10, signal: controller.signal })).rejects.toThrow('dừng')
  })

  it('runs through the whole transcript pipeline', async () => {
    const range: ResolvedRange = { ...RECENT, label: '24/09 – 06/10/2026', clamped: false, defaulted: false, notes: [] }
    const transcript = await buildTranscript(
      { source: DEMO_SOURCE, fetcher: createDemoFetcher({ now: () => NOW }), timeZone: 'Asia/Ho_Chi_Minh', now: NOW },
      range,
      { maxMessages: 3000, chunkTokens: 1000 },
    )
    expect(transcript.chunks.length).toBeGreaterThan(1)
    expect(transcript.chunks[0]?.text.startsWith('[#1 24/09 09:02] Nguyễn Minh Anh: Chào cả nhà!')).toBe(true)
    const stats = transcriptStats(transcript)
    expect([...stats.participants].sort()).toEqual(['Lê Thu Hà', 'Nguyễn Minh Anh', 'Phạm Đức Huy', 'Trần Quốc Bảo', 'Võ Ngọc Lan'])
    expect(stats.messageCount).toBe(transcript.messages.length)
  })
})
