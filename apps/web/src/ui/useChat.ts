'use client'

/**
 * Chat transport and per-source conversations.
 *
 * The SSE body is read with `fetch` rather than `EventSource` because the run
 * is started by a POST that carries the prompt, and because aborting the fetch
 * is the cancellation signal the backend listens for.
 *
 * Privacy: conversations live in a ref inside this hook and nowhere else. They
 * vanish on reload, sign-out or "Cuộc trò chuyện mới"; nothing is written to
 * localStorage, sessionStorage or IndexedDB.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ChatRequest, ConversationSource } from '@meobeo/backend/wire'
import { ApiError, apiError, newId, type AuthHeaders } from './api'
import { ReauthRequiredError } from './auth'
import { isAuthErrorCode, readEvents, reduceTurn, settleTurn } from './stream'
import type { Thread, Turn, TurnError } from './types'

export interface ChatController {
  /** The conversation about the selected source; undefined before its first message. */
  readonly thread: Thread | undefined
  readonly running: boolean
  /** Source keys with a turn in flight (runs continue while another source is shown). */
  readonly runningKeys: ReadonlySet<string>
  readonly send: (text: string) => void
  readonly stop: () => void
  /** "Cuộc trò chuyện mới": forget this source's conversation here and on the server. */
  readonly reset: () => void
}

export function sourceKey(source: ConversationSource): string {
  if (source.kind === 'chat') return `chat:${source.chatId}`
  if (source.kind === 'channel') return `channel:${source.teamId}/${source.channelId}`
  return `demo:${source.label ?? ''}`
}

export function useChat(
  source: ConversationSource | undefined,
  headers: AuthHeaders,
  onReauth: () => void,
): ChatController {
  const threads = useRef(new Map<string, Thread>())
  const runs = useRef(new Map<string, AbortController>())
  const [, render] = useReducer((value: number) => value + 1, 0)
  const frame = useRef<number | undefined>(undefined)

  // Text deltas arrive faster than the screen refreshes; render once per frame.
  const schedule = useCallback(() => {
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      render()
    })
  }, [])

  // Leaving the page (sign-out, unmount) stops every run and drops the text.
  useEffect(() => {
    const active = runs.current
    const held = threads.current
    return () => {
      for (const controller of active.values()) controller.abort()
      active.clear()
      held.clear()
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    }
  }, [])

  /** Apply `update` to one turn, unless its conversation was reset meanwhile. */
  const patch = useCallback((key: string, conversationId: string, turnId: string, update: (turn: Turn) => Turn) => {
    const thread = threads.current.get(key)
    if (thread === undefined || thread.conversationId !== conversationId) return
    threads.current.set(key, {
      ...thread,
      turns: thread.turns.map(turn => turn.id === turnId ? update(turn) : turn),
    })
    schedule()
  }, [schedule])

  const send = useCallback((text: string) => {
    const message = text.trim()
    if (source === undefined || message === '') return
    const key = sourceKey(source)
    if (runs.current.has(key)) return

    const thread = threads.current.get(key) ?? { conversationId: newId(), turns: [] }
    const turn: Turn = { id: newId(), prompt: message, startedAt: Date.now(), status: 'running', steps: [], answer: [] }
    threads.current.set(key, { ...thread, turns: [...thread.turns, turn] })
    const controller = new AbortController()
    runs.current.set(key, controller)
    render()

    const { conversationId } = thread
    const update = (change: (current: Turn) => Turn) => { patch(key, conversationId, turn.id, change) }
    const fail = (error: TurnError) => { update(current => ({ ...current, status: 'failed', error })) }
    const body: ChatRequest = {
      conversationId,
      source,
      message,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }

    void (async () => {
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          // Raced with the abort signal: a token popup can wait for minutes, and
          // "Dừng" must settle the turn at once.
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(await abortable(headers(), controller.signal)) },
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || response.body === null) {
          const error = await apiError(response)
          if (error.reauth) onReauth()
          fail(fromApiError(error))
          return
        }
        let ended = false
        for await (const event of readEvents(response.body)) {
          update(current => reduceTurn(current, event))
          if (event.t === 'done' || event.t === 'error') ended = true
          if (event.t === 'error' && isAuthErrorCode(event.code)) onReauth()
        }
        if (!ended && !controller.signal.aborted) {
          fail({ message: 'Kết nối tới máy chủ bị ngắt trước khi trả lời xong. Hãy thử lại.' })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof ReauthRequiredError) fail({ message: error.message, reauth: true })
        else if (error instanceof ApiError) fail(fromApiError(error))
        else fail({ message: 'Mất kết nối tới máy chủ giữa chừng. Hãy thử lại.' })
      } finally {
        if (runs.current.get(key) === controller) runs.current.delete(key)
        update(current => settleTurn(current, controller.signal.aborted ? 'stopped' : 'ended', Date.now()))
        render()
      }
    })()
  }, [source, headers, onReauth, patch])

  const stop = useCallback(() => {
    if (source !== undefined) runs.current.get(sourceKey(source))?.abort()
  }, [source])

  const reset = useCallback(() => {
    if (source === undefined) return
    const key = sourceKey(source)
    runs.current.get(key)?.abort()
    runs.current.delete(key)
    const previous = threads.current.get(key)
    threads.current.delete(key)
    render()
    if (previous === undefined) return
    // Best effort: the server drops its session after a TTL anyway, and the
    // next message uses a fresh conversation id regardless.
    void (async () => {
      try {
        await fetch('/api/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(await headers()) },
          body: JSON.stringify({ conversationId: previous.conversationId }),
          cache: 'no-store',
        })
      } catch {
        // ignored
      }
    })()
  }, [source, headers])

  const key = source === undefined ? undefined : sourceKey(source)
  return {
    thread: key === undefined ? undefined : threads.current.get(key),
    running: key !== undefined && runs.current.has(key),
    runningKeys: new Set(runs.current.keys()),
    send,
    stop,
    reset,
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

function fromApiError(error: ApiError): TurnError {
  return {
    message: error.message,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.reauth ? { reauth: true } : {}),
  }
}
