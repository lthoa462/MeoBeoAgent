'use client'

/**
 * The client boundary. Order matters:
 *  1. If this window is an MSAL popup/iframe landing on the redirect URI, hand
 *     the response to the main window and render nothing else.
 *  2. Read /api/health: demo mode skips Microsoft sign-in entirely.
 *  3. Otherwise sign in with MSAL, then show the workspace.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HealthResponse } from '@meobeo/backend/wire'
import { AppShell } from './AppShell'
import { ChatView } from './ChatView'
import { SourcePicker, type Selection } from './SourcePicker'
import { completeAuthResponse, isAuthResponseWindow } from './auth'
import { sourceKey, useChat } from './useChat'
import { useSession, type SessionController } from './useSession'
import { useSources } from './useSources'
import css from './App.module.css'

/** Server defaults, for a health response that lacks the limits (older backend). */
const DEFAULT_MAX_RANGE_DAYS = 31
const DEFAULT_MAX_PERIOD_DAYS = 92

// Module scope, so React's dev double-mount cannot run the bridge twice (the
// first run clears the response from the URL).
let bridge: Promise<boolean> | undefined

function runBridge(): Promise<boolean> {
  bridge ??= completeAuthResponse().then(() => true, () => {
    // Not an MSAL response after all: drop the stray `state` and carry on.
    window.history.replaceState(null, '', window.location.pathname)
    return false
  })
  return bridge
}

export function App() {
  const [boot, setBoot] = useState<'pending' | 'bridge' | 'app'>('pending')

  useEffect(() => {
    if (!isAuthResponseWindow()) {
      setBoot('app')
      return
    }
    setBoot('bridge')
    void runBridge().then((handled) => { if (!handled) setBoot('app') })
  }, [])

  if (boot === 'pending') return <Splash />
  if (boot === 'bridge') return <Splash text="Đang hoàn tất đăng nhập… Cửa sổ này sẽ tự đóng." />
  return <Main />
}

function Main() {
  const session = useSession()
  const { state } = session
  if (state.status === 'loading') return <Splash text="Đang khởi động…" />
  if (state.status === 'unconfigured') return <SetupScreen healthError={session.healthError} />
  if (state.status === 'signed-out') {
    return (
      <SignInScreen
        busy={session.busy}
        error={state.error}
        healthError={session.healthError}
        maxRangeDays={session.health?.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS}
        onSignIn={session.signIn}
      />
    )
  }
  // Keyed by user: signing in as someone else starts from empty memory.
  return <Workspace key={state.user.username} session={session} />
}

function Workspace({ session }: { session: SessionController }) {
  const { health, state } = session
  const demo = state.status === 'ready' && state.mode === 'demo'
  const sources = useSources(session.authHeaders, session.requireReauth)
  const [selection, setSelection] = useState<Selection | undefined>(undefined)
  const [drawer, setDrawer] = useState(false)
  const chat = useChat(selection?.source, session.authHeaders, session.requireReauth)

  // Demo has a single synthetic conversation: open it straight away.
  const firstDemoChat = demo && sources.state.status === 'ready' ? sources.state.data.chats[0] : undefined
  useEffect(() => {
    if (selection !== undefined || firstDemoChat === undefined) return
    const source = { kind: 'demo', label: firstDemoChat.label } as const
    setSelection({
      key: sourceKey(source),
      source,
      title: firstDemoChat.label,
      subtitle: 'Dữ liệu demo — không dùng Microsoft Graph',
    })
  }, [firstDemoChat, selection])

  // After a successful re-login, retry a source list that failed for lack of it.
  const wasReauth = useRef(false)
  const { reload } = sources
  const sourcesFailed = sources.state.status === 'error'
  useEffect(() => {
    if (wasReauth.current && !session.reauthNeeded && sourcesFailed) reload()
    wasReauth.current = session.reauthNeeded
  }, [session.reauthNeeded, sourcesFailed, reload])

  const select = useCallback((next: Selection) => {
    setSelection(next)
    setDrawer(false)
  }, [])

  const banner = (
    <>
      {session.reauthNeeded && (
        <div className={css.banner} data-tone="warn" role="alert">
          <span>Phiên đăng nhập Microsoft đã hết hạn. Hãy đăng nhập lại để tiếp tục.</span>
          <button type="button" className={css.bannerAction} onClick={session.reauth}>
            Đăng nhập lại
          </button>
        </div>
      )}
      {session.healthError !== undefined && (
        <div className={css.banner} data-tone="danger" role="status">
          <span>{session.healthError} Một số chức năng có thể không hoạt động.</span>
        </div>
      )}
    </>
  )

  return (
    <AppShell
      header={<TopBar session={session} health={health} />}
      banner={banner}
      drawerOpen={drawer}
      onDrawer={setDrawer}
      sidebar={(
        <SourcePicker
          state={sources.state}
          demoMode={demo}
          selectedKey={selection?.key}
          runningKeys={chat.runningKeys}
          onSelect={select}
          onReload={sources.reload}
        />
      )}
    >
      {selection === undefined
        ? <NoSource onOpen={() => { setDrawer(true) }} />
        : (
          <ChatView
            title={selection.title}
            subtitle={selection.subtitle}
            chat={chat}
            maxRangeDays={health?.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS}
            maxPeriodDays={health?.maxPeriodDays ?? DEFAULT_MAX_PERIOD_DAYS}
            providerConfigured={health?.providerConfigured ?? true}
            onReauth={session.reauth}
          />
        )}
    </AppShell>
  )
}

function TopBar({ session, health }: { session: SessionController; health: HealthResponse | undefined }) {
  const { state } = session
  const user = state.status === 'ready' ? state.user : undefined
  const microsoft = state.status === 'ready' && state.mode === 'microsoft'
  const model = health === undefined
    ? undefined
    : health.model === undefined ? health.provider : `${health.provider} · ${health.model}`

  return (
    <div className={css.topbar}>
      <div className={css.brand}>
        <span className={css.logo} aria-hidden="true">🐱</span>
        <span className={css.brandName}>MeoBeo</span>
        <span className={css.brandTag}>Tóm tắt Teams</span>
      </div>
      <div className={css.chips}>
        {health?.demoMode === true && <span className={css.chip} data-tone="accent">Chế độ demo</span>}
        {model !== undefined && (
          <span className={css.chip} data-tone={health?.providerConfigured === false ? 'warn' : undefined} title="Mô hình AI đang dùng">
            {health?.providerConfigured === false ? `${model} · chưa cấu hình` : model}
          </span>
        )}
      </div>
      {user !== undefined && (
        <div className={css.user}>
          <span className={css.avatar} aria-hidden="true">{initials(user.name)}</span>
          <span className={css.userText}>
            <span className={css.userName}>{user.name}</span>
            {microsoft && <span className={css.userMail}>{user.username}</span>}
          </span>
          {microsoft && (
            <button type="button" className={css.signOut} onClick={session.signOut}>
              Đăng xuất
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function NoSource({ onOpen }: { onOpen: () => void }) {
  return (
    <div className={css.placeholder}>
      <div className={css.placeholderBadge} aria-hidden="true">💬</div>
      <h1 className={css.placeholderTitle}>Chọn một nhóm chat hoặc kênh</h1>
      <p className={css.placeholderText}>
        Chọn nguồn ở cột bên trái, rồi hỏi MeoBeo tóm tắt, liệt kê việc cần làm hoặc trả lời câu hỏi về nội dung đã trao đổi.
      </p>
      <button type="button" className={css.placeholderAction} onClick={onOpen}>Mở danh sách nhóm</button>
    </div>
  )
}

function Splash({ text }: { text?: string }) {
  return (
    <div className={css.screen}>
      <div className={css.splash}>
        <span className={css.splashLogo} aria-hidden="true">🐱</span>
        {text !== undefined && <p className={css.splashText}>{text}</p>}
      </div>
    </div>
  )
}

function SignInScreen({ busy, error, healthError, maxRangeDays, onSignIn }: {
  busy: boolean
  error: string | undefined
  healthError: string | undefined
  maxRangeDays: number
  onSignIn: () => void
}) {
  return (
    <div className={css.screen}>
      <div className={css.card}>
        <div className={css.cardLogo} aria-hidden="true">🐱</div>
        <h1 className={css.cardTitle}>MeoBeo</h1>
        <p className={css.cardLead}>Trợ lý tóm tắt nhóm chat và kênh Microsoft Teams.</p>
        <ul className={css.points}>
          <li>Đọc tin nhắn chỉ khi bạn hỏi: ngày, tuần hay tháng nào trong quá khứ cũng được (mỗi lần tối đa {maxRangeDays} ngày).</li>
          <li>Không lưu tin nhắn: mọi thứ chỉ nằm trong bộ nhớ và biến mất khi bạn đóng trang.</li>
          <li>Dùng quyền của chính bạn: chỉ thấy những gì bạn thấy trong Teams.</li>
        </ul>
        <button type="button" className={css.primary} onClick={onSignIn}>
          <MicrosoftIcon />
          <span>Đăng nhập bằng Microsoft</span>
        </button>
        {busy && <p className={css.cardNote}>Đang chờ bạn đăng nhập trong cửa sổ Microsoft… Lỡ đóng cửa sổ? Bấm lại nút trên.</p>}
        {!busy && error !== undefined && <p className={css.cardError} role="alert">{error}</p>}
        {healthError !== undefined && <p className={css.cardNote}>{healthError}</p>}
      </div>
    </div>
  )
}

function SetupScreen({ healthError }: { healthError: string | undefined }) {
  return (
    <div className={css.screen}>
      <div className={css.card}>
        <div className={css.cardLogo} aria-hidden="true">🛠️</div>
        <h1 className={css.cardTitle}>Chưa cấu hình đăng nhập Microsoft</h1>
        <p className={css.cardLead}>
          Đặt <code>NEXT_PUBLIC_AZURE_CLIENT_ID</code> (hoặc <code>CLIENT_ID</code>) và <code>NEXT_PUBLIC_AZURE_TENANT_ID</code> trong
          tệp <code>.env</code> ở thư mục gốc, đăng ký địa chỉ trang này làm Redirect URI kiểu SPA trong Entra ID,
          rồi khởi động lại <code>npm run dev</code>.
        </p>
        <p className={css.cardLead}>
          Muốn chạy thử không cần Azure? Đặt <code>DEMO_MODE=1</code> (và <code>LLM_PROVIDER=mock</code> nếu chưa có API key).
        </p>
        <p className={css.cardNote}>Xem hướng dẫn chi tiết trong README.md.</p>
        {healthError !== undefined && <p className={css.cardError}>{healthError}</p>}
      </div>
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(part => part !== '')
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''
  return (first + last).toUpperCase()
}

function MicrosoftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="1" width="6.5" height="6.5" fill="#f25022" />
      <rect x="8.5" y="1" width="6.5" height="6.5" fill="#7fba00" />
      <rect x="1" y="8.5" width="6.5" height="6.5" fill="#00a4ef" />
      <rect x="8.5" y="8.5" width="6.5" height="6.5" fill="#ffb900" />
    </svg>
  )
}
