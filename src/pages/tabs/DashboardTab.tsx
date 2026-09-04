import { useMemo } from 'react'
import { addDays, format, isToday, parseISO, startOfDay } from 'date-fns'
import { ja } from 'date-fns/locale'
import { useNow } from '../../hooks/useReminders'
import { useRoomData } from '../../lib/roomData'
import { expandOccurrences } from '../../lib/recurrence'
import { colorForUser } from '../../hooks/usePresence'
import { EVENT_KIND_LABELS } from '../../lib/types'
import type { TabKey } from '../../components/RoomHeader'

interface Props {
  onJump: (tab: TabKey, id: string | null) => void
}

/**
 * いま全体がどうなっているかを、ひと目で見る画面。
 *
 * ここは「managing する画面」ではなく「みんなが今どうなっているかを知る画面」なので、
 * 数字・担当ごとの残り・今週の予定の 3 つだけに絞る。
 * 誰が何をしたかの記録は更新タブにあるので、こちらでは繰り返さない。
 */
export default function DashboardTab({ onJump }: Props) {
  const { todos, events, overrides, members } = useRoomData()
  const now = useNow()

  const upcoming = useMemo(
    () =>
      expandOccurrences(events.rows, now, addDays(now, 7), overrides.rows).sort(
        (a, b) => a.start.getTime() - b.start.getTime(),
      ),
    [events.rows, overrides.rows, now],
  )

  const stats = useMemo(() => {
    const open = todos.rows.filter((t) => !t.done)
    const overdue = open.filter((t) => t.due_at && parseISO(t.due_at) <= now)
    const today = open.filter((t) => t.due_at && isToday(parseISO(t.due_at)))
    const week = open.filter(
      (t) => t.due_at && parseISO(t.due_at) > now && parseISO(t.due_at) <= addDays(now, 7),
    )
    return { open, overdue, today, week }
  }, [todos.rows, now])

  /** 担当者ごとの持ち件数 */
  const byAssignee = useMemo(() => {
    const map = new Map<string, { name: string; open: number; overdue: number; done: number }>()
    const ensure = (id: string, name: string) => {
      if (!map.has(id)) map.set(id, { name, open: 0, overdue: 0, done: 0 })
      return map.get(id)!
    }

    for (const member of members.rows.filter((m) => m.status === 'approved')) {
      ensure(member.user_id, member.display_name || '名前なし')
    }

    for (const todo of todos.rows) {
      const id = todo.assignee_id ?? '__none__'
      const entry = ensure(id, todo.assignee_id ? todo.assignee_name || '名前なし' : '未割り当て')
      if (todo.done) entry.done++
      else {
        entry.open++
        if (todo.due_at && parseISO(todo.due_at) <= now) entry.overdue++
      }
    }

    return [...map.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .filter((entry) => entry.open > 0 || entry.done > 0)
      .sort((a, b) => b.open - a.open || b.done - a.done)
  }, [todos.rows, members.rows, now])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
        {/* 数字のまとめ */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="期限切れ"
            value={stats.overdue.length}
            accent="text-rose-600"
            onClick={() => onJump('todo', null)}
          />
          <StatCard
            label="今日が期限"
            value={stats.today.length}
            accent="text-amber-600"
            onClick={() => onJump('todo', null)}
          />
          <StatCard
            label="7日以内"
            value={stats.week.length}
            accent="text-slate-700"
            onClick={() => onJump('todo', null)}
          />
          <StatCard
            label="未完了ぜんぶ"
            value={stats.open.length}
            accent="text-slate-700"
            onClick={() => onJump('todo', null)}
          />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* 担当ごとの残り。誰が抱えているかが分かればよいので、数字だけにする */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-bold text-slate-700">担当ごとの残り</h3>
            {byAssignee.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">リマインドがありません。</p>
            ) : (
              <ul className="space-y-1">
                {byAssignee.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onJump('todo', null)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-slate-50"
                    >
                      <span
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
                        style={{ background: colorForUser(entry.id) }}
                      >
                        {entry.name.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{entry.name}</span>
                      <span className="shrink-0 text-xs text-slate-500">
                        残り {entry.open}
                        {entry.overdue > 0 && (
                          <span className="ml-1 text-rose-600">（超過 {entry.overdue}）</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* これからの予定と締切 */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-bold text-slate-700">今週の予定と締切</h3>
            {upcoming.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">予定はありません。</p>
            ) : (
              <ul className="space-y-1.5">
                {upcoming.slice(0, 8).map((occurrence) => (
                  <li key={occurrence.occurrenceKey}>
                    <button
                      type="button"
                      onClick={() => onJump('calendar', occurrence.event.id)}
                      className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left transition hover:bg-slate-50"
                    >
                      <span className="w-24 shrink-0 text-xs text-slate-500">
                        {format(occurrence.start, 'M/d(E)', { locale: ja })}
                        {!occurrence.view.all_day && ` ${format(occurrence.start, 'HH:mm')}`}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                        {EVENT_KIND_LABELS[occurrence.view.kind ?? 'event'].icon}{' '}
                        {occurrence.view.title}
                        {occurrence.view.kind === 'deadline' && (
                          <span className="ml-0.5 text-slate-400">〆</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <p className="text-center text-xs text-slate-400">
          {format(startOfDay(now), 'yyyy年M月d日(E)', { locale: ja })} 時点の状況です。
          <button
            type="button"
            onClick={() => onJump('updates', null)}
            className="ml-2 underline transition hover:text-slate-700"
          >
            誰が何を変えたかは「更新」で見られます
          </button>
        </p>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  accent,
  onClick,
}: {
  label: string
  value: number
  accent: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-400"
    >
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{label}</div>
    </button>
  )
}
