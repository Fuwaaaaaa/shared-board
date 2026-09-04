import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandOccurrences,
  firstIndexAtOrAfter,
  nextDueDate,
  nthOccurrence,
  occurrenceKey,
  originalStartFor,
  overrideKeyOf,
} from '../recurrence'
import { nextDueDate as nextDueDateShared } from '../../../supabase/functions/_shared/recurrence.ts'
import {
  allDayEndIso,
  allDayStartIso,
  boardDateTimeIso,
  occurrenceKeyDate,
  toBoardDate,
} from '../dates'
import type { CalendarEvent, EventOverride, Recurrence } from '../types'

function makeEvent(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    room_id: 'r1',
    kind: 'event',
    title: '定例',
    description: '',
    start_at: boardDateTimeIso('2026-01-31', '10:00'),
    end_at: boardDateTimeIso('2026-01-31', '11:00'),
    all_day: false,
    color: 'blue',
    recurrence: 'monthly',
    recurrence_until: null,
    remind_minutes: 15,
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

function jstTime(date: Date): string {
  const t = new Date(date.getTime() + 9 * 3600_000)
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

/** 展開結果を JST の 'yyyy-MM-dd HH:mm' に */
function stamp(date: Date): string {
  return `${toBoardDate(date)} ${jstTime(date)}`
}

const jan1 = new Date('2026-01-01T00:00:00+09:00')
const dec31 = new Date('2026-12-31T23:59:59+09:00')

describe('nthOccurrence', () => {
  it('1/31 の毎月は 2/28, 3/31, 4/30 に出る（累積でずれない）', () => {
    const base = new Date(boardDateTimeIso('2026-01-31', '10:00'))
    expect(stamp(nthOccurrence(base, 'monthly', 1))).toBe('2026-02-28 10:00')
    expect(stamp(nthOccurrence(base, 'monthly', 2))).toBe('2026-03-31 10:00')
    expect(stamp(nthOccurrence(base, 'monthly', 3))).toBe('2026-04-30 10:00')
    expect(stamp(nthOccurrence(base, 'monthly', 12))).toBe('2027-01-31 10:00')
    expect(stamp(nthOccurrence(base, 'monthly', 25))).toBe('2028-02-29 10:00')
  })

  it('2/29 の毎年は 2/28 に丸め、うるう年には 2/29 に戻る', () => {
    const base = new Date(allDayStartIso('2024-02-29'))
    expect(toBoardDate(nthOccurrence(base, 'yearly', 1))).toBe('2025-02-28')
    expect(toBoardDate(nthOccurrence(base, 'yearly', 4))).toBe('2028-02-29')
  })

  it('daily / weekly は JST の壁時計を保つ', () => {
    const base = new Date(boardDateTimeIso('2026-03-01', '09:00'))
    expect(stamp(nthOccurrence(base, 'daily', 40))).toBe('2026-04-10 09:00')
    expect(stamp(nthOccurrence(base, 'weekly', 3))).toBe('2026-03-22 09:00')
  })

  it('interval を掛けられる', () => {
    const base = new Date(boardDateTimeIso('2026-01-31', '10:00'))
    expect(stamp(nthOccurrence(base, 'monthly', 1, 2))).toBe('2026-03-31 10:00')
    expect(stamp(nthOccurrence(base, 'weekly', 2, 2))).toBe('2026-02-28 10:00')
  })
})

describe('firstIndexAtOrAfter', () => {
  it('逐次計算と一致する（ランダム）', () => {
    // 再現できるよう単純な線形合同法で乱数を作る
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const recs: Exclude<Recurrence, 'none'>[] = ['daily', 'weekly', 'monthly', 'yearly']

    for (let i = 0; i < 300; i++) {
      const rec = recs[Math.floor(rand() * recs.length)]
      const interval = 1 + Math.floor(rand() * 3)
      const base = new Date(
        Date.UTC(1990 + Math.floor(rand() * 40), Math.floor(rand() * 12), 1 + Math.floor(rand() * 31), Math.floor(rand() * 24), Math.floor(rand() * 60)),
      )
      const from = new Date(base.getTime() + (rand() - 0.1) * 20 * 365 * 24 * 3600_000)

      let expected = 0
      while (nthOccurrence(base, rec, expected, interval) < from) expected++

      expect(firstIndexAtOrAfter(base, rec, from, interval), `${rec} x${interval} base=${base.toISOString()} from=${from.toISOString()}`).toBe(expected)
    }
  })

  it('from が base 以前なら 0', () => {
    const base = new Date('2026-05-01T00:00:00Z')
    expect(firstIndexAtOrAfter(base, 'daily', new Date('2020-01-01T00:00:00Z'))).toBe(0)
    expect(firstIndexAtOrAfter(base, 'monthly', base)).toBe(0)
  })
})

describe('expandOccurrences', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('1/31 の毎月を 1 年展開すると月末に揃う', () => {
    const list = expandOccurrences([makeEvent()], jan1, dec31, [])
    expect(list.map((o) => toBoardDate(o.start))).toEqual([
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
    expect(list[0].end?.getTime()).toBe(list[0].start.getTime() + 3600_000)
  })

  it('recurrence_until 当日の回は出て、翌日は出ない', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '23:30'),
      end_at: null,
      recurrence: 'daily',
      recurrence_until: '2026-09-03',
    })
    const list = expandOccurrences([event], jan1, dec31, [])
    expect(list.map((o) => toBoardDate(o.start))).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
  })

  it('2015 年に始まった毎日を 2026 年の 1 週間で展開すると 7 件', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2015-04-01', '08:00'),
      end_at: null,
      recurrence: 'daily',
    })
    const from = new Date(allDayStartIso('2026-09-07'))
    const to = new Date('2026-09-13T23:59:59+09:00')
    const list = expandOccurrences([event], from, to, [])
    expect(list).toHaveLength(7)
    expect(toBoardDate(list[0].start)).toBe('2026-09-07')
    expect(toBoardDate(list[6].start)).toBe('2026-09-13')
    expect(list.every((o) => jstTime(o.start) === '08:00')).toBe(true)
  })

  it('範囲の手前で始まり範囲にかかる複数日の予定も拾う', () => {
    const event = makeEvent({
      start_at: allDayStartIso('2026-09-05'),
      end_at: allDayStartIso('2026-09-07'),
      all_day: true,
      recurrence: 'weekly',
    })
    const from = new Date(allDayStartIso('2026-09-13'))
    const to = new Date(allDayStartIso('2026-09-14'))
    const list = expandOccurrences([event], from, to, [])
    expect(list.map((o) => toBoardDate(o.originalStart))).toEqual(['2026-09-12'])
  })

  it('繰り返しなしの予定はそのまま 1 件', () => {
    const event = makeEvent({ recurrence: 'none' })
    expect(expandOccurrences([event], jan1, dec31, [])).toHaveLength(1)
    expect(expandOccurrences([event], new Date('2027-01-01T00:00:00Z'), new Date('2027-02-01T00:00:00Z'), [])).toHaveLength(0)
  })

  it('例外: この回だけ削除・移動・通知の上書き', () => {
    const event = makeEvent({ recurrence: 'daily', start_at: boardDateTimeIso('2026-09-01', '10:00'), end_at: boardDateTimeIso('2026-09-01', '11:00') })
    const overrides = [
      makeOverride({ id: 'o-cancel', occurrence_date: '2026-09-02', canceled: true }),
      makeOverride({
        id: 'o-move',
        occurrence_date: '2026-09-03',
        title: '動かした回',
        start_at: boardDateTimeIso('2026-09-10', '15:00'),
        end_at: boardDateTimeIso('2026-09-10', '16:00'),
        all_day: false,
        color: 'rose',
        remind_minutes: 60,
        tags: ['x'],
      }),
      makeOverride({
        id: 'o-remind',
        occurrence_date: '2026-09-04',
        title: '定例',
        start_at: boardDateTimeIso('2026-09-04', '10:00'),
        end_at: boardDateTimeIso('2026-09-04', '11:00'),
        all_day: false,
        color: 'blue',
        remind_minutes: null,
        tags: [],
      }),
    ]
    const from = new Date(allDayStartIso('2026-09-01'))
    const to = new Date('2026-09-05T23:59:59+09:00')
    const list = expandOccurrences([event], from, to, overrides)

    expect(list.map((o) => toBoardDate(o.originalStart))).toEqual([
      '2026-09-01',
      '2026-09-04',
      '2026-09-05',
    ])
    const sep4 = list.find((o) => toBoardDate(o.originalStart) === '2026-09-04')!
    expect(sep4.view.remind_minutes).toBeNull()
    expect(sep4.override?.id).toBe('o-remind')

    // 動かした先が範囲に入るときは、その範囲で拾える
    const later = expandOccurrences(
      [event],
      new Date(allDayStartIso('2026-09-10')),
      new Date('2026-09-10T23:59:59+09:00'),
      overrides,
    )
    const moved = later.find((o) => o.override?.id === 'o-move')!
    expect(moved).toBeDefined()
    expect(toBoardDate(moved.originalStart)).toBe('2026-09-03')
    expect(stamp(moved.start)).toBe('2026-09-10 15:00')
    expect(moved.view.title).toBe('動かした回')
    expect(moved.view.remind_minutes).toBe(60)
    // 同じ日の素の回（9/10）も別の回として出る
    expect(later.filter((o) => toBoardDate(o.originalStart) === '2026-09-10')).toHaveLength(1)
  })

  it('キー関数は元の回の JST で決まる', () => {
    const event = makeEvent()
    const original = new Date(boardDateTimeIso('2026-02-28', '10:00'))
    expect(occurrenceKey(event.id, original)).toBe('e1@20260228T1000')
    expect(overrideKeyOf(event.id, original)).toBe('e1|2026-02-28')
    expect(occurrenceKeyDate(original)).toBe('2026-02-28')
    expect(originalStartFor(event, '2026-02-28').getTime()).toBe(original.getTime())
  })

  it('タイムゾーンを NY にしても occurrenceKeyDate と JST 展開が変わらない', () => {
    const event = makeEvent({ all_day: false })
    const reference = expandOccurrences([event], jan1, dec31, []).map((o) => [
      occurrenceKeyDate(o.originalStart),
      o.start.toISOString(),
      o.occurrenceKey,
    ])

    vi.stubEnv('TZ', 'America/New_York')
    expect(new Date('2026-09-01T00:00:00Z').getTimezoneOffset()).not.toBe(-540)

    const inNy = expandOccurrences([event], jan1, dec31, []).map((o) => [
      occurrenceKeyDate(o.originalStart),
      o.start.toISOString(),
      o.occurrenceKey,
    ])
    expect(inNy).toEqual(reference)
    expect(inNy[1][0]).toBe('2026-02-28')
  })

  it('海外の閲覧者には終日予定が JST の日付のローカル 0:00 に置き直される', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const event = makeEvent({
      start_at: allDayStartIso('2026-09-01'),
      end_at: allDayEndIso('2026-09-01'),
      all_day: true,
      recurrence: 'none',
    })
    const from = new Date(2026, 7, 1)
    const to = new Date(2026, 9, 1)
    const [occurrence] = expandOccurrences([event], from, to, [])
    expect(occurrence).toBeDefined()
    // ローカル（NY）の 2026-09-01 0:00
    expect(occurrence.start.getFullYear()).toBe(2026)
    expect(occurrence.start.getMonth()).toBe(8)
    expect(occurrence.start.getDate()).toBe(1)
    expect(occurrence.start.getHours()).toBe(0)
    // originalStart は触らない
    expect(occurrence.originalStart.toISOString()).toBe('2026-08-31T15:00:00.000Z')
  })
})

describe('nextDueDate', () => {
  it('now より後の最初の回を返す（少なくとも 1 回は進める）', () => {
    const due = boardDateTimeIso('2026-01-31', '10:00')
    expect(stamp(new Date(nextDueDateShared(due, 'monthly', new Date('2026-01-31T00:00:00Z'))!))).toBe(
      '2026-02-28 10:00',
    )
    expect(stamp(new Date(nextDueDateShared(due, 'monthly', new Date('2026-05-15T00:00:00Z'))!))).toBe(
      '2026-05-31 10:00',
    )
    // まだ期限前に完了しても、次回は 1 つ先
    expect(stamp(new Date(nextDueDateShared(due, 'monthly', new Date('2025-01-01T00:00:00Z'))!))).toBe(
      '2026-02-28 10:00',
    )
    // ちょうど期限の時刻なら「後」なので次の回
    expect(stamp(new Date(nextDueDateShared(due, 'daily', new Date(due))!))).toBe('2026-02-01 10:00')
    expect(nextDueDateShared(due, 'none')).toBeNull()
    expect(nextDueDate(due, 'none')).toBeNull()
  })

  it('過去に放置されていても未来の回になる', () => {
    const next = nextDueDate(boardDateTimeIso('2015-01-31', '10:00'), 'monthly')!
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now())
    // 月末の日付は保たれる（毎月 31 日 → 30/31 日）
    const parts = toBoardDate(next).split('-').map(Number)
    expect(parts[2]).toBeGreaterThanOrEqual(28)
    // JST の時刻は保たれる
    expect(jstTime(new Date(next))).toBe('10:00')
  })
})
