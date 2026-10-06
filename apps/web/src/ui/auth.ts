/**
 * Microsoft sign-in for the SPA (MSAL browser v5, delegated Graph token).
 *
 * The token is sent to our own API as `Authorization: Bearer`, and the backend
 * forwards it to Graph without storing it. MSAL keeps its token cache in
 * sessionStorage, so closing the tab signs the browser out of this app.
 *
 * MSAL is imported dynamically: it touches `window`, and this module is also
 * evaluated during server rendering of the client components.
 */

import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser'

export const GRAPH_SCOPES: readonly string[] = [
  'User.Read',
  'Chat.Read',
  'ChannelMessage.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
]

export interface AuthSettings {
  readonly clientId: string | undefined
  readonly tenantId: string | undefined
}

/** Inlined at build time by next.config.ts (falls back to CLIENT_ID / TENANT_ID). */
export function authSettings(): AuthSettings {
  return {
    clientId: blankToUndefined(process.env.NEXT_PUBLIC_AZURE_CLIENT_ID),
    tenantId: blankToUndefined(process.env.NEXT_PUBLIC_AZURE_TENANT_ID),
  }
}

export interface SignedInUser {
  readonly name: string
  readonly username: string
}

/** Silent renewal failed and an interactive popup could not complete it. */
export class ReauthRequiredError extends Error {
  constructor(message = 'Cần đăng nhập lại Microsoft.') {
    super(message)
    this.name = 'ReauthRequiredError'
  }
}

export interface MicrosoftAuth {
  readonly user: () => SignedInUser | undefined
  readonly signIn: () => Promise<SignedInUser>
  /** A fresh access token for the Graph scopes; silent first, popup on interaction_required. */
  readonly getToken: () => Promise<string>
  /** Signs this tab out at once; the Microsoft logout popup finishes on its own. */
  readonly signOut: () => void
}

/**
 * MSAL v5 delivers popup and silent-iframe results through a "redirect bridge":
 * the redirect URI page itself must post the response back to the opener. Our
 * redirect URI is the app origin, so the app checks this before anything else.
 * The library state rides in `state`, which a normal visit never carries.
 */
export function isAuthResponseWindow(): boolean {
  if (typeof window === 'undefined') return false
  const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ''))
  const query = new URLSearchParams(window.location.search)
  return hash.has('state') || query.has('state')
}

/** Hand the auth response in this window's URL to the main window; MSAL then closes us. */
export async function completeAuthResponse(): Promise<void> {
  const title = document.title
  try {
    const bridge = await import('@azure/msal-browser/redirect-bridge')
    await bridge.broadcastResponseToMainFrame()
  } catch (error) {
    // The bridge renames the page before parsing; undo that if it was not ours.
    document.title = title
    throw error
  }
}

/** Create and initialize the MSAL client. Browser only. */
export async function createMicrosoftAuth(settings: { readonly clientId: string; readonly tenantId: string | undefined }): Promise<MicrosoftAuth> {
  const msal = await import('@azure/msal-browser')
  const origin = window.location.origin
  const app: IPublicClientApplication = new msal.PublicClientApplication({
    auth: {
      clientId: settings.clientId,
      authority: `https://login.microsoftonline.com/${settings.tenantId ?? 'organizations'}`,
      redirectUri: origin,
      postLogoutRedirectUri: origin,
    },
    cache: { cacheLocation: 'sessionStorage' },
    system: {
      // Never log tokens or account details to the console.
      loggerOptions: { piiLoggingEnabled: false, logLevel: msal.LogLevel.Error },
      // v5 cannot see a popup being closed (COOP), it only times out; leave
      // room for MFA, and let a second click take over (see signIn).
      popupBridgeTimeout: 180_000,
    },
  })
  await app.initialize()
  const redirected = await app.handleRedirectPromise()
  if (redirected?.account) app.setActiveAccount(redirected.account)
  else if (app.getActiveAccount() === null) {
    const [first] = app.getAllAccounts()
    if (first !== undefined) app.setActiveAccount(first)
  }

  const scopes = [...GRAPH_SCOPES]

  const user = (): SignedInUser | undefined => {
    const account = app.getActiveAccount()
    return account === null ? undefined : toUser(account)
  }

  const signIn = async (): Promise<SignedInUser> => {
    // A user who closed the first popup clicks again: cancel the stale wait
    // instead of failing with interaction_in_progress for minutes.
    const result = await app.loginPopup({ scopes, prompt: 'select_account', overrideInteractionInProgress: true })
    app.setActiveAccount(result.account)
    return toUser(result.account)
  }

  const getToken = async (): Promise<string> => {
    const account = app.getActiveAccount()
    if (account === null) throw new ReauthRequiredError()
    try {
      return (await app.acquireTokenSilent({ scopes, account })).accessToken
    } catch (error) {
      // Anything else (iframe renewal timed out because third-party cookies
      // are blocked, network down) is also fixed by signing in again.
      if (!(error instanceof msal.InteractionRequiredAuthError)) {
        throw new ReauthRequiredError('Không làm mới được phiên đăng nhập Microsoft. Hãy đăng nhập lại.')
      }
    }
    try {
      const result = await app.acquireTokenPopup({ scopes, account })
      app.setActiveAccount(result.account)
      return result.accessToken
    } catch {
      // Usually a blocked popup (no user gesture) or a closed window: the UI
      // offers a sign-in button, which is a gesture.
      throw new ReauthRequiredError()
    }
  }

  const signOut = (): void => {
    const account = app.getActiveAccount()
    // Not awaited: MSAL waits for the post-logout page until the bridge
    // timeout, and the tab is signed out as soon as the local cache is gone.
    void app.logoutPopup({ ...(account === null ? {} : { account }) })
      .catch(() => app.clearCache().catch(() => undefined))
    app.setActiveAccount(null)
  }

  return { user, signIn, getToken, signOut }
}

/** Vietnamese sentence for an MSAL failure, without echoing tokens or claims. */
export function describeAuthError(error: unknown): string {
  if (error instanceof ReauthRequiredError) return error.message
  const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'errorCode') : undefined
  if (code === 'user_cancelled') return 'Bạn đã đóng cửa sổ đăng nhập.'
  if (code === 'popup_window_error' || code === 'empty_window_error') {
    return 'Trình duyệt đã chặn cửa sổ đăng nhập. Hãy cho phép popup cho trang này rồi thử lại.'
  }
  if (code === 'interaction_in_progress') return 'Đang có một cửa sổ đăng nhập mở. Hãy hoàn tất hoặc đóng nó rồi thử lại.'
  if (code === 'timed_out') return 'Hết thời gian chờ đăng nhập. Hãy thử lại.'
  if (typeof code === 'string' && code.startsWith('AADSTS')) return `Microsoft từ chối đăng nhập (${code}). Xem README phần cấu hình Entra ID.`
  const message = error instanceof Error ? error.message : ''
  const aadsts = /AADSTS\d+/u.exec(message)?.[0]
  if (aadsts !== undefined) return `Microsoft từ chối đăng nhập (${aadsts}). Xem README phần cấu hình Entra ID.`
  return 'Đăng nhập Microsoft không thành công. Hãy thử lại.'
}

function toUser(account: AccountInfo): SignedInUser {
  return { name: account.name ?? account.username, username: account.username }
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
