'use client'

/**
 * Frame: header across the top, source sidebar on the left, conversation on
 * the right. On narrow screens the sidebar becomes a drawer over the content.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './AppShell.module.css'

export interface AppShellProps {
  readonly header: ReactNode
  /** Full-width notices under the header (re-login, server problems). */
  readonly banner?: ReactNode
  readonly sidebar: ReactNode
  readonly children: ReactNode
  readonly drawerOpen: boolean
  readonly onDrawer: (open: boolean) => void
}

export function AppShell({ header, banner, sidebar, children, drawerOpen, onDrawer }: AppShellProps) {
  // Escape closes the drawer, as it would close any overlay.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDrawer(false) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [drawerOpen, onDrawer])

  return (
    <div className={css.frame}>
      <header className={css.header}>
        <button
          type="button"
          className={css.menuButton}
          aria-label={drawerOpen ? 'Đóng danh sách nhóm' : 'Mở danh sách nhóm'}
          aria-expanded={drawerOpen}
          onClick={() => { onDrawer(!drawerOpen) }}
        >
          <MenuIcon />
        </button>
        {header}
      </header>
      {banner}
      <div className={css.body}>
        <aside className={clsx(css.sidebar, drawerOpen && css.sidebarOpen)}>{sidebar}</aside>
        {drawerOpen && <div className={css.scrim} onClick={() => { onDrawer(false) }} aria-hidden="true" />}
        <main className={css.main}>{children}</main>
      </div>
    </div>
  )
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
