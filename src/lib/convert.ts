import type { CalendarEvent, EventKind, Note, Todo } from './types'

/**
 * 付箋 → やること → 予定 の変換をここにまとめる。
 *
 * 「考えたことが、そのまま行動になる」流れをつくる部分なので、
 * 各タブに散らばらないよう行の組み立てだけをこのファイルに集約する。
 * 保存（insert）と楽観的更新は、これまでどおり呼び出し側のタブが行う。
 */

export interface Author {
  userId: string
  displayName: string
}

/** DB 側の上限にそろえる（UI の maxLength と同じ値） */
const TITLE_MAX = 120
const EVENT_TITLE_MAX = 100
const BODY_MAX = 500

/**
 * 付箋の本文を「最初の中身のある行 = タイトル / 残り = メモ」に分ける。
 * 空の付箋なら title は空文字を返すので、呼び出し側で弾く。
 */
export function splitNoteText(text: string): { title: string; body: string } {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1) return { title: '', body: '' }

  return {
    title: lines[first].trim().slice(0, TITLE_MAX),
    body: lines
      .slice(first + 1)
      .join('\n')
      .trim()
      .slice(0, BODY_MAX),
  }
}

export interface TodoSeed {
  roomId: string
  author: Author
  title: string
  notes?: string
  dueAt?: string | null
  assigneeId?: string | null
  assigneeName?: string
  remindMinutes?: number | null
  tags?: string[]
  sourceNoteId?: string | null
  sourceEventId?: string | null
  /** もとを取り込んだ時点の、もとの updated_at */
  sourceSyncedAt?: string | null
}

/** やること 1 行を組み立てる。既定値はすべてここで埋める */
export function buildTodo(seed: TodoSeed): Todo {
  return {
    id: crypto.randomUUID(),
    room_id: seed.roomId,
    title: seed.title.slice(0, TITLE_MAX),
    notes: (seed.notes ?? '').slice(0, BODY_MAX),
    due_at: seed.dueAt ?? null,
    done: false,
    done_at: null,
    assignee_id: seed.assigneeId ?? null,
    assignee_name: seed.assigneeName ?? '',
    // 期限がなければ事前通知は意味を持たないので落とす
    remind_minutes: seed.dueAt ? (seed.remindMinutes ?? null) : null,
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    subtasks: [],
    tags: seed.tags ?? [],
    status: 'todo',
    sort_order: Date.now(),
    source_note_id: seed.sourceNoteId ?? null,
    source_event_id: seed.sourceEventId ?? null,
    source_synced_at: seed.sourceSyncedAt ?? null,
    source_todo_id: null,
    deleted_at: null,
    author_id: seed.author.userId,
    author_name: seed.author.displayName,
    created_at: new Date().toISOString(),
  }
}

export interface EventSeed {
  roomId: string
  author: Author
  /** 予定（既定）か締切か */
  kind?: EventKind
  title: string
  description?: string
  startAt: string
  endAt?: string | null
  allDay?: boolean
  color?: string
  remindMinutes?: number | null
  tags?: string[]
  sourceNoteId?: string | null
  /** もとを取り込んだ時点の、もとの updated_at */
  sourceSyncedAt?: string | null
}

/** 予定 1 行を組み立てる */
export function buildEvent(seed: EventSeed): CalendarEvent {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    room_id: seed.roomId,
    kind: seed.kind ?? 'event',
    title: seed.title.slice(0, EVENT_TITLE_MAX),
    description: (seed.description ?? '').slice(0, BODY_MAX),
    start_at: seed.startAt,
    end_at: seed.endAt ?? null,
    all_day: seed.allDay ?? true,
    color: seed.color ?? 'blue',
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_until: null,
    remind_minutes: seed.remindMinutes ?? null,
    tags: seed.tags ?? [],
    source_note_id: seed.sourceNoteId ?? null,
    source_synced_at: seed.sourceSyncedAt ?? null,
    deleted_at: null,
    author_id: seed.author.userId,
    author_name: seed.author.displayName,
    created_at: now,
    updated_at: now,
  }
}

/** 予定 → やること（「準備することを追加」） */
export function todoFromEvent(event: CalendarEvent, roomId: string, author: Author): Todo {
  return buildTodo({
    roomId,
    author,
    title: event.title,
    notes: event.description,
    dueAt: event.start_at,
    remindMinutes: event.remind_minutes ?? 0,
    tags: event.tags ?? [],
    sourceEventId: event.id,
    sourceSyncedAt: event.updated_at,
  })
}

/** 付箋 → やること（既定値のみ。担当や期限はダイアログで足す） */
export function todoFromNote(note: Note, roomId: string, author: Author): Todo {
  const { title, body } = splitNoteText(note.text)
  return buildTodo({
    roomId,
    author,
    title,
    notes: body,
    tags: note.tags ?? [],
    sourceNoteId: note.id,
    sourceSyncedAt: note.updated_at,
  })
}

/** 付箋 → 予定 */
export function eventFromNote(
  note: Note,
  roomId: string,
  author: Author,
  startAt: string,
  allDay = true,
  kind: EventKind = 'event',
): CalendarEvent {
  const { title, body } = splitNoteText(note.text)
  return buildEvent({
    roomId,
    author,
    kind,
    title,
    description: body,
    startAt,
    allDay,
    tags: note.tags ?? [],
    sourceNoteId: note.id,
    sourceSyncedAt: note.updated_at,
  })
}

/* ---------------------------------------------------------------------------
 *  もとが変わったときの扱い
 *
 *  作ったあとの やること / 予定 は、もとの付箋とは別のものとして動く。
 *  共同編集では、片方を直したらもう片方も勝手に変わる方が驚かれるため。
 *  代わりに「もとが変わった」ことだけを知らせて、反映するかどうかは選んでもらう。
 * ------------------------------------------------------------------------- */

/** もと（付箋・予定）が、取り込んだあとに変わっているか */
export function originChanged(
  item: { source_synced_at: string | null },
  source: { updated_at: string } | undefined | null,
): boolean {
  if (!source || !item.source_synced_at) return false
  return source.updated_at > item.source_synced_at
}

/** 「反映する」で書き戻す内容（やること用） */
export function todoPatchFromNote(note: Note): Partial<Todo> {
  const { title, body } = splitNoteText(note.text)
  return {
    title: title.slice(0, TITLE_MAX),
    notes: body.slice(0, BODY_MAX),
    source_synced_at: note.updated_at,
  }
}

/** 「反映する」で書き戻す内容（予定用） */
export function eventPatchFromNote(note: Note): Partial<CalendarEvent> {
  const { title, body } = splitNoteText(note.text)
  return {
    title: title.slice(0, EVENT_TITLE_MAX),
    description: body.slice(0, BODY_MAX),
    source_synced_at: note.updated_at,
  }
}

/** 「予定 → やること」で、予定の変更を書き戻す内容 */
export function todoPatchFromEvent(event: CalendarEvent): Partial<Todo> {
  return {
    title: event.title.slice(0, TITLE_MAX),
    notes: event.description.slice(0, BODY_MAX),
    due_at: event.start_at,
    source_synced_at: event.updated_at,
  }
}

/** 「このままにする」。中身は変えず、お知らせだけ消す */
export function acknowledgeOrigin(source: { updated_at: string }): { source_synced_at: string } {
  return { source_synced_at: source.updated_at }
}

/** 変換ダイアログの初期値に使う「今日の 9:00」 */
export function defaultStart(now = new Date()): Date {
  const date = new Date(now)
  date.setHours(9, 0, 0, 0)
  return date
}
