/**
 * Raw Graph messages → TranscriptMessage[] in display order with 1-based `seq`.
 *
 * Drops: deletedDateTime set; messageType other than 'message' (system events,
 * typing, unknownFutureValue); messages from the bot itself
 * (from.application.id === selfAppId); messages whose createdDateTime is
 * outside [range.since, range.until); empty text after conversion; duplicate ids.
 *
 * Author: from.user.displayName ?? from.application.displayName ?? 'Không rõ'.
 * Text: htmlToText for contentType html (default), trimmed; attachments become
 * "[tệp: name]" / "[thẻ]" for cards / "[trích dẫn]" for messageReference;
 * a channel root `subject` is prefixed as "【subject】".
 *
 * Order: chats are chronological. When replies exist (channel), each thread is
 * placed at its root's time with replies (chronological) right after the root;
 * replies whose root is not in the set are placed by their own time.
 */

import type { GraphChatMessage, TimeRange, TranscriptMessage } from '../types.ts'

export interface NormalizeOptions {
  readonly range: TimeRange
  readonly selfAppId?: string | undefined
}

const UNKNOWN_AUTHOR = 'Không rõ'
const MAX_AUTHOR_CHARS = 80
const MAX_NAME_CHARS = 120

/** Attribute-aware tag pattern: quoted values may contain '>'. */
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`
const TAG = new RegExp(String.raw`<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(${ATTRS})>`, 'g')
const AT_TAG = new RegExp(String.raw`<at\b${ATTRS}>([\s\S]*?)<\/at>`, 'gi')
const LINK_TAG = new RegExp(String.raw`<a\b(${ATTRS})>([\s\S]*?)<\/a>`, 'gi')
/** Placeholder for a block boundary; runs of them collapse into one newline. */
const SOFT_BREAK = '\uE000'
const BLOCK_TAGS = new Set([
  'p', 'div', 'tr', 'ul', 'ol', 'table', 'blockquote', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer',
])

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', euro: '€', deg: '°', times: '×', divide: '÷',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', check: '✓',
  zwj: '‍', zwnj: '‌',
}

/**
 * HTML → plain text: <at>Name</at> → @Name, <br>/<p>/<div>/<li> → newlines
 * ("- " for li), <img> → [ảnh], <a href>text</a> → text (url), emoji
 * <emoji alt="x"> → x, strip other tags, decode entities (named + numeric),
 * collapse 3+ newlines to 2 and runs of spaces.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(AT_TAG, (_, inner: string) => `@${stripTags(inner).trim()}`)
    .replace(LINK_TAG, (_, attrs: string, inner: string) => linkText(attrs, inner))
    .replace(TAG, (_, closing: string, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase()
      if (name === 'br') return '\n'
      if (name === 'li') return closing ? SOFT_BREAK : `${SOFT_BREAK}- `
      if (name === 'emoji') return closing ? '' : attribute(attrs, 'alt') ?? ''
      if (name === 'img') {
        const isEmoji = /schema\.skype\.com\/Emoji/i.test(attribute(attrs, 'itemtype') ?? '')
        return isEmoji ? attribute(attrs, 'alt') ?? '' : '[ảnh]'
      }
      if (name === 'td' || name === 'th') return closing ? ' ' : ''
      return BLOCK_TAGS.has(name) ? SOFT_BREAK : ''
    })
  // Teams wraps every typed line in <p>; adjacent block boundaries are one line break, not a blank line.
  return tidy(decodeEntities(text).replace(/\s*\uE000[\s\uE000]*/g, '\n'))
}

export function normalizeMessages(raw: readonly GraphChatMessage[], options: NormalizeOptions): TranscriptMessage[] {
  const { since, until } = options.range
  const selfAppId = options.selfAppId?.trim().toLowerCase().replace(/^28:/, '')
  const seen = new Set<string>()
  const kept: Omit<TranscriptMessage, 'seq'>[] = []

  for (const message of flatten(raw)) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    if (message.deletedDateTime) continue
    if ((message.messageType ?? 'message') !== 'message') continue
    if (selfAppId && message.from?.application?.id?.toLowerCase() === selfAppId) continue
    const time = Date.parse(message.createdDateTime)
    if (!Number.isFinite(time) || time < since || time >= until) continue
    const text = messageText(message)
    if (text === '') continue
    const replyToId = message.replyToId && message.replyToId !== message.id ? message.replyToId : undefined
    kept.push({ id: message.id, time, author: authorOf(message), text, ...(replyToId === undefined ? {} : { replyToId }) })
  }

  return displayOrder(kept).map((message, index) => ({ ...message, seq: index + 1 }))
}

/** Root-level list plus any replies still nested under `$expand=replies` roots. */
function* flatten(raw: readonly GraphChatMessage[]): Generator<GraphChatMessage> {
  for (const message of raw) {
    yield message
    for (const reply of message.replies ?? []) yield reply.replyToId ? reply : { ...reply, replyToId: message.id }
  }
}

function displayOrder<T extends { readonly id: string; readonly time: number; readonly replyToId?: string }>(messages: readonly T[]): T[] {
  const chronological = [...messages].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
  const ids = new Set(chronological.map(message => message.id))
  const repliesByRoot = new Map<string, T[]>()
  const top: T[] = []
  for (const message of chronological) {
    if (message.replyToId !== undefined && ids.has(message.replyToId)) {
      const list = repliesByRoot.get(message.replyToId) ?? []
      list.push(message)
      repliesByRoot.set(message.replyToId, list)
    } else {
      top.push(message)
    }
  }
  if (repliesByRoot.size === 0) return chronological
  return top.flatMap(message => [message, ...(repliesByRoot.get(message.id) ?? [])])
}

function messageText(message: GraphChatMessage): string {
  const content = message.body?.content ?? ''
  const body = message.body?.contentType?.toLowerCase() === 'text' ? tidy(content) : htmlToText(content)
  const prefix: string[] = []
  const suffix: string[] = []
  for (const attachment of message.attachments ?? []) {
    const type = attachment.contentType?.toLowerCase() ?? ''
    const name = cleanName(attachment.name)
    if (type === 'messagereference') prefix.push('[trích dẫn]')
    else if (type.startsWith('application/vnd.microsoft.card')) suffix.push('[thẻ]')
    else suffix.push(name ? `[tệp: ${name}]` : '[tệp đính kèm]')
  }
  const subject = cleanName(message.subject)
  const text = [subject ? `【${subject}】` : '', ...prefix, body, ...suffix].filter(part => part !== '').join(' ')
  return text.trim()
}

function authorOf(message: GraphChatMessage): string {
  const name = message.from?.user?.displayName ?? message.from?.application?.displayName ?? ''
  // Display names are user-controlled: keep them on one line so they cannot fake transcript lines.
  const clean = stripControls(name).replace(/\s+/g, ' ').trim().slice(0, MAX_AUTHOR_CHARS)
  return clean === '' ? UNKNOWN_AUTHOR : clean
}

function cleanName(value: string | null | undefined): string {
  return stripControls(value ?? '').replace(/[\s[\]【】]+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
}

function linkText(attrs: string, inner: string): string {
  const href = attribute(attrs, 'href')
  if (href === undefined) return inner
  const url = decodeEntities(href).trim()
  if (!/^(https?:|mailto:)/i.test(url)) return inner
  const label = decodeEntities(stripTags(inner)).trim()
  const bare = url.replace(/^mailto:/i, '')
  if (label === '') return href
  if (label === url || label === bare) return inner
  return `${inner} (${href})`
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, 'i').exec(attrs)
  return match === null ? undefined : match[1] ?? match[2] ?? match[3]
}

function stripTags(html: string): string {
  return html.replace(TAG, '')
}

/** Single pass, so "&amp;lt;" becomes "&lt;" and not "<". */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      return valid ? String.fromCodePoint(code) : entity
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}

/**
 * Remove C0 controls (except tab/newline) and bidi overrides: message text is
 * untrusted and must not be able to reorder or hide what a model reads.
 */
function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '')
}

function tidy(text: string): string {
  return stripControls(text.replace(/\r\n?/g, '\n').replace(/ /g, ' '))
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
