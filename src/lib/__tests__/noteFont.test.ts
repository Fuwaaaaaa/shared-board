import { describe, expect, it } from 'vitest'
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  fontSizeFromDrag,
  noteFontSize,
} from '../noteFont'

describe('noteFontSize（保存値から実際の大きさを決める）', () => {
  it('0 は「まだ決めていない」。種類ごとの既定を使う', () => {
    // この機能より前に作られた付箋は font_size が 0 で入る。
    // 見た目が勝手に変わらないことが大事
    expect(noteFontSize('sticky', 0)).toBe(14)
    expect(noteFontSize('text', 0)).toBe(20)
  })

  it('未設定（undefined）でも既定に落ちる', () => {
    expect(noteFontSize('sticky', undefined)).toBe(14)
    expect(noteFontSize('text', undefined)).toBe(20)
  })

  it('決めてあればその値', () => {
    expect(noteFontSize('sticky', 32)).toBe(32)
    expect(noteFontSize('text', 11)).toBe(11)
  })

  it('範囲外の値は丸める', () => {
    expect(noteFontSize('sticky', 999)).toBe(MAX_FONT_SIZE)
    expect(noteFontSize('sticky', 1)).toBe(MIN_FONT_SIZE)
  })

  it('負の値は「未設定」と同じ扱い', () => {
    expect(noteFontSize('text', -5)).toBe(20)
  })
})

describe('fontSizeFromDrag（長押しドラッグ中の大きさ）', () => {
  it('上へ動かすと大きくなる', () => {
    expect(fontSizeFromDrag(20, -40)).toBe(30)
  })

  it('下へ動かすと小さくなる', () => {
    expect(fontSizeFromDrag(20, 40)).toBe(10)
  })

  it('動かさなければ変わらない', () => {
    expect(fontSizeFromDrag(20, 0)).toBe(20)
  })

  it('整数に丸める（1px 未満の揺れで再描画しない）', () => {
    expect(Number.isInteger(fontSizeFromDrag(20, -7))).toBe(true)
  })

  it('上下の限界を超えない', () => {
    expect(fontSizeFromDrag(20, -10000)).toBe(MAX_FONT_SIZE)
    expect(fontSizeFromDrag(20, 10000)).toBe(MIN_FONT_SIZE)
  })

  it('既定から上限まで 200px ほどで届く（手首の動きに収まる）', () => {
    expect(fontSizeFromDrag(14, -200)).toBe(MAX_FONT_SIZE)
  })
})

describe('clampFontSize', () => {
  it('壊れた数値でも NaN を返さない', () => {
    expect(clampFontSize(NaN)).toBe(14)
    expect(clampFontSize(Infinity)).toBe(14)
  })

  it('小数は丸める', () => {
    expect(clampFontSize(18.6)).toBe(19)
  })
})
