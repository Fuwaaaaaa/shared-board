/*
 * ボードの暦（Asia/Tokyo 固定）の日付計算。本体は Edge Function と共有している。
 * ここには「閲覧者のブラウザ」に依存する補助だけを足す。
 */

import { BOARD_TZ, toBoardDate } from '../../supabase/functions/_shared/dates.ts'

export * from '../../supabase/functions/_shared/dates.ts'

/** 閲覧者のブラウザがボードと同じタイムゾーン（日本時間）か */
export function isBoardTimeZone(): boolean {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === BOARD_TZ
  } catch {
    // Intl が使えない環境は国内扱いにする（何もしないのが一番安全）
    return true
  }
}

/** 'yyyy-MM-dd' を閲覧者ローカルの 0:00 として読む */
export function localDateOf(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 終日の日時を、JST の日付のまま閲覧者ローカルの 0:00 に置き直す。
 *
 * 終日は JST 0:00 で保存してあるので、そのまま format() すると日本より西では前日になる。
 * 画面（カレンダーのマス・入力欄）はローカルで日付を読むので、読む前にここを通す。
 */
export function pinBoardDay(value: Date | string): Date {
  return localDateOf(toBoardDate(value))
}

/**
 * 入力欄の 'yyyy-MM-dd' と 'HH:mm' を、閲覧者ローカルの時刻として ISO にする。
 *
 * 時刻のある予定・やることは、カレンダーでも一覧でも閲覧者のローカル時刻で出していて
 * （format(parseISO(…))）、入力欄もそれで埋めている。保存も同じ時計で読まないと、
 * 日本以外から開いた人が保存するたびに時差ぶんずれる（以前は JST で読んでいた）。
 * 終日は日付だけが意味を持つので、こちらではなく allDayStartIso（JST の 0:00）を使う。
 */
export function localDateTimeIso(dateStr: string, timeStr: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!date) throw new RangeError(`日付の形式が不正です: ${dateStr}`)
  const time = /^(\d{1,2}):(\d{2})/.exec(timeStr)
  if (!time) throw new RangeError(`時刻の形式が不正です: ${timeStr}`)
  return new Date(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    Number(time[1]),
    Number(time[2]),
  ).toISOString()
}
