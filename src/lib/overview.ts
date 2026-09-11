/*
 * ホーム画面の「自分の番」。
 *
 * ボードを跨いで、自分の担当のやることと、これから起きる予定を 1 か所に集める。
 *
 * ルームの中にも 📊 ダッシュボードがあるが、あちらは「このボードがいま
 * どうなっているか」を見る画面で、開いてからでないと見えない。こちらは
 * その手前——「どのボードを開けばいいか」を決めるための画面で、
 * ボードが増えるほど効いてくる。
 *
 * 区切り（期限切れ / 今日 / 今週）の境目はコードを読むだけでは分からないので、
 * 判断をここへ出してテストで固定する。集めるところ（HomePage）は
 * この関数に渡すだけにしてある。
 */

import { addDays, endOfDay, isSameDay, startOfDay } from 'date-fns'
import { expandOccurrences } from './recurrence'
import type { CalendarEvent, EventOverride, Todo } from './types'

/** 今日より先を何日ぶん見るか */
export const OVERVIEW_DAYS = 7

export type OverviewBucket = 'overdue' | 'today' | 'week'

export interface OverviewRoom {
  id: string
  slug: string
  name: string
}

export interface OverviewItem {
  /** 画面の key。予定は回ごとに違う値になる */
  key: string
  kind: 'todo' | 'event'
  bucket: OverviewBucket
  room: OverviewRoom
  /** 飛び先。予定は繰り返しの元の行を指す */
  targetId: string
  title: string
  at: Date
  allDay: boolean
}

export interface OverviewInput {
  /** 参加しているボード。ここに無いボードの行は捨てる */
  rooms: OverviewRoom[]
  /** 自分の担当のやること（done と deleted_at は呼ぶ側で外しておく） */
  todos: Todo[]
  events: CalendarEvent[]
  overrides: EventOverride[]
}

/**
 * やることの区切り。
 *
 * 3 つは重ならない。DashboardTab の数え方は「今日」と「期限切れ」が重なるが、
 * あちらは並べて見せる数で、こちらは足して意味を持たせる数なので分けている。
 * 期限の無いやることは出さない——日付で区切る画面に、日付の無いものは置けない。
 */
export function bucketOfDue(due: Date, now: Date): OverviewBucket | null {
  if (due.getTime() <= now.getTime()) return 'overdue'
  if (isSameDay(due, now)) return 'today'
  if (due.getTime() <= addDays(now, OVERVIEW_DAYS).getTime()) return 'week'
  return null
}

/**
 * 予定の区切り。
 *
 * 予定に「期限切れ」は無い。今日の 9 時の打ち合わせは、15 時に見ても
 * 今日の予定のまま——過ぎたことは分かっていて、それでも今日の顔ぶれに要る。
 *
 * 始まりではなく「今日にかかっているか」で見る。始まりだけを見ると、
 * 8/1〜8/3 の旅行が 8/2 に消える（始まったのは昨日なので）。
 */
export function bucketOfOccurrence(start: Date, end: Date | null, now: Date): OverviewBucket | null {
  const finish = end ?? start
  if (start.getTime() <= endOfDay(now).getTime() && finish.getTime() >= startOfDay(now).getTime()) {
    return 'today'
  }
  if (start.getTime() < now.getTime()) return null
  if (start.getTime() <= addDays(now, OVERVIEW_DAYS).getTime()) return 'week'
  return null
}

/**
 * ボードを跨いで集める。
 *
 * 並びは「近いものから」。期限切れは過ぎた順（いちばん古いものが上）ではなく、
 * ほかと同じ時刻順にしてある。上から順に片付ければいいようにしたいので、
 * 区切りをまたいでも 1 本の時系列で読めるほうがいい。
 */
export function buildOverview(input: OverviewInput, now: Date): OverviewItem[] {
  const roomById = new Map(input.rooms.map((room) => [room.id, room]))
  const items: OverviewItem[] = []

  for (const todo of input.todos) {
    const room = roomById.get(todo.room_id)
    if (!room || !todo.due_at) continue
    const due = new Date(todo.due_at)
    const bucket = bucketOfDue(due, now)
    if (!bucket) continue

    items.push({
      key: `todo:${todo.id}`,
      kind: 'todo',
      bucket,
      room,
      targetId: todo.id,
      title: todo.title,
      at: due,
      allDay: false,
    })
  }

  /*
   * 予定は展開してから区切る。繰り返しの規則をここで解き直さないのは、
   * 展開の本体が supabase/functions/_shared/recurrence.ts にあり、
   * 画面と Edge Function がそれを共有しているため。3 つめの写しは作らない。
   *
   * 今日の朝から数えるのは、もう始まった今日の予定も出したいから。
   */
  const from = startOfDay(now)
  const to = addDays(now, OVERVIEW_DAYS)

  for (const occurrence of expandOccurrences(input.events, from, to, input.overrides)) {
    const room = roomById.get(occurrence.event.room_id)
    if (!room) continue
    const bucket = bucketOfOccurrence(occurrence.start, occurrence.end, now)
    if (!bucket) continue

    items.push({
      key: `event:${occurrence.occurrenceKey}`,
      kind: 'event',
      bucket,
      room,
      targetId: occurrence.event.id,
      title: occurrence.view.title,
      at: occurrence.start,
      allDay: occurrence.view.all_day,
    })
  }

  return items.sort((a, b) => a.at.getTime() - b.at.getTime() || a.key.localeCompare(b.key))
}

export interface OverviewCounts {
  overdue: number
  todayTodo: number
  todayEvent: number
  week: number
}

/** 見出しに出す 4 つの数。items と同じ元から数えるので、足しても合う */
export function countOverview(items: OverviewItem[]): OverviewCounts {
  const counts: OverviewCounts = { overdue: 0, todayTodo: 0, todayEvent: 0, week: 0 }
  for (const item of items) {
    if (item.bucket === 'overdue') counts.overdue++
    else if (item.bucket === 'week') counts.week++
    else if (item.kind === 'todo') counts.todayTodo++
    else counts.todayEvent++
  }
  return counts
}
