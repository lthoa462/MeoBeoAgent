/**
 * App-only Graph tokens (OAuth client credentials) for the Teams bot, which
 * reads chats through RSC permissions. One cache entry per tenant, in RAM only,
 * refreshed 5 minutes before expiry; concurrent requests share one in-flight
 * token request.
 *
 * POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
 *   grant_type=client_credentials, scope=https://graph.microsoft.com/.default
 */

import type { AccessTokenProvider } from './client.ts'

export interface AppTokenOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly fetch?: typeof fetch
  /** Default https://login.microsoftonline.com */
  readonly authority?: string
  readonly now?: () => number
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
const REFRESH_MARGIN_MS = 5 * 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 30_000
/** Tenant ids come from Teams activities; only GUIDs and domain names may reach the token URL. */
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/

interface CachedToken {
  readonly token: string
  readonly expiresAt: number
}

/** Returns a factory: tenant id → token provider for that tenant. */
export function createAppTokenProvider(options: AppTokenOptions): (tenantId: string) => AccessTokenProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const authority = (options.authority ?? 'https://login.microsoftonline.com').replace(/\/+$/, '')
  const now = options.now ?? Date.now
  const cache = new Map<string, CachedToken>()
  const inflight = new Map<string, Promise<CachedToken>>()

  async function requestToken(tenantId: string): Promise<CachedToken> {
    const response = await fetchImpl(`${authority}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
        scope: GRAPH_SCOPE,
      }).toString(),
      // Shared by every waiting caller, so no caller's signal may cancel it; a hung
      // login endpoint must still not hang them all.
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => ({})) as {
      access_token?: unknown; expires_in?: unknown; error?: unknown
    }
    if (!response.ok || typeof body.access_token !== 'string' || body.access_token === '') {
      // Only the OAuth error code: error_description can echo request details.
      const code = typeof body.error === 'string' ? ` (${body.error})` : ''
      throw new Error(`Không lấy được token ứng dụng cho tenant ${tenantId}: HTTP ${response.status}${code}`)
    }
    const expiresIn = Number(body.expires_in)
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 60 * 60_000
    return { token: body.access_token, expiresAt: now() + lifetimeMs }
  }

  function prune(): void {
    const time = now()
    for (const [tenant, entry] of cache) if (entry.expiresAt <= time) cache.delete(tenant)
  }

  return tenantId => async signal => {
    if (!TENANT_PATTERN.test(tenantId)) throw new Error('Tenant id không hợp lệ.')
    signal?.throwIfAborted()
    const cached = cache.get(tenantId)
    if (cached !== undefined && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token

    let pending = inflight.get(tenantId)
    if (pending === undefined) {
      pending = requestToken(tenantId)
        .then(entry => {
          prune()
          cache.set(tenantId, entry)
          return entry
        })
        .finally(() => inflight.delete(tenantId))
      inflight.set(tenantId, pending)
    }
    return (await abortable(pending, signal)).token
  }
}

/** Stop waiting when `signal` aborts, without cancelling the shared work. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
