import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useRoomAccess } from '../hooks/useRoomAccess'
import { usePresence } from '../hooks/usePresence'
import { useRoomReminders } from '../hooks/useReminders'
import { useAppNotifications } from '../hooks/useNotifications'
import { usePwa } from '../hooks/usePwa'
import { RoomDataProvider, useRoomData } from '../lib/roomData'
import { useIdentity } from '../lib/identity'
import { supabase } from '../lib/supabase'
import RoomHeader, { type TabKey } from '../components/RoomHeader'
import MemberPanel from '../components/MemberPanel'
import ShareModal from '../components/ShareModal'
import SearchModal, { type SearchHit } from '../components/SearchModal'
import BoardSettingsModal from '../components/BoardSettingsModal'
import ChatPanel from '../components/ChatPanel'
import NotificationPanel from '../components/NotificationPanel'
import ShortcutsModal from '../components/ShortcutsModal'
import PollPanel from '../components/PollPanel'
import AccessRequestPanel from '../components/AccessRequestPanel'
import WhiteboardTab from './tabs/WhiteboardTab'
import CalendarTab from './tabs/CalendarTab'
import TodoTab from './tabs/TodoTab'
import UpdatesTab from './tabs/UpdatesTab'
import DashboardTab from './tabs/DashboardTab'
import { useBoardUpdates } from '../hooks/useBoardUpdates'
import type { CalendarEvent, RoomPreview } from '../lib/types'
import { isTypingTarget, matchShortcut, toChord } from '../lib/shortcuts'

export default function RoomPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { preview, level, refresh, requestAccess, claimOwner } = useRoomAccess(slug)

  const canAccess = level === 'owner' || level === 'member'

  // ?owner=<token> でオーナー権限を回収する
  const claimedRef = useRef(false)
  useEffect(() => {
    const token = searchParams.get('owner')
    if (!token || claimedRef.current) return
    claimedRef.current = true
    void claimOwner(token).then(() => {
      searchParams.delete('owner')
      setSearchParams(searchParams, { replace: true })
    })
  }, [searchParams, setSearchParams, claimOwner])

  /*
   * 公開ルームに初めて来た人を、承認済みメンバーとして自動登録する。
   *
   * 登録が済むまではボードを描かない。RLS の can_access_room が通すのは
   * 「作った人」と「承認済みの参加者」だけなので、済む前に読みにいくと
   * 1 行も返らない。それでも画面は出てしまうため、中身のあるボードが
   * 「まだ何もありません」に見え、リロードするまで直らなかった。
   */
  const joinedRef = useRef(false)
  const [joinFailed, setJoinFailed] = useState(false)

  const join = useCallback(() => {
    setJoinFailed(false)
    void requestAccess('').catch(() => setJoinFailed(true))
  }, [requestAccess])

  useEffect(() => {
    if (level !== 'guest' || joinedRef.current) return
    joinedRef.current = true
    join()
  }, [level, join])

  // guest は「リンク公開のボードに来たが、まだ登録が済んでいない」状態
  if (level === 'loading' || (level === 'guest' && !joinFailed)) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-400">
        読み込み中…
      </div>
    )
  }

  if (level === 'notfound' || !preview) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mb-2 text-3xl">🔍</div>
          <h1 className="font-bold text-slate-800">ボードが見つかりません</h1>
          <p className="mt-1 text-sm text-slate-500">
            URL が間違っているか、削除された可能性があります。
          </p>
          <Link
            to="/"
            className="mt-6 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            ホームに戻る
          </Link>
        </div>
      </div>
    )
  }

  if (level === 'guest') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mb-2 text-3xl">📶</div>
          <h1 className="font-bold text-slate-800">ボードに入れませんでした</h1>
          <p className="mt-1 text-sm text-slate-500">
            通信が届かなかったようです。つながっているか確かめて、もう一度お試しください。
          </p>
          <button
            type="button"
            onClick={join}
            className="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            もう一度試す
          </button>
        </div>
      </div>
    )
  }

  if (!canAccess) {
    return <AccessRequestPanel preview={preview} level={level} onRequest={requestAccess} />
  }

  return (
    <RoomDataProvider roomId={preview.id} canEdit={preview.can_edit} isOwner={preview.is_owner}>
      <RoomShell preview={preview} onRefreshPreview={refresh} />
    </RoomDataProvider>
  )
}

/** 権限が確定したあとの本体。ここから下ではルームのデータが揃っている前提で書ける。 */
function RoomShell({
  preview,
  onRefreshPreview,
}: {
  preview: RoomPreview
  onRefreshPreview: () => void
}) {
  const { userId, displayName } = useIdentity()
  const { members, events, todos, overrides, comments, live, refetchAll } = useRoomData()

  const [tab, setTab] = useState<TabKey>('board')
  const [focus, setFocus] = useState<{ tab: TabKey; id: string; nonce: number } | null>(null)
  const [showMembers, setShowMembers] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showPolls, setShowPolls] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  const [searchParams, setSearchParams] = useSearchParams()

  const { peers, sendCursor, setEditing } = usePresence(preview.id, userId, displayName, tab)
  const reminders = useRoomReminders(events.rows, todos.rows, overrides.rows, preview.name)
  const notifications = useAppNotifications(preview.id)
  const pwa = usePwa()

  // 作成直後は共有モーダルを自動で開く
  useEffect(() => {
    if (searchParams.get('created') !== '1') return
    setShowShare(true)
    searchParams.delete('created')
    setSearchParams(searchParams, { replace: true })
  }, [searchParams, setSearchParams])

  // Ctrl+F で検索、? でショートカット一覧
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (matchShortcut(toChord(e)) === 'search') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // チャットの未読件数（開いている間は既読にし続ける）
  const seenKey = `board.chatSeen.${preview.id}`
  const [lastSeen, setLastSeen] = useState(() => localStorage.getItem(seenKey) ?? '')

  const boardComments = useMemo(
    () => comments.rows.filter((c) => c.target_type === 'board'),
    [comments.rows],
  )

  useEffect(() => {
    if (!chatOpen) return
    const now = new Date().toISOString()
    localStorage.setItem(seenKey, now)
    setLastSeen(now)
  }, [chatOpen, boardComments.length, seenKey])

  const unreadChat = boardComments.filter(
    (c) => c.author_id !== userId && c.created_at > lastSeen,
  ).length

  // 更新タブの未読（チャットと同じ「最後に見た時刻」方式）
  const updates = useBoardUpdates()
  const updatesSeenKey = `board.updatesSeen.${preview.id}`
  const [updatesSeen, setUpdatesSeen] = useState(
    () => localStorage.getItem(updatesSeenKey) ?? '',
  )

  useEffect(() => {
    if (tab !== 'updates') return
    const now = new Date().toISOString()
    localStorage.setItem(updatesSeenKey, now)
    setUpdatesSeen(now)
  }, [tab, updates.length, updatesSeenKey])

  const unreadUpdates = updates.filter(
    (u) => u.actorId !== userId && u.at > updatesSeen,
  ).length

  const approvedCount = members.rows.filter((m) => m.status === 'approved').length
  const pendingCount = preview.is_owner
    ? members.rows.filter((m) => m.status === 'pending').length
    : 0

  function jumpTo(nextTab: TabKey, id: string | null) {
    setTab(nextTab)
    if (id) setFocus({ tab: nextTab, id, nonce: Date.now() })
  }

  function jumpToHit(hit: SearchHit) {
    setShowSearch(false)
    if (hit.kind === 'comment' && hit.targetId === null) {
      setChatOpen(true)
      return
    }
    jumpTo(hit.tab, hit.targetId)
  }

  /** 日程調整で日が決まったら、そのまま予定として登録する */
  async function createEventFromPoll(event: CalendarEvent) {
    events.upsertLocal(event)
    const { error } = await supabase.from('events').insert(event)
    if (error) {
      events.removeLocal(event.id)
      return
    }
    setShowPolls(false)
    jumpTo('calendar', event.id)
  }

  const focusId = focus && focus.tab === tab ? focus.id : null
  const focusNonce = focus?.nonce ?? 0

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <RoomHeader
        preview={preview}
        tab={tab}
        onTabChange={setTab}
        peers={peers}
        memberCount={approvedCount}
        pendingCount={pendingCount}
        unreadChat={unreadChat}
        unreadNotifications={notifications.unread}
        unreadUpdates={unreadUpdates}
        offline={pwa.offline}
        live={live}
        onRefetchAll={() => void refetchAll()}
        onOpenMembers={() => setShowMembers(true)}
        onOpenShare={() => setShowShare(true)}
        onOpenSearch={() => setShowSearch(true)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenNotifications={() => setShowNotifications(true)}
        onOpenPolls={() => setShowPolls(true)}
        onToggleChat={() => setChatOpen((open) => !open)}
      />

      <main className="min-h-0 flex-1">
        {tab === 'board' && (
          <WhiteboardTab
            peers={peers}
            onCursorMove={sendCursor}
            focusId={focusId}
            focusNonce={focusNonce}
            boardName={preview.name}
            onOpenShortcuts={() => setShowShortcuts(true)}
            onJump={jumpTo}
            onOpenShare={() => setShowShare(true)}
            onEditingChange={setEditing}
          />
        )}
        {tab === 'calendar' && (
          <CalendarTab
            reminders={reminders}
            focusId={focusId}
            focusNonce={focusNonce}
            boardName={preview.name}
            onJump={jumpTo}
          />
        )}
        {tab === 'todo' && (
          <TodoTab
            reminders={reminders}
            focusId={focusId}
            focusNonce={focusNonce}
            onJump={jumpTo}
          />
        )}
        {tab === 'updates' && (
          <UpdatesTab
            updates={updates}
            onJump={jumpTo}
            onOpenChat={() => setChatOpen(true)}
          />
        )}
        {tab === 'dashboard' && <DashboardTab onJump={jumpTo} />}
      </main>

      {showMembers && (
        <MemberPanel
          members={members.rows}
          preview={preview}
          onClose={() => setShowMembers(false)}
          onOpenShare={() => {
            setShowMembers(false)
            setShowShare(true)
          }}
        />
      )}
      {showShare && (
        <ShareModal
          preview={preview}
          onUpdated={onRefreshPreview}
          onClose={() => setShowShare(false)}
        />
      )}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} onJump={jumpToHit} />}
      {showSettings && (
        <BoardSettingsModal
          preview={preview}
          onClose={() => setShowSettings(false)}
          onUpdated={onRefreshPreview}
          onOpenShare={() => {
            setShowSettings(false)
            setShowShare(true)
          }}
        />
      )}
      {showNotifications && (
        <NotificationPanel
          notifications={notifications.rows}
          onClose={() => setShowNotifications(false)}
          onMarkAllRead={notifications.markAllRead}
          onMarkRead={notifications.markRead}
          onRemove={notifications.remove}
          onOpen={jumpTo}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showPolls && (
        <PollPanel onClose={() => setShowPolls(false)} onCreateEvent={createEventFromPoll} />
      )}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </div>
  )
}
