import { describe, expect, it } from 'vitest'
import {
  isKnownTimeZone,
  normalizeTzid,
  utcToWallClock,
  wallClockToUtc,
  zoneOffsetMs,
} from '../tz'

const HOUR = 60 * 60 * 1000

describe('normalizeTzid', () => {
  it('IANA の名前はそのまま通す', () => {
    expect(normalizeTzid('America/New_York')).toBe('America/New_York')
    expect(normalizeTzid('Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('引用符と前後の空白を外す', () => {
    expect(normalizeTzid('"Europe/Paris"')).toBe('Europe/Paris')
    expect(normalizeTzid('  Asia/Tokyo  ')).toBe('Asia/Tokyo')
  })

  it('先頭に付く提供元を落とす', () => {
    // Google の書き出しなどに出てくる形
    expect(normalizeTzid('/freeassociation.sourceforge.net/America/New_York')).toBe(
      'America/New_York',
    )
    expect(normalizeTzid('/mozilla.org/20050126_1/Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('Windows のゾーン名を IANA に寄せる', () => {
    expect(normalizeTzid('Tokyo Standard Time')).toBe('Asia/Tokyo')
    expect(normalizeTzid('"W. Europe Standard Time"')).toBe('Europe/Berlin')
    expect(normalizeTzid('Pacific Standard Time')).toBe('America/Los_Angeles')
    // 大文字小文字は問わない
    expect(normalizeTzid('EASTERN STANDARD TIME')).toBe('America/New_York')
  })

  it('知らない名前はそのまま返す（呼ぶ側が退避を決める）', () => {
    expect(normalizeTzid('Customized Time Zone')).toBe('Customized Time Zone')
  })
})

describe('isKnownTimeZone', () => {
  it('IANA の名前と UTC は読める', () => {
    expect(isKnownTimeZone('Asia/Tokyo')).toBe(true)
    expect(isKnownTimeZone('America/New_York')).toBe(true)
    expect(isKnownTimeZone('UTC')).toBe(true)
  })

  it('でたらめな名前は読めない', () => {
    expect(isKnownTimeZone('Customized Time Zone')).toBe(false)
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false)
  })
})

describe('zoneOffsetMs', () => {
  it('日本には夏時間が無いので、いつでも +9 時間', () => {
    expect(zoneOffsetMs('Asia/Tokyo', new Date('2026-01-15T00:00:00Z'))).toBe(9 * HOUR)
    expect(zoneOffsetMs('Asia/Tokyo', new Date('2026-07-15T00:00:00Z'))).toBe(9 * HOUR)
  })

  it('ニューヨークは夏と冬でずれが変わる', () => {
    expect(zoneOffsetMs('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(-4 * HOUR)
    expect(zoneOffsetMs('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-5 * HOUR)
  })

  it('UTC は 0', () => {
    expect(zoneOffsetMs('UTC', new Date('2026-07-15T12:00:00Z'))).toBe(0)
  })

  it('30 分刻み・45 分刻みのゾーンも読める', () => {
    expect(zoneOffsetMs('Asia/Kolkata', new Date('2026-07-15T12:00:00Z'))).toBe(5.5 * HOUR)
    expect(zoneOffsetMs('Asia/Kathmandu', new Date('2026-07-15T12:00:00Z'))).toBe(5.75 * HOUR)
  })

  it('知らないゾーンは null', () => {
    expect(zoneOffsetMs('Customized Time Zone', new Date())).toBeNull()
  })
})

describe('wallClockToUtc', () => {
  const at = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => ({ y, m, d, hh, mm, ss })

  it('夏のニューヨークの 10:00 は 14:00Z', () => {
    const result = wallClockToUtc('America/New_York', at(2026, 9, 1, 10, 0))
    expect(result?.toISOString()).toBe('2026-09-01T14:00:00.000Z')
  })

  it('冬のニューヨークの 10:00 は 15:00Z（夏時間の切り替えを跨いでも正しい）', () => {
    const result = wallClockToUtc('America/New_York', at(2026, 1, 1, 10, 0))
    expect(result?.toISOString()).toBe('2026-01-01T15:00:00.000Z')
  })

  it('日本の 9:00 は 0:00Z', () => {
    const result = wallClockToUtc('Asia/Tokyo', at(2026, 9, 1, 9, 0))
    expect(result?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('夏時間の切り替わりの直前・直後を、それぞれ正しく読む', () => {
    // 2026 年のニューヨークは 3/8 に夏時間へ入る
    expect(wallClockToUtc('America/New_York', at(2026, 3, 7, 12, 0))?.toISOString()).toBe(
      '2026-03-07T17:00:00.000Z',
    )
    expect(wallClockToUtc('America/New_York', at(2026, 3, 9, 12, 0))?.toISOString()).toBe(
      '2026-03-09T16:00:00.000Z',
    )
  })

  it('切り替えで二重になる時刻は、先に来るほう（切り替え前）を採る', () => {
    // 2026 年のニューヨークは 11/1 に夏時間が明け、1:30 が 2 度ある
    const result = wallClockToUtc('America/New_York', at(2026, 11, 1, 1, 30))
    expect(result?.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('切り替えで飛ばされる時刻でも、時刻を返す（落ちない）', () => {
    // 3/8 の 2:30 は存在しない
    const result = wallClockToUtc('America/New_York', at(2026, 3, 8, 2, 30))
    expect(result).toBeInstanceOf(Date)
    expect(Number.isNaN(result?.getTime())).toBe(false)
  })

  it('知らないゾーンは null', () => {
    expect(wallClockToUtc('Customized Time Zone', at(2026, 9, 1, 10, 0))).toBeNull()
  })
})

describe('utcToWallClock', () => {
  it('分解して組み立て直すと元に戻る', () => {
    for (const tzid of ['Asia/Tokyo', 'America/New_York', 'Europe/Paris', 'Australia/Sydney']) {
      for (const iso of ['2026-01-15T03:04:05Z', '2026-07-15T18:04:05Z']) {
        const parts = utcToWallClock(tzid, new Date(iso))
        expect(parts).not.toBeNull()
        expect(wallClockToUtc(tzid, parts!)?.toISOString()).toBe(
          new Date(iso).toISOString(),
        )
      }
    }
  })

  it('日付の変わり目を跨ぐゾーンでも壁時計が合う', () => {
    // 0:00Z は日本では同じ日の 9:00
    expect(utcToWallClock('Asia/Tokyo', new Date('2026-09-01T00:00:00Z'))).toEqual({
      y: 2026,
      m: 9,
      d: 1,
      hh: 9,
      mm: 0,
      ss: 0,
    })
    // 同じ瞬間、ニューヨークでは前日の 20:00
    expect(utcToWallClock('America/New_York', new Date('2026-09-01T00:00:00Z'))).toEqual({
      y: 2026,
      m: 8,
      d: 31,
      hh: 20,
      mm: 0,
      ss: 0,
    })
  })

  it('真夜中を 24 時ではなく 0 時として返す', () => {
    expect(utcToWallClock('Asia/Tokyo', new Date('2026-08-31T15:00:00Z'))?.hh).toBe(0)
  })

  it('知らないゾーンは null', () => {
    expect(utcToWallClock('Customized Time Zone', new Date())).toBeNull()
  })
})
