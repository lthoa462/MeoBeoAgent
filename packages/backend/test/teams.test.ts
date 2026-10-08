import { afterEach, describe, expect, it, vi } from 'vitest'
import { readConfig } from '../src/config.ts'
import { createApiApp } from '../src/http/app.ts'
import { createServices, type AppServices } from '../src/services.ts'
import { createPrivateLogger, createTeamsBot, type TeamsBot, type TeamsBotOptions } from '../src/teams/bot.ts'
import {
  extractPrompt, isEntraIssuedToken, isTrustedServiceUrl, parseTeamsActivity, resolveTeamsSource, type TeamsActivityLike,
} from '../src/teams/context.ts'
import {
  BUSY_TEXT, FOREIGN_TENANT_TEXT, INITIAL_PROGRESS, PLACEHOLDER_TEXT, createEditThrottle, finalText, personalHelpText, progressText, reduceProgress,
  shortHelpText, truncateForTeams, welcomeText, type ProgressState,
} from '../src/teams/format.ts'
import type { TranscriptStats } from '../src/types.ts'
import type { WireEvent } from '../src/wire.ts'
import { createFakeFetch, json, message, HOUR, type FakeFetch } from './fakes/graph.ts'

const ZONE = 'Asia/Ho_Chi_Minh'
const BOT = { id: '28:bot-app-id', name: 'MeoBeo' }
const TEAM_GUID = '0f3c9b2e-1111-4a5b-9c8d-123456789abc'
const MENTION = { type: 'mention', text: '<at>MeoBeo</at>', mentioned: BOT }

function groupMessage(overrides: Partial<TeamsActivityLike> & Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: 'in-1',
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    text: '<at>MeoBeo</at> tóm tắt 3 ngày qua',
    from: { id: '29:user-an', name: 'An', aadObjectId: 'aad-an' },
    recipient: BOT,
    conversation: { id: '19:group@thread.v2', conversationType: 'groupChat', tenantId: 'tenant-conv', name: 'Dự án Mèo' },
    channelData: { tenant: { id: 'contoso.onmicrosoft.com' } },
    entities: [MENTION],
    localTimezone: ZONE,
    ...overrides,
  }
}

function channelMessage(team: Record<string, string> = { id: '19:team@thread.tacv2', name: 'Kỹ thuật', aadGroupId: TEAM_GUID }) {
  return groupMessage({
    conversation: { id: '19:chan@thread.tacv2;messageid=1700000000000', conversationType: 'channel' },
    channelData: { tenant: { id: 'contoso.onmicrosoft.com' }, team, channel: { id: '19:chan@thread.tacv2', name: 'Deploy' } },
  })
}

describe('parseTeamsActivity', () => {
  it('reads a group chat mention: chat id, prompt without the bot mention, tenant and zone', () => {
    const info = parseTeamsActivity(groupMessage())
    expect(info).toEqual({
      kind: 'summarize',
      scope: 'groupChat',
      botName: 'MeoBeo',
      prompt: 'tóm tắt 3 ngày qua',
      conversationId: '19:group@thread.v2',
      tenantId: 'contoso.onmicrosoft.com',
      timeZone: ZONE,
      target: { kind: 'chat', chatId: '19:group@thread.v2', label: 'Dự án Mèo' },
    })
  })

  it('ignores group messages that do not mention the bot', () => {
    expect(parseTeamsActivity(groupMessage({ entities: [] }))).toEqual({ kind: 'ignore' })
    const otherMention = { type: 'mention', text: '<at>Nam</at>', mentioned: { id: '29:nam', name: 'Nam' } }
    expect(parseTeamsActivity(groupMessage({ text: '<at>Nam</at> ơi', entities: [otherMention] }))).toEqual({ kind: 'ignore' })
  })

  it('ignores bots, itself and non-message activities', () => {
    expect(parseTeamsActivity(groupMessage({ from: { id: '28:other-bot', name: 'Bot' } })).kind).toBe('ignore')
    expect(parseTeamsActivity(groupMessage({ from: { id: '29:x', role: 'bot' } })).kind).toBe('ignore')
    expect(parseTeamsActivity(groupMessage({ from: BOT })).kind).toBe('ignore')
    expect(parseTeamsActivity(groupMessage({ type: 'typing' })).kind).toBe('ignore')
  })

  it('answers personal chats with or without a mention', () => {
    const personal = { conversation: { id: 'a:personal', conversationType: 'personal' }, entities: [], text: 'xin chào' }
    expect(parseTeamsActivity(groupMessage(personal))).toEqual({ kind: 'personal', botName: 'MeoBeo', prompt: 'xin chào' })
  })

  it('reads a channel thread with the Graph team id from channelData', () => {
    const info = parseTeamsActivity(channelMessage())
    expect(info).toMatchObject({
      kind: 'summarize',
      scope: 'channel',
      conversationId: '19:chan@thread.tacv2;messageid=1700000000000',
      target: { kind: 'channel', channelId: '19:chan@thread.tacv2', teamId: TEAM_GUID, teamKey: '19:team@thread.tacv2', label: 'Kỹ thuật › Deploy' },
    })
  })

  it('resolves a channel team id through the lookup only when aadGroupId is missing', async () => {
    const lookup = vi.fn(async (_teamKey: string) => TEAM_GUID)
    const withId = parseTeamsActivity(channelMessage())
    if (withId.kind !== 'summarize') throw new Error('expected summarize')
    expect(await resolveTeamsSource(withId.target, lookup)).toEqual({ kind: 'channel', teamId: TEAM_GUID, channelId: '19:chan@thread.tacv2', label: 'Kỹ thuật › Deploy' })
    expect(lookup).not.toHaveBeenCalled()

    const withoutId = parseTeamsActivity(channelMessage({ id: '19:team@thread.tacv2' }))
    if (withoutId.kind !== 'summarize') throw new Error('expected summarize')
    expect(await resolveTeamsSource(withoutId.target, lookup)).toEqual({ kind: 'channel', teamId: TEAM_GUID, channelId: '19:chan@thread.tacv2', label: 'Deploy' })
    expect(lookup).toHaveBeenCalledWith('19:team@thread.tacv2')

    expect(await resolveTeamsSource(withoutId.target, async () => undefined)).toBeUndefined()
    expect(await resolveTeamsSource(withoutId.target, async () => '../../users')).toBeUndefined()
  })

  it('falls back to the default zone for unknown zones, and to the conversation tenant', () => {
    const info = parseTeamsActivity(groupMessage({ localTimezone: 'Mars/Olympus', channelData: {} }))
    expect(info).toMatchObject({ timeZone: undefined, tenantId: 'tenant-conv' })
  })

  it('flags conversations it cannot read', () => {
    expect(parseTeamsActivity(groupMessage({ conversation: { id: '19:x@thread.v2', conversationType: 'meetingSomething' } })).kind).toBe('unsupported')
    expect(parseTeamsActivity(groupMessage({ conversation: { id: '19:x/../me', conversationType: 'groupChat' } })).kind).toBe('unsupported')
  })

  it('keeps other people’s mentions and strips markup from the prompt', () => {
    const nam = { type: 'mention', text: '<at>Nam Trần</at>', mentioned: { id: '29:nam', name: 'Nam Trần' } }
    const activity = groupMessage({
      text: '<p><at>MeoBeo</at>&nbsp;tuần này <at>Nam Trần</at> làm gì &amp; còn việc gì?</p>',
      entities: [MENTION, nam],
    })
    expect(extractPrompt(activity)).toBe('tuần này @Nam Trần làm gì & còn việc gì?')
    expect(extractPrompt(groupMessage({ text: '<at>MeoBeo</at>' }))).toBe('')
  })
})

describe('inbound trust', () => {
  const jwt = (payload: object): string => `Bearer e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

  it('accepts only Microsoft Bot Framework service URLs (and loopback for local tools)', () => {
    for (const url of [
      'https://smba.trafficmanager.net/teams/', 'https://smba.trafficmanager.net/amer/', 'https://directline.botframework.com/',
      'https://smba.infra.gcc.teams.microsoft.com/teams', 'http://localhost:56150', 'http://127.0.0.1:3978/',
    ]) expect(isTrustedServiceUrl(url), url).toBe(true)
    for (const url of [
      undefined, '', 'not a url', 'https://attacker.example/collect/', 'http://smba.trafficmanager.net/teams/',
      'https://smba.trafficmanager.net.attacker.example/', 'https://evilbotframework.com/', 'https://u:p@smba.trafficmanager.net/',
      'https://teams.microsoft.com.attacker.example/', 'file:///etc/passwd',
    ]) expect(isTrustedServiceUrl(url), String(url)).toBe(false)
  })

  it('recognizes Entra-issued tokens, which the bot never accepts', () => {
    expect(isEntraIssuedToken(jwt({ iss: 'https://login.microsoftonline.com/tenant/v2.0', aud: 'app' }))).toBe(true)
    expect(isEntraIssuedToken(jwt({ iss: 'https://sts.windows.net/tenant/' }))).toBe(true)
    expect(isEntraIssuedToken(jwt({ iss: 'https://api.botframework.com' }))).toBe(false)
    for (const header of [undefined, '', 'Bearer', 'Bearer a.b.c', 'Bearer x.%%%.y', jwt({})]) expect(isEntraIssuedToken(header)).toBe(false)
  })
})

describe('progress text', () => {
  const stats: TranscriptStats = {
    transcriptId: 't_1', label: 'Tháng 10/2026 (đến hiện tại)', messageCount: 340, participants: ['An', 'Bình'],
    since: '2026-10-01T00:00:00+07:00', until: '2026-10-06T11:00:00+07:00', chunkCount: 8, truncated: false, scanLimited: false, clamped: true, notes: [],
  }
  const month = (id: string, month: number, messageCount: number): TranscriptStats => ({
    ...stats,
    transcriptId: id,
    label: `Tháng ${month}/2026`,
    messageCount,
    since: `2026-${String(month).padStart(2, '0')}-01T00:00:00+07:00`,
    until: `2026-${String(month + 1).padStart(2, '0')}-01T00:00:00+07:00`,
    clamped: false,
  })

  function fold(events: readonly WireEvent[], from = INITIAL_PROGRESS): ProgressState {
    return events.reduce(reduceProgress, from)
  }

  it('summarizes the turn so far on one line', () => {
    expect(progressText(INITIAL_PROGRESS, ZONE)).toBe(PLACEHOLDER_TEXT)
    expect(progressText(fold([{ t: 'fetch-progress', fetched: 150 }]), ZONE)).toBe('⏳ Đang đọc tin nhắn… (đã tải 150)')
    const state = fold([
      { t: 'tool-call', callId: 'l1', name: 'load_messages', input: { period: 'month', month: '2026-10' } },
      { t: 'fetch-progress', fetched: 340, scannedBackTo: '2026-10-01T08:00:00+07:00' },
      { t: 'transcript', stats },
      { t: 'tool-result', callId: 'l1', name: 'load_messages', status: 'completed', isError: false },
      { t: 'tool-call', callId: 'c1', name: 'summarize_messages', input: {} },
      { t: 'tool-call', callId: 'c2', name: 'extract_action_items', input: {} },
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 3, total: 8 },
      { t: 'agent-progress', agent: 'action-tracker', stage: 'map', done: 2, total: 8 },
    ])
    expect(progressText(state, ZONE)).toBe('⏳ Đã đọc 340 tin nhắn — Tháng 10/2026 (đến hiện tại) · Tóm tắt 3/8 phần · Việc cần làm 2/8 phần')
    const later = [
      { t: 'agent-progress', agent: 'summarizer', stage: 'reduce', done: 0, total: 1 },
      { t: 'tool-result', callId: 'c2', name: 'extract_action_items', status: 'completed', isError: false },
      { t: 'text-delta', text: 'Tóm', blockId: 'b1' },
    ] as const satisfies readonly WireEvent[]
    expect(progressText(fold(later, state), ZONE))
      .toBe('⏳ Đã đọc 340 tin nhắn — Tháng 10/2026 (đến hiện tại) · Tóm tắt: đang tổng hợp · Việc cần làm ✓ · Đang viết câu trả lời…')
  })

  it('shows how far back a channel scan has reached, in the reader\'s zone', () => {
    const state = fold([{ t: 'fetch-progress', fetched: 12, scannedBackTo: '2026-08-19T23:30:00Z' }])
    expect(progressText(state, ZONE)).toBe('⏳ Đang đọc tin nhắn… (đã tải 12 · đang quét tới 20/08)')
    expect(progressText(fold([{ t: 'fetch-progress', fetched: 0, scannedBackTo: 'không phải ngày' }]), ZONE)).toBe('⏳ Đang đọc tin nhắn… (đã tải 0)')
  })

  it('lists the segments of a split period: done ones with their count, running ones with their scan', () => {
    const loads = ['l7', 'l8', 'l9'].map(callId => ({ t: 'tool-call', callId, name: 'load_messages', input: {} }) as const)
    const state = fold([
      ...loads,
      { t: 'fetch-progress', fetched: 100, scannedBackTo: '2026-09-20T10:00:00+07:00', segment: 'Tháng 9/2026' },
      { t: 'fetch-progress', fetched: 50, scannedBackTo: '2026-09-25T10:00:00+07:00', segment: 'Tháng 8/2026' },
      { t: 'fetch-progress', fetched: 340, segment: 'Tháng 7/2026' },
      { t: 'fetch-progress', fetched: 180, scannedBackTo: '2026-09-01T00:00:00+07:00', segment: 'Tháng 9/2026' },
      { t: 'transcript', stats: month('t9', 9, 180) },
      { t: 'transcript', stats: month('t7', 7, 340) },
    ])
    expect(progressText(state, ZONE)).toBe(
      '⏳ Tháng 7/2026 ✓ 340 tin · Tháng 9/2026 ✓ 180 tin · Đang đọc Tháng 8/2026… (đã tải 50 · đang quét tới 25/09) · Khoảng dài được đọc lần lượt từng phần nên sẽ lâu hơn',
    )
    // The first finished segment is already shown as a segment.
    const first = fold([
      { t: 'fetch-progress', fetched: 40, segment: 'Tháng 7/2026' },
      { t: 'transcript', stats: month('t7', 7, 40) },
    ])
    expect(progressText(first, ZONE)).toBe('⏳ Tháng 7/2026 ✓ 40 tin')
    // Parallel specialist calls (one per segment) are counted rather than mixed together.
    const summarizing = fold([
      { t: 'transcript', stats: month('t8', 8, 500) },
      ...['s7', 's8', 's9'].map(callId => ({ t: 'tool-call', callId, name: 'summarize_messages', input: {} }) as const),
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 1, total: 4 },
      { t: 'tool-result', callId: 's8', name: 'summarize_messages', status: 'completed', isError: false },
    ], state)
    expect(progressText(summarizing, ZONE)).toBe('⏳ Tháng 7/2026 ✓ 340 tin · Tháng 8/2026 ✓ 500 tin · Tháng 9/2026 ✓ 180 tin · Tóm tắt: xong 1/3')
    const finished = fold(['s7', 's9'].map(callId => ({ t: 'tool-result', callId, name: 'summarize_messages', status: 'completed', isError: false }) as const), summarizing)
    expect(progressText(finished, ZONE)).toContain('Tóm tắt ✓')
  })

  it('sums up long splits, drops a failed read and keeps one entry per transcript', () => {
    const year = Array.from({ length: 6 }, (_, index) => month(`m${index}`, index + 1, 10))
    expect(progressText(fold(year.map(item => ({ t: 'transcript', stats: item }) as const)), ZONE)).toBe('⏳ Đã đọc 60 tin nhắn từ 6 khoảng')

    const failed = fold([
      { t: 'tool-call', callId: 'l1', name: 'load_messages', input: {} },
      { t: 'fetch-progress', fetched: 50 },
      { t: 'tool-result', callId: 'l1', name: 'load_messages', status: 'completed', isError: false },
    ])
    expect(failed.reading).toEqual([])
    expect(progressText(failed, ZONE)).toBe(PLACEHOLDER_TEXT)

    const again = fold([{ t: 'transcript', stats }, { t: 'transcript', stats }])
    expect(again.transcripts).toHaveLength(1)
  })

  it('falls back to the window bounds when a label is missing; an exclusive midnight end shows the day before', () => {
    const day = { ...stats, label: '', since: '2026-10-05T00:00:00+07:00', until: '2026-10-06T00:00:00+07:00', messageCount: 0 }
    expect(progressText(fold([{ t: 'transcript', stats: day }]), ZONE)).toBe('⏳ Không có tin nhắn nào — 05/10')
  })

  it('ignores events that do not change the line', () => {
    const state = fold([{ t: 'transcript', stats }])
    expect(reduceProgress(state, { t: 'tool-call', callId: 'x', name: 'other_tool', input: {} })).toBe(state)
    expect(reduceProgress(state, { t: 'tool-result', callId: 'x', name: 'summarize_messages', status: 'completed', isError: false })).toBe(state)
    expect(reduceProgress(state, { t: 'commentary', text: 'Đang xem…', blockId: 'b' })).toBe(state)
  })
})

describe('edit throttle', () => {
  it('lets a changed text through at most once per interval', () => {
    let now = 1_000
    const throttle = createEditThrottle({ intervalMs: 3_000, now: () => now })
    throttle.shown('a')
    expect(throttle.ready('b')).toBe(false)
    now += 2_999
    expect(throttle.ready('b')).toBe(false)
    now += 1
    expect(throttle.ready('a')).toBe(false)
    expect(throttle.ready('b')).toBe(true)
    throttle.shown('b')
    expect(throttle.ready('c')).toBe(false)
  })
})

describe('reply size', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length

  it('leaves normal answers alone', () => {
    expect(truncateForTeams('Xin chào')).toBe('Xin chào')
  })

  it('caps long ASCII answers by characters and multi-byte answers by bytes', () => {
    const ascii = truncateForTeams('line of text\n'.repeat(3_000))
    expect(ascii.length).toBeLessThanOrEqual(25_000)
    expect(ascii).toContain('rút gọn')
    const vietnamese = truncateForTeams('Đã quyết định triển khai bản phát hành mới. '.repeat(1_000))
    expect(bytes(vietnamese)).toBeLessThanOrEqual(24_000)
    expect(vietnamese).toContain('rút gọn')
  })

  it('never splits a surrogate pair', () => {
    const capped = truncateForTeams('😺'.repeat(10_000), 1_000)
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(bytes(capped)).toBeLessThanOrEqual(1_000)
  })

  const read = (overrides: Partial<TranscriptStats> = {}): TranscriptStats => ({
    transcriptId: 't', label: '2 ngày qua (05/10/2026 00:00 → 06/10/2026 10:00)', messageCount: 12, participants: [],
    since: '2026-10-05T00:00:00+07:00', until: '2026-10-06T10:00:00+07:00', chunkCount: 1, truncated: false, scanLimited: false, clamped: false, notes: [],
    ...overrides,
  })

  it('adds what was read under the final answer, within the cap', () => {
    const cut = read({ truncated: true })
    const text = finalText('**Tóm tắt**', [cut], ZONE)
    expect(text).toContain('**Tóm tắt**')
    expect(text).toContain('_Dựa trên 12 tin nhắn — 2 ngày qua (05/10/2026 00:00 → 06/10/2026 10:00); chưa đọc hết khoảng thời gian vì quá nhiều tin nhắn._')
    expect(bytes(finalText('ạ'.repeat(30_000), [cut], ZONE))).toBeLessThanOrEqual(24_000)
    expect(finalText('Không có gì.', [read({ messageCount: 0 })], ZONE)).toBe('Không có gì.')
    expect(finalText('Xin chào', [], ZONE)).toBe('Xin chào')
    expect(finalText('A', [read({ truncated: true, scanLimited: true })], ZONE))
      .toContain('; chưa quét tới đầu khoảng thời gian (chạm giới hạn quét)._')
  })

  it('never lets an injected image load when the reply is shown', () => {
    const answer = 'Xem ![sơ đồ](https://evil.example/p.png?d=bí-mật) và ![][r] <img src="https://evil.example/a.png"> <IMG/src=x> <svg onload=x>\n[r]: https://evil.example/r.png\n[tài liệu](https://docs.example/x)'
    const text = finalText(answer, [], ZONE)
    expect(text).not.toMatch(/!\[|<img|<svg/i)
    expect(text).toContain('[sơ đồ](https://evil.example/p.png?d=bí-mật)')
    expect(text).toContain('[tài liệu](https://docs.example/x)')
  })

  it('sums the segments of a split period in date order and names the incomplete ones', () => {
    const month = (id: string, m: number, messageCount: number, extra: Partial<TranscriptStats> = {}) => read({
      transcriptId: id, label: `Tháng ${m}/2026`, messageCount, since: `2026-0${m}-01T00:00:00+07:00`, until: `2026-0${m + 1}-01T00:00:00+07:00`, ...extra,
    })
    const quarter = [month('t9', 9, 180), month('t7', 7, 340, { truncated: true, scanLimited: true }), month('t8', 8, 500)]
    expect(finalText('Quý 3', quarter, ZONE)).toBe(
      'Quý 3\n\n_Dựa trên 1020 tin nhắn — Tháng 7/2026: 340 · Tháng 8/2026: 500 · Tháng 9/2026: 180; chưa quét tới đầu Tháng 7/2026 (chạm giới hạn quét)._',
    )
    const half = [3, 4, 5, 6, 7, 8].map(m => month(`h${m}`, m, 10))
    expect(finalText('Nửa năm', half, ZONE)).toContain('_Dựa trên 60 tin nhắn — 6 khoảng, Tháng 3/2026 → Tháng 8/2026._')
  })
})

describe('help texts', () => {
  const limits = { maxRangeDays: 31, maxPeriodDays: 92 }

  it('explains how to use the bot, what can be read and the web app', () => {
    const text = personalHelpText({ botName: 'MeoBeo', ...limits, webUrl: 'https://meobeo.example.com' })
    for (const example of ['tóm tắt 3 ngày qua', 'tóm tắt ngày 6/9', 'tuần thứ 2 tháng 8 có quyết định gì?', 'tóm tắt quý 3', 'ai đang phụ trách việc deploy?']) {
      expect(text).toContain(`\`@MeoBeo ${example}\``)
    }
    expect(text).toContain('bất kỳ ngày, tuần hay tháng nào trong quá khứ')
    expect(text).toContain('6/9 là ngày 6 tháng 9')
    expect(text).toContain('Mỗi lần đọc tối đa 31 ngày; khoảng dài hơn (tối đa 92 ngày) được chia theo từng tháng')
    expect(text).toContain('không lưu lại nội dung')
    expect(text).not.toMatch(/30 ngày|gần nhất/u)
    expect(text).toContain('https://meobeo.example.com')
    expect(personalHelpText({ botName: 'MeoBeo', ...limits })).not.toContain('http')
  })

  it('adapts the examples and rules to the configured limits', () => {
    const short = shortHelpText({ botName: 'Mèo', maxRangeDays: 7, maxPeriodDays: 7 })
    expect(short).toContain('@Mèo tóm tắt 24 giờ qua')
    expect(short).toContain('@Mèo tóm tắt ngày 6/9')
    expect(short).toContain('Mỗi lần đọc tối đa 7 ngày.')
    expect(short).not.toContain('quý 3')
    expect(short).not.toContain('chia theo')
    const welcome = welcomeText({ botName: 'MeoBeo', ...limits })
    expect(welcome).toContain('Chào mọi người')
    expect(welcome).toContain('@MeoBeo tuần thứ 2 tháng 8 có quyết định gì?')
    expect(welcome).toContain('tối đa 92 ngày')
  })
})

describe('SDK logger', () => {
  it('prints warnings and errors as strings only, never objects or debug output', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const logger = createPrivateLogger('teams').child('http')
    logger.debug('Handling activity', { text: 'bí mật' })
    logger.info('started')
    logger.error('Error processing activity:', new TypeError('chứa nội dung bí mật'), { text: 'bí mật' })
    logger.warn('JWT\nvalidation failed')
    expect(debug).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('[meobeo/teams/http] Error processing activity: TypeError')
    expect(warn).toHaveBeenCalledWith('[meobeo/teams/http] JWT validation failed')
    error.mockRestore()
    warn.mockRestore()
    debug.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// End to end through the real Teams SDK App: inbound activities go through the
// captured messaging handler; outbound Bot Connector calls are answered by an
// HTTP-client middleware instead of the network.

interface ConnectorCall {
  readonly method: string
  readonly url: string
  readonly data: { readonly type?: string; readonly text?: string; readonly id?: string } | undefined
}

const silentLogger = (() => {
  const ignore = (): void => undefined
  const logger = { loggerOptions: {}, error: ignore, warn: ignore, info: ignore, debug: ignore, trace: ignore, log: ignore, child: () => logger }
  return logger
})()

function fakeConnector(options: { readonly ids?: boolean } = {}) {
  const calls: ConnectorCall[] = []
  let next = 0
  const middleware = {
    async invoke(context: { config: { method?: string; url?: string; data?: unknown } }) {
      const { config } = context
      calls.push({ method: (config.method ?? '').toUpperCase(), url: config.url ?? '', data: config.data as ConnectorCall['data'] })
      const data = config.url?.includes('/v3/teams/')
        ? { id: '19:team@thread.tacv2', aadGroupId: TEAM_GUID }
        : options.ids === false ? {} : { id: `act-${++next}` }
      return { data, status: 200, statusText: 'OK', headers: {}, config }
    },
  }
  return { calls, client: { middlewares: [middleware] } as unknown as TeamsBotOptions['client'] }
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface BotHarness {
  readonly bot: TeamsBot
  readonly services: AppServices
  readonly calls: ConnectorCall[]
  readonly graph: FakeFetch
  readonly tokens: string[]
}

async function botHarness(env: Record<string, string> = { LLM_PROVIDER: 'mock' }, mockDelayMs = 0, connector = fakeConnector()): Promise<BotHarness> {
  const now = Date.now()
  const graph = createFakeFetch(url => {
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/messages')) {
      return json({ value: Array.from({ length: 5 }, (_, index) => message(now - (index + 1) * HOUR, { body: { contentType: 'text', content: `Cập nhật ${index}` } })) })
    }
    return undefined
  })
  const base = await createServices({ config: readConfig(env), graphFetch: graph.fetch, llm: { mock: { delayMs: mockDelayMs } } })
  const tokens: string[] = []
  // The bot needs app-only tokens; the real provider would call login.microsoftonline.com.
  const services: AppServices = { ...base, appTokens: tenant => async () => { tokens.push(tenant); return 'app-token' } }
  const { calls, client } = connector
  const bot = await createTeamsBot(services, { client, dangerouslyAllowUnauthenticatedRequests: true, logger: silentLogger, progressIntervalMs: 0 })
  cleanups.push(async () => { await bot.close(); await base.close() })
  return { bot, services, calls, graph, tokens }
}

const messagesPosted = (calls: readonly ConnectorCall[]) => calls.filter(call => call.data?.type === 'message')

describe('Teams bot end to end', () => {
  it('ignores group messages without a mention: no reply, no Graph read', async () => {
    const { bot, calls, graph } = await botHarness()
    const response = await bot.handle({ body: groupMessage({ entities: [], text: 'chuyện riêng' }), headers: {} })
    expect(response.status).toBe(200)
    await bot.idle()
    expect(calls).toEqual([])
    expect(graph.requests).toEqual([])
  })

  it('answers a mention: placeholder first, then the same message edited into the summary', async () => {
    const { bot, calls, graph, tokens } = await botHarness()
    const response = await bot.handle({ body: groupMessage(), headers: {} })
    expect(response.status).toBe(200)
    await bot.idle()

    const conversationUrl = 'https://smba.trafficmanager.net/teams/v3/conversations/19:group@thread.v2/activities'
    expect(calls[0]).toMatchObject({ method: 'POST', url: conversationUrl, data: { type: 'typing' } })
    const posted = calls.filter(call => call.method === 'POST' && call.data?.type === 'message')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.data?.text).toBe(PLACEHOLDER_TEXT)
    const edits = calls.filter(call => call.method === 'PUT')
    expect(edits.length).toBeGreaterThan(1)
    expect(edits.every(call => call.url === `${conversationUrl}/act-2` && call.data?.id === 'act-2')).toBe(true)
    expect(edits.some(call => call.data?.text?.startsWith('⏳ Đã đọc 5 tin nhắn'))).toBe(true)
    const final = edits.at(-1)?.data?.text ?? ''
    expect(final).not.toMatch(/^⏳/)
    expect(final).toContain('Dựa trên 5 tin nhắn')

    // Graph read with the app-only token of the activity's tenant, for the chat the activity came from.
    expect(tokens).toContain('contoso.onmicrosoft.com')
    expect(graph.paths()).toEqual(['/chats/19:group@thread.v2/messages'])
    expect(graph.requests.every(request => request.headers.get('authorization') === 'Bearer app-token')).toBe(true)
  })

  it('posts the answer as a new message when the placeholder has no id to edit', async () => {
    const { bot, calls } = await botHarness(undefined, 0, fakeConnector({ ids: false }))
    await bot.handle({ body: groupMessage(), headers: {} })
    await bot.idle()
    expect(calls.filter(call => call.method === 'PUT')).toEqual([])
    const texts = messagesPosted(calls).map(call => call.data?.text ?? '')
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe(PLACEHOLDER_TEXT)
    expect(texts[1]).toContain('Dựa trên 5 tin nhắn')
  })

  it('looks up the Graph team id of a channel and replies in the thread', async () => {
    const { bot, calls, graph } = await botHarness()
    await bot.handle({ body: channelMessage({ id: '19:team@thread.tacv2', name: 'Kỹ thuật' }), headers: {} })
    await bot.idle()
    expect(calls.some(call => call.method === 'GET' && call.url === 'https://smba.trafficmanager.net/teams/v3/teams/19:team@thread.tacv2')).toBe(true)
    expect(graph.paths()[0]).toBe(`/teams/${TEAM_GUID}/channels/19:chan@thread.tacv2/messages`)
    const threadUrl = 'https://smba.trafficmanager.net/teams/v3/conversations/19:chan@thread.tacv2;messageid=1700000000000/activities'
    expect(messagesPosted(calls).every(call => call.url.startsWith(threadUrl))).toBe(true)
  })

  it('tells a second request in the same conversation to wait', async () => {
    const { bot, calls } = await botHarness({ LLM_PROVIDER: 'mock' }, 100)
    await bot.handle({ body: groupMessage(), headers: {} })
    await bot.handle({ body: groupMessage({ id: 'in-2' }), headers: {} })
    await bot.idle()
    expect(messagesPosted(calls).some(call => call.data?.text === BUSY_TEXT)).toBe(true)
  })

  it('replies with help in personal chats and to a bare mention, without reading anything', async () => {
    const { bot, calls, graph } = await botHarness()
    await bot.handle({ body: groupMessage({ conversation: { id: 'a:1on1', conversationType: 'personal' }, entities: [], text: 'hi' }), headers: {} })
    await bot.handle({ body: groupMessage({ text: '<at>MeoBeo</at>' }), headers: {} })
    await bot.idle()
    const texts = messagesPosted(calls).map(call => call.data?.text ?? '')
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('@MeoBeo tóm tắt 3 ngày qua')
    expect(texts[1]).toContain('Bạn muốn mình làm gì?')
    expect(graph.requests).toEqual([])
  })

  it('explains a missing LLM configuration instead of failing silently', async () => {
    const { bot, calls } = await botHarness({ LLM_PROVIDER: 'openai' })
    await bot.handle({ body: groupMessage(), headers: {} })
    await bot.idle()
    expect(messagesPosted(calls).map(call => call.data?.text)).toEqual([expect.stringContaining('OPENAI_API_KEY')])
  })

  it('welcomes people when the app is added to a group chat', async () => {
    const { bot, calls } = await botHarness()
    await bot.handle({
      body: { ...groupMessage(), type: 'installationUpdate', action: 'add', text: undefined, entities: undefined },
      headers: {},
    })
    await bot.idle()
    expect(messagesPosted(calls).map(call => call.data?.text)).toEqual([expect.stringContaining('Chào mọi người')])
  })

  it('refuses Entra-issued tokens (e.g. a web user\'s ID token) before the SDK sees them', async () => {
    const appId = '11111111-2222-3333-4444-555555555555'
    const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const base = await createServices({ config: readConfig({ LLM_PROVIDER: 'mock', CLIENT_ID: appId, CLIENT_SECRET: 's', TENANT_ID: tenant }) })
    const { calls, client } = fakeConnector()
    const bot = await createTeamsBot(base, { client, dangerouslyAllowUnauthenticatedRequests: false, logger: silentLogger })
    cleanups.push(async () => { await bot.close(); await base.close() })
    const claims = { iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: appId, tid: tenant }
    const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
    const response = await bot.handle({
      body: groupMessage({ serviceUrl: 'https://attacker.example/collect/', channelData: { tenant: { id: tenant } } }),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response).toEqual({ status: 401, body: { error: 'Unsupported token issuer' } })
    await bot.idle()
    expect(calls).toEqual([])
  })

  it('never replies to a serviceUrl outside Microsoft, and reads nothing for it', async () => {
    const { bot, calls, graph } = await botHarness()
    await bot.handle({ body: groupMessage({ serviceUrl: 'https://attacker.example/collect/' }), headers: {} })
    await bot.handle({ body: { ...groupMessage({ serviceUrl: 'https://attacker.example/' }), type: 'installationUpdate', action: 'add' }, headers: {} })
    await bot.idle()
    expect(calls).toEqual([])
    expect(graph.requests).toEqual([])
  })

  it('reads only the configured tenant when TENANT_ID is a tenant GUID', async () => {
    const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const { bot, calls, graph, tokens } = await botHarness({ LLM_PROVIDER: 'mock', TENANT_ID: tenant })
    await bot.handle({ body: groupMessage(), headers: {} })
    await bot.idle()
    expect(messagesPosted(calls).map(call => call.data?.text)).toEqual([`⚠️ ${FOREIGN_TENANT_TEXT}`])
    expect(graph.requests).toEqual([])
    await bot.handle({ body: groupMessage({ id: 'in-2', channelData: { tenant: { id: tenant.toUpperCase() } } }), headers: {} })
    await bot.idle()
    expect(tokens).toEqual([tenant.toUpperCase()])
    expect(graph.paths()).toEqual(['/chats/19:group@thread.v2/messages'])
  })

  it('serves POST /api/messages through the Hono app', async () => {
    const base = await createServices({ config: readConfig({ LLM_PROVIDER: 'mock', DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS: '1' }) })
    cleanups.push(() => base.close())
    const { calls, client } = fakeConnector()
    const app = createApiApp({
      services: async () => base,
      teamsBot: { client, dangerouslyAllowUnauthenticatedRequests: true, logger: silentLogger },
    })
    const health = await (await app.request('/api/health')).json() as { teamsBot: boolean }
    expect(health.teamsBot).toBe(true)
    const response = await app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(groupMessage({ conversation: { id: 'a:1on1', conversationType: 'personal' }, entities: [], text: 'hi' })),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    await vi.waitFor(() => expect(messagesPosted(calls)).toHaveLength(1))
    expect((await app.request('/api/messages', { method: 'POST', body: '{nope' })).status).toBe(400)
  })
})
