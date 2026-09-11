import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandOccurrences,
  firstIndexAtOrAfter,
  firstMatchingStart,
  hasByDay,
  nextDueDate,
  normalizeRule,
  nthOccurrence,
  occurrenceKey,
  originalStartFor,
  overrideKeyOf,
  recurrenceLabel,
  ruleOf,
  stepDates,
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
    recurrence_days: [],
    recurrence_week: null,
    recurrence_interval: null,
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

// ---------------------------------------------------------------------------
//  繰り返しの曜日指定

/** 展開結果を JST の 'yyyy-MM-dd' の並びに */
function days(event: CalendarEvent, from: Date, to: Date, overrides: EventOverride[] = []) {
  return expandOccurrences([event], from, to, overrides).map((o) => toBoardDate(o.start))
}

describe('normalizeRule', () => {
  it('曜日を持てるのは 毎週 と 毎月 だけ', () => {
    expect(normalizeRule({ recurrence: 'daily', days: [1, 3], week: 2 })).toEqual({
      recurrence: 'daily',
      days: [],
      week: null,
      interval: 1,
    })
    expect(normalizeRule({ recurrence: 'yearly', days: [1], week: null })).toEqual({
      recurrence: 'yearly',
      days: [],
      week: null,
      interval: 1,
    })
  })

  it('並べ替えて重複を除く', () => {
    expect(normalizeRule({ recurrence: 'weekly', days: [4, 2, 2, 0], week: null }).days).toEqual([
      0, 2, 4,
    ])
  })

  it('範囲の外の曜日は落とす', () => {
    expect(normalizeRule({ recurrence: 'weekly', days: [-1, 7, 3, 1.5], week: null }).days).toEqual([
      3,
    ])
  })

  it('毎週は第 n 週を持たない', () => {
    expect(normalizeRule({ recurrence: 'weekly', days: [2], week: 3 }).week).toBeNull()
  })

  it('毎月の第 n 曜日は、曜日をちょうど 1 つに絞る', () => {
    expect(normalizeRule({ recurrence: 'monthly', days: [2, 4], week: 2 })).toEqual({
      recurrence: 'monthly',
      days: [2],
      week: 2,
      interval: 1,
    })
  })

  it('第 n 週だけ・曜日だけでは成立しないので、どちらも落とす', () => {
    expect(normalizeRule({ recurrence: 'monthly', days: [], week: 2 })).toEqual({
      recurrence: 'monthly',
      days: [],
      week: null,
      interval: 1,
    })
    // 毎月で曜日だけを選んでも「第何週か」が決まらない
    expect(normalizeRule({ recurrence: 'monthly', days: [2], week: null })).toEqual({
      recurrence: 'monthly',
      days: [],
      week: null,
      interval: 1,
    })
  })

  it('第 0 週と範囲外の週は落とす（DB の CHECK と同じ）', () => {
    expect(normalizeRule({ recurrence: 'monthly', days: [2], week: 0 }).week).toBeNull()
    expect(normalizeRule({ recurrence: 'monthly', days: [2], week: 6 }).week).toBeNull()
    expect(normalizeRule({ recurrence: 'monthly', days: [2], week: -2 }).week).toBeNull()
    // 最終週は使える
    expect(normalizeRule({ recurrence: 'monthly', days: [2], week: -1 }).week).toBe(-1)
  })

  it('ruleOf は、列が無い（古い）行でも従来の意味になる', () => {
    expect(ruleOf({ recurrence: 'weekly' })).toEqual({
      recurrence: 'weekly',
      days: [],
      week: null,
      interval: 1,
    })
    expect(hasByDay(ruleOf({ recurrence: 'weekly' }))).toBe(false)
  })
})

describe('曜日を指定した毎週', () => {
  // 2026-09-01 は火曜
  const base = makeEvent({
    start_at: boardDateTimeIso('2026-09-01', '19:00'),
    end_at: null,
    recurrence: 'weekly',
    recurrence_days: [2, 4],
  })

  it('火・木の両方に出て、ほかの曜日には出ない', () => {
    expect(
      days(base, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-09-20T23:59:59+09:00')),
    ).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
      '2026-09-10',
      '2026-09-15',
      '2026-09-17',
    ])
  })

  it('開始日より前の回は出さない（最初の週は切り落とす）', () => {
    // 木曜 9/3 始まりなら、その週の火曜 9/1 は出ない
    const thursday = makeEvent({
      start_at: boardDateTimeIso('2026-09-03', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2, 4],
    })
    const list = days(
      thursday,
      new Date('2026-08-25T00:00:00+09:00'),
      new Date('2026-09-12T23:59:59+09:00'),
    )
    expect(list).toEqual(['2026-09-03', '2026-09-08', '2026-09-10'])
  })

  it('表示範囲が週の途中から始まっても、その週の回を落とさない', () => {
    // 9/10（木）から見る。9/8（火）は範囲外、9/10 は範囲内
    expect(
      days(base, new Date('2026-09-10T00:00:00+09:00'), new Date('2026-09-11T23:59:59+09:00')),
    ).toEqual(['2026-09-10'])
  })

  it('JST の時刻は保たれる', () => {
    const [first] = expandOccurrences(
      [base],
      new Date('2026-09-01T00:00:00+09:00'),
      new Date('2026-09-05T23:59:59+09:00'),
      [],
    )
    expect(jstTime(first.start)).toBe('19:00')
  })

  it('終了日を過ぎた回は出ない', () => {
    const until = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2, 4],
      recurrence_until: '2026-09-08',
    })
    expect(
      days(until, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-09-30T23:59:59+09:00')),
    ).toEqual(['2026-09-01', '2026-09-03', '2026-09-08'])
  })

  it('曜日を選ばなければ、これまでどおり開始日の曜日だけ', () => {
    const plain = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
    })
    expect(
      days(plain, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-09-20T23:59:59+09:00')),
    ).toEqual(['2026-09-01', '2026-09-08', '2026-09-15'])
  })

  it('月をまたいでも続く', () => {
    expect(
      days(base, new Date('2026-09-28T00:00:00+09:00'), new Date('2026-10-04T23:59:59+09:00')),
    ).toEqual(['2026-09-29', '2026-10-01'])
  })
})

describe('毎月の第 n 曜日', () => {
  // 2026-09-08 は第 2 火曜
  const second = makeEvent({
    start_at: boardDateTimeIso('2026-09-08', '19:00'),
    end_at: null,
    recurrence: 'monthly',
    recurrence_days: [2],
    recurrence_week: 2,
  })

  it('各月の第 2 火曜に出る', () => {
    expect(
      days(second, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-12-31T23:59:59+09:00')),
    ).toEqual(['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08'])
  })

  it('第 5 火曜が無い月は、丸めずに飛ばす', () => {
    // 2026-09-29 は第 5 火曜。10 月と 11 月には第 5 火曜が無い
    const fifth = makeEvent({
      start_at: boardDateTimeIso('2026-09-29', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: 5,
    })
    expect(
      days(fifth, new Date('2026-09-01T00:00:00+09:00'), new Date('2027-01-31T23:59:59+09:00')),
    ).toEqual(['2026-09-29', '2026-12-29'])
  })

  it('最終週（-1）は、その月の最後のその曜日', () => {
    const last = makeEvent({
      start_at: boardDateTimeIso('2026-09-29', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: -1,
    })
    expect(
      days(last, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-12-31T23:59:59+09:00')),
    ).toEqual(['2026-09-29', '2026-10-27', '2026-11-24', '2026-12-29'])
  })

  it('年をまたいでも続く', () => {
    expect(
      days(second, new Date('2026-12-01T00:00:00+09:00'), new Date('2027-02-28T23:59:59+09:00')),
    ).toEqual(['2026-12-08', '2027-01-12', '2027-02-09'])
  })

  it('表示範囲が月の途中から始まっても、その月の回を落とさない', () => {
    expect(
      days(second, new Date('2026-10-05T00:00:00+09:00'), new Date('2026-10-20T23:59:59+09:00')),
    ).toEqual(['2026-10-13'])
  })
})

describe('曜日指定と「この回だけ」', () => {
  it('木曜を足しても、火曜に付けた例外は生き残る', () => {
    const before = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2],
    })
    const override = makeOverride({
      occurrence_date: '2026-09-08',
      title: '場所が変わります',
    })

    const after = { ...before, recurrence_days: [2, 4] }
    const list = expandOccurrences(
      [after],
      new Date('2026-09-01T00:00:00+09:00'),
      new Date('2026-09-12T23:59:59+09:00'),
      [override],
    )

    const changed = list.find((o) => toBoardDate(o.start) === '2026-09-08')
    expect(changed?.view.title).toBe('場所が変わります')
    // 木曜ぶんが増えているだけで、火曜の並びは動いていない
    expect(list.map((o) => toBoardDate(o.start))).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
      '2026-09-10',
    ])
  })
})

describe('曜日指定を入れても、これまでの予定の展開は 1 日も変わらない', () => {
  /*
   * 既存の行は recurrence_days が空・recurrence_week が null になる。
   * ここが変わると、event_overrides の occurrence_date が指す回とずれて
   * 「この回だけ」の変更が一斉に迷子になる。期待値はベタ書きにしておく。
   */
  const from = new Date('2026-01-01T00:00:00+09:00')
  const to = new Date('2026-06-30T23:59:59+09:00')

  it('毎日', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-01-30', '10:00'),
      end_at: null,
      recurrence: 'daily',
    })
    expect(days(event, from, new Date('2026-02-03T23:59:59+09:00'))).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
      '2026-02-03',
    ])
  })

  it('毎週', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-01-31', '10:00'),
      end_at: null,
      recurrence: 'weekly',
    })
    expect(days(event, from, new Date('2026-02-28T23:59:59+09:00'))).toEqual([
      '2026-01-31',
      '2026-02-07',
      '2026-02-14',
      '2026-02-21',
      '2026-02-28',
    ])
  })

  it('毎月 31 日は月末へ丸める（飛ばさない）', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-01-31', '10:00'),
      end_at: null,
      recurrence: 'monthly',
    })
    expect(days(event, from, to)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ])
  })

  it('毎年', () => {
    const event = makeEvent({
      start_at: boardDateTimeIso('2026-02-15', '10:00'),
      end_at: null,
      recurrence: 'yearly',
    })
    expect(days(event, from, new Date('2029-12-31T23:59:59+09:00'))).toEqual([
      '2026-02-15',
      '2027-02-15',
      '2028-02-15',
      '2029-02-15',
    ])
  })
})

describe('n 回ごと（interval）', () => {
  // 2026-01-06 は火曜
  const biweekly = makeEvent({
    start_at: boardDateTimeIso('2026-01-06', '19:00'),
    end_at: null,
    recurrence: 'weekly',
    recurrence_days: [2, 4],
    recurrence_interval: 2,
  })

  /*
   * interval の渡し忘れを捕まえる要のテスト。
   *
   * firstIndexAtOrAfter に interval を渡さないと、at は「週の本数」になる。
   * 一方 stepDates は 1 区切りで interval 週ぶん進むので、at から数え始めた
   * 区切りは範囲のはるか先を指し、stepAnchor が即 break して 0 件になる。
   * 例外もログも出ず、予定が画面から黙って消える。
   * 範囲を 1 年半先に取っているのは、その差が開くところを見るため。
   */
  it('範囲が遠くても消えない', () => {
    expect(
      days(biweekly, new Date('2027-06-01T00:00:00+09:00'), new Date('2027-06-30T23:59:59+09:00')),
    ).toEqual(['2027-06-08', '2027-06-10', '2027-06-22', '2027-06-24'])
  })

  it('隔週の火・木は 14 日おきに出る', () => {
    expect(
      days(biweekly, new Date('2026-01-06T00:00:00+09:00'), new Date('2026-02-10T23:59:59+09:00')),
    ).toEqual(['2026-01-06', '2026-01-08', '2026-01-20', '2026-01-22', '2026-02-03', '2026-02-05'])
  })

  /*
   * 週の先頭が日曜であることの、唯一の観測できる証拠。
   * base 相対（開始日の週を第 0 週として開始曜日から数える）に変えると落ちる。
   * _shared/ics.ts の rruleFor が書き出す WKST=SU と、ここが対になっている。
   */
  it('木曜から始めた隔週 火・木は、初週が木だけになる', () => {
    const thursday = makeEvent({
      start_at: boardDateTimeIso('2026-09-03', '19:00'),
      end_at: null,
      recurrence: 'weekly',
      recurrence_days: [2, 4],
      recurrence_interval: 2,
    })
    expect(
      days(thursday, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-10-05T23:59:59+09:00')),
    ).toEqual(['2026-09-03', '2026-09-15', '2026-09-17', '2026-09-29', '2026-10-01'])
  })

  it('stepDates の区切りが interval ぶん進む', () => {
    const rule = normalizeRule({ recurrence: 'weekly', days: [2, 4], week: null, interval: 2 })
    const base = new Date(boardDateTimeIso('2026-09-03', '19:00'))
    expect(stepDates(base, rule, 0).map(toBoardDate)).toEqual(['2026-09-03'])
    expect(stepDates(base, rule, 1).map(toBoardDate)).toEqual(['2026-09-15', '2026-09-17'])
  })

  it('3 か月ごとは月末へ丸めたまま数える', () => {
    const quarterly = makeEvent({ recurrence: 'monthly', recurrence_interval: 3 })
    expect(days(quarterly, jan1, dec31)).toEqual([
      '2026-01-31',
      '2026-04-30',
      '2026-07-31',
      '2026-10-31',
    ])
  })

  it('3 日ごと', () => {
    const every3 = makeEvent({
      start_at: boardDateTimeIso('2026-09-01', '19:00'),
      end_at: null,
      recurrence: 'daily',
      recurrence_interval: 3,
    })
    expect(
      days(every3, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-09-10T23:59:59+09:00')),
    ).toEqual(['2026-09-01', '2026-09-04', '2026-09-07', '2026-09-10'])
  })

  it('2 年ごと', () => {
    const every2y = makeEvent({
      start_at: boardDateTimeIso('2026-03-01', '19:00'),
      end_at: null,
      recurrence: 'yearly',
      recurrence_interval: 2,
    })
    expect(
      days(every2y, new Date('2026-01-01T00:00:00+09:00'), new Date('2030-12-31T23:59:59+09:00')),
    ).toEqual(['2026-03-01', '2028-03-01', '2030-03-01'])
  })

  it('2 か月ごとの第 2 火曜', () => {
    const nth = makeEvent({
      start_at: boardDateTimeIso('2026-09-08', '19:00'),
      end_at: null,
      recurrence: 'monthly',
      recurrence_days: [2],
      recurrence_week: 2,
      recurrence_interval: 2,
    })
    expect(
      days(nth, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-12-31T23:59:59+09:00')),
    ).toEqual(['2026-09-08', '2026-11-10'])
  })

  it('normalizeRule は 1 未満・非整数・上限超えを 1 に落とす', () => {
    const of = (interval: number) =>
      normalizeRule({ recurrence: 'weekly', days: [], week: null, interval }).interval
    expect(of(0)).toBe(1)
    expect(of(-1)).toBe(1)
    expect(of(1.5)).toBe(1)
    expect(of(Number.NaN)).toBe(1)
    expect(of(100)).toBe(1)
    expect(of(99)).toBe(99)
    expect(of(2)).toBe(2)
  })

  it('繰り返さない予定の間隔は 1', () => {
    expect(normalizeRule({ recurrence: 'none', days: [], week: null, interval: 3 }).interval).toBe(1)
  })

  it('ruleOf は、列が無い（古い）行でも 1 になる', () => {
    expect(ruleOf({ recurrence: 'weekly' }).interval).toBe(1)
    expect(ruleOf({ recurrence: 'weekly', recurrence_interval: null }).interval).toBe(1)
    expect(ruleOf({ recurrence: 'weekly', recurrence_interval: 2 }).interval).toBe(2)
  })

  it('繰り返しやることの次回は interval ぶん進む', () => {
    const due = boardDateTimeIso('2026-09-01', '09:00')
    const rule = { recurrence: 'weekly' as const, days: [], week: null, interval: 2 }
    // 期限より前に完了しても、次回は 2 週間後
    expect(toBoardDate(nextDueDate(due, rule)!)).toBe('2026-09-15')
  })
})

describe('曜日指定を入れても、n 回ごとを入れても、これまでの予定の展開は 1 日も変わらない', () => {
  /*
   * 列が無い（古い）行・null・1 の 3 通りが、どれも同じ並びになること。
   * DB の既存行は null、画面から保存し直した行は 1 になるので、
   * この 2 つがずれると「開いて保存しただけ」で予定が動いてしまう。
   */
  const cases: { name: string; patch: Partial<CalendarEvent> }[] = [
    { name: '列が無い', patch: { recurrence_interval: undefined } },
    { name: 'null', patch: { recurrence_interval: null } },
    { name: '1', patch: { recurrence_interval: 1 } },
  ]

  for (const { name, patch } of cases) {
    it(`毎週 火・木（${name}）`, () => {
      const event = makeEvent({
        start_at: boardDateTimeIso('2026-09-01', '19:00'),
        end_at: null,
        recurrence: 'weekly',
        recurrence_days: [2, 4],
        ...patch,
      })
      expect(
        days(event, new Date('2026-09-01T00:00:00+09:00'), new Date('2026-09-20T23:59:59+09:00')),
      ).toEqual([
        '2026-09-01',
        '2026-09-03',
        '2026-09-08',
        '2026-09-10',
        '2026-09-15',
        '2026-09-17',
      ])
    })

    it(`毎月 31 日（${name}）`, () => {
      expect(days(makeEvent(patch), jan1, dec31)).toEqual([
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
    })
  }
})

describe('firstMatchingStart', () => {
  /*
   * 寄せるときだけは間隔を見ない。
   *
   * 土曜に「隔週 火」を選んだとき、開始日の週の火曜は開始より前なので落ち、
   * 間隔を見たまま次の区切りへ進むと 10 日後の火曜になる。押した人が待って
   * いるのは 3 日後の火曜。寄せは「規則に合う最初の日を探す」だけの操作で、
   * 位相は寄せ先を新しい第 0 週と読み替えれば自己整合する。
   */
  it('土曜の予定に「隔週 火」を選ぶと、10 日後ではなく次の火曜へ寄る', () => {
    const snapped = firstMatchingStart(boardDateTimeIso('2026-09-05', '19:00'), {
      recurrence: 'weekly',
      days: [2],
      week: null,
      interval: 2,
    })
    expect(toBoardDate(new Date(snapped))).toBe('2026-09-08')
  })

  it('金曜の予定に「毎週 火」を選ぶと、次の火曜へ寄る', () => {
    // 2026-09-04 は金曜
    const friday = boardDateTimeIso('2026-09-04', '19:00')
    const snapped = firstMatchingStart(friday, {
      recurrence: 'weekly',
      days: [2],
      week: null,
    })
    expect(toBoardDate(snapped)).toBe('2026-09-08')
    // 時刻は動かさない
    expect(jstTime(new Date(snapped))).toBe('19:00')
  })

  it('すでに規則に合っていれば動かさない', () => {
    const tuesday = boardDateTimeIso('2026-09-01', '19:00')
    expect(firstMatchingStart(tuesday, { recurrence: 'weekly', days: [2, 4], week: null })).toBe(
      tuesday,
    )
  })

  it('曜日指定が無ければ、そのまま返す', () => {
    const any = boardDateTimeIso('2026-09-04', '19:00')
    expect(firstMatchingStart(any, { recurrence: 'monthly', days: [], week: null })).toBe(any)
  })

  it('毎月 第 2 火曜なら、その月の第 2 火曜へ寄る', () => {
    const first = boardDateTimeIso('2026-09-01', '19:00')
    const snapped = firstMatchingStart(first, {
      recurrence: 'monthly',
      days: [2],
      week: 2,
    })
    expect(toBoardDate(snapped)).toBe('2026-09-08')
  })
})

describe('stepDates', () => {
  it('第 5 火曜の無い月は空を返す（呼ぶ側が回り続けないよう、区切りは進む）', () => {
    const base = new Date(boardDateTimeIso('2026-09-29', '19:00'))
    const rule = { recurrence: 'monthly' as const, days: [2], week: 5 }
    expect(stepDates(base, rule, 0).map(toBoardDate)).toEqual(['2026-09-29'])
    // 10 月・11 月には第 5 火曜が無い
    expect(stepDates(base, rule, 1)).toEqual([])
    expect(stepDates(base, rule, 2)).toEqual([])
    expect(stepDates(base, rule, 3).map(toBoardDate)).toEqual(['2026-12-29'])
  })
})

describe('recurrenceLabel', () => {
  it('曜日と第 n 週を言葉にする', () => {
    expect(recurrenceLabel({ recurrence: 'weekly', days: [2, 4], week: null })).toBe('毎週 火・木')
    expect(recurrenceLabel({ recurrence: 'monthly', days: [2], week: 2 })).toBe('毎月 第2火曜')
    expect(recurrenceLabel({ recurrence: 'monthly', days: [2], week: -1 })).toBe('毎月 最終火曜')
  })

  it('曜日指定が無ければ、これまでどおりの言い方', () => {
    expect(recurrenceLabel({ recurrence: 'weekly', days: [], week: null })).toBe('毎週')
    expect(recurrenceLabel({ recurrence: 'daily', days: [], week: null })).toBe('毎日')
    expect(recurrenceLabel({ recurrence: 'none', days: [], week: null })).toBe('繰り返さない')
  })

  it('n 回ごとを言葉にする', () => {
    expect(recurrenceLabel({ recurrence: 'weekly', days: [2, 4], week: null, interval: 2 })).toBe(
      '隔週 火・木',
    )
    expect(recurrenceLabel({ recurrence: 'weekly', days: [2, 4], week: null, interval: 3 })).toBe(
      '3週ごと 火・木',
    )
    expect(recurrenceLabel({ recurrence: 'monthly', days: [], week: null, interval: 3 })).toBe(
      '3か月ごと',
    )
    expect(recurrenceLabel({ recurrence: 'monthly', days: [2], week: 2, interval: 2 })).toBe(
      '2か月ごと 第2火曜',
    )
    expect(recurrenceLabel({ recurrence: 'daily', days: [], week: null, interval: 3 })).toBe(
      '3日ごと',
    )
    expect(recurrenceLabel({ recurrence: 'yearly', days: [], week: null, interval: 2 })).toBe(
      '2年ごと',
    )
  })

  it('間隔が 1 なら、これまでと 1 文字も変わらない', () => {
    expect(recurrenceLabel({ recurrence: 'weekly', days: [2, 4], week: null, interval: 1 })).toBe(
      '毎週 火・木',
    )
    expect(recurrenceLabel({ recurrence: 'monthly', days: [2], week: 2, interval: 1 })).toBe(
      '毎月 第2火曜',
    )
    expect(recurrenceLabel({ recurrence: 'daily', days: [], week: null, interval: 1 })).toBe('毎日')
  })
})

describe('曜日を指定した繰り返しやることの次回', () => {
  /*
   * 「次回」は now より後の回なので、now を渡さないと結果が実行した日で変わる。
   * 期限のすぐ後に完了した、という状況を作って確かめる。
   */
  const justAfter = (dueIso: string) => new Date(new Date(dueIso).getTime() + 60_000)

  it('毎週 火・木なら、火の次は木', () => {
    // 2026-09-01（火）を完了 → 次は 9/3（木）
    const due = boardDateTimeIso('2026-09-01', '10:00')
    const next = nextDueDateShared(
      due,
      { recurrence: 'weekly', days: [2, 4], week: null },
      justAfter(due),
    )!
    expect(toBoardDate(next)).toBe('2026-09-03')
    expect(jstTime(new Date(next))).toBe('10:00')
  })

  it('木の次は翌週の火', () => {
    const due = boardDateTimeIso('2026-09-03', '10:00')
    const next = nextDueDateShared(
      due,
      { recurrence: 'weekly', days: [2, 4], week: null },
      justAfter(due),
    )!
    expect(toBoardDate(next)).toBe('2026-09-08')
  })

  it('期限より前に完了しても、次回は 1 つ先へ進む', () => {
    const due = boardDateTimeIso('2026-09-08', '10:00')
    const next = nextDueDateShared(
      due,
      { recurrence: 'monthly', days: [2], week: 2 },
      new Date('2026-09-01T00:00:00Z'),
    )!
    expect(toBoardDate(next)).toBe('2026-10-13')
  })

  it('放置されていても、いまより後の回になる', () => {
    // 2026-09-01（火）の期限を、11 月に入ってから完了した
    const due = boardDateTimeIso('2026-09-01', '10:00')
    const next = nextDueDateShared(
      due,
      { recurrence: 'weekly', days: [2, 4], week: null },
      new Date('2026-11-04T00:00:00+09:00'),
    )!
    expect(toBoardDate(next)).toBe('2026-11-05')
  })

  it('文字列で渡す従来の呼び方も、そのまま動く', () => {
    const due = boardDateTimeIso('2026-09-01', '10:00')
    expect(toBoardDate(nextDueDateShared(due, 'weekly', justAfter(due))!)).toBe('2026-09-08')
    // フロント側のラッパー（now を取らない）も、規則を受け付ける
    expect(nextDueDate(due, { recurrence: 'none', days: [], week: null })).toBeNull()
  })
})

describe('send-reminders が取ってくる列', () => {
  /*
   * EVENT_COLUMNS に列を足し忘れても、何もエラーにならない。
   * ruleOf が undefined を見て従来どおりの並びに落ち、通知だけが違う曜日に飛ぶ。
   * 画面でもテストでも気づけないので、ここで並びそのものを見る。
   *
   * 予定の展開に使う列（EventLike）が 1 つでも欠けていたら落とす。
   */
  const EVENT_LIKE_COLUMNS = [
    'id',
    'title',
    'description',
    'start_at',
    'end_at',
    'all_day',
    'color',
    'recurrence',
    'recurrence_days',
    'recurrence_week',
    'recurrence_interval',
    'recurrence_until',
    'remind_minutes',
    'tags',
  ]

  it('EventLike の列がすべて並んでいる', () => {
    const source = readFileSync(
      new URL('../../../supabase/functions/send-reminders/handler.ts', import.meta.url),
      'utf8',
    )
    const match = /const EVENT_COLUMNS\s*=\s*\n?\s*'([^']+)'/.exec(source)
    expect(match, 'EVENT_COLUMNS が見つかりません').not.toBeNull()

    const columns = match![1].split(',').map((c) => c.trim())
    for (const column of EVENT_LIKE_COLUMNS) {
      expect(columns, `${column} が EVENT_COLUMNS にありません`).toContain(column)
    }
  })

  it('この一覧じたいが EventLike と揃っている', () => {
    // makeEvent が返す行から、展開に関係しない列を除いたものと一致するはず。
    // EventLike に列が増えたとき、上の一覧を直し忘れたらここで落ちる
    const notUsedForExpansion = [
      'room_id',
      'kind',
      'source_note_id',
      'source_synced_at',
      'deleted_at',
      'author_id',
      'author_name',
      'created_at',
      'updated_at',
    ]
    const fromType = Object.keys(makeEvent())
      .filter((key) => !notUsedForExpansion.includes(key))
      .sort()
    expect(fromType).toEqual([...EVENT_LIKE_COLUMNS].sort())
  })
})
