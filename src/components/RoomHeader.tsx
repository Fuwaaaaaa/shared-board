import { Link } from 'react-router-dom'
import PresenceAvatars from './PresenceAvatars'
import { useIdentity } from '../lib/identity'
import { accessInfo } from '../lib/access'
import { SYNC_LABELS, useSyncStatus } from '../lib/syncStatus'
import { ThemeToggle } from '../lib/theme'
import type { Peer } from '../hooks/usePresence'
import type { RoomPreview } from '../lib/types'

export type TabKey = 'board' | 'calendar' | 'todo' | 'updates' | 'dashboard'

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'board', label: 'ホワイトボード', icon: '🖍️' },
  { key: 'calendar', label: 'カレンダー', icon: '📅' },
  { key: 'todo', label: 'リマインド', icon: '⏰' },
  { key: 'updates', label: '更新', icon: '📣' },
  { key: 'dashboard', label: 'ダッシュボード', icon: '📊' },
]

interface Props {
  preview: RoomPreview
  tab: TabKey
  onTabChange: (tab: TabKey) => void
  peers: Peer[]
  memberCount: number
  pendingCount: number
  unreadChat: number
  unreadNotifications: number
  unreadUpdates: number
  offline: boolean
  /** false なら Realtime が切れている（30 秒ごとの取り直しでしのいでいる） */
  live: boolean
  onRefetchAll: () => void
  onOpenMembers: () => void
  onOpenShare: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onOpenNotifications: () => void
  onOpenPolls: () => void
  onToggleChat: () => void
}

export default function RoomHeader({
  preview,
  tab,
  onTabChange,
  peers,
  memberCount,
  pendingCount,
  unreadChat,
  unreadNotifications,
  unreadUpdates,
  offline,
  live,
  onRefetchAll,
  onOpenMembers,
  onOpenShare,
  onOpenSearch,
  onOpenSettings,
  onOpenNotifications,
  onOpenPolls,
  onToggleChat,
}: Props) {
  const { userId, displayName, setDisplayName } = useIdentity()
  const access = accessInfo(preview)
  const sync = useSyncStatus()

  return (
    <header className="shrink-0 border-b border-slate-200 bg-white print:hidden">
      {offline && (
        <div className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
          オフラインです。いま書いたものは保存されません。つながってから書き直してください。
        </div>
      )}
      {/*
        つながってはいるが Realtime が切れている状態。
        中身は 30 秒ごとに追いつくので書き込みは止めなくてよいが、
        「相手の変更がすぐには映らない」ことは伝えておく。
        オフラインのときは上の帯のほうが正確なので、そちらに譲る。
      */}
      {!offline && !live && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-sky-50 px-4 py-1 text-center text-xs text-sky-900">
          <span>⚡ 再接続中です。他の人の変更は 30 秒ごとに取り込んでいます。</span>
          <button
            type="button"
            onClick={onRefetchAll}
            className="rounded border border-sky-300 px-1.5 py-0.5 font-medium transition hover:bg-sky-100"
          >
            今すぐ確認
          </button>
        </div>
      )}
      {preview.archived && (
        <div className="bg-slate-200 px-4 py-1 text-center text-xs text-slate-700">
          このボードは終了しています。中身はそのまま読めますが、新しい書き込みはできません。
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Link
          to="/"
          className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          title="ホームに戻る"
        >
          ←
        </Link>

        <button
          type="button"
          onClick={onOpenSettings}
          title="ボードの設定"
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-2">
            <span className="truncate font-bold text-slate-800">{preview.name}</span>
            <span
              title={`入り方：${access.howToEnter}`}
              className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
            >
              {access.icon} <span className="hidden sm:inline">{access.label}</span>
            </span>
            {preview.archived ? (
              <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">
                🔚 終了
              </span>
            ) : (
              !preview.can_edit && (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                  👀 閲覧のみ
                </span>
              )
            )}
            <span className="shrink-0 text-xs text-slate-300">⚙</span>
          </span>
        </button>

        <PresenceAvatars peers={peers} meId={userId} />

        <div className="toolbar-scroll flex items-center gap-1.5">
          <span
            title={SYNC_LABELS[sync].title}
            className={`shrink-0 rounded-full px-2 py-1 text-xs ${
              sync === 'saved'
                ? 'text-slate-400'
                : sync === 'saving'
                  ? 'text-slate-500'
                  : 'bg-amber-50 text-amber-700'
            }`}
          >
            {SYNC_LABELS[sync].icon}{' '}
            <span className="hidden lg:inline">{SYNC_LABELS[sync].label}</span>
          </span>

          <IconButton title="ボード内を検索" onClick={onOpenSearch}>
            🔍
          </IconButton>

          <IconButton title="チャット" onClick={onToggleChat} badge={unreadChat}>
            💬
          </IconButton>

          <IconButton title="通知" onClick={onOpenNotifications} badge={unreadNotifications}>
            🔔
          </IconButton>

          <IconButton title="日程調整" onClick={onOpenPolls}>
            🗳
          </IconButton>

          <ThemeToggle />

          <button
            type="button"
            onClick={onOpenMembers}
            title="参加者"
            className="relative shrink-0 rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            👥 {memberCount}
            {pendingCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-xs font-bold text-white">
                {pendingCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenShare}
            className="shrink-0 rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            🔗 <span className="hidden sm:inline">共有</span>
          </button>

          <button
            type="button"
            title="表示名を変更"
            onClick={() => {
              const next = window.prompt('表示名を変更', displayName)
              if (next?.trim()) setDisplayName(next)
            }}
            className="shrink-0 rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            👤 <span className="hidden md:inline">{displayName}</span>
          </button>
        </div>
      </div>

      <nav className="flex gap-1 px-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onTabChange(t.key)}
            className={`relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === t.key
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className="mr-1">{t.icon}</span>
            <span className="hidden sm:inline">{t.label}</span>
            {t.key === 'updates' && unreadUpdates > 0 && (
              <span className="absolute top-0.5 right-0 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {unreadUpdates > 99 ? '99+' : unreadUpdates}
              </span>
            )}
          </button>
        ))}
      </nav>
    </header>
  )
}

function IconButton({
  title,
  onClick,
  badge = 0,
  children,
}: {
  title: string
  onClick: () => void
  badge?: number
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="relative shrink-0 rounded-full border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
    >
      {children}
      {badge > 0 && (
        <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-slate-900 px-1 text-xs font-bold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}
