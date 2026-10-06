'use client'

/**
 * Who is using the app and how every API call authenticates.
 *
 * /api/health decides the mode first: in demo mode sign-in is skipped and no
 * Authorization header is sent. Otherwise MSAL is initialized (browser only)
 * and each call asks it for a fresh token.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HealthResponse } from '@meobeo/backend/wire'
import {
  ReauthRequiredError, authSettings, createMicrosoftAuth, describeAuthError,
  type MicrosoftAuth, type SignedInUser,
} from './auth'
import type { AuthHeaders } from './api'

export type SessionState =
  | { readonly status: 'loading' }
  /** No client id configured and not in demo mode: show the setup hint. */
  | { readonly status: 'unconfigured' }
  | { readonly status: 'signed-out'; readonly error?: string }
  | { readonly status: 'ready'; readonly mode: 'demo' | 'microsoft'; readonly user: SignedInUser }

export interface SessionController {
  readonly state: SessionState
  readonly health: HealthResponse | undefined
  /** Set when /api/health could not be read (backend down or misconfigured). */
  readonly healthError: string | undefined
  /** True while a sign-in or sign-out popup is open. */
  readonly busy: boolean
  /** The server or MSAL rejected the token; the UI shows a "sign in again" prompt. */
  readonly reauthNeeded: boolean
  readonly authHeaders: AuthHeaders
  readonly signIn: () => void
  readonly signOut: () => void
  readonly requireReauth: () => void
  readonly reauth: () => void
}

const DEMO_USER: SignedInUser = { name: 'Demo', username: 'demo' }

export function useSession(): SessionController {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const [health, setHealth] = useState<HealthResponse | undefined>(undefined)
  const [healthError, setHealthError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [reauthNeeded, setReauthNeeded] = useState(false)
  const auth = useRef<MicrosoftAuth | undefined>(undefined)
  const mode = useRef<'demo' | 'microsoft' | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const body = await readHealth()
      if (cancelled) return
      if (body.health === undefined) setHealthError(body.error)
      else setHealth(body.health)

      if (body.health?.demoMode === true) {
        mode.current = 'demo'
        setState({ status: 'ready', mode: 'demo', user: DEMO_USER })
        return
      }
      const settings = authSettings()
      if (settings.clientId === undefined) {
        setState({ status: 'unconfigured' })
        return
      }
      try {
        const created = await createMicrosoftAuth({ clientId: settings.clientId, tenantId: settings.tenantId })
        if (cancelled) return
        auth.current = created
        mode.current = 'microsoft'
        const user = created.user()
        setState(user === undefined ? { status: 'signed-out' } : { status: 'ready', mode: 'microsoft', user })
      } catch (error) {
        if (!cancelled) setState({ status: 'signed-out', error: describeAuthError(error) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const authHeaders = useCallback<AuthHeaders>(async () => {
    if (mode.current === 'demo') return {}
    const client = auth.current
    if (client === undefined) throw new ReauthRequiredError()
    try {
      return { authorization: `Bearer ${await client.getToken()}` }
    } catch (error) {
      if (error instanceof ReauthRequiredError) setReauthNeeded(true)
      throw error
    }
  }, [])

  /** Latest interactive attempt; an older one that gets cancelled by a re-click stays quiet. */
  const attempt = useRef(0)

  // Not blocked while busy: MSAL v5 cannot tell that a popup was closed, so a
  // second click must be able to start over (signIn overrides the stale one).
  const signInWith = useCallback((onError: (error: unknown) => void) => {
    const client = auth.current
    if (client === undefined) return
    const mine = ++attempt.current
    setBusy(true)
    client.signIn()
      .then((user) => {
        if (mine !== attempt.current) return // signed out meanwhile
        setReauthNeeded(false)
        setState({ status: 'ready', mode: 'microsoft', user })
      })
      .catch((error: unknown) => { if (mine === attempt.current) onError(error) })
      .finally(() => { if (mine === attempt.current) setBusy(false) })
  }, [])

  const signIn = useCallback(() => {
    signInWith((error) => { setState({ status: 'signed-out', error: describeAuthError(error) }) })
  }, [signInWith])

  // Keep the re-login prompt on failure; the user can retry or sign out.
  const reauth = useCallback(() => { signInWith(() => undefined) }, [signInWith])

  const signOut = useCallback(() => {
    const client = auth.current
    if (client === undefined) return
    attempt.current++
    setBusy(false)
    setReauthNeeded(false)
    setState({ status: 'signed-out' })
    client.signOut()
  }, [])

  const requireReauth = useCallback(() => {
    if (mode.current === 'microsoft') setReauthNeeded(true)
  }, [])

  return { state, health, healthError, busy, reauthNeeded, authHeaders, signIn, signOut, requireReauth, reauth }
}

async function readHealth(): Promise<{ health?: HealthResponse; error?: string }> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    if (!response.ok) return { error: `Máy chủ trả lỗi khi kiểm tra trạng thái (HTTP ${String(response.status)}).` }
    return { health: (await response.json()) as HealthResponse }
  } catch {
    return { error: 'Không kết nối được máy chủ.' }
  }
}
