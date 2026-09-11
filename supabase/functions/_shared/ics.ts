/*
 * .ics（iCalendar）の書き出し。フロントと Edge Function（board-ics）で共有する。
 *
 * ここには依存も DOM も Deno も持ち込まない。相対 import は Deno のため拡張子つきで書く。
 * ダウンロードさせる側（Blob と <a download>）は src/lib/ics.ts に置いてある。
 *
 * 共有しているのは、書き出したファイルと購読 URL が配るものを必ず同じにするため。
 * 別々に持つと、片方だけ直したときに黙ってずれる。
 */

import {
  hasByDay,
  nthOccurrence,
  originalStartFor,
  ruleOf,
  type OverrideLike,
  type Recurrence,
  type RecurrenceRule,
} from './recurrence.ts'
import { fromBoardParts, toBoardDate, toBoardParts, untilLimit } from './dates.ts'

/** 書き出しに必要な予定の列。フロントの CalendarEvent も DB の行もこれを満たす */
export interface IcsEventLike {
  id: string
  title: string
  description: string
  start_at: string
  end_at: string | null
  all_day: boolean
  recurrence: Recurrence
  recurrence_days?: number[] | null
  recurrence_week?: number | null
  recurrence_interval?: number | null
  recurrence_until: string | null
  tags: string[]
  /** 締切は見出しに 〆 を付けて、集まる予定と見分けられるようにする */
  kind?: 'event' | 'deadline'
}

/** 書き出しに必要なやることの列 */
export interface IcsTodoLike {
  id: string
  title: string
  notes: string
  due_at: string | null
  done: boolean
}

const FREQ: Record<Exclude<Recurrence, 'none'>, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

/** RRULE の BYDAY で使う曜日の綴り。0=日 … 6=土 */
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * RRULE の 1 行を組み立てる。
 *
 * 毎月の第 n 曜日は BYDAY=2TU（序数を前に置く形）で書く。
 * BYDAY=TU;BYSETPOS=2 と同じ意味だが、こちらのほうが取り込み先の対応が広い
 * （Google と Apple はこの形で書き出す）。読むときは両方を受け付ける。
 *
 * INTERVAL は 1 のときは書かない（RFC 5545 の既定が 1）。これまでに書き出した
 * ものと 1 文字も変わらないようにするため。
 *
 * WKST が意味を持つのは FREQ=WEEKLY かつ INTERVAL>1 かつ BYDAY があるときだけ、
 * と RFC 5545 が定めていて、下の push はちょうどその枝に置いてある。
 * 展開側（_shared/recurrence.ts の stepDates）が週の先頭を日曜に固定しているので、
 * ここも SU で合わせる。片方だけ変えると、自分の画面と取り込み先で違う日に出る。
 */
function rruleFor(event: IcsEventLike, rule: RecurrenceRule): string {
  const parts = [`FREQ=${FREQ[event.recurrence as Exclude<Recurrence, 'none'>]}`]

  const interval = rule.interval ?? 1
  if (interval > 1) parts.push(`INTERVAL=${interval}`)

  if (hasByDay(rule)) {
    if (rule.recurrence === 'weekly') {
      parts.push(`BYDAY=${rule.days.map((d) => ICS_DAYS[d]).join(',')}`, 'WKST=SU')
    } else {
      parts.push(`BYDAY=${rule.week}${ICS_DAYS[rule.days[0]]}`)
    }
  }

  return `RRULE:${parts.join(';')}${untilParam(event)}`
}

/** iCalendar のテキスト値をエスケープする */
function escapeText(value: string): string {
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      // 単独の CR も改行として扱う。LF が続かない CR を見落とすと、
      // 生の CR がプロパティ値の途中に出て行の構造が壊れる
      .replace(/\r\n|\r|\n/g, '\\n')
  )
}

/** 1 行 75 オクテットを超えないよう折り返す（RFC 5545） */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let current = ''
  let currentBytes = 0

  for (const char of line) {
    const size = new TextEncoder().encode(char).length
    // 継続行は先頭に空白が入るぶん 1 バイト狭くなる
    const limit = parts.length === 0 ? 75 : 74
    if (currentBytes + size > limit) {
      parts.push(current)
      current = ''
      currentBytes = 0
    }
    current += char
    currentBytes += size
  }
  if (current) parts.push(current)

  return parts.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n')
}

/** 20260831T030000Z の形にする（UTC） */
function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** 20260831 の形にする（ボードの暦 = JST の日付） */
function dateStamp(date: Date): string {
  return toBoardDate(date).replace(/-/g, '')
}

/** JST で翌日の同時刻 */
function nextBoardDay(date: Date): Date {
  const p = toBoardParts(date)
  return fromBoardParts({ ...p, d: p.d + 1 })
}

/**
 * RRULE の UNTIL。DTSTART が DATE なら DATE、DATE-TIME なら UTC の DATE-TIME にする決まり（RFC 5545）。
 * どちらも「終了日いっぱいまで」を指す（DATE は当日を含む。DATE-TIME は翌日 0:00 JST の 1 秒前）。
 */
function untilParam(event: Pick<IcsEventLike, 'all_day' | 'recurrence_until'>): string {
  if (!event.recurrence_until) return ''
  if (event.all_day) return `;UNTIL=${toBoardDate(event.recurrence_until).replace(/-/g, '')}`
  const limit = untilLimit(event.recurrence_until)
  return limit ? `;UNTIL=${utcStamp(new Date(limit.getTime() - 1000))}` : ''
}

/**
 * 予定の本体部分（DTSTART / DTEND / SUMMARY …）を書き出す。
 *
 * 締切は他のカレンダーアプリでも「予定」として取り込まれるので、
 * 見出しに 〆 を付けて、集まる予定と見分けられるようにする。
 */
function pushEventBody(
  lines: string[],
  event: Pick<IcsEventLike, 'all_day' | 'title' | 'description' | 'tags' | 'kind'>,
  start: Date,
  end: Date | null,
) {
  if (event.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(start)}`)
    // 終日予定の DTEND は「翌日」を指す決まり
    lines.push(`DTEND;VALUE=DATE:${dateStamp(nextBoardDay(end ?? start))}`)
  } else {
    lines.push(`DTSTART:${utcStamp(start)}`)
    lines.push(`DTEND:${utcStamp(end ?? new Date(start.getTime() + 60 * 60_000))}`)
  }

  const summary = event.kind === 'deadline' ? `${event.title} 〆` : event.title
  lines.push(`SUMMARY:${escapeText(summary)}`)
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
  if (event.tags?.length) lines.push(`CATEGORIES:${event.tags.map(escapeText).join(',')}`)
}

/*
 * 終わりの無い繰り返しを .ics に写すときに、RDATE を出す先の上限。
 *
 * 「丸めた回」は RRULE では表せないので 1 つずつ書き出すしかない。
 * 無限には書けないので、ここで区切る。取り込み先で 3 年より先の
 * 2/28（毎月 31 日の 2 月分）が欠けるが、そのころには書き出し直せる。
 */
const RDATE_HORIZON_YEARS = 3

/** RDATE の行数の上限（毎月なら 3 年で最大 36 件、間隔が広がればさらに減る） */
const MAX_RDATES = 60

/**
 * 「その月に無い日なので月末へ丸めた」回を並べる。
 *
 * アプリは 1/31 の毎月を 2/28 → 3/31 と月末へ丸めるが、.ics の
 * FREQ=MONTHLY は「無い日はその月を飛ばす」と読む決まりで、この差は
 * RRULE では書き表せない。そこで丸めで生まれた回だけを RDATE で名指しして補う。
 *
 * 丸めが起きるのは、毎月なら 29〜31 日、毎年なら 2/29 の予定だけ。
 * それ以外は空を返すので、ふつうの予定の書き出しは今までと同じ形になる。
 */
export function clampedRecurrenceDates(
  event: Pick<
    IcsEventLike,
    | 'start_at'
    | 'recurrence'
    | 'recurrence_until'
    | 'recurrence_days'
    | 'recurrence_week'
    | 'recurrence_interval'
  >,
  now: Date = new Date(),
): Date[] {
  const rec = event.recurrence
  if (rec !== 'monthly' && rec !== 'yearly') return []

  /*
   * 「毎月 第 n 曜日」は月末への丸めが起きない（無い月は飛ばす）。
   * ここを通すと、開始が 29〜31 日というだけで嘘の RDATE が並ぶ。
   */
  if (ruleOf(event).week !== null) return []

  const start = new Date(event.start_at)
  const base = toBoardParts(start)
  if (rec === 'monthly' && base.d <= 28) return []
  if (rec === 'yearly' && !(base.m === 2 && base.d === 29)) return []

  const limit = untilLimit(event.recurrence_until)
  const anchor = toBoardParts(start.getTime() > now.getTime() ? start : now)
  const horizon = limit ?? fromBoardParts({ ...anchor, y: anchor.y + RDATE_HORIZON_YEARS })

  /*
   * 何年も前に始まった繰り返しだと、古い回だけで上限に達してしまう。
   * 手元のカレンダーで意味があるのは最近と先の回なので、1 年前より
   * 古いものは出さない（そのぶん取り込み先では過去の回が欠ける）。
   */
  const oldest = fromBoardParts({ ...toBoardParts(now), y: toBoardParts(now).y - 1 })
  const windowStart = start.getTime() > oldest.getTime() ? start : oldest

  /*
   * 間隔を必ず渡すこと。渡さないと RRULE が出さない月の回まで RDATE に並び、
   * 取り込み先で回が増える（EXDATE で消える種類の間違いではないので気づきにくい）。
   */
  const interval = ruleOf(event).interval ?? 1

  const dates: Date[] = []
  // n = 0 は DTSTART そのものなので、丸めは起きない
  for (let n = 1; dates.length < MAX_RDATES; n++) {
    const cursor = nthOccurrence(start, rec, n, interval)
    if (cursor > horizon) break
    if (limit && cursor >= limit) break
    if (cursor < windowStart) continue
    if (toBoardParts(cursor).d !== base.d) dates.push(cursor)
  }
  return dates
}

/** 例外の回を指す EXDATE / RECURRENCE-ID の値 */
function occurrenceStamp(allDay: boolean, originalStart: Date): string {
  return allDay ? `;VALUE=DATE:${dateStamp(originalStart)}` : `:${utcStamp(originalStart)}`
}

/**
 * 予定と TODO を iCalendar 形式のテキストにする。
 *
 * now は DTSTAMP に入る。既定は「いま」だが、購読 URL（board-ics）は
 * 中身が変わっていない限り同じ本文を返したいので、そちらからは明示的に渡す
 * （毎回変えると ETag が永久に一致せず、取りに来るたび全文を送ることになる）。
 */
export function buildIcs(
  boardName: string,
  events: IcsEventLike[],
  todos: IcsTodoLike[] = [],
  overrides: OverrideLike[] = [],
  now: Date = new Date(),
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//minna-no-board//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(boardName)}`,
  ]

  /** 予定ごとの「この回だけ」の変更・削除 */
  const overridesByEvent = new Map<string, OverrideLike[]>()
  for (const override of overrides) {
    const list = overridesByEvent.get(override.event_id)
    if (list) list.push(override)
    else overridesByEvent.set(override.event_id, [override])
  }

  for (const event of events) {
    const start = new Date(event.start_at)
    const end = event.end_at ? new Date(event.end_at) : null
    const mine = event.recurrence === 'none' ? [] : (overridesByEvent.get(event.id) ?? [])

    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.id}@minna-no-board`)
    lines.push(`DTSTAMP:${utcStamp(now)}`)
    pushEventBody(lines, event, start, end)

    if (event.recurrence !== 'none') {
      const rule = ruleOf(event)
      lines.push(rruleFor(event, rule))

      // 削除した回だけを EXDATE で外す。
      // 変更した回は繰り返しの一部のままで、下の RECURRENCE-ID 付き VEVENT が上書きする。
      const canceled = new Set<number>()
      for (const override of mine) {
        if (!override.canceled) continue
        const originalStart = originalStartFor(event, override.occurrence_date)
        canceled.add(originalStart.getTime())
        lines.push(`EXDATE${occurrenceStamp(event.all_day, originalStart)}`)
      }

      // 月末へ丸めた回は RRULE では表せないので、名指しで足す。
      // 消した回まで足し直さないよう、EXDATE に出したものは除く
      const clamped = clampedRecurrenceDates(event, now).filter((d) => !canceled.has(d.getTime()))
      if (clamped.length > 0) {
        lines.push(
          event.all_day
            ? `RDATE;VALUE=DATE:${clamped.map(dateStamp).join(',')}`
            : `RDATE:${clamped.map(utcStamp).join(',')}`,
        )
      }
    }

    lines.push('END:VEVENT')

    // 変更した回は、同じ UID に RECURRENCE-ID を添えた別の VEVENT にする
    for (const override of mine) {
      if (override.canceled || !override.start_at) continue

      const originalStart = originalStartFor(event, override.occurrence_date)
      const overrideStart = new Date(override.start_at)
      const overrideEnd = override.end_at ? new Date(override.end_at) : null
      const allDay = override.all_day ?? event.all_day

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${event.id}@minna-no-board`)
      lines.push(`DTSTAMP:${utcStamp(now)}`)
      lines.push(`RECURRENCE-ID${occurrenceStamp(event.all_day, originalStart)}`)
      pushEventBody(
        lines,
        {
          all_day: allDay,
          kind: event.kind,
          title: override.title ?? event.title,
          description: override.description ?? event.description,
          tags: override.tags ?? event.tags,
        },
        overrideStart,
        overrideEnd,
      )
      lines.push('END:VEVENT')
    }
  }

  for (const todo of todos) {
    if (!todo.due_at) continue
    lines.push('BEGIN:VTODO')
    lines.push(`UID:todo-${todo.id}@minna-no-board`)
    lines.push(`DTSTAMP:${utcStamp(now)}`)
    lines.push(`DUE:${utcStamp(new Date(todo.due_at))}`)
    lines.push(`SUMMARY:${escapeText(todo.title)}`)
    if (todo.notes) lines.push(`DESCRIPTION:${escapeText(todo.notes)}`)
    lines.push(`STATUS:${todo.done ? 'COMPLETED' : 'NEEDS-ACTION'}`)
    lines.push('END:VTODO')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 は最後の行にも CRLF を求める
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}
