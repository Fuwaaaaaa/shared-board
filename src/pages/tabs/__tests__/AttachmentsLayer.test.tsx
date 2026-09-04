/*
 * 添付（PDF などのカード）のドラッグ確定。
 *
 * ここは長らく取り消しが積まれていなかった箇所で、原因は
 * 「掴んだ時点の位置を覚えていない」ことだった。ImagesLayer と同じ形に
 * 揃えたので、同じ形のテストで並べて守る。
 */

import { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AttachmentsLayer from '../AttachmentsLayer'
import type { Attachment } from '../../../lib/types'

function makeAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'file-1',
    room_id: 'room-1',
    storage_path: 'room-1/a.pdf',
    filename: '合宿のしおり.pdf',
    mime: 'application/pdf',
    size: 1024 * 512,
    x: 100,
    y: 200,
    z: 1,
    author_id: 'user-1',
    author_name: 'ひとり目',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

type Call = { kind: 'local'; x: number; y: number } | { kind: 'commit'; patch: Partial<Attachment> }

/** 親（WhiteboardTab）と同じく、onLocalChange をそのまま行に流し込む器 */
function Harness({ calls, zoom = 1 }: { calls: Call[]; zoom?: number }) {
  const [attachment, setAttachment] = useState(makeAttachment())
  return (
    <AttachmentsLayer
      attachments={[attachment]}
      urls={{}}
      interactive
      canEdit
      zoom={zoom}
      selectedId={null}
      onSelect={() => {}}
      onLocalChange={(next) => {
        calls.push({ kind: 'local', x: next.x, y: next.y })
        setAttachment(next)
      }}
      onCommit={(_id, patch) => calls.push({ kind: 'commit', patch })}
      onDelete={() => {}}
    />
  )
}

function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-ctx-kind="attachment"]')
  if (!el) throw new Error('添付カードが描かれていない')
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

describe('AttachmentsLayer のドラッグ', () => {
  it('動かしている間は onLocalChange で先に画面へ出す', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [0, 0], [40, 25])

    expect(calls[0]).toEqual({ kind: 'local', x: 140, y: 225 })
  })

  it('確定の直前に元の位置へ戻し、動いた先を onCommit に渡す', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [0, 0], [40, 25])

    const commitAt = calls.findIndex((c) => c.kind === 'commit')
    expect(commitAt).toBeGreaterThan(0)

    // ここが動いた先のままだと、親が積む取り消しの戻り先が動いた先になり、
    // Ctrl+Z を押しても何も起きないエントリになる
    expect(calls[commitAt - 1]).toEqual({ kind: 'local', x: 100, y: 200 })
    expect(calls[commitAt]).toEqual({ kind: 'commit', patch: { x: 140, y: 225 } })
  })

  it('何度動かしても、戻り先は掴んだ時点の位置のまま', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    const el = card(container)
    fireEvent.pointerDown(el, {
      button: 0,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 30, clientY: 5 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 40, clientY: 25 })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 40, clientY: 25 })

    const commitAt = calls.findIndex((c) => c.kind === 'commit')
    expect(calls[commitAt - 1]).toEqual({ kind: 'local', x: 100, y: 200 })
    expect(calls[commitAt]).toEqual({ kind: 'commit', patch: { x: 140, y: 225 } })
  })

  it('掴んだだけで動かさなければ、確定しない', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [10, 10], [10, 10])

    expect(calls.some((c) => c.kind === 'commit')).toBe(false)
  })

  it('ボードの左上より外へは出さない', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [0, 0], [-500, -500])

    expect(calls[0]).toEqual({ kind: 'local', x: 0, y: 0 })
  })

  it('拡大率に応じて移動量を割る', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} zoom={2} />)

    drag(card(container), [0, 0], [40, 20])

    expect(calls[0]).toEqual({ kind: 'local', x: 120, y: 210 })
  })

  it('閲覧のみの人は動かせない', () => {
    const calls: Call[] = []
    function ReadOnly() {
      const [attachment, setAttachment] = useState(makeAttachment())
      return (
        <AttachmentsLayer
          attachments={[attachment]}
          urls={{}}
          interactive
          canEdit={false}
          zoom={1}
          selectedId={null}
          onSelect={() => {}}
          onLocalChange={(next) => {
            calls.push({ kind: 'local', x: next.x, y: next.y })
            setAttachment(next)
          }}
          onCommit={(_id, patch) => calls.push({ kind: 'commit', patch })}
          onDelete={() => {}}
        />
      )
    }
    const { container } = render(<ReadOnly />)

    drag(card(container), [0, 0], [40, 25])

    expect(calls).toHaveLength(0)
  })
})
