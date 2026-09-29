import { format, parseISO } from 'date-fns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allDayEndIso,
  allDayStartIso,
  boardDateTimeIso,
  boardStamp,
  daysInMonth,
  fromBoardParts,
  localDateTimeIso,
  occurrenceKeyDate,
  pinBoardDay,
  reminderKey,
  toBoardDate,
  toBoardParts,
  untilLimit,
} from '../dates'

describe('dates（ボードの暦 = Asia/Tokyo）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('終日予定の開始は JST 0:00（= 前日 15:00Z）', () => {
    expect(allDayStartIso('2026-09-01')).toBe('2026-08-31T15:00:00.000Z')
    expect(allDayEndIso('2026-09-01')).toBe('2026-09-01T14:59:00.000Z')
  })

  it('日付と時刻を JST として ISO にする', () => {
    expect(boardDateTimeIso('2026-09-01', '10:30')).toBe('2026-09-01T01:30:00.000Z')
    expect(boardDateTimeIso('2026-01-01', '00:00')).toBe('2025-12-31T15:00:00.000Z')
  })

  it('toBoardDate は ISO 文字列でも Date でも同じ日付を返し、往復できる', () => {
    expect(toBoardDate('2026-08-31T15:00:00.000Z')).toBe('2026-09-01')
    expect(toBoardDate(new Date('2026-08-31T14:59:59.999Z'))).toBe('2026-08-31')
    for (const day of ['2024-02-29', '2026-01-01', '2026-12-31']) {
      expect(toBoardDate(allDayStartIso(day))).toBe(day)
      expect(toBoardDate(allDayEndIso(day))).toBe(day)
    }
  })

  it('toBoardParts / fromBoardParts は往復し、月末を超えた日は繰り上がる', () => {
    const date = new Date('2026-03-31T14:59:59.999Z')
    const parts = toBoardParts(date)
    expect(parts).toEqual({ y: 2026, m: 3, d: 31, hh: 23, mm: 59, ss: 59, ms: 999 })
    expect(fromBoardParts(parts).getTime()).toBe(date.getTime())
    expect(toBoardDate(fromBoardParts({ y: 2026, m: 1, d: 32 }))).toBe('2026-02-01')
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 2)).toBe(28)
  })

  it('boardStamp は JST の壁時計', () => {
    expect(boardStamp('2026-08-31T15:00:00.000Z')).toBe('20260901T0000')
  })

  it('untilLimit は終了日の翌日 JST 0:00（排他）', () => {
    expect(untilLimit('2026-09-30')?.toISOString()).toBe('2026-09-30T15:00:00.000Z')
    expect(untilLimit('2026-12-31')?.toISOString()).toBe('2026-12-31T15:00:00.000Z')
    expect(untilLimit(null)).toBeNull()
    expect(untilLimit('')).toBeNull()
    // ISO 形式で入っていても JST の日付として扱う
    expect(untilLimit('2026-09-30T00:00:00+09:00')?.toISOString()).toBe(
      '2026-09-30T15:00:00.000Z',
    )
  })

  it('occurrenceKeyDate は元の回の JST 日付', () => {
    expect(occurrenceKeyDate(new Date('2026-08-31T15:00:00.000Z'))).toBe('2026-09-01')
    expect(occurrenceKeyDate('2026-08-31T14:59:00.000Z')).toBe('2026-08-31')
  })

  it('reminderKey は時刻を toISOString 形式に正規化する（+00:00 と Z で同じ）', () => {
    const a = reminderKey('event', 'e1', '2026-09-01T01:00:00+00:00', 30)
    const b = reminderKey('event', 'e1', '2026-09-01T01:00:00Z', 30)
    const c = reminderKey('event', 'e1', new Date('2026-09-01T10:00:00+09:00'), 30)
    expect(a).toBe('event:e1:2026-09-01T01:00:00.000Z:30')
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(reminderKey('todo', 't1', '2026-09-01T10:00:00+09:00', 0)).toBe(
      'todo:t1:2026-09-01T01:00:00.000Z:0',
    )
  })

  it('実行環境のタイムゾーンを変えても結果が変わらない', () => {
    vi.stubEnv('TZ', 'America/New_York')
    // stub が効いていることの確認（NY は UTC-4/-5）
    expect(new Date('2026-09-01T00:00:00Z').getTimezoneOffset()).not.toBe(-540)

    expect(allDayStartIso('2026-09-01')).toBe('2026-08-31T15:00:00.000Z')
    expect(toBoardDate('2026-08-31T15:00:00.000Z')).toBe('2026-09-01')
    expect(boardDateTimeIso('2026-09-01', '10:30')).toBe('2026-09-01T01:30:00.000Z')
    expect(untilLimit('2026-09-30')?.toISOString()).toBe('2026-09-30T15:00:00.000Z')
  })
})

/*
 * 入力欄の読み書きは、閲覧者の時計で揃える。
 *
 * 時刻のある予定・やることは、画面ではローカル時刻で出し、入力欄もローカルで埋めている。
 * 以前は保存だけ JST で読んでいたので、日本以外から開いた人がタイトルだけ直して
 * 保存しても、時差ぶん時刻がずれていった（ニューヨークなら 13 時間）。
 */
describe('入力欄の日時（閲覧者の時計）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('日本で開いている人には、JST として読むのと同じ', () => {
    expect(localDateTimeIso('2026-09-01', '10:30')).toBe(boardDateTimeIso('2026-09-01', '10:30'))
  })

  it('入力欄を埋めた値をそのまま保存しても、時刻は動かない（ニューヨーク）', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const saved = '2026-10-01T01:00:00.000Z' // JST 10:00 = NY 前日 21:00

    // 入力欄はローカルで埋める
    const date = format(parseISO(saved), 'yyyy-MM-dd')
    const time = format(parseISO(saved), 'HH:mm')
    expect([date, time]).toEqual(['2026-09-30', '21:00'])

    // 同じ時計で読めば、元の時刻に戻る
    expect(localDateTimeIso(date, time)).toBe(saved)
  })

  it('形が崩れていたら RangeError', () => {
    expect(() => localDateTimeIso('2026-09-01', '')).toThrow(RangeError)
    expect(() => localDateTimeIso('', '10:00')).toThrow(RangeError)
  })

  /*
   * 終日は JST 0:00 で保存している。そのまま format() すると日本より西では前日になり、
   * 保存するたびに 1 日ずつ前へずれていた。
   */
  it('終日の日時は、JST の日付のままローカルの 0:00 に置き直す', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const stored = allDayStartIso('2026-10-01') // 2026-09-30T15:00Z

    expect(format(parseISO(stored), 'yyyy-MM-dd')).toBe('2026-09-30') // 置き直さないと前日
    expect(format(pinBoardDay(stored), 'yyyy-MM-dd')).toBe('2026-10-01')
    expect(allDayStartIso(format(pinBoardDay(stored), 'yyyy-MM-dd'))).toBe(stored)
  })
})
