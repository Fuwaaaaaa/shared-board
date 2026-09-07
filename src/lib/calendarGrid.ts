/*
 * 週・日表示で、掴んで動かした量を「いつ」に直す計算。
 *
 * カレンダーの中に書いていたが、丸めを 1 つ間違えても画面上は
 * それらしく動いてしまい、目では気づけないので、出してテストで固定する。
 */

/** 週表示の 1 時間ぶんの高さ（px）。CalendarTab の目盛りと同じ値 */
export const HOUR_HEIGHT = 48

/** 時刻の刻み（分）。この単位に丸める */
export const SNAP_MINUTES = 15

const DAY_MS = 24 * 60 * 60_000
const MINUTE_MS = 60_000

/**
 * 画面上の移動量（px）を、動かす時間（ミリ秒）に直す。
 *
 *   dx は列の幅で割って「何日ぶん動いたか」
 *   dy は 1 時間の高さで割って分にし、SNAP_MINUTES の単位に丸める
 *
 * どちらも四捨五入なので、半分を超えたところで次に移る。
 * columnWidth が 0 のときは日数を動かさない（幅を測る前に掴まれた場合）。
 */
export function dragDeltaMs(dx: number, dy: number, columnWidth: number): number {
  const dayShift = columnWidth > 0 ? Math.round(dx / columnWidth) : 0
  const rawMinutes = (dy / HOUR_HEIGHT) * 60
  const minuteShift = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES
  return dayShift * DAY_MS + minuteShift * MINUTE_MS
}
