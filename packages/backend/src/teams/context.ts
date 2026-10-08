/**
 * Pure reading of an inbound Teams activity: should the bot answer, what was
 * asked, and which conversation (as Graph ids) it is about. No SDK import, so
 * every case is unit-testable with plain objects.
 *
 * With RSC the bot receives EVERY message of a group chat or channel; anything
 * that does not @mention it is classified `ignore` without looking further.
 *
 * Ids: a group chat's Bot Framework conversation id is its Graph chat id
 * ("19:…@thread.v2"). In a channel the conversation id is
 * "<channelId>;messageid=<rootId>" (one per thread), channelData.channel.id is
 * the Graph channel id and channelData.team.aadGroupId the Graph team id; when
 * aadGroupId is missing it is looked up with the Bot Framework team id.
 */

import { isValidTimeZone } from '../config.ts'
import { MAX_MESSAGE_CHARS, isTeamId, isThreadId } from '../http/validate.ts'
import type { ConversationSource } from '../types.ts'

/** The subset of a Bot Framework activity this module reads. */
export interface TeamsActivityLike {
  readonly type: string
  /** Where the SDK sends every reply (with the bot's Bot Connector token). */
  readonly serviceUrl?: string | undefined
  readonly text?: string | undefined
  readonly from?: { readonly id?: string; readonly name?: string; readonly role?: string } | undefined
  readonly recipient?: { readonly id?: string; readonly name?: string } | undefined
  readonly conversation?: {
    readonly id?: string
    readonly conversationType?: string
    readonly tenantId?: string
    readonly name?: string
  } | undefined
  readonly channelData?: {
    readonly tenant?: { readonly id?: string } | undefined
    readonly channel?: { readonly id?: string; readonly name?: string } | undefined
    readonly team?: { readonly id?: string; readonly name?: string; readonly aadGroupId?: string } | undefined
  } | undefined
  readonly entities?: ReadonlyArray<{
    readonly type?: string
    readonly text?: string | null | undefined
    readonly mentioned?: { readonly id?: string; readonly name?: string | undefined } | undefined
  }> | undefined
  /** IANA zone of the sender's client (Bot Framework field, not in the SDK typings). */
  readonly localTimezone?: string | undefined
}

/** Where to read from, before the team id of a channel is resolved. */
export type TeamsTarget =
  | { readonly kind: 'chat'; readonly chatId: string; readonly label?: string }
  | {
      readonly kind: 'channel'
      readonly channelId: string
      /** Graph team id (aadGroupId), when the activity carried it. */
      readonly teamId?: string
      /** Bot Framework team id, for looking the Graph id up. */
      readonly teamKey?: string
      readonly label?: string
    }

export type TeamsTurnInfo =
  /** Not for us: from a bot, not a message, or a group/channel message without an @mention. */
  | { readonly kind: 'ignore' }
  /** 1:1 chat with the bot: RSC cannot read it, so the bot explains how to use it elsewhere. */
  | { readonly kind: 'personal'; readonly botName: string; readonly prompt: string }
  /** Mentioned somewhere the bot cannot summarize (unknown conversation type or malformed ids). */
  | { readonly kind: 'unsupported'; readonly botName: string }
  | {
      readonly kind: 'summarize'
      readonly scope: 'groupChat' | 'channel'
      readonly botName: string
      /** The request with the bot's mention removed; '' when only the mention was sent. */
      readonly prompt: string
      /** Bot Framework conversation id (channel threads include ";messageid="). */
      readonly conversationId: string
      readonly tenantId: string | undefined
      /** The sender's zone when Teams sent a valid one. */
      readonly timeZone: string | undefined
      readonly target: TeamsTarget
    }

const DEFAULT_BOT_NAME = 'MeoBeo'
const MAX_LABEL_CHARS = 200

export function parseTeamsActivity(activity: TeamsActivityLike): TeamsTurnInfo {
  if (activity.type !== 'message' || isFromBot(activity)) return { kind: 'ignore' }
  const botName = activity.recipient?.name?.trim() || DEFAULT_BOT_NAME
  const conversationType = activity.conversation?.conversationType
  const mentioned = isBotMentioned(activity)

  if (conversationType === 'personal') {
    return { kind: 'personal', botName, prompt: extractPrompt(activity) }
  }
  if (!mentioned) return { kind: 'ignore' }

  const conversationId = activity.conversation?.id ?? ''
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId
  const zone = activity.localTimezone?.trim()
  const timeZone = zone !== undefined && zone !== '' && zone.length <= 64 && isValidTimeZone(zone) ? zone : undefined
  // The part before ";messageid=" is the chat or channel itself.
  const baseId = conversationId.split(';')[0] ?? ''

  if (conversationType === 'groupChat') {
    if (!isThreadId(baseId)) return { kind: 'unsupported', botName }
    const label = cleanLabel(activity.conversation?.name)
    return {
      kind: 'summarize',
      scope: 'groupChat',
      botName,
      prompt: extractPrompt(activity),
      conversationId,
      tenantId,
      timeZone,
      target: { kind: 'chat', chatId: baseId, ...(label === undefined ? {} : { label }) },
    }
  }

  if (conversationType === 'channel') {
    const { channel, team } = activity.channelData ?? {}
    const channelId = channel?.id ?? baseId
    if (!isThreadId(channelId)) return { kind: 'unsupported', botName }
    const teamId = team?.aadGroupId !== undefined && isTeamId(team.aadGroupId) ? team.aadGroupId : undefined
    const label = cleanLabel([team?.name, channel?.name].filter(Boolean).join(' › '))
    return {
      kind: 'summarize',
      scope: 'channel',
      botName,
      prompt: extractPrompt(activity),
      conversationId,
      tenantId,
      timeZone,
      target: {
        kind: 'channel',
        channelId,
        ...(teamId === undefined ? {} : { teamId }),
        ...(team?.id === undefined ? {} : { teamKey: team.id }),
        ...(label === undefined ? {} : { label }),
      },
    }
  }

  return { kind: 'unsupported', botName }
}

/**
 * The ConversationSource for a target. `lookupTeamId` maps a Bot Framework team
 * id to its Graph id (ctx.api.teams.getById(...).aadGroupId); it is only called
 * when the activity lacked aadGroupId. Undefined when the team cannot be found.
 */
export async function resolveTeamsSource(
  target: TeamsTarget,
  lookupTeamId: (teamKey: string) => Promise<string | undefined>,
): Promise<ConversationSource | undefined> {
  const label = target.label === undefined ? {} : { label: target.label }
  if (target.kind === 'chat') return { kind: 'chat', chatId: target.chatId, ...label }
  let teamId = target.teamId
  if (teamId === undefined && target.teamKey !== undefined) {
    const found = await lookupTeamId(target.teamKey)
    teamId = found !== undefined && isTeamId(found) ? found : undefined
  }
  return teamId === undefined ? undefined : { kind: 'channel', teamId, channelId: target.channelId, ...label }
}

/**
 * Microsoft endpoints the Bot Connector service talks from (public cloud and
 * GCC), plus loopback for local tools such as Agents Playground. Replies carry
 * the bot's Bot Connector token, so they may only ever go to one of these.
 */
const SERVICE_HOSTS = [/^smba\.trafficmanager\.net$/, /(^|\.)botframework\.com$/, /\.teams\.microsoft\.(com|us)$/]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isTrustedServiceUrl(serviceUrl: string | undefined): boolean {
  let url: URL
  try {
    url = new URL(serviceUrl ?? '')
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:'
  return url.protocol === 'https:' && SERVICE_HOSTS.some(pattern => pattern.test(url.hostname))
}

/**
 * True when an inbound Authorization header carries a token issued by Entra ID
 * (login.microsoftonline.com / sts.windows.net) instead of the Bot Framework.
 * The Teams SDK routes such tokens to its "agentic identity" path, which accepts
 * any token whose audience is this app (e.g. the ID token of every web user of
 * the same app registration) and does not bind serviceUrl to the token. MeoBeo
 * is a classic bot, so they are refused before the SDK sees them; Bot Framework
 * tokens are then fully validated by the SDK (issuer, signature, serviceUrl).
 * The payload is decoded without verification: it only decides what to refuse.
 */
export function isEntraIssuedToken(authorization: string | undefined): boolean {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim() ?? ''
  const payload = token.split('.')[1]
  if (payload === undefined) return false
  let issuer: unknown
  try {
    issuer = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown }).iss
  } catch {
    return false
  }
  // The same prefixes the SDK uses to pick its Entra path.
  return typeof issuer === 'string' && /^\s*https:\/\/(login\.microsoftonline\.com|sts\.windows\.net\/)/i.test(issuer)
}

export function isFromBot(activity: TeamsActivityLike): boolean {
  const from = activity.from
  if (from === undefined) return true
  // Bot Framework ids of bots start with "28:"; people are "29:".
  return from.role === 'bot' || (from.id?.startsWith('28:') ?? false) || (from.id !== undefined && from.id === activity.recipient?.id)
}

export function isBotMentioned(activity: TeamsActivityLike): boolean {
  const botId = activity.recipient?.id
  return botId !== undefined && (activity.entities ?? []).some(entity => entity.type === 'mention' && entity.mentioned?.id === botId)
}

/**
 * The text addressed to the bot: its own mention removed, other people's
 * mentions kept as "@Name" (they often are the subject of the question),
 * leftover markup stripped, whitespace tidied, capped like web messages.
 */
export function extractPrompt(activity: TeamsActivityLike): string {
  let text = activity.text ?? ''
  const botId = activity.recipient?.id
  for (const entity of activity.entities ?? []) {
    if (entity.type !== 'mention' || entity.text === undefined || entity.text === null || entity.text === '') continue
    const replacement = entity.mentioned?.id === botId ? ' ' : `@${entity.mentioned?.name ?? stripTags(entity.text)}`
    text = text.split(entity.text).join(replacement)
  }
  text = text
    .replace(/<at>(.*?)<\/at>/gi, '@$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
  text = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.slice(0, MAX_MESSAGE_CHARS)
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

function decodeEntities(value: string): string {
  return value.replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#x27);/gi, (_, name: string) => {
    switch (name.toLowerCase()) {
      case 'nbsp': return ' '
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      default: return "'"
    }
  })
}

function cleanLabel(value: string | undefined): string | undefined {
  const label = value?.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
  return label === undefined || label === '' ? undefined : label
}
