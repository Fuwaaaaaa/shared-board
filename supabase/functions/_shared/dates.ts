/*
 * ボードの暦（Asia/Tokyo 固定）の日付計算。
 *
 * フロント（src/lib/dates.ts 経由）と Edge Function（send-reminders）の両方から読むので、
 * ここには依存も DOM も Deno も持ち込まない。相対 import は Deno のため拡張子つきで書く。
 *
 * JST には夏時間がないので、UTC に 9 時間足して getUTC* を読むだけで壁時計が取れる。
 * Intl を使わずに済ませているのは、実行環境ごとの tz データの差に左右されないため。
 */

export const BOARD_TZ = 'Asia/Tokyo'
export const DAY_MS = 24 * 60 * 60 * 1000

/** JST のオフセット（+09:00） */
const BOARD_OFFSET_MS = 9 * 60 * 60 * 1000

/** ボードの壁時計。m は 1〜12 */
export interface WallClock {
  y: number
  m: number
  d: number
  hh: number
  mm: number
  ss: number
  ms: number
}

/** 時刻を JST の壁時計に分解する */
export function toBoardParts(date: Date): WallClock {
  const shifted = new Date(date.getTime() + BOARD_OFFSET_MS)
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  }
}

/**
 * JST の壁時計から時刻を組み立てる。
 * d が月末を超えていれば翌月に繰り上がる（Date.UTC と同じ）。
 */
export function fromBoardParts(parts: Pick<WallClock, 'y' | 'm' | 'd'> & Partial<WallClock>): Date {
  return new Date(
    Date.UTC(
      parts.y,
      parts.m - 1,
      parts.d,
      parts.hh ?? 0,
      parts.mm ?? 0,
      parts.ss ?? 0,
      parts.ms ?? 0,
    ) - BOARD_OFFSET_MS,
  )
}

/** その月の日数。m は 1〜12 */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** 'yyyy-MM-dd' を分解する。'yyyy-MM-ddTHH:mm...' の先頭も受け付ける */
function parseDateStr(dateStr: string): Pick<WallClock, 'y' | 'm' | 'd'> {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!match) throw new RangeError(`日付の形式が不正です: ${dateStr}`)
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

function parseTimeStr(timeStr: string): Pick<WallClock, 'hh' | 'mm' | 'ss'> {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(timeStr)
  if (!match) throw new RangeError(`時刻の形式が不正です: ${timeStr}`)
  return { hh: Number(match[1]), mm: Number(match[2]), ss: Number(match[3] ?? 0) }
}

/** 'yyyy-MM-dd'（JST）。ISO 文字列も受け付ける */
export function toBoardDate(value: Date | string): string {
  const p = toBoardParts(toDate(value))
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
}

/** 'yyyyMMddTHHmm'（JST）。React の key などコンパクトな同定に使う */
export function boardStamp(value: Date | string): string {
  const p = toBoardParts(toDate(value))
  return `${p.y}${pad2(p.m)}${pad2(p.d)}T${pad2(p.hh)}${pad2(p.mm)}`
}

/** 'yyyy-MM-dd' の JST 0:00 */
export function boardDayStart(dateStr: string): Date {
  return fromBoardParts(parseDateStr(dateStr))
}

/** 終日予定の開始（JST 0:00）を ISO で */
export function allDayStartIso(dateStr: string): string {
  return boardDayStart(dateStr).toISOString()
}

/** 終日予定の終了（JST 23:59）を ISO で */
export function allDayEndIso(dateStr: string): string {
  return fromBoardParts({ ...parseDateStr(dateStr), hh: 23, mm: 59 }).toISOString()
}

/** 'yyyy-MM-dd' と 'HH:mm' を JST として ISO に */
export function boardDateTimeIso(dateStr: string, timeStr: string): string {
  return fromBoardParts({ ...parseDateStr(dateStr), ...parseTimeStr(timeStr) }).toISOString()
}

/**
 * 繰り返しの終了日（'yyyy-MM-dd'、その日いっぱい有効）を排他上限にする。
 * 返るのは翌日の JST 0:00。`cursor < limit` で判定する。
 */
export function untilLimit(recurrenceUntil: string | null | undefined): Date | null {
  if (!recurrenceUntil) return null
  const dateStr = /^\d{4}-\d{2}-\d{2}/.test(recurrenceUntil)
    ? recurrenceUntil
    : toBoardDate(recurrenceUntil)
  const p = parseDateStr(dateStr)
  return fromBoardParts({ ...p, d: p.d + 1 })
}

/**
 * event_overrides.occurrence_date の値（元の回の開始日、JST）。
 * 例外の同定キーはここでしか作らない。
 */
export function occurrenceKeyDate(originalStart: Date | string): string {
  return toBoardDate(originalStart)
}

/**
 * 通知の同定キー。画面内通知の既読管理、送信済み台帳、push の tag で同じ値を使う。
 * 時刻は toISOString() 形式に正規化するので、'+00:00' と 'Z' の表記差で別物にならない。
 */
export function reminderKey(
  kind: 'event' | 'todo',
  id: string,
  at: Date | string,
  minutes: number,
): string {
  return `${kind}:${id}:${toDate(at).toISOString()}:${minutes}`
}
