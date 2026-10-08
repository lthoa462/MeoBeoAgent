'use client'

/**
 * Left column: the group chats, meeting chats and team channels the user can
 * summarize. Picking one binds the source for every turn of that conversation;
 * the model never chooses it.
 */

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ConversationSource, SourcesResponse } from '@meobeo/backend/wire'
import type { SourcesState } from './useSources'
import { sourceKey } from './useChat'
import css from './SourcePicker.module.css'

export interface Selection {
  readonly key: string
  readonly source: ConversationSource
  readonly title: string
  readonly subtitle: string
}

export interface SourcePickerProps {
  readonly state: SourcesState
  readonly demoMode: boolean
  readonly selectedKey: string | undefined
  readonly runningKeys: ReadonlySet<string>
  readonly onSelect: (selection: Selection) => void
  readonly onReload: () => void
}

type Chat = SourcesResponse['chats'][number]
type Team = SourcesResponse['teams'][number]

export function SourcePicker({ state, demoMode, selectedKey, runningKeys, onSelect, onReload }: SourcePickerProps) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const query = fold(filter.trim())

  const data = state.status === 'ready' ? state.data : undefined
  const view = useMemo(() => (data === undefined ? undefined : filterSources(data, query)), [data, query])

  const chatSelection = (chat: Chat): Selection => {
    const source: ConversationSource = demoMode
      ? { kind: 'demo', label: chat.label }
      : { kind: 'chat', chatId: chat.chatId, label: chat.label }
    return { key: sourceKey(source), source, title: chat.label, subtitle: chatKindLabel(chat.chatType, demoMode) }
  }

  const channelSelection = (team: Team, channel: Team['channels'][number]): Selection => {
    const source: ConversationSource = { kind: 'channel', teamId: team.teamId, channelId: channel.channelId, label: `${team.label} › ${channel.label}` }
    return { key: sourceKey(source), source, title: `# ${channel.label}`, subtitle: `Kênh trong nhóm ${team.label}` }
  }

  const row = (selection: Selection, label: string, meta: string | undefined, icon: string) => {
    const active = selection.key === selectedKey
    return (
      <li key={selection.key + label}>
        <button
          type="button"
          className={clsx(css.row, active && css.rowActive)}
          aria-current={active ? 'true' : undefined}
          onClick={() => { onSelect(selection) }}
          title={label}
        >
          <span className={css.rowIcon} aria-hidden="true">{icon}</span>
          <span className={css.rowLabel}>{label}</span>
          {runningKeys.has(selection.key) && <span className={css.runningDot} aria-label="đang xử lý" />}
          {meta !== undefined && <span className={css.rowMeta}>{meta}</span>}
        </button>
      </li>
    )
  }

  const groups = view?.chats.filter(chat => chat.chatType !== 'meeting' && chat.chatType !== 'oneOnOne') ?? []
  const meetings = view?.chats.filter(chat => chat.chatType === 'meeting') ?? []
  const direct = view?.chats.filter(chat => chat.chatType === 'oneOnOne') ?? []

  return (
    <nav className={css.picker} aria-label="Nguồn hội thoại">
      <div className={css.head}>
        <span className={css.headTitle}>Nguồn hội thoại</span>
        <button type="button" className={css.iconButton} onClick={onReload} aria-label="Tải lại danh sách" title="Tải lại danh sách">
          <ReloadIcon />
        </button>
      </div>

      <div className={css.search}>
        <SearchIcon />
        <input
          type="search"
          className={css.searchInput}
          placeholder="Lọc nhóm chat, kênh…"
          aria-label="Lọc nhóm chat, kênh"
          value={filter}
          onChange={(event) => { setFilter(event.target.value) }}
        />
      </div>

      <div className={css.body}>
        {state.status === 'loading' && (
          <ul className={css.skeleton} aria-label="Đang tải">
            {[72, 56, 84, 64, 48, 70].map((width, index) => (
              <li key={index}><span style={{ width: `${String(width)}%` }} /></li>
            ))}
          </ul>
        )}

        {state.status === 'error' && (
          <div className={css.errorBox} role="alert">
            <p className={css.errorText}>{state.message}</p>
            {state.detail !== undefined && <p className={css.errorDetail}>{state.detail}</p>}
            <button type="button" className={css.retry} onClick={onReload}>Thử lại</button>
          </div>
        )}

        {data !== undefined && data.warnings.length > 0 && (
          <ul className={css.warnings}>
            {data.warnings.map(warning => <li key={warning}>{warning}</li>)}
          </ul>
        )}

        {view !== undefined && (
          <>
            {groups.length > 0 && (
              <section className={css.section}>
                <h2 className={css.sectionLabel}>{demoMode ? 'Hội thoại demo' : 'Nhóm chat'}</h2>
                <ul className={css.rows}>
                  {groups.map(chat => row(chatSelection(chat), chat.label, relativeTime(chat.lastUpdated), demoMode ? '🧪' : '💬'))}
                </ul>
              </section>
            )}

            {meetings.length > 0 && (
              <section className={css.section}>
                <h2 className={css.sectionLabel}>Cuộc họp</h2>
                <ul className={css.rows}>
                  {meetings.map(chat => row(chatSelection(chat), chat.label, relativeTime(chat.lastUpdated), '📅'))}
                </ul>
              </section>
            )}

            {direct.length > 0 && (
              <section className={css.section}>
                <h2 className={css.sectionLabel}>Chat 1:1</h2>
                <ul className={css.rows}>
                  {direct.map(chat => row(chatSelection(chat), chat.label, relativeTime(chat.lastUpdated), '👤'))}
                </ul>
              </section>
            )}

            {view.teams.length > 0 && (
              <section className={css.section}>
                <h2 className={css.sectionLabel}>Nhóm (Teams) › kênh</h2>
                {view.teams.map((team) => {
                  // A filter shows every match; otherwise the user folds teams.
                  const open = query !== '' || !collapsed.has(team.teamId)
                  return (
                    <div key={team.teamId} className={css.team}>
                      <button
                        type="button"
                        className={css.teamRow}
                        aria-expanded={open}
                        onClick={() => {
                          setCollapsed((current) => {
                            const next = new Set(current)
                            if (next.has(team.teamId)) next.delete(team.teamId)
                            else next.add(team.teamId)
                            return next
                          })
                        }}
                      >
                        <ChevronIcon open={open} />
                        <span className={css.rowLabel}>{team.label}</span>
                        <span className={css.rowMeta}>{team.channels.length}</span>
                      </button>
                      {open && team.error !== undefined && <p className={css.teamError}>{team.error}</p>}
                      {open && team.channels.length > 0 && (
                        <ul className={clsx(css.rows, css.channels)}>
                          {team.channels.map(channel => row(channelSelection(team, channel), channel.label, undefined, '#'))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </section>
            )}

            {view.chats.length + view.teams.length === 0 && (
              <p className={css.emptyText}>
                {query === ''
                  ? 'Không có nhóm chat hay kênh nào bạn có thể đọc.'
                  : `Không có kết quả cho “${filter.trim()}”.`}
              </p>
            )}
          </>
        )}
      </div>
    </nav>
  )
}

function chatKindLabel(chatType: string, demoMode: boolean): string {
  if (demoMode) return 'Dữ liệu demo — không dùng Microsoft Graph'
  if (chatType === 'meeting') return 'Chat cuộc họp'
  if (chatType === 'oneOnOne') return 'Chat 1:1'
  return 'Nhóm chat'
}

/** Lower-case and strip Vietnamese diacritics so "tong ket" finds "Tổng kết". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D').toLowerCase()
}

function filterSources(data: SourcesResponse, query: string): Pick<SourcesResponse, 'chats' | 'teams'> {
  if (query === '') return data
  const hit = (label: string) => fold(label).includes(query)
  return {
    chats: data.chats.filter(chat => hit(chat.label)),
    teams: data.teams.flatMap((team) => {
      if (hit(team.label)) return [team]
      const channels = team.channels.filter(channel => hit(channel.label))
      return channels.length === 0 ? [] : [{ ...team, channels }]
    }),
  }
}

function relativeTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return undefined
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'vừa xong'
  if (minutes < 60) return `${String(minutes)} phút`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} giờ`
  const days = Math.round(hours / 24)
  if (days < 7) return `${String(days)} ngày`
  return new Date(time).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }).replace('-', '/')
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={clsx(css.chevron, open && css.chevronOpen)}>
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={css.searchIcon}>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
