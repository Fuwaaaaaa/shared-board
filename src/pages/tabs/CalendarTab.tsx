import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInMinutes,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from '../../components/Modal'
import CommentList from '../../components/CommentList'
import NotificationBanner from '../../components/NotificationBanner'
import TagInput, { TagFilterBar } from '../../components/TagInput'
import {
  expandOccurrences,
  firstMatchingStart,
  groupOccurrencesByDay,
  normalizeRule,
  occurrenceKey,
  recurrenceLabel,
  ruleOf,
  type RecurrenceRule,
} from '../../lib/recurrence'
import { getHolidayName } from '../../lib/holidays'
import {
  allDayEndIso,
  allDayStartIso,
  boardDateTimeIso,
  localDateOf,
  occurrenceKeyDate,
  toBoardDate,
} from '../../lib/dates'
import {
  acknowledgeOrigin,
  eventPatchFromNote,
  originChanged,
  todoFromEvent,
} from '../../lib/convert'
import { useCalendarFeeds } from '../../hooks/useCalendarFeeds'
import FeedSettingsModal from '../../components/FeedSettingsModal'
import type { FeedEvent } from '../../lib/icsParse'
import { buildIcs, downloadText } from '../../lib/ics'
import { supabase } from '../../lib/supabase'
import { useIdentity } from '../../lib/identity'
import { useRoomData } from '../../lib/roomData'
import { HOUR_HEIGHT, dragDeltaMs } from '../../lib/calendarGrid'
import {
  EVENT_COLORS,
  EVENT_KIND_LABELS,
  MONTH_WEEK_OPTIONS,
  RECURRENCE_LABELS,
  REMIND_OPTIONS,
  WEEKDAY_LABELS,
  type CalendarEvent,
  type EventKind,
  type EventOccurrence,
  type EventOverride,
  type Recurrence,
  type Todo,
} from '../../lib/types'

/** 繰り返し予定の編集・削除を「その回だけ」に効かせるか、「すべての回」に効かせるか */
type EditScope = 'occurrence' | 'all'

// 曜日の名前は types.ts に 1 か所だけ置く（繰り返しの曜日選びと同じものを使う）
const WEEKDAYS = WEEKDAY_LABELS
const WEEK_START_KEY = 'board.weekStart'

type View = 'month' | 'week' | 'day' | 'list'
type WeekStart = 0 | 1

interface Props {
  reminders: {
    supported: boolean
    permission: NotificationPermission
    requestPermission: () => void
  }
  focusId: string | null
  focusNonce: number
  boardName: string
  /** 出自の付箋へ飛ぶ */
  onJump: (tab: 'board' | 'todo', id: string | null) => void
}

export default function CalendarTab({
  reminders,
  focusId,
  focusNonce,
  boardName,
  onJump,
}: Props) {
  const { userId, displayName } = useIdentity()
  const { roomId, canEdit, events, todos, overrides, comments, feeds, notes } = useRoomData()

  const [view, setView] = useState<View>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [editing, setEditing] = useState<EventOccurrence | null>(null)
  const [creatingOn, setCreatingOn] = useState<Date | null>(null)
  const [showTodos, setShowTodos] = useState(true)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [showFeeds, setShowFeeds] = useState(false)
  const [weekStart, setWeekStart] = useState<WeekStart>(
    () => (localStorage.getItem(WEEK_START_KEY) === '1' ? 1 : 0),
  )

  const weekOptions = useMemo(() => ({ weekStartsOn: weekStart }) as const, [weekStart])

  function changeWeekStart(value: WeekStart) {
    localStorage.setItem(WEEK_START_KEY, String(value))
    setWeekStart(value)
  }

  // 横断検索や通知からのジャンプ。回の情報がないので、これからの回を 1 つ選んで開く
  useEffect(() => {
    if (!focusId) return
    const event = events.rows.find((e) => e.id === focusId)
    if (!event) return

    const now = new Date()
    const next =
      expandOccurrences([event], now, addDays(now, 365), overrides.rows)[0] ??
      expandOccurrences([event], parseISO(event.start_at), addDays(now, 365), overrides.rows)[0]

    setCursor(next ? next.start : parseISO(event.start_at))
    setEditing(next ?? baseOccurrence(event))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce, events.rows])

  const range = useMemo(() => {
    if (view === 'day') return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) }
    if (view === 'week') {
      return { start: startOfWeek(cursor, weekOptions), end: endOfWeek(cursor, weekOptions) }
    }
    if (view === 'list') return { start: startOfDay(cursor), end: addDays(cursor, 90) }
    return {
      start: startOfWeek(startOfMonth(cursor), weekOptions),
      end: endOfWeek(endOfMonth(cursor), weekOptions),
    }
  }, [view, cursor, weekOptions])

  // 外部カレンダー（読み取り専用で重ねて表示する）
  const feedState = useCalendarFeeds(feeds.rows, range.start, range.end)

  const feedsByDay = useMemo(() => {
    const map = new Map<string, FeedEvent[]>()
    for (const event of feedState.events) {
      const key = format(event.start, 'yyyy-MM-dd')
      const list = map.get(key)
      if (list) list.push(event)
      else map.set(key, [event])
    }
    return map
  }, [feedState.events])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const event of events.rows) for (const tag of event.tags ?? []) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [events.rows])

  const filteredEvents = useMemo(
    () =>
      tagFilter.length === 0
        ? events.rows
        : events.rows.filter((e) => tagFilter.every((tag) => (e.tags ?? []).includes(tag))),
    [events.rows, tagFilter],
  )

  const occurrences = useMemo(
    () => expandOccurrences(filteredEvents, range.start, range.end, overrides.rows),
    [filteredEvents, range.start, range.end, overrides.rows],
  )
  const byDay = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences])

  /**
   * カレンダーに重ねて表示する期限つき TODO。
   *
   * 「カレンダーに締切として出す」を使ったやることは、すでに締切として並んでいる。
   * 重ねると同じものが 2 つ出て「二重に登録された」と見えるので、そちらは外す。
   */
  const todosByDay = useMemo(() => {
    const map = new Map<string, Todo[]>()
    if (!showTodos) return map

    const deadlineIds = new Set(
      events.rows.filter((e) => e.kind === 'deadline').map((e) => e.id),
    )

    for (const todo of todos.rows) {
      if (!todo.due_at) continue
      if (todo.source_event_id && deadlineIds.has(todo.source_event_id)) continue
      const key = format(parseISO(todo.due_at), 'yyyy-MM-dd')
      const list = map.get(key)
      if (list) list.push(todo)
      else map.set(key, [todo])
    }
    return map
  }, [todos.rows, events.rows, showTodos])

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const comment of comments.rows) {
      if (comment.target_type !== 'event' || !comment.target_id) continue
      counts[comment.target_id] = (counts[comment.target_id] ?? 0) + 1
    }
    return counts
  }, [comments.rows])

  /**
   * 「この回だけ」の変更を例外テーブルに書く。
   *
   * 同じ回に既に例外があればその行を上書きする。楽観的更新が効くよう、
   * 既存行の id を引き継いでから upsert する。
   */
  async function saveOverride(
    occurrence: EventOccurrence,
    patch: Partial<EventOverride> & { canceled: boolean },
  ) {
    const occurrenceDate = occurrenceKeyDate(occurrence.originalStart)
    const existing = overrides.rows.find(
      (o) => o.event_id === occurrence.event.id && o.occurrence_date === occurrenceDate,
    )

    const row: EventOverride = {
      id: existing?.id ?? crypto.randomUUID(),
      room_id: roomId,
      event_id: occurrence.event.id,
      occurrence_date: occurrenceDate,
      title: null,
      description: null,
      start_at: null,
      end_at: null,
      all_day: null,
      color: null,
      remind_minutes: null,
      tags: null,
      author_id: userId,
      author_name: displayName,
      created_at: existing?.created_at ?? new Date().toISOString(),
      ...patch,
    }

    overrides.upsertLocal(row)
    const { error } = await supabase
      .from('event_overrides')
      .upsert(row, { onConflict: 'event_id,occurrence_date' })

    if (error) {
      if (existing) overrides.upsertLocal(existing)
      else overrides.removeLocal(row.id)
    }
  }

  async function saveEvent(
    draft: EventDraft,
    occurrence: EventOccurrence | null,
    scope: EditScope,
  ) {
    // 保存する時刻はボードの暦（JST）で解釈する。閲覧者のタイムゾーンには依存しない
    const start = draft.allDay
      ? allDayStartIso(draft.date)
      : boardDateTimeIso(draft.date, draft.time)
    const end = draft.hasEnd
      ? draft.allDay
        ? allDayEndIso(draft.endDate)
        : boardDateTimeIso(draft.endDate, draft.endTime)
      : null

    // 繰り返しの 1 回分だけを変える。
    // 繰り返しなしの予定に例外を書いても展開時に読まれないので、そのときは通常の更新に落とす。
    if (occurrence && scope === 'occurrence' && occurrence.event.recurrence !== 'none') {
      await saveOverride(occurrence, {
        canceled: false,
        title: draft.title,
        description: draft.description,
        start_at: start,
        end_at: end,
        all_day: draft.allDay,
        color: draft.color,
        remind_minutes: draft.remind,
        tags: draft.tags,
      })
      setEditing(null)
      setCreatingOn(null)
      return
    }

    /*
     * 規則に合わない組み合わせ（毎日なのに曜日つき、など）は落としてから保存する。
     * DB にも同じ CHECK があるので、ここは押してから断られるのを避けるためのもの。
     * 決まりを変えるときは supabase/schema.sql も一緒に変えること。
     */
    const rule = normalizeRule({
      recurrence: draft.recurrence,
      days: draft.recurrenceDays,
      week: draft.recurrenceWeek,
    })

    /*
     * 曜日を選んだときは、規則に合う最初の日へ開始を寄せる（RFC 5545）。
     * 寄せないと、金曜の予定に「毎週 火」を選んだとき、取り込み先で
     * 金曜の回が 1 つだけ余分に出る。
     * 終了は同じぶんだけ動かして、予定の長さを保つ。
     */
    const snappedStart = firstMatchingStart(start, rule)
    const shiftMs = new Date(snappedStart).getTime() - new Date(start).getTime()
    const snappedEnd =
      end && shiftMs !== 0 ? new Date(new Date(end).getTime() + shiftMs).toISOString() : end

    const patch = {
      kind: draft.kind,
      title: draft.title,
      description: draft.description,
      start_at: snappedStart,
      end_at: snappedEnd,
      all_day: draft.allDay,
      color: draft.color,
      recurrence: rule.recurrence,
      recurrence_days: rule.days,
      recurrence_week: rule.week,
      recurrence_until: rule.recurrence === 'none' ? null : draft.recurrenceUntil || null,
      remind_minutes: draft.remind,
      tags: draft.tags,
    }

    if (occurrence) {
      const existing = occurrence.event

      /*
       * 開始日や繰り返し方を変えると回の並びがずれ、例外の対応づけが崩れる。
       * 時刻だけの変更なら日付キーは動かないのでそのまま残す。
       *
       * 曜日は「減らした・入れ替えた」ときだけ崩れたとみなす。増やすのは
       * 加算的で、それまでに出ていた回はすべてそのまま残るため、
       * 火曜に木曜を足しただけで火曜の「この回だけ」を消すのは理不尽になる。
       */
      const before = ruleOf(existing)
      const daysRemoved = before.days.some((d) => !rule.days.includes(d))

      const gridMoved =
        toBoardDate(patch.start_at) !== toBoardDate(existing.start_at) ||
        draft.recurrence !== existing.recurrence ||
        (patch.recurrence_until ?? null) !== (existing.recurrence_until ?? null) ||
        rule.week !== before.week ||
        daysRemoved

      const mine = overrides.rows.filter((o) => o.event_id === existing.id)
      if (gridMoved && mine.length > 0) {
        const ok = window.confirm(
          `この予定には「この回だけ」の変更が ${mine.length} 件あります。\n` +
            'すべての回を変更すると、それらは取り消されます。よろしいですか？',
        )
        if (!ok) return

        for (const override of mine) overrides.removeLocal(override.id)
        await supabase.from('event_overrides').delete().eq('event_id', existing.id)
      }

      events.upsertLocal({ ...existing, ...patch })
      await supabase.from('events').update(patch).eq('id', existing.id)
    } else {
      const now = new Date().toISOString()
      const event: CalendarEvent = {
        id: crypto.randomUUID(),
        room_id: roomId,
        ...patch,
        source_note_id: null,
        source_synced_at: null,
        deleted_at: null,
        author_id: userId,
        author_name: displayName,
        created_at: now,
        updated_at: now,
      }
      events.upsertLocal(event)
      const { error } = await supabase.from('events').insert(event)
      if (error) events.removeLocal(event.id)
    }

    setEditing(null)
    setCreatingOn(null)
  }

  /**
   * すべての回をゴミ箱に入れる。
   * 「この回だけ」の例外は残しておき、戻したときにそのまま復元されるようにする。
   */
  async function deleteEvent(id: string) {
    const current = events.rows.find((e) => e.id === id)
    if (!current) return

    const at = new Date().toISOString()
    events.upsertLocal({ ...current, deleted_at: at })
    setEditing(null)

    const { error } = await supabase.from('events').update({ deleted_at: at }).eq('id', id)
    if (error) events.upsertLocal(current)
  }

  /** その回だけ削除する */
  async function cancelOccurrence(occurrence: EventOccurrence) {
    setEditing(null)
    await saveOverride(occurrence, { canceled: true })
  }

  /** ドラッグで予定の日時を動かす。繰り返しの場合はその回だけ動かす */
  async function shiftEvent(occurrence: EventOccurrence, deltaMs: number) {
    if (!canEdit || deltaMs === 0) return

    const start = new Date(occurrence.start.getTime() + deltaMs)
    const end = occurrence.end ? new Date(occurrence.end.getTime() + deltaMs) : null

    // 終日予定は「動かした先の日付」を JST の 0:00〜23:59 に置き直す
    // （海外から見ていると occurrence.start がローカルの 0:00 に置き直されているため）
    const allDay = occurrence.view.all_day
    const startIso = allDay ? allDayStartIso(format(start, 'yyyy-MM-dd')) : start.toISOString()
    const endIso = end
      ? allDay
        ? allDayEndIso(format(end, 'yyyy-MM-dd'))
        : end.toISOString()
      : null

    if (occurrence.event.recurrence !== 'none') {
      await saveOverride(occurrence, {
        canceled: false,
        title: occurrence.view.title,
        description: occurrence.view.description,
        start_at: startIso,
        end_at: endIso,
        all_day: allDay,
        color: occurrence.view.color,
        remind_minutes: occurrence.view.remind_minutes,
        tags: occurrence.view.tags,
      })
      return
    }

    const patch = { start_at: startIso, end_at: endIso }
    events.upsertLocal({ ...occurrence.event, ...patch })
    await supabase.from('events').update(patch).eq('id', occurrence.event.id)
  }

  /** 週表示で終了時刻だけを伸ばす。繰り返しの場合はその回だけ伸ばす */
  async function resizeEvent(occurrence: EventOccurrence, newEnd: Date) {
    if (!canEdit) return

    if (occurrence.event.recurrence !== 'none') {
      await saveOverride(occurrence, {
        canceled: false,
        title: occurrence.view.title,
        description: occurrence.view.description,
        start_at: occurrence.start.toISOString(),
        end_at: newEnd.toISOString(),
        all_day: occurrence.view.all_day,
        color: occurrence.view.color,
        remind_minutes: occurrence.view.remind_minutes,
        tags: occurrence.view.tags,
      })
      return
    }

    const patch = { end_at: newEnd.toISOString() }
    events.upsertLocal({ ...occurrence.event, ...patch })
    await supabase.from('events').update(patch).eq('id', occurrence.event.id)
  }

  /** 予定から「準備すること」をつくる */
  async function createTodoFromEvent(event: CalendarEvent) {
    const todo = todoFromEvent(event, roomId, { userId, displayName })
    todos.upsertLocal(todo)
    const { error } = await supabase.from('todos').insert(todo)
    if (error) {
      todos.removeLocal(todo.id)
      return
    }
    setEditing(null)
    setCreatingOn(null)
    onJump('todo', todo.id)
  }

  /**
   * その予定が「どの付箋から生まれたか」。
   *
   * もとの付箋が変わっても予定は自動では変わらない。
   * 変わったことだけを知らせて、反映するかどうかは選んでもらう。
   */
  function originFor(event: CalendarEvent | null) {
    if (!event?.source_note_id) return null
    const note = notes.rows.find((n) => n.id === event.source_note_id)
    if (!note) return null

    const patch = async (values: Partial<CalendarEvent>, close: boolean) => {
      const next = { ...event, ...values }
      // 開いている編集画面は「開いた時点の回」を持っているので、そちらにも当てる
      if (close) setEditing(null)
      else {
        setEditing((current) =>
          current && current.event.id === event.id
            ? { ...current, event: next, view: { ...current.view, ...values } }
            : current,
        )
      }
      events.upsertLocal(next)
      await supabase.from('events').update(values).eq('id', event.id)
    }

    return {
      label: note.text.split('\n')[0]?.trim() || '（空の付箋）',
      changed: originChanged(event, note),
      onOpen: () => onJump('board', note.id),
      // 入力欄の値と保存された値がずれないよう、反映したらいったん閉じる
      onApply: () => patch(eventPatchFromNote(note), true),
      onKeep: () => patch(acknowledgeOrigin(note), false),
    }
  }

  function exportIcs() {
    const safeName = boardName.replace(/[\\/:*?"<>|]/g, '_') || 'calendar'
    downloadText(
      `${safeName}.ics`,
      buildIcs(boardName, events.rows, todos.rows, overrides.rows),
      'text/calendar',
    )
  }

  function shift(direction: -1 | 1) {
    if (view === 'day') setCursor((c) => addDays(c, direction))
    else if (view === 'week') setCursor((c) => (direction === 1 ? addWeeks(c, 1) : subWeeks(c, 1)))
    else setCursor((c) => (direction === 1 ? addMonths(c, 1) : subMonths(c, 1)))
  }

  const headingText =
    view === 'day'
      ? format(cursor, 'yyyy年 M月d日(E)', { locale: ja })
      : view === 'week'
        ? `${format(startOfWeek(cursor, weekOptions), 'yyyy年 M月d日')} 〜 ${format(
            endOfWeek(cursor, weekOptions),
            'M月d日',
          )}`
        : view === 'list'
          ? 'これからの予定'
          : format(cursor, 'yyyy年 M月')

  return (
    <div className="flex h-full flex-col">
      <div className="toolbar-scroll flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        {view !== 'list' && (
          <>
            <button
              type="button"
              onClick={() => shift(-1)}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100"
            >
              ›
            </button>
          </>
        )}
        <h2 className="shrink-0 font-bold whitespace-nowrap text-slate-800">{headingText}</h2>
        <button
          type="button"
          onClick={() => setCursor(new Date())}
          className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          今日
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTodos((v) => !v)}
            title="期限つきリマインドも表示する"
            className={`rounded-lg px-2 py-1.5 text-sm transition ${
              showTodos ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            ⏰
          </button>
          <button
            type="button"
            onClick={exportIcs}
            title="カレンダーアプリ用に書き出す (.ics)"
            className="rounded-lg px-2 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100"
          >
            📤
          </button>
          <button
            type="button"
            onClick={() => setShowFeeds(true)}
            title="外部カレンダーの取り込み"
            className={`relative rounded-lg px-2 py-1.5 text-sm transition ${
              feeds.rows.some((f) => f.enabled)
                ? 'bg-slate-900 text-white'
                : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            🌐
            {Object.keys(feedState.errors).length > 0 && (
              <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-rose-500" />
            )}
          </button>
          <button
            type="button"
            onClick={() => changeWeekStart(weekStart === 0 ? 1 : 0)}
            title="週の始まりを切り替える"
            className="rounded-lg px-2 py-1.5 text-sm whitespace-nowrap text-slate-500 transition hover:bg-slate-100"
          >
            週始 {weekStart === 0 ? '日' : '月'}
          </button>

          <div className="flex rounded-lg border border-slate-200 p-0.5">
            {(['month', 'week', 'day', 'list'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-sm transition ${
                  view === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {v === 'month' ? '月' : v === 'week' ? '週' : v === 'day' ? '日' : 'リスト'}
              </button>
            ))}
          </div>

          {canEdit && (
            <button
              type="button"
              onClick={() => setCreatingOn(new Date())}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-white transition hover:bg-slate-700"
            >
              ＋ <span className="hidden sm:inline">予定を追加</span>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        <div className="mb-4 space-y-3">
          <NotificationBanner
            supported={reminders.supported}
            permission={reminders.permission}
            onRequest={reminders.requestPermission}
            text="予定の事前通知（15分前など）をブラウザ通知で受け取れます。"
          />
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

        {view === 'month' && (
          <MonthView
            cursor={cursor}
            weekStartsOn={weekStart}
            byDay={byDay}
            todosByDay={todosByDay}
            feedsByDay={feedsByDay}
            canEdit={canEdit}
            onSelectDay={canEdit ? setCreatingOn : () => {}}
            onSelectEvent={setEditing}
            onMoveEvent={shiftEvent}
          />
        )}
        {(view === 'week' || view === 'day') && (
          <WeekView
            cursor={cursor}
            weekStartsOn={weekStart}
            singleDay={view === 'day'}
            byDay={byDay}
            todosByDay={todosByDay}
            feedsByDay={feedsByDay}
            canEdit={canEdit}
            onSelectEvent={setEditing}
            onSelectDay={canEdit ? setCreatingOn : () => {}}
            onMoveEvent={shiftEvent}
            onResizeEvent={resizeEvent}
          />
        )}
        {view === 'list' && (
          <ListView
            occurrences={occurrences}
            commentCounts={commentCounts}
            onSelectEvent={setEditing}
          />
        )}
      </div>

      {(editing || creatingOn) && (
        <EventModal
          occurrence={editing}
          defaultDate={creatingOn ?? new Date()}
          canEdit={canEdit}
          allTags={allTags}
          commentCount={editing ? (commentCounts[editing.event.id] ?? 0) : 0}
          onSave={saveEvent}
          onDelete={deleteEvent}
          onCancelOccurrence={cancelOccurrence}
          onCreateTodo={createTodoFromEvent}
          origin={originFor(editing?.event ?? null)}
          onClose={() => {
            setEditing(null)
            setCreatingOn(null)
          }}
        />
      )}

      {showFeeds && (
        <FeedSettingsModal
          errors={feedState.errors}
          loading={feedState.loading}
          onRefresh={feedState.refresh}
          onClose={() => setShowFeeds(false)}
        />
      )}
    </div>
  )
}

/** 外部カレンダーの予定は編集できないので、点線の枠で区別して出す */
function FeedChip({ event }: { event: FeedEvent }) {
  const palette = EVENT_COLORS[event.color] ?? EVENT_COLORS.slate
  return (
    <div
      title={`${event.feedName}: ${event.title}`}
      className="truncate rounded border border-dashed px-1.5 py-0.5 text-[11px] leading-tight"
      style={{ borderColor: palette.dot, color: palette.text }}
    >
      🌐 {!event.allDay && <span className="font-medium">{format(event.start, 'HH:mm')} </span>}
      {event.title}
    </div>
  )
}

// =============================================================================
//  月表示
// =============================================================================

function MonthView({
  cursor,
  weekStartsOn,
  byDay,
  todosByDay,
  feedsByDay,
  canEdit,
  onSelectDay,
  onSelectEvent,
  onMoveEvent,
}: {
  cursor: Date
  weekStartsOn: WeekStart
  byDay: Map<string, EventOccurrence[]>
  todosByDay: Map<string, Todo[]>
  feedsByDay: Map<string, FeedEvent[]>
  canEdit: boolean
  onSelectDay: (day: Date) => void
  onSelectEvent: (occurrence: EventOccurrence) => void
  onMoveEvent: (occurrence: EventOccurrence, deltaMs: number) => void
}) {
  const [dragOver, setDragOver] = useState<string | null>(null)
  const dragRef = useRef<EventOccurrence | null>(null)

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(cursor), { weekStartsOn }),
        end: endOfWeek(endOfMonth(cursor), { weekStartsOn }),
      }),
    [cursor, weekStartsOn],
  )

  const headers = useMemo(
    () => Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + weekStartsOn) % 7]),
    [weekStartsOn],
  )

  function handleDrop(day: Date) {
    const drag = dragRef.current
    dragRef.current = null
    setDragOver(null)
    if (!drag) return

    const delta = startOfDay(day).getTime() - startOfDay(drag.start).getTime()
    if (delta !== 0) onMoveEvent(drag, delta)
  }

  return (
    <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
      {headers.map((w) => (
        <div
          key={w}
          className={`bg-slate-50 py-2 text-center text-xs font-bold ${
            w === '日' ? 'text-rose-500' : w === '土' ? 'text-blue-500' : 'text-slate-500'
          }`}
        >
          {w}
        </div>
      ))}

      {days.map((day) => {
        const key = format(day, 'yyyy-MM-dd')
        const list = byDay.get(key) ?? []
        const dayTodos = todosByDay.get(key) ?? []
        const outside = !isSameMonth(day, cursor)
        const holiday = getHolidayName(day)

        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => onSelectDay(day)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelectDay(day)
            }}
            onDragOver={(e) => {
              if (!dragRef.current) return
              e.preventDefault()
              setDragOver(key)
            }}
            onDragLeave={() => setDragOver((c) => (c === key ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop(day)
            }}
            className={`min-h-24 cursor-pointer p-1.5 text-left transition ${
              dragOver === key
                ? 'bg-blue-100'
                : outside
                  ? 'bg-slate-50/60 hover:bg-slate-50'
                  : 'bg-white hover:bg-slate-50'
            }`}
          >
            <div className="mb-1 flex items-baseline gap-1">
              <span
                className={`inline-grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs ${
                  isToday(day)
                    ? 'bg-slate-900 font-bold text-white'
                    : outside
                      ? 'text-slate-300'
                      : holiday || day.getDay() === 0
                        ? 'text-rose-500'
                        : day.getDay() === 6
                          ? 'text-blue-500'
                          : 'text-slate-600'
                }`}
              >
                {format(day, 'd')}
              </span>
              {holiday && !outside && (
                <span className="truncate text-[10px] text-rose-500">{holiday}</span>
              )}
            </div>

            <div className="space-y-0.5">
              {list.slice(0, 4).map((occurrence) => (
                <EventChip
                  key={occurrence.occurrenceKey}
                  occurrence={occurrence}
                  day={day}
                  draggable={canEdit}
                  onDragStart={() => {
                    dragRef.current = occurrence
                  }}
                  onSelect={onSelectEvent}
                />
              ))}
              {list.length > 4 && (
                <div className="px-1.5 text-[10px] text-slate-400">ほか {list.length - 4} 件</div>
              )}

              {(feedsByDay.get(key) ?? []).slice(0, 3).map((event) => (
                <FeedChip key={event.uid} event={event} />
              ))}

              {dayTodos.slice(0, 2).map((todo) => (
                <div
                  key={todo.id}
                  title={`リマインド: ${todo.title}`}
                  className={`truncate rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[11px] leading-tight ${
                    todo.done ? 'text-slate-400 line-through' : 'text-slate-600'
                  }`}
                >
                  ⏰ {todo.title}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EventChip({
  occurrence,
  day,
  draggable,
  onDragStart,
  onSelect,
}: {
  occurrence: EventOccurrence
  day: Date
  draggable: boolean
  onDragStart: () => void
  onSelect: (occurrence: EventOccurrence) => void
}) {
  const palette = EVENT_COLORS[occurrence.view.color] ?? EVENT_COLORS.blue
  const continues = !isSameDay(occurrence.start, day)
  // 締切は「その日に何かをする」ではないので、色の帯ではなく控えめな枠で出す
  const deadline = occurrence.view.kind === 'deadline'

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(occurrence)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation()
          onSelect(occurrence)
        }
      }}
      title={deadline ? `締切: ${occurrence.view.title}` : occurrence.view.title}
      className={`truncate px-1.5 py-0.5 text-[11px] leading-tight ${
        draggable ? 'cursor-grab' : ''
      } ${
        deadline
          ? 'rounded border border-dashed border-slate-300 text-slate-600'
          : 'rounded'
      }`}
      style={deadline ? undefined : { background: palette.bg, color: palette.text }}
    >
      {continues ? (
        <span className="mr-1">↳</span>
      ) : deadline ? (
        <span className="mr-1">⏰</span>
      ) : (
        !occurrence.view.all_day && (
          <span className="mr-1 font-medium">{format(occurrence.start, 'HH:mm')}</span>
        )
      )}
      {occurrence.event.recurrence !== 'none' && (
        <span className="mr-0.5" title={recurrenceLabel(ruleOf(occurrence.event))}>
          🔁
        </span>
      )}
      {occurrence.override && (
        <span title="この回だけ変更しています" className="mr-0.5">
          ✏️
        </span>
      )}
      {occurrence.view.title}
      {deadline && <span className="ml-0.5 text-slate-400">〆</span>}
    </div>
  )
}

// =============================================================================
//  週表示（時間軸つき）
// =============================================================================

type WeekDrag =
  | { kind: 'move'; occurrence: EventOccurrence; startX: number; startY: number }
  | { kind: 'resize'; occurrence: EventOccurrence; startY: number; originEnd: Date }

function WeekView({
  cursor,
  weekStartsOn,
  singleDay,
  byDay,
  todosByDay,
  feedsByDay,
  canEdit,
  onSelectEvent,
  onSelectDay,
  onMoveEvent,
  onResizeEvent,
}: {
  cursor: Date
  weekStartsOn: WeekStart
  singleDay: boolean
  byDay: Map<string, EventOccurrence[]>
  todosByDay: Map<string, Todo[]>
  feedsByDay: Map<string, FeedEvent[]>
  canEdit: boolean
  onSelectEvent: (occurrence: EventOccurrence) => void
  onSelectDay: (day: Date) => void
  onMoveEvent: (occurrence: EventOccurrence, deltaMs: number) => void
  onResizeEvent: (occurrence: EventOccurrence, newEnd: Date) => void
}) {
  const days = useMemo(
    () =>
      singleDay
        ? [startOfDay(cursor)]
        : eachDayOfInterval({
            start: startOfWeek(cursor, { weekStartsOn }),
            end: endOfWeek(cursor, { weekStartsOn }),
          }),
    [cursor, weekStartsOn, singleDay],
  )
  const dragRef = useRef<WeekDrag | null>(null)
  // key は occurrenceKey。予定の id にすると、繰り返しの全部の回が同時に動いて見えてしまう
  const [preview, setPreview] = useState<{
    key: string
    deltaMs: number
    deltaEndMs: number
  } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // ドラッグで実際に動かした直後の click を捨てる（離した拍子に編集モーダルが開かないように）
  const suppressClickRef = useRef(false)

  /** 画面上の移動量を「日数 + 分」に直す（計算は lib/calendarGrid.ts） */
  function toDelta(dx: number, dy: number) {
    return dragDeltaMs(dx, dy, (gridRef.current?.clientWidth ?? 700) / 7)
  }

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return

    if (drag.kind === 'move') {
      setPreview({
        key: drag.occurrence.occurrenceKey,
        deltaMs: toDelta(e.clientX - drag.startX, e.clientY - drag.startY),
        deltaEndMs: 0,
      })
    } else {
      setPreview({
        key: drag.occurrence.occurrenceKey,
        deltaMs: 0,
        deltaEndMs: toDelta(0, e.clientY - drag.startY),
      })
    }
  }

  function handleUp() {
    const drag = dragRef.current
    const current = preview
    dragRef.current = null
    setPreview(null)
    if (!drag || !current) return

    if (current.deltaMs !== 0 || current.deltaEndMs !== 0) {
      suppressClickRef.current = true
      // click は pointerup の直後に同じ処理の中で届く。届かなかった（タッチなど）ときのために解除しておく
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }

    if (drag.kind === 'move') {
      onMoveEvent(drag.occurrence, current.deltaMs)
    } else if (current.deltaEndMs !== 0) {
      onResizeEvent(drag.occurrence, new Date(drag.originEnd.getTime() + current.deltaEndMs))
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex border-b border-slate-200">
        <div className="w-14 shrink-0" />
        {days.map((day) => {
          const holiday = getHolidayName(day)
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelectDay(day)}
              className="flex-1 border-l border-slate-100 py-2 text-center transition hover:bg-slate-50"
            >
              <div
                className={`text-xs ${
                  holiday || day.getDay() === 0
                    ? 'text-rose-500'
                    : day.getDay() === 6
                      ? 'text-blue-500'
                      : 'text-slate-500'
                }`}
              >
                {WEEKDAYS[day.getDay()]}
              </div>
              <div
                className={`mx-auto mt-0.5 grid h-6 w-6 place-items-center rounded-full text-sm ${
                  isToday(day) ? 'bg-slate-900 font-bold text-white' : 'text-slate-700'
                }`}
              >
                {format(day, 'd')}
              </div>
              {holiday && (
                <div className="truncate px-0.5 text-[9px] text-rose-500">{holiday}</div>
              )}
            </button>
          )
        })}
      </div>

      {/* 終日・複数日にまたがる予定と、期限つきリマインド */}
      <div className="flex border-b border-slate-200 bg-slate-50/60">
        <div className="w-14 shrink-0 py-1 pr-2 text-right text-[10px] text-slate-400">終日</div>
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd')
          const list = (byDay.get(key) ?? []).filter(
            (o) => o.view.all_day || !isSameDay(o.start, o.end ?? o.start),
          )
          const dayTodos = todosByDay.get(key) ?? []
          return (
            <div
              key={day.toISOString()}
              className="min-h-8 flex-1 space-y-0.5 border-l border-slate-100 p-1"
            >
              {list.map((occurrence) => (
                <EventChip
                  key={occurrence.occurrenceKey}
                  occurrence={occurrence}
                  day={day}
                  draggable={false}
                  onDragStart={() => {}}
                  onSelect={onSelectEvent}
                />
              ))}
              {(feedsByDay.get(key) ?? []).map((event) => (
                <FeedChip key={event.uid} event={event} />
              ))}
              {dayTodos.map((todo) => (
                <div
                  key={todo.id}
                  className={`truncate rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] ${
                    todo.done ? 'text-slate-400 line-through' : 'text-slate-600'
                  }`}
                >
                  ⏰ {todo.title}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* 時間軸 */}
      <div className="flex max-h-[60vh] overflow-y-auto">
        <div className="w-14 shrink-0">
          {Array.from({ length: 24 }, (_, hour) => (
            <div
              key={hour}
              className="relative pr-2 text-right text-[10px] text-slate-400"
              style={{ height: HOUR_HEIGHT }}
            >
              <span className="absolute -top-1.5 right-2">{hour === 0 ? '' : `${hour}:00`}</span>
            </div>
          ))}
        </div>

        <div ref={gridRef} className="flex flex-1">
          {days.map((day) => {
            const list = (byDay.get(format(day, 'yyyy-MM-dd')) ?? []).filter(
              (o) => !o.view.all_day && isSameDay(o.start, o.end ?? o.start),
            )
            return (
              <div
                key={day.toISOString()}
                className="relative flex-1 border-l border-slate-100"
                style={{ height: HOUR_HEIGHT * 24 }}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <div
                    key={hour}
                    className="border-b border-slate-100"
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}

                {list.map((occurrence) => {
                  const palette = EVENT_COLORS[occurrence.view.color] ?? EVENT_COLORS.blue
                  const isPreviewing = preview?.key === occurrence.occurrenceKey
                  const shiftMs = isPreviewing ? preview.deltaMs : 0
                  const endShiftMs = isPreviewing ? preview.deltaEndMs : 0

                  const start = new Date(occurrence.start.getTime() + shiftMs)
                  const rawEnd = occurrence.end ?? new Date(occurrence.start.getTime() + 30 * 60_000)
                  const end = new Date(rawEnd.getTime() + shiftMs + endShiftMs)

                  const startMinutes = differenceInMinutes(start, startOfDay(day))
                  const endMinutes = Math.min(differenceInMinutes(end, startOfDay(day)), 24 * 60)
                  const height = Math.max(20, ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT)
                  const movable = canEdit

                  return (
                    <div
                      key={occurrence.occurrenceKey}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false
                          return
                        }
                        if (!dragRef.current) onSelectEvent(occurrence)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onSelectEvent(occurrence)
                      }}
                      onPointerDown={(e) => {
                        if (!movable) return
                        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                        dragRef.current = {
                          kind: 'move',
                          occurrence,
                          startX: e.clientX,
                          startY: e.clientY,
                        }
                      }}
                      onPointerMove={handleMove}
                      onPointerUp={handleUp}
                      onPointerCancel={handleUp}
                      className={`absolute right-0.5 left-0.5 touch-none overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-tight ${
                        movable ? 'cursor-grab' : ''
                      } ${isPreviewing ? 'opacity-70 ring-2 ring-slate-800' : ''}`}
                      style={{
                        top: (startMinutes / 60) * HOUR_HEIGHT,
                        height,
                        background: palette.bg,
                        color: palette.text,
                      }}
                    >
                      <span className="font-medium">{format(start, 'HH:mm')}</span>{' '}
                      {occurrence.event.recurrence !== 'none' && (
                        <span title={recurrenceLabel(ruleOf(occurrence.event))}>🔁</span>
                      )}
                      {occurrence.override && (
                        <span title="この回だけ変更しています">✏️</span>
                      )}{' '}
                      {occurrence.view.title}

                      {movable && occurrence.end && (
                        <span
                          title="終了時刻を変える"
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            dragRef.current = {
                              kind: 'resize',
                              occurrence,
                              startY: e.clientY,
                              originEnd: occurrence.end!,
                            }
                          }}
                          onPointerMove={handleMove}
                          onPointerUp={handleUp}
                          onPointerCancel={handleUp}
                          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize bg-black/10"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
//  リスト表示
// =============================================================================

function ListView({
  occurrences,
  commentCounts,
  onSelectEvent,
}: {
  occurrences: EventOccurrence[]
  commentCounts: Record<string, number>
  onSelectEvent: (occurrence: EventOccurrence) => void
}) {
  const sorted = useMemo(
    () => occurrences.slice().sort((a, b) => a.start.getTime() - b.start.getTime()),
    [occurrences],
  )

  if (sorted.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
        これから 90 日間の予定はありません。
      </p>
    )
  }

  let lastDateKey = ''

  return (
    <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {sorted.map((occurrence) => {
        const palette = EVENT_COLORS[occurrence.view.color] ?? EVENT_COLORS.blue
        const dateKey = format(occurrence.start, 'yyyy-MM-dd')
        const showDate = dateKey !== lastDateKey
        lastDateKey = dateKey
        const count = commentCounts[occurrence.event.id] ?? 0
        const holiday = getHolidayName(occurrence.start)

        return (
          <li key={occurrence.occurrenceKey}>
            {showDate && (
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-1.5 text-xs font-bold text-slate-500">
                {format(occurrence.start, 'M月d日(E)', { locale: ja })}
                {holiday && <span className="font-normal text-rose-500">{holiday}</span>}
                {isToday(occurrence.start) && (
                  <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-white">
                    今日
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => onSelectEvent(occurrence)}
              className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left transition hover:bg-slate-50"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette.dot }} />
              <span className="w-24 shrink-0 text-sm text-slate-500">
                {occurrence.view.all_day
                  ? '終日'
                  : `${format(occurrence.start, 'HH:mm')}${
                      occurrence.end ? `〜${format(occurrence.end, 'HH:mm')}` : ''
                    }`}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                {occurrence.event.recurrence !== 'none' && (
                  <span className="mr-1" title={recurrenceLabel(ruleOf(occurrence.event))}>
                    🔁
                  </span>
                )}
                {occurrence.override && (
                  <span title="この回だけ変更しています" className="mr-1">
                    ✏️
                  </span>
                )}
                {occurrence.view.title}
              </span>
              {(occurrence.view.tags ?? []).slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
                >
                  #{tag}
                </span>
              ))}
              {count > 0 && <span className="shrink-0 text-xs text-slate-400">💬 {count}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// =============================================================================
//  予定の編集モーダル
// =============================================================================

interface EventDraft {
  /** 予定か締切か */
  kind: EventKind
  title: string
  description: string
  date: string
  time: string
  hasEnd: boolean
  endDate: string
  endTime: string
  allDay: boolean
  color: string
  recurrence: Recurrence
  /** 毎週に出す曜日（0=日 … 6=土）。空なら開始日の曜日だけ */
  recurrenceDays: number[]
  /** 毎月の第 n 週（1〜5、-1 は最終）。null なら開始日と同じ日付 */
  recurrenceWeek: number | null
  recurrenceUntil: string
  remind: number | null
  tags: string[]
}

/**
 * 予定 1 件分のドラフトを作る。
 *
 * scope='occurrence' なら「画面に見えているその回」の値（例外を当てた後）、
 * scope='all' なら「元の予定」の値を初期値にする。範囲を切り替えたときに
 * 作り直さないと、その回の日付のままシリーズ全体を動かしてしまう。
 */
function buildDraft(
  occurrence: EventOccurrence | null,
  defaultDate: Date,
  scope: EditScope,
): EventDraft {
  const source = occurrence ? (scope === 'occurrence' ? occurrence.view : occurrence.event) : null

  const start = source
    ? scope === 'occurrence' && occurrence
      ? occurrence.start
      : parseISO(source.start_at)
    : defaultDate

  const end = source?.end_at
    ? scope === 'occurrence' && occurrence?.end
      ? occurrence.end
      : parseISO(source.end_at)
    : null

  return {
    // 種別はシリーズの属性なので、常に元の予定から取る
    kind: occurrence?.event.kind ?? 'event',
    title: source?.title ?? '',
    description: source?.description ?? '',
    date: format(start, 'yyyy-MM-dd'),
    time: format(source && !source.all_day ? start : nextHour(start), 'HH:mm'),
    hasEnd: Boolean(end),
    endDate: format(end ?? start, 'yyyy-MM-dd'),
    endTime: format(end ?? nextHour(nextHour(start)), 'HH:mm'),
    allDay: source?.all_day ?? true,
    color: source?.color ?? 'blue',
    // 繰り返しの設定はシリーズの属性なので、常に元の予定から取る
    recurrence: occurrence?.event.recurrence ?? 'none',
    recurrenceDays: occurrence?.event.recurrence_days ?? [],
    recurrenceWeek: occurrence?.event.recurrence_week ?? null,
    recurrenceUntil: occurrence?.event.recurrence_until ?? '',
    remind: source ? source.remind_minutes : null,
    tags: source?.tags ?? [],
  }
}

/**
 * 繰り返しの曜日を選ぶところ。
 *
 * 毎週は曜日を複数（空なら「開始日と同じ曜日」＝これまでの動き）。
 * 毎月は「日付で」と「曜日で」を選び、曜日でなら第 n 週を選ぶ。曜日そのものは
 * 開始日から決まるので読むだけにする（選ばせると開始日と食い違う）。
 */
function RecurrenceFields({
  draft,
  update,
}: {
  draft: EventDraft
  update: (patch: Partial<EventDraft>) => void
}) {
  if (draft.recurrence !== 'weekly' && draft.recurrence !== 'monthly') return null

  const startWeekday = localDateOf(draft.date).getDay()

  if (draft.recurrence === 'weekly') {
    const toggle = (day: number) => {
      const next = draft.recurrenceDays.includes(day)
        ? draft.recurrenceDays.filter((d) => d !== day)
        : [...draft.recurrenceDays, day].sort((a, b) => a - b)
      update({ recurrenceDays: next })
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">曜日</span>
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map((label, day) => {
            const on = draft.recurrenceDays.includes(day)
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(day)}
                className={`h-8 w-8 rounded-lg border text-sm transition ${
                  on
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
        {draft.recurrenceDays.length === 0 && (
          <span className="text-xs text-slate-400">
            選ばなければ、開始日と同じ {WEEKDAY_LABELS[startWeekday]}曜だけに出ます
          </span>
        )}
      </div>
    )
  }

  const byWeekday = draft.recurrenceWeek !== null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-slate-500">毎月</span>
      <div className="flex gap-1">
        <button
          type="button"
          aria-pressed={!byWeekday}
          onClick={() => update({ recurrenceWeek: null, recurrenceDays: [] })}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            !byWeekday
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
        >
          日付で
        </button>
        <button
          type="button"
          aria-pressed={byWeekday}
          onClick={() => update({ recurrenceWeek: 1, recurrenceDays: [startWeekday] })}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            byWeekday
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
        >
          曜日で
        </button>
      </div>

      {byWeekday ? (
        <>
          <select
            value={String(draft.recurrenceWeek)}
            onChange={(e) => update({ recurrenceWeek: Number(e.target.value) })}
            aria-label="第何週か"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
          >
            {MONTH_WEEK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-sm text-slate-600">{WEEKDAY_LABELS[startWeekday]}曜</span>
          <span className="text-xs text-slate-400">
            その曜日が無い月は飛ばします
          </span>
        </>
      ) : (
        <span className="text-xs text-slate-400">
          毎月 {localDateOf(draft.date).getDate()} 日（無い月は月末に寄せます）
        </span>
      )}
    </div>
  )
}

/**
 * 開始日が規則に合わないときに、寄せ先を先に見せる。
 *
 * 保存すると黙って動くので、押す前に分かるようにしておく
 * （金曜の予定に「毎週 火」を選ぶと、開始は次の火曜になる）。
 */
function SnappedStartHint({ draft, rule }: { draft: EventDraft; rule: RecurrenceRule }) {
  const start = draft.allDay
    ? allDayStartIso(draft.date)
    : boardDateTimeIso(draft.date, draft.time)
  const snapped = firstMatchingStart(start, rule)
  if (toBoardDate(snapped) === toBoardDate(start)) return null

  return (
    <p className="text-xs text-slate-500">
      最初は {format(parseISO(snapped), 'yyyy年M月d日(E)', { locale: ja })} からになります
    </p>
  )
}

function EventModal({
  occurrence,
  defaultDate,
  canEdit,
  allTags,
  commentCount,
  onSave,
  onDelete,
  onCancelOccurrence,
  onCreateTodo,
  origin,
  onClose,
}: {
  occurrence: EventOccurrence | null
  defaultDate: Date
  canEdit: boolean
  allTags: string[]
  commentCount: number
  /** この予定が生まれたもとの付箋 */
  origin: {
    label: string
    /** もとの付箋が、取り込んだあとに変わっているか */
    changed: boolean
    onOpen: () => void
    onApply: () => Promise<void>
    onKeep: () => Promise<void>
  } | null
  onSave: (
    draft: EventDraft,
    occurrence: EventOccurrence | null,
    scope: EditScope,
  ) => Promise<void>
  onDelete: (id: string) => void
  onCancelOccurrence: (occurrence: EventOccurrence) => Promise<void>
  onCreateTodo: (event: CalendarEvent) => Promise<void>
  onClose: () => void
}) {
  const event = occurrence?.event ?? null
  const isRecurring = Boolean(event && event.recurrence !== 'none')

  // 繰り返し予定は「この回だけ」を既定にする（Google カレンダーと同じ）
  const [scope, setScope] = useState<EditScope>(isRecurring ? 'occurrence' : 'all')
  const [draft, setDraft] = useState<EventDraft>(() =>
    buildDraft(occurrence, defaultDate, isRecurring ? 'occurrence' : 'all'),
  )
  const [saving, setSaving] = useState(false)
  const [showComments, setShowComments] = useState(false)

  // 範囲を切り替えたら、その範囲の元の値でドラフトを作り直す
  const scopeRef = useRef(scope)
  useEffect(() => {
    if (scopeRef.current === scope) return
    scopeRef.current = scope
    setDraft(buildDraft(occurrence, defaultDate, scope))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  async function submit() {
    if (!draft.title.trim() || saving) return
    setSaving(true)
    await onSave({ ...draft, title: draft.title.trim() }, occurrence, scope)
    setSaving(false)
  }

  function update(patch: Partial<EventDraft>) {
    setDraft((current) => {
      const next = { ...current, ...patch }
      if (next.endDate < next.date) next.endDate = next.date
      if (patch.allDay === false && current.remind === null && !event) next.remind = 0

      // 「毎月 第 n 曜日」の曜日は開始日から決まる。日付を変えたら付いてこないと、
      // 画面に出ている「第2火曜」と保存される曜日がずれる
      if (patch.date && next.recurrenceWeek !== null) {
        next.recurrenceDays = [localDateOf(next.date).getDay()]
      }
      return next
    })
  }

  /** いま画面が表している繰り返しの規則。保存時と同じ正規化を通す */
  const draftRule = normalizeRule({
    recurrence: draft.recurrence,
    days: draft.recurrenceDays,
    week: draft.recurrenceWeek,
  })

  /**
   * 「この回だけ」では予定 / 締切を切り替えられない。
   *
   * 例外は event_overrides に書くが、この表に kind の列が無いので saveOverride は
   * kind を捨てる。一方で締切ボタンは allDay も立てるため、押せてしまうと
   * 「終日にはなったが 📅 予定のまま」という中途半端な結果だけが残る。
   * 押させないうえで、理由をその場に出す。
   */
  const kindLocked = isRecurring && scope === 'occurrence'
  const kindLockedReason =
    '予定と締切の切り替えは、この回だけではできません。「すべての回を変更」を選んでください。'

  return (
    <Modal
      title={`${EVENT_KIND_LABELS[draft.kind].label}${
        !canEdit ? '' : event ? 'を編集' : 'を追加'
      }`}
      onClose={onClose}
      footer={
        canEdit ? (
          <>
            {event && occurrence && (
              <button
                type="button"
                onClick={() => {
                  if (!isRecurring) {
                    if (window.confirm('この予定を削除します。よろしいですか？')) {
                      onDelete(event.id)
                    }
                    return
                  }

                  if (scope === 'occurrence') {
                    const label = format(occurrence.start, 'M月d日(E)', { locale: ja })
                    if (window.confirm(`${label} の回だけ削除します。よろしいですか？`)) {
                      void onCancelOccurrence(occurrence)
                    }
                    return
                  }

                  const message = '繰り返し予定です。すべての回が削除されます。よろしいですか？'
                  if (window.confirm(message)) onDelete(event.id)
                }}
                className="mr-auto rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
              >
                削除
              </button>
            )}
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
              disabled={!draft.title.trim() || saving}
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
            <span className="shrink-0">🖍️</span>
            <span className="min-w-0 flex-1 truncate">
              この付箋から生まれました：{origin.label}
            </span>
            <span className="shrink-0 text-slate-400">→</span>
          </button>

          {origin.changed && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p>元の付箋が変更されています。この予定は自動では変わりません。</p>
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
        {isRecurring && canEdit && occurrence && (
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="mb-2 text-xs text-slate-500">
              🔁 {format(occurrence.start, 'M月d日(E)', { locale: ja })} の回を開いています
            </p>
            <div className="flex flex-wrap gap-4">
              {(
                [
                  ['occurrence', 'この回だけ変更'],
                  ['all', 'すべての回を変更'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="event-scope"
                    checked={scope === value}
                    onChange={() => setScope(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(Object.keys(EVENT_KIND_LABELS) as EventKind[]).map((kind) => {
            const info = EVENT_KIND_LABELS[kind]
            return (
              <button
                key={kind}
                type="button"
                disabled={kindLocked}
                title={kindLocked ? kindLockedReason : info.hint}
                // 締切は「その日まで」なので、時刻は持たせない
                onClick={() => update(kind === 'deadline' ? { kind, allDay: true } : { kind })}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  draft.kind === kind
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 text-slate-600 hover:border-slate-400'
                } disabled:cursor-not-allowed disabled:border-slate-200 disabled:opacity-50 disabled:hover:border-slate-200`}
              >
                {info.icon} {info.label}
              </button>
            )
          })}
          <span className="w-full text-xs text-slate-500">
            {kindLocked ? kindLockedReason : EVENT_KIND_LABELS[draft.kind].hint}
          </span>
        </div>

        <input
          autoFocus
          value={draft.title}
          maxLength={100}
          onChange={(e) => update({ title: e.target.value })}
          placeholder={draft.kind === 'deadline' ? '締切のタイトル' : '予定のタイトル'}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800 disabled:bg-slate-50"
        />

        {draft.kind === 'event' && (
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => update({ allDay: e.target.checked })}
            />
            終日
          </label>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-10 text-sm text-slate-500">開始</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => update({ date: e.target.value })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
            />
            {!draft.allDay && (
              <input
                type="time"
                value={draft.time}
                onChange={(e) => update({ time: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-10 text-sm text-slate-500">終了</span>
            {draft.hasEnd ? (
              <>
                <input
                  type="date"
                  value={draft.endDate}
                  min={draft.date}
                  onChange={(e) => update({ endDate: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
                />
                {!draft.allDay && (
                  <input
                    type="time"
                    value={draft.endTime}
                    onChange={(e) => update({ endTime: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
                  />
                )}
                <button
                  type="button"
                  onClick={() => update({ hasEnd: false })}
                  className="text-sm text-slate-400 transition hover:text-slate-700"
                >
                  なくす
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => update({ hasEnd: true })}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
              >
                ＋ 終了日時を指定
              </button>
            )}
          </div>
        </div>

        {isRecurring && scope === 'occurrence' ? (
          <p className="text-xs text-slate-400">
            🔁 {recurrenceLabel(draftRule)} の予定です。
            繰り返しの設定はすべての回に共通なので、「すべての回を変更」から変えてください。
          </p>
        ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">繰り返し</span>
            <select
              value={draft.recurrence}
              onChange={(e) => update({ recurrence: e.target.value as Recurrence })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
            >
              {Object.entries(RECURRENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {draft.recurrence !== 'none' && (
              <>
                <span className="text-sm text-slate-500">終了</span>
                <input
                  type="date"
                  value={draft.recurrenceUntil}
                  onChange={(e) => update({ recurrenceUntil: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
                />
                {draft.recurrenceUntil && (
                  <button
                    type="button"
                    onClick={() => update({ recurrenceUntil: '' })}
                    className="text-sm text-slate-400 transition hover:text-slate-700"
                  >
                    無期限
                  </button>
                )}
              </>
            )}
          </div>
          <RecurrenceFields draft={draft} update={update} />
          <SnappedStartHint draft={draft} rule={draftRule} />
        </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">通知</span>
          <select
            value={draft.remind === null ? '' : String(draft.remind)}
            onChange={(e) =>
              update({ remind: e.target.value === '' ? null : Number(e.target.value) })
            }
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
          >
            {REMIND_OPTIONS.map((option) => (
              <option key={String(option.value)} value={option.value === null ? '' : option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">色</span>
          {Object.entries(EVENT_COLORS).map(([key, palette]) => (
            <button
              key={key}
              type="button"
              onClick={() => update({ color: key })}
              className={`h-6 w-6 rounded-full transition ${
                draft.color === key ? 'ring-2 ring-slate-800 ring-offset-2' : ''
              }`}
              style={{ background: palette.dot }}
            />
          ))}
        </div>

        <div>
          <span className="mb-1.5 block text-sm text-slate-500">タグ</span>
          <TagInput
            tags={draft.tags}
            suggestions={allTags}
            disabled={!canEdit}
            onChange={(tags) => update({ tags })}
          />
        </div>

        <textarea
          value={draft.description}
          maxLength={500}
          rows={3}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="メモ（任意）"
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800 disabled:bg-slate-50"
        />
      </fieldset>

      {event && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          {canEdit && (
            <button
              type="button"
              onClick={() => void onCreateTodo(occurrence ? occurrence.view : event)}
              className="mb-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
            >
              ＋ 準備することを追加
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowComments((open) => !open)}
            className="block text-sm font-medium text-slate-600 transition hover:text-slate-900"
          >
            💬 コメント{commentCount > 0 && `（${commentCount}）`} {showComments ? '▲' : '▼'}
          </button>
          {showComments && (
            <div className="mt-3">
              <CommentList
                targetType="event"
                targetId={event.id}
                placeholder="この予定へのコメント"
              />
            </div>
          )}
          <p className="mt-3 text-xs text-slate-400">作成者: {event.author_name || '不明'}</p>
        </div>
      )}
    </Modal>
  )
}

/**
 * 回の情報がないときの受け皿。横断検索から飛んできて、表示範囲に回が 1 つも
 * 見つからなかった場合に、元の予定の開始時刻を「その回」として扱う。
 */
function baseOccurrence(event: CalendarEvent): EventOccurrence {
  const start = parseISO(event.start_at)
  return {
    event,
    view: event,
    start,
    end: event.end_at ? parseISO(event.end_at) : null,
    originalStart: start,
    override: null,
    occurrenceKey: occurrenceKey(event.id, start),
  }
}

function nextHour(base: Date): Date {
  const d = new Date(base)
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}
