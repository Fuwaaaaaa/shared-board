import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useRoomAccess } from '../hooks/useRoomAccess'
import { usePresence } from '../hooks/usePresence'
import { useRoomReminders } from '../hooks/useReminders'
import { useAppNotifications } from '../hooks/useNotifications'
import { usePwa } from '../hooks/usePwa'
import { RoomDataProvider, useRoomData } from '../lib/roomData'
import { useIdentity } from '../lib/identity'
import { supabase } from '../lib/supabase'
import { notifyRoomChanged } from '../lib/roomChannel'
import { useOutboxReady } from '../lib/outboxStore'
import { useWriteQueue } from '../hooks/useWriteQueue'
import RoomHeader, { TAB_KEYS, type TabKey } from '../components/RoomHeader'
import AccessRequestPanel from '../components/AccessRequestPanel'
import Loading from '../components/Loading'
import ErrorBoundary from '../components/ErrorBoundary'
import type { SearchHit } from '../components/SearchModal'
import { useBoardUpdates } from '../hooks/useBoardUpdates'
import type { CalendarEvent, RoomPreview } from '../lib/types'
import { isTypingTarget, matchShortcut, toChord } from '../lib/shortcuts'

/*
 * タブとモーダルは、開いたときに取りに行く。
 *
 * どれも元から「選ばれているものだけを描く」書き方（{tab === 'board' && …}）
 * なので、lazy を被せるだけで実際に読み込む量が減る。
 * ボードのタブが一番大きい（WhiteboardTab とレイヤー 8 枚）ので、
 * カレンダーしか見ない人は最後まで取りに行かない。
 */
const WhiteboardTab = lazy(() => import('./tabs/WhiteboardTab'))
const CalendarTab = lazy(() => import('./tabs/CalendarTab'))
const TodoTab = lazy(() => import('./tabs/TodoTab'))
const UpdatesTab = lazy(() => import('./tabs/UpdatesTab'))
const DashboardTab = lazy(() => import('./tabs/DashboardTab'))

const MemberPanel = lazy(() => import('../components/MemberPanel'))
const ShareModal = lazy(() => import('../components/ShareModal'))
const SearchModal = lazy(() => import('../components/SearchModal'))
const BoardSettingsModal = lazy(() => import('../components/BoardSettingsModal'))
const ChatPanel = lazy(() => import('../components/ChatPanel'))
const NotificationPanel = lazy(() => import('../components/NotificationPanel'))
const ShortcutsModal = lazy(() => import('../components/ShortcutsModal'))
const PollPanel = lazy(() => import('../components/PollPanel'))
const OutboxModal = lazy(() => import('../components/OutboxModal'))

export default function RoomPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { preview, level, refresh, requestAccess, claimOwner } = useRoomAccess(slug)

  const canAccess = level === 'owner' || level === 'member'
  // ためてある書き込みを読み終わるまで、ボードを描き始めない（main.tsx を参照）
  const queueReady = useOutboxReady()

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
  if (!queueReady || level === 'loading' || (level === 'guest' && !joinFailed)) {
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
    <RoomDataProvider
      roomId={preview.id}
      canEdit={preview.can_edit}
      isOwner={preview.is_owner}
      archived={preview.archived}
    >
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

  // ためた書き込みを、つながったら送る
  useWriteQueue(userId)

  const [tab, setTab] = useState<TabKey>('board')
  const [focus, setFocus] = useState<{ tab: TabKey; id: string; nonce: number } | null>(null)
  const [showMembers, setShowMembers] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showPolls, setShowPolls] = useState(false)
  const [showOutbox, setShowOutbox] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  const [searchParams, setSearchParams] = useSearchParams()

  const { peers, sendCursor, setEditing } = usePresence(
    preview.id,
    userId,
    displayName,
    tab,
    onRefreshPreview,
  )

  /*
   * 設定を変えたときの後始末。自分の画面を取り直し、開いている他の人にも合図を送る。
   *
   * モーダルには 1 つにまとめて渡す。片方だけ呼ぶ書き方にすると、
   * 「自分には反映されるのに相手には届かない」が必ずどこかで起きる。
   */
  const onUpdated = useCallback(() => {
    onRefreshPreview()
    notifyRoomChanged(preview.id)
  }, [onRefreshPreview, preview.id])

  // 終了したことを知らせる帯は RoomHeader が preview.archived を見て出している。
  // 合図で preview が更新されるようになったので、リロードなしでその場に出る。

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

  /*
   * ホームの「自分の番」から飛んできたとき（?tab=todo&focus=…）。
   *
   * 読み終わるのを待たない。行がまだ届いていなくても useFocusJump が
   * 届いたところでもう一度合わせにいく（検索や通知から飛ぶときと同じ道）。
   *
   * 合図を URL から消すのは、created=1 と同じ理由。残したまま置くと、
   * リロードやタブの切り替えのたびに同じところへ引き戻される。
   */
  useEffect(() => {
    const wanted = searchParams.get('tab')
    if (!wanted || !TAB_KEYS.includes(wanted as TabKey)) return

    setTab(wanted as TabKey)
    const id = searchParams.get('focus')
    if (id) setFocus({ tab: wanted as TabKey, id, nonce: Date.now() })

    searchParams.delete('tab')
    searchParams.delete('focus')
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

  /**
   * 日程調整で日が決まったら、そのまま予定として登録する。作れたら true。
   *
   * 作れなかったことは呼び出し側（PollPanel）が伝える。ここで黙って戻ると、
   * 日程調整は締まったのに暦には何も無い、という食い違いだけが残る。
   */
  async function createEventFromPoll(event: CalendarEvent): Promise<boolean> {
    events.upsertLocal(event)
    const { error } = await supabase.from('events').insert(event)
    if (error) {
      events.removeLocal(event.id)
      return false
    }
    setShowPolls(false)
    jumpTo('calendar', event.id)
    return true
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
        onOpenOutbox={() => setShowOutbox(true)}
        onToggleChat={() => setChatOpen((open) => !open)}
      />

      <main className="min-h-0 flex-1">
        <ErrorBoundary key={tab} where={`tab:${tab}`} variant="inline">
          <Suspense fallback={<Loading />}>
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
          </Suspense>
        </ErrorBoundary>
      </main>

      {/* モーダルは開いた瞬間に取りに行く。受け皿を出すと画面が一瞬ちらつくので出さない */}
      <ErrorBoundary where="modals" variant="inline">
        <Suspense fallback={null}>
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
              onUpdated={onUpdated}
              onClose={() => setShowShare(false)}
            />
          )}
          {showSearch && <SearchModal onClose={() => setShowSearch(false)} onJump={jumpToHit} />}
          {showSettings && (
            <BoardSettingsModal
              preview={preview}
              onClose={() => setShowSettings(false)}
              onUpdated={onUpdated}
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
          {showOutbox && <OutboxModal onClose={() => setShowOutbox(false)} />}
          {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
