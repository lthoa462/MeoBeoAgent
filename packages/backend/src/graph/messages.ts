/**
 * Fetch chat / channel messages for a time window, newest first, stopping as
 * soon as the window is exhausted or `maxMessages` is reached.
 *
 * Group chat — GET /chats/{chatId}/messages
 *   ?$top=50&$orderby=createdDateTime desc&$filter=createdDateTime lt {untilISO}
 *   Page until a message's createdDateTime < since (then stop; drop older ones).
 *
 * Channel — GET /teams/{teamId}/channels/{channelId}/messages?$top=50&$expand=replies
 *   No $filter/$orderby support. Roots arrive newest-first by the last activity
 *   of the whole thread. Stop paging once a root's lastModifiedDateTime
 *   (fallback createdDateTime) < since. Keep roots AND replies whose
 *   createdDateTime is inside [since, until); follow `replies@odata.nextLink`
 *   when a thread has more replies.
 *
 * Messages are returned raw (GraphChatMessage); normalization happens later.
 * Ids are URL-encoded into paths. `onPage` is called with the running count.
 */

import type { ConversationSource, FetchOptions, FetchResult, GraphChatMessage, MessageFetcher, TimeRange } from '../types.ts'
import type { GraphClient, GraphPage } from './client.ts'

const PAGE_SIZE = 50

export async function fetchChatMessages(
  client: GraphClient, chatId: string, range: TimeRange, options: FetchOptions,
): Promise<FetchResult> {
  const signal = options.signal
  const pace = client.pacer(signal)
  const collected = new Collector(range, options.maxMessages)
  const query = [
    `$top=${PAGE_SIZE}`,
    `$orderby=${encodeURIComponent('createdDateTime desc')}`,
    // Graph only honors `lt` on createdDateTime, and only together with the matching $orderby.
    `$filter=${encodeURIComponent(`createdDateTime lt ${new Date(range.until).toISOString()}`)}`,
  ].join('&')
  let next: string | undefined = `/chats/${encodeURIComponent(chatId)}/messages?${query}`

  while (next !== undefined) {
    await pace()
    const page: GraphPage<GraphChatMessage> = await client.get(next, { signal })
    const values = page.value ?? []
    let exhausted = false
    for (const message of values) {
      const time = createdAt(message)
      if (time === Number.NEGATIVE_INFINITY) continue
      if (time < range.since) {
        exhausted = true
        break
      }
      if (!collected.add(message)) break
    }
    options.onPage?.(collected.count)
    next = page['@odata.nextLink']
    if (exhausted || collected.truncated) break
    if (collected.full) {
      // Full at a page boundary: more pages may still hold in-window messages,
      // and spending one more request just to settle the flag is not worth it.
      collected.truncated = next !== undefined
      break
    }
  }
  return collected.result()
}

export async function fetchChannelMessages(
  client: GraphClient, teamId: string, channelId: string, range: TimeRange, options: FetchOptions,
): Promise<FetchResult> {
  const signal = options.signal
  // One pacer for roots and reply pages alike: Graph rate-limits per channel.
  const pace = client.pacer(signal)
  const collected = new Collector(range, options.maxMessages)
  let next: string | undefined =
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${PAGE_SIZE}&$expand=replies`

  while (next !== undefined) {
    await pace()
    const page: GraphPage<GraphChatMessage> = await client.get(next, { signal })
    let exhausted = false
    for (const root of page.value ?? []) {
      const inlineReplies = root.replies ?? []
      if (threadActivity(root, inlineReplies) < range.since) {
        exhausted = true
        break
      }
      if (collected.full) {
        // An active thread is left unread: assume it holds in-window messages
        // rather than spend requests (and rate limit) to make sure.
        collected.truncated = true
        break
      }
      const thread = await readThread(client, root, inlineReplies, pace, signal)
      // Newest first inside the thread too, so truncation keeps the newest messages.
      const inWindow = thread.filter(message => collected.inRange(message)).sort((a, b) => createdAt(b) - createdAt(a))
      for (const message of inWindow) if (!collected.add(message)) break
      if (collected.truncated) break
    }
    options.onPage?.(collected.count)
    next = page['@odata.nextLink']
    if (exhausted || collected.truncated) break
    if (collected.full) {
      collected.truncated = next !== undefined
      break
    }
  }
  return collected.result()
}

/** MessageFetcher over Graph; rejects `demo` sources. */
export function createGraphFetcher(client: GraphClient): MessageFetcher {
  return {
    fetch(source: ConversationSource, range: TimeRange, options: FetchOptions): Promise<FetchResult> {
      if (source.kind === 'chat') return fetchChatMessages(client, source.chatId, range, options)
      if (source.kind === 'channel') return fetchChannelMessages(client, source.teamId, source.channelId, range, options)
      return Promise.reject(new Error('Graph fetcher cannot read demo sources'))
    },
  }
}

/** Root (without its nested replies) plus every reply, following `replies@odata.nextLink`. */
async function readThread(
  client: GraphClient,
  root: GraphChatMessage,
  inlineReplies: readonly GraphChatMessage[],
  pace: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<GraphChatMessage[]> {
  const { replies: _replies, 'replies@odata.nextLink': moreReplies, ...bare } = root
  const thread: GraphChatMessage[] = [bare]
  const addReplies = (replies: readonly GraphChatMessage[]): void => {
    for (const reply of replies) thread.push(reply.replyToId ? reply : { ...reply, replyToId: root.id })
  }
  addReplies(inlineReplies)
  let next = moreReplies
  while (next !== undefined) {
    await pace()
    const page: GraphPage<GraphChatMessage> = await client.get(next, { signal })
    addReplies(page.value ?? [])
    next = page['@odata.nextLink']
  }
  return thread
}

/**
 * When the thread was last active. Roots are ordered by this; replies that came
 * inline are folded in so a root whose lastModifiedDateTime lags still counts.
 */
function threadActivity(root: GraphChatMessage, replies: readonly GraphChatMessage[]): number {
  let latest = Math.max(createdAt(root), parseTime(root.lastModifiedDateTime))
  for (const reply of replies) latest = Math.max(latest, createdAt(reply))
  return latest
}

function createdAt(message: GraphChatMessage): number {
  return parseTime(message.createdDateTime)
}

/** Unparseable timestamps sort as "very old" so they can never extend paging. */
function parseTime(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/** In-window messages counted against maxMessages. */
class Collector {
  readonly #messages: GraphChatMessage[] = []
  truncated = false

  constructor(readonly range: TimeRange, readonly maxMessages: number) {}

  get count(): number {
    return this.#messages.length
  }

  get full(): boolean {
    return this.#messages.length >= this.maxMessages
  }

  inRange(message: GraphChatMessage): boolean {
    const time = createdAt(message)
    return time >= this.range.since && time < this.range.until
  }

  /** Adds an in-window message; returns false (and flags truncation) when already full. */
  add(message: GraphChatMessage): boolean {
    if (!this.inRange(message)) return true
    if (this.full) {
      this.truncated = true
      return false
    }
    this.#messages.push(message)
    return true
  }

  result(): FetchResult {
    return { messages: this.#messages, truncated: this.truncated }
  }
}
