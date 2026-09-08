import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIcs, clampedRecurrenceDates } from '../ics'
import { allDayEndIso, allDayStartIso, boardDateTimeIso, toBoardDate } from '../dates'
import type { CalendarEvent, EventOverride, Todo } from '../types'

/**
 * 時計を止める。RDATE は「今」を起点に何年ぶん出すかを決めるので、
 * 止めないと実行した日によって結果が変わる。
 */
function freezeAt(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

afterEach(() => {
  vi.useRealTimers()
})

function makeEvent(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    room_id: 'r1',
    kind: 'event',
    title: '定例',
    description: '',
    start_at: boardDateTimeIso('2026-09-01', '10:00'),
    end_at: boardDateTimeIso('2026-09-01', '11:00'),
    all_day: false,
    color: 'blue',
    recurrence: 'none',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_until: null,
    remind_minutes: null,
    tags: [],
    source_note_id: null,
    source_synced_at: null,
    deleted_at: null,
    author_id: 'u1',
    author_name: 'A',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

function makeOverride(patch: Partial<EventOverride> & { occurrence_date: string }): EventOverride {
  return {
    id: 'o1',
    room_id: 'r1',
    event_id: 'e1',
    canceled: false,
    title: null,
    description: null,
    start_at: null,
    end_at: null,
    all_day: null,
    color: null,
    remind_minutes: null,
    tags: null,
    author_id: 'u1',
    author_name: 'A',
    created_at: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

/** 折り返しを戻した行の配列 */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n')
}

describe('buildIcs', () => {
  it('時刻ありの予定は UTC の DATE-TIME、UNTIL は翌日 0:00 JST の 1 秒前（Z）', () => {
    const ics = buildIcs('ボード', [
      makeEvent({ recurrence: 'weekly', recurrence_until: '2026-09-30' }),
    ])
    const lines = unfold(ics)
    expect(lines).toContain('DTSTART:20260901T010000Z')
    expect(lines).toContain('DTEND:20260901T020000Z')
    expect(lines).toContain('RRULE:FREQ=WEEKLY;UNTIL=20260930T145959Z')
  })

  it('終日予定は DATE 形式（JST の日付）、DTEND は翌日、UNTIL は当日を含む DATE', () => {
    const ics = buildIcs('ボード', [
      makeEvent({
        all_day: true,
        start_at: allDayStartIso('2026-09-01'),
        end_at: allDayEndIso('2026-09-02'),
        recurrence: 'monthly',
        recurrence_until: '2026-12-31',
      }),
    ])
    const lines = unfold(ics)
    expect(lines).toContain('DTSTART;VALUE=DATE:20260901')
    expect(lines).toContain('DTEND;VALUE=DATE:20260903')
    expect(lines).toContain('RRULE:FREQ=MONTHLY;UNTIL=20261231')
  })

  it('75 オクテットで折り返し、日本語の途中で切らない', () => {
    const title = 'あ'.repeat(60) // 180 バイト
    const ics = buildIcs('ボード', [makeEvent({ title })])
    const raw = ics.split('\r\n')
    const encoder = new TextEncoder()
    for (const line of raw) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
    }
    // 継続行は空白で始まり、つなぐと元に戻る
    const summaryIndex = raw.findIndex((line) => line.startsWith('SUMMARY:'))
    expect(raw[summaryIndex + 1].startsWith(' ')).toBe(true)
    expect(unfold(ics)).toContain(`SUMMARY:${title}`)
  })

  it('特殊文字をエスケープする', () => {
    const ics = buildIcs('ボード', [
      makeEvent({ title: 'a;b,c\\d', description: '1 行目\n2 行目', tags: ['x,y', 'z'] }),
    ])
    const lines = unfold(ics)
    expect(lines).toContain('SUMMARY:a\\;b\\,c\\\\d')
    expect(lines).toContain('DESCRIPTION:1 行目\\n2 行目')
    expect(lines).toContain('CATEGORIES:x\\,y,z')
  })

  it('締切は見出しに 〆 が付く', () => {
    const lines = unfold(buildIcs('ボード', [makeEvent({ kind: 'deadline', title: '提出' })]))
    expect(lines).toContain('SUMMARY:提出 〆')
  })

  it('EXDATE と RECURRENCE-ID（時刻あり）', () => {
    const event = makeEvent({ recurrence: 'daily' })
    const overrides = [
      makeOverride({ id: 'o-cancel', occurrence_date: '2026-09-02', canceled: true }),
      makeOverride({
        id: 'o-move',
        occurrence_date: '2026-09-03',
        title: '動かした回',
        start_at: boardDateTimeIso('2026-09-03', '15:00'),
        end_at: boardDateTimeIso('2026-09-03', '16:00'),
        all_day: false,
      }),
    ]
    const lines = unfold(buildIcs('ボード', [event], [], overrides))

    expect(lines).toContain('EXDATE:20260902T010000Z')
    expect(lines).toContain('RECURRENCE-ID:20260903T010000Z')

    const recurrenceIdIndex = lines.indexOf('RECURRENCE-ID:20260903T010000Z')
    const block = lines.slice(recurrenceIdIndex, recurrenceIdIndex + 4)
    expect(block).toContain('DTSTART:20260903T060000Z')
    expect(block).toContain('DTEND:20260903T070000Z')
    expect(block).toContain('SUMMARY:動かした回')

    // 同じ UID が 2 回（本体と例外）
    expect(lines.filter((line) => line === 'UID:e1@minna-no-board')).toHaveLength(2)
  })

  it('EXDATE と RECURRENCE-ID（終日）', () => {
    const event = makeEvent({
      all_day: true,
      start_at: allDayStartIso('2026-09-01'),
      end_at: null,
      recurrence: 'weekly',
    })
    const overrides = [
      makeOverride({ id: 'o-cancel', occurrence_date: '2026-09-08', canceled: true }),
      makeOverride({
        id: 'o-move',
        occurrence_date: '2026-09-15',
        start_at: allDayStartIso('2026-09-16'),
        end_at: allDayEndIso('2026-09-16'),
        all_day: true,
      }),
    ]
    const lines = unfold(buildIcs('ボード', [event], [], overrides))
    expect(lines).toContain('EXDATE;VALUE=DATE:20260908')
    expect(lines).toContain('RECURRENCE-ID;VALUE=DATE:20260915')
    expect(lines).toContain('DTSTART;VALUE=DATE:20260916')
    expect(lines).toContain('DTEND;VALUE=DATE:20260917')
  })

  it('繰り返しなしの予定には例外を書かない', () => {
    const lines = unfold(
      buildIcs('ボード', [makeEvent()], [], [makeOverride({ occurrence_date: '2026-09-01', canceled: true })]),
    )
    expect(lines.some((line) => line.startsWith('EXDATE'))).toBe(false)
  })

  it('TODO は VTODO になる', () => {
    const todo: Todo = {
      id: 't1',
      room_id: 'r1',
      title: '買い物',
      notes: '',
      due_at: boardDateTimeIso('2026-09-01', '18:00'),
      done: false,
      done_at: null,
      assignee_id: null,
      assignee_name: '',
      remind_minutes: null,
      recurrence: 'none',
      recurrence_days: [],
      recurrence_week: null,
      subtasks: [],
      tags: [],
      status: 'todo',
      sort_order: 0,
      source_note_id: null,
      source_event_id: null,
      source_synced_at: null,
      source_todo_id: null,
      deleted_at: null,
      author_id: 'u1',
      author_name: 'A',
      created_at: '2026-01-01T00:00:00.000Z',
    }
    const lines = unfold(buildIcs('ボード', [], [todo]))
    expect(lines).toContain('BEGIN:VTODO')
    expect(lines).toContain('DUE:20260901T090000Z')
    expect(lines).toContain('STATUS:NEEDS-ACTION')
  })
})

describe('書き出したものを自分で読み戻せる', () => {
  it('「この回だけ削除・変更」が往復で保たれる', async () => {
    // 購読の取り込み側が EXDATE / RECURRENCE-ID を読まなかったころは、
    // 自分で書き出した .ics を自分のフィードに登録するだけで
    // 消した回が復活し、動かした回が二重に出ていた
    const { expandFeedEvents } = await import('../icsParse')

    const event = makeEvent({
      recurrence: 'weekly',
      recurrence_until: '2026-09-22',
      title: '定例',
    })
    const overrides = [
      makeOverride({ occurrence_date: '2026-09-08', canceled: true }),
      makeOverride({
        id: 'o2',
        occurrence_date: '2026-09-15',
        title: '今週だけ別の日',
        start_at: boardDateTimeIso('2026-09-16', '14:00'),
        end_at: boardDateTimeIso('2026-09-16', '15:00'),
      }),
    ]

    const text = buildIcs('ボード', [event], [], overrides)
    const hits = expandFeedEvents(
      text,
      { id: 'f1', name: '自分', color: 'slate' },
      new Date('2026-08-25T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
    )

    const titles = hits.map((h) => h.title).sort()
    // 9/1・9/22 は定例のまま、9/8 は消え、9/15 の回は 9/16 に 1 件だけ
    expect(titles).toEqual(['今週だけ別の日', '定例', '定例'])
    expect(hits.filter((h) => h.title === '今週だけ別の日')).toHaveLength(1)
  })

  it('毎月 31 日の回が、アプリの表示と 1 回ずつ一致する', async () => {
    /*
     * アプリは「その月に無い日は月末へ丸める」、.ics の FREQ=MONTHLY は
     * 「無い日はその月を飛ばす」。この差を RDATE で埋めているので、
     * 書き出して読み戻すと同じ並びに戻るはず。
     * 埋め忘れれば回が減り、二重に足せば回が増えるので、どちらも見つかる。
     */
    const { expandFeedEvents } = await import('../icsParse')
    const { expandOccurrences } = await import('../recurrence')
    freezeAt('2026-01-01T00:00:00Z')

    const event = makeEvent({
      recurrence: 'monthly',
      recurrence_until: '2026-12-31',
      start_at: boardDateTimeIso('2026-01-31', '10:00'),
      end_at: boardDateTimeIso('2026-01-31', '11:00'),
    })

    const from = new Date(boardDateTimeIso('2026-01-01', '00:00'))
    const to = new Date(boardDateTimeIso('2026-12-31', '23:59'))

    const inApp = expandOccurrences([event], from, to, [])
      .map((o) => toBoardDate(o.start))
      .sort()
    const inFeed = expandFeedEvents(
      buildIcs('ボード', [event], [], []),
      { id: 'f1', name: '自分', color: 'slate' },
      from,
      to,
    )
      .map((e) => toBoardDate(e.start))
      .sort()

    expect(inApp).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
    ])
    expect(inFeed).toEqual(inApp)
  })
})

describe('絵文字（サロゲートペア）', () => {
  it('折り返しても壊れず、読み戻せる', async () => {
    const { parseIcs } = await import('../icsParse')
    // 4 バイト文字なので、バイト数で折るときに割れやすい
    const title = '🎉'.repeat(40) + '打ち上げ'
    const text = buildIcs('ボード', [makeEvent({ title })], [], [])

    for (const line of text.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(parseIcs(text)[0].summary).toBe(title)
  })
})

describe('行の終わり方', () => {
  it('最後の行も CRLF で終わる（RFC 5545）', () => {
    expect(buildIcs('ボード', [makeEvent()], [], []).endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('単独の CR が値に混ざっても行構造を壊さない', () => {
    const text = buildIcs('ボード', [makeEvent({ title: '前' + String.fromCharCode(13) + '後' })], [], [])
    // 生の CR が残っていたら、行の数え方がずれる
    expect(text.split('\r\n').some((line) => line.includes(String.fromCharCode(13)))).toBe(false)
    // 値の中では改行は \n という 2 文字にエスケープされる
    expect(text).toContain('SUMMARY:前\\n後')
  })
})

describe('繰り返しの書き方', () => {
  it('毎月は BYMONTHDAY を付けずに出す', () => {
    // このアプリは「その月に無い日は月末に丸める」（1/31 の毎月 → 2/28）が、
    // .ics の FREQ=MONTHLY は仕様上「無い日はその月を飛ばす」。
    // 丸める挙動を RRULE で表す書き方は無いので、RRULE は素のまま出し、
    // 足りない回を RDATE で補う（下のテスト）
    const text = buildIcs(
      'ボード',
      [makeEvent({ recurrence: 'monthly', start_at: boardDateTimeIso('2026-01-31', '10:00') })],
      [],
      [],
    )
    expect(unfold(text)).toContain('RRULE:FREQ=MONTHLY')
  })
})

describe('clampedRecurrenceDates（月末へ丸めた回を並べる）', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('毎月 31 日は、丸められた月だけを挙げる', () => {
    const dates = clampedRecurrenceDates(
      {
        start_at: boardDateTimeIso('2026-01-31', '10:00'),
        recurrence: 'monthly',
        recurrence_until: '2026-12-31',
      },
      now,
    )
    // 2/28, 4/30, 6/30, 9/30, 11/30 の 5 回。31 日のある月は RRULE が出す
    expect(dates.map((d) => toBoardDate(d))).toEqual([
      '2026-02-28',
      '2026-04-30',
      '2026-06-30',
      '2026-09-30',
      '2026-11-30',
    ])
  })

  it('時刻は元の予定のまま保つ', () => {
    const [first] = clampedRecurrenceDates(
      {
        start_at: boardDateTimeIso('2026-01-31', '10:00'),
        recurrence: 'monthly',
        recurrence_until: '2026-03-31',
      },
      now,
    )
    expect(first.toISOString()).toBe(boardDateTimeIso('2026-02-28', '10:00'))
  })

  it('毎年 2/29 は、平年だけを挙げる', () => {
    const dates = clampedRecurrenceDates(
      {
        start_at: boardDateTimeIso('2028-02-29', '10:00'),
        recurrence: 'yearly',
        recurrence_until: '2033-12-31',
      },
      new Date('2028-01-01T00:00:00Z'),
    )
    // 2032 はうるう年なので 2/29 がそのまま出る。丸めが要るのはそれ以外の年
    expect(dates.map((d) => toBoardDate(d))).toEqual([
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2033-02-28',
    ])
  })

  it('丸めが起きない予定では空を返す（ふつうの予定の出力は変わらない）', () => {
    for (const day of ['2026-01-15', '2026-01-28']) {
      expect(
        clampedRecurrenceDates(
          { start_at: boardDateTimeIso(day, '10:00'), recurrence: 'monthly', recurrence_until: null },
          now,
        ),
      ).toEqual([])
    }
    expect(
      clampedRecurrenceDates(
        {
          start_at: boardDateTimeIso('2026-01-31', '10:00'),
          recurrence: 'weekly',
          recurrence_until: null,
        },
        now,
      ),
    ).toEqual([])
  })

  it('終わりの無い繰り返しでも、有限で打ち切る', () => {
    const dates = clampedRecurrenceDates(
      {
        start_at: boardDateTimeIso('2026-01-31', '10:00'),
        recurrence: 'monthly',
        recurrence_until: null,
      },
      now,
    )
    expect(dates.length).toBeGreaterThan(0)
    expect(dates.length).toBeLessThanOrEqual(60)
    // 3 年より先は出さない
    expect(dates[dates.length - 1].getTime()).toBeLessThan(
      new Date('2029-06-01T00:00:00Z').getTime(),
    )
  })

  it('書き出した .ics に RDATE が並ぶ', () => {
    freezeAt('2026-01-01T00:00:00Z')
    const text = buildIcs(
      'ボード',
      [
        makeEvent({
          recurrence: 'monthly',
          recurrence_until: '2026-12-31',
          start_at: boardDateTimeIso('2026-01-31', '10:00'),
          end_at: boardDateTimeIso('2026-01-31', '11:00'),
        }),
      ],
      [],
      [],
    )
    const rdate = unfold(text).find((line) => line.startsWith('RDATE'))
    expect(rdate).toBeDefined()
    expect(rdate).toContain('20260228T010000Z')
  })

  it('消した回は RDATE に出さない（EXDATE と食い違わせない）', () => {
    freezeAt('2026-01-01T00:00:00Z')
    const text = buildIcs(
      'ボード',
      [
        makeEvent({
          recurrence: 'monthly',
          recurrence_until: '2026-12-31',
          start_at: boardDateTimeIso('2026-01-31', '10:00'),
          end_at: boardDateTimeIso('2026-01-31', '11:00'),
        }),
      ],
      [],
      [makeOverride({ occurrence_date: '2026-02-28', canceled: true })],
    )
    const lines = unfold(text)
    expect(lines.some((line) => line.startsWith('EXDATE') && line.includes('20260228'))).toBe(true)
    expect(lines.some((line) => line.startsWith('RDATE') && line.includes('20260228'))).toBe(false)
  })
})

describe('繰り返しの曜日指定を書き出す', () => {
  /** RRULE の行を 1 本取り出す */
  function rrule(text: string): string {
    const line = unfold(text).find((l) => l.startsWith('RRULE:'))
    return line ?? ''
  }

  it('毎週 火・木は BYDAY=TU,TH になる', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2, 4],
    })
    expect(rrule(buildIcs('ボード', [event]))).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;WKST=SU')
  })

  it('毎月 第2火曜は BYDAY=2TU になる（序数を前に置く形）', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-08', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: 2,
    })
    expect(rrule(buildIcs('ボード', [event]))).toBe('RRULE:FREQ=MONTHLY;BYDAY=2TU')
  })

  it('最終週は BYDAY=-1TU になる', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-29', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: -1,
    })
    expect(rrule(buildIcs('ボード', [event]))).toBe('RRULE:FREQ=MONTHLY;BYDAY=-1TU')
  })

  it('曜日を選ばなければ、これまでどおりの RRULE', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
    })
    expect(rrule(buildIcs('ボード', [event]))).toBe('RRULE:FREQ=WEEKLY')
  })

  it('終了日つきでも BYDAY と UNTIL が並ぶ', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2, 4],
      recurrence_until: '2026-09-30',
    })
    const line = rrule(buildIcs('ボード', [event]))
    expect(line).toContain('BYDAY=TU,TH')
    expect(line).toContain('UNTIL=')
  })

  it('第 n 曜日には RDATE を出さない（丸めが起きないので）', () => {
    /*
     * clampedRecurrenceDates は「29〜31 日始まりの毎月」に RDATE を足す。
     * 第 n 曜日はその月に無ければ飛ばす決まりで丸めが起きないため、
     * ここを素通しにすると、開始が 31 日というだけで嘘の回が並ぶ。
     */
    freezeAt('2026-09-01T00:00:00Z')
    const event = makeEvent({
      // 2026-03-31 は第 5 火曜
      start_at: boardDateTimeIso('2026-03-31', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: 5,
    })
    const lines = unfold(buildIcs('ボード', [event]))
    expect(lines.some((line) => line.startsWith('RDATE'))).toBe(false)
    expect(
      clampedRecurrenceDates({
        start_at: boardDateTimeIso('2026-03-31', '19:00'),
        recurrence: 'monthly',
        recurrence_days: [2],
        recurrence_week: 5,
        recurrence_until: null,
      }),
    ).toEqual([])
  })

  it('日付で繰り返す毎月 31 日には、これまでどおり RDATE が出る', () => {
    freezeAt('2026-09-01T00:00:00Z')
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-03-31', '19:00'),
      end_at: null,
      recurrence: 'monthly',
    })
    const lines = unfold(buildIcs('ボード', [event]))
    expect(lines.some((line) => line.startsWith('RDATE'))).toBe(true)
  })

  it('DTSTAMP は渡した時刻になる（購読 URL が同じ本文を返せるように）', () => {
    const at = new Date('2026-09-08T01:02:03.000Z')
    const lines = unfold(buildIcs('ボード', [makeEvent()], [], [], at))
    expect(lines.filter((l) => l.startsWith('DTSTAMP:'))).toContain('DTSTAMP:20260908T010203Z')
  })
})
