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

  it('何年も前に始まった毎月の繰り返しでも、範囲内の回が出る（月末は丸める）', () => {
    const text = ics(`
BEGIN:VEVENT
UID:m
SUMMARY:毎月末
DTSTART:20150131T090000
RRULE:FREQ=MONTHLY
END:VEVENT`)
    const list = expandFeedEvents(text, feed, from, to)
    expect(list).toHaveLength(1)
    expect(list[0].start.getDate()).toBe(30)

    const feb = expandFeedEvents(text, feed, local(2026, 2, 1), local(2026, 2, 28, 23, 59))
    expect(feb).toHaveLength(1)
    expect(feb[0].start.getDate()).toBe(28)
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
