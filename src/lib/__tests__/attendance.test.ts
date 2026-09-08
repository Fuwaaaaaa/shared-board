import { describe, expect, it } from 'vitest'
import {
  attendanceDateOf,
  attendanceFor,
  describeOccurrenceReset,
  myAttendance,
  occurrenceGridMoved,
  tallyAttendance,
  yesCountByOccurrence,
  yesCountOf,
} from '../attendance'
import { expandOccurrences } from '../recurrence'
import { boardDateTimeIso, toBoardDate } from '../dates'
import type {
  AttendanceAnswer,
  CalendarEvent,
  EventAttendance,
  EventOccurrence,
  RoomMember,
} from '../types'

function makeEvent(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    room_id: 'r1',
    kind: 'event',
    title: '練習',
    description: '',
    start_at: boardDateTimeIso('2026-09-01', '19:00'),
    end_at: null,
    all_day: false,
    color: 'blue',
    recurrence: 'weekly',
    recurrence_days: [],
    recurrence_week: null,
    recurrence_until: null,
    remind_minutes: null,
    tags: [],
    source_note_id: null,
    source_synced_at: null,
    deleted_at: null,
    author_id: 'u1',
    author_name: 'ゆうき',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

function makeAnswer(patch: Partial<EventAttendance> = {}): EventAttendance {
  return {
    id: crypto.randomUUID(),
    room_id: 'r1',
    event_id: 'e1',
    occurrence_date: '2026-09-01',
    user_id: 'u1',
    voter_name: 'ゆうき',
    answer: 'yes',
    created_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  }
}

function makeMember(userId: string, name: string): RoomMember {
  return {
    id: `m-${userId}`,
    room_id: 'r1',
    user_id: userId,
    display_name: name,
    role: 'member',
    status: 'approved',
    can_edit: true,
    favorite: false,
    message: '',
    created_at: '2026-01-01T00:00:00.000Z',
    decided_at: null,
  }
}

/** 予定を展開して n 回目を取り出す */
function nth(event: CalendarEvent, index: number): EventOccurrence {
  const list = expandOccurrences(
    [event],
    new Date('2026-09-01T00:00:00+09:00'),
    new Date('2026-10-31T23:59:59+09:00'),
    [],
  )
  return list[index]
}

describe('attendanceFor', () => {
  const event = makeEvent()

  it('その回の答えだけを返す', () => {
    const rows = [
      makeAnswer({ occurrence_date: '2026-09-01', user_id: 'u1' }),
      makeAnswer({ occurrence_date: '2026-09-08', user_id: 'u1' }),
      makeAnswer({ occurrence_date: '2026-09-08', user_id: 'u2' }),
    ]
    expect(attendanceFor(rows, nth(event, 0))).toHaveLength(1)
    expect(attendanceFor(rows, nth(event, 1))).toHaveLength(2)
  })

  it('別の予定の答えは混ざらない', () => {
    const rows = [makeAnswer({ event_id: 'other', occurrence_date: '2026-09-01' })]
    expect(attendanceFor(rows, nth(event, 0))).toHaveLength(0)
  })

  it('繰り返しなしの予定は、日付を見ない（別の日へ動かしても答えが付いてくる）', () => {
    const single = makeEvent({ recurrence: 'none' })
    // 9/1 に答えたあと、予定を 9/20 へ動かした
    const rows = [makeAnswer({ occurrence_date: '2026-09-01' })]
    const moved = makeEvent({
      recurrence: 'none',
      start_at: boardDateTimeIso('2026-09-20', '19:00'),
    })

    expect(attendanceFor(rows, nth(single, 0))).toHaveLength(1)
    expect(attendanceFor(rows, nth(moved, 0))).toHaveLength(1)
  })

  it('回のキーは「元の回の開始日」', () => {
    expect(attendanceDateOf(nth(event, 1))).toBe('2026-09-08')
  })
})

describe('myAttendance', () => {
  it('自分の答えだけを返す。まだなら null', () => {
    const event = makeEvent()
    const rows = [
      makeAnswer({ user_id: 'u1', answer: 'no' }),
      makeAnswer({ user_id: 'u2', answer: 'yes' }),
    ]
    expect(myAttendance(rows, nth(event, 0), 'u1')?.answer).toBe('no')
    expect(myAttendance(rows, nth(event, 0), 'u3')).toBeNull()
  })
})

describe('tallyAttendance', () => {
  const members = [makeMember('u1', 'ゆうき'), makeMember('u2', 'けいこ'), makeMember('u3', 'みなみ')]

  it('○△× を数え、まだ答えていない人も数える', () => {
    const rows = [
      makeAnswer({ user_id: 'u1', voter_name: 'ゆうき', answer: 'yes' }),
      makeAnswer({ user_id: 'u2', voter_name: 'けいこ', answer: 'maybe' }),
    ]
    const tally = tallyAttendance(rows, members)
    expect(tally).toMatchObject({ yes: 1, maybe: 1, no: 0, unanswered: 1 })
    expect(tally.yesNames).toEqual(['ゆうき'])
    expect(tally.pendingNames).toEqual(['みなみ'])
  })

  it('名簿に無い人の答えも数に入る（外れたあとも答えは残るため）', () => {
    const rows = [makeAnswer({ user_id: 'gone', voter_name: 'いなくなった人', answer: 'yes' })]
    const tally = tallyAttendance(rows, members)
    expect(tally.yes).toBe(1)
    expect(tally.unanswered).toBe(3)
  })

  it('名前が空なら「名前なし」にする', () => {
    const rows = [makeAnswer({ user_id: 'u1', voter_name: '', answer: 'yes' })]
    expect(tallyAttendance(rows, []).yesNames).toEqual(['名前なし'])
  })
})

describe('yesCountByOccurrence', () => {
  it('○ だけを数える', () => {
    const event = makeEvent()
    const counts = yesCountByOccurrence([
      makeAnswer({ occurrence_date: '2026-09-01', user_id: 'u1', answer: 'yes' }),
      makeAnswer({ occurrence_date: '2026-09-01', user_id: 'u2', answer: 'yes' }),
      makeAnswer({ occurrence_date: '2026-09-01', user_id: 'u3', answer: 'no' }),
      makeAnswer({ occurrence_date: '2026-09-08', user_id: 'u1', answer: 'yes' }),
    ])
    expect(yesCountOf(counts, nth(event, 0))).toBe(2)
    expect(yesCountOf(counts, nth(event, 1))).toBe(1)
  })

  it('繰り返しなしの予定は、日付を見ずに引ける', () => {
    const single = makeEvent({ recurrence: 'none' })
    const counts = yesCountByOccurrence([makeAnswer({ occurrence_date: '2026-09-01' })])
    const moved = makeEvent({
      recurrence: 'none',
      start_at: boardDateTimeIso('2026-09-20', '19:00'),
    })
    expect(yesCountOf(counts, nth(single, 0))).toBe(1)
    expect(yesCountOf(counts, nth(moved, 0))).toBe(1)
  })

  it('答えが無ければ 0', () => {
    expect(yesCountOf(yesCountByOccurrence([]), nth(makeEvent(), 0))).toBe(0)
  })
})

describe('occurrenceGridMoved', () => {
  /*
   * サーバー側の tg_reset_event_occurrences とまったく同じ条件でなければならない。
   * ずれると「確認が出ないのに消える」「出るのに消えない」になる。
   */
  const event = makeEvent({
    start_at: boardDateTimeIso('2026-09-01', '19:00'),
    recurrence: 'weekly',
    recurrence_days: [2, 4],
  })

  const grid = (patch: Partial<Parameters<typeof occurrenceGridMoved>[0]> = {}) => ({
    date: toBoardDate(event.start_at),
    recurrence: event.recurrence,
    recurrenceUntil: '',
    days: [2, 4],
    week: null,
    ...patch,
  })

  it('何も変えていなければ動いていない', () => {
    expect(occurrenceGridMoved(grid(), event)).toBe(false)
  })

  it('時刻だけの変更では動いていない（日付キーは変わらない）', () => {
    // grid.date は日付だけを持つので、時刻を変えても同じ値になる
    expect(occurrenceGridMoved(grid(), { ...event, start_at: boardDateTimeIso('2026-09-01', '21:00') })).toBe(
      false,
    )
  })

  it('開始日を変えると動く', () => {
    expect(occurrenceGridMoved(grid({ date: '2026-09-02' }), event)).toBe(true)
  })

  it('繰り返し方を変えると動く', () => {
    expect(occurrenceGridMoved(grid({ recurrence: 'monthly' }), event)).toBe(true)
  })

  it('終了日を変えると動く', () => {
    expect(occurrenceGridMoved(grid({ recurrenceUntil: '2026-12-31' }), event)).toBe(true)
  })

  it('曜日を足しただけなら動かない', () => {
    expect(occurrenceGridMoved(grid({ days: [2, 4, 6] }), event)).toBe(false)
  })

  it('曜日を減らすと動く', () => {
    expect(occurrenceGridMoved(grid({ days: [2] }), event)).toBe(true)
  })

  it('曜日を入れ替えると動く', () => {
    expect(occurrenceGridMoved(grid({ days: [2, 5] }), event)).toBe(true)
  })

  it('第 n 週を変えると動く', () => {
    const monthly = makeEvent({
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: 2,
    })
    const base = {
      date: toBoardDate(monthly.start_at),
      recurrence: 'monthly' as const,
      recurrenceUntil: '',
      days: [2],
      week: 2,
    }
    expect(occurrenceGridMoved(base, monthly)).toBe(false)
    expect(occurrenceGridMoved({ ...base, week: 3 }, monthly)).toBe(true)
    expect(occurrenceGridMoved({ ...base, week: null, days: [] }, monthly)).toBe(true)
  })

  it('繰り返しなしのまま日付だけ動かしても、回は 1 つのままなので崩れない', () => {
    const single = makeEvent({ recurrence: 'none' })
    expect(
      occurrenceGridMoved(
        { date: '2026-09-20', recurrence: 'none', recurrenceUntil: '', days: [], week: null },
        single,
      ),
    ).toBe(false)
  })

  it('繰り返しを付ける・外すときは動く', () => {
    const single = makeEvent({ recurrence: 'none' })
    expect(
      occurrenceGridMoved(
        { date: toBoardDate(single.start_at), recurrence: 'weekly', recurrenceUntil: '', days: [], week: null },
        single,
      ),
    ).toBe(true)
  })
})

describe('describeOccurrenceReset', () => {
  it('どちらもあれば両方を数える', () => {
    const text = describeOccurrenceReset(2, 3)
    expect(text).toContain('「この回だけ」の変更が 2 件')
    expect(text).toContain('出欠の回答が 3 件')
  })

  it('片方だけなら片方だけ言う', () => {
    expect(describeOccurrenceReset(1, 0)).toContain('「この回だけ」の変更が 1 件')
    expect(describeOccurrenceReset(1, 0)).not.toContain('出欠')
    expect(describeOccurrenceReset(0, 1)).toContain('出欠の回答が 1 件')
  })

  it('どちらも無ければ空文字（確認を出さない）', () => {
    expect(describeOccurrenceReset(0, 0)).toBe('')
  })
})

describe('答えの 3 択', () => {
  it('日程調整と同じ 3 つ', () => {
    const answers: AttendanceAnswer[] = ['yes', 'maybe', 'no']
    expect(answers).toHaveLength(3)
  })
})
