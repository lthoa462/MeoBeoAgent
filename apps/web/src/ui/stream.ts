/**
 * Pure pieces of the chat transport: the SSE frame reader and the fold of one
 * wire event into a turn. Kept free of React so they can be unit tested.
 */

import { parseWireEvent, type SpecialistKind, type WireEvent } from '@meobeo/backend/wire'
import type { AgentProgress, Step, Turn } from './types'

/** The coordinator tool that runs each specialist; its row carries the progress bar. */
const SPECIALIST_TOOL: Readonly<Record<SpecialistKind, string>> = {
  summarizer: 'summarize_messages',
  'action-tracker': 'extract_action_items',
  qa: 'answer_question',
}

/**
 * Parse an SSE body into wire events. Frames are separated by a blank line;
 * `:` lines are comments (the server's keep-alive pings) and are skipped.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<WireEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/gu, '\n')
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const event = parseFrame(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        if (event !== undefined) yield event
        split = buffer.indexOf('\n\n')
      }
    }
    // A server that closes without the trailing blank line still meant the last frame.
    const event = parseFrame(buffer + decoder.decode())
    if (event !== undefined) yield event
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function parseFrame(frame: string): WireEvent | undefined {
  const data = frame.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(line.startsWith('data: ') ? 6 : 5))
  return data.length === 0 ? undefined : parseWireEvent(data.join('\n'))
}

let counter = 0
const localId = (prefix: string): string => `${prefix}${String(++counter)}`

/** Fold one wire event into the running turn. */
export function reduceTurn(turn: Turn, event: WireEvent): Turn {
  switch (event.t) {
    case 'text-delta': {
      const index = turn.answer.findIndex(block => block.blockId === event.blockId)
      if (index === -1) return { ...turn, answer: [...turn.answer, { blockId: event.blockId, text: event.text }] }
      return { ...turn, answer: turn.answer.map((block, at) => at === index ? { ...block, text: block.text + event.text } : block) }
    }
    case 'commentary': {
      const index = turn.steps.findIndex(step => step.kind === 'commentary' && step.blockId === event.blockId)
      if (index === -1) {
        return withStep(turn, { kind: 'commentary', id: localId('c'), blockId: event.blockId, text: event.text })
      }
      return replaceStep(turn, index, step => step.kind === 'commentary' ? { ...step, text: step.text + event.text } : step)
    }
    case 'reasoning-delta': {
      const last = turn.steps.at(-1)
      if (last?.kind === 'reasoning') {
        return replaceStep(turn, turn.steps.length - 1, step => step.kind === 'reasoning' ? { ...step, text: step.text + event.text } : step)
      }
      return withStep(turn, { kind: 'reasoning', id: localId('r'), text: event.text })
    }
    case 'tool-call': {
      // Text streamed before a tool call was narration, not the final answer:
      // move it into the process so the answer region holds only the last word.
      const narration: Step[] = turn.answer
        .filter(block => block.text.trim() !== '')
        .map(block => ({ kind: 'commentary', id: localId('c'), blockId: block.blockId, text: block.text }))
      return {
        ...turn,
        answer: [],
        steps: [...turn.steps, ...narration, { kind: 'tool', id: event.callId, name: event.name, input: event.input, status: 'running' }],
      }
    }
    case 'tool-result': {
      const index = turn.steps.findIndex(step => step.kind === 'tool' && step.id === event.callId)
      if (index === -1) return turn
      return replaceStep(turn, index, step => step.kind === 'tool' ? { ...step, status: event.isError ? 'failed' : 'completed' } : step)
    }
    case 'fetch-progress': {
      const progress = {
        fetched: event.fetched,
        ...(event.scannedBackTo === undefined ? {} : { scannedBackTo: event.scannedBackTo }),
        ...(event.segment === undefined ? {} : { segment: event.segment }),
      }
      // Each segment of a split period keeps its own line until its transcript arrives.
      const index = openFetch(turn.steps, event.segment)
      if (index === -1) return withStep(turn, { kind: 'fetch', id: localId('f'), ...progress })
      return replaceStep(turn, index, step => ({ kind: 'fetch', id: step.id, ...progress }))
    }
    case 'transcript': {
      // The stats card supersedes the "fetched N so far" line of the same load:
      // the line of its segment, else the open line of a plain (unsplit) read.
      const own = openFetch(turn.steps, event.stats.label)
      const index = own === -1 ? openFetch(turn.steps, undefined) : own
      const steps = index === -1 ? turn.steps : turn.steps.filter((_step, at) => at !== index)
      // The same transcript loaded again (served from memory) is one transcript, not two.
      const known = steps.findIndex(step => step.kind === 'transcript' && step.stats.transcriptId === event.stats.transcriptId)
      if (known !== -1) {
        return { ...turn, steps: steps.map((step, at) => at === known && step.kind === 'transcript' ? { ...step, stats: event.stats } : step) }
      }
      return { ...turn, steps: [...steps, { kind: 'transcript', id: localId('t'), stats: event.stats }] }
    }
    case 'agent-progress': {
      const next: AgentProgress = { agent: event.agent, stage: event.stage, done: event.done, total: event.total }
      // The server names the call; an older one does not, and then the earliest
      // running call of that tool is the best guess for whose progress this is.
      const tool = event.callId !== undefined
        ? turn.steps.findIndex(step => step.kind === 'tool' && step.id === event.callId)
        : turn.steps.findIndex(step => step.kind === 'tool' && step.name === SPECIALIST_TOOL[event.agent]
          && step.status === 'running' && (step.progress === undefined || !agentFinished(step.progress)))
      if (tool !== -1) return replaceStep(turn, tool, step => step.kind === 'tool' ? { ...step, progress: next } : step)
      const index = findLastIndex(turn.steps, step => step.kind === 'agent' && step.agent === event.agent && !agentFinished(step))
      if (index === -1) return withStep(turn, { kind: 'agent', id: localId('a'), ...next })
      return replaceStep(turn, index, step => step.kind === 'agent' ? { ...step, ...next } : step)
    }
    case 'done': {
      const answered = turn.answer.some(block => block.text.trim() !== '')
      return {
        ...turn,
        completed: event.completed,
        usage: event.usage,
        ...(answered || event.text.trim() === '' ? {} : { answer: [{ blockId: 'final', text: event.text }] }),
      }
    }
    case 'error':
      return {
        ...turn,
        status: 'failed',
        error: {
          message: event.message,
          detail: event.code,
          ...(isAuthErrorCode(event.code) ? { reauth: true } : {}),
        },
      }
    case 'run-start':
      return turn
    default:
      // A frame type this build does not know yet (newer backend).
      return turn
  }
}

/** An `error` frame caused by the Microsoft token (expired, revoked): offer to sign in again. */
export function isAuthErrorCode(code: unknown): boolean {
  return /401|unauthori[sz]ed|invalid_token|token_expired/iu.test(String(code))
}

/** Close a turn when its stream ends, however it ended. */
export function settleTurn(turn: Turn, outcome: 'ended' | 'stopped', now: number): Turn {
  const status: Turn['status'] = turn.status !== 'running'
    ? turn.status
    : outcome === 'stopped' ? 'stopped' : 'done'
  return {
    ...turn,
    status,
    endedAt: now,
    // A tool still "running" when the stream closed did not finish.
    steps: turn.steps.map(step => step.kind === 'tool' && step.status === 'running'
      ? { ...step, status: status === 'done' ? 'completed' : 'failed' }
      : step),
  }
}

export function agentFinished(step: AgentProgress): boolean {
  return step.stage !== 'map' && step.total > 0 && step.done >= step.total
}

function withStep(turn: Turn, step: Step): Turn {
  return { ...turn, steps: [...turn.steps, step] }
}

function replaceStep(turn: Turn, index: number, update: (step: Step) => Step): Turn {
  return { ...turn, steps: turn.steps.map((step, at) => at === index ? update(step) : step) }
}

/**
 * Index of the last fetch line of `segment` not yet closed by its transcript,
 * or -1. Without a segment any later transcript closes it (reads in sequence);
 * with one, only the transcript of that segment does (reads in parallel).
 */
function openFetch(steps: readonly Step[], segment: string | undefined): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    if (step?.kind === 'transcript' && (segment === undefined || step.stats.label === segment)) return -1
    if (step?.kind === 'fetch' && step.segment === segment) return index
  }
  return -1
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index] as T)) return index
  }
  return -1
}
