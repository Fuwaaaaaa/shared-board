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

/*
 * 区切り（週・月）を進める回数の上限。
 *
 * 曜日指定では「1 区切りが 1 回も生まない」ことがある（第 5 火曜の無い月）。
 * 出た回だけを数えていると、そういう月が続いたときに回り続けてしまう。
 */
export const MAX_STEPS_IN_RANGE = 500

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
//  曜日指定（毎週 火・木 / 毎月 第 2 火曜）

/**
 * 「n 回ごと」の上限。
 *
 * supabase/schema.sql の events_recurrence_interval_check と同じ数で、
 * 曜日の決まりと同じく 2 か所に写しがある。変えるときは両方そろえること。
 */
export const MAX_INTERVAL = 99

/**
 * 繰り返しの規則。
 *
 * days は 0=日 … 6=土。毎週なら「出す曜日」、毎月の第 n 曜日なら曜日を 1 つだけ持つ。
 * week は毎月の第 n 週（1〜5、-1 は最終）。null なら開始日と同じ日付で繰り返す。
 * interval は「n 回ごと」（1〜MAX_INTERVAL）。省略は 1 で、毎回という意味。
 *
 * 既定（days が空・week が null・interval が 1）は曜日指定なしで、
 * 従来の nthOccurrence と同じ動きになる。
 */
export interface RecurrenceRule {
  recurrence: Recurrence
  days: number[]
  week: number | null
  /** 省略は 1。任意にしてあるのは、既存の呼び出しをそのまま通すため */
  interval?: number
}

/** DB の行やフロントの下書きから規則を取り出すための、緩い形 */
export interface RecurrenceFields {
  recurrence: Recurrence
  recurrence_days?: number[] | null
  recurrence_week?: number | null
  recurrence_interval?: number | null
}

/**
 * 規則から使える間隔を取り出す。
 *
 * 列が無い（この機能より前からある）行は null で届き、1 として読む。
 * DB には「古い行の null」と「画面から保存し直した行の 1」が混ざるので、
 * 比べるときは必ずここを通すこと（片方を素の値で見ると、開いて保存し直した
 * だけの予定が「並びが変わった」と判定され、出欠が消える）。
 */
function intervalOf(rule: RecurrenceRule): number {
  const n = Math.trunc(rule.interval ?? 1)
  return Number.isFinite(n) && n >= 1 && n <= MAX_INTERVAL ? n : 1
}

/**
 * 行から規則を取り出す。
 * 列が無い（この機能より前からある）行でも、従来どおりの意味になる。
 */
export function ruleOf(row: RecurrenceFields): RecurrenceRule {
  return normalizeRule({
    recurrence: row.recurrence,
    days: row.recurrence_days ?? [],
    week: row.recurrence_week ?? null,
    interval: row.recurrence_interval ?? 1,
  })
}

/**
 * 保存前・使用前の正規化。並べ替え・重複除去と、規則に合わない値の切り落とし。
 *
 * DB の CHECK（supabase/schema.sql の events_recurrence_days_check と
 * events_recurrence_interval_check）と同じ決まりを持つ。
 * 押してから断られるのを避けるためで、合言葉の最短の長さと同じ理由。
 * ここを変えるときは schema.sql も一緒に変えること。
 */
export function normalizeRule(rule: RecurrenceRule): RecurrenceRule {
  const rec = rule.recurrence
  // 繰り返さない予定に間隔は無い（CHECK も 1 以外を受け付けない）
  const interval = rec === 'none' ? 1 : intervalOf(rule)

  // 曜日を持てるのは 毎週 と 毎月 だけ
  if (rec !== 'weekly' && rec !== 'monthly') {
    return { recurrence: rec, days: [], week: null, interval }
  }

  const days = [...new Set(rule.days)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b)

  if (rec === 'weekly') return { recurrence: rec, days, week: null, interval }

  // 毎月の第 n 曜日は、曜日をちょうど 1 つと第 n 週の両方が要る
  const week = rule.week
  const usable = week !== null && week !== 0 && week >= -1 && week <= 5 && days.length > 0
  if (!usable) return { recurrence: rec, days: [], week: null, interval }
  return { recurrence: rec, days: [days[0]], week, interval }
}

/** 曜日指定があるか。無ければ従来の経路をそのまま通す */
export function hasByDay(rule: RecurrenceRule): boolean {
  if (rule.recurrence === 'weekly') return rule.days.length > 0
  if (rule.recurrence === 'monthly') return rule.week !== null && rule.days.length > 0
  return false
}

/** JST での曜日（0=日 … 6=土） */
function boardWeekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * n 番目の区切りの「先頭」。毎週ならその週の日曜、毎月ならその月の 1 日。
 *
 * 区切りが生むどの回よりも早い日なので、打ち切りの判定に使える
 * （先頭が範囲より後なら、その区切りの回はすべて範囲より後）。
 * 曜日指定が無いときは区切りが 1 回しか生まないので、その回そのもの。
 */
function stepAnchor(base: Date, rule: RecurrenceRule, n: number): Date {
  const interval = intervalOf(rule)
  if (!hasByDay(rule)) return nthOccurrence(base, rule.recurrence, n, interval)

  const p = toBoardParts(base)
  if (rule.recurrence === 'weekly') {
    const weekday = boardWeekday(p.y, p.m, p.d)
    return fromBoardParts({ ...p, d: p.d - weekday + n * interval * 7, hh: 0, mm: 0, ss: 0, ms: 0 })
  }
  // 毎月
  const total = p.m - 1 + n * interval
  const y = p.y + Math.floor(total / 12)
  const m = (((total % 12) + 12) % 12) + 1
  return fromBoardParts({ y, m, d: 1, hh: 0, mm: 0, ss: 0, ms: 0 })
}

/**
 * n 番目の区切りが生む回（昇順）。時刻は base の JST 壁時計をそのまま使う。
 *
 * 週の先頭は日曜に固定する。閲覧者ごとの「週の始まり」設定に合わせると、
 * 同じ予定が人によって違う日に出てしまい、Edge Function 側では決めようがない。
 *
 * 「n 週ごと」を選ぶと、この起点が結果に効くようになる（「隔週 火・木」を
 * 木曜から始めると、最初の週は木だけ、2 週間後から火・木の両方が出る）。
 * RFC 5545 でいう WKST=SU そのもので、_shared/ics.ts の rruleFor も同じ枝で
 * WKST=SU を書き出す。片方だけ変えると、自分の画面と取り込み先で違う日に出る。
 *
 * base より前の回は出さない（RFC 5545 の「DTSTART が下限」と同じ）。
 */
export function stepDates(base: Date, rule: RecurrenceRule, n: number): Date[] {
  const keep = (dates: Date[]) => dates.filter((d) => d >= base)
  const interval = intervalOf(rule)

  if (!hasByDay(rule)) {
    if (rule.recurrence === 'none') return n === 0 ? [new Date(base.getTime())] : []
    return keep([nthOccurrence(base, rule.recurrence, n, interval)])
  }

  const p = toBoardParts(base)

  if (rule.recurrence === 'weekly') {
    const weekday = boardWeekday(p.y, p.m, p.d)
    const sunday = p.d - weekday + n * interval * 7
    return keep(rule.days.map((dow) => fromBoardParts({ ...p, d: sunday + dow })))
  }

  // 毎月の第 n 曜日
  const total = p.m - 1 + n * interval
  const y = p.y + Math.floor(total / 12)
  const m = (((total % 12) + 12) % 12) + 1
  const dow = rule.days[0]
  const week = rule.week as number

  let day: number
  if (week === -1) {
    const last = daysInMonth(y, m)
    day = last - ((boardWeekday(y, m, last) - dow + 7) % 7)
  } else {
    day = 1 + ((dow - boardWeekday(y, m, 1) + 7) % 7) + (week - 1) * 7
    // 「第 5 火曜」が無い月は、丸めずに飛ばす（.ics の FREQ=MONTHLY と同じ読み方）
    if (day > daysInMonth(y, m)) return []
  }
  return keep([fromBoardParts({ ...p, y, m, d: day })])
}

/**
 * 規則に合う最初の開始。
 *
 * RFC 5545 は DTSTART が規則を満たすことを求めていて、満たさないときの
 * 扱いは取り込み先ごとに違う。金曜の予定に「毎週 火」を選んだら開始を
 * 次の火曜へ寄せておかないと、Google などで金曜の回が 1 つだけ余分に出る。
 *
 * 寄せるときだけは間隔を見ない（interval: 1 で探す）。土曜に「隔週 火」を
 * 選んだとき、開始日の週の火曜は開始より前なので落ち、間隔を見たまま次の
 * 区切りへ進むと 10 日後の火曜になる。押した人が待っているのは 3 日後の火曜。
 * 寄せは「規則に合う最初の日を探す」だけの操作で、位相は寄せ先を新しい
 * 第 0 週と読み替えれば自己整合する（週 0 が何も生まないなら、その週を
 * 数え始めの週にしても系列は同じ）。
 */
export function firstMatchingStart(startIso: string, rule: RecurrenceRule): string {
  const normalized = normalizeRule(rule)
  if (!hasByDay(normalized)) return startIso

  const base = new Date(startIso)
  const everyStep = { ...normalized, interval: 1 }
  for (let i = 0; i < MAX_STEPS_IN_RANGE; i++) {
    const dates = stepDates(base, everyStep, i)
    if (dates.length > 0) return dates[0].toISOString()
  }
  return startIso
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
  /** 曜日指定（0=日 … 6=土）。空なら開始日の曜日だけ */
  recurrence_days: number[]
  /** 毎月の第 n 週（1〜5、-1 は最終）。null なら開始日と同じ日付 */
  recurrence_week: number | null
  /** 「n 回ごと」。null は 1（毎回）と同じ */
  recurrence_interval: number | null
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

    const rule = ruleOf(event)
    const limit = untilLimit(event.recurrence_until)
    // 範囲の手前で始まって範囲にかかる回（複数日の予定）も拾えるよう、長さのぶんだけ前から見る
    const from = new Date(rangeStart.getTime() - durationMs)
    /*
     * 間隔を必ず渡すこと。
     *
     * 渡さないと at は「区切りの本数」ではなく「週・月の本数」になり、
     * 一方 stepDates は 1 区切りで interval ぶん進むので、数え始めた区切りが
     * 範囲のはるか先を指す。下の stepAnchor が即 break して、その予定は
     * 1 件も出ない——例外もログも出ず、画面から黙って消える。
     */
    const at = firstIndexAtOrAfter(baseStart, event.recurrence, from, rule.interval)

    /*
     * 曜日指定のときは 1 区切り手前から見る。
     *
     * firstIndexAtOrAfter が数えているのは「開始日と同じ曜日 / 同じ日付」の回で、
     * 実際に出る回はそれより前に来ることがある。毎週なら同じ週の先行する曜日、
     * 毎月の第 n 曜日なら同じ日付の回から最大 4 週ぶん離れる。
     * 1 区切り戻せばどちらも覆え、余分は下の範囲判定が落とす。
     *
     * 間隔が広がっても 1 区切りで足りる。毎週なら、区切り at-2 の最終日と
     * nth(at-1) の差は 曜日 + 間隔×7 − 6 日で、間隔が 1 でも 1 日以上ある。
     */
    const first = hasByDay(rule) ? Math.max(0, at - 1) : at

    let emittedCount = 0
    for (
      let i = first, steps = 0;
      emittedCount < MAX_OCCURRENCES_IN_RANGE && steps < MAX_STEPS_IN_RANGE;
      i++, steps++
    ) {
      // 区切りの先頭で打ち切る。1 回も生まない区切り（第 5 火曜の無い月）が
      // 続いても、ここで必ず前に進む
      const anchor = stepAnchor(baseStart, rule, i)
      if (anchor > rangeEnd) break
      if (limit && anchor >= limit) break

      for (const cursor of stepDates(baseStart, rule, i)) {
        if (cursor > rangeEnd) continue
        if (limit && cursor >= limit) continue
        emittedCount++

        const override = overrideMap.get(overrideKeyOf(event.id, cursor)) ?? null
        if (override?.canceled) continue

        const end = durationMs > 0 ? new Date(cursor.getTime() + durationMs) : null
        push(makeOccurrence(event, cursor, end, override))
      }
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
export function nextDueDate(
  dueAt: string,
  rec: Recurrence | RecurrenceRule,
  now: Date = new Date(),
): string | null {
  const rule = typeof rec === 'string' ? ruleOf({ recurrence: rec }) : normalizeRule(rec)
  if (rule.recurrence === 'none') return null

  const base = new Date(dueAt)
  // 「now より後」= 「now + 1ms 以上」
  const after = new Date(now.getTime() + 1)

  if (!hasByDay(rule)) {
    // 少なくとも 1 区切りは進める（期限より前に完了しても、次回分は先へ動く）。
    // 隔週なら 1 区切り = 2 週間
    const n = Math.max(1, firstIndexAtOrAfter(base, rule.recurrence, after, rule.interval))
    return nthOccurrence(base, rule.recurrence, n, rule.interval).toISOString()
  }

  const first = Math.max(0, firstIndexAtOrAfter(base, rule.recurrence, after, rule.interval) - 1)
  for (let i = first, steps = 0; steps < MAX_STEPS_IN_RANGE; i++, steps++) {
    for (const date of stepDates(base, rule, i)) {
      // now より後、かつ いまの期限より後。曜日指定なしの Math.max(1, …) と同じ意味
      if (date >= after && date.getTime() > base.getTime()) return date.toISOString()
    }
  }
  return null
}
