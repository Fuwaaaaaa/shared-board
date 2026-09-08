import { describe, expect, it } from 'vitest'
import { BOARD_TEMPLATES } from '../templates'
import { NOTE_COLORS } from '../types'

/*
 * ボードの雛形（KPT・カンバンなど）。
 *
 * 中身はほぼデータなので、見るのは「置いた瞬間に破綻しないか」だけ。
 * 列を 1 つ足したときに、画面の外へはみ出したり、色の名前を打ち間違えたり——
 * どれも置いてみるまで気づけない種類の間違い。
 */

/** WhiteboardTab の BOARD_W / BOARD_H と揃える。ここを超えると画面の外に出る */
const BOARD_W = 2000
const BOARD_H = 1200

/** 付箋の色。ここに無い色は既定色に落ちて、意図が消える */
const KNOWN_COLORS = Object.keys(NOTE_COLORS)

describe('BOARD_TEMPLATES', () => {
  it('雛形の key は重複しない（選んだものと違うものが置かれないように）', () => {
    const keys = BOARD_TEMPLATES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('「白紙」があり、それだけが空', () => {
    const blank = BOARD_TEMPLATES.find((t) => t.key === 'blank')
    expect(blank?.items).toEqual([])
    for (const template of BOARD_TEMPLATES.filter((t) => t.key !== 'blank')) {
      expect(template.items.length).toBeGreaterThan(0)
    }
  })

  it('名前と説明が入っている（選ぶ画面に出る）', () => {
    for (const template of BOARD_TEMPLATES) {
      expect(template.name.trim()).not.toBe('')
      expect(template.description.trim()).not.toBe('')
    }
  })

  for (const template of BOARD_TEMPLATES) {
    it(`${template.name} — 置いたものが全部ボードの中に収まる`, () => {
      for (const item of template.items) {
        expect(item.x).toBeGreaterThanOrEqual(0)
        expect(item.y).toBeGreaterThanOrEqual(0)
        expect(item.x + item.w).toBeLessThanOrEqual(BOARD_W)
        expect(item.y + item.h).toBeLessThanOrEqual(BOARD_H)
      }
    })

    it(`${template.name} — 知っている色だけを使う`, () => {
      for (const item of template.items) {
        expect(KNOWN_COLORS).toContain(item.color)
      }
    })
  }
})
