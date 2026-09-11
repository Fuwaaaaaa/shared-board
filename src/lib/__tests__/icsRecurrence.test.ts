import { describe, expect, it } from 'vitest'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  expandRecurrence,
  fromWall,
  occurrenceAt,
  occurrencesAt,
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
    byDay: [],
    byMonth: [],
    byMonthDay: [],
    bySetPos: [],
    // RFC 5545 の既定は月曜
    wkst: 1,
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

describe('occurrencesAt（BYDAY）', () => {
  /** 展開結果を 'yyyy-MM-dd' の並びに（UTC で読む） */
  const utcDays = (dates: Date[]) => dates.map((d) => d.toISOString().slice(0, 10))

  const base = { y: 2026, m: 9, d: 1, hh: 10, mm: 0, ss: 0 }

  it('毎週 + BYDAY は、その週の選ばれた曜日ぶんに増える', () => {
    // 2026-09-01 は火曜。週の起点は既定の月曜（8/31〜9/6）
    const dates = occurrencesAt(UTC_ZONE, base, {
      freq: 'weekly',
      interval: 1,
      byDay: [
        { weekday: 2, nth: null },
        { weekday: 4, nth: null },
      ],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }, 0)
    expect(utcDays(dates)).toEqual(['2026-09-01', '2026-09-03'])
  })

  it('週の起点が変わると、同じ週に入る日が変わる', () => {
    // 日曜起点なら 8/30〜9/5。月曜起点でも同じ週に火・木が入るので、
    // 差が出るのは日曜を選んだとき
    const sunday = [{ weekday: 0, nth: null }]
    const mondayStart = occurrencesAt(UTC_ZONE, base, {
      freq: 'weekly',
      interval: 1,
      byDay: sunday,
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }, 0)
    const sundayStart = occurrencesAt(UTC_ZONE, base, {
      freq: 'weekly',
      interval: 1,
      byDay: sunday,
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 0,
    }, 0)
    expect(utcDays(mondayStart)).toEqual(['2026-09-06'])
    expect(utcDays(sundayStart)).toEqual(['2026-08-30'])
  })

  it('毎日 + BYDAY は絞り込み（その曜日でなければ生まれない）', () => {
    const spec = {
      freq: 'daily' as const,
      interval: 1,
      byDay: [{ weekday: 2, nth: null }],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }
    // 9/1 は火曜、9/2 は水曜
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec, 0))).toEqual(['2026-09-01'])
    expect(occurrencesAt(UTC_ZONE, base, spec, 1)).toEqual([])
  })

  it('毎月 + 序数つき BYDAY は、その位置の曜日 1 日', () => {
    const spec = {
      freq: 'monthly' as const,
      interval: 1,
      byDay: [{ weekday: 2, nth: 2 }],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec, 0))).toEqual(['2026-09-08'])
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec, 1))).toEqual(['2026-10-13'])
  })

  it('毎月 + 序数なし BYDAY は、その月の該当する曜日すべて', () => {
    const dates = occurrencesAt(UTC_ZONE, base, {
      freq: 'monthly',
      interval: 1,
      byDay: [{ weekday: 2, nth: null }],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }, 0)
    expect(utcDays(dates)).toEqual([
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ])
  })

  it('BYSETPOS で位置を選べる（-1 は最後）', () => {
    const spec = (bySetPos: number[]) => ({
      freq: 'monthly' as const,
      interval: 1,
      byDay: [{ weekday: 2, nth: null }],
      byMonth: [],
      byMonthDay: [],
      bySetPos,
      wkst: 1,
    })
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec([2]), 0))).toEqual(['2026-09-08'])
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec([-1]), 0))).toEqual(['2026-09-29'])
  })

  it('第 5 火曜が無い月は空（丸めない）', () => {
    const spec = {
      freq: 'monthly' as const,
      interval: 1,
      byDay: [{ weekday: 2, nth: 5 }],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }
    // 9 月には第 5 火曜（9/29）がある。10 月・11 月には無い
    expect(utcDays(occurrencesAt(UTC_ZONE, base, spec, 0))).toEqual(['2026-09-29'])
    expect(occurrencesAt(UTC_ZONE, base, spec, 1)).toEqual([])
    expect(occurrencesAt(UTC_ZONE, base, spec, 2)).toEqual([])
  })

  it('BYDAY が無ければ、これまでどおり 1 件', () => {
    const dates = occurrencesAt(UTC_ZONE, base, {
      freq: 'monthly',
      interval: 1,
      byDay: [],
      byMonth: [],
      byMonthDay: [],
      bySetPos: [],
      wkst: 1,
    }, 1)
    expect(utcDays(dates)).toEqual(['2026-10-01'])
  })
})

describe('BYDAY つきの展開（相手の暦で数える）', () => {
  it('夏時間をまたいでも、毎週 火・木の壁時計は動かない', () => {
    // ニューヨークの夏時間は 2026-03-08 に始まる
    const start = fromWall(NY, { y: 2026, m: 3, d: 3, hh: 9, mm: 0, ss: 0 })
    const dates = expandRecurrence(
      spec({
        start,
        zone: NY,
        freq: 'weekly',
        byDay: [
          { weekday: 2, nth: null },
          { weekday: 4, nth: null },
        ],
      }),
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-20T00:00:00Z'),
      50,
    )

    const wall = dates.map((d) => {
      const p = toWall(NY, d)
      return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
    })
    expect(wall).toEqual([
      '2026-03-03 09:00',
      '2026-03-05 09:00',
      '2026-03-10 09:00',
      '2026-03-12 09:00',
      '2026-03-17 09:00',
      '2026-03-19 09:00',
    ])
  })

  it('DTSTART より前の回は出さない', () => {
    // 木曜始まりなら、同じ週の火曜は出ない
    const start = new Date('2026-09-03T10:00:00Z')
    const dates = expandRecurrence(
      spec({
        start,
        freq: 'weekly',
        byDay: [
          { weekday: 2, nth: null },
          { weekday: 4, nth: null },
        ],
      }),
      new Date('2026-08-25T00:00:00Z'),
      new Date('2026-09-12T00:00:00Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-03T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
      '2026-09-10T10:00:00.000Z',
    ])
  })

  it('COUNT は実際に出た回を数える', () => {
    const start = new Date('2026-09-01T10:00:00Z')
    const dates = expandRecurrence(
      spec({
        start,
        freq: 'weekly',
        byDay: [
          { weekday: 2, nth: null },
          { weekday: 4, nth: null },
        ],
        count: 3,
      }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
    ])
  })

  it('毎月 第 2 火曜が、DTSTART の日付ではなく実際の第 2 火曜に出る', () => {
    // これが「いまの既知の課題」に載っていた劣化そのもの
    const start = new Date('2026-09-08T10:00:00Z')
    const dates = expandRecurrence(
      spec({
        start,
        freq: 'monthly',
        byDay: [{ weekday: 2, nth: 2 }],
      }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-08T10:00:00.000Z',
      '2026-10-13T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-12-08T10:00:00.000Z',
    ])
  })

  it('UNTIL は BYDAY があっても効く', () => {
    const start = new Date('2026-09-01T10:00:00Z')
    const dates = expandRecurrence(
      spec({
        start,
        freq: 'weekly',
        byDay: [
          { weekday: 2, nth: null },
          { weekday: 4, nth: null },
        ],
        until: new Date('2026-09-08T10:00:00Z'),
        untilInclusive: true,
      }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
    ])
  })
})

describe('occurrencesAt（BYMONTHDAY / BYMONTH）', () => {
  const utcDays = (dates: Date[]) => dates.map((d) => d.toISOString().slice(0, 10))

  /** 2026-09-01 は火曜 */
  const base = { y: 2026, m: 9, d: 1, hh: 10, mm: 0, ss: 0 }

  const at = (
    over: Partial<
      Pick<
        RecurrenceSpec,
        'freq' | 'interval' | 'byDay' | 'byMonth' | 'byMonthDay' | 'bySetPos' | 'wkst'
      >
    > &
      Pick<RecurrenceSpec, 'freq'>,
    n: number,
    from = base,
  ) =>
    utcDays(
      occurrencesAt(
        UTC_ZONE,
        from,
        { interval: 1, byDay: [], byMonth: [], byMonthDay: [], bySetPos: [], wkst: 1, ...over },
        n,
      ),
    )

  it('毎月 + BYMONTHDAY は、その日付ぶんに増える', () => {
    expect(at({ freq: 'monthly', byMonthDay: [1, 15] }, 0)).toEqual([
      '2026-09-01',
      '2026-09-15',
    ])
    expect(at({ freq: 'monthly', byMonthDay: [1, 15] }, 1)).toEqual([
      '2026-10-01',
      '2026-10-15',
    ])
  })

  it('BYMONTHDAY の負の値は、月末から数える', () => {
    // -1 は月末。月ごとに 30 / 31 / 28 と変わる
    expect(at({ freq: 'monthly', byMonthDay: [-1] }, 0)).toEqual(['2026-09-30'])
    expect(at({ freq: 'monthly', byMonthDay: [-1] }, 1)).toEqual(['2026-10-31'])
    // 9 月から 5 か月後は 2027 年 2 月。うるう年ではないので 28 日
    expect(at({ freq: 'monthly', byMonthDay: [-1] }, 5)).toEqual(['2027-02-28'])
    // -2 は月末の 1 つ前
    expect(at({ freq: 'monthly', byMonthDay: [-2] }, 0)).toEqual(['2026-09-29'])
  })

  /*
   * ボード自身の予定は「その月に無い日は月末へ丸める」。
   * 外から来た .ics は RFC どおり「飛ばす」。この違いは意図したもので、
   * 書き出す側が RDATE で埋めている（src/lib/ics.ts）。
   */
  it('その月に無い日は、丸めずに飛ばす', () => {
    // 9 月は 30 日まで
    expect(at({ freq: 'monthly', byMonthDay: [31] }, 0)).toEqual([])
    expect(at({ freq: 'monthly', byMonthDay: [31] }, 1)).toEqual(['2026-10-31'])
    expect(at({ freq: 'monthly', byMonthDay: [30, 31] }, 0)).toEqual(['2026-09-30'])
  })

  it('毎年 + BYMONTH + BYMONTHDAY は、その 1 日（祝日カレンダーの形）', () => {
    const xmas = { y: 2026, m: 12, d: 25, hh: 0, mm: 0, ss: 0 }
    expect(at({ freq: 'yearly', byMonth: [12], byMonthDay: [25] }, 0, xmas)).toEqual([
      '2026-12-25',
    ])
    expect(at({ freq: 'yearly', byMonth: [12], byMonthDay: [25] }, 1, xmas)).toEqual([
      '2027-12-25',
    ])
  })

  it('毎年 + BYMONTH は、月そのものが増える', () => {
    // 年 2 回。DTSTART より前の回は expandRecurrence 側で落とす
    expect(at({ freq: 'yearly', byMonth: [3, 9] }, 0)).toEqual(['2026-03-01', '2026-09-01'])
    expect(at({ freq: 'yearly', byMonth: [3, 9] }, 1)).toEqual(['2027-03-01', '2027-09-01'])
  })

  it('毎月 / 毎日 の BYMONTH は絞り込み（月は増えない）', () => {
    // 毎月 + BYMONTH=9 は、9 月の回だけ残る
    expect(at({ freq: 'monthly', byMonth: [9] }, 0)).toEqual(['2026-09-01'])
    expect(at({ freq: 'monthly', byMonth: [9] }, 1)).toEqual([])
    expect(at({ freq: 'monthly', byMonth: [9] }, 12)).toEqual(['2027-09-01'])

    expect(at({ freq: 'daily', byMonth: [9] }, 0)).toEqual(['2026-09-01'])
    // 9/1 の 30 日後は 10/1
    expect(at({ freq: 'daily', byMonth: [9] }, 30)).toEqual([])
  })

  it('毎年 + BYMONTH + BYDAY は「11 月の第 4 木曜」になる', () => {
    const nov = { y: 2026, m: 11, d: 26, hh: 0, mm: 0, ss: 0 }
    const rule = { freq: 'yearly' as const, byMonth: [11], byDay: [{ weekday: 4, nth: 4 }] }
    expect(at(rule, 0, nov)).toEqual(['2026-11-26'])
    expect(at(rule, 1, nov)).toEqual(['2027-11-25'])
  })

  /* Outlook は「第 1 月曜」を、序数ではなく 1〜7 日との重なりで書いてくる */
  it('BYDAY と BYMONTHDAY が両方あるときは、重なりだけを採る', () => {
    const dates = at(
      {
        freq: 'monthly',
        byDay: [{ weekday: 1, nth: null }],
        byMonthDay: [1, 2, 3, 4, 5, 6, 7],
      },
      0,
    )
    // 2026 年 9 月の月曜は 7 / 14 / 21 / 28。1〜7 日と重なるのは 7 日だけ
    expect(dates).toEqual(['2026-09-07'])
  })

  /* VTIMEZONE の切り替え規則が、まさにこの形で書かれている */
  it('毎年 + BYMONTH + 最後の曜日（夏時間の切り替えの形）', () => {
    const mar = { y: 2026, m: 3, d: 29, hh: 1, mm: 0, ss: 0 }
    const rule = { freq: 'yearly' as const, byMonth: [3], byDay: [{ weekday: 0, nth: -1 }] }
    // 2026 年 3 月の日曜は 1 / 8 / 15 / 22 / 29
    expect(at(rule, 0, mar)).toEqual(['2026-03-29'])
    expect(at(rule, 1, mar)).toEqual(['2027-03-28'])
  })
})

describe('expandRecurrence（BYMONTHDAY / BYMONTH）', () => {
  it('DTSTART より前に来る回は出さない', () => {
    // 毎年 3 月と 9 月。DTSTART が 9 月なので、初年の 3 月は出ない
    const dates = expandRecurrence(
      spec({
        start: new Date('2026-09-01T10:00:00Z'),
        freq: 'yearly',
        byMonth: [3, 9],
      }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-12-31T23:59:59Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2027-03-01T10:00:00.000Z',
      '2027-09-01T10:00:00.000Z',
    ])
  })

  it('COUNT は、実際に出た回だけを数える', () => {
    // 毎月 31 日。31 日の無い月は回そのものが生まれないので、数にも入らない
    const dates = expandRecurrence(
      spec({
        start: new Date('2026-01-31T10:00:00Z'),
        freq: 'monthly',
        byMonthDay: [31],
        count: 3,
      }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-12-31T23:59:59Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-01-31T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
      '2026-05-31T10:00:00.000Z',
    ])
  })

  it('範囲の手前から始まった繰り返しでも、月末の回を拾える', () => {
    const dates = expandRecurrence(
      spec({
        start: new Date('2020-01-31T10:00:00Z'),
        freq: 'monthly',
        byMonthDay: [-1],
      }),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-11-30T23:59:59Z'),
      50,
    )
    expect(iso(dates)).toEqual([
      '2026-09-30T10:00:00.000Z',
      '2026-10-31T10:00:00.000Z',
      '2026-11-30T10:00:00.000Z',
    ])
  })
})
