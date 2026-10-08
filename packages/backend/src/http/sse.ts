/**
 * A TurnHandle as a Server-Sent Events response: one `data: <json>` frame per
 * WireEvent, a `: ping` comment every 15 s so proxies keep the connection open,
 * and the run aborted when the browser goes away (request signal or body
 * cancel). Frames are serialized as-is; nothing is logged.
 */

import type { TurnHandle } from '../agents/session.ts'
import type { WireEvent } from '../wire.ts'

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
}

const PING_INTERVAL_MS = 15_000

export interface SseOptions {
  /** Aborts when the client disconnects (the incoming request's signal). */
  readonly signal?: AbortSignal
  readonly pingIntervalMs?: number
}

export function sseResponse(handle: TurnHandle, options: SseOptions = {}): Response {
  const encoder = new TextEncoder()
  const { signal } = options
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ping: ReturnType<typeof setInterval> | undefined

  const write = (chunk: string): void => {
    if (controller === undefined) return
    try {
      controller.enqueue(encoder.encode(chunk))
    } catch {
      // Closed or errored underneath us: the client is gone.
      finish()
    }
  }
  const send = (event: WireEvent): void => write(`data: ${JSON.stringify(event)}\n\n`)

  /** Stop writing and close the body (idempotent). */
  const finish = (): void => {
    const target = controller
    controller = undefined
    clearInterval(ping)
    signal?.removeEventListener('abort', disconnected)
    try { target?.close() } catch { /* already closed or cancelled */ }
  }
  function disconnected(): void {
    finish()
    handle.abort(new Error('client disconnected'))
  }

  const body = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target
      if (signal?.aborted) {
        disconnected()
        return
      }
      signal?.addEventListener('abort', disconnected, { once: true })
      ping = setInterval(() => write(': ping\n\n'), options.pingIntervalMs ?? PING_INTERVAL_MS)
      void (async () => {
        try {
          for await (const event of handle) send(event)
        } catch {
          // The handle's queue never throws; this only guards the contract.
          send({ t: 'error', code: 'internal', message: 'Lỗi máy chủ khi gửi kết quả.' })
        } finally {
          finish()
        }
      })()
    },
    cancel() {
      disconnected()
    },
  })

  return new Response(body, { headers: SSE_HEADERS })
}
