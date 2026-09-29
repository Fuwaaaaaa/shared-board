import { describe, expect, it } from 'vitest'
import { localDateTimeIso } from '../dates'
import { missingDateTime } from '../eventForm'

/*
 * 予定の編集画面で、日付や時刻の欄が空のまま保存させない。
 *
 * 保存は localDateTimeIso で入力欄を読むが、空の欄は読めずに例外になる。以前は
 * それがそのまま投げられ、「保存中」のまま画面が固まっていた。
 */

const draft = {
  date: '2026-10-05',
  time: '10:00',
  allDay: false,
  hasEnd: false,
  endDate: '2026-10-05',
  endTime: '11:00',
}

describe('missingDateTime', () => {
  it('空の欄は、読むと例外になる（だから先に止める）', () => {
    expect(() => localDateTimeIso('2026-10-05', '')).toThrow(RangeError)
    expect(() => localDateTimeIso('', '10:00')).toThrow(RangeError)
  })

  it('埋まっていれば止めない', () => {
    expect(missingDateTime(draft)).toBeNull()
    expect(missingDateTime({ ...draft, hasEnd: true })).toBeNull()
  })

  it('開始の時刻・日付が空なら止める', () => {
    expect(missingDateTime({ ...draft, time: '' })).toBe('開始の日付と時刻を入れてください')
    expect(missingDateTime({ ...draft, date: '' })).toBe('開始の日付と時刻を入れてください')
  })

  it('終日なら時刻は見ない', () => {
    expect(missingDateTime({ ...draft, allDay: true, time: '' })).toBeNull()
    expect(missingDateTime({ ...draft, allDay: true, hasEnd: true, endTime: '' })).toBeNull()
  })

  it('終了を指定しているときだけ、終了の欄も見る', () => {
    expect(missingDateTime({ ...draft, endTime: '' })).toBeNull()
    expect(missingDateTime({ ...draft, hasEnd: true, endTime: '' })).toMatch(/^終了の日付と時刻/)
    expect(missingDateTime({ ...draft, hasEnd: true, endDate: '' })).toMatch(/^終了の日付と時刻/)
  })
})
