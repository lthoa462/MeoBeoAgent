/**
 * Offline scripted provider (LLM_PROVIDER=mock): lets the whole app — web UI,
 * Teams bot, tests — run without any API key, like the chat-agents sample's
 * mock-provider.ts. It is deterministic and only "pretends" to reason:
 *
 * - Coordinator requests (tools include load_messages):
 *   1. no load_messages result yet → call load_messages with a structured
 *      period inferred from the user text (inferPeriod: "ngày 6/9", "hôm qua",
 *      "tuần trước", "tuần 2 tháng 8", "tháng 8", "quý 3", "3 ngày qua",
 *      "từ 1/8 đến 15/8", "năm 2025"…; nothing recognized → no parameters = server
 *      default), dates taken from the per-turn "Current time:" line;
 *   2. after load_messages → no messages: answer directly; otherwise call the
 *      specialists IN ONE STEP (parallel): summarize_messages and
 *      extract_action_items, or answer_question when the text ends with "?" —
 *      for every non-empty segment when the period was split;
 *   3. after the specialists → final Vietnamese Markdown answer: a "Phạm vi"
 *      line with the server's label, the sections (per segment plus a closing
 *      overview for a split period) and the notes that limit completeness.
 * - Requests without tools (specialists, chunk-reader): a short Markdown digest
 *   of the transcript lines or notes in the prompt, shaped by the task — an
 *   overview for the summarizer, commitment-like lines for the action tracker,
 *   lines sharing words with the question for Q&A — so map-reduce is observable.
 *
 * The digest never repeats a message in full (only its first few words), so
 * tests can tell "derived from the transcript" apart from "the transcript".
 */

import { ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, GenerateOptions, Message, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin, type ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

export const MOCK_PROVIDER_ID = 'mock'
export const MOCK_MODEL_ID = 'mock-model'

export interface MockProviderOptions {
  /** Observe every request the adapter serves (tests inspect what each agent was sent). */
  readonly onRequest?: (request: GenerateOptions) => void
  /** Simulated thinking time per request, honoring the request's signal. Default 0. */
  readonly delayMs?: number
}

/** Plugin for createAgentRuntime({ providers: [mockProviderPlugin()] }). */
export function mockProviderPlugin(options: MockProviderOptions = {}): ComposableModelProviderPlugin {
  return defineModelProviderPlugin({
    id: MOCK_PROVIDER_ID,
    family: MOCK_PROVIDER_ID,
    displayName: 'MeoBeo mock (offline)',
    routes: [MOCK_PROVIDER_ID],
    defaultModel: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
    setup(registrar) {
      const remove = registrar.registerAdapter(new MockAdapter(options))
      return () => { remove(); return undefined }
    },
  })
}

class MockAdapter extends ModelAdapter {
  /** Tool-call ids only need to be unique; a counter keeps runs reproducible. */
  #calls = 0

  constructor(private readonly options: MockProviderOptions) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    // No reasoning efforts declared: the runtime must never send one to this route.
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.options.onRequest?.(request)
    if ((this.options.delayMs ?? 0) > 0) await delay(this.options.delayMs ?? 0, request.signal)
    request.signal?.throwIfAborted()
    const isCoordinator = request.tools?.some(tool => tool.name === 'load_messages') ?? false
    const step = isCoordinator ? coordinatorStep(request) : { text: workerDigest(lastUserText(request.messages)) }
    if ('calls' in step) yield * toolRound(step.commentary, step.calls, () => `call_${++this.#calls}`)
    else yield * textRound(step.text, request)
  }
}

// ---------------------------------------------------------------------------
// Coordinator script

interface ToolCallPlan {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

type CoordinatorStep =
  | { readonly commentary: string; readonly calls: readonly ToolCallPlan[] }
  | { readonly text: string }

interface ToolOutcome {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly text: string
  readonly isError: boolean
}

/** One loaded window as load_messages reports it (the whole result, or one segment of a split). */
interface LoadedWindow {
  readonly transcriptId: string
  readonly label: string
  readonly messageCount: number
  readonly participants: number
  readonly notes: readonly string[]
  /** clamped, truncated or scanLimited: its notes change how complete the answer is. */
  readonly limited: boolean
}

const TITLES: Readonly<Record<string, string>> = {
  summarize_messages: '**Tổng quan**',
  extract_action_items: '**Việc cần làm**',
  answer_question: '**Trả lời**',
}

function coordinatorStep(request: GenerateOptions): CoordinatorStep {
  const messages = request.messages
  const lastUser = findLastIndex(messages, message => message.source.kind === 'user')
  const userText = lastUser < 0 ? '' : textOf(messages[lastUser]?.content ?? [])
  const outcomes = toolOutcomes(messages.slice(lastUser + 1))

  const load = outcomes.findLast(outcome => outcome.name === 'load_messages')
  if (load === undefined) {
    return {
      commentary: 'Mình sẽ tải tin nhắn trong khoảng thời gian bạn hỏi.',
      calls: [{ name: 'load_messages', args: inferPeriod(userText, currentDate(request.system)) }],
    }
  }

  const result = parseJson(load.text)
  const error = typeof result?.error === 'string' ? result.error : undefined
  if (load.isError || error !== undefined || result === undefined) {
    // Drop argument examples such as { "period": "month", … } meant for the model, not for the user.
    const reason = (error ?? (load.text.trim() || 'lỗi không xác định')).replace(/\s*\{[^{}]*\}/g, '')
    return { text: `Không tải được tin nhắn: ${reason}` }
  }
  const windows = (Array.isArray(result.segments) ? result.segments : [result]).map(loadedWindow)
  const total = windows.reduce((sum, window) => sum + window.messageCount, 0)
  const label = typeof result.label === 'string' ? result.label : 'khoảng thời gian đã đọc'
  const scope = windows.length > 1
    ? `**Phạm vi:** ${label} · ${total} tin nhắn, chia thành ${windows.length} đoạn theo tháng.`
    : `**Phạm vi:** ${label} · ${total} tin nhắn${total > 0 ? ` của ${windows[0]?.participants ?? 0} người` : ''}.`
  if (total === 0) {
    return { text: `${scope}\n\nKhông có tin nhắn nào trong khoảng thời gian này. Hãy thử một khoảng khác, ví dụ 7 ngày qua.` }
  }

  const specialists = outcomes.filter(outcome => outcome.name !== 'load_messages')
  if (specialists.length === 0) {
    const question = userText.trim().endsWith('?')
    const calls = windows.filter(window => window.messageCount > 0).flatMap(({ transcriptId }): ToolCallPlan[] => question
      ? [{ name: 'answer_question', args: { transcriptId, question: userText.trim() } }]
      : [
          { name: 'summarize_messages', args: { transcriptId } },
          { name: 'extract_action_items', args: { transcriptId } },
        ])
    const work = question ? 'tìm câu trả lời' : 'tóm tắt và liệt kê việc cần làm'
    return {
      commentary: windows.length > 1
        ? `Khoảng này được chia thành ${windows.length} đoạn theo tháng; mình sẽ ${work} cho từng đoạn cùng lúc.`
        : `Đã tải xong, mình sẽ ${work}.`,
      calls,
    }
  }
  return { text: finalAnswer(scope, windows, specialists) }
}

function finalAnswer(scope: string, windows: readonly LoadedWindow[], outcomes: readonly ToolOutcome[]): string {
  const sections = (window: LoadedWindow): string => outcomes
    .filter(outcome => outcome.args.transcriptId === window.transcriptId)
    .map(outcome => `${TITLES[outcome.name] ?? `**${outcome.name}**`}\n${outcome.isError ? '(lỗi)' : outcome.text}`)
    .join('\n\n')
  const split = windows.length > 1
  const notes = windows
    .filter(window => window.limited)
    .flatMap(window => window.notes.map(note => (split ? `${window.label}: ${note}` : note)))
  const footer = notes.length === 0 ? '' : `\n\n_${notes.join(' ')}_`
  const [only] = windows
  if (!split && only !== undefined) return `${scope}\n\n${sections(only)}${footer}`

  const perSegment = windows.map(window => `### ${window.label} · ${window.messageCount} tin nhắn\n\n${
    window.messageCount === 0 ? 'Không có tin nhắn nào trong đoạn này.' : sections(window)
  }`)
  const busiest = windows.reduce((best, window) => (window.messageCount > best.messageCount ? window : best))
  const quiet = windows.filter(window => window.messageCount === 0).map(window => window.label)
  const overview = [
    '### Tổng hợp cả giai đoạn',
    `- Số tin nhắn: ${windows.map(window => `${window.label} ${window.messageCount}`).join(', ')}; sôi nổi nhất là ${busiest.label}.`,
    ...(quiet.length === 0 ? [] : [`- Không có tin nhắn: ${quiet.join(', ')}.`]),
    '- Việc cần làm được liệt kê theo từng đoạn ở trên; trích dẫn #n đánh số lại trong mỗi đoạn.',
  ].join('\n')
  return [scope, ...perSegment, overview].join('\n\n') + footer
}

function loadedWindow(value: unknown): LoadedWindow {
  const stats = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    transcriptId: String(stats.transcriptId ?? ''),
    label: typeof stats.label === 'string' ? stats.label : '?',
    messageCount: typeof stats.messageCount === 'number' ? stats.messageCount : 0,
    participants: Array.isArray(stats.participants) ? stats.participants.length : 0,
    notes: Array.isArray(stats.notes) ? stats.notes.filter(note => typeof note === 'string') : [],
    limited: stats.clamped === true || stats.truncated === true || stats.scanLimited === true,
  }
}

/** Results of the tools called since the last user message, with their tool names and arguments. */
function toolOutcomes(messages: readonly Message[]): ToolOutcome[] {
  const calls = new Map<string, { readonly name: string; readonly args: Readonly<Record<string, unknown>> }>()
  const outcomes: ToolOutcome[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, { name: block.name, args: parseJson(block.arguments) ?? {} })
      if (block.type === 'tool-result') {
        const call = calls.get(block.toolCallId)
        outcomes.push({ name: call?.name ?? '', args: call?.args ?? {}, text: textOf(block.content), isError: block.isError === true })
      }
    }
  }
  return outcomes
}

const DAY_MS = 86_400_000
/** The line session.ts puts in the per-turn instructions (the prompts also contain example dates). */
const CURRENT_TIME = /Current time: (\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/

/** The user's calendar date "now" (as the UTC midnight of that date), as the per-turn instructions state it. */
function currentDate(system: string | undefined): number {
  const match = system === undefined ? null : CURRENT_TIME.exec(system)
  if (match === null) return Date.now() - (Date.now() % DAY_MS)
  const [, y, m, d] = match
  return Date.UTC(Number(y), Number(m) - 1, Number(d))
}

const UNITS: Readonly<Record<string, string>> = {
  giờ: 'hour', tiếng: 'hour', hour: 'hour', hours: 'hour',
  ngày: 'day', day: 'day', days: 'day',
  tuần: 'week', week: 'week', weeks: 'week',
  tháng: 'month', month: 'month', months: 'month',
}
const DATE = String.raw`(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?`
const YEAR = String.raw`(?:\s*(?:\/|năm)\s*(\d{4}))?`
const PATTERNS = {
  between: new RegExp(String.raw`(?:từ|from)\s+(?:ngày\s+)?${DATE}\s*(?:đến|tới|to|-|–)\s*(?:ngày\s+)?${DATE}`),
  quarter: new RegExp(String.raw`(?:quý|quarter|\bq)\s*([1-4])${YEAR}`),
  weekOfMonth: new RegExp(String.raw`tuần\s+(?:thứ\s+)?([1-5])\s+(?:của\s+)?tháng\s+(\d{1,2})${YEAR}`),
  longDate: /ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/,
  // Not the "8/2026" of "tháng 8/2026".
  date: new RegExp(String.raw`(?<!tháng\s{0,3})(?<![\d/])${DATE}(?![\d/])`),
  last: /(\d+)\s*(giờ|tiếng|hours?|ngày|days?|tuần|weeks?|tháng|months?)/,
  month: new RegExp(String.raw`(?:tháng|month)\s+(\d{1,2})${YEAR}`),
  year: /(?:năm|year)\s+(\d{4})/,
}

/**
 * The load_messages arguments a real model should send for `text`, with
 * `today` the user's calendar date (UTC midnight). Dates are dd/MM; a date or
 * month without a year is its most recent past occurrence. Unrecognized text
 * → {} (the server's default window).
 */
export function inferPeriod(text: string, today: number): Record<string, string | number> {
  const lower = text.toLowerCase().normalize('NFC')
  const current = new Date(today)
  const year = current.getUTCFullYear()
  const month = current.getUTCMonth() + 1
  const pastYear = (m: number): number => (m > month ? year - 1 : year)
  /** Most recent day/month on or before today, unless the year is given. */
  const pastDay = (d: number, m: number, y: string | undefined): number => {
    if (y !== undefined) return Date.UTC(Number(y), m - 1, d)
    const candidate = Date.UTC(year, m - 1, d)
    return candidate <= today ? candidate : Date.UTC(year - 1, m - 1, d)
  }
  const day = (wall: number) => ({ period: 'day', date: isoDate(wall) })
  const week = (wall: number) => ({ period: 'week_containing', date: isoDate(wall) })
  const monthOf = (y: number, m: number) => ({ period: 'month', month: `${y}-${pad(m)}` })

  const between = PATTERNS.between.exec(lower)
  if (between !== null) {
    const [, d1, m1, y1, d2, m2, y2] = between
    const since = pastDay(Number(d1), Number(m1), y1)
    const sinceYear = new Date(since).getUTCFullYear()
    let end = Date.UTC(y2 === undefined ? sinceYear : Number(y2), Number(m2) - 1, Number(d2))
    // "từ 20/12 đến 5/1": the end falls in the next year.
    if (end < since && y2 === undefined) end = Date.UTC(sinceYear + 1, Number(m2) - 1, Number(d2))
    return { period: 'range', since: isoDate(since), until: isoDate(end + DAY_MS) }
  }
  const quarter = PATTERNS.quarter.exec(lower)
  if (quarter !== null) {
    const q = Number(quarter[1])
    const first = 3 * q - 2
    const y = quarter[2] === undefined ? pastYear(first) : Number(quarter[2])
    return { period: 'range', since: `${y}-${pad(first)}-01`, until: q === 4 ? `${y + 1}-01-01` : `${y}-${pad(first + 3)}-01` }
  }
  const weekOfMonth = PATTERNS.weekOfMonth.exec(lower)
  if (weekOfMonth !== null) {
    const m = Number(weekOfMonth[2])
    const y = weekOfMonth[3] === undefined ? pastYear(m) : Number(weekOfMonth[3])
    return { period: 'week_of_month', month: `${y}-${pad(m)}`, week: Number(weekOfMonth[1]) }
  }
  const date = PATTERNS.longDate.exec(lower) ?? PATTERNS.date.exec(lower)
  if (date !== null && Number(date[2]) >= 1 && Number(date[2]) <= 12) return day(pastDay(Number(date[1]), Number(date[2]), date[3]))
  if (/hôm nay|today/.test(lower)) return day(today)
  if (/hôm qua|yesterday/.test(lower)) return day(today - DAY_MS)
  if (/tuần này|this week/.test(lower)) return week(today)
  if (/tuần trước|tuần rồi|last week/.test(lower)) return week(today - 7 * DAY_MS)
  if (/tháng này|this month/.test(lower)) return monthOf(year, month)
  if (/tháng trước|last month/.test(lower)) return month === 1 ? monthOf(year - 1, 12) : monthOf(year, month - 1)
  const last = PATTERNS.last.exec(lower)
  if (last !== null) return { period: 'last', amount: Number(last[1]), unit: UNITS[last[2] ?? ''] ?? 'day' }
  const named = PATTERNS.month.exec(lower)
  if (named !== null) {
    const m = Number(named[1])
    if (m >= 1 && m <= 12) return monthOf(named[2] === undefined ? pastYear(m) : Number(named[2]), m)
  }
  // A whole year is longer than any period limit: the server refuses it and the answer explains why.
  const wholeYear = PATTERNS.year.exec(lower)?.[1] ?? (/năm ngoái|last year/.test(lower) ? String(year - 1) : undefined)
  if (wholeYear !== undefined) return { period: 'range', since: `${wholeYear}-01-01`, until: `${Number(wholeYear) + 1}-01-01` }
  return {}
}

function isoDate(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// Specialist / chunk-reader script

const LINE = /^\s*(?:↳\s*)?\[#(\d+) ([^\]]+)\] ([^:\n]+): (.*)$/
const FIRST_WORDS = 5
const MAX_ITEMS = 6
const NOTHING = '(không có gì liên quan)'
const NO_ACTIONS = 'Không có việc cần làm nào.'
/** Words that make a message look like a task, a commitment or a request. */
const ACTION_WORDS = /(?:^|[\s,(])(?:sẽ|nhờ|cần|hạn|deadline|phụ trách|nhận|giao|chốt|todo|i'll|please)(?=[\s,.!?:)]|$)/
const QA_STOPWORDS = new Set(['có', 'không', 'gì', 'nào', 'của', 'cho', 'và', 'là', 'đã', 'chưa', 'the', 'what', 'who', 'when'])

type WorkerTask = 'summary' | 'actions' | 'qa'

/** A compact digest of whatever transcript or notes the request carries, shaped by its task. */
function workerDigest(prompt: string): string {
  const head = prompt.split('\n', 1)[0] ?? ''
  const task: WorkerTask = /chuyên gia theo dõi việc cần làm|^Nhiệm vụ: Liệt kê các việc cần làm/.test(head)
    ? 'actions'
    : /chuyên gia trả lời câu hỏi|^Nhiệm vụ: Trả lời câu hỏi/.test(head) ? 'qa' : 'summary'
  // "Nhiệm vụ: …" is the final answer for the coordinator; "Nhiệm vụ cuối cùng …" asks for notes.
  const final = head.startsWith('Nhiệm vụ:')

  const transcript = between(prompt, 'transcript')
  if (transcript !== undefined) {
    const lines = transcript.split('\n').map(line => LINE.exec(line)).filter(match => match !== null)
    if (lines.length === 0) return NOTHING
    if (task === 'actions') {
      const items = lines.filter(line => ACTION_WORDS.test((line[4] ?? '').toLowerCase())).slice(0, MAX_ITEMS).map(actionItem)
      return items.length > 0 ? items.join('\n') : final ? NO_ACTIONS : NOTHING
    }
    if (task === 'qa') {
      const words = (head.split('câu hỏi:').at(-1) ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2 && !QA_STOPWORDS.has(word))
      const hits = lines.filter(line => words.some(word => (line[4] ?? '').toLowerCase().includes(word))).slice(0, 3)
      if (hits.length === 0) return final ? '(mock) Không thấy tin nhắn nào nói trực tiếp về câu hỏi này.' : NOTHING
      return [`- (mock) ${hits.length} tin nhắn liên quan nhất:`, ...hits.map(sample)].join('\n')
    }
    const counts = new Map<string, number>()
    for (const line of lines) counts.set(line[3] ?? '', (counts.get(line[3] ?? '') ?? 0) + 1)
    const authors = [...counts].map(([name, count]) => `${name} (${count})`).join(', ')
    const first = lines[0]?.[1] ?? '?'
    const last = lines.at(-1)?.[1] ?? '?'
    return [`- (mock) ${lines.length} tin nhắn #${first}–#${last} của ${counts.size} người: ${authors}.`, ...lines.slice(0, 3).map(sample)].join('\n')
  }

  const notes = between(prompt, 'notes')
  if (notes !== undefined) {
    const bullets = notes.split('\n').filter(line => line.trimStart().startsWith('-')).map(line => line.trim())
    if (task === 'actions') {
      const items = [...new Set(bullets.filter(line => line.includes('— hạn:')))].slice(0, MAX_ITEMS)
      return items.length > 0 ? items.join('\n') : final ? NO_ACTIONS : NOTHING
    }
    const citations = [...new Set(notes.match(/#\d+/g) ?? [])]
    return [
      `- (mock) Gộp ${bullets.length} ghi chú, trích dẫn: ${citations.slice(0, 8).join(', ') || 'không có'}.`,
      ...bullets.slice(0, 3).map(line => `- ${line.replace(/^-\s*/, '').slice(0, 80)}`),
    ].join('\n')
  }
  return '(mock) Không thấy dữ liệu hội thoại trong yêu cầu.'
}

/** "- 05/10 09:00 Lan (#1): "Em sẽ gửi bản thiết…"". */
function sample(line: RegExpExecArray): string {
  return `- ${line[2]} ${line[3]} (#${line[1]}): "${firstWords(line[4] ?? '')}"`
}

/** "- **"Em sẽ gửi bản thiết…"** — Lan — hạn: 05/10 (#1)": a deadline only when the message states a date. */
function actionItem(line: RegExpExecArray): string {
  const deadline = /\b(\d{1,2}\/\d{1,2})\b/.exec(line[4] ?? '')?.[1] ?? 'chưa rõ'
  return `- **"${firstWords(line[4] ?? '')}"** — ${line[3]} — hạn: ${deadline} (#${line[1]})`
}

function between(text: string, tag: string): string | undefined {
  const start = text.indexOf(`<${tag}>`)
  const end = text.lastIndexOf(`</${tag}>`)
  return start < 0 || end < start ? undefined : text.slice(start + tag.length + 2, end)
}

function firstWords(text: string): string {
  const words = text.trim().split(/\s+/)
  return words.length <= FIRST_WORDS ? words.join(' ') : `${words.slice(0, FIRST_WORDS).join(' ')}…`
}

// Chunk plumbing

function toolRound(commentary: string, calls: readonly ToolCallPlan[], nextId: () => string): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: commentary, phase: 'commentary' },
    { type: 'block-end', index: 0, block: { type: 'text', text: commentary, phase: 'commentary' } },
  ]
  calls.forEach((call, offset) => {
    chunks.push({
      type: 'block-end',
      index: offset + 1,
      block: { type: 'tool-call', id: ToolCallId(nextId()), name: call.name, arguments: JSON.stringify(call.args) },
    })
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 50, outputTokens: 10 + calls.length * 10 } })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

function textRound(text: string, request: GenerateOptions): StreamChunk[] {
  const chunks: StreamChunk[] = []
  // Several deltas, so streaming consumers see more than one frame.
  for (const piece of text.match(/[^\n]*\n?/g)?.filter(part => part !== '') ?? [text]) {
    chunks.push({ type: 'text-delta', index: 0, text: piece, phase: 'final-answer' })
  }
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text, phase: 'final-answer' } })
  const input = request.messages.reduce((sum, message) => sum + textOf(message.content).length, request.system?.length ?? 0)
  chunks.push({ type: 'usage', usage: { inputTokens: Math.ceil(input / 4), outputTokens: Math.ceil(text.length / 4) } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

function lastUserText(messages: readonly Message[]): string {
  const index = findLastIndex(messages, message => message.role === 'user')
  return index < 0 ? '' : textOf(messages[index]?.content ?? [])
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
