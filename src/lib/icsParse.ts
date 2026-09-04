import { addDays } from 'date-fns'
import {
  MAX_OCCURRENCES_IN_RANGE,
  firstIndexAtOrAfter,
  nthOccurrence,
  type Recurrence,
} from '../../supabase/functions/_shared/recurrence.ts'

/** 外部カレンダーから読み込んだ予定（DB には保存せず、表示のときだけ使う） */
export interface FeedEvent {
  uid: string
  title: string
  start: Date
  end: Date | null
  allDay: boolean
  feedId: string
  feedName: string
  color: string
}

interface RawEvent {
  uid: string
  summary: string
  start: Date
  end: Date | null
  allDay: boolean
  rrule: string | null
  /** EXDATE。この時刻に始まる回は出さない（「この回だけ削除」） */
  exdates: Date[]
  /**
   * RECURRENCE-ID。値があれば、この VEVENT は同じ UID の
   * 「その回だけの差し替え」（「この回だけ変更」）を表す。
   */
  recurrenceId: Date | null
}

/** 折り返された行（先頭が空白・タブ）を元に戻す */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const result: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && result.length > 0) {
      result[result.length - 1] += line.slice(1)
    } else {
      result.push(line)
    }
  }
  return result
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/**
 * 20260901 / 20260901T100000 / 20260901T010000Z を Date にする。
 *
 * TZID 付きの時刻はタイムゾーン変換までは行わず、閲覧者のローカル時刻として扱う。
 * 日本国内で使う分にはほぼ問題にならないが、厳密ではない点に注意。
 */
function parseDateValue(value: string, isDateOnly: boolean): Date | null {
  const clean = value.trim()
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(clean)
  if (!match) return null

  const [, y, m, d, hh, mm, ss, utc] = match
  if (isDateOnly || hh === undefined) {
    return new Date(Number(y), Number(m) - 1, Number(d))
  }

  if (utc) {
    return new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
    )
  }
  return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
}

/**
 * 1 つの .ics から読み取る VEVENT の上限。
 *
 * 中継の上限が 5MB なので、切り詰めた VEVENT なら数万件が通る。
 * 1 予定あたりの展開数（MAX_OCCURRENCES_IN_RANGE）は抑えてあるが、
 * 予定の数そのものに天井が無いと、細工した .ics を購読先に登録するだけで
 * そのボードのカレンダーを開いた全員のタブを固められる（15 分ごとに再発する）。
 */
const MAX_EVENTS = 5000

/** 1 回の展開で作る回の総数の上限（上と同じ理由の天井） */
const MAX_OCCURRENCES_TOTAL = 20000

/** VEVENT を取り出す。VTODO や VTIMEZONE は無視する。 */
export function parseIcs(text: string): RawEvent[] {
  const lines = unfold(text)
  const events: RawEvent[] = []

  let current: Partial<RawEvent> | null = null
  let depth = 0

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {
        uid: '',
        summary: '',
        end: null,
        allDay: false,
        rrule: null,
        exdates: [],
        recurrenceId: null,
      }
      depth = 1
      continue
    }
    if (!current) continue

    if (line.startsWith('BEGIN:')) {
      depth++
      continue
    }
    if (line === 'END:VEVENT') {
      if (current.start && current.summary !== undefined) {
        events.push({
          uid: current.uid || `${current.summary}-${current.start.toISOString()}`,
          summary: current.summary || '(無題)',
          start: current.start,
          end: current.end ?? null,
          allDay: current.allDay ?? false,
          rrule: current.rrule ?? null,
          exdates: current.exdates ?? [],
          recurrenceId: current.recurrenceId ?? null,
        })
      }
      current = null
      depth = 0
      if (events.length >= MAX_EVENTS) break
      continue
    }
    if (line.startsWith('END:')) {
      depth--
      continue
    }
    if (depth > 1) continue // VALARM など入れ子の中は読まない

    const colon = line.indexOf(':')
    if (colon === -1) continue

    const rawKey = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const [name, ...params] = rawKey.split(';')
    const isDateOnly = params.some((p) => p.toUpperCase() === 'VALUE=DATE')

    switch (name.toUpperCase()) {
      case 'UID':
        current.uid = value
        break
      case 'SUMMARY':
        current.summary = unescapeText(value)
        break
      case 'DTSTART': {
        const date = parseDateValue(value, isDateOnly)
        if (date) {
          current.start = date
          current.allDay = isDateOnly
        }
        break
      }
      case 'DTEND': {
        const date = parseDateValue(value, isDateOnly)
        // 終日予定の DTEND は「翌日」を指すので 1 日戻す
        if (date) current.end = isDateOnly ? addDays(date, -1) : date
        break
      }
      case 'RRULE':
        current.rrule = value
        break
      case 'EXDATE': {
        // 1 行にカンマ区切りで複数入る。行そのものが複数回現れることもある
        for (const part of value.split(',')) {
          const date = parseDateValue(part, isDateOnly)
          if (date) current.exdates = [...(current.exdates ?? []), date]
        }
        break
      }
      case 'RECURRENCE-ID': {
        const date = parseDateValue(value, isDateOnly)
        if (date) current.recurrenceId = date
        break
      }
    }
  }

  return events
}

const FREQ_TO_RECURRENCE: Record<string, Exclude<Recurrence, 'none'>> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}

/**
 * RRULE のうち、よく使う FREQ / INTERVAL / COUNT / UNTIL だけを解釈する。
 * 回は基準日から直接計算するので、何年も前に始まった繰り返しでも上限に当たらない。
 */
function expandRrule(event: RawEvent, from: Date, to: Date): Date[] {
  const single = event.start >= from && event.start <= to ? [event.start] : []
  if (!event.rrule) return single

  const parts = Object.fromEntries(
    event.rrule.split(';').map((piece) => {
      const [k, v] = piece.split('=')
      return [k.toUpperCase(), v]
    }),
  ) as Record<string, string | undefined>

  const recurrence = FREQ_TO_RECURRENCE[(parts.FREQ ?? '').toUpperCase()]
  if (!recurrence) return single

  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1)
  const count = parts.COUNT ? Number(parts.COUNT) : null

  // UNTIL が DATE 形式なら「その日いっぱい」なので、翌日 0:00 を排他上限にする。
  // DATE-TIME なら、その時刻の回まで含む。
  let limit: Date | null = null
  let limitInclusive = false
  if (parts.UNTIL) {
    const isDateOnly = parts.UNTIL.length === 8
    const until = parseDateValue(parts.UNTIL, isDateOnly)
    if (until) {
      limit = isDateOnly ? addDays(until, 1) : until
      limitInclusive = !isDateOnly
    }
  }

  const durationMs = event.end ? Math.max(0, event.end.getTime() - event.start.getTime()) : 0
  const first = firstIndexAtOrAfter(
    event.start,
    recurrence,
    new Date(from.getTime() - durationMs),
    interval,
  )

  const result: Date[] = []
  for (let n = first; result.length < MAX_OCCURRENCES_IN_RANGE; n++) {
    if (count !== null && n >= count) break
    const cursor = nthOccurrence(event.start, recurrence, n, interval)
    if (cursor > to) break
    if (limit && (limitInclusive ? cursor > limit : cursor >= limit)) break
    if (cursor.getTime() + durationMs < from.getTime()) continue
    result.push(cursor)
  }

  return result
}

/** パースした予定を、表示範囲に現れる回だけに展開する */
export function expandFeedEvents(
  text: string,
  feed: { id: string; name: string; color: string },
  from: Date,
  to: Date,
): FeedEvent[] {
  const result: FeedEvent[] = []
  const raws = parseIcs(text)

  /*
   * RECURRENCE-ID を持つ VEVENT は、繰り返しの「その回だけの差し替え」。
   * 元の回を消してから差し替えを足さないと、動かした回が
   * 「元の位置」と「動かした先」の両方に出て二重になる。
   */
  const overrides = raws.filter((raw) => raw.recurrenceId !== null)
  const replaced = new Map<string, Set<number>>()
  for (const raw of overrides) {
    const times = replaced.get(raw.uid) ?? new Set<number>()
    times.add(raw.recurrenceId!.getTime())
    replaced.set(raw.uid, times)
  }

  const push = (raw: RawEvent, start: Date, uid: string) => {
    const durationMs = raw.end ? Math.max(0, raw.end.getTime() - raw.start.getTime()) : 0
    result.push({
      uid,
      title: raw.summary,
      start,
      end: durationMs > 0 ? new Date(start.getTime() + durationMs) : null,
      allDay: raw.allDay,
      feedId: feed.id,
      feedName: feed.name,
      color: feed.color,
    })
  }

  for (const raw of raws) {
    if (raw.recurrenceId !== null) continue // 差し替えは下でまとめて足す

    const excluded = new Set(raw.exdates.map((d) => d.getTime()))
    const movedAway = replaced.get(raw.uid)

    for (const start of expandRrule(raw, from, to)) {
      if (result.length >= MAX_OCCURRENCES_TOTAL) return result
      const at = start.getTime()
      // EXDATE で消された回と、差し替えられた回は、元の位置には出さない
      if (excluded.has(at) || movedAway?.has(at)) continue
      push(raw, start, `${feed.id}:${raw.uid}:${start.toISOString()}`)
    }
  }

  for (const raw of overrides) {
    if (result.length >= MAX_OCCURRENCES_TOTAL) return result
    if (raw.start < from || raw.start > to) continue
    // uid は「元の回の時刻」で作る。動かしても同じ回だと分かるように
    push(raw, raw.start, `${feed.id}:${raw.uid}:${raw.recurrenceId!.toISOString()}`)
  }

  return result
}

/** 上限に達して打ち切られたか（画面に「一部のみ表示」と出すため） */
export function isFeedTruncated(events: FeedEvent[]): boolean {
  return events.length >= MAX_OCCURRENCES_TOTAL
}
