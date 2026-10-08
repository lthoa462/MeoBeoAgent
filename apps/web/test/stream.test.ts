import { describe, expect, it } from 'vitest'
import type { TranscriptStats, WireEvent } from '@meobeo/backend/wire'
import { readEvents, reduceTurn, settleTurn } from '../src/ui/stream'
import { describeFetch, describeToolInput, formatSpan, pickDates, summarizeTranscripts, todayInputValue, windowLabel } from '../src/ui/format'
import type { Turn } from '../src/ui/types'

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<WireEvent[]> {
  const events: WireEvent[] = []
  for await (const event of readEvents(stream)) events.push(event)
  return events
}

const frame = (event: WireEvent): string => `data: ${JSON.stringify(event)}\n\n`

const turn = (): Turn => ({ id: 't1', prompt: 'Tóm tắt 24 giờ qua', startedAt: 0, status: 'running', steps: [], answer: [] })

const stats: TranscriptStats = {
  transcriptId: 'tr1',
  label: 'Thứ Hai, 05/10/2026',
  messageCount: 42,
  participants: ['An', 'Bình'],
  since: '2026-10-05T00:00:00.000Z',
  until: '2026-10-06T00:00:00.000Z',
  chunkCount: 1,
  truncated: false,
  scanLimited: false,
  clamped: false,
  notes: [],
}

/** Stats of one month of 2026, as a split period loads them. */
const month = (m: number, messageCount: number, extra: Partial<TranscriptStats> = {}): TranscriptStats => ({
  ...stats,
  transcriptId: `m${String(m)}`,
  label: `Tháng ${String(m)}/2026`,
  messageCount,
  since: `2026-${String(m).padStart(2, '0')}-01T00:00:00+07:00`,
  until: `2026-${String(m + 1).padStart(2, '0')}-01T00:00:00+07:00`,
  ...extra,
})

/** A local-time ISO string this year, so dd/MM expectations hold in any zone and year. */
const thisYear = (monthDay: string): string => `${String(new Date().getFullYear())}-${monthDay}T12:00:00`

describe('readEvents', () => {
  it('parses frames split across chunks, skips ping comments, CRLF and unknown payloads', async () => {
    const start = frame({ t: 'run-start', runId: 'r1', conversationId: 'c1' })
    const delta = frame({ t: 'text-delta', text: 'Xin chào', blockId: 'b1' })
    const events = await collect(body(
      ': ping\n\n',
      start.slice(0, 10),
      start.slice(10),
      delta.replace(/\n/gu, '\r\n'),
      'data: not json\n\n',
      `data: ${JSON.stringify({ t: 'done', text: 'Xin chào', completed: true, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })}`,
    ))
    expect(events.map(event => event.t)).toEqual(['run-start', 'text-delta', 'done'])
    expect(events[1]).toMatchObject({ text: 'Xin chào' })
  })
})

describe('reduceTurn', () => {
  it('builds the process timeline and the final answer of a full turn', () => {
    const events: WireEvent[] = [
      { t: 'commentary', text: 'Mình sẽ đọc ', blockId: 'c1' },
      { t: 'commentary', text: 'tin nhắn 24 giờ qua.', blockId: 'c1' },
      { t: 'tool-call', callId: 'k1', name: 'load_messages', input: { since: '2026-10-05T00:00:00Z' } },
      { t: 'fetch-progress', fetched: 50 },
      { t: 'fetch-progress', fetched: 80 },
      { t: 'transcript', stats },
      { t: 'tool-result', callId: 'k1', name: 'load_messages', status: 'completed', isError: false },
      { t: 'tool-call', callId: 'k2', name: 'summarize_messages', input: { transcriptId: 'tr1' } },
      { t: 'tool-call', callId: 'k3', name: 'extract_action_items', input: { transcriptId: 'tr1' } },
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 1, total: 3 },
      { t: 'agent-progress', agent: 'action-tracker', stage: 'single', done: 0, total: 1 },
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 3, total: 3 },
      { t: 'agent-progress', agent: 'summarizer', stage: 'reduce', done: 1, total: 1 },
      { t: 'agent-progress', agent: 'action-tracker', stage: 'single', done: 1, total: 1 },
      { t: 'tool-result', callId: 'k2', name: 'summarize_messages', status: 'completed', isError: false },
      { t: 'tool-result', callId: 'k3', name: 'extract_action_items', status: 'failed', isError: true },
      { t: 'text-delta', text: '## Tóm tắt\n', blockId: 'a1' },
      { t: 'text-delta', text: '- Chốt ngày phát hành #12', blockId: 'a1' },
      { t: 'done', text: '## Tóm tắt\n- Chốt ngày phát hành #12', completed: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]
    const result = settleTurn(events.reduce(reduceTurn, turn()), 'ended', 9_000)

    expect(result.status).toBe('done')
    expect(result.endedAt).toBe(9_000)
    expect(result.answer).toEqual([{ blockId: 'a1', text: '## Tóm tắt\n- Chốt ngày phát hành #12' }])
    expect(result.usage?.totalTokens).toBe(15)
    // The stats card replaced the "fetched N" line of the same load.
    expect(result.steps.map(step => step.kind)).toEqual(['commentary', 'tool', 'transcript', 'tool', 'tool'])
    expect(result.steps[0]).toMatchObject({ kind: 'commentary', text: 'Mình sẽ đọc tin nhắn 24 giờ qua.' })
    // Specialist progress rides on the tool row that runs that specialist.
    expect(result.steps.filter(step => step.kind === 'tool')).toMatchObject([
      { name: 'load_messages', status: 'completed' },
      { name: 'summarize_messages', status: 'completed', progress: { agent: 'summarizer', stage: 'reduce', done: 1, total: 1 } },
      { name: 'extract_action_items', status: 'failed', progress: { agent: 'action-tracker', stage: 'single', done: 1, total: 1 } },
    ])
  })

  it('puts the progress of parallel specialist calls on the row of the call it belongs to', () => {
    const events: WireEvent[] = [
      { t: 'tool-call', callId: 's7', name: 'summarize_messages', input: { transcriptId: 'm7' } },
      { t: 'tool-call', callId: 's8', name: 'summarize_messages', input: { transcriptId: 'm8' } },
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 0, total: 5, callId: 's7' },
      { t: 'agent-progress', agent: 'summarizer', stage: 'single', done: 0, total: 1, callId: 's8' },
      { t: 'agent-progress', agent: 'summarizer', stage: 'single', done: 1, total: 1, callId: 's8' },
      { t: 'tool-result', callId: 's8', name: 'summarize_messages', status: 'completed', isError: false },
      { t: 'agent-progress', agent: 'summarizer', stage: 'map', done: 1, total: 5, callId: 's7' },
    ]
    const result = events.reduce(reduceTurn, turn())
    expect(result.steps).toMatchObject([
      { kind: 'tool', id: 's7', status: 'running', progress: { stage: 'map', done: 1, total: 5 } },
      { kind: 'tool', id: 's8', status: 'completed', progress: { stage: 'single', done: 1, total: 1 } },
    ])
  })

  it('counts a transcript loaded twice in one turn once', () => {
    const again = { ...stats, notes: ['ghi chú mới'] }
    const result = [
      { t: 'transcript', stats },
      { t: 'tool-result', callId: 'k1', name: 'load_messages', status: 'completed', isError: false },
      { t: 'transcript', stats: again },
    ].reduce<Turn>((current, event) => reduceTurn(current, event as WireEvent), turn())
    const cards = result.steps.filter(step => step.kind === 'transcript')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ stats: { transcriptId: 'tr1', notes: ['ghi chú mới'] } })
  })

  it('keeps specialist progress that matches no running tool as its own step', () => {
    const result = reduceTurn(turn(), { t: 'agent-progress', agent: 'qa', stage: 'single', done: 0, total: 1 })
    const updated = reduceTurn(result, { t: 'agent-progress', agent: 'qa', stage: 'single', done: 1, total: 1 })
    expect(updated.steps).toMatchObject([{ kind: 'agent', agent: 'qa', done: 1, total: 1 }])
  })

  it('moves text streamed before a tool call into the process', () => {
    const result = [
      { t: 'text-delta', text: 'Để mình xem…', blockId: 'x' },
      { t: 'tool-call', callId: 'k1', name: 'load_messages', input: {} },
      { t: 'text-delta', text: 'Kết quả', blockId: 'y' },
    ].reduce((current, event) => reduceTurn(current, event as WireEvent), turn())
    expect(result.steps.map(step => step.kind)).toEqual(['commentary', 'tool'])
    expect(result.answer).toEqual([{ blockId: 'y', text: 'Kết quả' }])
  })

  it('uses done.text when nothing was streamed, and flags auth errors for re-login', () => {
    const answered = reduceTurn(turn(), { t: 'done', text: 'Không có tin nhắn.', completed: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    expect(answered.answer).toEqual([{ blockId: 'final', text: 'Không có tin nhắn.' }])

    const failed = reduceTurn(turn(), { t: 'error', code: 'graph_unauthorized', message: 'Token hết hạn' })
    expect(failed).toMatchObject({ status: 'failed', error: { message: 'Token hết hạn', reauth: true } })
    expect(settleTurn(failed, 'ended', 1).status).toBe('failed')
  })

  it('marks a stopped turn and its unfinished tools', () => {
    const running = reduceTurn(turn(), { t: 'tool-call', callId: 'k1', name: 'load_messages', input: {} })
    const stopped = settleTurn(running, 'stopped', 5)
    expect(stopped.status).toBe('stopped')
    expect(stopped.steps[0]).toMatchObject({ kind: 'tool', status: 'failed' })
  })

  it('keeps one live line per segment of a split period and closes each with its transcript', () => {
    const events: WireEvent[] = [
      { t: 'fetch-progress', fetched: 50, segment: 'Tháng 8/2026', scannedBackTo: '2026-09-20T10:00:00+07:00' },
      { t: 'fetch-progress', fetched: 40, segment: 'Tháng 7/2026' },
      { t: 'fetch-progress', fetched: 120, segment: 'Tháng 8/2026', scannedBackTo: '2026-08-12T10:00:00+07:00' },
      { t: 'transcript', stats: month(7, 40) },
      { t: 'fetch-progress', fetched: 300, segment: 'Tháng 8/2026', scannedBackTo: '2026-08-01T00:00:00+07:00' },
    ]
    const running = events.reduce(reduceTurn, turn())
    expect(running.steps.map(step => step.kind)).toEqual(['fetch', 'transcript'])
    expect(running.steps[0]).toMatchObject({ kind: 'fetch', fetched: 300, segment: 'Tháng 8/2026', scannedBackTo: '2026-08-01T00:00:00+07:00' })
    const done = reduceTurn(running, { t: 'transcript', stats: month(8, 300) })
    expect(done.steps.map(step => step.kind === 'transcript' ? step.stats.label : step.kind)).toEqual(['Tháng 7/2026', 'Tháng 8/2026'])

    // Plain reads in sequence: each transcript closes the line before it.
    const plain = ([
      { t: 'fetch-progress', fetched: 10 },
      { t: 'transcript', stats },
      { t: 'fetch-progress', fetched: 5, scannedBackTo: '2026-10-01T00:00:00+07:00' },
    ] as WireEvent[]).reduce(reduceTurn, turn())
    expect(plain.steps).toMatchObject([{ kind: 'transcript' }, { kind: 'fetch', fetched: 5, scannedBackTo: '2026-10-01T00:00:00+07:00' }])
  })

  it('ignores frame types it does not know', () => {
    const before = turn()
    expect(reduceTurn(before, { t: 'something-new' } as unknown as WireEvent)).toBe(before)
  })
})

describe('format', () => {
  it('describes tool inputs compactly', () => {
    expect(describeToolInput('load_messages', {})).toBe('khoảng thời gian mặc định')
    expect(describeToolInput('load_messages', { since: '2020-01-02T03:04:00', until: 'not a date' })).toBe('từ 02/01/2020 03:04')
    expect(describeToolInput('load_messages', { period: 'range', since: '2020-01-02T03:04:00' })).toBe('từ 02/01/2020 03:04')
    // Bare dates are whole days with an exclusive end, shown inclusive with the year (as the server labels them).
    expect(describeToolInput('load_messages', { period: 'range', since: '2020-07-01', until: '2020-10-01' })).toBe('01/07 – 30/09/2020')
    expect(describeToolInput('load_messages', { period: 'range', since: '2025-01-01', until: '2026-01-01' })).toBe('01/01 – 31/12/2025')
    expect(describeToolInput('load_messages', { since: '2025-12-15', until: '2026-01-16' })).toBe('15/12/2025 – 15/01/2026')
    expect(describeToolInput('load_messages', { since: '2026-10-05', until: '2026-10-06' })).toBe('ngày 05/10/2026')
    expect(describeToolInput('load_messages', { since: '2026-10-01' })).toBe('từ 01/10/2026')
    expect(describeToolInput('load_messages', { period: 'day', date: '2026-09-06' })).toBe('ngày 06/09/2026')
    expect(describeToolInput('load_messages', { period: 'day', date: '9-6' })).toBe('ngày 06/09')
    expect(describeToolInput('load_messages', { period: 'week_of_month', month: '2026-08', week: 2 })).toBe('tuần 2 tháng 8/2026')
    expect(describeToolInput('load_messages', { period: 'week_containing', date: '2026-09-06' })).toBe('tuần chứa ngày 06/09/2026')
    expect(describeToolInput('load_messages', { period: 'month', month: '07' })).toBe('tháng 7')
    expect(describeToolInput('load_messages', { period: 'last', amount: 3, unit: 'day' })).toBe('3 ngày qua')
    expect(describeToolInput('load_messages', { period: 'last', amount: 3, unit: 'constructor' })).toBe('khoảng thời gian mặc định')
    expect(describeToolInput('answer_question', { transcriptId: 't', question: 'Ai phụ trách?' })).toBe('“Ai phụ trách?”')
    expect(describeToolInput('extract_action_items', { transcriptId: 't' })).toBeUndefined()
  })

  it('describes a read in progress with its segment and how far back the scan reached', () => {
    expect(describeFetch({ fetched: 1500 }, true)).toBe('Đã tải 1.500 tin nhắn…')
    expect(describeFetch({ fetched: 12, scannedBackTo: thisYear('08-20') }, false)).toBe('Đã tải 12 tin nhắn · đã quét tới 20/08')
    expect(describeFetch({ fetched: 150, segment: 'Tháng 8/2026', scannedBackTo: thisYear('08-20') }, true))
      .toBe('Đang đọc Tháng 8/2026: 150 tin nhắn · đã quét tới 20/08')
    expect(describeFetch({ fetched: 3, segment: 'Tháng 8/2026', scannedBackTo: 'không phải ngày' }, true)).toBe('Đang đọc Tháng 8/2026: 3 tin nhắn')
  })

  it('folds the transcripts of a turn into one summary, oldest window first', () => {
    const single = summarizeTranscripts([{ ...stats, notes: ['Không có tin nhắn nào.', 'Không có tin nhắn nào.'] }])
    expect(single).toMatchObject({ messageCount: 42, participants: ['An', 'Bình'], notes: ['Không có tin nhắn nào.'] })

    const quarter = summarizeTranscripts([
      month(9, 180, { participants: ['Chi', 'An'] }),
      month(7, 340, { participants: ['An', 'Bình'], truncated: true, scanLimited: true, notes: ['Chỉ quét được tới 20/07/2026 08:00.'] }),
      month(8, 500, { participants: ['Bình'] }),
    ])
    expect(quarter.messageCount).toBe(1_020)
    expect(quarter.segments.map(windowLabel)).toEqual(['Tháng 7/2026', 'Tháng 8/2026', 'Tháng 9/2026'])
    expect(quarter.participants).toEqual(['An', 'Bình', 'Chi'])
    expect(quarter.notes).toEqual(['Tháng 7/2026: Chỉ quét được tới 20/07/2026 08:00.'])
    expect(windowLabel({ ...stats, label: ' ', since: '2020-01-02T03:04:00', until: '2020-01-03T03:04:00' })).toBe('02/01/2020 03:04 → 03/01/2020 03:04')
  })

  it('turns picked dates into a request the agents read as dd/MM/yyyy', () => {
    const limits = { today: '2026-10-06', maxRangeDays: 31, maxPeriodDays: 92 }
    expect(pickDates('', '', limits)).toEqual({})
    expect(pickDates('2026-09-06', '', limits)).toEqual({ prompt: 'Tóm tắt ngày 06/09/2026' })
    expect(pickDates('', '2026-09-06', limits)).toEqual({ prompt: 'Tóm tắt ngày 06/09/2026' })
    expect(pickDates('2026-08-15', '2026-08-01', limits)).toEqual({ prompt: 'Tóm tắt từ 01/08/2026 đến 15/08/2026' })
    const quarter = pickDates('2026-07-01', '2026-09-30', limits)
    expect(quarter.prompt).toBe('Tóm tắt từ 01/07/2026 đến 30/09/2026')
    expect(quarter.note).toContain('từng tháng')
    expect(pickDates('2026-01-01', '2026-09-30', limits)).toEqual({ note: 'Khoảng này dài 273 ngày, vượt giới hạn 92 ngày cho một yêu cầu.' })
    expect(pickDates('2026-10-10', '', limits).prompt).toBeUndefined()
    expect(pickDates('2026-10-01', '2026-10-10', limits)).toMatchObject({ prompt: 'Tóm tắt từ 01/10/2026 đến 10/10/2026', note: expect.stringContaining('hiện tại') })
    expect(pickDates('2026-02-30', '', limits)).toEqual({})
    expect(todayInputValue(new Date(2026, 8, 6, 23, 59))).toBe('2026-09-06')
  })

  it('formats elapsed spans', () => {
    expect(formatSpan(400)).toBe('1s')
    expect(formatSpan(12_400)).toBe('12s')
    expect(formatSpan(65_000)).toBe('1m 05s')
  })
})
