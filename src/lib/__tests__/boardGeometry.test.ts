import { describe, expect, it } from 'vitest'
import { boundingBox, insideRect, type Rect } from '../boardGeometry'

const FRAME: Rect = { x: 100, y: 100, w: 200, h: 200 }

function note(x: number, y: number, w = 20, h = 20): Rect & { id: string } {
  return { id: `${x},${y}`, x, y, w, h }
}

describe('insideRect（フレームの中の付箋）', () => {
  it('中心が入っていれば中', () => {
    const inside = insideRect([note(150, 150)], FRAME)
    expect(inside).toHaveLength(1)
  })

  it('縁にかかっていても中心が外なら外', () => {
    // 右端をまたぐが、中心（305）はフレームの外
    expect(insideRect([note(295, 150)], FRAME)).toHaveLength(0)
  })

  it('中心が境界ちょうどなら中', () => {
    // 中心が x=100（左端）ちょうど
    expect(insideRect([note(90, 150)], FRAME)).toHaveLength(1)
    // 中心が x=300（右端）ちょうど
    expect(insideRect([note(290, 150)], FRAME)).toHaveLength(1)
  })

  it('完全に外なら選ばない', () => {
    expect(insideRect([note(0, 0), note(500, 500)], FRAME)).toHaveLength(0)
  })

  it('元の要素をそのまま返す（id などを落とさない）', () => {
    expect(insideRect([note(150, 150)], FRAME)[0].id).toBe('150,150')
  })

  it('空なら空', () => {
    expect(insideRect([], FRAME)).toEqual([])
  })
})

describe('boundingBox', () => {
  it('1 件ならそれ自身', () => {
    expect(boundingBox([{ x: 10, y: 20, w: 30, h: 40 }])).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  it('複数件をまとめて囲む', () => {
    expect(
      boundingBox([
        { x: 10, y: 20, w: 30, h: 40 },
        { x: 100, y: 5, w: 10, h: 10 },
      ]),
    ).toEqual({ x: 10, y: 5, w: 100, h: 55 })
  })

  it('余白を辺ごとに足せる', () => {
    expect(
      boundingBox([{ x: 100, y: 100, w: 50, h: 50 }], {
        top: 72,
        right: 40,
        bottom: 40,
        left: 40,
      }),
    ).toEqual({ x: 60, y: 28, w: 130, h: 162 })
  })

  it('左上がボードの外に出るときは 0 で止め、右下の余白は削らない', () => {
    const box = boundingBox([{ x: 10, y: 10, w: 50, h: 50 }], {
      top: 72,
      right: 40,
      bottom: 40,
      left: 40,
    })
    expect(box).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    // 右下は元の位置 + 余白のまま
    expect(box!.x + box!.w).toBe(10 + 50 + 40)
    expect(box!.y + box!.h).toBe(10 + 50 + 40)
  })

  it('空なら null', () => {
    expect(boundingBox([])).toBeNull()
  })
})
