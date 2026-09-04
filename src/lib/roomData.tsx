import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import { useRealtimeTable } from '../hooks/useRealtimeTable'
import type {
  Activity,
  Attachment,
  BoardImage,
  CalendarEvent,
  CalendarFeed,
  Comment,
  Connector,
  EventOverride,
  Frame,
  Note,
  NoteReaction,
  NoteVote,
  Poll,
  PollOption,
  PollVote,
  RoomMember,
  Stroke,
  Todo,
} from './types'

type Table<T extends { id: string }> = ReturnType<typeof useRealtimeTable<T>>

/** ゴミ箱に入っているもの。30 日で自動的に消える。 */
export interface Trash {
  notes: Note[]
  events: CalendarEvent[]
  todos: Todo[]
  images: BoardImage[]
}

interface RoomData {
  roomId: string
  /** false なら「閲覧のみ」。編集系の UI を出さない */
  canEdit: boolean
  /** ボードを作った人か。中身を丸ごと置き換える操作（保存した状態から戻す）に使う */
  isOwner: boolean
  notes: Table<Note>
  strokes: Table<Stroke>
  images: Table<BoardImage>
  attachments: Table<Attachment>
  connectors: Table<Connector>
  frames: Table<Frame>
  reactions: Table<NoteReaction>
  events: Table<CalendarEvent>
  /** 繰り返し予定の「この回だけ」の変更・削除 */
  overrides: Table<EventOverride>
  todos: Table<Todo>
  comments: Table<Comment>
  votes: Table<NoteVote>
  polls: Table<Poll>
  pollOptions: Table<PollOption>
  pollVotes: Table<PollVote>
  feeds: Table<CalendarFeed>
  activities: Table<Activity>
  members: Table<RoomMember>
  /** 承認済み参加者（担当者の選択などに使う） */
  approvedMembers: RoomMember[]
  /** 削除済み。戻すか、完全に消すかを選べる */
  trash: Trash
  /**
   * すべてのテーブルで Realtime がつながっているか。
   *
   * 1 つでも切れていれば false。切れている間も useRealtimeTable が 30 秒ごとに
   * 取り直しているので中身は追いつくが、「他の人の変更が即座には届かない」状態なので
   * 画面に出す（共同編集では、届いていないことに気付けないのがいちばん困る）。
   */
  live: boolean
  /** 全テーブルを取り直す。「今すぐ確認」から呼ぶ */
  refetchAll: () => Promise<void>
}

const RoomDataContext = createContext<RoomData | null>(null)

export function useRoomData(): RoomData {
  const ctx = useContext(RoomDataContext)
  if (!ctx) throw new Error('useRoomData は RoomDataProvider の内側で使ってください')
  return ctx
}

/**
 * ゴミ箱に入っている行を rows から外す。
 *
 * 論理削除は Realtime では UPDATE として届くので、取得のしかたは変えずに済む。
 * 各タブは rows しか見ていないため、ここで分けるだけで削除済みが画面から消える。
 */
function useWithoutDeleted<T extends { id: string; deleted_at: string | null }>(
  table: Table<T>,
): readonly [Table<T>, T[]] {
  const live = useMemo(() => table.rows.filter((row) => !row.deleted_at), [table.rows])
  const trashed = useMemo(
    () =>
      table.rows
        .filter((row) => row.deleted_at)
        .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '')),
    [table.rows],
  )
  // table 自体は useRealtimeTable 側で useMemo されているので、
  // ここでも参照を保てば「何も変わっていないのに全レイヤーが再描画される」ことがなくなる。
  // getRow / patchLocal などは削除済みも含む元の行を見る（ゴミ箱の行も undo で触るため）。
  const withoutDeleted = useMemo(() => ({ ...table, rows: live }), [table, live])
  return useMemo(() => [withoutDeleted, trashed] as const, [withoutDeleted, trashed])
}

/**
 * ルームの全データをここでまとめて購読する。
 *
 * タブごとに購読すると「カレンダータブを開いていないとリマインドが鳴らない」
 * 「横断検索ができない」といった問題が出るため、ルーム単位で 1 回だけ購読する。
 */
export function RoomDataProvider({
  roomId,
  canEdit,
  isOwner,
  children,
}: {
  roomId: string
  canEdit: boolean
  isOwner: boolean
  children: ReactNode
}) {
  const allNotes = useRealtimeTable<Note>('notes', roomId)
  const strokes = useRealtimeTable<Stroke>('strokes', roomId)
  const allImages = useRealtimeTable<BoardImage>('images', roomId)
  const attachments = useRealtimeTable<Attachment>('attachments', roomId)
  const connectors = useRealtimeTable<Connector>('connectors', roomId)
  const frames = useRealtimeTable<Frame>('frames', roomId)
  const reactions = useRealtimeTable<NoteReaction>('note_reactions', roomId)
  const allEvents = useRealtimeTable<CalendarEvent>('events', roomId)
  const overrides = useRealtimeTable<EventOverride>('event_overrides', roomId)
  const allTodos = useRealtimeTable<Todo>('todos', roomId)
  const comments = useRealtimeTable<Comment>('comments', roomId)
  const votes = useRealtimeTable<NoteVote>('note_votes', roomId)
  const polls = useRealtimeTable<Poll>('polls', roomId)
  const pollOptions = useRealtimeTable<PollOption>('poll_options', roomId)
  const pollVotes = useRealtimeTable<PollVote>('poll_votes', roomId)
  const feeds = useRealtimeTable<CalendarFeed>('calendar_feeds', roomId)
  const activities = useRealtimeTable<Activity>('activities', roomId)
  const members = useRealtimeTable<RoomMember>('room_members', roomId)

  const [notes, trashedNotes] = useWithoutDeleted(allNotes)
  const [images, trashedImages] = useWithoutDeleted(allImages)
  const [events, trashedEvents] = useWithoutDeleted(allEvents)
  const [todos, trashedTodos] = useWithoutDeleted(allTodos)

  const approvedMembers = useMemo(
    () =>
      members.rows
        .filter((m) => m.status === 'approved')
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja')),
    [members.rows],
  )

  // どれか 1 つでも切れていれば「つながっていない」とみなす。
  // 真偽値なので useMemo は要らない（毎回同じ値なら value の useMemo が止める）。
  const live =
    allNotes.live &&
    strokes.live &&
    allImages.live &&
    attachments.live &&
    connectors.live &&
    frames.live &&
    reactions.live &&
    allEvents.live &&
    overrides.live &&
    allTodos.live &&
    comments.live &&
    votes.live &&
    polls.live &&
    pollOptions.live &&
    pollVotes.live &&
    feeds.live &&
    activities.live &&
    members.live

  // refetch を 18 個そのまま useCallback の依存に並べると、どれか 1 つが
  // 作り直されるたびに refetchAll の identity が変わって Provider の value が
  // 揺れる。ref 経由にして、refetchAll 自体は一度きりにする。
  const refetchersRef = useRef<(() => Promise<void>)[]>([])
  refetchersRef.current = [
    allNotes.refetch,
    strokes.refetch,
    allImages.refetch,
    attachments.refetch,
    connectors.refetch,
    frames.refetch,
    reactions.refetch,
    allEvents.refetch,
    overrides.refetch,
    allTodos.refetch,
    comments.refetch,
    votes.refetch,
    polls.refetch,
    pollOptions.refetch,
    pollVotes.refetch,
    feeds.refetch,
    activities.refetch,
    members.refetch,
  ]

  const refetchAll = useCallback(async () => {
    await Promise.all(refetchersRef.current.map((refetch) => refetch()))
  }, [])

  const trash = useMemo<Trash>(
    () => ({
      notes: trashedNotes,
      events: trashedEvents,
      todos: trashedTodos,
      images: trashedImages,
    }),
    [trashedNotes, trashedEvents, trashedTodos, trashedImages],
  )

  // Provider の value を毎回作り直すと、購読している全タブ・全レイヤーが
  // どのテーブルが変わっても再描画される。変わったときだけ新しい値にする。
  // （Context の分割はしない。レイヤー側の memo 化で足りる）
  const value = useMemo<RoomData>(
    () => ({
      roomId,
      canEdit,
      isOwner,
      notes,
      strokes,
      images,
      attachments,
      connectors,
      frames,
      reactions,
      events,
      overrides,
      todos,
      comments,
      votes,
      polls,
      pollOptions,
      pollVotes,
      feeds,
      activities,
      members,
      approvedMembers,
      trash,
      live,
      refetchAll,
    }),
    [
      roomId,
      canEdit,
      isOwner,
      notes,
      strokes,
      images,
      attachments,
      connectors,
      frames,
      reactions,
      events,
      overrides,
      todos,
      comments,
      votes,
      polls,
      pollOptions,
      pollVotes,
      feeds,
      activities,
      members,
      approvedMembers,
      trash,
      live,
      refetchAll,
    ],
  )

  return <RoomDataContext.Provider value={value}>{children}</RoomDataContext.Provider>
}
