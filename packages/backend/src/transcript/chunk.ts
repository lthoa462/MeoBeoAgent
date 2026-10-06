/**
 * Format messages as compact lines and split them into chunks by estimated
 * tokens (`estimateTextTokens` from '@alvin0/ai-agent-sdk-core/tools').
 *
 * Line: "[#12 03/10 09:15] Nguyễn Văn A: nội dung" (date dd/MM, time HH:mm in
 * timeZone); replies are prefixed "  ↳ ". Multi-line text keeps its newlines,
 * indented by two spaces. A single message longer than the budget is cut with
 * "…" so every chunk respects `chunkTokens`. Chunks never split a line.
 */

import { estimateTextTokens } from '@alvin0/ai-agent-sdk-core/tools'
import type { TranscriptChunk, TranscriptMessage } from '../types.ts'
import { zonedParts } from './range.ts'

const REPLY_PREFIX = '  ↳ '
const ELLIPSIS = '…'

export function formatMessageLine(message: TranscriptMessage, timeZone: string): string {
  const p = zonedParts(message.time, timeZone)
  const stamp = `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`
  const indent = message.replyToId === undefined ? '' : REPLY_PREFIX
  // Continuation lines are always indented, so message text can never start a
  // line that looks like a new "[#n …]" entry (prompt-injection hygiene).
  const continuation = `\n${' '.repeat(indent.length)}  `
  return `${indent}[#${message.seq} ${stamp}] ${message.author}: ${message.text.split('\n').join(continuation)}`
}

export function chunkTranscript(
  messages: readonly TranscriptMessage[],
  options: { readonly timeZone: string; readonly chunkTokens: number },
): TranscriptChunk[] {
  const budget = Math.max(1, Math.floor(options.chunkTokens))
  const chunks: TranscriptChunk[] = []
  let lines: string[] = []
  let members: TranscriptMessage[] = []
  let used = 0

  const flush = (): void => {
    const first = members[0]
    const last = members[members.length - 1]
    if (first === undefined || last === undefined) return
    const text = lines.join('\n')
    const times = members.map(message => message.time)
    chunks.push({
      index: chunks.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      from: Math.min(...times),
      to: Math.max(...times),
      text,
      estimatedTokens: estimateTextTokens(text),
    })
    lines = []
    members = []
    used = 0
  }

  for (const message of messages) {
    const line = fitLine(formatMessageLine(message, options.timeZone), budget)
    // Counting each line with its separator over-estimates the joined text, so
    // the sum can only err on the safe side of the budget.
    const cost = estimateTextTokens(`${line}\n`)
    if (members.length > 0 && used + cost > budget) flush()
    lines.push(line)
    members.push(message)
    used += cost
  }
  flush()
  return chunks
}

/** Cut a line (keeping its "[#n …] Author:" head) so the line plus a newline fits `budget`. */
function fitLine(line: string, budget: number): string {
  if (estimateTextTokens(`${line}\n`) <= budget) return line
  let keep = line.length
  let cut = line
  while (keep > 0 && estimateTextTokens(`${cut}\n`) > budget) {
    const ratio = budget / estimateTextTokens(`${cut}\n`)
    keep = Math.min(keep - 1, Math.floor(keep * ratio) - ELLIPSIS.length - 1)
    cut = `${trimSurrogate(line.slice(0, Math.max(0, keep)))}${ELLIPSIS}`
  }
  return cut
}

/** Never leave half of a surrogate pair at the cut. */
function trimSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
