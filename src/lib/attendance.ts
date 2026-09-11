/*
 * 予定の出欠（○ / △ / ×）。
 *
 * 「どの回に対する答えか」は occurrence_date（元の回の JST 開始日）で指す。
 * これは event_overrides と同じキーで、同じ前提の上に立っている——
 * 対応している繰り返しは 1 予定につき 1 日 1 回しか出現しない、という前提。
 * 曜日指定を足してもこの前提は変わらない（毎週×曜日は各曜日が週 1 回、
 * 毎月 第 n 曜日は月 1 回）。
 *
 * 表示用のキー（recurrence.ts の occurrenceKey）は使わない。あちらは時刻を含むので、
 * 時刻だけを変えたときに「例外は残るのに出欠だけ迷子になる」食い違いが生まれる。
 */

import { occurrenceKeyDate, toBoardDate } from './dates'
import { ruleOf } from './recurrence'
import type {
  CalendarEvent,
  EventAttendance,
  EventOccurrence,
  Recurrence,
  RoomMember,
} from './types'

/** その回を指すキー。event_overrides.occurrence_date と同じ値 */
export function attendanceDateOf(occurrence: EventOccurrence): string {
  return occurrenceKeyDate(occurrence.originalStart)
}

/**
 * その回に付いている出欠。
 *
 * 繰り返しなしの予定は回が 1 つしかないので occurrence_date を見ない。
 * 見てしまうと、予定を別の日へ動かした瞬間に答えが全部消える。
 */
export function attendanceFor(
  rows: EventAttendance[],
  occurrence: EventOccurrence,
): EventAttendance[] {
  const eventId = occurrence.event.id
  if (occurrence.event.recurrence === 'none') {
    return rows.filter((row) => row.event_id === eventId)
  }

  const date = attendanceDateOf(occurrence)
  return rows.filter((row) => row.event_id === eventId && row.occurrence_date === date)
}

/** その回に対する自分の答え。まだ答えていなければ null */
export function myAttendance(
  rows: EventAttendance[],
  occurrence: EventOccurrence,
  userId: string,
): EventAttendance | null {
  return attendanceFor(rows, occurrence).find((row) => row.user_id === userId) ?? null
}

export interface AttendanceTally {
  yes: number
  maybe: number
  no: number
  /** まだ答えていない承認済み参加者の数 */
  unanswered: number
  /** ○ と答えた人の名前 */
  yesNames: string[]
  /** まだ答えていない人の名前 */
  pendingNames: string[]
}

/**
 * その回の集計。
 *
 * 名前はサーバーが本人の表示名に直したもの（voter_name）を使う。
 * 未回答は「承認済み参加者のうち、答えていない人」。
 */
export function tallyAttendance(
  rows: EventAttendance[],
  approvedMembers: RoomMember[],
): AttendanceTally {
  const tally: AttendanceTally = {
    yes: 0,
    maybe: 0,
    no: 0,
    unanswered: 0,
    yesNames: [],
    pendingNames: [],
  }

  const answered = new Set<string>()
  for (const row of rows) {
    answered.add(row.user_id)
    tally[row.answer]++
    if (row.answer === 'yes') tally.yesNames.push(row.voter_name || '名前なし')
  }

  for (const member of approvedMembers) {
    if (answered.has(member.user_id)) continue
    tally.unanswered++
    tally.pendingNames.push(member.display_name || '名前なし')
  }

  return tally
}

/** 保存しようとしている繰り返しの設定（CalendarTab の下書きから作る） */
export interface OccurrenceGrid {
  /** 開始日（'yyyy-MM-dd'、JST） */
  date: string
  recurrence: Recurrence
  /** 空文字は無期限 */
  recurrenceUntil: string
  days: number[]
  week: number | null
  /** 「n 回ごと」。1 なら毎回 */
  interval: number
}

/**
 * 回の並びが動いたか。動いていれば「この回だけ」の変更と出欠が取り消される。
 *
 * サーバー側の public.tg_reset_event_occurrences（supabase/schema.sql）と
 * まったく同じ条件でなければならない。ずれると、確認が出ないのに消える／
 * 出るのに消えない、という食い違いになる。片方を直すときは必ず両方直すこと。
 *
 * 曜日を「足しただけ」は動いたとみなさない。増やすのは加算的で、それまでに
 * 出ていた回はすべてそのまま残るため。
 */
export function occurrenceGridMoved(
  next: OccurrenceGrid,
  event: Pick<
    CalendarEvent,
    | 'start_at'
    | 'recurrence'
    | 'recurrence_until'
    | 'recurrence_days'
    | 'recurrence_week'
    | 'recurrence_interval'
  >,
): boolean {
  // 繰り返しなしのまま日付だけ動いたときは、回が 1 つのままなので崩れない
  if (next.recurrence === 'none' && event.recurrence === 'none') return false

  const before = ruleOf(event)

  if (next.date !== toBoardDate(event.start_at)) return true
  if (next.recurrence !== event.recurrence) return true
  if ((next.recurrenceUntil || null) !== (event.recurrence_until ?? null)) return true
  if (next.week !== before.week) return true
  /*
   * 間隔は必ず「1 に読み替えてから」比べる。
   *
   * この機能より前からある行は null で届き、画面から保存し直すと 1 が入る。
   * 素の値で比べると、開いて保存しただけの古い予定が「並びが動いた」と
   * 判定され、出欠と「この回だけ」が消える。ruleOf が ?? 1 を通している。
   */
  if ((next.interval || 1) !== (before.interval ?? 1)) return true

  // 減らした・入れ替えたときだけ
  return before.days.some((day) => !next.days.includes(day))
}

/** 「この回だけ n 件・出欠 m 件が取り消されます」の文。どちらも 0 なら空文字 */
export function describeOccurrenceReset(overrides: number, attendance: number): string {
  const parts: string[] = []
  if (overrides > 0) parts.push(`「この回だけ」の変更が ${overrides} 件`)
  if (attendance > 0) parts.push(`出欠の回答が ${attendance} 件`)
  if (parts.length === 0) return ''

  return (
    `この予定には${parts.join('と')}あります。\n` +
    'すべての回を変更すると、それらは取り消されます。よろしいですか？'
  )
}

/**
 * 「その回に ○ が何人いるか」を引ける表。
 *
 * 一覧の各行から attendanceFor を呼ぶと行数 × 行数の走査になるので、
 * 1 回だけ作って配る。繰り返しなしの予定は日付を持たないキーに入れる
 * （attendanceFor と同じ理由。予定を動かしても答えが付いてくる）。
 */
export function yesCountByOccurrence(rows: EventAttendance[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.answer !== 'yes') continue
    for (const key of [row.event_id, `${row.event_id}|${row.occurrence_date}`]) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/** yesCountByOccurrence から、その回の ○ の数を引く */
export function yesCountOf(counts: Map<string, number>, occurrence: EventOccurrence): number {
  const key =
    occurrence.event.recurrence === 'none'
      ? occurrence.event.id
      : `${occurrence.event.id}|${attendanceDateOf(occurrence)}`
  return counts.get(key) ?? 0
}
