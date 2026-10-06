/**
 * Minimal Microsoft Graph client over fetch: bearer auth, paging via
 * `@odata.nextLink`, retry on throttling. Tokens are requested per call from an
 * AccessTokenProvider and never stored here.
 *
 * CONTRACT (implemented by the graph work package):
 * - `baseUrl` defaults to https://graph.microsoft.com/v1.0.
 * - Relative paths are resolved against baseUrl; absolute URLs (nextLink) are
 *   accepted ONLY when their origin equals baseUrl's origin, so the token is
 *   never sent to another host.
 * - 429 / 503 / 504 are retried up to `maxRetries` (default 4), waiting
 *   `Retry-After` seconds when present, else exponential backoff (1s, 2s, 4s…,
 *   capped at 30s). The wait honors the AbortSignal.
 * - Non-2xx responses throw GraphError(status, code from `error.code`); the
 *   message never includes response bodies beyond `error.message`.
 */

export type AccessTokenProvider = (signal?: AbortSignal) => Promise<string>

export interface GraphClientOptions {
  readonly token: AccessTokenProvider
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly maxRetries?: number
  /** Injectable for tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * Minimum gap between consecutive requests against one resource (the pages of
   * one chat, channel or list). Teams allows ~1 rps per chat/channel and per
   * user for /me/chats, ~83% of that sustained. Default 1200; 0 disables.
   */
  readonly requestIntervalMs?: number
}

export interface GraphRequestOptions {
  readonly signal?: AbortSignal | undefined
  readonly headers?: Readonly<Record<string, string>>
}

export interface GraphPage<T> {
  readonly value: readonly T[]
  readonly '@odata.nextLink'?: string
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message)
    this.name = 'GraphError'
  }
}

const DEFAULT_BASE_URL = 'https://graph.microsoft.com/v1.0'
const RETRYABLE_STATUS = new Set([429, 503, 504])
const MAX_BACKOFF_MS = 30_000
/** Longest Retry-After we honor; anything longer is reported as a failure instead of a silent hang. */
const MAX_RETRY_AFTER_MS = 60_000
const DEFAULT_REQUEST_INTERVAL_MS = 1_200
const MAX_ERROR_MESSAGE_CHARS = 300

export class GraphClient {
  readonly #base: URL

  constructor(readonly options: GraphClientOptions) {
    this.#base = new URL((options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''))
  }

  /** GET one resource or page. */
  async get<T>(pathOrUrl: string, options?: GraphRequestOptions): Promise<T> {
    const url = this.#resolve(pathOrUrl)
    const signal = options?.signal
    const maxRetries = this.options.maxRetries ?? 4
    const fetchImpl = this.options.fetch ?? globalThis.fetch

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const token = await this.options.token(signal)
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...options?.headers, Authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      })
      if (response.ok) return await readJson<T>(response)
      const delay = RETRYABLE_STATUS.has(response.status) && attempt < maxRetries
        ? retryDelay(response.headers.get('retry-after'), attempt)
        : undefined
      if (delay === undefined) throw await toGraphError(response)
      await response.body?.cancel().catch(() => undefined)
      await this.sleep(delay, signal)
    }
  }

  /** Iterate `value` arrays page by page, following `@odata.nextLink`. */
  async *pages<T>(pathOrUrl: string, options?: GraphRequestOptions): AsyncGenerator<readonly T[], void, void> {
    const pace = this.pacer(options?.signal)
    let next: string | undefined = pathOrUrl
    while (next !== undefined) {
      await pace()
      const page: GraphPage<T> = await this.get<GraphPage<T>>(next, options)
      yield page.value ?? []
      next = page['@odata.nextLink']
    }
  }

  /** Abortable wait, using the injected sleep when present. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? abortableSleep)(ms, signal)
  }

  /**
   * A gate for one logical operation against one Graph resource: the first call
   * passes immediately, later calls wait until `requestIntervalMs` has passed
   * since the previous one, staying under the per-chat/channel rate limit
   * instead of bursting into 429s.
   */
  pacer(signal?: AbortSignal): () => Promise<void> {
    const interval = this.options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS
    let last: number | undefined
    return async () => {
      if (last !== undefined && interval > 0) {
        const wait = last + interval - Date.now()
        if (wait > 0) await this.sleep(wait, signal)
      }
      last = Date.now()
    }
  }

  #resolve(pathOrUrl: string): URL {
    // Anything with a scheme (or protocol-relative) is absolute and must stay on Graph's origin.
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl) || pathOrUrl.startsWith('//')
    let url: URL
    try {
      url = absolute ? new URL(pathOrUrl) : new URL(`${this.#base.href.replace(/\/+$/, '')}/${pathOrUrl.replace(/^\/+/, '')}`)
    } catch {
      throw new GraphError('Đường dẫn Microsoft Graph không hợp lệ.', 0, 'invalidUrl')
    }
    if (url.origin !== this.#base.origin) {
      throw new GraphError('Từ chối gửi token tới máy chủ ngoài Microsoft Graph.', 0, 'foreignOrigin')
    }
    return url
  }
}

/**
 * A short Vietnamese explanation of a Graph failure, safe to show to people or
 * hand to the model (no bodies, no tokens).
 */
export function describeGraphError(error: unknown): string {
  if (!(error instanceof GraphError)) return 'Không kết nối được tới Microsoft Graph.'
  switch (error.status) {
    case 401: return 'Phiên đăng nhập Microsoft đã hết hạn hoặc không hợp lệ; hãy đăng nhập lại.'
    case 403: return 'Không có quyền đọc cuộc trò chuyện này (thiếu quyền Graph hoặc ứng dụng chưa được cài vào cuộc trò chuyện).'
    case 404: return 'Không tìm thấy cuộc trò chuyện hoặc kênh này.'
    case 429:
    case 503:
    case 504: return 'Microsoft Graph đang giới hạn tần suất hoặc tạm thời quá tải; hãy thử lại sau ít phút.'
    default: return error.status === 0 ? error.message : `Microsoft Graph trả lỗi ${error.status}${error.code === undefined ? '' : ` (${error.code})`}.`
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new GraphError('Phản hồi từ Microsoft Graph không phải JSON hợp lệ.', response.status, 'invalidResponse')
  }
}

async function toGraphError(response: Response): Promise<GraphError> {
  let code: string | undefined
  let detail: string | undefined
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') detail = body.error.message.slice(0, MAX_ERROR_MESSAGE_CHARS)
  } catch {
    // Not JSON: keep only the status.
  }
  const message = `Microsoft Graph ${response.status}${code === undefined ? '' : ` ${code}`}${detail ? `: ${detail}` : ''}`
  return new GraphError(message, response.status, code)
}

/** Milliseconds to wait before retry `attempt` (0-based), or undefined when Retry-After asks for too long. */
function retryDelay(retryAfter: string | null, attempt: number): number | undefined {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(ms)) return ms > MAX_RETRY_AFTER_MS ? undefined : Math.max(0, ms)
  }
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
