'use client'

/** The chats and channels the signed-in user can summarize (GET /api/sources). */

import { useCallback, useEffect, useState } from 'react'
import type { SourcesResponse } from '@meobeo/backend/wire'
import { ApiError, getJson, type AuthHeaders } from './api'
import { ReauthRequiredError } from './auth'

export type SourcesState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly detail?: string }
  | { readonly status: 'ready'; readonly data: SourcesResponse }

export interface SourcesController {
  readonly state: SourcesState
  readonly reload: () => void
}

export function useSources(headers: AuthHeaders, onReauth: () => void): SourcesController {
  const [state, setState] = useState<SourcesState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    getJson<SourcesResponse>('/api/sources', headers, controller.signal)
      .then((data) => { setState({ status: 'ready', data }) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError) {
          if (error.reauth) onReauth()
          setState({ status: 'error', message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) })
        } else if (error instanceof ReauthRequiredError) {
          setState({ status: 'error', message: error.message })
        } else {
          setState({ status: 'error', message: 'Không tải được danh sách nhóm chat. Kiểm tra kết nối rồi thử lại.' })
        }
      })
    return () => { controller.abort() }
  }, [headers, onReauth, attempt])

  const reload = useCallback(() => { setAttempt(value => value + 1) }, [])
  return { state, reload }
}
