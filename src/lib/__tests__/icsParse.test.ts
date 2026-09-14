import { describe, expect, it } from 'vitest'
import { boardDateTimeIso } from '../dates'
import { buildIcs } from '../ics'
import { expandOccurrences } from '../recurrence'
import {
  expandFeedEvents,
  hasUnsupportedRecurrence,
  parseByDay,
  parseIcs,
  parseNumberList,
  parseWkst,
  unreadableRrule,
} from '../icsParse'

const feed = { id: 'f1', name: '外部', color: 'slate' }

function ics(body: string): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body.trim().split('\n'), 'END:VCALENDAR'].join('\r\n')
}

function local(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm)
}

describe('parseIcs', () => {
  it('折り返し（unfold）とエスケープを戻す', () => {
    const text = ics(`
BEGIN:VEVENT
UID:a
SUMMARY:長い
 タイトル\\, つづき\\; 終わり\\n2 行目
DTSTART;VALUE=DATE:20260901
END:VEVENT`)
    const [event] = parseIcs(text)
    expect(event.summary).toBe('長いタイトル, つづき; 終わり\n2 行目')
    expect(event.allDay).toBe(true)
    expect(event.start.getTime()).toBe(local(2026, 9, 1).getTime())
  })

  it('DATE / DATE-TIME（floating） / Z を読む', () => {
    const text = ics(`
BEGIN:VEVENT
UID:date
SUMMARY:終日
DTSTART;VALUE=DATE:20260901
DTEND;VALUE=DATE:20260903
END:VEVENT
BEGIN:VEVENT
UID:floating
SUMMARY:ローカル
DTSTART:20260901T100000
DTEND:20260901T110000
END:VEVENT
BEGIN:VEVENT
UID:utc
SUMMARY:UTC
DTSTART:20260901T010000Z
END:VEVENT`)
    const events = parseIcs(text)
    expect(events).toHaveLength(3)

    const [date, floating, utc] = events
    expect(date.allDay).toBe(true)
    // 終日の DTEND は翌日を指すので 1 日戻る
    expect(date.end?.getTime()).toBe(local(2026, 9, 2).getTime())

    expect(floating.allDay).toBe(false)
    expect(floating.start.getTime()).toBe(local(2026, 9, 1, 10, 0).getTime())
    expect(floating.end?.getTime()).toBe(local(2026, 9, 1, 11, 0).getTime())

    expect(utc.start.toISOString()).toBe('2026-09-01T01:00:00.000Z')
  })

  it('VALARM など入れ子の中は読まず、VTODO は無視する', () => {
    const text = ics(`
BEGIN:VTODO
UID:todo
SUMMARY:やること
END:VTODO
BEGIN:VEVENT
UID:x
SUMMARY:本体
DTSTART:20260901T010000Z
BEGIN:VALARM
SUMMARY:アラーム
TRIGGER:-PT10M
END:VALARM
END:VEVENT`)
    const events = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('本体')
  })
})

describe('expandFeedEvents', () => {
  const from = local(2026, 9, 1)
  const to = local(2026, 9, 30, 23, 59)

  it('繰り返しなしは範囲内なら 1 件', () => {
    const text = ics(`
BEGIN:VEVENT
UID:x
SUMMARY:単発
DTSTART:20260910T100000
DTEND:20260910T110000
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list).toHaveLength(1)
    expect(list[0].uid).toBe(`f1:x:${local(2026, 9, 10, 10).toISOString()}`)
    expect(list[0].end?.getTime()).toBe(local(2026, 9, 10, 11).getTime())
    expect(expandFeedEvents(text, feed, local(2026, 10, 1), local(2026, 10, 31))).toHaveLength(0)
  })

  it('UNTIL が DATE 形式なら当日の回を含む', () => {
    const text = ics(`
BEGIN:VEVENT
UID:d
SUMMARY:毎日
DTSTART:20260901T230000
RRULE:FREQ=DAILY;UNTIL=20260903
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list.map((e) => e.start.getDate())).toEqual([1, 2, 3])
  })

  it('UNTIL が DATE-TIME ならその時刻まで', () => {
    const text = ics(`
BEGIN:VEVENT
UID:d
SUMMARY:毎日
DTSTART:20260901T010000Z
RRULE:FREQ=DAILY;UNTIL=20260903T010000Z
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list).toHaveLength(3)

    const earlier = ics(`
BEGIN:VEVENT
UID:d
SUMMARY:毎日
DTSTART:20260901T010000Z
RRULE:FREQ=DAILY;UNTIL=20260903T005900Z
END:VEVENT`)
    expect(expandFeedEvents(earlier, feed, from, to)).toHaveLength(2)
  })

  it('INTERVAL と COUNT', () => {
    const text = ics(`
BEGIN:VEVENT
UID:w
SUMMARY:隔週
DTSTART:20260901T100000
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list.map((e) => e.start.getDate())).toEqual([1, 15, 29])
  })

  it('COUNT は基準からの通算（範囲の手前の回も数える）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:c
SUMMARY:毎日 5 回
DTSTART:20260828T100000
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    // 8/28, 8/29, 8/30, 8/31, 9/1 のうち範囲内は 9/1 だけ
    expect(list.map((e) => e.start.getDate())).toEqual([1])
  })

  it('何年も前に始まった毎月の繰り返しでも、範囲内の回が出る', () => {
    const text = ics(`
BEGIN:VEVENT
UID:m
SUMMARY:毎月 15 日
DTSTART:20150115T090000
RRULE:FREQ=MONTHLY
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list).toHaveLength(1)
    expect(list[0].start.getDate()).toBe(15)
  })

  it('毎月 31 日は、その日が無い月を飛ばす（RFC 5545 の決まり）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:m
SUMMARY:毎月 31 日
DTSTART:20150131T090000
RRULE:FREQ=MONTHLY
END:VEVENT`)

    // 9 月は 30 日までなので、この月には出ない
    expect(expandFeedEvents(text, feed, from, to)).toHaveLength(0)
    expect(
      expandFeedEvents(text, feed, local(2026, 2, 1), local(2026, 2, 28, 23, 59)),
    ).toHaveLength(0)

    // 31 日のある月には出る
    const october = expandFeedEvents(text, feed, local(2026, 10, 1), local(2026, 10, 31, 23, 59))
    expect(october).toHaveLength(1)
    expect(october[0].start.getDate()).toBe(31)
  })

  it('RDATE で名指しされた回を足す（飛ばした回を書き出し側が補える）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:m
SUMMARY:毎月 31 日
DTSTART:20260131T090000
RRULE:FREQ=MONTHLY
RDATE:20260228T090000,20260930T090000
END:VEVENT`)

    const feb = expandFeedEvents(text, feed, local(2026, 2, 1), local(2026, 2, 28, 23, 59))
    expect(feb.map((e) => e.start.getDate())).toEqual([28])

    // RRULE で出ない 9/30 も RDATE で出る
    expect(expandFeedEvents(text, feed, from, to).map((e) => e.start.getDate())).toEqual([30])
  })

  it('RDATE が RRULE と同じ回を指しても、二重にしない', () => {
    const text = ics(`
BEGIN:VEVENT
UID:m
SUMMARY:毎月 15 日
DTSTART:20260115T090000
RRULE:FREQ=MONTHLY
RDATE:20260915T090000
END:VEVENT`)
    expect(expandFeedEvents(text, feed, from, to)).toHaveLength(1)
  })

  it('範囲の手前で始まって範囲にかかる複数日の予定も拾う', () => {
    const text = ics(`
BEGIN:VEVENT
UID:long
SUMMARY:合宿
DTSTART;VALUE=DATE:20260830
DTEND;VALUE=DATE:20260902
END:VEVENT`)
    // 単発は「開始が範囲内」だけを見る（元の仕様のまま）
    expect(expandFeedEvents(text, feed, from, to)).toHaveLength(0)

    // 8/30〜9/1 の 3 日間（DTEND は翌日を指す）が毎週。8/30 の回は 9/1 にかかる
    const weekly = ics(`
BEGIN:VEVENT
UID:long
SUMMARY:合宿
DTSTART;VALUE=DATE:20260830
DTEND;VALUE=DATE:20260902
RRULE:FREQ=WEEKLY
END:VEVENT`)
    const list = expandFeedEvents(weekly, feed, from, to)
    expect(list.map((e) => `${e.start.getMonth() + 1}/${e.start.getDate()}`)).toEqual([
      '8/30',
      '9/6',
      '9/13',
      '9/20',
      '9/27',
    ])
  })

  it('壊れた RRULE でも固まらない', () => {
    const text = ics(`
BEGIN:VEVENT
UID:bad
SUMMARY:壊れた
DTSTART:20260901T100000
RRULE:FREQ=HOURLY;INTERVAL=abc
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list).toHaveLength(1)
  })
})

describe('この回だけ削除・変更（EXDATE / RECURRENCE-ID）', () => {
  it('EXDATE で消された回は出さない', () => {
    const text = ics(`
BEGIN:VEVENT
UID:weekly
SUMMARY:定例
DTSTART:20260901T010000Z
DTEND:20260901T020000Z
RRULE:FREQ=WEEKLY;COUNT=3
EXDATE:20260908T010000Z
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    const starts = hits.map((h) => h.start.toISOString())

    expect(starts).toEqual(['2026-09-01T01:00:00.000Z', '2026-09-15T01:00:00.000Z'])
  })

  it('EXDATE はカンマ区切りで複数書ける', () => {
    const text = ics(`
BEGIN:VEVENT
UID:weekly
SUMMARY:定例
DTSTART:20260901T010000Z
RRULE:FREQ=WEEKLY;COUNT=3
EXDATE:20260908T010000Z,20260915T010000Z
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    expect(hits).toHaveLength(1)
  })

  it('RECURRENCE-ID の回は差し替わる（二重に出さない）', () => {
    // 9/8 の回を 9/9 へ動かし、名前も変えた場合
    const text = ics(`
BEGIN:VEVENT
UID:weekly
SUMMARY:定例
DTSTART:20260901T010000Z
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20260908T010000Z
SUMMARY:今週だけ別の日
DTSTART:20260909T050000Z
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    const starts = hits.map((h) => h.start.toISOString()).sort()

    // 元の 9/8 は消え、9/9 に 1 件だけ出る
    expect(starts).toEqual([
      '2026-09-01T01:00:00.000Z',
      '2026-09-09T05:00:00.000Z',
      '2026-09-15T01:00:00.000Z',
    ])
    expect(hits.filter((h) => h.title === '今週だけ別の日')).toHaveLength(1)
  })

  it('差し替えの回は uid が変わらない（動かしても同じ回だと分かる）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:weekly
SUMMARY:定例
DTSTART:20260901T010000Z
RRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20260908T010000Z
SUMMARY:動かした回
DTSTART:20260909T050000Z
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    const moved = hits.find((h) => h.title === '動かした回')
    expect(moved?.uid).toBe('f1:weekly:2026-09-08T01:00:00.000Z')
  })

  it('終日予定でも EXDATE が効く', () => {
    const text = ics(`
BEGIN:VEVENT
UID:daily
SUMMARY:終日
DTSTART;VALUE=DATE:20260901
RRULE:FREQ=DAILY;COUNT=3
EXDATE;VALUE=DATE:20260902
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    expect(hits.map((h) => h.start.getDate())).toEqual([1, 3])
  })

  it('繰り返しの元が無い差し替えは、そのまま 1 件として出す', () => {
    const text = ics(`
BEGIN:VEVENT
UID:orphan
RECURRENCE-ID:20260908T010000Z
SUMMARY:はぐれた回
DTSTART:20260909T050000Z
END:VEVENT
`)
    const hits = expandFeedEvents(text, feed, local(2026, 9, 1), local(2026, 9, 30))
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('はぐれた回')
  })
})

describe('TZID', () => {
  it('TZID 付きの時刻を、そのゾーンの時刻として読む（夏）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:ny
SUMMARY:ニューヨークの朝会
DTSTART;TZID=America/New_York:20260901T100000
DTEND;TZID=America/New_York:20260901T110000
END:VEVENT`)
    const [event] = parseIcs(text)
    // 夏時間（EDT, UTC-4）なので 10:00 は 14:00Z
    expect(event.start.toISOString()).toBe('2026-09-01T14:00:00.000Z')
    expect(event.end?.toISOString()).toBe('2026-09-01T15:00:00.000Z')
  })

  it('同じ TZID でも、冬は 1 時間ずれる', () => {
    const text = ics(`
BEGIN:VEVENT
UID:ny
SUMMARY:ニューヨークの朝会
DTSTART;TZID=America/New_York:20260101T100000
END:VEVENT`)
    const [event] = parseIcs(text)
    // 標準時（EST, UTC-5）なので 10:00 は 15:00Z
    expect(event.start.toISOString()).toBe('2026-01-01T15:00:00.000Z')
  })

  it('Outlook の Windows 名も読む', () => {
    const text = ics(`
BEGIN:VEVENT
UID:w
SUMMARY:西海岸
DTSTART;TZID="Pacific Standard Time":20260901T090000
END:VEVENT`)
    const [event] = parseIcs(text)
    // 夏時間（PDT, UTC-7）
    expect(event.start.toISOString()).toBe('2026-09-01T16:00:00.000Z')
  })

  it('Google が付ける提供元つきの TZID も読む', () => {
    const text = ics(`
BEGIN:VEVENT
UID:g
SUMMARY:提供元つき
DTSTART;TZID=/freeassociation.sourceforge.net/America/New_York:20260901T100000
END:VEVENT`)
    const [event] = parseIcs(text)
    expect(event.start.toISOString()).toBe('2026-09-01T14:00:00.000Z')
  })

  it('知らない TZID は、VTIMEZONE の TZOFFSETTO に退避する', () => {
    const text = ics(`
BEGIN:VTIMEZONE
TZID:Customized Time Zone
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0630
TZOFFSETTO:+0630
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:c
SUMMARY:独自ゾーン
DTSTART;TZID=Customized Time Zone:20260901T100000
END:VEVENT`)
    const [event] = parseIcs(text)
    // +06:30 なので 10:00 は 03:30Z
    expect(event.start.toISOString()).toBe('2026-09-01T03:30:00.000Z')
  })

  it('知らない TZID で VTIMEZONE も無ければ、フローティング扱いにする', () => {
    const text = ics(`
BEGIN:VEVENT
UID:u
SUMMARY:名乗りだけ
DTSTART;TZID=Mars/Olympus:20260901T100000
END:VEVENT`)
    const [event] = parseIcs(text)
    // 閲覧者の暦（テストでは JST）で 10:00
    expect(event.start.getTime()).toBe(local(2026, 9, 1, 10, 0).getTime())
  })

  it('TZID の付いた EXDATE で、その回だけ消せる', () => {
    const text = ics(`
BEGIN:VEVENT
UID:ex
SUMMARY:毎日
DTSTART;TZID=America/New_York:20260901T100000
RRULE:FREQ=DAILY
EXDATE;TZID=America/New_York:20260903T100000
END:VEVENT`)
    const list = expandFeedEvents(
      text,
      feed,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-05T00:00:00Z'),
    )
    const days = list.map((e) => e.start.toISOString().slice(0, 10))
    expect(days).not.toContain('2026-09-03')
    expect(days).toContain('2026-09-02')
  })

  it('夏時間を跨ぐ毎週の予定でも、現地の時刻がずれない', () => {
    const text = ics(`
BEGIN:VEVENT
UID:dst
SUMMARY:毎週の定例
DTSTART;TZID=America/New_York:20261026T090000
RRULE:FREQ=WEEKLY
END:VEVENT`)
    const list = expandFeedEvents(
      text,
      feed,
      new Date('2026-10-26T00:00:00Z'),
      new Date('2026-11-10T00:00:00Z'),
    )
    // 11/1 に夏時間が明けるので、UTC では 1 時間後ろへ動く
    expect(list.map((e) => e.start.toISOString())).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-09T14:00:00.000Z',
    ])
  })

  it('TZID があっても、日付だけの値（終日）は閲覧者の暦の 0:00 で読む', () => {
    const text = ics(`
BEGIN:VEVENT
UID:ad
SUMMARY:終日
DTSTART;TZID=America/New_York;VALUE=DATE:20260901
END:VEVENT`)
    const [event] = parseIcs(text)
    expect(event.allDay).toBe(true)
    expect(event.start.getTime()).toBe(local(2026, 9, 1).getTime())
  })
})

describe('parseByDay / parseNumberList / parseWkst', () => {
  it('曜日の並びを読む', () => {
    expect(parseByDay('TU,TH')).toEqual([
      { weekday: 2, nth: null },
      { weekday: 4, nth: null },
    ])
  })

  it('序数つき（2TU / -1FR）を読む', () => {
    expect(parseByDay('2TU')).toEqual([{ weekday: 2, nth: 2 }])
    expect(parseByDay('-1FR')).toEqual([{ weekday: 5, nth: -1 }])
    expect(parseByDay('+3WE')).toEqual([{ weekday: 3, nth: 3 }])
  })

  it('読めない語と第 0 週は落とす', () => {
    expect(parseByDay('XX,TU,0TU,')).toEqual([{ weekday: 2, nth: null }])
    expect(parseByDay('')).toEqual([])
    expect(parseByDay(undefined)).toEqual([])
  })

  it('BYSETPOS を読む（0 は落とす）', () => {
    expect(parseNumberList('-1,2')).toEqual([-1, 2])
    expect(parseNumberList('0,3')).toEqual([3])
    expect(parseNumberList(undefined)).toEqual([])
  })

  it('WKST の既定は月曜（RFC 5545）', () => {
    expect(parseWkst(undefined)).toBe(1)
    expect(parseWkst('SU')).toBe(0)
    expect(parseWkst('なにか')).toBe(1)
  })
})

describe('BYDAY つきの .ics を取り込む', () => {
  const from = new Date('2026-09-01T00:00:00Z')
  const to = new Date('2026-12-31T23:59:59Z')

  function dates(rrule: string): string[] {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:x@example.com',
      'DTSTART:20260908T100000Z',
      'DTEND:20260908T110000Z',
      `RRULE:${rrule}`,
      'SUMMARY:定例',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    return expandFeedEvents(text, feed, from, to).map((e) => e.start.toISOString().slice(0, 10))
  }

  it('「毎月 第 2 火曜」が、実際の第 2 火曜に出る', () => {
    // これが docs/OVERVIEW.html の「いまの既知の課題」に載っていた劣化。
    // BYDAY を読まなかったころは DTSTART の日（8 日）での単純な毎月になっていた
    expect(dates('FREQ=MONTHLY;BYDAY=2TU')).toEqual([
      '2026-09-08',
      '2026-10-13',
      '2026-11-10',
      '2026-12-08',
    ])
  })

  it('BYSETPOS で書かれていても同じ結果になる', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2')).toEqual([
      '2026-09-08',
      '2026-10-13',
      '2026-11-10',
      '2026-12-08',
    ])
  })

  it('毎週 月・水・金 を COUNT=5 で', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5')).toEqual([
      '2026-09-09',
      '2026-09-11',
      '2026-09-14',
      '2026-09-16',
      '2026-09-18',
    ])
  })

  it('最終金曜', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=-1FR')).toEqual([
      '2026-09-25',
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ])
  })

  it('BYDAY が無ければ、これまでどおり DTSTART の日で毎月', () => {
    expect(dates('FREQ=MONTHLY')).toEqual([
      '2026-09-08',
      '2026-10-08',
      '2026-11-08',
      '2026-12-08',
    ])
  })
})

describe('書き出したものを読み戻すと、同じ回になる', () => {
  /*
   * 書く側（_shared/ics.ts）と読む側（icsParse）を 1 つのテストで結ぶ。
   * 片方だけ直したときに、ここが落ちる。
   */
  it('毎週 火・木', () => {
    const event = {
      id: 'e1',
      title: '練習',
      description: '',
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      all_day: false,
      recurrence: 'weekly' as const,
      recurrence_days: [2, 4],
      recurrence_week: null,
      recurrence_interval: null,
      recurrence_until: null,
      remind_minutes: null,
      color: 'blue',
      room_id: 'r1',
      kind: 'event' as const,
      source_note_id: null,
      source_synced_at: null,
      deleted_at: null,
      author_id: 'u1',
      author_name: 'A',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      tags: [],
    }

    const from = new Date('2026-09-01T00:00:00+09:00')
    const to = new Date('2026-10-31T23:59:59+09:00')

    const mine = expandOccurrences([event], from, to, []).map((o) => o.start.toISOString())
    const theirs = expandFeedEvents(buildIcs('ボード', [event]), feed, from, to).map((e) =>
      e.start.toISOString(),
    )
    expect(theirs).toEqual(mine)
  })

  /*
   * 隔週は、書く側の WKST=SU と読む側の週の起点が食い違うと落ちる。
   * RFC 5545 が WKST を significant と定めるのはまさにこの組み合わせ
   * （FREQ=WEEKLY かつ INTERVAL>1 かつ BYDAY あり）で、
   * _shared/recurrence.ts の stepDates が日曜起点であることの対になる。
   */
  it('隔週 火・木（週の起点が書く側と読む側で一致している）', () => {
    // 木曜始まり。初週が木だけになるので、起点がずれていれば必ず差が出る
    const event = {
      id: 'e3',
      title: '練習',
      description: '',
      start_at: boardDateTimeIso('2026-09-03', '19:00'),
      end_at: null,
      all_day: false,
      recurrence: 'weekly' as const,
      recurrence_days: [2, 4],
      recurrence_week: null,
      recurrence_interval: 2,
      recurrence_until: null,
      remind_minutes: null,
      color: 'blue',
      room_id: 'r1',
      kind: 'event' as const,
      source_note_id: null,
      source_synced_at: null,
      deleted_at: null,
      author_id: 'u1',
      author_name: 'A',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      tags: [],
    }

    const from = new Date('2026-09-01T00:00:00+09:00')
    const to = new Date('2026-12-31T23:59:59+09:00')

    const mine = expandOccurrences([event], from, to, []).map((o) => o.start.toISOString())
    const theirs = expandFeedEvents(buildIcs('ボード', [event]), feed, from, to).map((e) =>
      e.start.toISOString(),
    )
    expect(theirs).toEqual(mine)
    // 取り込み側が INTERVAL を無視していれば、毎週ぶん出て件数が合わない
    expect(mine.length).toBeGreaterThan(0)
  })

  it('毎月 第 2 火曜', () => {
    const event = {
      id: 'e2',
      title: '定例',
      description: '',
      start_at: boardDateTimeIso('2026-09-08', '19:00'),
      end_at: null,
      all_day: false,
      recurrence: 'monthly' as const,
      recurrence_days: [2],
      recurrence_week: 2,
      recurrence_interval: null,
      recurrence_until: null,
      remind_minutes: null,
      color: 'blue',
      room_id: 'r1',
      kind: 'event' as const,
      source_note_id: null,
      source_synced_at: null,
      deleted_at: null,
      author_id: 'u1',
      author_name: 'A',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      tags: [],
    }

    const from = new Date('2026-09-01T00:00:00+09:00')
    const to = new Date('2027-02-28T23:59:59+09:00')

    const mine = expandOccurrences([event], from, to, []).map((o) => o.start.toISOString())
    const theirs = expandFeedEvents(buildIcs('ボード', [event]), feed, from, to).map((e) =>
      e.start.toISOString(),
    )
    expect(theirs).toEqual(mine)
  })
})

/*
 * Intl が知らない TZID を、VTIMEZONE に書かれた切り替えの規則から読む。
 *
 * 以前は STANDARD の TZOFFSETTO 1 つで一年中通していたので、
 * 夏時間のある地域では半年ぶん 1 時間ずれていた。
 * 下の VTIMEZONE は Outlook が実際に書き出す形（DTSTART の年が 1601）で、
 * 中身は中央ヨーロッパ（冬 +01:00 / 夏 +02:00）と同じ。
 */
describe('VTIMEZONE の夏時間', () => {
  const VTZ = `
BEGIN:VTIMEZONE
TZID:Customized Time Zone
BEGIN:STANDARD
DTSTART:16011028T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010325T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE`.trim()

  const eventAt = (stamp: string) =>
    ics(`
${VTZ}
BEGIN:VEVENT
UID:dst
SUMMARY:打ち合わせ
DTSTART;TZID=Customized Time Zone:${stamp}
END:VEVENT`)

  it('夏は +02:00、冬は +01:00 で読む', () => {
    // 7/15 は夏時間のあいだ。12:00 は 10:00Z
    expect(parseIcs(eventAt('20260715T120000'))[0].start.toISOString()).toBe(
      '2026-07-15T10:00:00.000Z',
    )
    // 12/15 は標準時。12:00 は 11:00Z
    expect(parseIcs(eventAt('20261215T120000'))[0].start.toISOString()).toBe(
      '2026-12-15T11:00:00.000Z',
    )
  })

  it('切り替えの当日を跨いでも、境目で切り替わる', () => {
    // 2026 年 3 月の最後の日曜は 3/29。02:00 に +01:00 -> +02:00
    expect(parseIcs(eventAt('20260329T010000'))[0].start.toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    )
    expect(parseIcs(eventAt('20260329T040000'))[0].start.toISOString()).toBe(
      '2026-03-29T02:00:00.000Z',
    )

    // 2026 年 10 月の最後の日曜は 10/25。03:00 に +02:00 -> +01:00
    expect(parseIcs(eventAt('20261025T010000'))[0].start.toISOString()).toBe(
      '2026-10-24T23:00:00.000Z',
    )
    expect(parseIcs(eventAt('20261025T060000'))[0].start.toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    )
  })

  it('年が変わっても、その年の最後の日曜で切り替わる', () => {
    // 2027 年 3 月の最後の日曜は 3/28
    expect(parseIcs(eventAt('20270327T120000'))[0].start.toISOString()).toBe(
      '2027-03-27T11:00:00.000Z',
    )
    expect(parseIcs(eventAt('20270329T120000'))[0].start.toISOString()).toBe(
      '2027-03-29T10:00:00.000Z',
    )
  })

  /*
   * ここが一番効く。毎週の会議は「向こうの 10:00」であって
   * 「いつも同じ UTC 時刻」ではない。切り替えを跨ぐと UTC のほうが 1 時間動く。
   */
  it('毎週の会議は、切り替えを跨いでも向こうの 10:00 のまま', () => {
    const text = ics(`
${VTZ}
BEGIN:VEVENT
UID:weekly
SUMMARY:定例
DTSTART;TZID=Customized Time Zone:20261021T100000
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT`)

    const list = expandFeedEvents(
      text,
      feed,
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-11-30T00:00:00Z'),
    )

    expect(list.map((e) => e.start.toISOString())).toEqual([
      // 10/21 は夏時間のあいだ（+02:00）
      '2026-10-21T08:00:00.000Z',
      // 10/25 に切り替わったので、ここからは +01:00
      '2026-10-28T09:00:00.000Z',
      '2026-11-04T09:00:00.000Z',
    ])
  })

  it('切り替えの規則が無ければ、これまでどおり固定のずれで通す', () => {
    const text = ics(`
BEGIN:VTIMEZONE
TZID:Flat Zone
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0545
TZOFFSETTO:+0545
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:flat
SUMMARY:一年中同じ
DTSTART;TZID=Flat Zone:20260715T120000
END:VEVENT`)
    // +05:45 なので、夏でも冬でも 06:15Z
    expect(parseIcs(text)[0].start.toISOString()).toBe('2026-07-15T06:15:00.000Z')
  })

  /* Intl が名前を引けるなら、相手の VTIMEZONE より本物の tz データを採る */
  it('Intl が知っている名前なら、VTIMEZONE より tz データを優先する', () => {
    const text = ics(`
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0000
TZOFFSETTO:+0000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:jst
SUMMARY:東京
DTSTART;TZID=Asia/Tokyo:20260715T120000
END:VEVENT`)
    // VTIMEZONE は +00:00 と嘘を書いているが、Asia/Tokyo は Intl が引ける
    expect(parseIcs(text)[0].start.toISOString()).toBe('2026-07-15T03:00:00.000Z')
  })
})

/*
 * まだ読めない RRULE の指定を、無視して展開しない。
 *
 * BYYEARDAY / BYWEEKNO / BYHOUR などは「いつ起きるか」を大きく変える。
 * 無視して DTSTART の日付で繰り返すと、出ないより悪い
 * 「もっともらしい間違った予定」になり、見ている人には間違いだと分からない。
 * だから展開そのものをやめて、DTSTART の 1 回だけを出し、画面で断る。
 */
describe('読めない繰り返しは展開しない', () => {
  const from = new Date('2026-01-01T00:00:00Z')
  const to = new Date('2029-12-31T23:59:59Z')

  const withRule = (rrule: string) =>
    ics(`
BEGIN:VEVENT
UID:r
SUMMARY:読めない繰り返し
DTSTART:20260410T100000Z
RRULE:${rrule}
END:VEVENT`)

  it('読めない指定を並べる', () => {
    expect(unreadableRrule('FREQ=YEARLY;BYYEARDAY=100')).toEqual(['BYYEARDAY'])
    expect(unreadableRrule('FREQ=YEARLY;BYWEEKNO=20')).toEqual(['BYWEEKNO'])
    expect(unreadableRrule('FREQ=DAILY;BYHOUR=9,17')).toEqual(['BYHOUR'])
    expect(unreadableRrule('FREQ=DAILY;BYMINUTE=0,30')).toEqual(['BYMINUTE'])
    expect(unreadableRrule('FREQ=DAILY;BYSECOND=0')).toEqual(['BYSECOND'])

    // 読めない FREQ も同じ扱い（規則が読めていないことに変わりはない）
    expect(unreadableRrule('FREQ=FORTNIGHTLY')).toEqual(['FREQ'])
    expect(unreadableRrule('INTERVAL=2')).toEqual(['FREQ'])

    // 読めるものは空
    expect(unreadableRrule('FREQ=WEEKLY;BYDAY=TU,TH')).toEqual([])
    expect(unreadableRrule('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25')).toEqual([])
    expect(unreadableRrule('FREQ=MONTHLY;BYDAY=-1FR;BYSETPOS=1;WKST=SU')).toEqual([])

    // 値が空の指定は「書いていない」と同じに扱う
    expect(unreadableRrule('FREQ=DAILY;BYHOUR=')).toEqual([])
  })

  it('BYYEARDAY は、DTSTART の 1 回だけにする', () => {
    const list = expandFeedEvents(withRule('FREQ=YEARLY;BYYEARDAY=100'), feed, from, to)

    // 毎年 DTSTART の日（4/10）に並べてしまうと、100 日目とは無関係の日に
    // 正しそうな顔で出る。1 回だけに留める
    expect(list.map((e) => e.start.toISOString())).toEqual(['2026-04-10T10:00:00.000Z'])
    expect(list[0].recurrenceUnsupported).toBe(true)
  })

  it('BYWEEKNO / BYHOUR も同じ', () => {
    for (const rule of ['FREQ=YEARLY;BYWEEKNO=20', 'FREQ=DAILY;BYHOUR=9,17']) {
      const list = expandFeedEvents(withRule(rule), feed, from, to)
      expect(list).toHaveLength(1)
      expect(list[0].recurrenceUnsupported).toBe(true)
    }
  })

  it('読めない FREQ も 1 回だけにする', () => {
    const list = expandFeedEvents(withRule('FREQ=FORTNIGHTLY;INTERVAL=1'), feed, from, to)
    expect(list).toHaveLength(1)
    expect(list[0].recurrenceUnsupported).toBe(true)
  })

  it('読める繰り返しには印を付けない', () => {
    const list = expandFeedEvents(
      withRule('FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=10;COUNT=3'),
      feed,
      from,
      to,
    )
    expect(list.map((e) => e.start.toISOString())).toEqual([
      '2026-04-10T10:00:00.000Z',
      '2027-04-10T10:00:00.000Z',
      '2028-04-10T10:00:00.000Z',
    ])
    expect(list.every((e) => !e.recurrenceUnsupported)).toBe(true)
    expect(hasUnsupportedRecurrence(list)).toBe(false)
  })

  it('購読先の中に 1 つでもあれば、画面で断れるようにする', () => {
    const text = ics(`
BEGIN:VEVENT
UID:ok
SUMMARY:読める
DTSTART:20260410T100000Z
RRULE:FREQ=DAILY;COUNT=2
END:VEVENT
BEGIN:VEVENT
UID:ng
SUMMARY:読めない
DTSTART:20260412T100000Z
RRULE:FREQ=YEARLY;BYYEARDAY=100
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)

    expect(list.filter((e) => e.recurrenceUnsupported)).toHaveLength(1)
    expect(hasUnsupportedRecurrence(list)).toBe(true)
    // 読めるほうは、これまでどおり展開される
    expect(list.filter((e) => e.uid.includes(':ok:'))).toHaveLength(2)
  })

  /* 範囲の外なら、そもそも 1 回も出さない（単発の予定と同じ扱い） */
  it('DTSTART が範囲の外なら何も出さない', () => {
    const list = expandFeedEvents(
      withRule('FREQ=YEARLY;BYYEARDAY=100'),
      feed,
      new Date('2027-01-01T00:00:00Z'),
      new Date('2027-12-31T00:00:00Z'),
    )
    expect(list).toEqual([])
  })
})
