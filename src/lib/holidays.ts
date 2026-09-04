/**
 * 日本の祝日（内閣府の定義にもとづく計算）
 *
 * 1980〜2099 年に対応する。祝日法の改正（ハッピーマンデー・みどりの日の移動・山の日の新設など）と
 * 皇室行事による 1 回限りの休日、2020・2021 年の東京オリンピックによる特例移動も入れてある。
 * 春分・秋分は近似式（1980〜2099 年で有効）で求める。
 * 外部通信はしないので、オフラインでも動く。
 */

type DayMap = Map<string, string>

const MIN_YEAR = 1980
const MAX_YEAR = 2099

const cache = new Map<number, DayMap>()

function key(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 曜日（0=日）。暦の計算なので UTC で行い、実行環境のタイムゾーンに影響されないようにする */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** その月の第 n 月曜日の日付 */
function nthMonday(year: number, month: number, nth: number): number {
  const firstDow = dayOfWeek(year, month, 1)
  const firstMonday = 1 + ((8 - firstDow) % 7)
  return firstMonday + (nth - 1) * 7
}

/** 春分の日（近似式） */
function shunbun(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

/** 秋分の日（近似式） */
function shubun(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

/** 年内の通し日（1 始まり）から月日へ */
function fromDayOfYear(year: number, dayOfYear: number): { month: number; day: number } {
  const date = new Date(Date.UTC(year, 0, dayOfYear))
  return { month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365
}

/** 法律で定められた「国民の祝日」（振替休日・国民の休日を含まない） */
function buildShukujitsu(year: number): DayMap {
  const map: DayMap = new Map()
  const add = (month: number, day: number, name: string) => map.set(key(year, month, day), name)

  add(1, 1, '元日')
  add(1, year >= 2000 ? nthMonday(year, 1, 2) : 15, '成人の日')
  add(2, 11, '建国記念の日')
  add(3, shunbun(year), '春分の日')

  // 4/29 は昭和天皇の誕生日 → みどりの日 → 昭和の日と名前を変えてきた
  if (year <= 1988) add(4, 29, '天皇誕生日')
  else if (year <= 2006) add(4, 29, 'みどりの日')
  else add(4, 29, '昭和の日')

  add(5, 3, '憲法記念日')
  if (year >= 2007) add(5, 4, 'みどりの日')
  add(5, 5, 'こどもの日')

  // 海の日: 1996 年に 7/20 で新設、2003 年から第 3 月曜
  if (year === 2020) add(7, 23, '海の日')
  else if (year === 2021) add(7, 22, '海の日')
  else if (year >= 2003) add(7, nthMonday(year, 7, 3), '海の日')
  else if (year >= 1996) add(7, 20, '海の日')

  // 山の日: 2016 年に新設
  if (year === 2020) add(8, 10, '山の日')
  else if (year === 2021) add(8, 8, '山の日')
  else if (year >= 2016) add(8, 11, '山の日')

  // 敬老の日: 2003 年から第 3 月曜、それ以前は 9/15
  add(9, year >= 2003 ? nthMonday(year, 9, 3) : 15, '敬老の日')
  add(9, shubun(year), '秋分の日')

  // 体育の日: 2000 年から第 2 月曜、2020 年からスポーツの日
  if (year === 2020) add(7, 24, 'スポーツの日')
  else if (year === 2021) add(7, 23, 'スポーツの日')
  else if (year >= 2020) add(10, nthMonday(year, 10, 2), 'スポーツの日')
  else if (year >= 2000) add(10, nthMonday(year, 10, 2), '体育の日')
  else add(10, 10, '体育の日')

  add(11, 3, '文化の日')
  add(11, 23, '勤労感謝の日')

  // 天皇誕生日: 平成は 12/23、令和は 2/23（2019 年は代替わりの年でどちらもない）
  if (year >= 2020) add(2, 23, '天皇誕生日')
  else if (year >= 1989 && year <= 2018) add(12, 23, '天皇誕生日')

  // 皇室行事による 1 回限りの休日
  if (year === 1989) add(2, 24, '昭和天皇の大喪の礼')
  if (year === 1990) add(11, 12, '即位礼正殿の儀')
  if (year === 1993) add(6, 9, '皇太子徳仁親王の結婚の儀')
  if (year === 2019) {
    add(5, 1, '天皇の即位の日')
    add(10, 22, '即位礼正殿の儀')
  }

  return map
}

function buildYear(year: number): DayMap {
  // 1. 国民の祝日
  const shukujitsu = buildShukujitsu(year)
  const map: DayMap = new Map(shukujitsu)

  // 2. 振替休日: 祝日が日曜なら、次の祝日でない日を休みにする（2007 年より前は翌日だけ）
  for (const k of shukujitsu.keys()) {
    const [y, m, d] = k.split('-').map(Number)
    if (dayOfWeek(y, m, d) !== 0) continue

    let cursor = new Date(Date.UTC(y, m - 1, d + 1))
    if (year >= 2007) {
      while (shukujitsu.has(key(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()))) {
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
      }
    }
    const ck = key(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate())
    if (cursor.getUTCFullYear() === year && !map.has(ck)) map.set(ck, '振替休日')
  }

  // 3. 国民の休日: 前日と翌日が祝日の平日（1985-12-27 施行）。
  //    日曜と振替休日は対象外。月末をまたぐ並び（2019/4/30）も拾えるよう、年内の全日を走査する
  const total = daysInYear(year)
  for (let n = 1; n <= total; n++) {
    const { month, day } = fromDayOfYear(year, n)
    if (year < 1985 || (year === 1985 && (month < 12 || day < 27))) continue

    const k = key(year, month, day)
    if (map.has(k)) continue
    if (dayOfWeek(year, month, day) === 0) continue

    const prev = n > 1 ? fromDayOfYear(year, n - 1) : null
    const next = n < total ? fromDayOfYear(year, n + 1) : null
    if (
      prev &&
      next &&
      shukujitsu.has(key(year, prev.month, prev.day)) &&
      shukujitsu.has(key(year, next.month, next.day))
    ) {
      map.set(k, '国民の休日')
    }
  }

  return map
}

function dateKey(date: Date): string {
  return key(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

/** その日が祝日なら名前を、そうでなければ null を返す（1980〜2099 年の範囲外は null） */
export function getHolidayName(date: Date): string | null {
  const year = date.getFullYear()
  if (Number.isNaN(year) || year < MIN_YEAR || year > MAX_YEAR) return null

  let map = cache.get(year)
  if (!map) {
    map = buildYear(year)
    cache.set(year, map)
  }
  return map.get(dateKey(date)) ?? null
}
