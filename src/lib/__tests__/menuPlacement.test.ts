import { describe, expect, it } from 'vitest'
import { menuAnchor, placeMenu } from '../menuPlacement'

const VIEW = { w: 1000, h: 800 }
const MENU = { w: 220, h: 300 }

describe('placeMenu（コンテキストメニューの配置）', () => {
  it('収まるならクリック位置にそのまま置く', () => {
    expect(placeMenu({ x: 100, y: 100 }, MENU, VIEW)).toEqual({
      left: 100,
      top: 100,
      maxHeight: 784,
    })
  })

  it('右にはみ出すならクリック位置の左へ折り返す', () => {
    // 900 + 220 = 1120 > 1000 なので 900 - 220 = 680
    expect(placeMenu({ x: 900, y: 100 }, MENU, VIEW).left).toBe(680)
  })

  it('下にはみ出すならクリック位置の上へ折り返す', () => {
    // 700 + 300 = 1000 > 800 なので 700 - 300 = 400
    expect(placeMenu({ x: 100, y: 700 }, MENU, VIEW).top).toBe(400)
  })

  it('右下の隅では両方向に折り返す', () => {
    expect(placeMenu({ x: 980, y: 790 }, MENU, VIEW)).toMatchObject({
      left: 760,
      top: 490,
    })
  })

  it('gutter のぶんは必ず画面の内側に入れる', () => {
    // 左上の隅ぎりぎりでクリックしても、余白より外へは出さない
    expect(placeMenu({ x: 0, y: 0 }, MENU, VIEW)).toMatchObject({ left: 8, top: 8 })
    expect(placeMenu({ x: 10, y: 10 }, MENU, VIEW)).toMatchObject({ left: 10, top: 10 })
    // 折り返した先（995 - 220 = 775）も右端の余白を割るので、内側へ押し込む
    expect(placeMenu({ x: 995, y: 5 }, MENU, VIEW).left).toBe(772)
  })

  it('gutter を変えられる', () => {
    expect(placeMenu({ x: 0, y: 0 }, MENU, VIEW, 20)).toMatchObject({ left: 20, top: 20 })
  })

  it('メニューが画面より大きくても座標が負にならない', () => {
    const huge = { w: 1200, h: 900 }
    const placement = placeMenu({ x: 500, y: 400 }, huge, VIEW)

    expect(placement.left).toBe(8)
    expect(placement.top).toBe(8)
    // 高さは画面に収まるぶんだけに切り詰める（メニュー側で内部スクロールさせる）
    expect(placement.maxHeight).toBe(784)
  })

  it('画面が極端に小さくても maxHeight が負にならない', () => {
    expect(placeMenu({ x: 0, y: 0 }, MENU, { w: 10, h: 10 }).maxHeight).toBe(0)
  })
})

describe('menuAnchor（メニューを出す位置）', () => {
  const RECT = { left: 400, bottom: 500 }

  it('カーソルの座標をそのまま使う', () => {
    expect(menuAnchor({ x: 123, y: 456 }, RECT, VIEW)).toEqual({ x: 123, y: 456 })
  })

  it('片方が 0 でも、もう片方に値があればカーソル扱い', () => {
    // 画面のいちばん上や左をクリックした場合。ここをキーボード扱いにすると
    // メニューが明後日の方向へ飛ぶ
    expect(menuAnchor({ x: 300, y: 0 }, RECT, VIEW)).toEqual({ x: 300, y: 0 })
    expect(menuAnchor({ x: 0, y: 300 }, RECT, VIEW)).toEqual({ x: 0, y: 300 })
  })

  it('座標が 0,0 のときだけ、フォーカス中の要素の左下に寄せる', () => {
    expect(menuAnchor({ x: 0, y: 0 }, RECT, VIEW)).toEqual({ x: 400, y: 500 })
  })

  it('フォーカスがどこにも無ければ画面の中央', () => {
    expect(menuAnchor({ x: 0, y: 0 }, null, VIEW)).toEqual({ x: 500, y: 400 })
  })

  it('カーソル位置にそのまま置ける（アンカーと配置を通しで確認）', () => {
    const anchor = menuAnchor({ x: 640, y: 320 }, RECT, VIEW)
    expect(placeMenu(anchor, MENU, VIEW)).toMatchObject({ left: 640, top: 320 })
  })
})
