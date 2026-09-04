/*
 * 繰り返し予定の展開。フロントと Edge Function（send-reminders）で共有する。
 *
 * 回は「基準日から n 回目」を直接計算する（nthOccurrence）。前の回に 1 か月ずつ足していく
 * 方式だと 1/31 → 2/28 → 3/28 と月末が縮んでいくが、基準から数えれば 3/31 に戻る。
 * 表示範囲の手前の回は数えずに飛ばすので、何年も前に始まった繰り返しでも上限に当たらない。
 */

import {
  DAY_MS,
  boardStamp,
  daysInMonth,
  fromBoardParts,
  toBoardDate,
  toBoardParts,
  untilLimit,
} from './dates.ts'

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

/** 暴走防止。表示範囲に入る回の上限（範囲の手前は数えない） */
export const MAX_OCCURRENCES_IN_RANGE = 400

/**
 * 基準日から数えて n 回目（0 が基準日そのもの）の開始時刻。
 *
 * daily / weekly はミリ秒の加算（JST は夏時間がないので壁時計がずれない）。
 * monthly / yearly は JST の壁時計で月・年を進め、日は月末で丸める（1/31 → 2/28、2/29 → 翌年 2/28）。
 */
export function nthOccurrence(base: Date, rec: Recurrence, n: number, interval = 1): Date {
  const steps = n * interval
  switch (rec) {
    case 'daily':
      return new Date(base.getTime() + steps * DAY_MS)
    case 'weekly':
      return new Date(base.getTime() + steps * 7 * DAY_MS)
    case 'monthly': {
      const p = toBoardParts(base)
      const total = p.m - 1 + steps
      const y = p.y + Math.floor(total / 12)
      const m = (((total % 12) + 12) % 12) + 1
      return fromBoardParts({ ...p, y, m, d: Math.min(p.d, daysInMonth(y, m)) })
    }
    case 'yearly': {
      const p = toBoardParts(base)
      const y = p.y + steps
      return fromBoardParts({ ...p, y, d: Math.min(p.d, daysInMonth(y, p.m)) })
    }
    default:
      return new Date(base.getTime())
  }
}

/**
 * 開始が from 以上になる最初の回の番号（0 以上）。
 * 差分から当たりをつけ、前後に 1 つずつ動かして正確な位置に合わせる。
 */
export function firstIndexAtOrAfter(base: Date, rec: Recurrence, from: Date, interval = 1): number {
  if (rec === 'none' || from <= base) return 0

  let n: number
  const diffMs = from.getTime() - base.getTime()
  if (rec === 'daily') {
    n = Math.floor(diffMs / (interval * DAY_MS))
  } else if (rec === 'weekly') {
    n = Math.floor(diffMs / (interval * 7 * DAY_MS))
  } else {
    const b = toBoardParts(base)
    const f = toBoardParts(from)
    const months = (f.y - b.y) * 12 + (f.m - b.m)
    n = Math.floor((rec === 'monthly' ? months : f.y - b.y) / interval)
  }
  if (n < 0) n = 0

  const nth = (i: number) => nthOccurrence(base, rec, i, interval)
  while (nth(n) < from) n++
  while (n > 0 && nth(n - 1) >= from) n--
  return n
}

// ----------------------------------------------------------------------------
//  例外（この回だけ）を重ねた展開

/** 展開に必要な予定の列。フロントの CalendarEvent も DB の行もこれを満たす */
export interface EventLike {
  id: string
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
}

/** 例外行。canceled=false の行は差分ではなく表示に必要な値を丸ごと持つ */
export interface OverrideLike {
  event_id: string
  /** 元の回の開始日（'yyyy-MM-dd'、JST）。occurrenceKeyDate で作る */
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
}

/** 繰り返しを展開した 1 回分 */
export interface Occurrence<E extends EventLike, O extends OverrideLike> {
  /** DB 上の元の 1 行 */
  event: E
  /** 例外を当てたあとの表示用の値 */
  view: E
  /** 実効の開始（この回だけ動かしたあと） */
  start: Date
  end: Date | null
  /** 元の回の開始。例外の同定に使うので、動かしても変わらない */
  originalStart: Date
  override: O | null
  occurrenceKey: string
}

/** React の key と同定に使う。引数は「元の回の開始」なので、動かしても変わらない */
export function occurrenceKey(eventId: string, originalStart: Date): string {
  return `${eventId}@${boardStamp(originalStart)}`
}

/** 例外テーブルの一意キー（event_id + 元の回の開始日） */
export function overrideKeyOf(eventId: string, originalStart: Date): string {
  return `${eventId}|${toBoardDate(originalStart)}`
}

/**
 * 例外行の occurrence_date から「元の回の開始時刻」を復元する。
 * 日付は例外の値、時刻は元の予定の JST 時刻を使う。
 */
export function originalStartFor(event: Pick<EventLike, 'start_at'>, occurrenceDate: string): Date {
  const base = toBoardParts(new Date(event.start_at))
  const [y, m, d] = occurrenceDate.slice(0, 10).split('-').map(Number)
  return fromBoardParts({ ...base, y, m, d })
}

export function buildOverrideMap<O extends OverrideLike>(overrides: O[]): Map<string, O> {
  const map = new Map<string, O>()
  for (const override of overrides) {
    map.set(`${override.event_id}|${override.occurrence_date}`, override)
  }
  return map
}

/** 元の予定に例外を重ねて、その回の表示用の値を作る */
export function applyOverride<E extends EventLike, O extends OverrideLike>(
  event: E,
  override: O | null,
): E {
  if (!override || override.canceled) return event
  return {
    ...event,
    title: override.title ?? event.title,
    description: override.description ?? event.description,
    start_at: override.start_at ?? event.start_at,
    end_at: override.end_at,
    all_day: override.all_day ?? event.all_day,
    color: override.color ?? event.color,
    remind_minutes: override.remind_minutes,
    tags: override.tags ?? event.tags,
  }
}

/** 予定の実効の期間が表示範囲にかかっているか */
function intersects(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): boolean {
  return (end ?? start) >= rangeStart && start <= rangeEnd
}

function makeOccurrence<E extends EventLike, O extends OverrideLike>(
  event: E,
  originalStart: Date,
  fallbackEnd: Date | null,
  override: O | null,
): Occurrence<E, O> {
  const view = applyOverride(event, override)
  const moved = Boolean(override && !override.canceled && override.start_at)
  const start = moved ? new Date(view.start_at) : originalStart
  const end = moved ? (view.end_at ? new Date(view.end_at) : null) : fallbackEnd

  return {
    event,
    view,
    start,
    end,
    originalStart,
    override: override && !override.canceled ? override : null,
    occurrenceKey: occurrenceKey(event.id, originalStart),
  }
}

/**
 * 予定を「表示範囲に現れる 1 回ずつ」に展開する。
 * 繰り返しなしの予定はそのまま 1 件になる。
 *
 * 繰り返しの回に「この回だけ」の変更（overrides）があれば、それを重ねてから範囲で絞る。
 * 削除された回は結果に現れない。
 */
export function expandOccurrences<E extends EventLike, O extends OverrideLike>(
  events: E[],
  rangeStart: Date,
  rangeEnd: Date,
  overrides: O[],
): Occurrence<E, O>[] {
  const result: Occurrence<E, O>[] = []
  const overrideMap = buildOverrideMap(overrides)
  const emitted = new Set<string>()

  const push = (occurrence: Occurrence<E, O>) => {
    if (!intersects(occurrence.start, occurrence.end, rangeStart, rangeEnd)) return
    if (emitted.has(occurrence.occurrenceKey)) return
    emitted.add(occurrence.occurrenceKey)
    result.push(occurrence)
  }

  for (const event of events) {
    const baseStart = new Date(event.start_at)
    const baseEnd = event.end_at ? new Date(event.end_at) : null
    const durationMs = baseEnd ? Math.max(0, baseEnd.getTime() - baseStart.getTime()) : 0

    if (event.recurrence === 'none') {
      push(makeOccurrence<E, O>(event, baseStart, baseEnd, null))
      continue
    }

    const limit = untilLimit(event.recurrence_until)
    // 範囲の手前で始まって範囲にかかる回（複数日の予定）も拾えるよう、長さのぶんだけ前から見る
    const first = firstIndexAtOrAfter(
      baseStart,
      event.recurrence,
      new Date(rangeStart.getTime() - durationMs),
    )

    let emittedCount = 0
    for (let i = first; emittedCount < MAX_OCCURRENCES_IN_RANGE; i++) {
      const cursor = nthOccurrence(baseStart, event.recurrence, i)
      if (cursor > rangeEnd) break
      if (limit && cursor >= limit) break
      emittedCount++

      const override = overrideMap.get(overrideKeyOf(event.id, cursor)) ?? null
      if (override?.canceled) continue

      const end = durationMs > 0 ? new Date(cursor.getTime() + durationMs) : null
      push(makeOccurrence(event, cursor, end, override))
    }
  }

  // 元の回が表示範囲の外でも、動かした先が範囲に入るものを拾う。
  // 上のループは「元の回」を範囲で打ち切るので、ここで補う。
  if (overrides.length > 0) {
    const byId = new Map(events.map((event) => [event.id, event]))

    for (const override of overrides) {
      if (override.canceled || !override.start_at) continue

      const event = byId.get(override.event_id)
      if (!event || event.recurrence === 'none') continue

      const originalStart = originalStartFor(event, override.occurrence_date)
      if (originalStart >= rangeStart && originalStart <= rangeEnd) continue // 上で処理済み

      push(makeOccurrence(event, originalStart, null, override))
    }
  }

  return result
}

/**
 * 繰り返し TODO を完了したときの、次回の期限。
 * 期限を過ぎたまま放置されていても、now より後の回を直接求める。
 */
export function nextDueDate(dueAt: string, rec: Recurrence, now: Date = new Date()): string | null {
  if (rec === 'none') return null

  const base = new Date(dueAt)
  // 「now より後」= 「now + 1ms 以上」。少なくとも 1 回は進める
  const n = Math.max(1, firstIndexAtOrAfter(base, rec, new Date(now.getTime() + 1)))
  return nthOccurrence(base, rec, n).toISOString()
}
