/*
 * ボードの暦（Asia/Tokyo 固定）の日付計算。本体は Edge Function と共有している。
 * ここには「閲覧者のブラウザ」に依存する補助だけを足す。
 */

import { BOARD_TZ } from '../../supabase/functions/_shared/dates.ts'

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
