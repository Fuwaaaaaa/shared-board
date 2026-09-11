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
  EventAttendance,
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
  frames: Frame[]
  connectors: Connector[]
  attachments: Attachment[]
  comments: Comment[]
  /*
   * 手描き（strokes）はここに入らない。points が重いのでゴミ箱の行を
   * そもそも購読していない（useRealtimeTable の skipDeleted）。
   * 中身は TrashModal が開いたときに取りに行く。
   */
}

interface RoomData {
  roomId: string
  /** false なら「閲覧のみ」。編集系の UI を出さない */
  canEdit: boolean
  /** ボードを作った人か。中身を丸ごと置き換える操作（保存した状態から戻す）に使う */
  isOwner: boolean
  /**
   * 終了したボードか。
   *
   * canEdit では代わりにならない。出欠やコメントは「閲覧のみ」の人も書けるが、
   * 終了したボードでは誰も書けない（サーバー側の room_is_open）。
   * その 2 つを画面側で見分けるのに要る。
   */
  archived: boolean
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
  /** 予定の回ごとの出欠（○/△/×） */
  attendance: Table<EventAttendance>
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
  archived,
  children,
}: {
  roomId: string
  canEdit: boolean
  isOwner: boolean
  archived: boolean
  children: ReactNode
}) {
  const allNotes = useRealtimeTable<Note>('notes', roomId)
  // 手描きだけ、ゴミ箱の行を live に載せない（points が重いので全員に配らない）。
  // 中身は TrashModal が開いたときに取りに行く
  const allStrokes = useRealtimeTable<Stroke>('strokes', roomId, { skipDeleted: true })
  const allImages = useRealtimeTable<BoardImage>('images', roomId)
  const allAttachments = useRealtimeTable<Attachment>('attachments', roomId)
  const allConnectors = useRealtimeTable<Connector>('connectors', roomId)
  const allFrames = useRealtimeTable<Frame>('frames', roomId)
  const reactions = useRealtimeTable<NoteReaction>('note_reactions', roomId)
  const allEvents = useRealtimeTable<CalendarEvent>('events', roomId)
  const overrides = useRealtimeTable<EventOverride>('event_overrides', roomId)
  const allTodos = useRealtimeTable<Todo>('todos', roomId)
  const allComments = useRealtimeTable<Comment>('comments', roomId)
  const votes = useRealtimeTable<NoteVote>('note_votes', roomId)
  const polls = useRealtimeTable<Poll>('polls', roomId)
  const pollOptions = useRealtimeTable<PollOption>('poll_options', roomId)
  const pollVotes = useRealtimeTable<PollVote>('poll_votes', roomId)
  const attendance = useRealtimeTable<EventAttendance>('event_attendance', roomId)
  const feeds = useRealtimeTable<CalendarFeed>('calendar_feeds', roomId)
  const activities = useRealtimeTable<Activity>('activities', roomId)
  const members = useRealtimeTable<RoomMember>('room_members', roomId)

  const [notes, trashedNotes] = useWithoutDeleted(allNotes)
  /*
   * 手描きは「捨てたぶん」を受け取らない。
   *
   * それでもここを通すのは、消した直後の 1 往復ぶんのため。楽観的更新は
   * deleted_at を書き込むだけなので、ここで外さないと消した線が
   * サーバーの返事（と Realtime のエコー）が届くまで画面に残る。
   *
   * 返ってくる trashed は「このタブで消したぶん」しか入っていないので、
   * ゴミ箱の一覧には使えない（TrashModal が自分で取りに行く）。
   */
  const [strokes] = useWithoutDeleted(allStrokes)
  const [images, trashedImages] = useWithoutDeleted(allImages)
  const [events, trashedEvents] = useWithoutDeleted(allEvents)
  const [todos, trashedTodos] = useWithoutDeleted(allTodos)
  const [frames, trashedFrames] = useWithoutDeleted(allFrames)
  const [connectors, trashedConnectors] = useWithoutDeleted(allConnectors)
  const [attachments, trashedAttachments] = useWithoutDeleted(allAttachments)
  /*
   * 消した発言を rows から外すのはここ 1 か所。
   *
   * コメントを読んでいる場所は多い（チャット・付箋や予定のコメント欄・横断検索・
   * 📣 更新・各タブの件数バッジ）が、どれも roomData を通っている。
   * 1 つでも直に from('comments') を叩くと、そこだけ消した発言が生き返る。
   */
  const [comments, trashedComments] = useWithoutDeleted(allComments)

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
    allAttachments.live &&
    allConnectors.live &&
    allFrames.live &&
    reactions.live &&
    allEvents.live &&
    overrides.live &&
    allTodos.live &&
    comments.live &&
    votes.live &&
    polls.live &&
    pollOptions.live &&
    pollVotes.live &&
    attendance.live &&
    feeds.live &&
    activities.live &&
    members.live

  // refetch を 19 個そのまま useCallback の依存に並べると、どれか 1 つが
  // 作り直されるたびに refetchAll の identity が変わって Provider の value が
  // 揺れる。ref 経由にして、refetchAll 自体は一度きりにする。
  const refetchersRef = useRef<(() => Promise<void>)[]>([])
  refetchersRef.current = [
    allNotes.refetch,
    strokes.refetch,
    allImages.refetch,
    allAttachments.refetch,
    allConnectors.refetch,
    allFrames.refetch,
    reactions.refetch,
    allEvents.refetch,
    overrides.refetch,
    allTodos.refetch,
    comments.refetch,
    votes.refetch,
    polls.refetch,
    pollOptions.refetch,
    pollVotes.refetch,
    attendance.refetch,
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
      frames: trashedFrames,
      connectors: trashedConnectors,
      attachments: trashedAttachments,
      comments: trashedComments,
    }),
    [
      trashedNotes,
      trashedEvents,
      trashedTodos,
      trashedImages,
      trashedFrames,
      trashedConnectors,
      trashedAttachments,
      trashedComments,
    ],
  )

  // Provider の value を毎回作り直すと、購読している全タブ・全レイヤーが
  // どのテーブルが変わっても再描画される。変わったときだけ新しい値にする。
  // （Context の分割はしない。レイヤー側の memo 化で足りる）
  const value = useMemo<RoomData>(
    () => ({
      roomId,
      canEdit,
      isOwner,
      archived,
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
      attendance,
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
      archived,
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
      attendance,
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
