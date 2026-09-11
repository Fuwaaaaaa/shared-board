/*
 * 外部カレンダー（.ics）の繰り返しを、その予定自身の暦で展開する。
 *
 * ボード自身の繰り返し（supabase/functions/_shared/recurrence.ts）とは
 * 2 点で作法が違うので、共有せず別に持つ。
 *
 *  1. 暦が Asia/Tokyo 固定ではない。相手が TZID で名乗ったゾーンで数える。
 *     日をミリ秒で足すと、夏時間のある地域で毎週の会議が 1 時間ずれていく。
 *  2. その月に無い日は「飛ばす」。RFC 5545 の FREQ=MONTHLY はそう決まっている。
 *     ボード側は逆に「月末へ丸める」——これは決めの違いで、どちらも正しい。
 *     食い違うぶんは書き出し側が RDATE で補っている（src/lib/ics.ts）。
 */

import { daysInMonth } from './dates'
import { utcToWallClock, wallClockToUtc, type ZonedParts } from './tz'

const DAY_MS = 24 * 60 * 60 * 1000

export type IcsFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** 切り替えが 1 回。at（UTC ミリ秒）以降は offsetMs になる */
export interface ZoneTransition {
  at: number
  offsetMs: number
}

/**
 * 数えるときの暦。
 *
 * - `fixed`  UTC。TZID が無く Z で終わる値
 * - `iana`   TZID が読めたとき。夏時間は Intl の持つ tz データが面倒を見る
 * - `rules`  TZID を Intl が知らないとき、VTIMEZONE の切り替え規則から起こしたもの
 * - `local`  フローティング（TZID も Z も無い）。RFC どおり閲覧者の暦で読む
 */
export type Zone =
  | { kind: 'fixed'; offsetMs: number }
  | { kind: 'iana'; tzid: string }
  | { kind: 'rules'; base: number; transitions: ZoneTransition[] }
  | { kind: 'local' }

export const UTC_ZONE: Zone = { kind: 'fixed', offsetMs: 0 }
export const LOCAL_ZONE: Zone = { kind: 'local' }

/**
 * その瞬間のずれ。transitions は at の昇順に並んでいる前提。
 *
 * 「at 以下で最後のもの」を二分探索で探す。1 つも無ければ base
 * （＝最初の切り替えより前。VTIMEZONE の最初の TZOFFSETFROM）。
 */
export function offsetAtInstant(zone: Extract<Zone, { kind: 'rules' }>, ms: number): number {
  const { transitions } = zone
  let lo = 0
  let hi = transitions.length - 1
  let found = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (transitions[mid].at <= ms) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return found === -1 ? zone.base : transitions[found].offsetMs
}

/** 時刻を、そのゾーンの壁時計に分解する */
export function toWall(zone: Zone, date: Date): ZonedParts {
  if (zone.kind === 'iana') {
    const parts = utcToWallClock(zone.tzid, date)
    if (parts) return parts
    // 読めるはずの名前でしか iana を作らないが、念のため素通しにする
    return toWall(LOCAL_ZONE, date)
  }
  if (zone.kind === 'fixed' || zone.kind === 'rules') {
    const offset = zone.kind === 'fixed' ? zone.offsetMs : offsetAtInstant(zone, date.getTime())
    const shifted = new Date(date.getTime() + offset)
    return {
      y: shifted.getUTCFullYear(),
      m: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
      hh: shifted.getUTCHours(),
      mm: shifted.getUTCMinutes(),
      ss: shifted.getUTCSeconds(),
    }
  }
  return {
    y: date.getFullYear(),
    m: date.getMonth() + 1,
    d: date.getDate(),
    hh: date.getHours(),
    mm: date.getMinutes(),
    ss: date.getSeconds(),
  }
}

/** そのゾーンの壁時計を、実際の時刻に直す */
export function fromWall(zone: Zone, p: ZonedParts): Date {
  if (zone.kind === 'iana') {
    const date = wallClockToUtc(zone.tzid, p)
    if (date) return date
    return fromWall(LOCAL_ZONE, p)
  }
  if (zone.kind === 'fixed') {
    return new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - zone.offsetMs)
  }
  if (zone.kind === 'rules') {
    /*
     * ずれの量は、求めたい時刻そのものに依存する（切り替えを跨ぐと変わる）。
     * 一度あたりを付けてから、その時刻でのずれで測り直す —— tz.ts の
     * wallClockToUtc と同じ手順で、あちらは Intl、こちらは VTIMEZONE の規則。
     *
     * 春に飛ばされる 1 時間（存在しない壁時計）は RFC でも決まっていないので、
     * 切り替え前のずれで読んだ時刻を返す。
     */
    const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
    const first = offsetAtInstant(zone, guess)
    const candidate = guess - first
    const second = offsetAtInstant(zone, candidate)
    if (second === first) return new Date(candidate)

    const adjusted = guess - second
    return offsetAtInstant(zone, adjusted) === second ? new Date(adjusted) : new Date(candidate)
  }
  return new Date(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
}

/**
 * 基準から数えて n 回目（0 が基準そのもの）の開始時刻。
 *
 * その月・その年に無い日（2 月の 31 日、平年の 2/29）は null を返す。
 * 呼ぶ側はその回を「生成しない」——RFC 5545 の決まりに合わせる。
 *
 * 前の回に足していくのではなく基準から直接数えるので、
 * 何年も前に始まった繰り返しでも誤差が積もらない。
 */
export function occurrenceAt(
  zone: Zone,
  base: ZonedParts,
  freq: IcsFreq,
  n: number,
  interval = 1,
): Date | null {
  const steps = n * interval

  if (freq === 'daily' || freq === 'weekly') {
    // 壁時計の「日付」だけを進める。時刻は基準のまま置く
    const days = steps * (freq === 'weekly' ? 7 : 1)
    const moved = new Date(Date.UTC(base.y, base.m - 1, base.d) + days * DAY_MS)
    return fromWall(zone, {
      ...base,
      y: moved.getUTCFullYear(),
      m: moved.getUTCMonth() + 1,
      d: moved.getUTCDate(),
    })
  }

  if (freq === 'monthly') {
    const total = base.m - 1 + steps
    const y = base.y + Math.floor(total / 12)
    const m = (((total % 12) + 12) % 12) + 1
    if (base.d > daysInMonth(y, m)) return null
    return fromWall(zone, { ...base, y, m })
  }

  const y = base.y + steps
  if (base.d > daysInMonth(y, base.m)) return null
  return fromWall(zone, { ...base, y })
}

/**
 * 開始が target 以上になる最初の回の番号。
 * 差から当たりを付け、前後へ動かして合わせる。飛ばされる回は数に入ったまま
 * （n は「ステップの番号」であって「何回目に出たか」ではない）。
 */
function firstStepAtOrAfter(
  zone: Zone,
  base: ZonedParts,
  freq: IcsFreq,
  interval: number,
  target: Date,
  start: Date,
): number {
  if (target <= start) return 0

  let n: number
  if (freq === 'daily' || freq === 'weekly') {
    const perStep = interval * (freq === 'weekly' ? 7 : 1) * DAY_MS
    n = Math.floor((target.getTime() - start.getTime()) / perStep)
  } else {
    const t = toWall(zone, target)
    const months = (t.y - base.y) * 12 + (t.m - base.m)
    n = Math.floor((freq === 'monthly' ? months : t.y - base.y) / interval)
  }
  if (n < 0 || !Number.isFinite(n)) n = 0

  // 当たりの前後 400 ステップまでで合わせる（飛ばされる回が続いても抜ける）
  const at = (i: number) => occurrenceAt(zone, base, freq, i, interval)
  for (let guard = 0; guard < 400; guard++) {
    const here = at(n)
    if (here !== null && here >= target) break
    n++
  }
  for (let guard = 0; guard < 400 && n > 0; guard++) {
    const prev = at(n - 1)
    if (prev === null || prev < target) break
    n--
  }
  return n
}

/** BYDAY の 1 つ。nth があれば「第 n 曜日」（BYDAY=2TU の形） */
export interface ByDayPart {
  /** 0=日 … 6=土 */
  weekday: number
  nth: number | null
}

/**
 * n 番目のステップが生む回（昇順）。BY... が 1 つも無ければ occurrenceAt と同じ 1 件。
 *
 * BY... の意味は FREQ で変わる（RFC 5545）。同じ名前でも「回を増やす」ときと
 * 「絞り込む」ときがあり、そこを取り違えると回数が合わなくなる。
 *
 *   BYDAY      daily   絞り込み。その曜日でなければ、その回は生まれない
 *              weekly  その週の中で、選ばれた曜日ぶんに増える
 *              monthly / yearly  序数つきならその位置の曜日、無ければ該当する曜日すべて
 *   BYMONTHDAY monthly / yearly  その日付ぶんに増える（負は月末から数える）
 *              daily   絞り込み。weekly では使えない決まりなので見ない
 *   BYMONTH    yearly  その月ぶんに増える
 *              それ以外  絞り込み
 *   BYSETPOS   上で並べ終えた集合から、位置で選ぶ
 *
 * 週の起点は spec.wkst。RFC の既定は月曜で、こちらが書き出すときは WKST=SU を付ける。
 */
export function occurrencesAt(
  zone: Zone,
  base: ZonedParts,
  spec: Pick<
    RecurrenceSpec,
    'freq' | 'interval' | 'byDay' | 'byMonth' | 'byMonthDay' | 'bySetPos' | 'wkst'
  >,
  n: number,
): Date[] {
  const { freq, byDay, byMonth, byMonthDay, bySetPos, wkst } = spec
  const interval = Math.max(1, spec.interval)

  // 何の指定も無ければ、基準の日付をそのまま進めるだけ
  if (byDay.length === 0 && byMonth.length === 0 && byMonthDay.length === 0) {
    const at = occurrenceAt(zone, base, freq, n, interval)
    return at ? [at] : []
  }

  /** BYMONTH による絞り込み（yearly で月を増やすのは下の分岐） */
  const monthAllowed = (m: number) => byMonth.length === 0 || byMonth.includes(m)

  /** BYMONTHDAY を、その月の実際の日に直す。無い日（2 月の 30 日）は落とす */
  const monthDaysIn = (y: number, m: number): number[] => {
    const last = daysInMonth(y, m)
    return byMonthDay
      .map((value) => (value > 0 ? value : last + value + 1))
      .filter((d) => d >= 1 && d <= last)
  }
  const monthDayAllowed = (y: number, m: number, d: number) =>
    byMonthDay.length === 0 || monthDaysIn(y, m).includes(d)

  const weekdayOf = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()

  if (freq === 'daily') {
    // すべて絞り込み。1 日進めて、条件に合わなければ生まない
    const at = occurrenceAt(zone, base, freq, n, interval)
    if (!at) return []
    const p = toWall(zone, at)
    if (!monthAllowed(p.m)) return []
    if (!monthDayAllowed(p.y, p.m, p.d)) return []
    if (byDay.length > 0) {
      const dow = weekdayOf(p.y, p.m, p.d)
      if (!byDay.some((part) => part.weekday === dow)) return []
    }
    return [at]
  }

  if (freq === 'weekly') {
    if (byDay.length === 0) {
      // 曜日の指定が無ければ回は増えない。BYMONTH の絞り込みだけ効く
      const at = occurrenceAt(zone, base, freq, n, interval)
      if (!at) return []
      return monthAllowed(toWall(zone, at).m) ? [at] : []
    }

    // 基準の週（wkst 起点）の先頭から n*interval 週ぶん進める
    const weekdays = new Set(byDay.map((part) => part.weekday))
    const baseUtc = Date.UTC(base.y, base.m - 1, base.d)
    const baseDow = new Date(baseUtc).getUTCDay()
    const offsetToStart = (baseDow - wkst + 7) % 7
    const weekStart = baseUtc - offsetToStart * DAY_MS + n * interval * 7 * DAY_MS

    const dates: Date[] = []
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart + i * DAY_MS)
      if (!weekdays.has(day.getUTCDay())) continue
      const m = day.getUTCMonth() + 1
      if (!monthAllowed(m)) continue
      dates.push(
        fromWall(zone, {
          ...base,
          y: day.getUTCFullYear(),
          m,
          d: day.getUTCDate(),
        }),
      )
    }
    return dates
  }

  // monthly / yearly。まず対象の期間を決める
  let y: number
  let months: number[]
  if (freq === 'monthly') {
    const total = base.m - 1 + n * interval
    y = base.y + Math.floor(total / 12)
    const m = (((total % 12) + 12) % 12) + 1
    // monthly での BYMONTH は絞り込み。月そのものは interval が決める
    if (!monthAllowed(m)) return []
    months = [m]
  } else {
    y = base.y + n * interval
    // yearly での BYMONTH は回を増やす（FREQ=YEARLY;BYMONTH=3,9 で年 2 回）
    months = byMonth.length > 0 ? [...new Set(byMonth)].sort((a, b) => a - b) : [base.m]
  }

  const days: { m: number; d: number }[] = []

  for (const m of months) {
    if (m < 1 || m > 12) continue
    const last = daysInMonth(y, m)

    // ---- 曜日の指定が無い: 日付そのもので選ぶ ----
    if (byDay.length === 0) {
      const list = byMonthDay.length > 0 ? monthDaysIn(y, m) : [base.d]
      for (const d of list) {
        // その月に無い日は回そのものを生まない（RFC 5545 の決まり）
        if (d >= 1 && d <= last) days.push({ m, d })
      }
      continue
    }

    // ---- 曜日で選ぶ。BYMONTHDAY があれば、そこで絞る ----
    const byWeekday: Record<number, number[]> = {}
    for (let d = 1; d <= last; d++) {
      ;(byWeekday[weekdayOf(y, m, d)] ??= []).push(d)
    }

    for (const part of byDay) {
      const list = byWeekday[part.weekday] ?? []
      if (part.nth === null) {
        for (const d of list) if (monthDayAllowed(y, m, d)) days.push({ m, d })
        continue
      }
      const index = part.nth > 0 ? part.nth - 1 : list.length + part.nth
      if (index < 0 || index >= list.length) continue
      const d = list[index]
      if (monthDayAllowed(y, m, d)) days.push({ m, d })
    }
  }

  days.sort((a, b) => a.m - b.m || a.d - b.d)
  // 同じ日が二重に入ることがある（BYDAY=TU,2TU のような書き方）
  const unique = days.filter(
    (day, i) => i === 0 || day.m !== days[i - 1].m || day.d !== days[i - 1].d,
  )

  const picked =
    bySetPos.length > 0
      ? bySetPos
          .map((pos) => (pos > 0 ? unique[pos - 1] : unique[unique.length + pos]))
          .filter((day): day is { m: number; d: number } => Boolean(day))
          .sort((a, b) => a.m - b.m || a.d - b.d)
      : unique

  return picked.map((day) => fromWall(zone, { ...base, y, m: day.m, d: day.d }))
}

export interface RecurrenceSpec {
  /** DTSTART（絶対時刻） */
  start: Date
  zone: Zone
  freq: IcsFreq
  interval: number
  /** BYDAY。空なら曜日の指定なし */
  byDay: ByDayPart[]
  /**
   * BYMONTH（1〜12）。空なら月の指定なし。
   *
   * FREQ で意味が変わる（RFC 5545）。YEARLY のときだけ「回を増やす」で、
   * それ以外は「その月でなければ出さない」という絞り込み。
   */
  byMonth: number[]
  /**
   * BYMONTHDAY。負は月末から数える（-1 が月末）。空なら日付の指定なし。
   *
   * MONTHLY / YEARLY では回を増やし、DAILY では絞り込みになる。
   * WEEKLY では使えない決まりなので見ない。
   */
  byMonthDay: number[]
  /** BYSETPOS。上の絞り込みで並べたあとの位置指定（-1 は最後） */
  bySetPos: number[]
  /** WKST（0=日 … 6=土）。RFC の既定は月曜 */
  wkst: number
  /** COUNT。数えるのは「実際に出た回」だけ（飛ばした回は数えない） */
  count: number | null
  /** UNTIL。inclusive なら「その時刻の回まで含む」 */
  until: Date | null
  untilInclusive: boolean
  /** 予定の長さ。範囲に「かかっている」かの判定に使う */
  durationMs: number
}

/**
 * 表示範囲 [from, to] に現れる回を返す。
 *
 * COUNT があるときは、0 回目から数え直さないと何回目かが決まらないので、
 * 範囲の手前も歩く。上限（maxSteps）で必ず止まる。
 */
export function expandRecurrence(
  spec: RecurrenceSpec,
  from: Date,
  to: Date,
  maxInRange: number,
  maxSteps = 10000,
): Date[] {
  const base = toWall(spec.zone, spec.start)
  const interval = Math.max(1, spec.interval)
  const result: Date[] = []

  /*
   * COUNT が無ければ、範囲の手前は数えずに飛ばせる。
   *
   * BY... があるときは 1 ステップ手前から見る。firstStepAtOrAfter が数えているのは
   * 「DTSTART と同じ曜日 / 同じ日付」の回で、実際に出る回はそれより前に来ることがある
   * （週の先行する曜日、月の第 1 曜日、BYMONTH で 12 月の DTSTART から 1 月へ回るなど）。
   * 余分は下の範囲判定が落とす。
   */
  const filtered =
    spec.byDay.length > 0 || spec.byMonth.length > 0 || spec.byMonthDay.length > 0
  const at0 =
    spec.count === null
      ? firstStepAtOrAfter(
          spec.zone,
          base,
          spec.freq,
          interval,
          new Date(from.getTime() - spec.durationMs),
          spec.start,
        )
      : 0
  const firstStep = filtered ? Math.max(0, at0 - 1) : at0

  let emitted = 0
  let done = false
  for (let n = firstStep; n < firstStep + maxSteps && !done; n++) {
    if (spec.count !== null && emitted >= spec.count) break
    if (result.length >= maxInRange) break

    // その月に無い日は回そのものが生まれない（空が返る）
    for (const at of occurrencesAt(spec.zone, base, spec, n)) {
      // DTSTART より前の回は出さない（RFC 5545 の「DTSTART が下限」）
      if (at < spec.start) continue
      if (at > to) {
        done = true
        break
      }
      if (spec.until && (spec.untilInclusive ? at > spec.until : at >= spec.until)) {
        done = true
        break
      }
      if (spec.count !== null && emitted >= spec.count) {
        done = true
        break
      }

      emitted++
      if (result.length >= maxInRange) {
        done = true
        break
      }
      if (at.getTime() + spec.durationMs < from.getTime()) continue
      result.push(at)
    }
  }

  return result
}
