import { describe, expect, it } from 'vitest'
import type { TranscriptStats, WireEvent } from '@meobeo/backend/wire'
import { readEvents, reduceTurn, settleTurn } from '../src/ui/stream'
import { describeToolInput, formatSpan } from '../src/ui/format'
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
  messageCount: 42,
  participants: ['An', 'Bình'],
  since: '2026-10-05T00:00:00.000Z',
  until: '2026-10-06T00:00:00.000Z',
  chunkCount: 1,
  truncated: false,
  clamped: false,
  notes: [],
}

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

  it('ignores frame types it does not know', () => {
    const before = turn()
    expect(reduceTurn(before, { t: 'something-new' } as unknown as WireEvent)).toBe(before)
  })
})

describe('format', () => {
  it('describes tool inputs compactly', () => {
    expect(describeToolInput('load_messages', {})).toBe('khoảng thời gian mặc định')
    expect(describeToolInput('load_messages', { since: '2020-01-02T03:04:00', until: 'not a date' })).toBe('từ 02/01/2020 03:04')
    expect(describeToolInput('answer_question', { transcriptId: 't', question: 'Ai phụ trách?' })).toBe('“Ai phụ trách?”')
    expect(describeToolInput('extract_action_items', { transcriptId: 't' })).toBeUndefined()
  })

  it('formats elapsed spans', () => {
    expect(formatSpan(400)).toBe('1s')
    expect(formatSpan(12_400)).toBe('12s')
    expect(formatSpan(65_000)).toBe('1m 05s')
  })
})
