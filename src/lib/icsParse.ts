import { addDays } from 'date-fns'
import { MAX_OCCURRENCES_IN_RANGE } from '../../supabase/functions/_shared/recurrence.ts'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  expandRecurrence,
  fromWall,
  type IcsFreq,
  type Zone,
} from './icsRecurrence'
import { isKnownTimeZone, normalizeTzid } from './tz'

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

export interface RawEvent {
  uid: string
  summary: string
  start: Date
  end: Date | null
  allDay: boolean
  /** DTSTART が名乗っていた暦。繰り返しはこの暦で数える */
  zone: Zone
  rrule: string | null
  /** EXDATE。この時刻に始まる回は出さない（「この回だけ削除」） */
  exdates: Date[]
  /** RDATE。RRULE で出ない回を名指しで足す */
  rdates: Date[]
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

/** +0900 / -0530 / +091500 をミリ秒にする */
function parseUtcOffset(value: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim())
  if (!match) return null
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3])
  const seconds = Number(match[4] ?? 0)
  return sign * ((hours * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * VTIMEZONE から、名前ごとの固定オフセットを拾う。
 *
 * Intl が知らない名前（Outlook の "Customized Time Zone" など）に出会ったときの
 * 逃げ道。夏時間の切り替えまでは追わず、STANDARD のずれで通す。
 * ずれの量そのものは相手が書いてきた値なので、名前を無視するよりはずっと近い。
 */
function parseVTimezones(lines: string[]): Map<string, number> {
  const zones = new Map<string, number>()

  let tzid: string | null = null
  let standard: number | null = null
  let daylight: number | null = null
  let section: 'standard' | 'daylight' | null = null
  let inside = false

  for (const line of lines) {
    if (line === 'BEGIN:VTIMEZONE') {
      inside = true
      tzid = null
      standard = null
      daylight = null
      section = null
      continue
    }
    if (!inside) continue

    if (line === 'END:VTIMEZONE') {
      // STANDARD が無い（一年中夏時間扱いの）書き方もあるので、その場合は DAYLIGHT
      const offset = standard ?? daylight
      if (tzid && offset !== null) zones.set(tzid, offset)
      inside = false
      continue
    }
    if (line === 'BEGIN:STANDARD') {
      section = 'standard'
      continue
    }
    if (line === 'BEGIN:DAYLIGHT') {
      section = 'daylight'
      continue
    }
    if (line === 'END:STANDARD' || line === 'END:DAYLIGHT') {
      section = null
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).split(';')[0].toUpperCase()
    const value = line.slice(colon + 1)

    if (name === 'TZID' && section === null) {
      tzid = value.trim()
    } else if (name === 'TZOFFSETTO') {
      const offset = parseUtcOffset(value)
      if (offset === null) continue
      if (section === 'standard') standard = offset
      else if (section === 'daylight') daylight = offset
    }
  }

  return zones
}

/** プロパティのパラメータから TZID を取り出す */
function tzidParam(params: string[]): string | null {
  for (const param of params) {
    if (param.toUpperCase().startsWith('TZID=')) return param.slice('TZID='.length)
  }
  return null
}

/**
 * その値をどの暦で読むかを決める。
 *
 *   末尾が Z              -> UTC
 *   TZID が Intl で読める -> そのゾーン
 *   TZID を VTIMEZONE が説明している -> その固定オフセット
 *   どれでもない          -> フローティング。RFC どおり閲覧者の暦で読む
 */
function zoneFor(value: string, params: string[], zones: Map<string, number>): Zone {
  if (/Z$/.test(value.trim())) return UTC_ZONE

  const raw = tzidParam(params)
  if (!raw) return LOCAL_ZONE

  const normalized = normalizeTzid(raw)
  if (isKnownTimeZone(normalized)) return { kind: 'iana', tzid: normalized }

  const offset = zones.get(raw.trim()) ?? zones.get(normalized)
  if (offset !== undefined) return { kind: 'fixed', offsetMs: offset }

  return LOCAL_ZONE
}

/**
 * 20260901 / 20260901T100000 / 20260901T010000Z を Date にする。
 *
 * 日付だけの値（終日予定）は閲覧者ローカルの 0:00 として読む。ボードの終日予定も
 * 同じ扱いなので（src/lib/recurrence.ts の pinAllDay）、並べたときに揃う。
 */
function parseDateValue(value: string, isDateOnly: boolean, zone: Zone): Date | null {
  const clean = value.trim()
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(clean)
  if (!match) return null

  const [, y, m, d, hh, mm, ss] = match
  if (isDateOnly || hh === undefined) {
    return new Date(Number(y), Number(m) - 1, Number(d))
  }

  return fromWall(zone, {
    y: Number(y),
    m: Number(m),
    d: Number(d),
    hh: Number(hh),
    mm: Number(mm),
    ss: Number(ss),
  })
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

/** VEVENT を取り出す。VTODO は無視し、VTIMEZONE はゾーンの逃げ道としてだけ読む。 */
export function parseIcs(text: string): RawEvent[] {
  const lines = unfold(text)
  const zones = parseVTimezones(lines)
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
        zone: LOCAL_ZONE,
        rrule: null,
        exdates: [],
        rdates: [],
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
          zone: current.zone ?? LOCAL_ZONE,
          rrule: current.rrule ?? null,
          exdates: current.exdates ?? [],
          rdates: current.rdates ?? [],
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
    const zone = zoneFor(value, params, zones)

    switch (name.toUpperCase()) {
      case 'UID':
        current.uid = value
        break
      case 'SUMMARY':
        current.summary = unescapeText(value)
        break
      case 'DTSTART': {
        const date = parseDateValue(value, isDateOnly, zone)
        if (date) {
          current.start = date
          current.allDay = isDateOnly
          current.zone = zone
        }
        break
      }
      case 'DTEND': {
        const date = parseDateValue(value, isDateOnly, zone)
        // 終日予定の DTEND は「翌日」を指すので 1 日戻す
        if (date) current.end = isDateOnly ? addDays(date, -1) : date
        break
      }
      case 'RRULE':
        current.rrule = value
        break
      case 'EXDATE':
      case 'RDATE': {
        // 1 行にカンマ区切りで複数入る。行そのものが複数回現れることもある
        const key = name.toUpperCase() === 'EXDATE' ? 'exdates' : 'rdates'
        for (const part of value.split(',')) {
          const date = parseDateValue(part, isDateOnly, zone)
          if (date) current[key] = [...(current[key] ?? []), date]
        }
        break
      }
      case 'RECURRENCE-ID': {
        const date = parseDateValue(value, isDateOnly, zone)
        if (date) current.recurrenceId = date
        break
      }
    }
  }

  return events
}

const FREQ_TO_ICS: Record<string, IcsFreq> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}

/**
 * RRULE のうち、よく使う FREQ / INTERVAL / COUNT / UNTIL だけを解釈する。
 *
 * BYDAY・BYMONTHDAY などは見ていないので、「第 2 火曜」のような指定は
 * DTSTART の日付での単純な繰り返しになる。
 *
 * 回は基準日から直接計算するので、何年も前に始まった繰り返しでも上限に当たらない。
 * その月に無い日（2 月の 31 日）はその回を出さない —— RFC 5545 の決まり。
 * ボード自身の予定は逆に月末へ丸めるが、その差は書き出し側が RDATE で埋めている。
 */
function expandRrule(event: RawEvent, from: Date, to: Date): Date[] {
  const durationMs = event.end ? Math.max(0, event.end.getTime() - event.start.getTime()) : 0
  // 繰り返さない予定は「開始が範囲内」だけを見る。範囲の手前から続く長い予定を
  // 拾うのは繰り返しの側の話で、ここを広げると単発の予定の見え方が変わる
  const base = event.start >= from && event.start <= to ? [event.start] : []

  if (!event.rrule) return base

  const parts = Object.fromEntries(
    event.rrule.split(';').map((piece) => {
      const [k, v] = piece.split('=')
      return [k.toUpperCase(), v]
    }),
  ) as Record<string, string | undefined>

  const freq = FREQ_TO_ICS[(parts.FREQ ?? '').toUpperCase()]
  if (!freq) return base

  // UNTIL が DATE 形式なら「その日いっぱい」なので、翌日 0:00 を排他上限にする。
  // DATE-TIME なら、その時刻の回まで含む。
  let until: Date | null = null
  let untilInclusive = false
  if (parts.UNTIL) {
    const isDateOnly = parts.UNTIL.length === 8
    const parsed = parseDateValue(parts.UNTIL, isDateOnly, event.zone)
    if (parsed) {
      until = isDateOnly ? addDays(parsed, 1) : parsed
      untilInclusive = !isDateOnly
    }
  }

  return expandRecurrence(
    {
      start: event.start,
      zone: event.zone,
      freq,
      interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
      count: parts.COUNT ? Number(parts.COUNT) : null,
      until,
      untilInclusive,
      durationMs,
    },
    from,
    to,
    MAX_OCCURRENCES_IN_RANGE,
  )
}

/** RRULE で出た回に、RDATE で名指しされた回を足す（重複は落とす） */
function occurrencesOf(event: RawEvent, from: Date, to: Date): Date[] {
  const dates = expandRrule(event, from, to)
  if (event.rdates.length === 0) return dates

  const durationMs = event.end ? Math.max(0, event.end.getTime() - event.start.getTime()) : 0
  const seen = new Set(dates.map((d) => d.getTime()))

  for (const date of event.rdates) {
    if (seen.has(date.getTime())) continue
    if (date > to || date.getTime() + durationMs < from.getTime()) continue
    seen.add(date.getTime())
    dates.push(date)
  }

  dates.sort((a, b) => a.getTime() - b.getTime())
  return dates
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

    for (const start of occurrencesOf(raw, from, to)) {
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
