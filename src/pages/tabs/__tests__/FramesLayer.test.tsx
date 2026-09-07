/*
 * フレーム（囲み）のドラッグとサイズ変更。
 *
 * 付箋・画像・添付と同じ約束——「ドラッグ中に onLocalChange で書き換えたら、
 * 確定前に元の値へ戻す」——をここでも守る。破ると Ctrl+Z が黙って効かなくなる。
 *
 * 移動は付箋と同じく差分だけを親に渡す。フレームを動かすと中の付箋も
 * 一緒に動くので、まとめて動かせるのは親だけ。
 */

import { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import FramesLayer from '../FramesLayer'
import type { Frame } from '../../../lib/types'

function makeFrame(over: Partial<Frame> = {}): Frame {
  return {
    id: 'frame-1',
    room_id: 'room-1',
    x: 100,
    y: 100,
    w: 600,
    h: 400,
    title: '午前の案',
    color: 'slate',
    z: 1,
    author_id: 'user-1',
    author_name: 'ひとり目',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

type Call =
  | { kind: 'local'; w: number; h: number }
  | { kind: 'commit'; patch: Partial<Frame> }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'end' }

function Harness({
  calls,
  zoom = 1,
  canEdit = true,
}: {
  calls: Call[]
  zoom?: number
  canEdit?: boolean
}) {
  const [frame, setFrame] = useState(makeFrame())
  return (
    <FramesLayer
      frames={[frame]}
      interactive
      canEdit={canEdit}
      zoom={zoom}
      selectedId={null}
      onSelect={() => {}}
      onDragMove={(_frame, dx, dy) => calls.push({ kind: 'move', dx, dy })}
      onDragEnd={() => calls.push({ kind: 'end' })}
      onLocalChange={(next) => {
        calls.push({ kind: 'local', w: next.w, h: next.h })
        setFrame(next)
      }}
      onCommit={(_id, patch) => calls.push({ kind: 'commit', patch })}
      onDelete={() => {}}
      onOpenMenu={() => {}}
    />
  )
}

function frameEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-ctx-kind="frame"]')
  if (!el) throw new Error('フレームが描かれていない')
  return el as HTMLElement
}

function resizeHandle(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[title="サイズ変更"]')
  if (!el) throw new Error('サイズ変更のつまみが無い')
  return el as HTMLElement
}

function drag(el: HTMLElement, from: [number, number], to: [number, number][]) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerType: 'mouse',
    pointerId: 1,
    clientX: from[0],
    clientY: from[1],
  })
  for (const [x, y] of to) {
    fireEvent.pointerMove(el, { pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y })
  }
  const last = to[to.length - 1] ?? from
  fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 1, clientX: last[0], clientY: last[1] })
}

describe('フレームの移動', () => {
  it('動かしているあいだは差分だけを渡す（中の付箋は親がまとめて動かす）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(frameEl(container), [10, 10], [[40, 30]])

    expect(calls).toEqual([{ kind: 'move', dx: 30, dy: 20 }, { kind: 'end' }])
  })

  it('拡大しているときは、画面の移動量をズームで割る', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} zoom={2} />)

    drag(frameEl(container), [0, 0], [[40, 20]])

    expect(calls[0]).toEqual({ kind: 'move', dx: 20, dy: 10 })
  })
})

describe('フレームのサイズ変更', () => {
  it('確定の直前に、いったん元の大きさへ戻す（Ctrl+Z の戻り先を残すため）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(resizeHandle(container), [0, 0], [[50, 40]])

    const commitAt = calls.findIndex((c) => c.kind === 'commit')
    expect(commitAt).toBeGreaterThan(0)
    expect(calls[commitAt - 1]).toEqual({ kind: 'local', w: 600, h: 400 })
    expect(calls[commitAt]).toEqual({ kind: 'commit', patch: { w: 650, h: 440 } })
  })

  it('小さくしすぎない（下限より小さくならない）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(resizeHandle(container), [0, 0], [[-1000, -1000]])

    expect(calls.find((c) => c.kind === 'commit')).toEqual({
      kind: 'commit',
      patch: { w: 160, h: 160 },
    })
  })

  it('大きさが変わらなければ確定しない', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(resizeHandle(container), [0, 0], [])

    expect(calls.some((c) => c.kind === 'commit')).toBe(false)
  })

  it('「閲覧のみ」の人には、つまみ自体が出ない', () => {
    const { container } = render(<Harness calls={[]} canEdit={false} />)
    expect(container.querySelector('[title="サイズ変更"]')).toBeNull()
  })
})
