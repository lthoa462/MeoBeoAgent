/**
 * Small helpers shared by the hooks that talk to /api. Nothing here logs a
 * request or response body: they carry tokens and chat content.
 */

/** Resolves the Authorization header for one call ({} in demo mode). */
export type AuthHeaders = () => Promise<Record<string, string>>

/** A non-2xx answer from our API, already phrased for people. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly detail: string | undefined
  constructor(status: number, message: string, code?: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }

  get reauth(): boolean {
    return this.status === 401
  }
}

/** Read an error body (`{ error, message }` or plain text) and phrase it in Vietnamese. */
export async function apiError(response: Response): Promise<ApiError> {
  let code: string | undefined
  let serverMessage: string | undefined
  const raw = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(raw)
    if (body !== null && typeof body === 'object') {
      code = stringField(body, 'error') ?? stringField(body, 'code')
      serverMessage = stringField(body, 'message')
    }
  } catch {
    // not JSON; the status alone decides the sentence
  }
  const status = response.status
  return new ApiError(status, describeStatus(status, code), code, detailOf(status, code, serverMessage))
}

export function describeStatus(status: number, code?: string): string {
  if (status === 401) return 'Phiên đăng nhập Microsoft đã hết hạn hoặc không hợp lệ. Hãy đăng nhập lại.'
  if (status === 403) return 'Bạn hoặc ứng dụng chưa có quyền đọc nguồn này (có thể cần admin consent). Xem README.'
  if (status === 404) return 'Không tìm thấy nhóm chat hoặc kênh này, hoặc bạn không còn là thành viên.'
  if (status === 409) return 'Cuộc trò chuyện này đang xử lý một yêu cầu khác. Đợi xong hoặc bấm Dừng rồi thử lại.'
  if (status === 429) return 'Microsoft Graph hoặc máy chủ đang giới hạn tốc độ. Thử lại sau ít phút.'
  if (status === 503) {
    return code === 'provider_not_configured' || code === undefined || code === 'not_configured'
      ? 'Máy chủ chưa cấu hình nhà cung cấp mô hình (LLM_PROVIDER và API key). Xem README.'
      : 'Máy chủ tạm thời không sẵn sàng. Thử lại sau.'
  }
  if (status === 400) return 'Yêu cầu không hợp lệ.'
  if (status === 413) return 'Tin nhắn quá dài.'
  return `Máy chủ trả lỗi (HTTP ${String(status)}).`
}

function detailOf(status: number, code: string | undefined, message: string | undefined): string | undefined {
  const parts = [message, code === undefined ? undefined : `${code} · HTTP ${String(status)}`]
    .filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' — ')
}

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' && field.trim() !== '' ? field : undefined
}

/** GET a JSON endpoint with the caller's auth headers. */
export async function getJson<T>(path: string, headers: AuthHeaders, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: 'application/json', ...(await headers()) },
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw await apiError(response)
  return (await response.json()) as T
}

/** A random id; falls back when crypto.randomUUID is missing (plain-http LAN origins). */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
