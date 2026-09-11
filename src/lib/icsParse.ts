import { addDays } from 'date-fns'
import { MAX_OCCURRENCES_IN_RANGE } from '../../supabase/functions/_shared/recurrence.ts'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  expandRecurrence,
  fromWall,
  type ByDayPart,
  type IcsFreq,
  type RecurrenceSpec,
  type Zone,
  type ZoneTransition,
} from './icsRecurrence'
import { isKnownTimeZone, normalizeTzid, type ZonedParts } from './tz'

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
  /**
   * 繰り返しの形式を読めなかったか。
   *
   * true のとき、出しているのは <code>DTSTART</code> の 1 回だけで、
   * 2 回目以降は出していない。読めない指定を無視して DTSTART の日付で繰り返すと、
   * 「出ない」よりも悪い「もっともらしい間違った予定」になるため
   * （unreadableRrule のコメントを参照）。
   */
  recurrenceUnsupported: boolean
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

/** VTIMEZONE の切り替えを起こす窓。外側は端のずれで通す */
const TZ_WINDOW_FROM = new Date(Date.UTC(1970, 0, 1))
const TZ_WINDOW_TO = new Date(Date.UTC(2100, 0, 1))

/** 1 つの STANDARD / DAYLIGHT が生む切り替えの上限 */
const MAX_TZ_TRANSITIONS = 400

/** 読む VTIMEZONE の数の上限（細工された .ics で膨らませない） */
const MAX_TZ_ZONES = 50

/** VTIMEZONE の中の STANDARD / DAYLIGHT 1 つぶん */
interface TzSubComponent {
  standard: boolean
  /** 切り替わる前のずれ。DTSTART はこの暦の壁時計として書かれている */
  offsetFrom: number
  /** 切り替わったあとのずれ */
  offsetTo: number
  start: ZonedParts | null
  rrule: string | null
  rdates: string[]
}

/** TZID も Z も付かない値（VTIMEZONE の DTSTART）を、壁時計として読む */
function parseWallParts(value: string): ZonedParts | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim())
  if (!match) return null
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: Number(match[4]),
    mm: Number(match[5]),
    ss: Number(match[6]),
  }
}

/** その STANDARD / DAYLIGHT が起こす切り替えを並べる */
function transitionsOf(sub: TzSubComponent): ZoneTransition[] {
  if (!sub.start) return []

  // DTSTART と RDATE は「切り替わる前のずれ」での壁時計
  const before: Zone = { kind: 'fixed', offsetMs: sub.offsetFrom }
  const first = fromWall(before, sub.start)

  const out: ZoneTransition[] = [{ at: first.getTime(), offsetMs: sub.offsetTo }]

  for (const raw of sub.rdates) {
    const parts = parseWallParts(raw)
    if (parts) out.push({ at: fromWall(before, parts).getTime(), offsetMs: sub.offsetTo })
  }

  if (sub.rrule) {
    const spec = rruleSpecOf(sub.rrule, first, before, 0)
    if (spec) {
      const dates = expandRecurrence(spec, TZ_WINDOW_FROM, TZ_WINDOW_TO, MAX_TZ_TRANSITIONS)
      for (const date of dates) out.push({ at: date.getTime(), offsetMs: sub.offsetTo })
    }
  }

  return out
}

/**
 * VTIMEZONE 1 つを、切り替えの一覧を持つ暦にする。
 *
 * Intl が知らない名前（Outlook の "Customized Time Zone"、社内で配られた
 * 独自の TZID など）に出会ったときの逃げ道。
 *
 * 以前はここで STANDARD の TZOFFSETTO だけを拾い、一年中そのずれで通していた。
 * ずれの量は相手が書いてきた値なので名前を無視するよりは近いが、
 * 夏時間のある地域では半年ぶん 1 時間ずれる。会議の .ics を貼った人には
 * 「夏のあいだだけ 1 時間早く出る」という形で見え、理由が分からない。
 *
 * VTIMEZONE は切り替えの規則そのもの（FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU の形）を
 * 持っているので、それを展開して「いつ何分ずれるか」の一覧にする。
 * 規則が読めなかったときだけ、これまでどおり固定のずれへ落ちる。
 */
function zoneOf(subs: TzSubComponent[]): Zone | null {
  if (subs.length === 0) return null

  const collected: (ZoneTransition & { from: number })[] = []
  for (const sub of subs) {
    for (const t of transitionsOf(sub)) collected.push({ ...t, from: sub.offsetFrom })
  }

  if (collected.length === 0) {
    // 切り替えが読めない。STANDARD が無い（一年中夏時間扱いの）書き方もある
    const fallback = subs.find((sub) => sub.standard) ?? subs[0]
    return { kind: 'fixed', offsetMs: fallback.offsetTo }
  }

  collected.sort((a, b) => a.at - b.at)

  // 同じ時刻に 2 つ並んだら、後から書かれたほうを残す
  const transitions: ZoneTransition[] = collected
    .filter((t, i) => i === collected.length - 1 || t.at !== collected[i + 1].at)
    .map(({ at, offsetMs }) => ({ at, offsetMs }))

  // 最初の切り替えより前のずれ。一番早い切り替えの「切り替わる前」を採る
  return { kind: 'rules', base: collected[0].from, transitions }
}

/**
 * VTIMEZONE を名前ごとの暦にする。
 *
 * STANDARD / DAYLIGHT は 1 つの VTIMEZONE に何組でも書ける（規則が変わった年を
 * またぐ書き方）。全部集めてから 1 本の切り替えの一覧に均す。
 */
function parseVTimezones(lines: string[]): Map<string, Zone> {
  const zones = new Map<string, Zone>()

  let tzid: string | null = null
  let subs: TzSubComponent[] = []
  let current: TzSubComponent | null = null
  let inside = false

  for (const line of lines) {
    if (line === 'BEGIN:VTIMEZONE') {
      inside = true
      tzid = null
      subs = []
      current = null
      continue
    }
    if (!inside) continue

    if (line === 'END:VTIMEZONE') {
      const zone = zoneOf(subs)
      if (tzid && zone && zones.size < MAX_TZ_ZONES) zones.set(tzid, zone)
      inside = false
      current = null
      continue
    }
    if (line === 'BEGIN:STANDARD' || line === 'BEGIN:DAYLIGHT') {
      current = {
        standard: line === 'BEGIN:STANDARD',
        offsetFrom: 0,
        offsetTo: 0,
        start: null,
        rrule: null,
        rdates: [],
      }
      continue
    }
    if (line === 'END:STANDARD' || line === 'END:DAYLIGHT') {
      if (current) subs.push(current)
      current = null
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).split(';')[0].toUpperCase()
    const value = line.slice(colon + 1)

    if (current === null) {
      if (name === 'TZID') tzid = value.trim()
      continue
    }

    switch (name) {
      case 'TZOFFSETFROM': {
        const offset = parseUtcOffset(value)
        if (offset !== null) current.offsetFrom = offset
        break
      }
      case 'TZOFFSETTO': {
        const offset = parseUtcOffset(value)
        if (offset !== null) current.offsetTo = offset
        break
      }
      case 'DTSTART':
        current.start = parseWallParts(value)
        break
      case 'RRULE':
        current.rrule = value
        break
      case 'RDATE':
        for (const part of value.split(',')) current.rdates.push(part)
        break
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
 *   TZID が Intl で読める -> そのゾーン（夏時間は tz データが面倒を見る）
 *   TZID を VTIMEZONE が説明している -> そこに書かれた切り替えの規則
 *   どれでもない          -> フローティング。RFC どおり閲覧者の暦で読む
 *
 * Intl を先に見るのは、名前が引けるなら本物の tz データのほうが確かだから。
 * VTIMEZONE は相手が書いてきた分しか持っていない（多くは前後 1 年ぶん）。
 */
function zoneFor(value: string, params: string[], zones: Map<string, Zone>): Zone {
  if (/Z$/.test(value.trim())) return UTC_ZONE

  const raw = tzidParam(params)
  if (!raw) return LOCAL_ZONE

  const normalized = normalizeTzid(raw)
  if (isKnownTimeZone(normalized)) return { kind: 'iana', tzid: normalized }

  return zones.get(raw.trim()) ?? zones.get(normalized) ?? LOCAL_ZONE
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
 * RRULE のうち、実際に配られている .ics でよく見るものを解釈する。
 *
 *   FREQ / INTERVAL / COUNT / UNTIL
 *   BYDAY（`TU,TH` と `2TU` / `-1FR`）・BYSETPOS・WKST
 *   BYMONTH・BYMONTHDAY（負は月末から数える）
 *
 * まだ読まないのは BYWEEKNO / BYYEARDAY / BYHOUR / BYMINUTE / BYSECOND。
 * これらは「無かったこと」にはしない。見つけたら展開そのものをやめ、
 * DTSTART の 1 回だけを出して画面で断る（unreadableRrule）。
 * 無視して DTSTART の日付で繰り返すと、出ないより悪い
 * 「もっともらしい間違った予定」になるため。
 *
 * 回は基準日から直接計算するので、何年も前に始まった繰り返しでも上限に当たらない。
 * その月に無い日（2 月の 31 日）はその回を出さない —— RFC 5545 の決まり。
 * ボード自身の予定は逆に月末へ丸めるが、その差は書き出し側が RDATE で埋めている。
 */
/** RRULE の曜日の綴り。0=日 … 6=土 */
const ICS_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * BYDAY を読む。`TU,TH` と `2TU`（序数つき）、`-1FR`（最後から）を受け付ける。
 *
 * 序数つきは Google と Apple が書き出す形。序数なし + BYSETPOS で
 * 同じことを書く実装（Outlook など）もあるので、そちらは parseNumberList で受ける。
 * 読めない語は落とす。
 */
export function parseByDay(value: string | undefined): ByDayPart[] {
  const text = (value ?? '').trim()
  if (!text) return []

  const parts: ByDayPart[] = []
  for (const token of text.split(',')) {
    const match = /^([+-]?\d+)?([A-Za-z]{2})$/.exec(token.trim())
    if (!match) continue
    const weekday = ICS_WEEKDAYS.indexOf(match[2].toUpperCase())
    if (weekday < 0) continue
    const nth = match[1] ? Number(match[1]) : null
    if (nth !== null && (!Number.isInteger(nth) || nth === 0)) continue
    parts.push({ weekday, nth })
  }
  return parts
}

/** `-1,2` のような整数の並びを読む。0 と読めない値は落とす */
export function parseNumberList(value: string | undefined): number[] {
  const text = (value ?? '').trim()
  if (!text) return []

  return text
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter((n) => Number.isInteger(n) && n !== 0)
}

/** WKST。RFC 5545 の既定は月曜 */
export function parseWkst(value: string | undefined): number {
  const index = ICS_WEEKDAYS.indexOf((value ?? '').trim().toUpperCase())
  return index >= 0 ? index : 1
}

/** RRULE の 1 行を `名前 -> 値` にする */
function rruleParts(rrule: string): Record<string, string | undefined> {
  return Object.fromEntries(
    rrule.split(';').map((piece) => {
      const [k, v] = piece.split('=')
      return [k.toUpperCase(), v]
    }),
  ) as Record<string, string | undefined>
}

/**
 * まだ読めない RRULE の部品。
 *
 * どれも「いつ起きるか」を大きく変える指定なので、無視して DTSTART の日付で
 * 繰り返すと、出ないより悪い「もっともらしい間違った予定」になる。
 *
 *   FREQ=YEARLY;BYYEARDAY=100
 *
 * を「毎年 DTSTART の日」と読むと、100 日目とは何の関係もない日に、
 * 正しそうな顔をした予定が毎年並ぶ。見ている人には間違いだと分からない。
 * カレンダーとしては、間違った日に出すより「出さずに断る」ほうがましなので、
 * こういう指定を見つけたら展開そのものをやめる（unreadableRrule）。
 */
const UNREADABLE_RRULE_PARTS = ['BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']

/**
 * その RRULE を展開してよいか。読めない理由を並べて返す（空なら展開してよい）。
 *
 * 読めない FREQ も同じ扱いにする。どちらも「規則が読めていない」ことに変わりはなく、
 * 読めないまま DTSTART で繰り返すのが一番まずい。
 */
export function unreadableRrule(rrule: string): string[] {
  const parts = rruleParts(rrule)
  const reasons: string[] = []

  if (!FREQ_TO_ICS[(parts.FREQ ?? '').toUpperCase()]) reasons.push('FREQ')
  for (const name of UNREADABLE_RRULE_PARTS) {
    const value = parts[name]
    if (value !== undefined && value.trim() !== '') reasons.push(name)
  }
  return reasons
}

/** その予定の繰り返しを展開できるか */
function canExpand(event: RawEvent): boolean {
  return event.rrule === null || unreadableRrule(event.rrule).length === 0
}

/**
 * RRULE の 1 行を、展開に使う形にする。読めない FREQ なら null。
 *
 * VEVENT からも VTIMEZONE の STANDARD / DAYLIGHT からも呼ぶ。
 * 切り替えの規則（FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU）は RRULE そのものなので、
 * 2 か所で別々に読むと、片方だけ直したときに黙ってずれる。
 */
export function rruleSpecOf(
  rrule: string,
  start: Date,
  zone: Zone,
  durationMs: number,
): RecurrenceSpec | null {
  const parts = rruleParts(rrule)

  const freq = FREQ_TO_ICS[(parts.FREQ ?? '').toUpperCase()]
  if (!freq) return null

  // UNTIL が DATE 形式なら「その日いっぱい」なので、翌日 0:00 を排他上限にする。
  // DATE-TIME なら、その時刻の回まで含む。
  let until: Date | null = null
  let untilInclusive = false
  if (parts.UNTIL) {
    const isDateOnly = parts.UNTIL.length === 8
    const parsed = parseDateValue(parts.UNTIL, isDateOnly, zone)
    if (parsed) {
      until = isDateOnly ? addDays(parsed, 1) : parsed
      untilInclusive = !isDateOnly
    }
  }

  return {
    start,
    zone,
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    byDay: parseByDay(parts.BYDAY),
    byMonth: parseNumberList(parts.BYMONTH).filter((m) => m >= 1 && m <= 12),
    byMonthDay: parseNumberList(parts.BYMONTHDAY).filter((d) => d >= -31 && d <= 31),
    bySetPos: parseNumberList(parts.BYSETPOS),
    wkst: parseWkst(parts.WKST),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until,
    untilInclusive,
    durationMs,
  }
}

function expandRrule(event: RawEvent, from: Date, to: Date): Date[] {
  const durationMs = event.end ? Math.max(0, event.end.getTime() - event.start.getTime()) : 0
  // 繰り返さない予定は「開始が範囲内」だけを見る。範囲の手前から続く長い予定を
  // 拾うのは繰り返しの側の話で、ここを広げると単発の予定の見え方が変わる
  const base = event.start >= from && event.start <= to ? [event.start] : []

  if (!event.rrule) return base

  // 読めない指定があれば、DTSTART の 1 回だけ。違う日に出すより出さないほうがまし
  if (!canExpand(event)) return base

  const spec = rruleSpecOf(event.rrule, event.start, event.zone, durationMs)
  if (!spec) return base

  return expandRecurrence(spec, from, to, MAX_OCCURRENCES_IN_RANGE)
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
      recurrenceUnsupported: !canExpand(raw),
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

/**
 * 繰り返しを展開できなかった予定が混じっているか。
 *
 * 混じっていたら購読先ごとの一行で断る。黙って 1 回だけ出すと、
 * 「2 回目以降が来ていない」ことに誰も気づけない。
 */
export function hasUnsupportedRecurrence(events: FeedEvent[]): boolean {
  return events.some((event) => event.recurrenceUnsupported)
}
