import { describe, expect, it } from 'vitest'
import { anchorPoints, boundingBox, insideRect, type Rect } from '../boardGeometry'

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

describe('anchorPoints', () => {
  /*
   * 線は画面（ConnectorsLayer）と PNG の書き出し（boardExport）の両方が引く。
   * 計算がずれると「画面と書き出しで線の向きが違う」ことになるので、
   * ここで縁の当たり方そのものを固定しておく。
   */
  const box = (x: number, y: number) => ({ x, y, w: 100, h: 100 })

  it('真横に並ぶと、向かい合う辺の中点どうしをつなぐ', () => {
    // 中心 (50,50) と (250,50)。右辺 x=100 から左辺 x=200 へ
    expect(anchorPoints(box(0, 0), box(200, 0))).toEqual([100, 50, 200, 50])
  })

  it('真上下に並ぶと、上下の辺の中点どうしをつなぐ', () => {
    expect(anchorPoints(box(0, 200), box(0, 0))).toEqual([50, 200, 50, 100])
  })

  it('斜めなら、縦横で先に当たるほうの辺で止まる', () => {
    // 中心 (50,50) → (250,150)。dx=200 dy=100 なので横が先に当たる
    const [x1, y1, x2, y2] = anchorPoints(box(0, 0), box(200, 100))
    expect(x1).toBe(100)
    expect(y1).toBe(75)
    expect(x2).toBe(200)
    expect(y2).toBe(125)
  })

  it('重なって中心が同じなら、中心をそのまま返す（0 除算にしない）', () => {
    expect(anchorPoints(box(0, 0), box(0, 0))).toEqual([50, 50, 50, 50])
  })
})
