import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  boardDateTimeText,
  formatWeekdays,
  looksMojibake,
  parseCsv,
  parseCsvObjects,
  parseWeekOrdinal,
  parseWeekdays,
  parseFlexibleDate,
  toCsv,
} from '../csv'

const BOM = '\uFEFF'

/** BOM と CRLF を外して行ごとに見る */
function lines(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').replace(/\r\n$/, '').split('\r\n')
}

describe('toCsv', () => {
  it('BOM を付け、CRLF で区切り、末尾も CRLF で終わる', () => {
    const csv = toCsv(['a', 'b'], [['1', '2']])
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv).toBe(`${BOM}a,b\r\n1,2\r\n`)
  })

  it('数式に見える先頭文字（= + - @）には \' を前置する', () => {
    const csv = toCsv(['x'], [['=1+1'], ['+1'], ['-1'], ['@x']])
    expect(lines(csv)).toEqual(['x', "'=1+1", "'+1", "'-1", "'@x"])
  })

  it('タブ・CR で始まる文字列も保護される（引用符つきで出る）', () => {
    const csv = toCsv(['x'], [['\tabc']])
    expect(lines(csv)[1]).toBe("'\tabc")

    const withCr = toCsv(['x'], [['\rabc']])
    // CR を含むので引用符で囲まれる。先頭の ' はその内側
    expect(withCr).toBe(`${BOM}x\r\n"'\rabc"\r\n`)
  })

  it('数値・真偽値はそのまま出す（-1 という数値には \' を付けない）', () => {
    const csv = toCsv(['n', 'b'], [[-1, true], [0, false]])
    expect(lines(csv)).toEqual(['n,b', '-1,true', '0,false'])
  })

  it('null は空欄', () => {
    expect(lines(toCsv(['a', 'b'], [[null, 'x']]))).toEqual(['a,b', ',x'])
  })

  it('引用符と改行とカンマをエスケープする', () => {
    const csv = toCsv(['t'], [['彼は "やあ" と言った'], ['1行目\n2行目'], ['a,b']])
    expect(lines(csv)).toEqual([
      't',
      '"彼は ""やあ"" と言った"',
      '"1行目\n2行目"',
      '"a,b"',
    ])
  })

  it('ふつうの文字列には何も付けない（数式の先頭文字が途中にあっても）', () => {
    expect(lines(toCsv(['t'], [['a=b'], ['メール @ 3時'], ['気になる-1']]))).toEqual([
      't',
      'a=b',
      'メール @ 3時',
      '気になる-1',
    ])
  })
})

describe('parseCsv', () => {
  it("'=1+1 は =1+1 に戻す（toCsv との往復）", () => {
    expect(parseCsv("x\r\n'=1+1\r\n")).toEqual([['x'], ['=1+1']])
    expect(parseCsv("x\r\n'+1\r\n'-1\r\n'@x\r\n")).toEqual([['x'], ['+1'], ['-1'], ['@x']])
  })

  it("'abc のように次が数式の先頭文字でないものはそのまま", () => {
    expect(parseCsv("x\r\n'abc\r\n")).toEqual([['x'], ["'abc"]])
    expect(parseCsv("x\r\n'\r\n")).toEqual([['x'], ["'"]])
  })

  it('引用符の中の改行・カンマ・二重引用符を扱える', () => {
    const csv = '"a,b","1行目\n2行目","彼は ""やあ"" と言った"\r\n'
    expect(parseCsv(csv)).toEqual([['a,b', '1行目\n2行目', '彼は "やあ" と言った']])
  })

  it('引用符の中で保護された値も戻す', () => {
    expect(parseCsv('"\'=SUM(A1:A2)"\r\n')).toEqual([['=SUM(A1:A2)']])
  })

  it('BOM を外し、空行を落とす', () => {
    expect(parseCsv(`${BOM}a,b\r\n\r\n1,2\r\n,\r\n`)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('往復しても値が変わらない', () => {
    const rows = [
      ['=1+1', 'a"b', '改行\nあり'],
      ['-3', '@here', 'ふつう'],
    ]
    const csv = toCsv(['x', 'y', 'z'], rows)
    expect(parseCsv(csv)).toEqual([['x', 'y', 'z'], ...rows])
  })
})

describe('parseCsvObjects', () => {
  it('ヘッダーをキーにする（値は trim される）', () => {
    expect(parseCsvObjects('title, due\r\n やること , 2026-09-01\r\n')).toEqual([
      { title: 'やること', due: '2026-09-01' },
    ])
  })

  it('ヘッダーだけなら空', () => {
    expect(parseCsvObjects('title\r\n')).toEqual([])
  })
})

describe('日付はボードの暦（Asia/Tokyo）で読み書きする', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('書き出しは JST の壁時計で出す', () => {
    // 2026-09-01T01:00Z = JST 10:00
    expect(boardDateTimeText('2026-09-01T01:00:00.000Z')).toBe('2026-09-01 10:00')
    // 日付が変わる境目
    expect(boardDateTimeText('2026-08-31T15:00:00.000Z')).toBe('2026-09-01 00:00')
  })

  it('取り込みは JST として読む', () => {
    expect(parseFlexibleDate('2026-09-01 10:00')?.toISOString()).toBe('2026-09-01T01:00:00.000Z')
    expect(parseFlexibleDate('2026/9/1')?.toISOString()).toBe('2026-08-31T15:00:00.000Z')
  })

  it('実行環境のタイムゾーンを変えても結果が変わらない', () => {
    // ここだけ date-fns の format と new Date(y, m, d) を使っていて、
    // 海外から書き出す・取り込むとボードの暦とずれていた
    vi.stubEnv('TZ', 'America/New_York')
    expect(new Date('2026-09-01T00:00:00Z').getTimezoneOffset()).not.toBe(-540)

    expect(boardDateTimeText('2026-09-01T01:00:00.000Z')).toBe('2026-09-01 10:00')
    expect(parseFlexibleDate('2026-09-01 10:00')?.toISOString()).toBe('2026-09-01T01:00:00.000Z')
  })

  it('往復しても同じ時刻に戻る', () => {
    const iso = '2026-12-31T15:30:00.000Z'
    expect(parseFlexibleDate(boardDateTimeText(iso))?.toISOString()).toBe(iso)
  })
})

describe('looksMojibake（取り込む前に化けを見つける）', () => {
  it('置換文字が混ざっていたら true', () => {
    expect(looksMojibake('タイトル,開始')).toBe(false)
    expect(looksMojibake('\uFFFD\uFFFD,start')).toBe(true)
  })

  it('絵文字は化けではない', () => {
    expect(looksMojibake('🎉 打ち上げ,2026-09-01 10:00')).toBe(false)
  })
})

describe('絵文字（サロゲートペア）', () => {
  it('書き出して読み戻しても壊れない', () => {
    const title = '🎉🎊 打ち上げ'
    const csv = toCsv(['タイトル', 'メモ'], [[title, '🍻, 乾杯']])
    const rows = parseCsvObjects(csv)

    expect(rows[0]['タイトル']).toBe(title)
    // カンマを含む絵文字混じりの値も、引用のはがし方を間違えない
    expect(rows[0]['メモ']).toBe('🍻, 乾杯')
  })
})

describe('繰り返しの曜日を CSV に載せる', () => {
  /*
   * 載せないと、書き出して取り込み直しただけで「毎週 火・木」が
   * 「毎週（開始日の曜日）」に化ける。予定が黙って変わるのがいちばん困る。
   */
  it('曜日の並びを書き出す', () => {
    expect(formatWeekdays([2, 4])).toBe('火・木')
    expect(formatWeekdays([0, 6])).toBe('日・土')
    expect(formatWeekdays([])).toBe('')
  })

  it('曜日の並びを読む（中黒・読点・カンマ・空白）', () => {
    expect(parseWeekdays('火・木')).toEqual([2, 4])
    expect(parseWeekdays('火,木')).toEqual([2, 4])
    expect(parseWeekdays('火、木')).toEqual([2, 4])
    expect(parseWeekdays('火 木')).toEqual([2, 4])
  })

  it('「火曜」「火曜日」や英語表記も読む', () => {
    expect(parseWeekdays('火曜・木曜日')).toEqual([2, 4])
    expect(parseWeekdays('TU,TH')).toEqual([2, 4])
    expect(parseWeekdays('tu th')).toEqual([2, 4])
  })

  it('読めない語は落とす', () => {
    expect(parseWeekdays('火・ほげ・木')).toEqual([2, 4])
    expect(parseWeekdays('')).toEqual([])
    expect(parseWeekdays(undefined)).toEqual([])
  })

  it('書き出して読み戻すと元に戻る', () => {
    for (const days of [[2, 4], [0], [1, 2, 3, 4, 5], []]) {
      expect(parseWeekdays(formatWeekdays(days))).toEqual(days)
    }
  })

  it('第 n 週を読む', () => {
    expect(parseWeekOrdinal('第2')).toBe(2)
    expect(parseWeekOrdinal('2')).toBe(2)
    expect(parseWeekOrdinal('第5')).toBe(5)
    expect(parseWeekOrdinal('最終')).toBe(-1)
    expect(parseWeekOrdinal('last')).toBe(-1)
    expect(parseWeekOrdinal('-1')).toBe(-1)
  })

  it('範囲の外と読めない値は null', () => {
    expect(parseWeekOrdinal('第0')).toBeNull()
    expect(parseWeekOrdinal('第6')).toBeNull()
    expect(parseWeekOrdinal('-2')).toBeNull()
    expect(parseWeekOrdinal('ほげ')).toBeNull()
    expect(parseWeekOrdinal('')).toBeNull()
    expect(parseWeekOrdinal(undefined)).toBeNull()
  })
})
