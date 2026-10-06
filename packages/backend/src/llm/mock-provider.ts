/**
 * Offline scripted provider (LLM_PROVIDER=mock): lets the whole app — web UI,
 * Teams bot, tests — run without any API key, like the chat-agents sample's
 * mock-provider.ts. It is deterministic and only "pretends" to reason:
 *
 * - Coordinator requests (tools include load_messages):
 *   1. no load_messages result yet → call load_messages with a window inferred
 *      from the user text ("N ngày"/"N days", "hôm qua", "tuần", "tháng"; default
 *      omitted = server default) expressed as ISO `since`;
 *   2. after load_messages → if messageCount is 0, answer directly; else call
 *      summarize_messages and extract_action_items IN THE SAME STEP (parallel),
 *      or answer_question when the user text ends with "?";
 *   3. after specialists → final answer in Vietnamese Markdown quoting their output.
 * - Requests without tools (specialists, chunk-reader): return a short
 *   Markdown digest derived from the transcript lines in the prompt (counts by
 *   author, first lines, "#n" citations), so map-reduce is observable.
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
  readonly text: string
  readonly isError: boolean
}

function coordinatorStep(request: GenerateOptions): CoordinatorStep {
  const messages = request.messages
  const lastUser = findLastIndex(messages, message => message.source.kind === 'user')
  const userText = lastUser < 0 ? '' : textOf(messages[lastUser]?.content ?? [])
  const outcomes = toolOutcomes(messages.slice(lastUser + 1))

  const load = outcomes.findLast(outcome => outcome.name === 'load_messages')
  if (load === undefined) {
    const now = currentTime(request.system)
    return {
      commentary: 'Mình sẽ tải tin nhắn trong khoảng thời gian bạn hỏi.',
      calls: [{ name: 'load_messages', args: inferWindow(userText, now) }],
    }
  }

  const stats = parseJson(load.text)
  const error = typeof stats?.error === 'string' ? stats.error : undefined
  if (load.isError || error !== undefined || stats === undefined) {
    return { text: `Không tải được tin nhắn: ${error ?? 'lỗi không xác định'}` }
  }
  const scope = `Phạm vi: ${String(stats.since)} → ${String(stats.until)}, ${String(stats.messageCount)} tin nhắn.`
  if (stats.messageCount === 0) {
    return { text: `${scope}\n\nKhông có tin nhắn nào trong khoảng thời gian này. Hãy thử một khoảng rộng hơn, ví dụ 7 ngày qua.` }
  }

  const specialists = outcomes.filter(outcome => outcome.name !== 'load_messages')
  if (specialists.length === 0) {
    const transcriptId = stats.transcriptId
    const question = userText.trim().endsWith('?')
    return {
      commentary: question ? 'Đã tải xong, mình sẽ tìm câu trả lời.' : 'Đã tải xong, mình sẽ tóm tắt và liệt kê việc cần làm.',
      calls: question
        ? [{ name: 'answer_question', args: { transcriptId, question: userText.trim() } }]
        : [
            { name: 'summarize_messages', args: { transcriptId } },
            { name: 'extract_action_items', args: { transcriptId } },
          ],
    }
  }

  const titles: Record<string, string> = {
    summarize_messages: '**Tổng quan**',
    extract_action_items: '**Việc cần làm**',
    answer_question: '**Trả lời**',
  }
  const sections = specialists.map(outcome => `${titles[outcome.name] ?? `**${outcome.name}**`}\n${outcome.isError ? '(lỗi)' : outcome.text}`)
  const notes = Array.isArray(stats.notes) && stats.clamped === true ? `\n\n_${stats.notes.join(' ')}_` : ''
  return { text: `${scope}\n\n${sections.join('\n\n')}${notes}` }
}

/** Results of the tools called since the last user message, with their tool names. */
function toolOutcomes(messages: readonly Message[]): ToolOutcome[] {
  const names = new Map<string, string>()
  const outcomes: ToolOutcome[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') names.set(block.id, block.name)
      if (block.type === 'tool-result') {
        outcomes.push({ name: names.get(block.toolCallId) ?? '', text: textOf(block.content), isError: block.isError === true })
      }
    }
  }
  return outcomes
}

const DAY_MS = 86_400_000
/** The line session.ts puts in the per-turn instructions (the prompts also contain example dates). */
const CURRENT_TIME = /Current time: ((\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2})?([+-]\d{2}:\d{2}|Z))/

interface CurrentTime {
  readonly epochMs: number
  /** The user's UTC offset as printed in the per-turn instructions, e.g. "+07:00". */
  readonly offset: string
  /** The user's calendar date at that instant, as epoch ms of its UTC midnight. */
  readonly dateUtc: number
}

/** "Now" as the per-turn instructions state it; the mock has no other clock it may trust. */
function currentTime(system: string | undefined): CurrentTime {
  const match = system === undefined ? null : CURRENT_TIME.exec(system)
  if (match === null) {
    const now = Date.now()
    return { epochMs: now, offset: 'Z', dateUtc: now - (now % DAY_MS) }
  }
  const [, iso = '', y, mo, d, offset = 'Z'] = match
  return { epochMs: Date.parse(iso), offset, dateUtc: Date.UTC(Number(y), Number(mo) - 1, Number(d)) }
}

function inferWindow(text: string, now: CurrentTime): Record<string, string> {
  const lower = text.toLowerCase()
  const startOfDay = (daysAgo: number) => `${new Date(now.dateUtc - daysAgo * DAY_MS).toISOString().slice(0, 10)}T00:00:00${now.offset}`
  if (/hôm qua|yesterday/.test(lower)) return { since: startOfDay(1), until: startOfDay(0) }
  if (/hôm nay|today/.test(lower)) return { since: startOfDay(0) }
  const hours = /(\d+)\s*(giờ|tiếng|hours?)/.exec(lower)
  if (hours !== null) return { since: new Date(now.epochMs - Number(hours[1]) * 3_600_000).toISOString() }
  const days = /(\d+)\s*(ngày|days?)/.exec(lower)
  if (days !== null) return { since: new Date(now.epochMs - Number(days[1]) * DAY_MS).toISOString() }
  if (/tuần|week/.test(lower)) return { since: new Date(now.epochMs - 7 * DAY_MS).toISOString() }
  if (/tháng|month/.test(lower)) return { since: new Date(now.epochMs - 30 * DAY_MS).toISOString() }
  return {}
}

// ---------------------------------------------------------------------------
// Specialist / chunk-reader script

const LINE = /^\s*(?:↳\s*)?\[#(\d+) ([^\]]+)\] ([^:\n]+): (.*)$/
const FIRST_WORDS = 5

/** A compact digest of whatever transcript or notes the request carries. */
function workerDigest(prompt: string): string {
  const transcript = between(prompt, 'transcript')
  if (transcript !== undefined) {
    const lines = transcript.split('\n').map(line => LINE.exec(line)).filter(match => match !== null)
    if (lines.length === 0) return '(không có gì liên quan)'
    const counts = new Map<string, number>()
    for (const line of lines) counts.set(line[3] ?? '', (counts.get(line[3] ?? '') ?? 0) + 1)
    const authors = [...counts].map(([name, count]) => `${name} (${count})`).join(', ')
    const first = lines[0]?.[1] ?? '?'
    const last = lines.at(-1)?.[1] ?? '?'
    const samples = lines.slice(0, 3).map(line => `- ${line[2]} ${line[3]} (#${line[1]}): "${firstWords(line[4] ?? '')}"`)
    return [`- (mock) ${lines.length} tin nhắn #${first}–#${last} của ${counts.size} người: ${authors}.`, ...samples].join('\n')
  }
  const notes = between(prompt, 'notes')
  if (notes !== undefined) {
    const bullets = notes.split('\n').filter(line => line.trimStart().startsWith('-'))
    const citations = [...new Set(notes.match(/#\d+/g) ?? [])]
    return [
      `- (mock) Gộp ${bullets.length} ghi chú, trích dẫn: ${citations.slice(0, 8).join(', ') || 'không có'}.`,
      ...bullets.slice(0, 3).map(line => `- ${line.trim().replace(/^-\s*/, '').slice(0, 80)}`),
    ].join('\n')
  }
  return '(mock) Không thấy dữ liệu hội thoại trong yêu cầu.'
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

// ---------------------------------------------------------------------------
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
