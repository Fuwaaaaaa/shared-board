/*
 * 予定の編集画面（CalendarTab の EventModal）の入力の確かめ。
 */

interface DateTimeFields {
  date: string
  time: string
  allDay: boolean
  hasEnd: boolean
  endDate: string
  endTime: string
}

/**
 * 開始の日付と時刻がそろっているか（終日なら時刻は見ない）。
 *
 * そろっていないまま開始を読むと例外になる。描くたびに開始を読むもの
 * （「最初は〇月〇日からになります」の案内）は、これを見てから読むこと。
 * 見ずに読んでいたので、時刻の欄を空にするとカレンダーのタブごと落ちていた。
 */
export function hasStart(fields: Pick<DateTimeFields, 'date' | 'time' | 'allDay'>): boolean {
  return Boolean(fields.date) && (fields.allDay || Boolean(fields.time))
}

/**
 * 日付や時刻の欄が空なら、そのことを言う文を返す。埋まっていれば null。
 *
 * 保存は入力欄を localDateTimeIso などで読むが、空の欄は読めずに例外になる。
 * 以前はそれがそのまま投げられ、「保存中」のまま画面が固まっていた。
 * 終日なら時刻は見ない。終了は指定しているときだけ見る。
 */
export function missingDateTime(fields: DateTimeFields): string | null {
  if (!hasStart(fields)) return '開始の日付と時刻を入れてください'
  if (fields.hasEnd && (!fields.endDate || (!fields.allDay && !fields.endTime))) {
    return '終了の日付と時刻を入れてください（要らなければ「なくす」）'
  }
  return null
}
