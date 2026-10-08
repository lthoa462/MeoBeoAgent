/**
 * Fetch chat / channel messages for a time window, newest first, stopping as
 * soon as the window is exhausted, `maxMessages` is reached, `maxScanPages`
 * requests have been made or the `deadline` has passed.
 *
 * Group chat — GET /chats/{chatId}/messages
 *   ?$top=50&$orderby=createdDateTime desc&$filter=createdDateTime lt {untilISO}
 *   Jumps straight to the window's end, so the cost follows the number of
 *   messages in the window whatever its date. Page until a message's
 *   createdDateTime < since (then stop; drop older ones).
 *
 * Channel — GET /teams/{teamId}/channels/{channelId}/messages?$top=50&$expand=replies
 *   No $filter/$orderby support. Roots arrive newest-first by the last activity
 *   of the whole thread, so an old window means paging back from now through
 *   every thread active since then. Stop paging once a root's
 *   lastModifiedDateTime (fallback createdDateTime) < since. Keep roots AND
 *   replies whose createdDateTime is inside [since, until); follow
 *   `replies@odata.nextLink` when a thread has more replies (not for threads
 *   started after the window, which cannot hold window messages). Replies are
 *   filtered to the window page by page, so a busy thread is never held whole.
 *
 * The scan budget covers every request of the window: `maxScanPages` counts
 * list pages and a thread's reply pages alike, and no request starts after
 * `deadline` (epoch ms). When the budget stops a scan before it reached `since`
 * (possibly in the middle of a thread), the result is truncated + scanLimited.
 * `scannedBackTo` is the oldest point the scan reached: the oldest
 * createdDateTime (chat) or thread activity (channel) seen, or `since` itself
 * once the listing ran out. `onPage(count, scannedBackTo)` follows each page.
 *
 * Messages are returned raw (GraphChatMessage); normalization happens later.
 * Ids are URL-encoded into paths.
 */

import type { ConversationSource, FetchOptions, FetchResult, GraphChatMessage, MessageFetcher, TimeRange } from '../types.ts'
import type { GraphClient, GraphPage } from './client.ts'

const PAGE_SIZE = 50

export async function fetchChatMessages(
  client: GraphClient, chatId: string, range: TimeRange, options: FetchOptions,
): Promise<FetchResult> {
  const collected = new Collector(range, options)
  const query = [
    `$top=${PAGE_SIZE}`,
    `$orderby=${encodeURIComponent('createdDateTime desc')}`,
    // Graph only honors `lt` on createdDateTime, and only together with the matching $orderby.
    `$filter=${encodeURIComponent(`createdDateTime lt ${new Date(range.until).toISOString()}`)}`,
  ].join('&')
  const first = `/chats/${encodeURIComponent(chatId)}/messages?${query}`

  return scan(client, first, options, collected, client.pacer(options.signal), async values => {
    for (const message of values) {
      const time = createdAt(message)
      if (time === Number.NEGATIVE_INFINITY) continue
      collected.reached(time)
      if (time < range.since) return true
      if (!collected.add(message)) break
    }
    return false
  })
}

export async function fetchChannelMessages(
  client: GraphClient, teamId: string, channelId: string, range: TimeRange, options: FetchOptions,
): Promise<FetchResult> {
  const signal = options.signal
  // One pacer for roots and reply pages alike: Graph rate-limits per channel.
  const pace = client.pacer(signal)
  const collected = new Collector(range, options)
  const first = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${PAGE_SIZE}&$expand=replies`

  return scan(client, first, options, collected, pace, async roots => {
    for (const root of roots) {
      const inlineReplies = root.replies ?? []
      const activity = threadActivity(root, inlineReplies)
      collected.reached(activity)
      if (activity < range.since) return true
      // Replies come after their root: a thread started after the window has nothing for it.
      if (createdAt(root) >= range.until) continue
      if (collected.full) {
        // An active thread is left unread: assume it holds in-window messages
        // rather than spend requests (and rate limit) to make sure.
        collected.truncated = true
        break
      }
      const inWindow = await readThread(client, root, inlineReplies, pace, collected, signal)
      // Newest first inside the thread too, so truncation keeps the newest messages.
      inWindow.sort((a, b) => createdAt(b) - createdAt(a))
      for (const message of inWindow) if (!collected.add(message)) break
      // Also when the budget ran out inside this thread: what was read is kept, the scan stops.
      if (collected.truncated) break
    }
    return false
  })
}

/**
 * Page a newest-first listing. `readPage` consumes one page and returns true
 * once it saw the start of the window. Stops on that, on truncation, when full,
 * or when the scan budget is spent (→ truncated + scanLimited).
 */
async function scan(
  client: GraphClient,
  first: string,
  options: FetchOptions,
  collected: Collector,
  pace: () => Promise<void>,
  readPage: (values: readonly GraphChatMessage[]) => Promise<boolean>,
): Promise<FetchResult> {
  let next: string | undefined = first
  while (next !== undefined && collected.takePage()) {
    await pace()
    const page: GraphPage<GraphChatMessage> = await client.get(next, { signal: options.signal })
    const exhausted = await readPage(page.value ?? [])
    next = page['@odata.nextLink']
    // Nothing older exists: the scan has covered the whole window (unless a thread was cut short).
    if (next === undefined && !collected.scanLimited) collected.reached(collected.range.since)
    options.onPage?.(collected.count, collected.scannedBackTo)
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

/**
 * The thread's in-window messages: the root (without its nested replies) and
 * the replies, following `replies@odata.nextLink` while the scan budget lasts.
 */
async function readThread(
  client: GraphClient,
  root: GraphChatMessage,
  inlineReplies: readonly GraphChatMessage[],
  pace: () => Promise<void>,
  collected: Collector,
  signal: AbortSignal | undefined,
): Promise<GraphChatMessage[]> {
  const { replies: _replies, 'replies@odata.nextLink': moreReplies, ...bare } = root
  const thread: GraphChatMessage[] = []
  const keep = (messages: readonly GraphChatMessage[]): void => {
    for (const message of messages) {
      if (collected.inRange(message)) thread.push(message === bare || message.replyToId ? message : { ...message, replyToId: root.id })
    }
  }
  keep([bare, ...inlineReplies])
  let next = moreReplies
  while (next !== undefined && collected.takePage()) {
    await pace()
    const page: GraphPage<GraphChatMessage> = await client.get(next, { signal })
    keep(page.value ?? [])
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

/** In-window messages counted against maxMessages, the scan budget, and how far back the scan reached. */
class Collector {
  readonly #messages: GraphChatMessage[] = []
  readonly maxMessages: number
  readonly #maxPages: number
  readonly #deadline: number
  #pages = 0
  #oldest = Number.POSITIVE_INFINITY
  truncated = false
  scanLimited = false

  constructor(readonly range: TimeRange, options: FetchOptions) {
    this.maxMessages = options.maxMessages
    this.#maxPages = Math.max(1, options.maxScanPages ?? Number.POSITIVE_INFINITY)
    this.#deadline = options.deadline ?? Number.POSITIVE_INFINITY
  }

  /** Claims one request (list or reply page); false, flagging truncated + scanLimited, once pages or time are spent. */
  takePage(): boolean {
    if (this.#pages >= this.#maxPages || Date.now() >= this.#deadline) {
      this.truncated = true
      this.scanLimited = true
      return false
    }
    this.#pages++
    return true
  }

  get count(): number {
    return this.#messages.length
  }

  get full(): boolean {
    return this.#messages.length >= this.maxMessages
  }

  /** Oldest point in time the scan has reached, if any. */
  get scannedBackTo(): number | undefined {
    return Number.isFinite(this.#oldest) ? this.#oldest : undefined
  }

  reached(time: number): void {
    if (Number.isFinite(time)) this.#oldest = Math.min(this.#oldest, time)
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
    const scannedBackTo = this.scannedBackTo
    return {
      messages: this.#messages,
      truncated: this.truncated,
      scanLimited: this.scanLimited,
      ...(scannedBackTo === undefined ? {} : { scannedBackTo }),
    }
  }
}
