'use client'

/**
 * The conversation column for one source: header, turns, composer.
 *
 * Each turn shows the question, a compact "process" timeline (narration, tool
 * calls, fetch progress, transcript stats, specialist progress) and the final
 * answer. A finished turn folds its process into one "Quá trình" row so the
 * answer stays easy to find, as in the edge sample.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Markdown } from './Markdown'
import type { ChatController } from './useChat'
import type { AgentProgress, Step, Turn } from './types'
import { agentFinished } from './stream'
import {
  AGENT_LABELS, TOOL_LABELS, clip, describeFetch, describeToolInput, formatDateTime, formatNumber, formatSpan,
  pickDates, summarizeTranscripts, todayInputValue, windowLabel, type TranscriptSummary,
} from './format'
import css from './ChatView.module.css'

/** Quick actions: the label on the chip and the prompt it sends. */
export const QUICK_PROMPTS: ReadonlyArray<{ readonly label: string; readonly prompt: string }> = [
  { label: 'Tóm tắt hôm qua', prompt: 'Tóm tắt hôm qua' },
  { label: 'Tóm tắt tuần trước', prompt: 'Tóm tắt tuần trước' },
  { label: 'Tóm tắt tháng trước', prompt: 'Tóm tắt tháng trước' },
  { label: 'Việc cần làm tuần này', prompt: 'Liệt kê việc cần làm tuần này (ai phụ trách, hạn chót, trạng thái)' },
]

export interface ChatViewProps {
  readonly title: string
  readonly subtitle: string
  readonly chat: ChatController
  /** Longest single read (days); longer periods are read month by month. */
  readonly maxRangeDays: number
  /** Longest period one request may cover (days). */
  readonly maxPeriodDays: number
  /** False when /api/health says the LLM provider is not configured. */
  readonly providerConfigured: boolean
  readonly onReauth: () => void
}

export function ChatView({ title, subtitle, chat, maxRangeDays, maxPeriodDays, providerConfigured, onReauth }: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  /** Whether the reader is at the bottom, which is what makes autoscroll safe. */
  const pinned = useRef(true)
  const turns = chat.thread?.turns ?? []

  // Follow the stream only while the reader has not scrolled up: yanking the
  // view back down mid-read is worse than losing the tail.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight
  }, [chat.thread])

  useEffect(() => {
    pinned.current = true
    // On touch screens focusing would pop the keyboard over the empty state.
    if (window.matchMedia('(pointer: fine)').matches) composer.current?.focus()
  }, [title])

  // Grow the composer with its content, up to the CSS max-height.
  useLayoutEffect(() => {
    const element = composer.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(element.scrollHeight)}px`
  }, [draft])

  const send = (text: string): void => {
    if (text.trim() === '' || chat.running) return
    pinned.current = true
    chat.send(text)
  }

  const submit = (): void => {
    if (draft.trim() === '' || chat.running) return
    send(draft)
    setDraft('')
  }

  /** The date picker fills the composer instead of sending, so the request can still be edited. */
  const fill = (text: string): void => {
    setDraft(text)
    setPicking(false)
    const element = composer.current
    if (element === null) return
    element.focus()
    requestAnimationFrame(() => { element.setSelectionRange(text.length, text.length) })
  }

  const chips = (className: string | undefined) => (
    <>
      {QUICK_PROMPTS.map(chip => (
        <button key={chip.label} type="button" className={className} disabled={chat.running} onClick={() => { send(chip.prompt) }}>
          {chip.label}
        </button>
      ))}
      <button
        type="button"
        className={className}
        aria-expanded={picking}
        onClick={() => { setPicking(value => !value) }}
      >
        📅 Chọn ngày/khoảng
      </button>
    </>
  )

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter breaks the line; never while an IME is composing
    // (Vietnamese Telex/VNI input relies on composition).
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <section className={css.column} aria-label={`Trò chuyện về ${title}`}>
      <div className={css.bar}>
        <div className={css.barTitle}>
          <span className={css.title}>{title}</span>
          <span className={css.subtitle}>{subtitle}</span>
        </div>
        <button
          type="button"
          className={css.newButton}
          onClick={() => { chat.reset(); setDraft(''); composer.current?.focus() }}
          disabled={turns.length === 0 && !chat.running}
          title="Bắt đầu lại: quên lịch sử hỏi đáp về nguồn này"
          aria-label="Cuộc trò chuyện mới"
        >
          <PlusIcon />
          <span>Cuộc trò chuyện mới</span>
        </button>
      </div>

      <div
        className={css.scroller}
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        <div className={css.thread}>
          {turns.length === 0
            ? (
              <div className={css.empty}>
                <div className={css.emptyBadge} aria-hidden="true">🐱</div>
                <h1 className={css.emptyTitle}>Hỏi MeoBeo về “{title}”</h1>
                <p className={css.emptyHint}>
                  Tóm tắt, liệt kê việc cần làm hoặc hỏi bất cứ điều gì đã được bàn trong nhóm — ngày, tuần hay
                  tháng nào trong quá khứ cũng được, ví dụ “tóm tắt ngày 6/9” hay “tuần thứ 2 tháng 8 có quyết định gì?”.
                  Tin nhắn chỉ được đọc khi bạn hỏi và không được lưu lại.
                </p>
                <div className={css.emptyChips}>{chips(css.chip)}</div>
              </div>
            )
            : turns.map(turn => (
              <TurnView key={turn.id} turn={turn} onReauth={onReauth} />
            ))}
        </div>
      </div>

      <div className={css.composerWrap}>
        {!providerConfigured && (
          <div className={css.notice} role="status">
            Máy chủ chưa cấu hình mô hình AI (LLM_PROVIDER và API key), nên chưa thể trả lời. Xem README.
          </div>
        )}
        {turns.length > 0 && <div className={css.chipRow}>{chips(css.chipSmall)}</div>}
        {picking && (
          <DatePicker
            maxRangeDays={maxRangeDays}
            maxPeriodDays={maxPeriodDays}
            onPick={fill}
            onClose={() => { setPicking(false) }}
          />
        )}
        <div className={css.composer}>
          <textarea
            ref={composer}
            className={css.input}
            value={draft}
            rows={1}
            placeholder="Hỏi về nhóm chat này, ví dụ “tuần thứ 2 tháng 8 có quyết định gì?”"
            aria-label="Câu hỏi"
            maxLength={4000}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={onKeyDown}
          />
          {chat.running
            ? (
              <button type="button" className={clsx(css.action, css.stop)} onClick={chat.stop}>
                <StopIcon />
                <span>Dừng</span>
              </button>
            )
            : (
              <button type="button" className={css.action} disabled={draft.trim() === ''} onClick={submit}>
                <SendIcon />
                <span>Gửi</span>
              </button>
            )}
        </div>
        <p className={css.composerHint}>
          Enter để gửi, Shift+Enter để xuống dòng. MeoBeo có thể sai — hãy đối chiếu tin gốc qua số trích dẫn #n.
        </p>
      </div>
    </section>
  )
}

/**
 * Native date inputs: one date asks about that day, two about the span between
 * them. Fills the composer rather than sending, so the request can be edited
 * ("Tóm tắt" → "Có quyết định gì…") before it goes out.
 */
function DatePicker({ maxRangeDays, maxPeriodDays, onPick, onClose }: {
  maxRangeDays: number
  maxPeriodDays: number
  onPick: (prompt: string) => void
  onClose: () => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const today = todayInputValue()
  const picked = pickDates(from, to, { today, maxRangeDays, maxPeriodDays })
  const hint = `Chọn một ngày, hoặc thêm ngày kết thúc để chọn khoảng. Mỗi lần đọc tối đa ${String(maxRangeDays)} ngày`
    + (maxPeriodDays > maxRangeDays ? `; khoảng dài hơn (tối đa ${String(maxPeriodDays)} ngày) được chia theo tháng.` : '.')

  return (
    <div className={css.picker} role="group" aria-label="Chọn ngày hoặc khoảng ngày">
      <label className={css.pickerField}>
        <span>Từ ngày</span>
        <input type="date" className={css.pickerInput} value={from} max={today} onChange={(event) => { setFrom(event.target.value) }} />
      </label>
      <label className={css.pickerField}>
        <span>Đến ngày <span className={css.muted}>(không bắt buộc)</span></span>
        <input
          type="date"
          className={css.pickerInput}
          value={to}
          min={from === '' ? undefined : from}
          max={today}
          onChange={(event) => { setTo(event.target.value) }}
        />
      </label>
      <div className={css.pickerActions}>
        <button
          type="button"
          className={css.pickerAction}
          disabled={picked.prompt === undefined}
          onClick={() => { if (picked.prompt !== undefined) onPick(picked.prompt) }}
        >
          Điền vào ô chat
        </button>
        <button type="button" className={css.pickerClose} onClick={onClose}>Đóng</button>
      </div>
      <p className={clsx(css.pickerHint, picked.prompt === undefined && picked.note !== undefined && css.pickerWarn)} aria-live="polite">
        {picked.prompt === undefined ? picked.note ?? hint : `“${picked.prompt}”${picked.note === undefined ? '' : ` — ${picked.note}`}`}
      </p>
    </div>
  )
}

function TurnView({ turn, onReauth }: { turn: Turn; onReauth: () => void }) {
  const live = turn.status === 'running'
  const answer = turn.answer.map(block => block.text).join('\n\n').trim()
  const nothing = !live && answer === '' && turn.error === undefined && turn.status === 'done'

  return (
    <article className={css.turn}>
      <div className={css.user}>{turn.prompt}</div>
      <Process turn={turn} />
      {answer !== '' && (
        <div className={clsx(css.answer, live && css.answerLive)} aria-live={live ? 'polite' : undefined}>
          <Markdown text={answer} />
        </div>
      )}
      {turn.error !== undefined && (
        <div className={css.error} role="alert">
          <span className={css.errorMessage}>{turn.error.message}</span>
          {turn.error.detail !== undefined && <span className={css.errorDetail}>{turn.error.detail}</span>}
          {turn.error.reauth === true && (
            <button type="button" className={css.errorAction} onClick={onReauth}>Đăng nhập lại</button>
          )}
        </div>
      )}
      <Footnote turn={turn} nothing={nothing} />
    </article>
  )
}

function Footnote({ turn, nothing }: { turn: Turn; nothing: boolean }) {
  const notes: string[] = []
  if (turn.status === 'stopped') notes.push('Đã dừng.')
  else if (nothing) notes.push('Không nhận được câu trả lời từ máy chủ.')
  else if (turn.status === 'done' && turn.completed === false) notes.push('Câu trả lời có thể chưa đầy đủ.')
  if (turn.usage !== undefined && turn.usage.totalTokens > 0) {
    notes.push(`${formatNumber(turn.usage.totalTokens)} token (vào ${formatNumber(turn.usage.inputTokens)} · ra ${formatNumber(turn.usage.outputTokens)})`)
  }
  if (notes.length === 0) return null
  return <div className={css.footnote}>{notes.join(' · ')}</div>
}

/** The turn's work: expanded while live, folded into one row once finished. */
function Process({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false)
  const live = turn.status === 'running'
  if (!live && turn.steps.length === 0) return null

  // A split period loads one transcript per month: they share one card, at the first one's place.
  const transcripts = turn.steps.flatMap(step => step.kind === 'transcript' ? [step] : [])
  const cardAt = transcripts[0]?.id
  const card = transcripts.length === 0 ? undefined : summarizeTranscripts(transcripts.map(step => step.stats))
  // The specialists then run once per month: name the month on each of their rows.
  const segmentOf = (step: Step): string | undefined => {
    if (transcripts.length < 2 || step.kind !== 'tool' || step.input === null || typeof step.input !== 'object') return undefined
    const id: unknown = Reflect.get(step.input, 'transcriptId')
    const stats = transcripts.find(item => item.stats.transcriptId === id)?.stats
    return stats === undefined ? undefined : windowLabel(stats)
  }
  const tools = turn.steps.filter(step => step.kind === 'tool').length
  const count = tools > 0 ? tools : turn.steps.length
  const body = (
    <ol className={css.steps}>
      {turn.steps.map((step) => {
        if (step.kind !== 'transcript') return <StepView key={step.id} step={step} live={live} segment={segmentOf(step)} />
        return step.id === cardAt && card !== undefined
          ? <li key={step.id} className={css.cardItem}><TranscriptCard summary={card} /></li>
          : null
      })}
      {live && <Working startedAt={turn.startedAt} />}
    </ol>
  )
  if (live) return <div className={css.process}>{body}</div>

  const span = turn.endedAt === undefined ? undefined : formatSpan(turn.endedAt - turn.startedAt)
  return (
    <div className={css.process}>
      <button
        type="button"
        className={css.processToggle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <ChevronIcon open={open} />
        <span>Quá trình</span>
        {span !== undefined && <span className={css.processMeta}>{span}</span>}
        <span className={css.processMeta}>{`${String(count)} bước`}</span>
      </button>
      {open && body}
    </div>
  )
}

/** Keep a clock moving while the server is between events. */
function Working({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(tick) }
  }, [])
  return (
    <li className={clsx(css.step, css.working)}>
      <span className={css.spinner} aria-hidden="true" />
      <span>Đang làm việc</span>
      <span className={css.muted}>{formatSpan(Math.max(0, now - startedAt))}</span>
    </li>
  )
}

function StepView({ step, live, segment }: { step: Exclude<Step, { kind: 'transcript' }>; live: boolean; segment: string | undefined }) {
  switch (step.kind) {
    case 'commentary':
      return <li className={clsx(css.step, css.commentary)}>{step.text.trim()}</li>
    case 'reasoning':
      return <Reasoning text={step.text} />
    case 'tool': {
      const input = describeToolInput(step.name, step.input)
      const detail = segment === undefined ? input : input === undefined ? segment : `${segment} · ${input}`
      return (
        <li className={css.step} data-status={step.status}>
          <StatusMark status={step.status} />
          <span className={css.toolName}>{TOOL_LABELS[step.name] ?? step.name}</span>
          {detail !== undefined && <span className={css.toolDetail}>{detail}</span>}
          {step.progress !== undefined && step.status !== 'failed' && <ProgressBar progress={step.progress} />}
          {step.status === 'failed' && <span className={css.failed}>lỗi</span>}
        </li>
      )
    }
    case 'fetch':
      return (
        <li className={css.step}>
          <StatusMark status={live ? 'running' : 'completed'} />
          <span>{describeFetch(step, live)}</span>
        </li>
      )
    case 'agent':
      return (
        <li className={css.step}>
          <StatusMark status={agentFinished(step) || !live ? 'completed' : 'running'} />
          <span className={css.toolName}>{AGENT_LABELS[step.agent]}</span>
          <ProgressBar progress={step} />
        </li>
      )
  }
}

function StatusMark({ status }: { status: 'running' | 'completed' | 'failed' }) {
  if (status === 'running') return <span className={css.spinner} aria-label="đang chạy" />
  return <span className={css.dot} data-status={status} aria-label={status === 'failed' ? 'lỗi' : 'xong'} />
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={clsx(css.step, css.reasoning)}>
      <button type="button" className={css.linkButton} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {open ? 'Ẩn suy luận' : `Suy luận · ${formatNumber(text.length)} ký tự`}
      </button>
      {open && <div className={css.reasoningBody}>{text}</div>}
    </li>
  )
}

/** Stage text plus a bar; map is most of the work, reduce the last stretch. */
function ProgressBar({ progress }: { progress: AgentProgress }) {
  const finished = agentFinished(progress)
  const total = Math.max(progress.total, 1)
  const ratio = Math.min(progress.done / total, 1)
  const fraction = finished
    ? 1
    : progress.stage === 'map'
      ? 0.85 * ratio
      : progress.stage === 'reduce' ? 0.85 + 0.15 * ratio : ratio
  const stage = finished
    ? 'xong'
    : progress.stage === 'map'
      ? `đọc từng phần ${String(progress.done)}/${String(progress.total)}`
      : progress.stage === 'reduce'
        ? `tổng hợp ${String(progress.done)}/${String(progress.total)}`
        : 'đang đọc toàn bộ'
  const percent = Math.round(fraction * 100)
  return (
    <span className={css.progressWrap}>
      <span className={css.progressText}>{stage}</span>
      <span className={css.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className={css.progressFill} style={{ width: `${String(percent)}%` }} />
      </span>
    </span>
  )
}

/**
 * What was read: the server's label of the window first (so a misread request
 * shows at a glance), then counts and people. A split period gets one compact
 * row per month and totals on top.
 */
function TranscriptCard({ summary }: { summary: TranscriptSummary }) {
  const { segments, participants, notes } = summary
  const shown = participants.slice(0, 6)
  const more = participants.length - shown.length
  const one = segments.length === 1 ? segments[0] : undefined
  const first = one?.firstMessageAt === undefined ? undefined : formatDateTime(one.firstMessageAt)
  const last = one?.lastMessageAt === undefined ? undefined : formatDateTime(one.lastMessageAt)

  return (
    <div className={css.card}>
      <div className={css.cardTitle}>{one === undefined ? `${String(segments.length)} khoảng thời gian` : windowLabel(one)}</div>
      <div className={css.cardStats}>
        <div className={css.stat}>
          <span className={css.statValue}>{formatNumber(summary.messageCount)}</span>
          <span className={css.statLabel}>tin nhắn</span>
        </div>
        <div className={css.stat}>
          <span className={css.statValue}>{formatNumber(participants.length)}</span>
          <span className={css.statLabel}>người tham gia</span>
        </div>
      </div>
      {one === undefined && (
        <ul className={css.segments}>
          {segments.map(stats => (
            <li key={stats.transcriptId} className={css.segment}>
              <span className={css.dot} data-status={stats.truncated ? 'warn' : 'completed'} aria-hidden="true" />
              <span className={css.segmentLabel}>{windowLabel(stats)}</span>
              <span className={css.muted}>
                {`${formatNumber(stats.messageCount)} tin nhắn · ${formatNumber(stats.participants.length)} người`}
                {stats.truncated ? ' · chưa đọc hết' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <div className={css.people}>
          {shown.map(name => <span key={name} className={css.person}>{clip(name, 32)}</span>)}
          {more > 0 && <span className={css.muted}>{`và ${String(more)} người khác`}</span>}
        </div>
      )}
      {first !== undefined && last !== undefined && (
        <div className={css.cardLine}>{`Tin đầu tiên ${first} · tin cuối ${last}`}</div>
      )}
      {notes.length > 0 && (
        <ul className={css.cardNotes}>
          {notes.map(note => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  )
}

/* Inline icons: four glyphs do not justify an icon package. */

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={clsx(css.chevron, open && css.chevronOpen)}>
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 8h9M8 3.5 12.5 8 8 12.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  )
}
