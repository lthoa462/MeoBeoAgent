/**
 * What the signed-in web user can summarize (delegated token):
 * - GET /me
 * - GET /me/chats?$expand=members&$top=50 (paged, newest first by lastUpdatedDateTime;
 *   label = topic, else member display names except the user; skip oneOnOne with bots?
 *   keep all chat types but put group/meeting first)
 * - GET /me/joinedTeams, then GET /teams/{id}/channels per team (in parallel, small cap)
 * A failure listing one part (e.g. 403 on channels without admin consent) becomes
 * a `warnings` entry / team `error`, not a failed response.
 */

import type { SourcesResponse } from '../wire.ts'
import { GraphError, type GraphClient } from './client.ts'

export interface GraphUser {
  readonly id: string
  readonly displayName: string
}

export interface ListSourcesOptions {
  /** The signed-in user when the caller already resolved it (skips one GET /me). */
  readonly me?: GraphUser
}

type SourceChat = SourcesResponse['chats'][number]
type SourceTeam = SourcesResponse['teams'][number]

interface GraphChat {
  readonly id: string
  readonly topic?: string | null
  readonly chatType?: string | null
  readonly lastUpdatedDateTime?: string | null
  readonly members?: ReadonlyArray<{ readonly userId?: string | null; readonly displayName?: string | null }> | null
}

interface GraphNamed {
  readonly id: string
  readonly displayName?: string | null
}

const MAX_CHATS = 100
const CHANNEL_CONCURRENCY = 4
const MAX_LABEL_NAMES = 4

export async function getMe(client: GraphClient, signal?: AbortSignal): Promise<GraphUser> {
  const me = await client.get<{ id?: unknown; displayName?: unknown; userPrincipalName?: unknown }>(
    '/me?$select=id,displayName,userPrincipalName', { signal },
  )
  if (typeof me.id !== 'string' || me.id === '') {
    throw new GraphError('Microsoft Graph không trả về định danh người dùng.', 502, 'invalidResponse')
  }
  const name = typeof me.displayName === 'string' && me.displayName.trim() !== ''
    ? me.displayName.trim()
    : typeof me.userPrincipalName === 'string' ? me.userPrincipalName : ''
  return { id: me.id, displayName: name }
}

export async function listSources(client: GraphClient, signal?: AbortSignal, options?: ListSourcesOptions): Promise<SourcesResponse> {
  const me = options?.me ?? await getMe(client, signal)
  const warnings: string[] = []
  const [chats, teams] = await Promise.all([
    listChats(client, me, signal).catch((error: unknown) => {
      warnings.push(`Không tải được danh sách group chat (${partialReason(error)}).`)
      return []
    }),
    listTeams(client, signal, warnings).catch((error: unknown) => {
      warnings.push(`Không tải được danh sách nhóm (team) (${partialReason(error)}).`)
      return []
    }),
  ])
  return { chats, teams, warnings }
}

async function listChats(client: GraphClient, me: GraphUser, signal: AbortSignal | undefined): Promise<SourceChat[]> {
  const raw: GraphChat[] = []
  for await (const page of client.pages<GraphChat>('/me/chats?$expand=members&$top=50', { signal })) {
    raw.push(...page)
    if (raw.length >= MAX_CHATS) break
  }
  return raw
    .slice(0, MAX_CHATS)
    .map(chat => ({ chat, rank: chat.chatType === 'oneOnOne' ? 1 : 0, updated: Date.parse(chat.lastUpdatedDateTime ?? '') || 0 }))
    .sort((a, b) => a.rank - b.rank || b.updated - a.updated)
    .map(({ chat }) => ({
      chatId: chat.id,
      chatType: chat.chatType ?? 'group',
      label: chatLabel(chat, me),
      ...(chat.lastUpdatedDateTime ? { lastUpdated: chat.lastUpdatedDateTime } : {}),
    }))
}

function chatLabel(chat: GraphChat, me: GraphUser): string {
  const topic = chat.topic?.trim()
  if (topic) return topic
  const names = (chat.members ?? [])
    .filter(member => member.userId !== me.id)
    .map(member => member.displayName?.trim() ?? '')
    .filter(name => name !== '')
  if (names.length === 0) return chat.chatType === 'meeting' ? 'Cuộc họp không tên' : 'Cuộc trò chuyện không tên'
  const shown = names.slice(0, MAX_LABEL_NAMES).join(', ')
  return names.length > MAX_LABEL_NAMES ? `${shown} +${names.length - MAX_LABEL_NAMES}` : shown
}

async function listTeams(client: GraphClient, signal: AbortSignal | undefined, warnings: string[]): Promise<SourceTeam[]> {
  const teams: GraphNamed[] = []
  for await (const page of client.pages<GraphNamed>('/me/joinedTeams', { signal })) teams.push(...page)
  teams.sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '', 'vi'))

  let failed = 0
  const listed = await mapLimit(teams, CHANNEL_CONCURRENCY, async (team): Promise<SourceTeam> => {
    const label = team.displayName?.trim() || 'Nhóm không tên'
    try {
      const channels: GraphNamed[] = []
      for await (const page of client.pages<GraphNamed>(`/teams/${encodeURIComponent(team.id)}/channels`, { signal })) {
        channels.push(...page)
      }
      return {
        teamId: team.id,
        label,
        channels: channels.map(channel => ({ channelId: channel.id, label: channel.displayName?.trim() || 'Kênh không tên' })),
      }
    } catch (error) {
      failed++
      return { teamId: team.id, label, channels: [], error: `Không liệt kê được kênh (${partialReason(error)}).` }
    }
  })
  if (failed > 0) {
    warnings.push(`Không liệt kê được kênh của ${failed}/${teams.length} nhóm; có thể ứng dụng chưa được quản trị viên cấp quyền đọc kênh.`)
  }
  return listed
}

/**
 * Short Vietnamese reason for a partial failure. Anything that is not a Graph
 * error, plus 401 (expired sign-in), aborts the whole listing instead.
 */
function partialReason(error: unknown): string {
  if (!(error instanceof GraphError) || error.status === 401 || error.status === 0) throw error
  if (error.status === 403) return 'không có quyền'
  if (error.status === 404) return 'không tìm thấy'
  if (error.status === 429) return 'Graph đang giới hạn tần suất'
  return `lỗi ${error.status}${error.code === undefined ? '' : ` ${error.code}`}`
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
