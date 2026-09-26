// Hiển thị tiến trình của agent trên terminal, theo dạng dòng thời gian:
//
//   ── Bước 1 ──
//   💭 Suy nghĩ
//   │ Giáo viên cần 5 câu về dấu tam thức... trước hết tra tài liệu Bài 17.
//   └ 2.4 giây
//   ⚙ search_library({"query":"..."})
//   ✓ {"results":[...]}
//   ── Bước 2 ──
//   💭 Suy nghĩ ...
//   🐱 Câu trả lời cuối cùng...
//
// Tách riêng để agent loop (core/agent.ts) không phụ thuộc vào giao diện:
// cùng các AgentEvent đó có thể vẽ lên web, Telegram... theo cách khác.

import type { AgentEvent } from './core/agent.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const thought = (s: string) => `\x1b[2;3m${s}\x1b[0m` // mờ + nghiêng
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

export type RenderOptions = {
  label: string
  /** false = ẩn nội dung suy nghĩ, chỉ hiện "đang suy nghĩ… (x giây)". */
  showThinking: boolean
  write?: (text: string) => void
}

export class TurnRenderer {
  private mode: 'idle' | 'thinking' | 'answer' | 'tool' = 'idle'
  private thinkingStartedAt = 0
  private readonly startedAt = Date.now()
  private readonly write: (text: string) => void

  constructor(private readonly options: RenderOptions) {
    this.write = options.write ?? (text => process.stdout.write(text))
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'step-start':
        // Chỉ vẽ tiêu đề bước từ bước 2, khi agent thật sự lặp lại.
        if (event.step > 1) this.write(dim(`\n── Bước ${event.step} ──`))
        this.mode = 'idle'
        break

      case 'reasoning-delta':
        if (this.mode !== 'thinking') {
          this.mode = 'thinking'
          this.thinkingStartedAt = Date.now()
          this.write(`\n${cyan('💭 Suy nghĩ')}${this.options.showThinking ? '' : dim(' …')}`)
          if (this.options.showThinking) this.write(dim('\n│ '))
        }
        if (this.options.showThinking) this.write(thought(event.text.replace(/\n/g, `\n${dim('│')} `)))
        break

      case 'reasoning-end':
        this.write(dim(`\n└ ${seconds(Date.now() - this.thinkingStartedAt)}`))
        this.mode = 'idle'
        break

      case 'text-delta':
        if (this.mode !== 'answer') {
          this.mode = 'answer'
          this.write('\n🐱 ')
        }
        this.write(event.text)
        break

      case 'tool-call':
        this.mode = 'tool'
        this.write(dim(`\n⚙ ${event.call.name}(${preview(JSON.stringify(event.call.args), 120)})`))
        break

      case 'tool-result':
        this.write(dim(`\n${event.result.isError ? red('✗') : '✓'} ${preview(event.result.result, 160)}`))
        break

      case 'done': {
        if (event.reason === 'max-steps') this.write(red('\n(Đã chạm giới hạn số bước, dừng lại.)'))
        const u = event.usage
        const reasoning = u.reasoningTokens ? `, suy nghĩ ${u.reasoningTokens}` : ''
        this.write(dim(`\n\n[${this.options.label} · ${seconds(Date.now() - this.startedAt)} · vào ${u.inputTokens} / ra ${u.outputTokens}${reasoning} tokens]\n`))
        break
      }
    }
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} giây`
}

function preview(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
