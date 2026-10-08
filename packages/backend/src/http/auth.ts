/**
 * Who is calling: the browser sends its delegated Graph token as a Bearer
 * header; the server only forwards it to Graph and identifies the user with
 * GET /me. The token → user mapping is cached in RAM for a few minutes under
 * sha256(token), so the token itself is never kept, and the map is bounded.
 */

import { createHash } from 'node:crypto'
import { GraphClient } from '../graph/client.ts'
import { getMe, type GraphUser } from '../graph/sources.ts'

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_ENTRIES = 1_000
/** Entra access tokens are JWTs (base64url segments); anything else is refused before reaching Graph. */
const BEARER = /^Bearer\s+([A-Za-z0-9\-_.~+/]+=*)$/i
const MAX_TOKEN_CHARS = 16_384

export interface UserResolverOptions {
  readonly ttlMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

export type UserResolver = (bearer: string, graphFetch: typeof fetch, signal?: AbortSignal) => Promise<GraphUser>

interface Entry {
  readonly user: GraphUser
  readonly expiresAt: number
}

/** The raw token from an Authorization header, or undefined when it is missing or malformed. */
export function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined || header.length > MAX_TOKEN_CHARS + 16) return undefined
  return BEARER.exec(header.trim())?.[1]
}

/** Resolves a bearer token to the Graph user; failures (GraphError 401 included) propagate. */
export function createUserResolver(options: UserResolverOptions = {}): UserResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now
  const users = new Map<string, Entry>()
  const inflight = new Map<string, Promise<GraphUser>>()

  const remember = (key: string, user: GraphUser): void => {
    const time = now()
    for (const [candidate, entry] of users) if (entry.expiresAt <= time) users.delete(candidate)
    // Insertion order is age order: drop the oldest when full.
    while (users.size >= maxEntries) {
      const oldest = users.keys().next().value
      if (oldest === undefined) break
      users.delete(oldest)
    }
    users.set(key, { user, expiresAt: time + ttlMs })
  }

  return async (bearer, graphFetch, signal) => {
    const key = createHash('sha256').update(bearer).digest('base64url')
    const hit = users.get(key)
    if (hit !== undefined && hit.expiresAt > now()) return hit.user

    let pending = inflight.get(key)
    if (pending === undefined) {
      const client = new GraphClient({ token: async () => bearer, fetch: graphFetch })
      // Not tied to one caller's signal: concurrent requests with the same token share it.
      pending = getMe(client)
        .then(user => {
          remember(key, user)
          return user
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    return await abortable(pending, signal)
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
