import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranscriptStats } from '@meobeo/backend/wire'
import { ChatView, QUICK_PROMPTS } from '../src/ui/ChatView'
import type { ChatController } from '../src/ui/useChat'
import type { Turn } from '../src/ui/types'

const month = (m: number, messageCount: number, participants: string[]): TranscriptStats => ({
  transcriptId: `t${String(m)}`,
  label: `Tháng ${String(m)}/2026`,
  messageCount,
  participants,
  since: `2026-0${String(m)}-01T00:00:00+07:00`,
  until: `2026-0${String(m + 1)}-01T00:00:00+07:00`,
  chunkCount: 1,
  truncated: false,
  scanLimited: false,
  clamped: false,
  notes: [],
})

function render(turns: readonly Turn[], running = false): string {
  const chat: ChatController = {
    thread: turns.length === 0 ? undefined : { conversationId: 'c1', turns },
    running,
    runningKeys: new Set(),
    send: () => undefined,
    stop: () => undefined,
    reset: () => undefined,
  }
  return renderToStaticMarkup(createElement(ChatView, {
    title: 'Dự án', subtitle: 'Nhóm chat', chat, maxRangeDays: 31, maxPeriodDays: 92, providerConfigured: true, onReauth: () => undefined,
  }))
}

describe('ChatView', () => {
  it('offers the quick prompts and the date picker, without the old 30-day wording', () => {
    const html = render([])
    for (const chip of QUICK_PROMPTS) expect(html).toContain(chip.label)
    expect(html).toContain('📅 Chọn ngày/khoảng')
    expect(html).toContain('tuần thứ 2 tháng 8')
    expect(html).not.toMatch(/30 ngày|gần nhất/u)
  })

  it('shows a split period as one card with a row per month, and the read still running', () => {
    const turn: Turn = {
      id: 'turn1',
      prompt: 'Tóm tắt quý 3',
      startedAt: 0,
      status: 'running',
      answer: [],
      steps: [
        { kind: 'tool', id: 'k1', name: 'load_messages', input: { period: 'range', since: '2026-07-01', until: '2026-10-01' }, status: 'running' },
        { kind: 'transcript', id: 's7', stats: month(7, 340, ['An', 'Bình']) },
        { kind: 'transcript', id: 's8', stats: month(8, 500, ['Bình', 'Chi']) },
        { kind: 'fetch', id: 'f9', fetched: 150, segment: 'Tháng 9/2026', scannedBackTo: '2026-09-20T12:00:00' },
        { kind: 'tool', id: 'k2', name: 'summarize_messages', input: { transcriptId: 't8' }, status: 'running' },
      ],
    }
    const html = render([turn], true)
    // The specialist row names the month it summarizes.
    expect(html).toMatch(/Agent tóm tắt<\/span><span[^>]*>Tháng 8\/2026<\/span>/u)
    expect(html).toContain('2 khoảng thời gian')
    expect(html).toContain('840')
    expect(html).toContain('Tháng 7/2026')
    expect(html).toContain('340 tin nhắn · 2 người')
    expect(html).toContain('Tháng 8/2026')
    expect(html).toContain('Đang đọc Tháng 9/2026: 150 tin nhắn · đã quét tới 20/09')
    // One card for both transcripts.
    expect(html.match(/khoảng thời gian<\/div>/gu)).toHaveLength(1)
  })

  it('puts the server label on top of a single transcript card', () => {
    const turn: Turn = {
      id: 'turn2',
      prompt: 'Tuần 2 tháng 8 có quyết định gì?',
      startedAt: 0,
      endedAt: 1_000,
      status: 'running',
      answer: [],
      steps: [{
        kind: 'transcript',
        id: 's',
        stats: { ...month(8, 12, ['An']), label: 'Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)', notes: ['Không có gì đặc biệt.'] },
      }],
    }
    const html = render([turn], true)
    expect(html).toContain('Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)')
    expect(html).toContain('Không có gì đặc biệt.')
    expect(html).not.toContain('khoảng thời gian</div>')
  })
})
