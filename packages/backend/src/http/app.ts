/**
 * Hono app for the web UI and the Teams bot, mounted by Next.js under /api
 * (apps/web/src/app/api/[[...route]]/route.ts), or served alone by serve.ts.
 *
 *   GET  {base}/health   → HealthResponse (no auth)
 *   GET  {base}/sources  → SourcesResponse (Bearer Graph token, delegated)
 *   POST {base}/chat     → SSE of WireEvent (Bearer token; ChatRequest body)
 *   POST {base}/reset    → { ok } (Bearer token; ResetRequest body)
 *   POST {base}/messages → Teams Bot Framework endpoint (JWT validated by the Teams SDK)
 *
 * In DEMO_MODE the Bearer token is not required, user = "demo", and only the
 * demo source is offered/accepted.
 *
 * Errors are JSON `{ error: <code>, message: <Vietnamese sentence> }`. The demo
 * conversation is listed by /sources as the chat `{ chatId: 'demo', chatType:
 * 'demo' }`; /chat accepts it back as `{kind:'demo'}` or `{kind:'chat',
 * chatId:'demo'}`, and only in demo mode.
 *
 * Nothing here logs a request body, a message or a token.
 */

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { IHttpServerResponse } from '@microsoft/teams.apps'
import { BusyError, type TurnHandle } from '../agents/session.ts'
import { DEMO_SOURCE, createDemoFetcher } from '../demo/fixture.ts'
import { GraphClient, GraphError, describeGraphError } from '../graph/client.ts'
import { createGraphFetcher } from '../graph/messages.ts'
import { listSources, type GraphUser } from '../graph/sources.ts'
import { describeLlmConfig } from '../llm/runtime.ts'
import { getServices, onServicesClose, type AppServices } from '../services.ts'
import type { TeamsBot, TeamsBotOptions } from '../teams/bot.ts'
import type { MessageFetcher, TurnContext } from '../types.ts'
import type { HealthResponse, SourcesResponse } from '../wire.ts'
import { createUserResolver, parseBearer } from './auth.ts'
import { sseResponse } from './sse.ts'
import { DEMO_CHAT_ID, parseChatRequest, parseResetRequest } from './validate.ts'

export interface ApiAppOptions {
  /** Default '/api'. */
  readonly basePath?: string
  /** Default getServices(). */
  readonly services?: () => Promise<AppServices>
  /** Mount the Teams endpoint. Default: services.config.teams.enabled. */
  readonly teams?: boolean
  /** Options for the Teams bot (tests intercept Bot Connector calls here). */
  readonly teamsBot?: TeamsBotOptions
  /** Simulated Graph latency per demo page, so the UI shows fetch progress. Default 250. */
  readonly demoPageDelayMs?: number
}

const DEMO_USER: GraphUser = { id: 'demo', displayName: 'Demo' }
/** A 4000-character message is at most ~12 KB of UTF-8; anything far larger is not from our UI. */
const MAX_JSON_BODY_BYTES = 32 * 1024
/** Bot Framework activities are small, but cards and entities add up. */
const MAX_ACTIVITY_BYTES = 1024 * 1024
const DEFAULT_DEMO_PAGE_DELAY_MS = 250

interface Caller {
  readonly user: GraphUser
  /** The delegated Graph token; undefined only in demo mode. */
  readonly bearer: string | undefined
}

export function createApiApp(options: ApiAppOptions = {}): Hono {
  const services = options.services ?? getServices
  const resolveUser = createUserResolver()
  const bots = new WeakMap<AppServices, Promise<TeamsBot>>()
  const app = new Hono().basePath(options.basePath ?? '/api')

  app.onError((error, c) => {
    console.error('[meobeo] request failed:', error instanceof Error ? error.name : typeof error)
    return failure(c, 500, 'internal', 'Lỗi máy chủ; hãy thử lại.')
  })
  app.notFound(c => failure(c, 404, 'not_found', 'Không có API này.'))
  // Sources, answers and errors are personal: never cached by a browser or proxy.
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('cache-control')) {
      try { c.res.headers.set('cache-control', 'no-store') } catch { /* immutable response */ }
    }
  })

  const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: c => failure(c, 413, 'payload_too_large', 'Yêu cầu quá lớn.') })

  /** The caller, or the 401/4xx/5xx response to return instead. */
  async function authenticate(c: Context, s: AppServices): Promise<Caller | Response> {
    if (s.config.demoMode) return { user: DEMO_USER, bearer: undefined }
    const bearer = parseBearer(c.req.header('authorization'))
    if (bearer === undefined) {
      return failure(c, 401, 'unauthorized', 'Cần đăng nhập Microsoft: thiếu hoặc sai header Authorization: Bearer <token>.')
    }
    try {
      return { user: await resolveUser(bearer, s.graphFetch, c.req.raw.signal), bearer }
    } catch (error) {
      return graphFailure(c, error)
    }
  }

  app.get('/health', async c => {
    const s = await services()
    const status = describeLlmConfig(s.config)
    const body: HealthResponse = {
      ok: true,
      provider: s.llm?.provider ?? status.provider,
      model: s.llm?.model ?? status.model,
      providerConfigured: s.conversations !== undefined,
      teamsBot: options.teams ?? s.config.teams.enabled,
      demoMode: s.config.demoMode,
      maxLookbackDays: s.config.limits.maxLookbackDays,
    }
    return c.json(body)
  })

  app.get('/sources', async c => {
    const s = await services()
    const caller = await authenticate(c, s)
    if (caller instanceof Response) return caller
    if (caller.bearer === undefined) {
      const demo: SourcesResponse = {
        chats: [{ chatId: DEMO_CHAT_ID, chatType: 'demo', label: DEMO_SOURCE.label ?? 'Hội thoại demo' }],
        teams: [],
        warnings: [],
      }
      return c.json(demo)
    }
    try {
      const sources = await listSources(delegatedClient(caller.bearer, s), c.req.raw.signal, { me: caller.user })
      return c.json(sources)
    } catch (error) {
      return graphFailure(c, error)
    }
  })

  app.post('/chat', jsonLimit, async c => {
    const s = await services()
    const caller = await authenticate(c, s)
    if (caller instanceof Response) return caller
    const body = await readJson(c)
    if (body instanceof Response) return body
    const parsed = parseChatRequest(body, { demoMode: s.config.demoMode, defaultTimeZone: s.config.defaultTimeZone, demoSource: DEMO_SOURCE })
    if (!parsed.ok) return failure(c, 400, 'invalid_request', parsed.message)
    if (s.conversations === undefined) {
      return failure(c, 503, 'provider_not_configured', s.llmProblem ?? 'Chưa cấu hình mô hình ngôn ngữ.')
    }

    const { conversationId, source, message, timeZone } = parsed.value
    let fetcher: MessageFetcher
    if (source.kind === 'demo') {
      fetcher = createDemoFetcher({ pageDelayMs: options.demoPageDelayMs ?? DEFAULT_DEMO_PAGE_DELAY_MS })
    } else if (caller.bearer !== undefined) {
      // The user's own token, bound by the host: the model picks a window, never the chat or the credentials.
      fetcher = createGraphFetcher(delegatedClient(caller.bearer, s))
    } else {
      return failure(c, 401, 'unauthorized', 'Cần đăng nhập Microsoft.')
    }

    const signal = c.req.raw.signal
    const turn: TurnContext = {
      source,
      fetcher,
      timeZone,
      now: Date.now(),
      signal,
      // The bot's own summaries posted in a chat are not part of what people said.
      ...(s.config.teams.clientId === undefined ? {} : { selfAppId: s.config.teams.clientId }),
    }
    let handle: TurnHandle
    try {
      handle = s.conversations.runTurn(sessionKey(caller.user, conversationId), message, turn, { conversationId })
    } catch (error) {
      if (error instanceof BusyError) return failure(c, 409, 'busy', error.message)
      throw error
    }
    return sseResponse(handle, { signal })
  })

  app.post('/reset', jsonLimit, async c => {
    const s = await services()
    const caller = await authenticate(c, s)
    if (caller instanceof Response) return caller
    const body = await readJson(c)
    if (body instanceof Response) return body
    const parsed = parseResetRequest(body)
    if (!parsed.ok) return failure(c, 400, 'invalid_request', parsed.message)
    const reset = s.conversations?.reset(sessionKey(caller.user, parsed.value.conversationId)) ?? true
    return reset
      ? c.json({ ok: true })
      : failure(c, 409, 'busy', 'Cuộc trò chuyện đang xử lý một yêu cầu; hãy dừng yêu cầu đó trước khi đặt lại.')
  })

  const teamsBot = (s: AppServices): Promise<TeamsBot> => {
    let pending = bots.get(s)
    if (pending === undefined) {
      // Loaded on first use: the Teams SDK (Express, MSAL) is heavy and the web-only setup never needs it.
      const created = import('../teams/bot.ts')
        .then(module => module.createTeamsBot(s, options.teamsBot))
        .then(bot => {
          onServicesClose(s, () => bot.close())
          return bot
        })
      created.catch(() => {
        if (bots.get(s) === created) bots.delete(s)
      })
      bots.set(s, created)
      pending = created
    }
    return pending
  }

  app.post('/messages', bodyLimit({ maxSize: MAX_ACTIVITY_BYTES, onError: c => failure(c, 413, 'payload_too_large', 'Activity quá lớn.') }), async c => {
    const s = await services()
    if (!(options.teams ?? s.config.teams.enabled)) {
      return failure(c, 404, 'not_found', 'Bot Teams chưa được bật (cần CLIENT_ID và CLIENT_SECRET).')
    }
    let bot: TeamsBot
    try {
      bot = await teamsBot(s)
    } catch (error) {
      console.error('[meobeo] Teams bot failed to start:', error instanceof Error ? error.name : typeof error)
      return failure(c, 503, 'bot_unavailable', 'Bot Teams chưa khởi động được; xem log của server.')
    }
    const body = await readJson(c)
    if (body instanceof Response) return body
    // Header names arrive lower-cased, which is what the SDK's JWT check reads.
    return botResponse(await bot.handle({ body, headers: Object.fromEntries(c.req.raw.headers) }))
  })

  return app
}

/** Web sessions are per signed-in user, so one person can never continue another's conversation. */
function sessionKey(user: GraphUser, conversationId: string): string {
  return `${user.id}:${conversationId}`
}

function delegatedClient(bearer: string, s: AppServices): GraphClient {
  return new GraphClient({ token: async () => bearer, fetch: s.graphFetch })
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return failure(c, 400, 'invalid_json', 'Nội dung yêu cầu không phải JSON hợp lệ.')
  }
}

function failure(c: Context, status: ContentfulStatusCode, error: string, message: string): Response {
  return c.json({ error, message }, status)
}

/** Graph failures keep their meaning for the browser: 401 asks it to sign in again. */
function graphFailure(c: Context, error: unknown): Response {
  if (error instanceof GraphError) {
    const message = describeGraphError(error)
    switch (error.status) {
      case 401: return failure(c, 401, 'unauthorized', message)
      case 403: return failure(c, 403, 'forbidden', message)
      case 404: return failure(c, 404, 'not_found', message)
      case 429: return failure(c, 429, 'throttled', message)
      default: return failure(c, 502, 'graph_error', message)
    }
  }
  return failure(c, 502, 'graph_unreachable', describeGraphError(error))
}

function botResponse({ status, body }: IHttpServerResponse): Response {
  if (body === undefined || body === null || status === 204 || status === 304) return new Response(null, { status })
  if (typeof body === 'string') return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
