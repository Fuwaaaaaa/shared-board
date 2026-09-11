import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { addDays, format, isToday, startOfDay } from 'date-fns'
import { ja } from 'date-fns/locale'
import { supabase } from '../lib/supabase'
import {
  buildOverview,
  countOverview,
  OVERVIEW_DAYS,
  type OverviewItem,
  type OverviewRoom,
} from '../lib/overview'
import type { CalendarEvent, EventOverride, Todo } from '../lib/types'

/** 最初から開いておく件数。これを超えたぶんは「ほかに n 件」に畳む */
const SHOWN = 8

/*
 * 取りすぎないための天井。
 *
 * 1 ボードあたりの上限（やること 3000・予定 3000）はあるが、参加ボードの数には
 * 上限が無い。ここが無いと、ボードを何十個も持っている人のホームだけが重くなる。
 * 期限や開始の近い順に取るので、切られるのはいちばん遠いぶん。
 */
const CAP = 500

interface Props {
  /** 参加していて、終了していないボード。終了したボードは書けないので出さない */
  rooms: OverviewRoom[]
  userId: string
}

/**
 * ホームの「自分の番」。
 *
 * ボードを開かないと自分の担当が見えないのが、これまでの弱点だった。
 * ボードが 2〜3 個のうちは開いて確かめられるが、増えると「どれを開けばいいか」
 * から分からなくなる。
 *
 * 取り方は 3 本の問い合わせだけ（やること・予定・この回だけの変更）。
 * ボードごとに問い合わせない——参加ボードが 30 個あっても 3 本のままにしたい。
 * どのボードの行が返るかは RLS が決めるので、room_id で絞る必要もない。
 *
 * 繰り返しの展開を SQL でやらないのは、規則の写しを 3 つめにしないため
 * （いまは画面と Edge Function が supabase/functions/_shared/recurrence.ts を
 * 共有している）。サーバーでは窓に出てくる見込みのある行までを絞り、
 * 回に開くのは画面側でする。
 */
export default function MyOverview({ rooms, userId }: Props) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [overrides, setOverrides] = useState<EventOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  /*
   * 「いま」は読み込んだ時点で止める。毎回 new Date() を作ると、
   * 再描画のたびに区切りが動いて useMemo が効かなくなる。
   */
  const [now] = useState(() => new Date())

  useEffect(() => {
    let alive = true
    const from = startOfDay(now).toISOString()
    const to = addDays(now, OVERVIEW_DAYS).toISOString()

    void (async () => {
      const [todoRes, eventRes, overrideRes] = await Promise.all([
        supabase
          .from('todos')
          .select('*')
          .eq('assignee_id', userId)
          .eq('done', false)
          .is('deleted_at', null)
          .not('due_at', 'is', null)
          .lte('due_at', to)
          .order('due_at')
          .limit(CAP),
        supabase
          .from('events')
          .select('*')
          .is('deleted_at', null)
          /*
           * 繰り返しは start_at で切らない。切ってよさそうに見えるが、2 方向とも危ない。
           *
           *   手前 … 3 か月前に始めた定例は start_at が窓のはるか手前にある。
           *   先   … 3 週間後に始まる系列の回を「この回だけ」で今週へ前倒しすると、
           *          元の行の start_at は窓より先のまま。
           *
           * どちらも展開の側（expandOccurrences）は手当てしているので、
           * ここで先に落とさないことだけが要る。繰り返しの行そのものは多くない。
           *
           * 繰り返さない予定は窓で切る。終わりが窓に入るもの（またがっている旅行）も拾う。
           */
          .or(
            `recurrence.neq.none,and(start_at.lte.${to},or(end_at.gte.${from},start_at.gte.${from}))`,
          )
          .order('start_at')
          .limit(CAP),
        /*
         * 「この回だけ」は日付で絞らない。ある回を窓の外から窓の中へ動かした
         * 変更は、控えの側が元の日付で並ぶので、窓で切ると取りこぼす。
         * 1 ボード 5000 件までの表なので、まとめて取っても軽い。
         */
        supabase.from('event_overrides').select('*').limit(CAP),
      ])

      if (!alive) return
      setTodos((todoRes.data ?? []) as Todo[])
      setEvents((eventRes.data ?? []) as CalendarEvent[])
      setOverrides((overrideRes.data ?? []) as EventOverride[])
      setLoading(false)
    })()

    return () => {
      alive = false
    }
  }, [userId, now])

  const items = useMemo(
    () => buildOverview({ rooms, todos, events, overrides }, now),
    [rooms, todos, events, overrides, now],
  )
  const counts = useMemo(() => countOverview(items), [items])

  // 読み込み中と、本当に何も無いときは場所を取らない
  if (loading || items.length === 0) return null

  const shown = expanded ? items : items.slice(0, SHOWN)

  return (
    <section className="mb-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-lg font-bold text-slate-800">自分の番</h2>
      <p className="mb-5 text-sm text-slate-500">
        参加しているボードを跨いで、自分の担当と{OVERVIEW_DAYS} 日先までの予定を集めています。
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="期限切れ" count={counts.overdue} tone="alert" />
        <Tile label="今日のやること" count={counts.todayTodo} />
        <Tile label="今日の予定" count={counts.todayEvent} />
        <Tile label="今週" count={counts.week} />
      </div>

      <ul className="overflow-hidden rounded-xl border border-slate-200">
        {shown.map((item) => (
          <li key={item.key} className="border-b border-slate-100 last:border-b-0">
            <Link
              to={linkTo(item)}
              className="flex items-center gap-3 px-3 py-2.5 text-sm transition hover:bg-slate-50"
            >
              <span className="shrink-0" aria-hidden>
                {item.kind === 'todo' ? '⏰' : '📅'}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-700">{item.title}</span>
              <span className="shrink-0 text-xs text-slate-400">{item.room.name}</span>
              <span
                className={`shrink-0 text-xs ${
                  item.bucket === 'overdue' ? 'font-medium text-rose-600' : 'text-slate-400'
                }`}
              >
                {whenLabel(item)}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {items.length > SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 text-sm text-slate-500 transition hover:text-slate-800"
        >
          {expanded ? '畳む' : `ほかに ${items.length - SHOWN} 件`}
        </button>
      )}
    </section>
  )
}

/** 押したら、そのボードの該当タブを開いて、その行まで飛ぶ（RoomPage が受ける） */
function linkTo(item: OverviewItem): string {
  const tab = item.kind === 'todo' ? 'todo' : 'calendar'
  return `/r/${item.room.slug}?tab=${tab}&focus=${item.targetId}`
}

/**
 * いつのことか。
 *
 * 日付まで書くと 1 行が長くなるので、今日のものは時刻だけにする。
 * 終日の予定は時刻を出さない（0:00 と書くと、朝いちの予定に見える）。
 */
function whenLabel(item: OverviewItem): string {
  if (item.allDay) return isToday(item.at) ? '終日' : format(item.at, 'M/d(E)', { locale: ja })
  if (isToday(item.at)) return format(item.at, 'HH:mm')
  return format(item.at, 'M/d(E) HH:mm', { locale: ja })
}

function Tile({ label, count, tone }: { label: string; count: number; tone?: 'alert' }) {
  const alert = tone === 'alert' && count > 0
  return (
    <div
      className={`rounded-xl border p-3 ${
        alert ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className={`text-2xl font-bold ${alert ? 'text-rose-700' : 'text-slate-800'}`}>
        {count}
      </div>
      <div className={`text-xs ${alert ? 'text-rose-600' : 'text-slate-500'}`}>{label}</div>
    </div>
  )
}
