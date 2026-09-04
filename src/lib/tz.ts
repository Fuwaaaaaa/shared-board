/*
 * タイムゾーンの換算。外部カレンダー（.ics）を読むときにだけ使う。
 *
 * ボード自身の暦は Asia/Tokyo 固定で、supabase/functions/_shared/dates.ts が
 * 「実行環境の tz データに左右されないため Intl を使わない」方針で書かれている。
 * ここはその方針の外側 —— 相手が名乗ってきた任意のゾーンを読む必要があるので、
 * Intl の持つ tz データに頼る。だから共有モジュールには置かない。
 *
 * 知らないゾーンでは null を返す。呼ぶ側で「VTIMEZONE の固定オフセットに退避」
 * 「フローティング扱い」など、次の手に進めるようにするため。
 */

/** 壁時計。m は 1〜12 */
export interface ZonedParts {
  y: number
  m: number
  d: number
  hh: number
  mm: number
  ss: number
}

/**
 * Outlook / Exchange が出す Windows のゾーン名を IANA に寄せる。
 *
 * 全部を網羅するつもりはない。実際に配られている .ics でよく見るものだけ。
 * ここに無い名前は「知らないゾーン」として扱われ、VTIMEZONE の
 * 固定オフセットへ退避する。
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'singapore standard time': 'Asia/Singapore',
  'se asia standard time': 'Asia/Bangkok',
  'india standard time': 'Asia/Kolkata',
  'arabian standard time': 'Asia/Dubai',
  'israel standard time': 'Asia/Jerusalem',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'russian standard time': 'Europe/Moscow',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'aus central standard time': 'Australia/Darwin',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'utc': 'UTC',
}

/**
 * TZID の値を IANA 名に寄せる。
 *
 * - 引用符を外す（TZID="W. Europe Standard Time"）
 * - 先頭に付く提供元を落とす（/freeassociation.sourceforge.net/Asia/Tokyo、
 *   /mozilla.org/20050126_1/Asia/Tokyo のように段数が一定でないので、
 *   後ろから見て読める名前になったところを採る）
 * - Windows のゾーン名を置き換える
 */
export function normalizeTzid(raw: string): string {
  const value = raw.trim().replace(/^"(.*)"$/, '$1').trim()

  if (value.startsWith('/')) {
    const segments = value.slice(1).split('/')
    for (let i = 0; i < segments.length; i++) {
      const candidate = segments.slice(i).join('/')
      if (isKnownTimeZone(candidate)) return candidate
    }
    // 読める名前にならなければ、提供元とおぼしき先頭 1 つだけ落として返す
    return segments.slice(1).join('/')
  }

  return WINDOWS_TO_IANA[value.toLowerCase()] ?? value
}

/** Intl が知らないゾーンでは null。作り直しは高くつくので覚えておく */
const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(tzid: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tzid)
  if (cached !== undefined) return cached

  let formatter: Intl.DateTimeFormat | null = null
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    // timeZone が通っても、名前によっては整形時に落ちることがある
    formatter.format(0)
  } catch {
    formatter = null
  }
  formatters.set(tzid, formatter)
  return formatter
}

/** その名前で時刻を読めるか */
export function isKnownTimeZone(tzid: string): boolean {
  return formatterFor(tzid) !== null
}

/** そのゾーンでの壁時計に分解する。知らないゾーンなら null */
export function utcToWallClock(tzid: string, date: Date): ZonedParts | null {
  const formatter = formatterFor(tzid)
  if (!formatter) return null

  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  // 24 時制でも 0 時を 24 と出す環境があるので均す
  if (parts.hour === 24) parts.hour = 0

  return {
    y: parts.year,
    m: parts.month,
    d: parts.day,
    hh: parts.hour,
    mm: parts.minute,
    ss: parts.second,
  }
}

/** その瞬間の、そのゾーンの UTC からのずれ（ミリ秒）。知らないゾーンなら null */
export function zoneOffsetMs(tzid: string, at: Date): number | null {
  const parts = utcToWallClock(tzid, at)
  if (!parts) return null
  const asUtc = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss)
  // ミリ秒は整形に出てこないので、比較の前に落とす
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * そのゾーンの壁時計を、実際の時刻に直す。知らないゾーンなら null。
 *
 * ずれの量は求めたい時刻そのものに依存する（夏時間の切り替わりを跨ぐと変わる）ので、
 * 一度あたりを付けてから、その時刻でのずれで測り直す。
 *
 * 切り替わりの隙間に落ちる壁時計（春に飛ばされる 1 時間）は .ics の仕様でも
 * 決まっていない。ここでは切り替え前のずれで読んだ時刻を返す。
 */
export function wallClockToUtc(tzid: string, p: ZonedParts): Date | null {
  const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)

  const first = zoneOffsetMs(tzid, new Date(guess))
  if (first === null) return null

  const second = zoneOffsetMs(tzid, new Date(guess - first))
  if (second === null || second === first) return new Date(guess - first)

  // 測り直したずれで壁時計が合うならそちら。合わなければ最初の読みを採る
  const adjusted = new Date(guess - second)
  const check = utcToWallClock(tzid, adjusted)
  const matches =
    check !== null &&
    check.y === p.y &&
    check.m === p.m &&
    check.d === p.d &&
    check.hh === p.hh &&
    check.mm === p.mm
  return matches ? adjusted : new Date(guess - first)
}
