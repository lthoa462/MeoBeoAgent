/**
 * Offline stand-ins for Microsoft Graph: a fetch that records every request and
 * answers from a route table, plus builders for raw chat messages.
 */

import { GraphClient, type GraphClientOptions } from '../../src/graph/client.ts'
import type { GraphChatMessage } from '../../src/types.ts'

export const GRAPH = 'https://graph.microsoft.com/v1.0'

export interface RecordedRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body: string | undefined
}

export type FakeHandler = (url: URL, request: RecordedRequest) => Response | Promise<Response> | undefined

export interface FakeFetch {
  readonly fetch: typeof fetch
  readonly requests: RecordedRequest[]
  /** Request paths (decoded) without the Graph base, e.g. "/chats/x/messages". */
  paths(): string[]
}

/** A fetch that records requests; an unrouted URL answers 404 like Graph would. */
export function createFakeFetch(handler: FakeHandler): FakeFetch {
  const requests: RecordedRequest[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    requests.push(request)
    return await handler(url, request) ?? json({ error: { code: 'NotFound', message: 'no route' } }, 404)
  }) as typeof fetch
  return {
    fetch: fakeFetch,
    requests,
    paths: () => requests.map(request => decodeURIComponent(request.url.pathname).replace(/^\/v1\.0/, '')),
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

export interface TestClient {
  readonly client: GraphClient
  readonly fake: FakeFetch
  readonly sleeps: number[]
}

/**
 * GraphClient over a fake fetch with an instant, recorded sleep (no real
 * waiting in tests). `realSleep` keeps the client's own abortable timer.
 */
export function createTestClient(
  handler: FakeHandler,
  options: Partial<GraphClientOptions> & { readonly realSleep?: boolean } = {},
): TestClient {
  const fake = createFakeFetch(handler)
  const sleeps: number[] = []
  const { realSleep = false, ...overrides } = options
  const client = new GraphClient({
    token: async () => 'test-token',
    fetch: fake.fetch,
    ...(realSleep ? {} : { sleep: async (ms: number) => { sleeps.push(ms) } }),
    requestIntervalMs: 0,
    ...overrides,
  })
  return { client, fake, sleeps }
}

let counter = 0

/** A plain chat message created at `at` (ISO or epoch ms). */
export function message(at: string | number, overrides: Partial<GraphChatMessage> = {}): GraphChatMessage {
  const createdDateTime = typeof at === 'number' ? new Date(at).toISOString() : at
  counter++
  return {
    id: `m${counter}`,
    messageType: 'message',
    createdDateTime,
    lastModifiedDateTime: createdDateTime,
    deletedDateTime: null,
    from: { user: { id: 'u1', displayName: 'Nguyễn Văn A' } },
    body: { contentType: 'html', content: `<p>tin ${counter}</p>` },
    ...overrides,
  }
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
