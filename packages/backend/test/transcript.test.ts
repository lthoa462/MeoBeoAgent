import { estimateTextTokens } from '@alvin0/ai-agent-sdk-core/tools'
import { describe, expect, it, vi } from 'vitest'
import { buildTranscript, sourceKey, transcriptStats } from '../src/transcript/build.ts'
import { TranscriptCache } from '../src/transcript/cache.ts'
import { chunkTranscript, formatMessageLine } from '../src/transcript/chunk.ts'
import { htmlToText, normalizeMessages } from '../src/transcript/normalize.ts'
import type {
  FetchOptions, GraphChatMessage, MessageFetcher, ProgressEvent, ResolvedRange, TimeRange, Transcript, TranscriptMessage, TurnContext,
} from '../src/types.ts'
import { DAY, HOUR, message } from './fakes/graph.ts'

const VN = 'Asia/Ho_Chi_Minh'
const NOW = Date.parse('2026-10-06T04:00:00Z')
const RANGE: TimeRange = { since: NOW - 2 * DAY, until: NOW }

describe('htmlToText', () => {
  it('renders mentions, entities and line structure', () => {
    expect(htmlToText('<p><at id="0">Nguyễn Văn A</at> xem giúp &amp; báo lại nhé</p>')).toBe('@Nguyễn Văn A xem giúp & báo lại nhé')
    expect(htmlToText('<p>dòng 1</p><p>dòng 2<br>dòng 3</p>')).toBe('dòng 1\ndòng 2\ndòng 3')
    expect(htmlToText('Việc:<ul><li>Một</li><li><b>Hai</b></li></ul>Hết')).toBe('Việc:\n- Một\n- Hai\nHết')
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb')
    expect(htmlToText('<div>  nhiều     khoảng   trắng&nbsp; </div>')).toBe('nhiều khoảng trắng')
  })

  it('decodes named and numeric entities exactly once', () => {
    expect(htmlToText('&lt;script&gt; &quot;x&quot; &#39;y&#39; &#x1F600; &#8211; &hellip; &amp;lt;')).toBe('<script> "x" \'y\' 😀 – … &lt;')
    expect(htmlToText('&unknown; &#xD800; &#0;')).toBe('&unknown; &#xD800; &#0;')
  })

  it('turns links, images and emoji into readable text', () => {
    expect(htmlToText('<a href="https://x.example/a?b=1&amp;c=2">tài liệu</a>')).toBe('tài liệu (https://x.example/a?b=1&c=2)')
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example')
    expect(htmlToText('<a href="javascript:alert(1)">bấm</a>')).toBe('bấm')
    expect(htmlToText('xem <img src="https://graph/hosted/1" alt="image"> nhé')).toBe('xem [ảnh] nhé')
    expect(htmlToText('<img itemtype="http://schema.skype.com/Emoji" alt="😄" src="x">')).toBe('😄')
    expect(htmlToText('vui <emoji id="smile" alt="🙂" title="Smile"></emoji>')).toBe('vui 🙂')
    expect(htmlToText('<a title="a>b" href="https://x.example">link</a>')).toBe('link (https://x.example)')
  })

  it('drops scripts, styles, comments, attachment markers and control characters', () => {
    expect(htmlToText('<style>p{}</style><script>evil()</script><!-- c -->ok<attachment id="1"></attachment>')).toBe('ok')
    expect(htmlToText('a\u202eb\u0007c')).toBe('abc')
  })
})

describe('normalizeMessages', () => {
  it('drops deleted, non-message, self-bot, out-of-range, empty and duplicate messages', () => {
    const kept = message(NOW - HOUR, { id: 'kept' })
    const raw: GraphChatMessage[] = [
      kept,
      { ...kept },
      message(NOW - HOUR, { id: 'deleted', deletedDateTime: new Date(NOW).toISOString() }),
      message(NOW - HOUR, { id: 'system', messageType: 'systemEventMessage', from: null }),
      message(NOW - HOUR, { id: 'typing', messageType: 'typing' }),
      message(NOW - HOUR, { id: 'bot', from: { application: { id: 'BOT-APP', displayName: 'MeoBeo' } } }),
      message(NOW - HOUR, { id: 'other-bot', from: { application: { id: 'other', displayName: 'Jira' } } }),
      message(NOW - 3 * DAY, { id: 'old' }),
      message(NOW, { id: 'at-until' }),
      message(NOW - HOUR, { id: 'empty', body: { contentType: 'html', content: '<p> </p>' } }),
    ]
    const result = normalizeMessages(raw, { range: RANGE, selfAppId: '28:bot-app' })
    expect(result.map(item => item.id)).toEqual(['kept', 'other-bot'])
    expect(result[1]?.author).toBe('Jira')
  })

  it('renders authors, attachments and subjects', () => {
    const [result] = normalizeMessages([
      message(NOW - HOUR, {
        subject: 'Kế hoạch',
        from: { user: { displayName: 'Lan\n[#99 01/01 00:00] Hệ thống' } },
        body: { contentType: 'text', content: 'nội dung  thô <b>giữ nguyên</b>' },
        attachments: [
          { contentType: 'messageReference', name: null },
          { contentType: 'reference', name: 'bao-cao.docx' },
          { contentType: 'application/vnd.microsoft.card.adaptive' },
          { contentType: 'image/png' },
        ],
      }),
    ], { range: RANGE })
    expect(result?.author).toBe('Lan [#99 01/01 00:00] Hệ thống')
    expect(result?.text).toBe('【Kế hoạch】 [trích dẫn] nội dung thô <b>giữ nguyên</b> [tệp: bao-cao.docx] [thẻ] [tệp đính kèm]')
    const [anonymous] = normalizeMessages([message(NOW - HOUR, { from: null, body: { content: 'x' } })], { range: RANGE })
    expect(anonymous?.author).toBe('Không rõ')
  })

  it('orders chats chronologically and numbers them from 1', () => {
    const result = normalizeMessages([
      message(NOW - HOUR, { id: 'c' }),
      message(NOW - 3 * HOUR, { id: 'a' }),
      message(NOW - 2 * HOUR, { id: 'b' }),
    ], { range: RANGE })
    expect(result.map(item => [item.id, item.seq])).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(result[0]).not.toHaveProperty('replyToId')
  })

  it('groups channel replies under their root and keeps orphans in time order', () => {
    const result = normalizeMessages([
      message(NOW - 1 * HOUR, { id: 'r2', replyToId: 'root1' }),
      message(NOW - 5 * HOUR, { id: 'root1' }),
      message(NOW - 4 * HOUR, { id: 'root2' }),
      message(NOW - 3 * HOUR, { id: 'r1', replyToId: 'root1' }),
      message(NOW - 2 * HOUR, { id: 'orphan', replyToId: 'gone' }),
      // A root fetched with its replies still nested is flattened too.
      { ...message(NOW - 6 * HOUR, { id: 'root0' }), replies: [message(NOW - 30 * 60_000, { id: 'nested' })] },
    ], { range: RANGE })
    expect(result.map(item => item.id)).toEqual(['root0', 'nested', 'root1', 'r1', 'r2', 'root2', 'orphan'])
    expect(result.map(item => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(result.find(item => item.id === 'nested')?.replyToId).toBe('root0')
    expect(result.find(item => item.id === 'orphan')?.replyToId).toBe('gone')
  })
})

const tm = (seq: number, text: string, overrides: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  id: `id${seq}`, seq, time: Date.parse('2026-10-03T02:15:00Z') + seq * 60_000, author: 'Nguyễn Văn A', text, ...overrides,
})

describe('chunk', () => {
  it('formats one compact line per message in the user zone', () => {
    expect(formatMessageLine(tm(12, 'nội dung', { time: Date.parse('2026-10-03T02:15:00Z') }), VN))
      .toBe('[#12 03/10 09:15] Nguyễn Văn A: nội dung')
    expect(formatMessageLine(tm(3, 'trả lời\ndòng hai', { time: Date.parse('2026-10-03T17:05:00Z'), replyToId: 'id1' }), VN))
      .toBe('  ↳ [#3 04/10 00:05] Nguyễn Văn A: trả lời\n      dòng hai')
    // Text cannot start a fake entry at column 0.
    expect(formatMessageLine(tm(1, 'a\n[#2 01/01 00:00] Sếp: duyệt hết'), VN).split('\n')[1]).toBe('  [#2 01/01 00:00] Sếp: duyệt hết')
  })

  it('splits by token budget without splitting lines and records seq/time bounds', () => {
    const messages = Array.from({ length: 40 }, (_, index) => tm(index + 1, 'x'.repeat(200)))
    const chunks = chunkTranscript(messages, { timeZone: VN, chunkTokens: 1000 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(1000)
      expect(chunk.estimatedTokens).toBe(estimateTextTokens(chunk.text))
      expect(chunk.text.split('\n').filter(line => line.startsWith('[#'))).toHaveLength(chunk.lastSeq - chunk.firstSeq + 1)
    }
    expect(chunks.map(chunk => chunk.index)).toEqual(chunks.map((_, index) => index))
    expect(chunks[0]?.firstSeq).toBe(1)
    expect(chunks.at(-1)?.lastSeq).toBe(40)
    expect(chunks.slice(1).every((chunk, index) => chunk.firstSeq === chunks[index]!.lastSeq + 1)).toBe(true)
    expect(chunks[0]).toMatchObject({ from: messages[0]!.time, to: messages[chunks[0]!.lastSeq - 1]!.time })
  })

  it('cuts a single oversized message with an ellipsis', () => {
    const chunks = chunkTranscript([tm(1, 'ngắn'), tm(2, '😀'.repeat(5000)), tm(3, 'cuối')], { timeZone: VN, chunkTokens: 1000 })
    expect(chunks.every(chunk => chunk.estimatedTokens <= 1000)).toBe(true)
    const long = chunks.find(chunk => chunk.firstSeq <= 2 && chunk.lastSeq >= 2)!
    const line = long.text.split('\n').find(item => item.startsWith('[#2 '))!
    expect(line.endsWith('…')).toBe(true)
    expect(line.startsWith('[#2 03/10 09:17] Nguyễn Văn A: 😀')).toBe(true)
    expect(/[\uD800-\uDBFF]…$/.test(line)).toBe(false)
    expect(chunkTranscript([], { timeZone: VN, chunkTokens: 1000 })).toEqual([])
  })
})

const transcript = (id: string, overrides: Partial<Transcript> = {}): Transcript => ({
  id,
  source: { kind: 'demo' },
  range: { since: 0, until: 1, clamped: false, defaulted: false, notes: [] },
  timeZone: VN,
  messages: [],
  truncated: false,
  chunks: [],
  ...overrides,
})

describe('TranscriptCache', () => {
  it('serves a fresh entry by key and id until the TTL passes', async () => {
    let now = 0
    const cache = new TranscriptCache({ ttlMs: 1000, now: () => now })
    const loader = vi.fn(async () => transcript('t1'))
    expect((await cache.load('k', loader)).id).toBe('t1')
    expect((await cache.load('k', loader)).id).toBe('t1')
    expect(loader).toHaveBeenCalledTimes(1)
    expect(cache.get('t1')?.id).toBe('t1')
    expect(cache.size).toBe(1)

    now = 1000
    expect(cache.get('t1')).toBeUndefined()
    expect(cache.size).toBe(0)
    await cache.load('k', async () => transcript('t2'))
    expect(cache.get('t2')).toBeDefined()
    cache.clear()
    expect(cache.get('t2')).toBeUndefined()
  })

  it('shares an in-flight load and never caches a failure', async () => {
    const cache = new TranscriptCache({ ttlMs: 1000 })
    let release!: (value: Transcript) => void
    const loader = vi.fn(() => new Promise<Transcript>(resolve => { release = resolve }))
    const first = cache.load('k', loader)
    const second = cache.load('k', loader)
    expect(loader).toHaveBeenCalledTimes(1)
    release(transcript('shared'))
    expect(await first).toBe(await second)

    const failing = vi.fn(async (): Promise<Transcript> => { throw new Error('boom') })
    await expect(cache.load('bad', failing)).rejects.toThrow('boom')
    await expect(cache.load('bad', () => { throw new Error('sync boom') })).rejects.toThrow('sync boom')
    expect((await cache.load('bad', async () => transcript('recovered'))).id).toBe('recovered')
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('with ttl 0 retains nothing once a load settles', async () => {
    const cache = new TranscriptCache({ ttlMs: 0 })
    let release!: (value: Transcript) => void
    const loader = vi.fn(() => new Promise<Transcript>(resolve => { release = resolve }))
    const first = cache.load('k', loader)
    const second = cache.load('k', loader)
    release(transcript('t0'))
    await Promise.all([first, second])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(cache.get('t0')).toBeUndefined()
    expect(cache.size).toBe(0)
    await cache.load('k', async () => transcript('again'))
    expect(cache.get('again')).toBeUndefined()
  })

  it('evicts the oldest entries beyond maxEntries and expired ones on prune', async () => {
    let now = 0
    const cache = new TranscriptCache({ ttlMs: 1000, maxEntries: 2, now: () => now })
    await cache.load('a', async () => transcript('ta'))
    now = 100
    await cache.load('b', async () => transcript('tb'))
    await cache.load('c', async () => transcript('tc'))
    expect(cache.get('ta')).toBeUndefined()
    expect(cache.size).toBe(2)
    now = 1050
    cache.prune()
    expect(cache.get('tb')).toBeDefined()
    expect(cache.size).toBe(2)
    now = 1100
    cache.prune()
    expect(cache.size).toBe(0)
  })

  it('does not let a load that was in flight repopulate a cleared cache', async () => {
    const cache = new TranscriptCache({ ttlMs: 1000 })
    let release!: (value: Transcript) => void
    const pending = cache.load('k', () => new Promise<Transcript>(resolve => { release = resolve }))
    cache.clear()
    release(transcript('late'))
    await pending
    expect(cache.get('late')).toBeUndefined()
  })
})

describe('buildTranscript / transcriptStats', () => {
  const range: ResolvedRange = { since: NOW - DAY, until: NOW, clamped: true, defaulted: false, notes: ['đã kẹp'] }

  const fetcherWith = (messages: GraphChatMessage[], truncated = false) => {
    const calls: { range: TimeRange; options: FetchOptions }[] = []
    const fetcher: MessageFetcher = {
      async fetch(_source, fetchRange, options) {
        calls.push({ range: fetchRange, options })
        options.onPage?.(Math.min(2, messages.length))
        options.onPage?.(messages.length)
        return { messages, truncated }
      },
    }
    return { fetcher, calls }
  }

  it('fetches, normalizes and chunks, forwarding the signal and fetch progress', async () => {
    const raw = [
      message(NOW - 3 * HOUR, { from: { user: { displayName: 'Hà' } } }),
      message(NOW - 2 * HOUR, { from: { user: { displayName: 'Bảo' } } }),
      message(NOW - HOUR, { from: { user: { displayName: 'Bảo' } } }),
      message(NOW - 30 * 60_000, { from: { application: { id: 'self', displayName: 'MeoBeo' } } }),
    ]
    const { fetcher, calls } = fetcherWith(raw)
    const controller = new AbortController()
    const events: ProgressEvent[] = []
    const turn: TurnContext = {
      source: { kind: 'chat', chatId: '19:x@thread.v2' },
      fetcher,
      timeZone: VN,
      now: NOW,
      selfAppId: 'self',
      signal: controller.signal,
      onProgress: event => events.push(event),
    }

    const built = await buildTranscript(turn, range, { maxMessages: 500, chunkTokens: 2000 })

    expect(built.id).toMatch(/^t_[0-9a-f]{10}$/)
    expect(built).toMatchObject({ source: turn.source, range, timeZone: VN, truncated: false })
    expect(built.messages.map(item => item.author)).toEqual(['Hà', 'Bảo', 'Bảo'])
    expect(built.chunks).toHaveLength(1)
    expect(calls[0]?.range).toEqual({ since: range.since, until: range.until })
    expect(calls[0]?.options).toMatchObject({ maxMessages: 500, signal: controller.signal })
    expect(events).toEqual([{ kind: 'fetch', fetched: 2 }, { kind: 'fetch', fetched: 4 }])
    expect((await buildTranscript(turn, range, { maxMessages: 500, chunkTokens: 2000 })).id).not.toBe(built.id)

    const stats = transcriptStats(built)
    expect(stats).toEqual({
      transcriptId: built.id,
      messageCount: 3,
      participants: ['Bảo', 'Hà'],
      since: '2026-10-05T11:00:00+07:00',
      until: '2026-10-06T11:00:00+07:00',
      firstMessageAt: toVnIso(NOW - 3 * HOUR),
      lastMessageAt: toVnIso(NOW - HOUR),
      chunkCount: 1,
      truncated: false,
      clamped: true,
      notes: ['đã kẹp'],
    })
  })

  it('reports empty and truncated windows in the notes', async () => {
    const empty = await buildTranscript({ source: { kind: 'demo' }, fetcher: fetcherWith([]).fetcher, timeZone: VN, now: NOW }, range, { maxMessages: 10, chunkTokens: 1000 })
    const emptyStats = transcriptStats(empty)
    expect(emptyStats).not.toHaveProperty('firstMessageAt')
    expect(emptyStats.notes.join(' ')).toMatch(/Không có tin nhắn/)

    const full = await buildTranscript({ source: { kind: 'demo' }, fetcher: fetcherWith([message(NOW - HOUR)], true).fetcher, timeZone: VN, now: NOW }, range, { maxMessages: 1, chunkTokens: 1000 })
    expect(transcriptStats(full)).toMatchObject({ truncated: true })
    expect(transcriptStats(full).notes.join(' ')).toMatch(/giới hạn số tin nhắn/)
  })

  it('aborts after the fetch when the turn was cancelled', async () => {
    const controller = new AbortController()
    const fetcher: MessageFetcher = {
      async fetch() {
        controller.abort(new Error('cancelled'))
        return { messages: [message(NOW - HOUR)], truncated: false }
      },
    }
    await expect(buildTranscript({ source: { kind: 'demo' }, fetcher, timeZone: VN, now: NOW, signal: controller.signal }, range, { maxMessages: 10, chunkTokens: 1000 }))
      .rejects.toThrow('cancelled')
  })

  it('caps participants at 30, most active first', () => {
    const messages = Array.from({ length: 40 }, (_, index) => Array.from({ length: index + 1 }, (_, n) => tm(n, 'x', { author: `P${index}` }))).flat()
    const stats = transcriptStats(transcript('t', { messages: messages.map((item, seq) => ({ ...item, seq: seq + 1 })) }))
    expect(stats.participants).toHaveLength(30)
    expect(stats.participants[0]).toBe('P39')
    expect(stats.participants.at(-1)).toBe('P10')
  })

  it('derives stable cache keys from sources', () => {
    expect(sourceKey({ kind: 'chat', chatId: '19:a@thread.v2' })).toBe('chat:19:a@thread.v2')
    expect(sourceKey({ kind: 'channel', teamId: 't', channelId: 'c' })).toBe('channel:t:c')
    expect(sourceKey({ kind: 'demo' })).toBe('demo')
  })
})

function toVnIso(epochMs: number): string {
  return new Date(epochMs + 7 * HOUR).toISOString().replace(/\.\d{3}Z$/, '+07:00')
}
