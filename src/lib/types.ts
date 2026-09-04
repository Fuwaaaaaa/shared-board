export type Visibility = 'public' | 'private'
export type MemberStatus = 'pending' | 'approved' | 'rejected'
export type MemberRole = 'owner' | 'member'

export interface Room {
  id: string
  slug: string
  name: string
  visibility: Visibility
  owner_id: string
  owner_name: string
  archived: boolean
  created_at: string
}

/** get_room_preview RPC の戻り値。まだ入れないボードでも「名前だけ」は誰でも見える。 */
export interface RoomPreview {
  id: string
  slug: string
  name: string
  visibility: Visibility
  owner_name: string
  is_owner: boolean
  my_status: MemberStatus | null
  /** false なら「閲覧のみ」。コメントと投票はできるが中身は変えられない */
  can_edit: boolean
  /** 終了したボード。中身は読めるが、新しい書き込みは誰にもできない（can_edit も false になる） */
  archived: boolean
  /** 参加に合言葉が要るか。合言葉そのものはサーバーから出てこない */
  needs_pin: boolean
  /** 入れない理由（受付停止・参加期限切れ・人数上限）。空文字なら入れる */
  join_blocked: string
}

/** オーナーだけが変えられる、共有リンクの受け入れ条件 */
export interface JoinSettings {
  join_closed: boolean
  join_expires_at: string | null
  max_members: number | null
}

export interface RoomMember {
  id: string
  room_id: string
  user_id: string
  display_name: string
  role: MemberRole
  status: MemberStatus
  can_edit: boolean
  favorite: boolean
  message: string
  created_at: string
  decided_at: string | null
}

/** 付箋（sticky）と、枠なしで文字だけ置くテキストボックス（text） */
export type NoteKind = 'sticky' | 'text'

export interface Note {
  id: string
  room_id: string
  kind: NoteKind
  x: number
  y: number
  w: number
  h: number
  color: string
  text: string
  tags: string[]
  z: number
  /** 文字サイズ（px）。0 は「まだ決めていない」で、種類ごとの既定を使う */
  font_size: number
  deleted_at: string | null
  author_id: string
  author_name: string
  created_at: string
  updated_at: string
}

export interface NoteVote {
  id: string
  room_id: string
  note_id: string
  user_id: string
  voter_name: string
  created_at: string
}

export type ActivityAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'completed'
  | 'reopened'
  | 'restored'
  // ここから下は target_type = 'access' のときだけ使う。
  // 「いつ誰が入ってきたか」「誰が権限を変えたか」を、付箋の履歴と同じ流れに残す。
  | 'member_approved'
  | 'member_rejected'
  | 'member_removed'
  | 'member_left'
  | 'member_can_edit'
  | 'member_view_only'
  | 'members_revoked_all'
  | 'board_closed'
  | 'board_reopened'
  | 'link_rotated'
  | 'owner_link_rotated'
  | 'access_mode'
  | 'join_settings'
  | 'pin_set'
  | 'pin_cleared'

/**
 * ゴミ箱に入るもの。
 * deleted_at が入っている行は画面に出さず、ゴミ箱から戻せる。
 */
export interface SoftDeletable {
  deleted_at: string | null
}

export interface Activity {
  id: string
  room_id: string
  actor_id: string | null
  actor_name: string
  action: ActivityAction
  target_type: 'notes' | 'events' | 'todos' | 'images' | 'access'
  /** 付箋なら本文、アクセスまわりなら相手の名前や設定の内容 */
  target_label: string
  created_at: string
}

export type Point = [number, number]

/** 手描き（free）と図形。図形の points は始点・終点の 2 点だけ */
export type StrokeKind = 'free' | 'line' | 'arrow' | 'rect' | 'ellipse'

export interface Stroke {
  id: string
  room_id: string
  kind: StrokeKind
  points: Point[]
  color: string
  width: number
  author_id: string
  created_at: string
}

export interface BoardImage {
  id: string
  room_id: string
  storage_path: string
  x: number
  y: number
  w: number
  h: number
  z: number
  deleted_at: string | null
  author_id: string
  author_name: string
  created_at: string
}

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: '繰り返さない',
  daily: '毎日',
  weekly: '毎週',
  monthly: '毎月',
  yearly: '毎年',
}

/** 事前通知の選択肢（分）。null は通知なし */
export const REMIND_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: '通知なし' },
  { value: 0, label: '時刻ちょうど' },
  { value: 5, label: '5分前' },
  { value: 15, label: '15分前' },
  { value: 30, label: '30分前' },
  { value: 60, label: '1時間前' },
  { value: 1440, label: '1日前' },
]

/**
 * カレンダーに出るものの種類。
 *
 * event（予定）は「その時間に何かをする」、deadline（締切）は「その日までに終える」。
 * 意味が違うので、カレンダー上でも見た目を分ける。
 */
export type EventKind = 'event' | 'deadline'

export const EVENT_KIND_LABELS: Record<EventKind, { icon: string; label: string; hint: string }> = {
  event: { icon: '📅', label: '予定', hint: 'その日時に集まる・行うこと' },
  deadline: { icon: '⏰', label: '締切', hint: 'その日までに終わらせること' },
}

export interface CalendarEvent {
  id: string
  room_id: string
  kind: EventKind
  title: string
  description: string
  start_at: string
  end_at: string | null
  all_day: boolean
  color: string
  recurrence: Recurrence
  recurrence_until: string | null
  remind_minutes: number | null
  tags: string[]
  /** この予定のもとになった付箋。付箋が消えても予定は残る（null になる） */
  source_note_id: string | null
  /** もとを取り込んだ時点の、もとの updated_at。これより新しければ「元が変わった」 */
  source_synced_at: string | null
  deleted_at: string | null
  author_id: string
  author_name: string
  created_at: string
  updated_at: string
}

/**
 * 繰り返し予定の「この回だけ」の変更・削除。
 *
 * occurrence_date は元の回の開始日（'yyyy-MM-dd'）で、その回を別の日へ動かしても変わらない。
 * canceled が false の行は差分ではなく、表示に必要な値を丸ごと持つ。
 */
export interface EventOverride {
  id: string
  room_id: string
  event_id: string
  occurrence_date: string
  canceled: boolean
  title: string | null
  description: string | null
  start_at: string | null
  end_at: string | null
  all_day: boolean | null
  color: string | null
  remind_minutes: number | null
  tags: string[] | null
  author_id: string
  author_name: string
  created_at: string
}

/** 繰り返しを展開した 1 回分。id は元の予定と同じ、occurrenceKey で日ごとに区別する */
export interface EventOccurrence {
  /** DB 上の元の 1 行。id や繰り返し設定はこちらを見る */
  event: CalendarEvent
  /** 例外を当てたあとの表示用の値。例外がなければ event と同じ内容 */
  view: CalendarEvent
  /** 実効の開始（この回だけ動かしたあと） */
  start: Date
  end: Date | null
  /** 元の回の開始。例外の同定に使うので、動かしてもこの値は変わらない */
  originalStart: Date
  /** この回だけの変更。null なら素の繰り返し */
  override: EventOverride | null
  occurrenceKey: string
}

export interface Subtask {
  id: string
  title: string
  done: boolean
}

export interface Todo {
  id: string
  room_id: string
  title: string
  notes: string
  due_at: string | null
  done: boolean
  done_at: string | null
  assignee_id: string | null
  assignee_name: string
  remind_minutes: number | null
  recurrence: Recurrence
  subtasks: Subtask[]
  tags: string[]
  status: TodoStatus
  sort_order: number
  /** このやることのもとになった付箋 / 予定。もとが消えても残る（null になる） */
  source_note_id: string | null
  source_event_id: string | null
  /** もとを取り込んだ時点の、もとの updated_at。これより新しければ「元が変わった」 */
  source_synced_at: string | null
  /**
   * 繰り返しのやることを完了したときに作られる「次回分」が、どの行から生まれたか。
   * 同じ元から派生した未完了の次回分は 1 件だけ（DB の部分一意インデックス）。
   */
  source_todo_id: string | null
  deleted_at: string | null
  author_id: string
  author_name: string
  created_at: string
}

/** 付箋どうしをつなぐ線。座標は付箋の位置から計算する。 */
export interface Connector {
  id: string
  room_id: string
  from_note_id: string
  to_note_id: string
  style: 'arrow' | 'line'
  color: string
  label: string
  author_id: string
  created_at: string
}

export interface Frame {
  id: string
  room_id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  color: string
  z: number
  author_id: string
  author_name: string
  created_at: string
}

export interface NoteReaction {
  id: string
  room_id: string
  note_id: string
  user_id: string
  emoji: string
  created_at: string
}

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🤔', '😮', '🙏']

export interface Attachment {
  id: string
  room_id: string
  storage_path: string
  filename: string
  mime: string
  size: number
  x: number
  y: number
  z: number
  author_id: string
  author_name: string
  created_at: string
}

export type PollAnswer = 'yes' | 'maybe' | 'no'

export const POLL_ANSWER_LABELS: Record<PollAnswer, { label: string; mark: string }> = {
  yes: { label: '参加できる', mark: '○' },
  maybe: { label: 'たぶん', mark: '△' },
  no: { label: '難しい', mark: '×' },
}

export interface Poll {
  id: string
  room_id: string
  title: string
  description: string
  status: 'open' | 'closed'
  decided_option_id: string | null
  author_id: string
  author_name: string
  created_at: string
}

export interface PollOption {
  id: string
  poll_id: string
  room_id: string
  start_at: string
  end_at: string | null
  all_day: boolean
  sort: number
}

export interface PollVote {
  id: string
  poll_id: string
  option_id: string
  room_id: string
  user_id: string
  voter_name: string
  answer: PollAnswer
  created_at: string
}

export interface CalendarFeed {
  id: string
  room_id: string
  name: string
  url: string
  color: string
  enabled: boolean
  author_id: string
  created_at: string
}

/**
 * 通知の種類。増やすときは supabase/schema.sql の
 * notifications_kind_check も一緒に直す。
 */
export type NotificationKind =
  | 'mention'
  | 'assigned'
  | 'converted'
  | 'join_request'
  | 'join_decided'

export const NOTIFICATION_ICONS: Record<NotificationKind, string> = {
  mention: '💬',
  assigned: '⏰',
  converted: '🖍️',
  join_request: '🙋',
  join_decided: '👋',
}

export interface AppNotification {
  id: string
  room_id: string
  user_id: string
  actor_name: string
  kind: string
  body: string
  link_tab: string
  link_id: string | null
  read: boolean
  created_at: string
}

/** リマインドのカンバン列 */
export type TodoStatus = 'todo' | 'doing' | 'done'

export const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  todo: '未着手',
  doing: '進行中',
  done: '完了',
}

export type CommentTarget = 'board' | 'note' | 'event' | 'todo'

export interface Comment {
  id: string
  room_id: string
  target_type: CommentTarget
  target_id: string | null
  body: string
  author_id: string
  author_name: string
  created_at: string
}

/**
 * 付箋の色。
 *
 * ライトは「色紙」の明るい色のまま。ダークでは同じ色相の暗いトーンにして、
 * 文字色も明るくする（index.css の変数反転だけでは、明るい付箋の上の文字が
 * 明るくなって読めなくなるため、付箋は JS 側で切り替える）。
 * boardExport.ts（PNG 書き出し）は bg / border だけを使い、ライト固定。
 */
export interface NoteColor {
  label: string
  bg: string
  border: string
  text: string
  darkBg: string
  darkBorder: string
  darkText: string
}

export const NOTE_COLORS: Record<string, NoteColor> = {
  yellow: {
    label: '黄色',
    bg: '#fef3c7',
    border: '#f5c542',
    text: '#1e293b',
    darkBg: '#4a3a10',
    darkBorder: '#8a6d1f',
    darkText: '#fef3c7',
  },
  pink: {
    label: 'ピンク',
    bg: '#fce7f3',
    border: '#f0a6cd',
    text: '#1e293b',
    darkBg: '#4a1f36',
    darkBorder: '#8a3f68',
    darkText: '#fce7f3',
  },
  blue: {
    label: '青',
    bg: '#dbeafe',
    border: '#7fb0f0',
    text: '#1e293b',
    darkBg: '#1e2f4a',
    darkBorder: '#3b5f8a',
    darkText: '#dbeafe',
  },
  green: {
    label: '緑',
    bg: '#dcfce7',
    border: '#7cd6a0',
    text: '#1e293b',
    darkBg: '#1c3a2a',
    darkBorder: '#2f6d4a',
    darkText: '#dcfce7',
  },
  purple: {
    label: '紫',
    bg: '#ede9fe',
    border: '#b3a4f5',
    text: '#1e293b',
    darkBg: '#2f2648',
    darkBorder: '#5b4a8a',
    darkText: '#ede9fe',
  },
  gray: {
    label: 'グレー',
    bg: '#f1f5f9',
    border: '#b7c3d1',
    text: '#1e293b',
    darkBg: '#2a3441',
    darkBorder: '#4b5a6b',
    darkText: '#e2e8f0',
  },
}

/** 付箋の見た目に使う色を、テーマに合わせて返す。知らない色名は黄色にする */
export function noteStyle(
  color: string,
  dark: boolean,
): { bg: string; border: string; text: string } {
  const palette = NOTE_COLORS[color] ?? NOTE_COLORS.yellow
  return dark
    ? { bg: palette.darkBg, border: palette.darkBorder, text: palette.darkText }
    : { bg: palette.bg, border: palette.border, text: palette.text }
}

/** 予定の色パレット */
export const EVENT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  blue: { bg: '#dbeafe', text: '#1e40af', dot: '#3b82f6' },
  rose: { bg: '#ffe4e6', text: '#9f1239', dot: '#f43f5e' },
  amber: { bg: '#fef3c7', text: '#92400e', dot: '#f59e0b' },
  green: { bg: '#dcfce7', text: '#166534', dot: '#22c55e' },
  violet: { bg: '#ede9fe', text: '#5b21b6', dot: '#8b5cf6' },
  slate: { bg: '#e2e8f0', text: '#334155', dot: '#64748b' },
}

/** ペンの色 */
export const PEN_COLORS = ['#1f2937', '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7']

/** ペンの色の読み上げ用ラベル（スクリーンリーダーは色そのものを読めない） */
export const PEN_COLOR_LABELS: Record<string, string> = {
  '#1f2937': '黒',
  '#ef4444': '赤',
  '#3b82f6': '青',
  '#22c55e': '緑',
  '#f59e0b': 'オレンジ',
  '#a855f7': '紫',
}
