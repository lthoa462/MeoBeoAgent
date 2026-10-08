/**
 * Strict parsing of browser request bodies. Everything that reaches a Graph
 * URL or a session key is checked here against a narrow charset, and the
 * result is rebuilt from validated fields only, so nothing unchecked rides
 * along.
 */

import { isValidTimeZone } from '../config.ts'
import type { ConversationSource } from '../types.ts'

export const MAX_MESSAGE_CHARS = 4_000
const MAX_LABEL_CHARS = 200
const MAX_TIME_ZONE_CHARS = 64

const CONVERSATION_ID = /^[A-Za-z0-9_\-:.]{1,100}$/
/** Graph chat/channel ids: "19:…@thread.v2", "19:…@unq.gbl.spaces", "19:meeting_…@thread.v2". No '/', '?', '#', '%'. */
const THREAD_ID = /^[A-Za-z0-9:@._=+-]{1,256}$/
/** Graph team id = the team's Microsoft 365 group id (a GUID). */
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/
/** The pseudo chat id under which GET /sources lists the demo conversation. */
export const DEMO_CHAT_ID = 'demo'

const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

export interface ParsedChatRequest {
  readonly conversationId: string
  readonly source: ConversationSource
  readonly message: string
  readonly timeZone: string
}

export interface ChatRequestRules {
  readonly demoMode: boolean
  readonly defaultTimeZone: string
  /** The source served in demo mode (any accepted demo request maps to it). */
  readonly demoSource: ConversationSource
}

export function parseChatRequest(body: unknown, rules: ChatRequestRules): Parsed<ParsedChatRequest> {
  if (!isRecord(body)) return fail('Nội dung yêu cầu phải là một đối tượng JSON.')
  const conversationId = parseConversationId(body.conversationId)
  if (!conversationId.ok) return conversationId

  if (typeof body.message !== 'string') return fail('Thiếu nội dung tin nhắn (message).')
  if (body.message.length > MAX_MESSAGE_CHARS) return fail(`Tin nhắn dài quá ${MAX_MESSAGE_CHARS} ký tự.`)
  const message = body.message.replace(CONTROL_EXCEPT_NEWLINE_TAB, '').trim()
  if (message === '') return fail('Tin nhắn trống.')

  const source = parseSource(body.source, rules)
  if (!source.ok) return source

  const zone = typeof body.timeZone === 'string' ? body.timeZone.trim() : ''
  const timeZone = zone !== '' && zone.length <= MAX_TIME_ZONE_CHARS && isValidTimeZone(zone) ? zone : rules.defaultTimeZone

  return { ok: true, value: { conversationId: conversationId.value, source: source.value, message, timeZone } }
}

export function parseResetRequest(body: unknown): Parsed<{ readonly conversationId: string }> {
  if (!isRecord(body)) return fail('Nội dung yêu cầu phải là một đối tượng JSON.')
  const conversationId = parseConversationId(body.conversationId)
  return conversationId.ok ? { ok: true, value: { conversationId: conversationId.value } } : conversationId
}

/**
 * A source the browser picked from GET /sources. In demo mode only the demo
 * conversation is accepted (as `{kind:'demo'}` or the listed pseudo chat
 * `{kind:'chat', chatId:'demo'}`); outside demo mode `demo` is refused, so a
 * client can never switch the server to synthetic data.
 */
export function parseSource(value: unknown, rules: Pick<ChatRequestRules, 'demoMode' | 'demoSource'>): Parsed<ConversationSource> {
  if (!isRecord(value)) return fail('Thiếu nguồn hội thoại (source).')
  const label = parseLabel(value.label)
  const isDemo = value.kind === 'demo' || (value.kind === 'chat' && value.chatId === DEMO_CHAT_ID)
  if (rules.demoMode) {
    return isDemo ? { ok: true, value: rules.demoSource } : fail('Chế độ demo chỉ tóm tắt được hội thoại demo.')
  }
  switch (value.kind) {
    case 'chat':
      if (typeof value.chatId !== 'string' || !THREAD_ID.test(value.chatId)) return fail('Mã nhóm chat (chatId) không hợp lệ.')
      return { ok: true, value: { kind: 'chat', chatId: value.chatId, ...(label === undefined ? {} : { label }) } }
    case 'channel':
      if (typeof value.teamId !== 'string' || !TEAM_ID.test(value.teamId)) return fail('Mã nhóm (teamId) không hợp lệ.')
      if (typeof value.channelId !== 'string' || !THREAD_ID.test(value.channelId)) return fail('Mã kênh (channelId) không hợp lệ.')
      return { ok: true, value: { kind: 'channel', teamId: value.teamId, channelId: value.channelId, ...(label === undefined ? {} : { label }) } }
    case 'demo':
      return fail('Hội thoại demo chỉ dùng được khi máy chủ bật DEMO_MODE.')
    default:
      return fail('Loại nguồn hội thoại không hợp lệ (chat | channel).')
  }
}

/** True for ids that may be placed in a Graph chat/channel URL. */
export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value)
}

export function isTeamId(value: string): boolean {
  return TEAM_ID.test(value)
}

function parseConversationId(value: unknown): Parsed<string> {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
    ? { ok: true, value }
    : fail('Mã cuộc trò chuyện (conversationId) không hợp lệ: 1–100 ký tự chữ, số, "_", "-", ":", ".".')
}

/** Display names only ever reach the model quoted on one line, but keep them short and printable anyway. */
function parseLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.replace(CONTROL_EXCEPT_NEWLINE_TAB, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
  return label === '' ? undefined : label
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message }
}
