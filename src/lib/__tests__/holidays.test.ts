import { describe, expect, it } from 'vitest'
import { getHolidayName } from '../holidays'

function name(y: number, m: number, d: number): string | null {
  return getHolidayName(new Date(y, m - 1, d))
}

describe('getHolidayName', () => {
  it('2019 年の即位関連（4/30・5/2 は国民の休日）', () => {
    expect(name(2019, 4, 29)).toBe('昭和の日')
    expect(name(2019, 4, 30)).toBe('国民の休日')
    expect(name(2019, 5, 1)).toBe('天皇の即位の日')
    expect(name(2019, 5, 2)).toBe('国民の休日')
    expect(name(2019, 5, 3)).toBe('憲法記念日')
    expect(name(2019, 5, 6)).toBe('振替休日') // 5/5 こどもの日が日曜
    expect(name(2019, 10, 22)).toBe('即位礼正殿の儀')
    expect(name(2019, 2, 23)).toBeNull()
    expect(name(2019, 12, 23)).toBeNull()
  })

  it('2020 / 2021 年のオリンピック特例', () => {
    expect(name(2020, 7, 23)).toBe('海の日')
    expect(name(2020, 7, 24)).toBe('スポーツの日')
    expect(name(2020, 8, 10)).toBe('山の日')
    expect(name(2020, 7, 20)).toBeNull()
    expect(name(2020, 10, 12)).toBeNull()

    expect(name(2021, 7, 22)).toBe('海の日')
    expect(name(2021, 7, 23)).toBe('スポーツの日')
    expect(name(2021, 8, 8)).toBe('山の日')
    expect(name(2021, 8, 9)).toBe('振替休日')
    expect(name(2021, 8, 11)).toBeNull()
  })

  it('振替休日と国民の休日（2026 年）', () => {
    expect(name(2026, 5, 3)).toBe('憲法記念日') // 日曜
    expect(name(2026, 5, 4)).toBe('みどりの日')
    expect(name(2026, 5, 5)).toBe('こどもの日')
    expect(name(2026, 5, 6)).toBe('振替休日')
    expect(name(2026, 9, 21)).toBe('敬老の日')
    expect(name(2026, 9, 22)).toBe('国民の休日')
    expect(name(2026, 9, 23)).toBe('秋分の日')
  })

  it('天皇誕生日は 2018 年まで 12/23、2020 年から 2/23', () => {
    expect(name(2018, 12, 23)).toBe('天皇誕生日')
    expect(name(2018, 12, 24)).toBe('振替休日') // 2018-12-23 は日曜
    expect(name(2019, 12, 23)).toBeNull()
    expect(name(2020, 2, 23)).toBe('天皇誕生日')
    expect(name(2020, 2, 24)).toBe('振替休日')
    expect(name(1988, 4, 29)).toBe('天皇誕生日')
    expect(name(1989, 4, 29)).toBe('みどりの日')
    expect(name(2006, 4, 29)).toBe('みどりの日')
    expect(name(2007, 4, 29)).toBe('昭和の日')
    expect(name(2006, 5, 4)).toBe('国民の休日')
    expect(name(2007, 5, 4)).toBe('みどりの日')
  })

  it('ハッピーマンデー前の固定日', () => {
    expect(name(1999, 1, 15)).toBe('成人の日')
    expect(name(2000, 1, 10)).toBe('成人の日')
    expect(name(1999, 10, 10)).toBe('体育の日')
    expect(name(1999, 10, 11)).toBe('振替休日') // 1999-10-10 は日曜
    expect(name(2002, 9, 15)).toBe('敬老の日')
    expect(name(2003, 9, 15)).toBe('敬老の日') // 第 3 月曜がたまたま 15 日
    expect(name(1996, 7, 20)).toBe('海の日')
    expect(name(1995, 7, 20)).toBeNull()
    expect(name(2003, 7, 21)).toBe('海の日')
    expect(name(2015, 8, 11)).toBeNull()
    expect(name(2016, 8, 11)).toBe('山の日')
  })

  it('皇室行事の 1 回限りの休日', () => {
    expect(name(1989, 2, 24)).toBe('昭和天皇の大喪の礼')
    expect(name(1990, 11, 12)).toBe('即位礼正殿の儀')
    expect(name(1993, 6, 9)).toBe('皇太子徳仁親王の結婚の儀')
  })

  it('2007 年より前の振替休日は翌日だけ', () => {
    // 1993-05-03 は月曜なので振替なし。1992-05-03 が日曜 → 5/4 が振替休日
    expect(name(1992, 5, 3)).toBe('憲法記念日')
    expect(name(1992, 5, 4)).toBe('振替休日')
    expect(name(1992, 5, 6)).toBeNull()
    // 2009-05-03 が日曜 → 5/4・5/5 は祝日なので 5/6 が振替休日
    expect(name(2009, 5, 6)).toBe('振替休日')
  })

  it('対応範囲外の年は null', () => {
    expect(name(1979, 1, 1)).toBeNull()
    expect(name(2100, 1, 1)).toBeNull()
    expect(name(1980, 1, 1)).toBe('元日')
    expect(name(2099, 1, 1)).toBe('元日')
  })
})
