import { parseISO } from 'date-fns'
import { originalStartFor } from './recurrence'
import { fromBoardParts, toBoardDate, toBoardParts, untilLimit } from './dates'
import type { CalendarEvent, EventOverride, Recurrence, Todo } from './types'

const FREQ: Record<Exclude<Recurrence, 'none'>, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

/** iCalendar のテキスト値をエスケープする */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // 単独の CR も改行として扱う。LF が続かない CR を見落とすと、
    // 生の CR がプロパティ値の途中に出て行の構造が壊れる
    .replace(/\r\n|\r|\n/g, '\\n')
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
function untilParam(event: Pick<CalendarEvent, 'all_day' | 'recurrence_until'>): string {
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
  event: Pick<CalendarEvent, 'all_day' | 'title' | 'description' | 'tags'> & {
    kind?: CalendarEvent['kind']
  },
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

/** 例外の回を指す EXDATE / RECURRENCE-ID の値 */
function occurrenceStamp(allDay: boolean, originalStart: Date): string {
  return allDay ? `;VALUE=DATE:${dateStamp(originalStart)}` : `:${utcStamp(originalStart)}`
}

/** 予定と TODO を iCalendar 形式のテキストにする */
export function buildIcs(
  boardName: string,
  events: CalendarEvent[],
  todos: Todo[] = [],
  overrides: EventOverride[] = [],
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//minna-no-board//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(boardName)}`,
  ]

  const now = new Date()

  /** 予定ごとの「この回だけ」の変更・削除 */
  const overridesByEvent = new Map<string, EventOverride[]>()
  for (const override of overrides) {
    const list = overridesByEvent.get(override.event_id)
    if (list) list.push(override)
    else overridesByEvent.set(override.event_id, [override])
  }

  for (const event of events) {
    const start = parseISO(event.start_at)
    const end = event.end_at ? parseISO(event.end_at) : null
    const mine = event.recurrence === 'none' ? [] : (overridesByEvent.get(event.id) ?? [])

    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.id}@minna-no-board`)
    lines.push(`DTSTAMP:${utcStamp(now)}`)
    pushEventBody(lines, event, start, end)

    if (event.recurrence !== 'none') {
      lines.push(`RRULE:FREQ=${FREQ[event.recurrence]}${untilParam(event)}`)

      // 削除した回だけを EXDATE で外す。
      // 変更した回は繰り返しの一部のままで、下の RECURRENCE-ID 付き VEVENT が上書きする。
      for (const override of mine) {
        if (!override.canceled) continue
        const originalStart = originalStartFor(event, override.occurrence_date)
        lines.push(`EXDATE${occurrenceStamp(event.all_day, originalStart)}`)
      }
    }

    lines.push('END:VEVENT')

    // 変更した回は、同じ UID に RECURRENCE-ID を添えた別の VEVENT にする
    for (const override of mine) {
      if (override.canceled || !override.start_at) continue

      const originalStart = originalStartFor(event, override.occurrence_date)
      const overrideStart = parseISO(override.start_at)
      const overrideEnd = override.end_at ? parseISO(override.end_at) : null
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
    lines.push(`DUE:${utcStamp(parseISO(todo.due_at))}`)
    lines.push(`SUMMARY:${escapeText(todo.title)}`)
    if (todo.notes) lines.push(`DESCRIPTION:${escapeText(todo.notes)}`)
    lines.push(`STATUS:${todo.done ? 'COMPLETED' : 'NEEDS-ACTION'}`)
    lines.push('END:VTODO')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 は最後の行にも CRLF を求める
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

/** テキストをファイルとしてダウンロードさせる */
export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  downloadBlob(filename, blob)
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 少し待ってから開放しないと、ブラウザによってはダウンロードが中断される
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
