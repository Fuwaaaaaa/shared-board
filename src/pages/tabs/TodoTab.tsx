import { useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict, isToday, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from '../../components/Modal'
import CommentList from '../../components/CommentList'
import RecurrenceIntervalSelect from '../../components/RecurrenceIntervalSelect'
import NotificationBanner from '../../components/NotificationBanner'
import TagInput, { TagFilterBar } from '../../components/TagInput'
import { useNow } from '../../hooks/useReminders'
import { usePushNotifications } from '../../hooks/usePushNotifications'
import { useOptimisticTable } from '../../hooks/useOptimisticTable'
import { useNotice } from '../../hooks/useNotice'
import { useFocusJump } from '../../hooks/useFocusJump'
import { nextDueDate, normalizeRule, recurrenceLabel, ruleOf } from '../../lib/recurrence'
import { localDateOf, localDateTimeIso } from '../../lib/dates'
import {
  acknowledgeOrigin,
  buildEvent,
  buildTodo,
  originChanged,
  todoPatchFromEvent,
  todoPatchFromNote,
} from '../../lib/convert'
import { notifyUser } from '../../hooks/useNotifications'
import { buildNameLabels } from '../../lib/names'
import { supabase } from '../../lib/supabase'
import { useIdentity } from '../../lib/identity'
import { useRoomData } from '../../lib/roomData'
import {
  MONTH_WEEK_OPTIONS,
  RECURRENCE_LABELS,
  REMIND_OPTIONS,
  TODO_STATUS_LABELS,
  WEEKDAY_LABELS,
  type Recurrence,
  type Subtask,
  type Todo,
  type TodoStatus,
} from '../../lib/types'

type Bucket = 'overdue' | 'today' | 'soon' | 'later' | 'someday' | 'done'

const BUCKETS: { key: Bucket; label: string; accent: string }[] = [
  { key: 'overdue', label: '期限切れ', accent: 'text-rose-600' },
  { key: 'today', label: '今日', accent: 'text-amber-600' },
  { key: 'soon', label: '3日以内', accent: 'text-slate-700' },
  { key: 'later', label: 'それ以降', accent: 'text-slate-500' },
  { key: 'someday', label: '期限なし', accent: 'text-slate-500' },
  { key: 'done', label: '完了', accent: 'text-slate-400' },
]

interface Props {
  reminders: {
    supported: boolean
    permission: NotificationPermission
    requestPermission: () => void
  }
  focusId: string | null
  focusNonce: number
  /** 出自の付箋や、作った予定へ飛ぶ */
  onJump: (tab: 'board' | 'calendar', id: string | null) => void
}

export default function TodoTab({ reminders, focusId, focusNonce, onJump }: Props) {
  const { userId, displayName } = useIdentity()
  const { roomId, canEdit, todos, comments, approvedMembers, notes, events } = useRoomData()
  const now = useNow()
  const push = usePushNotifications()
  const [notice, setNotice] = useNotice()

  // 書き込みは 1 か所に寄せる。散らばっていたころは、失敗しても
  // 画面が黙って元に戻るだけで、理由が出なかった
  const todoOps = useOptimisticTable<Todo>('todos', todos, setNotice, { roomId, userId })

  const [title, setTitle] = useState('')
  const [editing, setEditing] = useState<Todo | null>(null)
  const [mineOnly, setMineOnly] = useState(false)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [view, setView] = useState<'list' | 'board'>('list')

  // 検索・更新タブから飛んできたやることを開く
  useFocusJump(focusId, focusNonce, todos.rows, (todo) => setEditing(todo))

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const comment of comments.rows) {
      if (comment.target_type !== 'todo' || !comment.target_id) continue
      counts[comment.target_id] = (counts[comment.target_id] ?? 0) + 1
    }
    return counts
  }, [comments.rows])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const todo of todos.rows) for (const tag of todo.tags ?? []) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [todos.rows])

  const visible = useMemo(() => {
    let list = todos.rows
    if (mineOnly) list = list.filter((t) => t.assignee_id === userId)
    if (tagFilter.length > 0) {
      list = list.filter((t) => tagFilter.every((tag) => (t.tags ?? []).includes(tag)))
    }
    return list
  }, [todos.rows, mineOnly, userId, tagFilter])

  // 担当の選択肢。同じ表示名の人がいるときだけ見分けをつける
  const memberOptions = useMemo(() => {
    const labels = buildNameLabels(approvedMembers, userId)
    return approvedMembers.map((m) => ({
      id: m.user_id,
      name: labels.get(m.user_id) ?? m.display_name,
    }))
  }, [approvedMembers, userId])

  const grouped = useMemo(() => groupByDue(visible, now), [visible, now])
  const mineCount = todos.rows.filter((t) => t.assignee_id === userId && !t.done).length

  async function addTodo(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return

    const todo = buildTodo({
      roomId,
      author: { userId, displayName },
      title: trimmed,
      tags: tagFilter,
    })

    setTitle('')
    await todoOps.insert([todo], 'やることの保存')
  }

  /** カンバンの列を移動する。完了列に入れたら done も立てる。 */
  async function setStatus(todo: Todo, status: TodoStatus, sortOrder?: number) {
    const patch: Partial<Todo> = {
      status,
      done: status === 'done',
      done_at: status === 'done' ? (todo.done_at ?? new Date().toISOString()) : null,
    }
    if (sortOrder !== undefined) patch.sort_order = sortOrder
    await patchTodo(todo, patch)

    if (status === 'done' && !todo.done) await spawnNextOccurrence(todo)
  }

  async function patchTodo(todo: Todo, patch: Partial<Todo>) {
    await todoOps.patch(todo.id, patch, { what: '保存' })
  }

  /**
   * 繰り返しタスクの次回分を作る。
   *
   * 同じ元から生まれた未完了の次回分は 1 件だけ（DB の部分一意インデックス todos_next_occurrence_uidx）。
   * 2 人が同時に完了にしても、片方の insert が 23505 で弾かれて二重にならない。
   */
  async function spawnNextOccurrence(todo: Todo) {
    if (todo.recurrence === 'none' || !todo.due_at) return
    // 既に次回分があれば作らない（前に完了 → 未完了に戻して、もう一度完了にした場合など）
    if (todos.rows.some((t) => t.source_todo_id === todo.id && !t.done)) return

    const next = nextDueDate(todo.due_at, ruleOf(todo))
    if (!next) return

    const repeated: Todo = {
      ...todo,
      id: crypto.randomUUID(),
      due_at: next,
      done: false,
      done_at: null,
      status: 'todo',
      sort_order: Date.now(),
      subtasks: (todo.subtasks ?? []).map((s) => ({ ...s, done: false })),
      source_todo_id: todo.id,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: new Date().toISOString(),
    }

    // 失敗（一意制約違反 23505 を含む）は「相手が先に作っただけ」なので、
    // 自分の分が引っ込むだけでよい
    await todoOps.insert([repeated], '次回分の保存')
  }

  /** 完了に切り替える。繰り返しタスクなら次回分を新しく作る。 */
  async function toggleDone(todo: Todo) {
    if (todo.done) {
      await patchTodo(todo, { done: false, done_at: null, status: 'todo' })
      return
    }

    await patchTodo(todo, { done: true, done_at: new Date().toISOString(), status: 'done' })
    await spawnNextOccurrence(todo)
  }

  /** ゴミ箱に入れる。30 日は「ボードの設定 → ゴミ箱」から戻せる。 */
  async function deleteTodo(id: string) {
    const current = todos.rows.find((t) => t.id === id)
    if (!current) return

    setEditing(null)
    await todoOps.patch(id, { deleted_at: new Date().toISOString() }, { what: '削除を保存' })
  }

  /**
   * やること → カレンダー。
   *
   * これは「その日までに終える」ものなので、予定ではなく締切として出す。
   * カレンダーでは終日欄に控えめに並び、通常の予定と見分けられる。
   */
  async function createEventFromTodo(todo: Todo) {
    const start = todo.due_at ?? new Date().toISOString()
    const event = buildEvent({
      roomId,
      author: { userId, displayName },
      kind: 'deadline',
      title: todo.title,
      description: todo.notes,
      startAt: start,
      allDay: true,
      remindMinutes: todo.remind_minutes,
      tags: todo.tags ?? [],
      sourceNoteId: todo.source_note_id,
    })

    events.upsertLocal(event)
    const { error } = await supabase.from('events').insert(event)
    if (error) {
      events.removeLocal(event.id)
      return
    }

    // 予定側からも、このやることをたどれるようにしておく
    await patchTodo(todo, { source_event_id: event.id })
    setEditing(null)
    onJump('calendar', event.id)
  }

  /**
   * もとの変更を取り込む。
   * 開いている編集画面は入力欄の値を自分で持っているので、いったん閉じて
   * 新しい内容の一覧に戻す（画面の値と保存された値がずれないようにする）。
   */
  async function applyOrigin(todo: Todo, patch: Partial<Todo>) {
    setEditing(null)
    await patchTodo(todo, patch)
  }

  /** 中身は変えず、「元が変わった」の印だけ消す */
  async function keepOrigin(todo: Todo, patch: Partial<Todo>) {
    setEditing({ ...todo, ...patch })
    await patchTodo(todo, patch)
  }

  /**
   * 編集中のやることが「どこから生まれたか」。
   *
   * もとが変わっていたら、反映するか・このままにするかを選べるようにする。
   * 勝手に上書きしないのは、共同編集では誰の変更で何が起きたのか分からなくなるため。
   */
  const origin = useMemo(() => {
    if (!editing) return null
    const target = editing

    if (target.source_note_id) {
      const note = notes.rows.find((n) => n.id === target.source_note_id)
      if (note) {
        return {
          icon: '🖍️',
          label: note.text.split('\n')[0]?.trim() || '（空の付箋）',
          changed: originChanged(target, note),
          onOpen: () => onJump('board', note.id),
          onApply: () => applyOrigin(target, todoPatchFromNote(note)),
          onKeep: () => keepOrigin(target, acknowledgeOrigin(note)),
        }
      }
    }

    if (target.source_event_id) {
      const event = events.rows.find((e) => e.id === target.source_event_id)
      if (event) {
        return {
          icon: '📅',
          label: event.title,
          changed: originChanged(target, event),
          onOpen: () => onJump('calendar', event.id),
          onApply: () => applyOrigin(target, todoPatchFromEvent(event)),
          onKeep: () => keepOrigin(target, acknowledgeOrigin(event)),
        }
      }
    }

    return null
    // patchTodo は毎回作られるが、中身は todos と supabase だけを見ている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, notes.rows, events.rows, onJump])

  return (
    <div className="h-full overflow-auto">
      {notice && (
        <div
          role="status"
          className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"
        >
          {notice}
        </div>
      )}
      <div className="mx-auto max-w-2xl p-3 sm:p-6">
        {canEdit && (
          <form onSubmit={addTodo} className="mb-4 flex gap-2">
            <input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="やること・忘れたくないことを入力"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-slate-800"
            />
            <button
              type="submit"
              disabled={!title.trim()}
              className="shrink-0 rounded-lg bg-slate-900 px-4 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
            >
              追加
            </button>
          </form>
        )}

        <div className="mb-4 space-y-3">
          <NotificationBanner
            supported={reminders.supported}
            permission={reminders.permission}
            onRequest={reminders.requestPermission}
            text="期限の前（15分前など）にブラウザ通知でお知らせできます。"
          />
          <PushSettings push={push} />
        </div>

        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setMineOnly(false)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                !mineOnly ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              すべて
            </button>
            <button
              type="button"
              onClick={() => setMineOnly(true)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                mineOnly ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              自分の担当{mineCount > 0 && `（${mineCount}）`}
            </button>

            <div className="ml-auto flex rounded-lg border border-slate-200 p-0.5">
              {(['list', 'board'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1 text-sm transition ${
                    view === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {v === 'list' ? '一覧' : 'カンバン'}
                </button>
              ))}
            </div>
          </div>

          <TagFilterBar
            allTags={allTags}
            selected={tagFilter}
            onToggle={(tag) =>
              setTagFilter((current) =>
                current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
              )
            }
            onClear={() => setTagFilter([])}
          />
        </div>

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
            {mineOnly || tagFilter.length > 0
              ? '条件に合うリマインドはありません。'
              : 'まだリマインドはありません。'}
          </p>
        ) : view === 'board' ? (
          <KanbanView
            todos={visible}
            now={now}
            canEdit={canEdit}
            commentCounts={commentCounts}
            onSetStatus={setStatus}
            onEdit={setEditing}
          />
        ) : (
          <div className="space-y-6">
            {BUCKETS.map(({ key, label, accent }) => {
              const list = grouped[key]
              if (list.length === 0) return null
              return (
                <section key={key}>
                  <h3 className={`mb-2 text-xs font-bold tracking-wide ${accent}`}>
                    {label}（{list.length}）
                  </h3>
                  <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    {list.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        now={now}
                        canEdit={canEdit}
                        commentCount={commentCounts[todo.id] ?? 0}
                        highlighted={focusId === todo.id}
                        onToggle={() => toggleDone(todo)}
                        onEdit={() => setEditing(todo)}
                      />
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>

      {editing && (
        <TodoModal
          todo={editing}
          canEdit={canEdit}
          allTags={allTags}
          members={memberOptions}
          commentCount={commentCounts[editing.id] ?? 0}
          origin={origin}
          onCreateEvent={() => createEventFromTodo(editing)}
          onSave={async (patch) => {
            const before = editing.assignee_id
            await patchTodo(editing, patch)

            // 新しく担当になった人に知らせる（自分で自分を選んだときは送らない）
            if (
              patch.assignee_id &&
              patch.assignee_id !== before &&
              patch.assignee_id !== userId
            ) {
              await notifyUser({
                roomId,
                userId: patch.assignee_id,
                kind: 'assigned',
                body: `「${patch.title ?? editing.title}」の担当になりました`,
                linkTab: 'todo',
                linkId: editing.id,
              })
            }
            setEditing(null)
          }}
          onDelete={() => deleteTodo(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/**
 * カンバン表示。列の間をドラッグで移動でき、同じ列の中では手動で並べ替えられる。
 * 並び順は sort_order（数値）で持ち、落とした位置の前後の中間値を入れる。
 */
function KanbanView({
  todos,
  now,
  canEdit,
  commentCounts,
  onSetStatus,
  onEdit,
}: {
  todos: Todo[]
  now: Date
  canEdit: boolean
  commentCounts: Record<string, number>
  onSetStatus: (todo: Todo, status: TodoStatus, sortOrder?: number) => void
  onEdit: (todo: Todo) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<TodoStatus | null>(null)

  const columns = useMemo(() => {
    const map: Record<TodoStatus, Todo[]> = { todo: [], doing: [], done: [] }
    for (const todo of todos) {
      const status: TodoStatus = todo.done ? 'done' : (todo.status ?? 'todo')
      map[status].push(todo)
    }
    for (const key of Object.keys(map) as TodoStatus[]) {
      map[key].sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          (a.due_at ?? '').localeCompare(b.due_at ?? ''),
      )
    }
    return map
  }, [todos])

  /** 落とした位置に合わせた sort_order を計算する */
  function orderFor(list: Todo[], index: number): number {
    const before = list[index - 1]?.sort_order ?? 0
    const after = list[index]?.sort_order
    if (after === undefined) return before + 1000
    return (before + after) / 2
  }

  function handleDrop(status: TodoStatus, index: number) {
    const todo = todos.find((t) => t.id === dragId)
    setDragId(null)
    setOverColumn(null)
    if (!todo || !canEdit) return

    const list = columns[status].filter((t) => t.id !== todo.id)
    onSetStatus(todo, status, orderFor(list, index))
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {(Object.keys(TODO_STATUS_LABELS) as TodoStatus[]).map((status) => (
        <section
          key={status}
          onDragOver={(e) => {
            if (!dragId) return
            e.preventDefault()
            setOverColumn(status)
          }}
          onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
          onDrop={(e) => {
            e.preventDefault()
            handleDrop(status, columns[status].length)
          }}
          className={`rounded-xl border p-2 transition ${
            overColumn === status ? 'border-slate-900 bg-slate-100' : 'border-slate-200 bg-slate-50'
          }`}
        >
          <h3 className="mb-2 px-1 text-xs font-bold tracking-wide text-slate-500">
            {TODO_STATUS_LABELS[status]}（{columns[status].length}）
          </h3>

          <ul className="min-h-16 space-y-2">
            {columns[status].map((todo, index) => {
              const due = todo.due_at ? parseISO(todo.due_at) : null
              const overdue = due !== null && !todo.done && due.getTime() <= now.getTime()
              const subtasks = todo.subtasks ?? []

              return (
                <li
                  key={todo.id}
                  draggable={canEdit}
                  onDragStart={() => setDragId(todo.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => dragId && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleDrop(status, index)
                  }}
                  className={`rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition ${
                    canEdit ? 'cursor-grab' : ''
                  } ${dragId === todo.id ? 'opacity-40' : ''}`}
                >
                  <button type="button" onClick={() => onEdit(todo)} className="w-full text-left">
                    <span
                      className={`block text-sm ${
                        todo.done ? 'text-slate-400 line-through' : 'text-slate-800'
                      }`}
                    >
                      {todo.recurrence !== 'none' && (
            <span className="mr-1" title={recurrenceLabel(ruleOf(todo))}>
              🔁
            </span>
          )}
                      {todo.title}
                    </span>

                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {due && (
                        <span className={overdue ? 'font-medium text-rose-600' : 'text-slate-500'}>
                          🕒 {format(due, 'M/d HH:mm')}
                        </span>
                      )}
                      {todo.assignee_name && (
                        <span className="rounded bg-slate-100 px-1.5 text-slate-600">
                          {todo.assignee_name}
                        </span>
                      )}
                      {subtasks.length > 0 && (
                        <span className="text-slate-500">
                          ☑ {subtasks.filter((s) => s.done).length}/{subtasks.length}
                        </span>
                      )}
                      {(commentCounts[todo.id] ?? 0) > 0 && (
                        <span className="text-slate-400">💬 {commentCounts[todo.id]}</span>
                      )}
                      {(todo.tags ?? []).slice(0, 2).map((tag) => (
                        <span key={tag} className="rounded bg-slate-100 px-1.5 text-slate-500">
                          #{tag}
                        </span>
                      ))}
                    </span>
                  </button>

                  {canEdit && (
                    <div className="mt-2 flex gap-1">
                      {(Object.keys(TODO_STATUS_LABELS) as TodoStatus[])
                        .filter((s) => s !== status)
                        .map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => onSetStatus(todo, s)}
                            className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-50"
                          >
                            → {TODO_STATUS_LABELS[s]}
                          </button>
                        ))}
                    </div>
                  )}
                </li>
              )
            })}

            {columns[status].length === 0 && (
              <li className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-xs text-slate-400">
                ここにドラッグ
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** タブを閉じていても届く通知の設定 */
function PushSettings({ push }: { push: ReturnType<typeof usePushNotifications> }) {
  if (push.state === 'unsupported') return null

  if (push.state === 'not-configured') {
    return (
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-400">
        タブを閉じていても届くプッシュ通知は、まだ設定されていません（管理者向け:
        docs/SETUP.md の「プッシュ通知」を参照）。
      </p>
    )
  }

  if (push.state === 'ios-needs-install') {
    return (
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs leading-relaxed text-slate-500">
        📲 iPhone / iPad では、Safari の共有ボタン →「ホーム画面に追加」で置いたアイコンから開くと、
        タブを閉じていても通知を受け取れます（iOS 16.4 以降）。
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="min-w-0 flex-1 text-sm text-slate-600">
        {push.state === 'on'
          ? '✅ このブラウザはタブを閉じていても通知を受け取ります。'
          : 'タブを閉じていても通知を受け取れます。'}
      </p>

      {push.state === 'denied' ? (
        <span className="text-xs text-slate-400">通知はブラウザ側でブロックされています</span>
      ) : (
        <button
          type="button"
          disabled={push.state === 'working'}
          onClick={() => (push.state === 'on' ? void push.disable() : void push.enable())}
          className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition disabled:opacity-50 ${
            push.state === 'on'
              ? 'border border-slate-300 text-slate-700 hover:bg-slate-50'
              : 'bg-slate-900 font-medium text-white hover:bg-slate-700'
          }`}
        >
          {push.state === 'working' ? '設定中…' : push.state === 'on' ? '解除する' : '📲 受け取る'}
        </button>
      )}

      {push.error && <p className="w-full text-xs text-rose-600">{push.error}</p>}
    </div>
  )
}

function TodoRow({
  todo,
  now,
  canEdit,
  commentCount,
  highlighted,
  onToggle,
  onEdit,
}: {
  todo: Todo
  now: Date
  canEdit: boolean
  commentCount: number
  highlighted: boolean
  onToggle: () => void
  onEdit: () => void
}) {
  const due = todo.due_at ? parseISO(todo.due_at) : null
  const overdue = due !== null && !todo.done && due.getTime() <= now.getTime()
  const subtasks = todo.subtasks ?? []
  const doneSubtasks = subtasks.filter((s) => s.done).length

  return (
    <li
      className={`flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50 ${
        highlighted ? 'bg-amber-50' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={todo.done}
        disabled={!canEdit}
        onChange={onToggle}
        className="h-4.5 w-4.5 shrink-0 accent-slate-900 disabled:opacity-50"
      />

      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span
          className={`block truncate ${
            todo.done ? 'text-slate-400 line-through' : 'text-slate-800'
          }`}
        >
          {todo.recurrence !== 'none' && (
            <span className="mr-1" title={recurrenceLabel(ruleOf(todo))}>
              🔁
            </span>
          )}
          {todo.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
          {due && (
            <span className={overdue ? 'font-medium text-rose-600' : 'text-slate-500'}>
              🕒 {format(due, 'M/d(E) HH:mm', { locale: ja })}
              {!todo.done && (
                <span className="ml-1 text-slate-400">
                  (
                  {overdue
                    ? `${formatDistanceToNowStrict(due, { locale: ja })}超過`
                    : `あと${formatDistanceToNowStrict(due, { locale: ja })}`}
                  )
                </span>
              )}
            </span>
          )}
          {todo.assignee_name && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
              👤 {todo.assignee_name}
            </span>
          )}
          {(todo.tags ?? []).map((tag) => (
            <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
              #{tag}
            </span>
          ))}
          {subtasks.length > 0 && (
            <span className="text-slate-500">
              ☑ {doneSubtasks}/{subtasks.length}
            </span>
          )}
          {commentCount > 0 && <span className="text-slate-400">💬 {commentCount}</span>}
          {todo.notes && <span className="truncate text-slate-400">📝 {todo.notes}</span>}
        </span>
      </button>
    </li>
  )
}

/**
 * 繰り返しの曜日を選ぶところ（カレンダー側の RecurrenceFields と同じ考え方）。
 *
 * 毎週は曜日を複数、毎月は「日付で / 曜日で」。曜日そのものは期限の日付から
 * 決まるので読むだけにする（選ばせると期限と食い違う）。
 */
function TodoRecurrenceFields({
  date,
  recurrence,
  days,
  week,
  onDaysChange,
  onWeekChange,
}: {
  date: string
  recurrence: Recurrence
  days: number[]
  week: number | null
  onDaysChange: (days: number[]) => void
  onWeekChange: (week: number | null, days: number[]) => void
}) {
  if (recurrence !== 'weekly' && recurrence !== 'monthly') return null

  const startWeekday = localDateOf(date).getDay()

  if (recurrence === 'weekly') {
    const toggle = (day: number) => {
      onDaysChange(
        days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b),
      )
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">曜日</span>
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map((label, day) => {
            const on = days.includes(day)
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(day)}
                className={`h-7 w-7 rounded-lg border text-xs transition ${
                  on
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
        {days.length === 0 && (
          <span className="text-xs text-slate-400">
            選ばなければ、期限と同じ {WEEKDAY_LABELS[startWeekday]}曜だけ
          </span>
        )}
      </div>
    )
  }

  const byWeekday = week !== null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500">毎月</span>
      <div className="flex gap-1">
        <button
          type="button"
          aria-pressed={!byWeekday}
          onClick={() => onWeekChange(null, [])}
          className={`rounded-lg border px-2.5 py-1 text-xs transition ${
            !byWeekday
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          日付で
        </button>
        <button
          type="button"
          aria-pressed={byWeekday}
          onClick={() => onWeekChange(1, [startWeekday])}
          className={`rounded-lg border px-2.5 py-1 text-xs transition ${
            byWeekday
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          曜日で
        </button>
      </div>
      {byWeekday && (
        <>
          <select
            value={String(week)}
            onChange={(e) => onWeekChange(Number(e.target.value), [startWeekday])}
            aria-label="第何週か"
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-800"
          >
            {MONTH_WEEK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-600">{WEEKDAY_LABELS[startWeekday]}曜</span>
        </>
      )}
    </div>
  )
}

function TodoModal({
  todo,
  canEdit,
  allTags,
  members,
  commentCount,
  origin,
  onCreateEvent,
  onSave,
  onDelete,
  onClose,
}: {
  todo: Todo
  canEdit: boolean
  allTags: string[]
  members: { id: string; name: string }[]
  commentCount: number
  /** このやることが生まれたもと（付箋 or 予定） */
  origin: {
    icon: string
    label: string
    /** もとが、取り込んだあとに変わっているか */
    changed: boolean
    onOpen: () => void
    onApply: () => Promise<void>
    onKeep: () => Promise<void>
  } | null
  onCreateEvent: () => void
  onSave: (patch: Partial<Todo>) => Promise<void>
  onDelete: () => void
  onClose: () => void
}) {
  const due = todo.due_at ? parseISO(todo.due_at) : null

  const [title, setTitle] = useState(todo.title)
  const [notes, setNotes] = useState(todo.notes)
  const [assigneeId, setAssigneeId] = useState(todo.assignee_id ?? '')
  const [date, setDate] = useState(due ? format(due, 'yyyy-MM-dd') : '')
  const [time, setTime] = useState(due ? format(due, 'HH:mm') : '09:00')
  const [remind, setRemind] = useState<number | null>(todo.remind_minutes)
  const [recurrence, setRecurrence] = useState<Recurrence>(todo.recurrence ?? 'none')
  const [recurrenceDays, setRecurrenceDays] = useState<number[]>(todo.recurrence_days ?? [])
  const [recurrenceWeek, setRecurrenceWeek] = useState<number | null>(
    todo.recurrence_week ?? null,
  )
  const [recurrenceInterval, setRecurrenceInterval] = useState(todo.recurrence_interval ?? 1)
  const [subtasks, setSubtasks] = useState<Subtask[]>(todo.subtasks ?? [])
  const [tags, setTags] = useState<string[]>(todo.tags ?? [])
  const [subtaskDraft, setSubtaskDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [showComments, setShowComments] = useState(false)

  async function submit() {
    if (!title.trim() || saving) return
    setSaving(true)

    const assignee = members.find((m) => m.id === assigneeId)

    // 規則に合わない組み合わせは落としてから保存する（DB にも同じ CHECK がある）
    const rule = normalizeRule({
      recurrence: date ? recurrence : 'none',
      days: recurrenceDays,
      week: recurrenceWeek,
      interval: recurrenceInterval,
    })

    await onSave({
      title: title.trim(),
      notes: notes.trim(),
      assignee_id: assigneeId || null,
      assignee_name: assignee?.name ?? '',
      // 入力欄はローカル時刻で埋めている（上の useState）ので、読むのもローカル。
      // 時刻を消していたら、既定の 9:00 にする
      due_at: date ? localDateTimeIso(date, time || '09:00') : null,
      remind_minutes: date ? remind : null,
      recurrence: rule.recurrence,
      recurrence_days: rule.days,
      recurrence_week: rule.week,
      recurrence_interval: rule.interval ?? 1,
      subtasks,
      tags,
    })
    setSaving(false)
  }

  function addSubtask() {
    const trimmed = subtaskDraft.trim()
    if (!trimmed) return
    setSubtasks((current) => [...current, { id: crypto.randomUUID(), title: trimmed, done: false }])
    setSubtaskDraft('')
  }

  return (
    <Modal
      title={canEdit ? 'リマインドを編集' : 'リマインド'}
      onClose={onClose}
      footer={
        canEdit ? (
          <>
            <button
              type="button"
              onClick={onDelete}
              className="mr-auto rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
            >
              削除
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!title.trim() || saving}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
            >
              保存
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            閉じる
          </button>
        )
      }
    >
      {origin && (
        <div className="mb-4 space-y-2">
          <button
            type="button"
            onClick={origin.onOpen}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 transition hover:border-slate-400"
          >
            <span className="shrink-0">{origin.icon}</span>
            <span className="min-w-0 flex-1 truncate">
              ここから生まれました：{origin.label}
            </span>
            <span className="shrink-0 text-slate-400">→</span>
          </button>

          {origin.changed && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p>
                元が変更されています。ここは自動では変わりません。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={origin.onOpen}
                  className="rounded-lg border border-amber-300 px-2.5 py-1 transition hover:bg-amber-100"
                >
                  変更を見る
                </button>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => void origin.onApply()}
                      className="rounded-lg bg-amber-900 px-2.5 py-1 font-medium text-white transition hover:bg-amber-800"
                    >
                      反映する
                    </button>
                    <button
                      type="button"
                      onClick={() => void origin.onKeep()}
                      className="rounded-lg border border-amber-300 px-2.5 py-1 transition hover:bg-amber-100"
                    >
                      このままにする
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <fieldset disabled={!canEdit} className="space-y-4">
        <input
          autoFocus
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800 disabled:bg-slate-50"
        />

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">期限</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                const value = e.target.value
                setDate(value)
                if (value && !date && remind === null) setRemind(0)
                // 「毎月 第 n 曜日」の曜日は期限から決まる。日付を変えたら付いてこないと、
                // 画面に出ている曜日と保存される曜日がずれる
                if (value && recurrenceWeek !== null) {
                  setRecurrenceDays([localDateOf(value).getDay()])
                }
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
            />
            <input
              type="time"
              value={time}
              disabled={!date || !canEdit}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50 disabled:text-slate-400"
            />
            {date && (
              <button
                type="button"
                onClick={() => setDate('')}
                className="text-sm text-slate-400 transition hover:text-slate-700"
              >
                期限をなくす
              </button>
            )}
          </div>
        </div>

        {date && (
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              通知
              <select
                value={remind === null ? '' : String(remind)}
                onChange={(e) => setRemind(e.target.value === '' ? null : Number(e.target.value))}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
              >
                {REMIND_OPTIONS.map((option) => (
                  <option
                    key={String(option.value)}
                    value={option.value === null ? '' : option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-600">
              繰り返し
              <select
                value={recurrence}
                onChange={(e) => {
                  setRecurrence(e.target.value as Recurrence)
                  // 選べる間隔は周期ごとに違うので、選択肢に無い値が残らないよう戻す
                  setRecurrenceInterval(1)
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
              >
                {Object.entries(RECURRENCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <RecurrenceIntervalSelect
                recurrence={recurrence}
                interval={recurrenceInterval}
                onChange={setRecurrenceInterval}
              />
            </label>
          </div>
        )}

        {recurrence !== 'none' && date && (
          <div className="flex flex-col gap-2 rounded-lg bg-slate-50 px-3 py-2">
            <TodoRecurrenceFields
              date={date}
              recurrence={recurrence}
              days={recurrenceDays}
              week={recurrenceWeek}
              onDaysChange={setRecurrenceDays}
              onWeekChange={(week, days) => {
                setRecurrenceWeek(week)
                setRecurrenceDays(days)
              }}
            />
            <p className="text-xs text-slate-600">
              完了にすると、
              {recurrenceLabel(
                normalizeRule({
                  recurrence,
                  days: recurrenceDays,
                  week: recurrenceWeek,
                  interval: recurrenceInterval,
                }),
              )}
              の次回分が自動で作られます。
            </p>
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">担当</label>
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
          >
            <option value="">未割り当て</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name || '名前なし'}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">タグ</span>
          <TagInput tags={tags} suggestions={allTags} disabled={!canEdit} onChange={setTags} />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">
            サブタスク
            {subtasks.length > 0 &&
              `（${subtasks.filter((s) => s.done).length}/${subtasks.length}）`}
          </label>
          <ul className="mb-2 space-y-1">
            {subtasks.map((subtask) => (
              <li key={subtask.id} className="group flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={subtask.done}
                  onChange={() =>
                    setSubtasks((current) =>
                      current.map((s) => (s.id === subtask.id ? { ...s, done: !s.done } : s)),
                    )
                  }
                  className="h-4 w-4 shrink-0 accent-slate-900"
                />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    subtask.done ? 'text-slate-400 line-through' : 'text-slate-700'
                  }`}
                >
                  {subtask.title}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSubtasks((current) => current.filter((s) => s.id !== subtask.id))
                  }
                  className="shrink-0 text-xs text-slate-300 transition group-hover:text-rose-600"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              value={subtaskDraft}
              maxLength={100}
              onChange={(e) => setSubtaskDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addSubtask()
                }
              }}
              placeholder="小項目を追加"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
            />
            <button
              type="button"
              onClick={addSubtask}
              disabled={!subtaskDraft.trim()}
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              追加
            </button>
          </div>
        </div>

        <textarea
          value={notes}
          maxLength={500}
          rows={3}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="メモ（任意）"
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
        />
      </fieldset>

      {canEdit && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onCreateEvent}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            ⏰ カレンダーに締切として出す
          </button>
          <p className="mt-1 text-xs text-slate-400">
            その日の終日欄に「⏰ {title || todo.title} 〆」として並びます。集まる予定を作りたいときは、
            カレンダーから追加してください。
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={() => setShowComments((open) => !open)}
          className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          💬 コメント{commentCount > 0 && `（${commentCount}）`} {showComments ? '▲' : '▼'}
        </button>
        {showComments && (
          <div className="mt-3">
            <CommentList
              targetType="todo"
              targetId={todo.id}
              placeholder="このリマインドへのコメント"
            />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">作成者: {todo.author_name || '不明'}</p>
      </div>
    </Modal>
  )
}

function groupByDue(todos: Todo[], now: Date): Record<Bucket, Todo[]> {
  const result: Record<Bucket, Todo[]> = {
    overdue: [],
    today: [],
    soon: [],
    later: [],
    someday: [],
    done: [],
  }

  const threeDaysLater = new Date(now)
  threeDaysLater.setDate(threeDaysLater.getDate() + 3)

  for (const todo of todos) {
    if (todo.done) {
      result.done.push(todo)
      continue
    }
    if (!todo.due_at) {
      result.someday.push(todo)
      continue
    }

    const due = parseISO(todo.due_at)
    if (due.getTime() <= now.getTime()) result.overdue.push(todo)
    else if (isToday(due)) result.today.push(todo)
    else if (due <= threeDaysLater) result.soon.push(todo)
    else result.later.push(todo)
  }

  const byDue = (a: Todo, b: Todo) => (a.due_at ?? '').localeCompare(b.due_at ?? '')
  result.overdue.sort(byDue)
  result.today.sort(byDue)
  result.soon.sort(byDue)
  result.later.sort(byDue)
  result.someday.sort((a, b) => b.created_at.localeCompare(a.created_at))
  result.done.sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''))

  return result
}
