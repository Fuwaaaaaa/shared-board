/*
 * 画像のドラッグ確定の作法を固定する。
 *
 * OVERVIEW.html「引き継ぐ人へ」に書いてある約束——
 * 「ドラッグ中に onLocalChange で書き換えたら、確定前に元の値へ戻す」——は、
 * 破っても画面上は正常に見え、Ctrl+Z が黙って効かなくなるだけなので気づけない。
 * ここで形にしておき、同じ形の AttachmentsLayer と並べて守る。
 */

import { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ImagesLayer from '../ImagesLayer'
import type { BoardImage } from '../../../lib/types'

function makeImage(over: Partial<BoardImage> = {}): BoardImage {
  return {
    id: 'img-1',
    room_id: 'room-1',
    storage_path: 'room-1/a.png',
    x: 100,
    y: 200,
    w: 300,
    h: 150,
    z: 1,
    deleted_at: null,
    author_id: 'user-1',
    author_name: 'ひとり目',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

type Call = { kind: 'local'; x: number; y: number } | { kind: 'commit'; patch: Partial<BoardImage> }

/** 親（WhiteboardTab）と同じく、onLocalChange をそのまま行に流し込む器 */
function Harness({ calls, zoom = 1 }: { calls: Call[]; zoom?: number }) {
  const [image, setImage] = useState(makeImage())
  return (
    <ImagesLayer
      images={[image]}
      urls={{}}
      interactive
      zoom={zoom}
      selectedId={null}
      onSelect={() => {}}
      onLocalChange={(next) => {
        calls.push({ kind: 'local', x: next.x, y: next.y })
        setImage(next)
      }}
      onCommit={(_id, patch) => calls.push({ kind: 'commit', patch })}
      onDelete={() => {}}
    />
  )
}

function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-ctx-kind="image"]')
  if (!el) throw new Error('画像が描かれていない')
  return el as HTMLElement
}

function drag(el: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerType: 'mouse',
    pointerId: 1,
    clientX: from[0],
    clientY: from[1],
  })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] })
}

describe('ImagesLayer のドラッグ', () => {
  it('動かしている間は onLocalChange で先に画面へ出す', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [0, 0], [40, 25])

    // 100+40, 200+25
    expect(calls[0]).toEqual({ kind: 'local', x: 140, y: 225 })
  })

  it('確定の直前に元の位置へ戻し、動いた先を onCommit に渡す', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [0, 0], [40, 25])

    const commitAt = calls.findIndex((c) => c.kind === 'commit')
    expect(commitAt).toBeGreaterThan(0)

    // commit の直前は「元の位置へ戻す」onLocalChange でなければならない。
    // ここが動いた先のままだと、親が積む取り消しの戻り先が動いた先になり、
    // Ctrl+Z を押しても何も起きないエントリになる
    expect(calls[commitAt - 1]).toEqual({ kind: 'local', x: 100, y: 200 })
    expect(calls[commitAt]).toEqual({ kind: 'commit', patch: { x: 140, y: 225 } })
  })

  it('掴んだだけで動かさなければ、確定しない', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [10, 10], [10, 10])

    expect(calls.some((c) => c.kind === 'commit')).toBe(false)
  })

  it('拡大率に応じて移動量を割る', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} zoom={2} />)

    drag(card(container), [0, 0], [40, 20])

    // 画面上の 40px は、2 倍に拡大していればボード上の 20px
    expect(calls[0]).toEqual({ kind: 'local', x: 120, y: 210 })
  })

  it('右ボタンでは掴まない（右クリックはメニュー側の担当）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    const el = card(container)
    fireEvent.pointerDown(el, {
      button: 2,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 40, clientY: 25 })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 40, clientY: 25 })

    expect(calls).toHaveLength(0)
  })
})
