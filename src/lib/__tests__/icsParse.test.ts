import { describe, expect, it } from 'vitest'
import { expandFeedEvents, parseIcs } from '../icsParse'

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
