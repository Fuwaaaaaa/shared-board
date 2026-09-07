import { describe, expect, it } from 'vitest'
import { alignNotes, snapToGrid, type AlignTarget } from '../boardAlign'

/*
 * 「揃える」の結果。
 *
 * 送り幅を間違えても画面上は「なんとなく並ぶ」ので、見ただけでは気づけない。
 * とくに大きさのまちまちな付箋を横一列にしたときの重なりは、
 * 動かしてみるまで分からない。
 */

const GRID = 20

/** 付箋 1 枚。既定は 100×80 の正方形寄り */
function at(id: string, x: number, y: number, w = 100, h = 80): AlignTarget {
  return { id, x, y, w, h }
}

describe('snapToGrid', () => {
  it('いちばん近い格子点に寄せる', () => {
    expect(snapToGrid(0, GRID)).toBe(0)
    expect(snapToGrid(9, GRID)).toBe(0)
    expect(snapToGrid(11, GRID)).toBe(20)
    expect(snapToGrid(30, GRID)).toBe(40) // ちょうど半分は大きいほうへ
  })

  it('負の値でも同じ規則', () => {
    expect(snapToGrid(-9, GRID)).toBe(-0)
    expect(snapToGrid(-11, GRID)).toBe(-20)
  })
})

describe('alignNotes', () => {
  it('左揃え — いちばん左に合わせ、縦は動かさない', () => {
    const after = alignNotes([at('a', 100, 10), at('b', 40, 90), at('c', 70, 50)], 'left', GRID)
    expect(after).toEqual([
      { id: 'a', x: 40, y: 10 },
      { id: 'b', x: 40, y: 90 },
      { id: 'c', x: 40, y: 50 },
    ])
  })

  it('上揃え — いちばん上に合わせ、横は動かさない', () => {
    const after = alignNotes([at('a', 10, 100), at('b', 90, 40)], 'top', GRID)
    expect(after).toEqual([
      { id: 'a', x: 10, y: 40 },
      { id: 'b', x: 90, y: 40 },
    ])
  })

  it('横に並べる — もとの左右の順を保ち、幅ぶんだけ送る', () => {
    // 幅がまちまち。送り幅に幅を足し忘れると重なる
    const after = alignNotes(
      [at('right', 500, 300, 60, 80), at('left', 100, 200, 150, 80)],
      'row',
      GRID,
    )
    expect(after).toEqual([
      { id: 'left', x: 100, y: 200 },
      // 100 + 150（左の幅）+ 20（間隔）
      { id: 'right', x: 270, y: 200 },
    ])
  })

  it('横に並べる — 縦位置はいちばん左のものに揃う', () => {
    const after = alignNotes([at('a', 0, 500), at('b', 300, 10)], 'row', GRID)
    expect(after.every((p) => p.y === 500)).toBe(true)
  })

  it('縦に並べる — もとの上下の順を保ち、高さぶんだけ送る', () => {
    const after = alignNotes(
      [at('bottom', 300, 500, 100, 40), at('top', 200, 100, 100, 120)],
      'column',
      GRID,
    )
    expect(after).toEqual([
      { id: 'top', x: 200, y: 100 },
      // 100 + 120（上の高さ）+ 20（間隔）
      { id: 'bottom', x: 200, y: 240 },
    ])
  })

  it('グリッドに揃える — それぞれを近い格子点へ', () => {
    const after = alignNotes([at('a', 9, 11), at('b', 31, 49)], 'grid', GRID)
    expect(after).toEqual([
      { id: 'a', x: 0, y: 20 },
      { id: 'b', x: 40, y: 40 },
    ])
  })

  it('1 枚だけのときは、グリッド以外は何もしない', () => {
    const one = [at('a', 9, 11)]
    expect(alignNotes(one, 'left', GRID)).toEqual([])
    expect(alignNotes(one, 'row', GRID)).toEqual([])
    expect(alignNotes(one, 'grid', GRID)).toEqual([{ id: 'a', x: 0, y: 20 }])
  })

  it('渡した配列は並べ替えない（呼び出し側が before に使う）', () => {
    const targets = [at('b', 300, 0), at('a', 100, 0)]
    alignNotes(targets, 'row', GRID)
    expect(targets.map((t) => t.id)).toEqual(['b', 'a'])
  })
})
