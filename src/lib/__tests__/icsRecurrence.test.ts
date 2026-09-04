import { describe, expect, it } from 'vitest'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  expandRecurrence,
  fromWall,
  occurrenceAt,
  toWall,
  type RecurrenceSpec,
  type Zone,
} from '../icsRecurrence'

const NY: Zone = { kind: 'iana', tzid: 'America/New_York' }
const TOKYO: Zone = { kind: 'iana', tzid: 'Asia/Tokyo' }

/** 展開の結果を読みやすく並べる */
function iso(dates: Date[]): string[] {
  return dates.map((d) => d.toISOString())
}

function spec(
  over: Partial<RecurrenceSpec> & Pick<RecurrenceSpec, 'start' | 'freq'>,
): RecurrenceSpec {
  return {
    zone: UTC_ZONE,
    interval: 1,
    count: null,
    until: null,
    untilInclusive: false,
    durationMs: 0,
    ...over,
  }
}

describe('occurrenceAt', () => {
  it('毎月は、その月に無い日の回を生まない（RFC どおり飛ばす）', () => {
    const base = toWall(UTC_ZONE, new Date('2026-01-31T10:00:00Z'))

    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 0)?.toISOString()).toBe(
      '2026-01-31T10:00:00.000Z',
    )
    // 2 月に 31 日は無いので、この回は生まれない
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 1)).toBeNull()
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 2)?.toISOString()).toBe(
      '2026-03-31T10:00:00.000Z',
    )
    // 4 月は 30 日まで
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 3)).toBeNull()
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 4)?.toISOString()).toBe(
      '2026-05-31T10:00:00.000Z',
    )
  })

  it('毎年 2/29 は、うるう年にだけ出る', () => {
    const base = toWall(UTC_ZONE, new Date('2028-02-29T10:00:00Z'))

    expect(occurrenceAt(UTC_ZONE, base, 'yearly', 0)?.toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    )
    expect(occurrenceAt(UTC_ZONE, base, 'yearly', 1)).toBeNull()
    expect(occurrenceAt(UTC_ZONE, base, 'yearly', 2)).toBeNull()
    expect(occurrenceAt(UTC_ZONE, base, 'yearly', 3)).toBeNull()
    expect(occurrenceAt(UTC_ZONE, base, 'yearly', 4)?.toISOString()).toBe(
      '2032-02-29T10:00:00.000Z',
    )
  })

  it('年をまたぐ毎月も、基準の日を保つ', () => {
    const base = toWall(UTC_ZONE, new Date('2026-11-15T00:00:00Z'))
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 3)?.toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    )
  })

  it('間隔（INTERVAL）を掛ける', () => {
    const base = toWall(UTC_ZONE, new Date('2026-09-01T00:00:00Z'))
    expect(occurrenceAt(UTC_ZONE, base, 'daily', 3, 2)?.toISOString()).toBe(
      '2026-09-07T00:00:00.000Z',
    )
    expect(occurrenceAt(UTC_ZONE, base, 'weekly', 2, 2)?.toISOString()).toBe(
      '2026-09-29T00:00:00.000Z',
    )
    expect(occurrenceAt(UTC_ZONE, base, 'monthly', 2, 3)?.toISOString()).toBe(
      '2027-03-01T00:00:00.000Z',
    )
  })

  it('夏時間のある地域では、壁時計の時刻を保つ（ミリ秒で足さない）', () => {
    // ニューヨークの毎週 9:00。2026 年は 11/1 に夏時間が明ける
    const start = new Date('2026-10-26T13:00:00Z') // = 10/26 09:00 EDT
    const base = toWall(NY, start)

    expect(occurrenceAt(NY, base, 'weekly', 0)?.toISOString()).toBe('2026-10-26T13:00:00.000Z')
    // 明けたあとも現地では 9:00 のまま。UTC では 1 時間ずれる
    expect(occurrenceAt(NY, base, 'weekly', 1)?.toISOString()).toBe('2026-11-02T14:00:00.000Z')
  })

  it('日本には夏時間が無いので、ずっと同じ時刻', () => {
    const base = toWall(TOKYO, new Date('2026-03-01T00:00:00Z')) // 09:00 JST
    expect(occurrenceAt(TOKYO, base, 'weekly', 20)?.toISOString()).toBe('2026-07-19T00:00:00.000Z')
  })
})

describe('toWall / fromWall', () => {
  it('固定オフセットのゾーンを往復できる', () => {
    const zone: Zone = { kind: 'fixed', offsetMs: 5.5 * 60 * 60 * 1000 }
    const date = new Date('2026-09-01T12:34:56Z')
    expect(toWall(zone, date)).toEqual({ y: 2026, m: 9, d: 1, hh: 18, mm: 4, ss: 56 })
    expect(fromWall(zone, toWall(zone, date)).toISOString()).toBe(date.toISOString())
  })

  it('閲覧者ローカル（テストでは JST）でも往復できる', () => {
    const date = new Date('2026-09-01T12:34:56Z')
    expect(toWall(LOCAL_ZONE, date)).toEqual({ y: 2026, m: 9, d: 1, hh: 21, mm: 34, ss: 56 })
    expect(fromWall(LOCAL_ZONE, toWall(LOCAL_ZONE, date)).toISOString()).toBe(date.toISOString())
  })
})

describe('expandRecurrence', () => {
  it('範囲に入る回だけを返す', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2026-09-01T00:00:00Z'), freq: 'daily' }),
      new Date('2026-09-03T00:00:00Z'),
      new Date('2026-09-05T00:00:00Z'),
      400,
    )
    expect(iso(result)).toEqual([
      '2026-09-03T00:00:00.000Z',
      '2026-09-04T00:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
    ])
  })

  it('毎月 31 日は、無い月を飛ばして並ぶ', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2026-01-31T00:00:00Z'), freq: 'monthly' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
      400,
    )
    expect(iso(result)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
      '2026-05-31T00:00:00.000Z',
    ])
  })

  it('COUNT は「実際に出た回」だけを数える（飛ばした回は数に入れない）', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2026-01-31T00:00:00Z'), freq: 'monthly', count: 3 }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-12-31T00:00:00Z'),
      400,
    )
    // 1/31, 3/31, 5/31 の 3 回で終わる（2 月・4 月は生まれていないので数えない）
    expect(iso(result)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
      '2026-05-31T00:00:00.000Z',
    ])
  })

  it('COUNT があるときは、範囲の手前の回も数える', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2026-09-01T00:00:00Z'), freq: 'daily', count: 5 }),
      new Date('2026-09-04T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
      400,
    )
    // 5 回目は 9/5。範囲の手前の 9/1〜9/3 も数に入る
    expect(iso(result)).toEqual(['2026-09-04T00:00:00.000Z', '2026-09-05T00:00:00.000Z'])
  })

  it('UNTIL は、その時刻の回まで含む / 含まないを選べる', () => {
    const until = new Date('2026-09-03T00:00:00Z')
    const from = new Date('2026-09-01T00:00:00Z')
    const to = new Date('2026-09-30T00:00:00Z')

    const inclusive = expandRecurrence(
      spec({ start: from, freq: 'daily', until, untilInclusive: true }),
      from,
      to,
      400,
    )
    expect(iso(inclusive)).toHaveLength(3)

    const exclusive = expandRecurrence(
      spec({ start: from, freq: 'daily', until, untilInclusive: false }),
      from,
      to,
      400,
    )
    expect(iso(exclusive)).toHaveLength(2)
  })

  it('何年も前に始まった繰り返しでも、範囲の回が出る（手前は数えない）', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2010-01-05T00:00:00Z'), freq: 'weekly' }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
      400,
    )
    expect(result.length).toBeGreaterThan(3)
    expect(result[0].getTime()).toBeGreaterThanOrEqual(new Date('2026-09-01T00:00:00Z').getTime())
  })

  it('長い予定は、始まりが範囲の手前でも範囲にかかっていれば出る', () => {
    const result = expandRecurrence(
      spec({
        start: new Date('2026-09-01T00:00:00Z'),
        freq: 'monthly',
        durationMs: 3 * 24 * 60 * 60 * 1000,
      }),
      new Date('2026-09-03T00:00:00Z'),
      new Date('2026-09-10T00:00:00Z'),
      400,
    )
    expect(iso(result)).toEqual(['2026-09-01T00:00:00.000Z'])
  })

  it('上限で必ず打ち切る', () => {
    const result = expandRecurrence(
      spec({ start: new Date('2026-01-01T00:00:00Z'), freq: 'daily' }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2030-01-01T00:00:00Z'),
      10,
    )
    expect(result).toHaveLength(10)
  })

  it('夏時間を跨ぐ毎日の予定でも、現地の時刻がずれない', () => {
    const start = new Date('2026-10-30T13:00:00Z') // 10/30 09:00 EDT
    const result = expandRecurrence(
      spec({ start, zone: NY, freq: 'daily' }),
      start,
      new Date('2026-11-03T23:00:00Z'),
      400,
    )
    // 11/1 に夏時間が明けるので、そこから UTC では 1 時間後ろへ動く
    expect(iso(result)).toEqual([
      '2026-10-30T13:00:00.000Z',
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
    ])
  })
})
