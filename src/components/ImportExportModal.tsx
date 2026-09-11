import { useRef, useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { useRoomData } from '../lib/roomData'
import {
  boardDateTimeText,
  formatWeekdays,
  looksMojibake,
  parseCsvObjects,
  parseFlexibleDate,
  parseInterval,
  parseWeekOrdinal,
  parseWeekdays,
  toCsv,
} from '../lib/csv'
import { buildIcs, downloadText } from '../lib/ics'
import { normalizeRule } from '../lib/recurrence'
import { MONTH_WEEK_LABELS, type CalendarEvent, type Todo } from '../lib/types'
import { messageOf } from '../lib/errorMessage'

const EVENT_HEADERS = [
  'タイトル',
  '種別',
  '開始',
  '終了',
  '終日',
  '繰り返し',
  '繰り返しの曜日',
  '繰り返しの週',
  '繰り返しの間隔',
  '繰り返しの終了日',
  '通知(分前)',
  'タグ',
  'メモ',
]
const TODO_HEADERS = [
  'タイトル',
  '期限',
  '状態',
  '担当',
  '通知(分前)',
  '繰り返し',
  '繰り返しの曜日',
  '繰り返しの週',
  '繰り返しの間隔',
  'タグ',
  'メモ',
]

/**
 * 取り込む CSV の上限。
 *
 * 画像は 20MB、添付は 10MB で止めているのに、ここだけ何の確認もせず
 * file.text() に渡していた。数十 MB の CSV を選ぶとタブごと固まる。
 */
const MAX_CSV_BYTES = 2 * 1024 * 1024
const MAX_CSV_ROWS = 2000

/** 選ばれたファイルを読む前に大きさを確かめる。だめなら理由を返す */
function readCsvGuard(file: File): string | null {
  if (file.size > MAX_CSV_BYTES) {
    return `ファイルが大きすぎます（${Math.round(MAX_CSV_BYTES / 1024 / 1024)}MB まで）。`
  }
  return null
}

interface Props {
  boardName: string
  onClose: () => void
}

/** 予定とリマインドの CSV 入出力 */
export default function ImportExportModal({ boardName, onClose }: Props) {
  const { userId, displayName } = useIdentity()
  const { roomId, canEdit, events, todos, overrides } = useRoomData()
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const eventInputRef = useRef<HTMLInputElement>(null)
  const todoInputRef = useRef<HTMLInputElement>(null)

  const safeName = boardName.replace(/[\\/:*?"<>|]/g, '_') || 'board'

  function exportEvents() {
    const rows = events.rows
      .slice()
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .map((event) => [
        event.title,
        event.kind === 'deadline' ? '締切' : '予定',
        boardDateTimeText(event.start_at),
        event.end_at ? boardDateTimeText(event.end_at) : '',
        event.all_day ? 'はい' : 'いいえ',
        event.recurrence,
        formatWeekdays(event.recurrence_days ?? []),
        event.recurrence_week === null || event.recurrence_week === undefined
          ? ''
          : (MONTH_WEEK_LABELS[String(event.recurrence_week)] ?? ''),
        (event.recurrence_interval ?? 1) > 1 ? String(event.recurrence_interval) : '',
        event.recurrence_until ?? '',
        event.remind_minutes ?? '',
        (event.tags ?? []).join(' '),
        event.description,
      ])
    downloadText(`${safeName}_予定.csv`, toCsv(EVENT_HEADERS, rows), 'text/csv')
  }

  function exportTodos() {
    const rows = todos.rows
      .slice()
      .sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''))
      .map((todo) => [
        todo.title,
        todo.due_at ? boardDateTimeText(todo.due_at) : '',
        todo.done ? '完了' : todo.status === 'doing' ? '進行中' : '未着手',
        todo.assignee_name,
        todo.remind_minutes ?? '',
        todo.recurrence,
        formatWeekdays(todo.recurrence_days ?? []),
        todo.recurrence_week === null || todo.recurrence_week === undefined
          ? ''
          : (MONTH_WEEK_LABELS[String(todo.recurrence_week)] ?? ''),
        (todo.recurrence_interval ?? 1) > 1 ? String(todo.recurrence_interval) : '',
        (todo.tags ?? []).join(' '),
        todo.notes,
      ])
    downloadText(`${safeName}_リマインド.csv`, toCsv(TODO_HEADERS, rows), 'text/csv')
  }

  function exportIcs() {
    downloadText(
      `${safeName}.ics`,
      buildIcs(boardName, events.rows, todos.rows, overrides.rows),
      'text/calendar',
    )
  }

  async function importEvents(file: File) {
    const tooBig = readCsvGuard(file)
    if (tooBig) {
      setError(tooBig)
      return
    }

    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const text = await file.text()
      if (looksMojibake(text)) {
        // file.text() は常に UTF-8 として読む。Shift_JIS のまま渡されると
        // 日本語だけが化けるが、英語のヘッダーなら列は揃ってしまい、
        // 化けた本文がそのまま保存される。黙って壊すより、ここで止める
        setError('文字が化けています。CSV を UTF-8 で保存し直してから、もう一度お試しください。')
        return
      }
      const objects = parseCsvObjects(text)
      if (objects.length > MAX_CSV_ROWS) {
        setError(`一度に取り込めるのは ${MAX_CSV_ROWS} 行までです。分けて取り込んでください。`)
        return
      }
      const rows: CalendarEvent[] = []
      let skipped = 0

      for (const item of objects) {
        const title = (item['タイトル'] ?? item.title ?? '').trim()
        const start = parseFlexibleDate(item['開始'] ?? item.start ?? '')
        if (!title || !start) {
          skipped++
          continue
        }
        const end = parseFlexibleDate(item['終了'] ?? item.end ?? '')
        const remind = Number(item['通知(分前)'] ?? '')

        const now = new Date().toISOString()
        rows.push({
          id: crypto.randomUUID(),
          room_id: roomId,
          // 「種別」列に「締切」とあれば締切として取り込む
          kind: /締切|〆|deadline/i.test(item['種別'] ?? '') ? 'deadline' : 'event',
          title,
          description: item['メモ'] ?? '',
          start_at: start.toISOString(),
          end_at: end ? end.toISOString() : null,
          all_day: /はい|true|1/i.test(item['終日'] ?? ''),
          color: 'blue',
          ...csvRule(item),
          recurrence_until: (item['繰り返しの終了日'] ?? '').trim() || null,
          remind_minutes: Number.isFinite(remind) && item['通知(分前)'] ? remind : null,
          tags: splitTags(item['タグ']),
          source_note_id: null,
          source_synced_at: null,
          deleted_at: null,
          author_id: userId,
          author_name: displayName,
          created_at: now,
          updated_at: now,
        })
      }

      if (rows.length === 0) {
        setError('取り込める行がありませんでした。「タイトル」と「開始」の列が必要です。')
        return
      }

      // 先に画面へ出しておき、保存に失敗したら必ず取り消す。
      // 巻き戻さないと、DB に無い予定が画面に残り続ける（次に開くまで気づけない）。
      for (const row of rows) events.upsertLocal(row)
      const { error: insertError } = await supabase.from('events').insert(rows)
      if (insertError) {
        for (const row of rows) events.removeLocal(row.id)
        throw insertError
      }

      setResult(
        `${rows.length} 件の予定を取り込みました。${skipped > 0 ? `（${skipped} 行は読み取れず飛ばしました）` : ''}`,
      )
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function importTodos(file: File) {
    const tooBig = readCsvGuard(file)
    if (tooBig) {
      setError(tooBig)
      return
    }

    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const text = await file.text()
      if (looksMojibake(text)) {
        // file.text() は常に UTF-8 として読む。Shift_JIS のまま渡されると
        // 日本語だけが化けるが、英語のヘッダーなら列は揃ってしまい、
        // 化けた本文がそのまま保存される。黙って壊すより、ここで止める
        setError('文字が化けています。CSV を UTF-8 で保存し直してから、もう一度お試しください。')
        return
      }
      const objects = parseCsvObjects(text)
      if (objects.length > MAX_CSV_ROWS) {
        setError(`一度に取り込めるのは ${MAX_CSV_ROWS} 行までです。分けて取り込んでください。`)
        return
      }
      const rows: Todo[] = []
      let skipped = 0

      for (const item of objects) {
        const title = (item['タイトル'] ?? item.title ?? '').trim()
        if (!title) {
          skipped++
          continue
        }
        const due = parseFlexibleDate(item['期限'] ?? item.due ?? '')
        const state = item['状態'] ?? ''
        const remind = Number(item['通知(分前)'] ?? '')

        rows.push({
          id: crypto.randomUUID(),
          room_id: roomId,
          title,
          notes: item['メモ'] ?? '',
          due_at: due ? due.toISOString() : null,
          done: /完了|done|true/i.test(state),
          done_at: /完了|done|true/i.test(state) ? new Date().toISOString() : null,
          assignee_id: null,
          assignee_name: item['担当'] ?? '',
          remind_minutes: Number.isFinite(remind) && item['通知(分前)'] ? remind : null,
          ...csvRule(item),
          subtasks: [],
          tags: splitTags(item['タグ']),
          status: /完了|done/i.test(state) ? 'done' : /進行/i.test(state) ? 'doing' : 'todo',
          sort_order: 0,
          source_note_id: null,
          source_event_id: null,
          source_synced_at: null,
          source_todo_id: null,
          deleted_at: null,
          author_id: userId,
          author_name: displayName,
          created_at: new Date().toISOString(),
        })
      }

      if (rows.length === 0) {
        setError('取り込める行がありませんでした。「タイトル」の列が必要です。')
        return
      }

      for (const row of rows) todos.upsertLocal(row)
      const { error: insertError } = await supabase.from('todos').insert(rows)
      if (insertError) {
        for (const row of rows) todos.removeLocal(row.id)
        throw insertError
      }

      setResult(
        `${rows.length} 件のリマインドを取り込みました。${skipped > 0 ? `（${skipped} 行は読み取れず飛ばしました）` : ''}`,
      )
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="書き出し・取り込み" onClose={onClose}>
      <div className="space-y-6">
        <section>
          <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">書き出し</h3>
          <div className="flex flex-wrap gap-2">
            <ActionButton onClick={exportEvents}>📅 予定を CSV で保存</ActionButton>
            <ActionButton onClick={exportTodos}>⏰ リマインドを CSV で保存</ActionButton>
            <ActionButton onClick={exportIcs}>📤 カレンダー形式（.ics）</ActionButton>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            CSV は Excel でそのまま開けます（UTF-8 の BOM 付き）。
          </p>
        </section>

        {canEdit && (
          <section>
            <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">取り込み</h3>
            <div className="flex flex-wrap gap-2">
              <ActionButton disabled={busy} onClick={() => eventInputRef.current?.click()}>
                📅 予定の CSV を読み込む
              </ActionButton>
              <ActionButton disabled={busy} onClick={() => todoInputRef.current?.click()}>
                ⏰ リマインドの CSV を読み込む
              </ActionButton>
            </div>

            <input
              ref={eventInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importEvents(file)
              }}
            />
            <input
              ref={todoInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importTodos(file)
              }}
            />

            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
              <p className="mb-1 font-medium">列の名前</p>
              <p>予定: {EVENT_HEADERS.join(' / ')}</p>
              <p>リマインド: {TODO_HEADERS.join(' / ')}</p>
              <p className="mt-1 text-slate-400">
                必須は予定が「タイトル・開始」、リマインドが「タイトル」だけです。
                書き出した CSV をそのまま編集して読み込むのが確実です。
              </p>
            </div>
          </section>
        )}

        {result && (
          <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{result}</p>
        )}
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      </div>
    </Modal>
  )
}

function ActionButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function splitTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,、]+/)
    .map((tag) => tag.replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, 8)
}

function normalizeRecurrence(value: string | undefined) {
  const v = (value ?? '').trim().toLowerCase()
  if (['daily', '毎日'].includes(v)) return 'daily' as const
  if (['weekly', '毎週'].includes(v)) return 'weekly' as const
  if (['monthly', '毎月'].includes(v)) return 'monthly' as const
  if (['yearly', '毎年'].includes(v)) return 'yearly' as const
  return 'none' as const
}

/**
 * CSV の 1 行から繰り返しの 4 列を作る。
 * 規則に合わない組み合わせ（毎日なのに曜日つき、など）は normalizeRule が落とす。
 * 「繰り返しの間隔」列が無い古い CSV は parseInterval が 1 に倒す。
 */
function csvRule(item: Record<string, string>) {
  const rule = normalizeRule({
    recurrence: normalizeRecurrence(item['繰り返し']),
    days: parseWeekdays(item['繰り返しの曜日']),
    week: parseWeekOrdinal(item['繰り返しの週']),
    interval: parseInterval(item['繰り返しの間隔']),
  })
  return {
    recurrence: rule.recurrence,
    recurrence_days: rule.days,
    recurrence_week: rule.week,
    recurrence_interval: rule.interval ?? 1,
  }
}
