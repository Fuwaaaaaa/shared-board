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

/**
 * 数えるときの暦。
 *
 * - `fixed`  UTC や、VTIMEZONE の固定オフセットに退避したとき
 * - `iana`   TZID が読めたとき
 * - `local`  フローティング（TZID も Z も無い）。RFC どおり閲覧者の暦で読む
 */
export type Zone =
  | { kind: 'fixed'; offsetMs: number }
  | { kind: 'iana'; tzid: string }
  | { kind: 'local' }

export const UTC_ZONE: Zone = { kind: 'fixed', offsetMs: 0 }
export const LOCAL_ZONE: Zone = { kind: 'local' }

/** 時刻を、そのゾーンの壁時計に分解する */
export function toWall(zone: Zone, date: Date): ZonedParts {
  if (zone.kind === 'iana') {
    const parts = utcToWallClock(zone.tzid, date)
    if (parts) return parts
    // 読めるはずの名前でしか iana を作らないが、念のため素通しにする
    return toWall(LOCAL_ZONE, date)
  }
  if (zone.kind === 'fixed') {
    const shifted = new Date(date.getTime() + zone.offsetMs)
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

export interface RecurrenceSpec {
  /** DTSTART（絶対時刻） */
  start: Date
  zone: Zone
  freq: IcsFreq
  interval: number
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

  // COUNT が無ければ、範囲の手前は数えずに飛ばせる
  const firstStep =
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

  let emitted = 0
  for (let n = firstStep; n < firstStep + maxSteps; n++) {
    if (spec.count !== null && emitted >= spec.count) break
    if (result.length >= maxInRange) break

    const at = occurrenceAt(spec.zone, base, spec.freq, n, interval)
    if (at === null) continue // その月に無い日。回そのものが生まれない
    if (at > to) break
    if (spec.until && (spec.untilInclusive ? at > spec.until : at >= spec.until)) break

    emitted++
    if (at.getTime() + spec.durationMs < from.getTime()) continue
    result.push(at)
  }

  return result
}
