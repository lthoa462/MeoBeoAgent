/**
 * The Teams bot on top of the Teams SDK v2 (`@microsoft/teams.apps`).
 *
 * The SDK's App owns JWT validation and activity routing; we never start its
 * HTTP server. A capture adapter records the handler the App registers for its
 * messaging endpoint, and our Hono route (http/app.ts) feeds it requests.
 *
 * Bot Service gives a turn ~15 s, so handlers only classify the activity and
 * return; the summary runs in the background (tracked, errors caught):
 *   typing → placeholder "⏳ …" → progress edits (≥ 3 s apart, only when the
 *   text changes) → the placeholder is edited into the answer (or a new message
 *   when the edit fails). Group chats and channels do not support streaming.
 *
 * Privacy: with RSC the bot receives every message of the conversation. Those
 * that do not @mention it are dropped without logging; the SDK gets a logger
 * that never prints objects (activities) and drops debug output entirely.
 */

import { App, type AppOptions, type HttpMethod, type HttpRouteHandler, type IHttpServerAdapter, type IHttpServerRequest, type IHttpServerResponse, type IPlugin } from '@microsoft/teams.apps'
import { MessageActivityInput, TypingActivityInput, type ActivityLike } from '@microsoft/teams.api'
import { BusyError, type TurnHandle } from '../agents/session.ts'
import { GraphClient } from '../graph/client.ts'
import { createGraphFetcher } from '../graph/messages.ts'
import type { AppServices } from '../services.ts'
import type { TurnContext } from '../types.ts'
import { parseTeamsActivity, resolveTeamsSource, type TeamsActivityLike, type TeamsTurnInfo } from './context.ts'
import {
  BUSY_TEXT, FAILED_TEXT, INITIAL_PROGRESS, MISSING_APP_CREDENTIALS_TEXT, NO_TEAM_TEXT, NO_TENANT_TEXT, PLACEHOLDER_TEXT,
  UNSUPPORTED_TEXT, createEditThrottle, errorText, finalText, personalHelpText, progressText, reduceProgress, shortHelpText,
  truncateForTeams, welcomeText, type HelpOptions,
} from './format.ts'

/** The App's messaging endpoint; our Hono route forwards to it whatever its own path is. */
export const MESSAGING_ENDPOINT = '/api/messages'
/** How long close() waits for background replies after aborting their turns. */
const CLOSE_GRACE_MS = 5_000

type SdkLogger = NonNullable<AppOptions<IPlugin>['logger']>

export interface TeamsBotOptions {
  /** HTTP client (or options) for Bot Connector calls; tests intercept with a middleware. */
  readonly client?: AppOptions<IPlugin>['client']
  /** Skip inbound JWT validation (local testing only). Default: the SDK reads DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS. */
  readonly dangerouslyAllowUnauthenticatedRequests?: boolean
  readonly logger?: SdkLogger
  /** Minimum gap between placeholder edits. Default 3000. */
  readonly progressIntervalMs?: number
  readonly now?: () => number
}

export interface TeamsBot {
  readonly app: App
  /** One POST to the messaging endpoint: validated and routed by the SDK. */
  handle(request: IHttpServerRequest): Promise<IHttpServerResponse>
  /** Settles once every background reply has finished (tests, shutdown). */
  idle(): Promise<void>
  /** Abort running summaries and wait (briefly) for their last edits. */
  close(): Promise<void>
}

/** What the reply logic needs from an SDK activity context. */
export interface ReplyContext {
  readonly activity: TeamsActivityLike
  send(activity: ActivityLike): Promise<{ readonly id: string }>
  readonly api: { readonly teams: { getById(id: string): Promise<{ readonly aadGroupId?: string }> } }
}

/** Records the handler the App registers for its messaging endpoint instead of serving HTTP. */
class CaptureAdapter implements IHttpServerAdapter {
  handler: HttpRouteHandler | undefined

  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    // Other routes (remote functions, tabs) are not served by this app.
    if (method === 'POST' && path === MESSAGING_ENDPOINT) this.handler = handler
  }
}

export async function createTeamsBot(services: AppServices, options: TeamsBotOptions = {}): Promise<TeamsBot> {
  const { config } = services
  const { clientId, clientSecret, tenantId } = config.teams
  const now = options.now ?? Date.now
  const adapter = new CaptureAdapter()
  const app = new App({
    httpServerAdapter: adapter,
    messagingEndpoint: MESSAGING_ENDPOINT,
    logger: options.logger ?? createPrivateLogger('teams'),
    // No turn state: nothing about a conversation is persisted by the SDK either.
    state: false,
    // Keep conversation and user ids out of telemetry baggage.
    telemetry: { agent365: false },
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.dangerouslyAllowUnauthenticatedRequests === undefined
      ? {}
      : { dangerouslyAllowUnauthenticatedRequests: options.dangerouslyAllowUnauthenticatedRequests }),
  })

  const pending = new Set<Promise<void>>()
  const running = new Set<TurnHandle>()
  let closed = false

  /** Run `work` in the background; failures are logged by kind only, never with content. */
  const track = (what: string, work: () => Promise<void>): void => {
    const job = work()
      .catch((error: unknown) => logFailure(what, error))
      .finally(() => pending.delete(job))
    pending.add(job)
  }

  const help = (botName: string): HelpOptions => ({ botName, maxLookbackDays: config.limits.maxLookbackDays, webUrl: config.web.url })

  const onMessage = (ctx: ReplyContext): void => {
    if (closed) return
    const info = parseTeamsActivity(ctx.activity)
    switch (info.kind) {
      case 'ignore':
        return
      case 'personal':
        track('help', () => post(ctx, personalHelpText(help(info.botName))))
        return
      case 'unsupported':
        track('unsupported', () => post(ctx, UNSUPPORTED_TEXT))
        return
      case 'summarize':
        startSummary(ctx, info)
    }
  }

  const startSummary = (ctx: ReplyContext, info: Extract<TeamsTurnInfo, { kind: 'summarize' }>): void => {
    const { conversations, appTokens } = services
    const reply = (text: string): void => track('reply', () => post(ctx, text))
    if (info.prompt === '') return reply(shortHelpText(help(info.botName)))
    if (conversations === undefined) return reply(errorText(services.llmProblem ?? 'Chưa cấu hình mô hình ngôn ngữ.'))
    if (appTokens === undefined) return reply(errorText(MISSING_APP_CREDENTIALS_TEXT))
    if (info.tenantId === undefined) return reply(errorText(NO_TENANT_TEXT))
    const tenant = info.tenantId
    // Channel threads carry ";messageid=", so every thread gets its own session.
    const key = `teams:${info.conversationId}`
    if (conversations.isBusy(key)) return reply(BUSY_TEXT)

    track('summary', async () => {
      void ctx.send(new TypingActivityInput()).catch(() => undefined)
      const source = await resolveTeamsSource(info.target, async teamKey => (await ctx.api.teams.getById(teamKey)).aadGroupId)
        .catch(() => undefined)
      if (source === undefined) return post(ctx, errorText(NO_TEAM_TEXT))

      const timeZone = info.timeZone ?? config.defaultTimeZone
      const turn: TurnContext = {
        source,
        // App-only token of the conversation's tenant: RSC grants read access to this chat/channel only.
        fetcher: createGraphFetcher(new GraphClient({ token: appTokens(tenant), fetch: services.graphFetch })),
        timeZone,
        now: now(),
        ...(clientId === undefined ? {} : { selfAppId: clientId }),
      }
      let handle: TurnHandle
      try {
        handle = conversations.runTurn(key, info.prompt, turn, { conversationId: info.conversationId })
      } catch (error) {
        return post(ctx, error instanceof BusyError ? BUSY_TEXT : errorText(FAILED_TEXT))
      }
      running.add(handle)
      try {
        await deliverTurn(ctx, handle, timeZone)
      } finally {
        running.delete(handle)
      }
    })
  }

  /** Placeholder → throttled progress edits → final edit (or a new message when editing fails). */
  const deliverTurn = async (ctx: ReplyContext, handle: TurnHandle, timeZone: string): Promise<void> => {
    let placeholderId: string | undefined
    try {
      placeholderId = (await ctx.send(PLACEHOLDER_TEXT)).id || undefined
    } catch (error) {
      // If the bot cannot post here, the answer could not be posted either.
      handle.abort(new Error('cannot post to the conversation'))
      throw error
    }
    // Without an id an "edit" would post a new message each time: then only the answer is sent.
    const edit = (text: string): Promise<unknown> => placeholderId === undefined
      ? Promise.resolve()
      : ctx.send(new MessageActivityInput(text).withId(placeholderId))
    const finish = async (text: string): Promise<void> => {
      if (placeholderId !== undefined) {
        try {
          await edit(text)
          return
        } catch (error) {
          logFailure('final edit', error)
        }
      }
      await ctx.send(text)
    }

    const throttle = createEditThrottle({ ...(options.progressIntervalMs === undefined ? {} : { intervalMs: options.progressIntervalMs }), now })
    throttle.shown(PLACEHOLDER_TEXT)
    let state = INITIAL_PROGRESS
    for await (const event of handle) {
      if (event.t === 'done') {
        await finish(finalText(event.text, state.stats, timeZone))
      } else if (event.t === 'error') {
        await finish(errorText(event.message))
      } else {
        state = reduceProgress(state, event)
        const text = progressText(state, timeZone)
        if (throttle.ready(text)) {
          throttle.shown(text)
          await edit(text).catch((error: unknown) => logFailure('progress edit', error))
        }
      }
    }
  }

  const onInstall = (ctx: Pick<ReplyContext, 'send'> & { readonly activity: { readonly conversation?: { readonly conversationType?: string }; readonly recipient?: { readonly name?: string } } }): void => {
    if (closed) return
    const botName = ctx.activity.recipient?.name?.trim() || 'MeoBeo'
    const text = ctx.activity.conversation?.conversationType === 'personal' ? personalHelpText(help(botName)) : welcomeText(help(botName))
    track('welcome', () => post(ctx, text))
  }

  app.on('message', async ctx => { onMessage(ctx) })
  app.on('install.add', async ctx => { onInstall(ctx) })
  await app.initialize()

  const handler = adapter.handler
  if (handler === undefined) throw new Error('Teams SDK did not register its messaging endpoint')

  return {
    app,
    handle: request => handler(request),
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending])
    },
    async close() {
      closed = true
      for (const handle of running) handle.abort(new Error('MeoBeo is shutting down'))
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_GRACE_MS) }),
      ])
      clearTimeout(timer)
    },
  }
}

async function post(ctx: Pick<ReplyContext, 'send'>, text: string): Promise<void> {
  await ctx.send(truncateForTeams(text))
}

/** Failure kind and HTTP status only: errors from Graph or Bot Connector can echo request details. */
function logFailure(what: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error
  const status = statusOf(error)
  console.error(`[meobeo/teams] ${what} failed: ${name}${status === undefined ? '' : ` (HTTP ${status})`}`)
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const direct = (error as { status?: unknown }).status
  if (typeof direct === 'number') return direct
  const response = (error as { response?: { status?: unknown } }).response
  return typeof response?.status === 'number' ? response.status : undefined
}

/**
 * A logger for the Teams SDK that cannot leak conversation content: only
 * warnings and errors, only string arguments (activities and HTTP bodies are
 * objects and are dropped), Errors reduced to their name, one line each.
 */
export function createPrivateLogger(name: string): SdkLogger {
  const write = (level: 'error' | 'warn', parts: readonly unknown[]): void => {
    const text = parts
      .map(part => typeof part === 'string' ? part : part instanceof Error ? part.name : '')
      .filter(part => part !== '')
      .join(' ')
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .slice(0, 300)
    if (text !== '') console[level](`[meobeo/${name}] ${text}`)
  }
  const ignore = (): void => undefined
  return {
    loggerOptions: { level: 'warn' },
    error: (...parts: unknown[]) => write('error', parts),
    warn: (...parts: unknown[]) => write('warn', parts),
    info: ignore,
    debug: ignore,
    trace: ignore,
    log: (level: string, ...parts: unknown[]) => {
      if (level === 'error' || level === 'warn') write(level, parts)
    },
    child: (child: string) => createPrivateLogger(`${name}/${child}`),
  }
}
