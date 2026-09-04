import { describe, expect, it } from 'vitest'
import { buildIcs } from '../ics'
import { allDayEndIso, allDayStartIso, boardDateTimeIso } from '../dates'
import type { CalendarEvent, EventOverride, Todo } from '../types'

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

describe('繰り返しの書き方（取り込み先との食い違いを固定する）', () => {
  it('毎月は BYMONTHDAY を付けずに出す', () => {
    // このアプリは「その月に無い日は月末に丸める」（1/31 の毎月 → 2/28）が、
    // .ics の FREQ=MONTHLY は仕様上「無い日はその月を飛ばす」。
    // 丸める挙動を RRULE で正確に表す書き方が無いので、食い違いは README に記録し、
    // 出力の形だけここで固定しておく（勝手に変わったら気づけるように）
    const text = buildIcs(
      'ボード',
      [makeEvent({ recurrence: 'monthly', start_at: boardDateTimeIso('2026-01-31', '10:00') })],
      [],
      [],
    )
    expect(unfold(text)).toContain('RRULE:FREQ=MONTHLY')
  })
})
