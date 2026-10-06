import { describe, expect, it } from 'vitest'
import { DEMO_SOURCE, createDemoFetcher, demoMessages } from '../src/demo/fixture.ts'
import { buildTranscript, transcriptStats } from '../src/transcript/build.ts'
import { normalizeMessages } from '../src/transcript/normalize.ts'
import type { ResolvedRange, TimeRange } from '../src/types.ts'

const DAY = 86_400_000
/** 06/10/2026 11:00 in Vietnam. */
const NOW = Date.parse('2026-10-06T04:00:00Z')
const ALL: TimeRange = { since: NOW - 30 * DAY, until: NOW }

describe('demo fixture', () => {
  it('is deterministic for a given now and stays within the last 12 days', () => {
    const messages = demoMessages(NOW)
    expect(demoMessages(NOW)).toEqual(messages)
    expect(messages.length).toBeGreaterThanOrEqual(110)
    expect(messages.length).toBeLessThanOrEqual(130)
    const times = messages.map(item => Date.parse(item.createdDateTime))
    expect(Math.max(...times)).toBeLessThan(NOW)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - 13 * DAY)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(new Set(messages.map(item => item.id)).size).toBe(messages.length)
    expect(new Set(messages.filter(item => item.from?.user).map(item => item.from?.user?.displayName)).size).toBe(5)
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
    expect(text).not.toMatch(/<[a-z]|&amp;|\{[+-]\d+\}/)
  })

  it('honors the range, keeps the newest maxMessages and reports pages', async () => {
    const fetcher = createDemoFetcher({ now: () => NOW })
    const pages: number[] = []
    const window = await fetcher.fetch(DEMO_SOURCE, { since: NOW - 2 * DAY, until: NOW - DAY }, { maxMessages: 1000, onPage: count => pages.push(count) })
    expect(window.truncated).toBe(false)
    expect(window.messages.length).toBeGreaterThan(0)
    for (const item of window.messages) {
      const time = Date.parse(item.createdDateTime)
      expect(time).toBeGreaterThanOrEqual(NOW - 2 * DAY)
      expect(time).toBeLessThan(NOW - DAY)
    }
    expect(pages.at(-1)).toBe(window.messages.length)

    const all = await fetcher.fetch(DEMO_SOURCE, ALL, { maxMessages: 1000 })
    expect(all.messages).toHaveLength(demoMessages(NOW).length)

    const limited = await fetcher.fetch(DEMO_SOURCE, ALL, { maxMessages: 10 })
    expect(limited.truncated).toBe(true)
    expect(limited.messages.map(item => item.id)).toEqual(all.messages.slice(0, 10).map(item => item.id))
    const newest = Math.max(...demoMessages(NOW).map(item => Date.parse(item.createdDateTime)))
    expect(Date.parse(limited.messages[0]!.createdDateTime)).toBe(newest)
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    controller.abort(new Error('dừng'))
    await expect(createDemoFetcher({ now: () => NOW }).fetch(DEMO_SOURCE, ALL, { maxMessages: 10, signal: controller.signal })).rejects.toThrow('dừng')
  })

  it('runs through the whole transcript pipeline', async () => {
    const range: ResolvedRange = { ...ALL, clamped: false, defaulted: false, notes: [] }
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
