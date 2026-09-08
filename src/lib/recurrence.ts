/*
 * 繰り返し予定の展開（フロント側の入り口）。
 *
 * 計算本体は supabase/functions/_shared/recurrence.ts にあり、Edge Function と共有している。
 * ここでは公開 API 名を保ちつつ、閲覧者のタイムゾーン補正と date-fns を使う日ごとの振り分けを足す。
 */

import { addDays, format, startOfDay } from 'date-fns'
import {
  expandOccurrences as expandShared,
  nextDueDate as nextDueDateShared,
  buildOverrideMap,
  firstIndexAtOrAfter,
  firstMatchingStart,
  hasByDay,
  normalizeRule,
  nthOccurrence,
  occurrenceKey,
  originalStartFor,
  overrideKeyOf,
  ruleOf,
  stepDates,
  type RecurrenceRule,
} from '../../supabase/functions/_shared/recurrence.ts'
import { DAY_MS, isBoardTimeZone, localDateOf, toBoardDate } from './dates'
import {
  MONTH_WEEK_LABELS,
  RECURRENCE_LABELS,
  WEEKDAY_LABELS,
  type CalendarEvent,
  type EventOccurrence,
  type EventOverride,
  type Recurrence,
} from './types'

export {
  buildOverrideMap,
  firstIndexAtOrAfter,
  firstMatchingStart,
  hasByDay,
  normalizeRule,
  nthOccurrence,
  occurrenceKey,
  originalStartFor,
  overrideKeyOf,
  ruleOf,
  stepDates,
}
export type { RecurrenceRule }

/**
 * 画面に出す繰り返しの言い方。「毎週 火・木」「毎月 第2火曜」「毎月 最終火曜」。
 *
 * 文言だけをフロントに置いているのは、_shared に画面用の日本語を持ち込まないため
 * （Edge Function 側では要らないし、RECURRENCE_LABELS を二重に持つことになる）。
 */
export function recurrenceLabel(rule: RecurrenceRule): string {
  const base = RECURRENCE_LABELS[rule.recurrence]
  if (!hasByDay(rule)) return base

  if (rule.recurrence === 'weekly') {
    return `${base} ${rule.days.map((d) => WEEKDAY_LABELS[d]).join('・')}`
  }
  return `${base} ${MONTH_WEEK_LABELS[String(rule.week)] ?? ''}${WEEKDAY_LABELS[rule.days[0]]}曜`
}

/** 予定の実効の期間が表示範囲にかかっているか */
function intersects(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): boolean {
  return (end ?? start) >= rangeStart && start <= rangeEnd
}

/**
 * 海外から見ている人向けに、終日予定を「JST の日付」のローカル 0:00〜23:59 に置き直す。
 * 終日予定は JST 0:00 で保存されているので、そのままだと海外では前日の夕方に見えてしまう。
 * originalStart は例外の同定に使うので触らない。
 */
function pinAllDay(occurrence: EventOccurrence): EventOccurrence {
  if (!occurrence.view.all_day) return occurrence

  const start = localDateOf(toBoardDate(occurrence.start))
  let end: Date | null = null
  if (occurrence.end) {
    end = localDateOf(toBoardDate(occurrence.end))
    end.setHours(23, 59, 0, 0)
  }
  return { ...occurrence, start, end }
}

/**
 * 予定を「表示範囲に現れる 1 回ずつ」に展開する。
 * 繰り返しなしの予定はそのまま 1 件になる。削除された回は結果に現れない。
 */
export function expandOccurrences(
  events: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date,
  overrides: EventOverride[],
): EventOccurrence[] {
  if (isBoardTimeZone()) return expandShared(events, rangeStart, rangeEnd, overrides)

  // 置き直すと範囲の内外が最大 1 日ずれるので、少し広く展開してから絞る
  const widened = expandShared(
    events,
    new Date(rangeStart.getTime() - DAY_MS),
    new Date(rangeEnd.getTime() + DAY_MS),
    overrides,
  )
  return widened
    .map(pinAllDay)
    .filter((occurrence) => intersects(occurrence.start, occurrence.end, rangeStart, rangeEnd))
}

/**
 * 予定を「その予定が乗る日」ごとに振り分ける。
 * 複数日にまたがる予定は、またがる全ての日に現れる。
 */
export function groupOccurrencesByDay(
  occurrences: EventOccurrence[],
): Map<string, EventOccurrence[]> {
  const map = new Map<string, EventOccurrence[]>()

  for (const occurrence of occurrences) {
    const lastDay = startOfDay(occurrence.end ?? occurrence.start)
    let day = startOfDay(occurrence.start)

    // 1 件の予定が極端に長くても 366 日で打ち切る
    for (let i = 0; i < 366; i++) {
      const key = format(day, 'yyyy-MM-dd')
      const list = map.get(key)
      if (list) list.push(occurrence)
      else map.set(key, [occurrence])

      if (day >= lastDay) break
      day = addDays(day, 1)
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => {
      if (a.view.all_day !== b.view.all_day) return a.view.all_day ? -1 : 1
      return a.start.getTime() - b.start.getTime()
    })
  }

  return map
}

/** 繰り返し TODO を完了したときの、次回の期限（過去に放置されていても未来の回になる） */
export function nextDueDate(
  dueAt: string,
  recurrence: Recurrence | RecurrenceRule,
): string | null {
  return nextDueDateShared(dueAt, recurrence)
}
