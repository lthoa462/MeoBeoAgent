import { describe, expect, it, vi } from 'vitest'
import { createAppTokenProvider } from '../src/graph/app-token.ts'
import { GraphError, describeGraphError } from '../src/graph/client.ts'
import { createGraphFetcher, fetchChannelMessages, fetchChatMessages } from '../src/graph/messages.ts'
import { getMe, listSources } from '../src/graph/sources.ts'
import type { GraphChatMessage, TimeRange } from '../src/types.ts'
import { DAY, GRAPH, HOUR, createFakeFetch, createTestClient, json, message } from './fakes/graph.ts'

const NOW = Date.parse('2026-10-06T04:00:00Z')
const RANGE: TimeRange = { since: NOW - 2 * DAY, until: NOW }

describe('GraphClient', () => {
  it('resolves paths against the base URL and sends the bearer token', async () => {
    const { client, fake } = createTestClient(() => json({ id: 'me' }))
    await expect(client.get('/me')).resolves.toEqual({ id: 'me' })
    await client.get('users?$top=1')
    expect(fake.requests.map(request => request.url.href)).toEqual([`${GRAPH}/me`, `${GRAPH}/users?$top=1`])
    expect(fake.requests[0]?.headers.get('authorization')).toBe('Bearer test-token')
    expect(fake.requests[0]?.headers.get('accept')).toBe('application/json')
  })

  it('pages through @odata.nextLink', async () => {
    const { client, fake } = createTestClient(url => {
      if (url.searchParams.get('page') === '2') return json({ value: [3] })
      return json({ value: [1, 2], '@odata.nextLink': `${GRAPH}/items?page=2` })
    })
    const pages: (readonly number[])[] = []
    for await (const page of client.pages<number>('/items')) pages.push(page)
    expect(pages).toEqual([[1, 2], [3]])
    expect(fake.requests).toHaveLength(2)
  })

  it('never sends the token to a foreign nextLink host', async () => {
    const { client, fake } = createTestClient(url =>
      url.hostname === 'graph.microsoft.com' ? json({ value: [1], '@odata.nextLink': 'https://evil.example.com/steal' }) : json({ value: [] }))
    const read = async (): Promise<void> => {
      for await (const _page of client.pages('/items')) { /* drain */ }
    }
    await expect(read()).rejects.toMatchObject({ name: 'GraphError', code: 'foreignOrigin' })
    expect(fake.requests.map(request => request.url.hostname)).toEqual(['graph.microsoft.com'])
    await expect(client.get('//evil.example.com/x')).rejects.toBeInstanceOf(GraphError)
    expect(fake.requests).toHaveLength(1)
  })

  it('retries 429 after Retry-After and 503/504 with exponential backoff', async () => {
    const statuses = [429, 503, 504]
    const { client, fake, sleeps } = createTestClient(() => {
      const status = statuses.shift()
      if (status === 429) return json({ error: { code: 'TooManyRequests', message: 'slow down' } }, 429, { 'Retry-After': '3' })
      if (status !== undefined) return json({ error: { code: 'ServiceUnavailable' } }, status)
      return json({ ok: true })
    })
    await expect(client.get('/me')).resolves.toEqual({ ok: true })
    expect(fake.requests).toHaveLength(4)
    expect(sleeps).toEqual([3000, 2000, 4000])
  })

  it('gives up after maxRetries and when Retry-After is unreasonably long', async () => {
    const throttled = createTestClient(() => json({ error: { code: 'TooManyRequests', message: 'later' } }, 429), { maxRetries: 2 })
    await expect(throttled.client.get('/me')).rejects.toMatchObject({ status: 429, code: 'TooManyRequests' })
    expect(throttled.fake.requests).toHaveLength(3)
    expect(throttled.sleeps).toEqual([1000, 2000])

    const longWait = createTestClient(() => json({}, 429, { 'Retry-After': '3600' }))
    await expect(longWait.client.get('/me')).rejects.toMatchObject({ status: 429 })
    expect(longWait.fake.requests).toHaveLength(1)
  })

  it('maps error bodies to GraphError without leaking anything but error.message', async () => {
    const { client } = createTestClient(url => url.pathname.endsWith('/forbidden')
      ? json({ error: { code: 'Forbidden', message: 'Missing scope', innerError: { secret: 'x' } } }, 403)
      : new Response('<html>oops</html>', { status: 500 }))
    const forbidden = await client.get('/forbidden').catch((error: unknown) => error)
    expect(forbidden).toBeInstanceOf(GraphError)
    expect(forbidden).toMatchObject({ status: 403, code: 'Forbidden', message: 'Microsoft Graph 403 Forbidden: Missing scope' })
    const broken = await client.get('/broken').catch((error: unknown) => error)
    expect(broken).toMatchObject({ status: 500, code: undefined, message: 'Microsoft Graph 500' })
    expect(describeGraphError(forbidden)).toMatch(/quyền/)
    expect(describeGraphError(new GraphError('x', 401, undefined))).toMatch(/đăng nhập/)
  })

  it('honors the abort signal while waiting to retry', async () => {
    const { client } = createTestClient(() => json({}, 503, { 'Retry-After': '30' }), { realSleep: true })
    const controller = new AbortController()
    const pending = client.get('/me', { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stop')), 5)
    await expect(pending).rejects.toThrow('stop')
  })

  it('paces consecutive pages of one resource', async () => {
    const { client, sleeps } = createTestClient(url => url.searchParams.get('page') === '2'
      ? json({ value: [2] })
      : json({ value: [1], '@odata.nextLink': `${GRAPH}/items?page=2` }), { requestIntervalMs: 1200 })
    for await (const _page of client.pages('/items')) { /* drain */ }
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(1000)
    expect(sleeps[0]).toBeLessThanOrEqual(1200)
  })
})

describe('fetchChatMessages', () => {
  it('asks Graph for the window newest-first and stops paging once past `since`', async () => {
    const page1 = [message(NOW - HOUR), message(NOW - 10 * HOUR)]
    const page2 = [message(NOW - DAY), message(NOW - 3 * DAY), message(NOW - 4 * DAY)]
    const { client, fake } = createTestClient(url => url.searchParams.get('$skiptoken') === '2'
      ? json({ value: page2, '@odata.nextLink': `${GRAPH}/chats/c/messages?$skiptoken=3` })
      : json({ value: page1, '@odata.nextLink': `${GRAPH}/chats/c/messages?$skiptoken=2` }))
    const progress: Array<[number, number | undefined]> = []

    const result = await fetchChatMessages(client, '19:abc@thread.v2', RANGE, { maxMessages: 100, onPage: (count, back) => progress.push([count, back]) })

    expect(result).toMatchObject({ truncated: false, scanLimited: false, scannedBackTo: NOW - 3 * DAY })
    expect(result.messages.map(item => item.id)).toEqual([page1[0]?.id, page1[1]?.id, page2[0]?.id])
    expect(fake.requests).toHaveLength(2)
    const first = fake.requests[0]!.url
    expect(first.pathname).toBe('/v1.0/chats/19%3Aabc%40thread.v2/messages')
    expect(first.searchParams.get('$top')).toBe('50')
    expect(first.searchParams.get('$orderby')).toBe('createdDateTime desc')
    expect(first.searchParams.get('$filter')).toBe(`createdDateTime lt ${new Date(NOW).toISOString()}`)
    expect(progress).toEqual([[2, NOW - 10 * HOUR], [3, NOW - 3 * DAY]])
  })

  it('jumps straight to an old window and stops at maxScanPages', async () => {
    // 10–16/08/2026 in Vietnam, two months before NOW; every page is inside the window.
    const old: TimeRange = { since: Date.parse('2026-08-09T17:00:00Z'), until: Date.parse('2026-08-16T17:00:00Z') }
    const { client, fake } = createTestClient(url => {
      const page = Number(url.searchParams.get('$skiptoken') ?? '0')
      return json({
        value: [message(old.until - (2 * page + 1) * HOUR), message(old.until - (2 * page + 2) * HOUR)],
        '@odata.nextLink': `${GRAPH}/chats/c/messages?$skiptoken=${page + 1}`,
      })
    })
    const progress: Array<[number, number | undefined]> = []

    const result = await fetchChatMessages(client, 'c', old, { maxMessages: 100, maxScanPages: 3, onPage: (count, back) => progress.push([count, back]) })

    expect(fake.requests).toHaveLength(3)
    expect(fake.requests[0]!.url.searchParams.get('$filter')).toBe('createdDateTime lt 2026-08-16T17:00:00.000Z')
    expect(result).toMatchObject({ truncated: true, scanLimited: true, scannedBackTo: old.until - 6 * HOUR })
    expect(result.messages).toHaveLength(6)
    expect(progress).toEqual([[2, old.until - 2 * HOUR], [4, old.until - 4 * HOUR], [6, old.until - 6 * HOUR]])
  })

  it('reports the whole window as scanned once the listing runs out', async () => {
    const { client } = createTestClient(() => json({ value: [message(NOW - HOUR)] }))
    const progress: Array<number | undefined> = []
    const result = await fetchChatMessages(client, 'c', RANGE, { maxMessages: 10, maxScanPages: 1, onPage: (_, back) => progress.push(back) })
    expect(result).toMatchObject({ truncated: false, scanLimited: false, scannedBackTo: RANGE.since })
    expect(progress).toEqual([RANGE.since])
  })

  it('keeps the newest maxMessages and flags truncation', async () => {
    const page = [0, 1, 2, 3, 4].map(hours => message(NOW - (hours + 1) * HOUR))
    const { client } = createTestClient(() => json({ value: page }))
    const result = await fetchChatMessages(client, 'c', RANGE, { maxMessages: 3 })
    expect(result.truncated).toBe(true)
    expect(result.messages.map(item => item.id)).toEqual(page.slice(0, 3).map(item => item.id))
  })

  it('is not truncated when the window ends exactly at maxMessages', async () => {
    const page = [message(NOW - HOUR), message(NOW - 2 * HOUR), message(NOW - 3 * DAY)]
    const { client } = createTestClient(() => json({ value: page, '@odata.nextLink': `${GRAPH}/chats/c/messages?next=1` }))
    const result = await fetchChatMessages(client, 'c', RANGE, { maxMessages: 2 })
    expect(result).toMatchObject({ truncated: false })
    expect(result.messages).toHaveLength(2)
  })

  it('treats a full page boundary with more pages as truncated without fetching them', async () => {
    const { client, fake } = createTestClient(() => json({
      value: [message(NOW - HOUR), message(NOW - 2 * HOUR)],
      '@odata.nextLink': `${GRAPH}/chats/c/messages?next=1`,
    }))
    const result = await fetchChatMessages(client, 'c', RANGE, { maxMessages: 2 })
    expect(result.truncated).toBe(true)
    expect(fake.requests).toHaveLength(1)
  })
})

describe('fetchChannelMessages', () => {
  const reply = (rootId: string, at: number, overrides: Partial<GraphChatMessage> = {}): GraphChatMessage =>
    message(at, { replyToId: rootId, ...overrides })

  it('reads threads until a root is older than `since`, keeping in-window roots and replies', async () => {
    // Root A: new thread, two replies in the window and one inline reply before it.
    const rootA = message(NOW - 5 * HOUR, { id: 'A', subject: 'Release' })
    const aReplies = [reply('A', NOW - HOUR), reply('A', NOW - 2 * HOUR)]
    // Root B: started before the window, still active through a reply inside it.
    const rootB = message(NOW - 5 * DAY, { id: 'B', lastModifiedDateTime: new Date(NOW - 3 * HOUR).toISOString() })
    const bReplies = [reply('B', NOW - 4 * DAY), reply('B', NOW - 3 * HOUR)]
    // Root C: more replies than fit inline; Graph links to the rest (without replyToId on one).
    const rootC = message(NOW - 20 * HOUR, { id: 'C' })
    const cInline = [reply('C', NOW - 19 * HOUR)]
    const cMore = [message(NOW - 18 * HOUR), reply('C', NOW - 6 * DAY)]
    // Root D: last activity before the window → stop here, never read page 2.
    const rootD = message(NOW - 3 * DAY, { id: 'D' })

    const { client, fake } = createTestClient(url => {
      if (url.pathname.endsWith('/messages/C/replies')) return json({ value: cMore })
      if (url.searchParams.get('$skiptoken') === 'p2') return json({ value: [message(NOW - 10 * DAY)] })
      return json({
        value: [
          { ...rootA, replies: [...aReplies, reply('A', NOW - 3 * DAY)] },
          { ...rootB, replies: bReplies },
          { ...rootC, replies: cInline, 'replies@odata.nextLink': `${GRAPH}/teams/T/channels/C1/messages/C/replies?$skiptoken=r2` },
          { ...rootD, replies: [] },
        ],
        '@odata.nextLink': `${GRAPH}/teams/T/channels/C1/messages?$skiptoken=p2`,
      })
    })

    const progress: Array<[number, number | undefined]> = []
    const result = await fetchChannelMessages(client, 'T', '19:chan@thread.tacv2', RANGE, { maxMessages: 100, onPage: (count, back) => progress.push([count, back]) })

    expect(result).toMatchObject({ truncated: false, scanLimited: false, scannedBackTo: NOW - 3 * DAY })
    const ids = result.messages.map(item => item.id)
    expect(new Set(ids)).toEqual(new Set(['A', aReplies[0]!.id, aReplies[1]!.id, bReplies[1]!.id, 'C', cInline[0]!.id, cMore[0]!.id]))
    expect(ids).not.toContain('B')
    expect(result.messages.every(item => item.replies === undefined && item['replies@odata.nextLink'] === undefined)).toBe(true)
    expect(result.messages.find(item => item.id === cMore[0]!.id)?.replyToId).toBe('C')

    const first = fake.requests[0]!.url
    expect(first.pathname).toBe('/v1.0/teams/T/channels/19%3Achan%40thread.tacv2/messages')
    expect(first.searchParams.get('$top')).toBe('50')
    expect(first.searchParams.get('$expand')).toBe('replies')
    expect(first.searchParams.has('$filter')).toBe(false)
    expect(fake.paths()).toEqual([
      '/teams/T/channels/19:chan@thread.tacv2/messages',
      '/teams/T/channels/C1/messages/C/replies',
    ])
    expect(progress).toEqual([[7, NOW - 3 * DAY]])
  })

  it('pages back from now to an old window, skipping newer threads, until maxScanPages', async () => {
    const old: TimeRange = { since: NOW - 30 * DAY, until: NOW - 29 * DAY }
    // Each page: two threads started after the window (their extra replies are never read).
    const { client, fake } = createTestClient(url => {
      const page = Number(url.searchParams.get('$skiptoken') ?? '0')
      const roots = [1, 2].map(n => {
        const at = NOW - (2 * page + n) * DAY
        return { ...message(at, { id: `r${page}-${n}` }), replies: [], 'replies@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages/r${page}-${n}/replies` }
      })
      return json({ value: roots, '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages?$skiptoken=${page + 1}` })
    })
    const progress: Array<[number, number | undefined]> = []

    const result = await fetchChannelMessages(client, 'T', 'C', old, { maxMessages: 100, maxScanPages: 2, onPage: (count, back) => progress.push([count, back]) })

    expect(fake.paths()).toEqual(['/teams/T/channels/C/messages', '/teams/T/channels/C/messages'])
    expect(result).toMatchObject({ messages: [], truncated: true, scanLimited: true, scannedBackTo: NOW - 4 * DAY })
    expect(progress).toEqual([[0, NOW - 2 * DAY], [0, NOW - 4 * DAY]])
  })

  it('reads an old thread that is still active and stops at the window start without hitting the cap', async () => {
    const old: TimeRange = { since: NOW - 30 * DAY, until: NOW - 29 * DAY }
    const oldRoot = message(old.since + HOUR, { id: 'old', lastModifiedDateTime: new Date(NOW - 5 * DAY).toISOString() })
    const { client } = createTestClient(url => url.searchParams.get('$skiptoken') === 'p2'
      ? json({ value: [{ ...message(NOW - 40 * DAY, { id: 'older' }), replies: [] }], '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages?$skiptoken=p3` })
      : json({
        value: [{ ...message(NOW - DAY, { id: 'new' }), replies: [] }, { ...oldRoot, replies: [reply('old', NOW - 5 * DAY)] }],
        '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages?$skiptoken=p2`,
      }))
    const result = await fetchChannelMessages(client, 'T', 'C', old, { maxMessages: 100, maxScanPages: 2 })
    expect(result.messages.map(item => item.id)).toEqual(['old'])
    expect(result).toMatchObject({ truncated: false, scanLimited: false, scannedBackTo: NOW - 40 * DAY })
  })

  it('keeps paging past threads that were only touched (reactions) and stops at maxMessages', async () => {
    const touched = message(NOW - 4 * DAY, { id: 'R', lastModifiedDateTime: new Date(NOW - HOUR).toISOString() })
    const busy = message(NOW - 3 * HOUR, { id: 'busy' })
    const busyReplies = [1, 2, 3, 4].map(hours => reply('busy', NOW - (3 - hours / 2) * HOUR))
    const { client } = createTestClient(url => url.searchParams.get('$skiptoken') === 'p2'
      ? json({ value: [{ ...busy, replies: busyReplies }] })
      : json({ value: [{ ...touched, replies: [] }], '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages?$skiptoken=p2` }))

    const result = await fetchChannelMessages(client, 'T', 'C', RANGE, { maxMessages: 3 })
    expect(result.truncated).toBe(true)
    // Newest first inside the thread: the three latest replies survive, the root does not.
    expect(result.messages.map(item => item.id)).toEqual([busyReplies[3]!.id, busyReplies[2]!.id, busyReplies[1]!.id])
  })

  it('counts reply pages against maxScanPages and keeps only in-window replies of a busy thread', async () => {
    // One root page with a thread whose replies never end; each reply page holds one in-window and one old reply.
    const root = message(NOW - 4 * DAY, { id: 'busy', lastModifiedDateTime: new Date(NOW - HOUR).toISOString() })
    const { client, fake } = createTestClient(url => {
      if (url.pathname.endsWith('/replies')) {
        const page = Number(url.searchParams.get('$skiptoken') ?? '0')
        return json({
          value: [reply('busy', NOW - (page + 2) * HOUR, { id: `in-${page}` }), reply('busy', NOW - (page + 5) * DAY, { id: `old-${page}` })],
          '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages/busy/replies?$skiptoken=${page + 1}`,
        })
      }
      return json({ value: [{ ...root, replies: [], 'replies@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages/busy/replies` }] })
    })
    const result = await fetchChannelMessages(client, 'T', 'C', RANGE, { maxMessages: 100, maxScanPages: 3 })
    expect(fake.requests).toHaveLength(3)
    expect(result.messages.map(item => item.id)).toEqual(['in-0', 'in-1'])
    expect(result).toMatchObject({ truncated: true, scanLimited: true })
  })

  it('stops at the deadline with what it has, flagged scanLimited', async () => {
    const pageOf = (page: number) => json({
      value: [{ ...message(NOW - (page + 1) * HOUR, { id: `m${page}` }), replies: [] }],
      '@odata.nextLink': `${GRAPH}/teams/T/channels/C/messages?$skiptoken=${page + 1}`,
    })
    const deadline = Date.now() + 60_000
    const now = vi.spyOn(Date, 'now')
    try {
      const { client, fake } = createTestClient(url => {
        // The second page answers after the deadline.
        if (url.searchParams.get('$skiptoken') === '1') now.mockReturnValue(deadline)
        return pageOf(Number(url.searchParams.get('$skiptoken') ?? '0'))
      })
      const result = await fetchChannelMessages(client, 'T', 'C', RANGE, { maxMessages: 100, deadline })
      expect(fake.requests).toHaveLength(2)
      expect(result.messages.map(item => item.id)).toEqual(['m0', 'm1'])
      expect(result).toMatchObject({ truncated: true, scanLimited: true, scannedBackTo: NOW - 2 * HOUR })

      const late = createTestClient(() => pageOf(0))
      expect(await fetchChatMessages(late.client, 'c', RANGE, { maxMessages: 100, deadline: deadline - 1 }))
        .toMatchObject({ messages: [], truncated: true, scanLimited: true })
      expect(late.fake.requests).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('createGraphFetcher routes by source kind and rejects demo sources', async () => {
    const { client, fake } = createTestClient(() => json({ value: [] }))
    const fetcher = createGraphFetcher(client)
    await fetcher.fetch({ kind: 'chat', chatId: 'c1' }, RANGE, { maxMessages: 10 })
    await fetcher.fetch({ kind: 'channel', teamId: 't1', channelId: 'ch1' }, RANGE, { maxMessages: 10 })
    expect(fake.paths()).toEqual(['/chats/c1/messages', '/teams/t1/channels/ch1/messages'])
    await expect(fetcher.fetch({ kind: 'demo' }, RANGE, { maxMessages: 10 })).rejects.toThrow(/demo/)
  })
})

describe('createAppTokenProvider', () => {
  const tokenServer = () => {
    let issued = 0
    const fake = createFakeFetch((url, request) => {
      if (url.pathname.includes('bad-tenant')) return json({ error: 'invalid_client', error_description: 'secret abc wrong' }, 401)
      issued++
      const body = new URLSearchParams(request.body)
      return json({ access_token: `tok-${issued}-${body.get('client_id')}`, expires_in: 3600, token_type: 'Bearer' })
    })
    return fake
  }

  it('caches one token per tenant and posts client credentials', async () => {
    const fake = tokenServer()
    const tokens = createAppTokenProvider({ clientId: 'app', clientSecret: 's3cret', fetch: fake.fetch, now: () => NOW })
    expect(await tokens('tenant-1')()).toBe('tok-1-app')
    expect(await tokens('tenant-1')()).toBe('tok-1-app')
    expect(await tokens('tenant-2')()).toBe('tok-2-app')
    expect(fake.requests.map(request => request.url.href)).toEqual([
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
      'https://login.microsoftonline.com/tenant-2/oauth2/v2.0/token',
    ])
    const body = new URLSearchParams(fake.requests[0]?.body)
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'client_credentials', client_id: 'app', client_secret: 's3cret', scope: 'https://graph.microsoft.com/.default',
    })
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const fake = tokenServer()
    const provider = createAppTokenProvider({ clientId: 'app', clientSecret: 's', fetch: fake.fetch })('tenant')
    const tokens = await Promise.all([provider(), provider(), provider()])
    expect(new Set(tokens).size).toBe(1)
    expect(fake.requests).toHaveLength(1)
  })

  it('refreshes five minutes before expiry', async () => {
    const fake = tokenServer()
    let now = NOW
    const provider = createAppTokenProvider({ clientId: 'app', clientSecret: 's', fetch: fake.fetch, now: () => now })('tenant')
    expect(await provider()).toBe('tok-1-app')
    now = NOW + 54 * 60_000
    expect(await provider()).toBe('tok-1-app')
    now = NOW + 56 * 60_000
    expect(await provider()).toBe('tok-2-app')
  })

  it('reports failures without the secret and does not cache them', async () => {
    const fake = tokenServer()
    const factory = createAppTokenProvider({ clientId: 'app', clientSecret: 'abc', fetch: fake.fetch })
    const error: unknown = await factory('bad-tenant')().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/401 \(invalid_client\)/)
    expect((error as Error).message).not.toMatch(/abc/)
    await expect(factory('bad-tenant')()).rejects.toThrow()
    expect(fake.requests).toHaveLength(2)
    await expect(factory('../evil')()).rejects.toThrow(/Tenant/)
    expect(fake.requests).toHaveLength(2)
  })
})

describe('sources', () => {
  const me = { id: 'me-id', displayName: 'Tôi' }
  const member = (userId: string, displayName: string) => ({ userId, displayName })

  const graph = (overrides: { chats?: () => Response; channels403?: string } = {}) => (url: URL): Response | undefined => {
    const path = decodeURIComponent(url.pathname).replace('/v1.0', '')
    if (path === '/me') return json({ id: me.id, displayName: me.displayName })
    if (path === '/me/chats') {
      if (overrides.chats) return overrides.chats()
      if (url.searchParams.get('$skiptoken') === '2') {
        return json({ value: [{ id: 'c-old-group', chatType: 'group', topic: null, lastUpdatedDateTime: '2026-09-01T00:00:00Z', members: [member(me.id, 'Tôi'), member('u2', 'Bình')] }] })
      }
      return json({
        value: [
          { id: 'c-1on1', chatType: 'oneOnOne', topic: null, lastUpdatedDateTime: '2026-10-06T00:00:00Z', members: [member(me.id, 'Tôi'), member('u2', 'Bình')] },
          { id: 'c-topic', chatType: 'group', topic: '  Dự án X  ', lastUpdatedDateTime: '2026-10-02T00:00:00Z', members: [] },
          {
            id: 'c-many', chatType: 'meeting', topic: null, lastUpdatedDateTime: '2026-10-05T00:00:00Z',
            members: [member(me.id, 'Tôi'), ...['An', 'Bình', 'Chi', 'Dũng', 'Em', 'Giang'].map((name, index) => member(`x${index}`, name))],
          },
        ],
        '@odata.nextLink': `${GRAPH}/me/chats?$skiptoken=2`,
      })
    }
    if (path === '/me/joinedTeams') return json({ value: [{ id: 't-b', displayName: 'Team B' }, { id: 't-a', displayName: 'Team A' }] })
    if (path === '/teams/t-a/channels') return json({ value: [{ id: 'ch-1', displayName: 'General' }, { id: 'ch-2', displayName: 'Release' }] })
    if (path === '/teams/t-b/channels') return json({ error: { code: 'Forbidden', message: 'Missing role' } }, 403)
    return undefined
  }

  it('getMe returns id and display name', async () => {
    const { client } = createTestClient(graph())
    await expect(getMe(client)).resolves.toEqual(me)
  })

  it('labels and sorts chats, lists channels, and turns a 403 into a team error plus warning', async () => {
    const { client, fake } = createTestClient(graph())
    const sources = await listSources(client)

    expect(sources.chats.map(chat => [chat.chatId, chat.label])).toEqual([
      ['c-many', 'An, Bình, Chi, Dũng +2'],
      ['c-topic', 'Dự án X'],
      ['c-old-group', 'Bình'],
      ['c-1on1', 'Bình'],
    ])
    expect(sources.chats[0]).toMatchObject({ chatType: 'meeting', lastUpdated: '2026-10-05T00:00:00Z' })
    expect(sources.teams).toEqual([
      { teamId: 't-a', label: 'Team A', channels: [{ channelId: 'ch-1', label: 'General' }, { channelId: 'ch-2', label: 'Release' }] },
      { teamId: 't-b', label: 'Team B', channels: [], error: expect.stringMatching(/không có quyền/) },
    ])
    expect(sources.warnings).toHaveLength(1)
    expect(sources.warnings[0]).toMatch(/1\/2/)
    const chatsRequest = fake.requests.find(request => request.url.pathname.endsWith('/me/chats'))!
    expect(chatsRequest.url.searchParams.get('$expand')).toBe('members')
    expect(chatsRequest.url.searchParams.get('$top')).toBe('50')
  })

  it('skips GET /me when the caller already knows the user', async () => {
    const { client, fake } = createTestClient(graph())
    await listSources(client, undefined, { me })
    expect(fake.paths()).not.toContain('/me')
  })

  it('degrades a forbidden chat list to a warning but fails on an expired sign-in', async () => {
    const forbidden = createTestClient(graph({ chats: () => json({ error: { code: 'Forbidden' } }, 403) }))
    const sources = await listSources(forbidden.client)
    expect(sources.chats).toEqual([])
    expect(sources.teams).toHaveLength(2)
    expect(sources.warnings.some(warning => /group chat/.test(warning))).toBe(true)

    const expired = createTestClient(graph({ chats: () => json({ error: { code: 'InvalidAuthenticationToken' } }, 401) }))
    await expect(listSources(expired.client)).rejects.toMatchObject({ status: 401 })
  })
})
