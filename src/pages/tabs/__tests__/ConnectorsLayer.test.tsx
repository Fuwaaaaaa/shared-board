/*
 * 付箋をつなぐ線の、端点の位置。
 *
 * 線は「付箋の中心から相手の中心へ向かって、矩形の縁で止める」で引いている。
 * 縦横どちらの縁で止めるかを取り違えても線は引かれてしまい、
 * 付箋の内側や外側で少しずれるだけなので、見ただけでは気づけない。
 */

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ConnectorsLayer from '../ConnectorsLayer'
import type { Connector, Note } from '../../../lib/types'

function makeNote(id: string, x: number, y: number, w = 200, h = 100): Note {
  return {
    id,
    room_id: 'room-1',
    kind: 'sticky',
    x,
    y,
    w,
    h,
    color: 'yellow',
    text: id,
    tags: [],
    z: 1,
    font_size: 0,
    deleted_at: null,
    author_id: 'user-1',
    author_name: 'ひとり目',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  }
}

function makeConnector(over: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-1',
    room_id: 'room-1',
    from_note_id: 'a',
    to_note_id: 'b',
    style: 'arrow',
    color: '#334155',
    label: '',
    author_id: 'user-1',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function renderLayer(
  notes: Note[],
  connectors: Connector[],
  interactive = true,
  onSelect: (id: string | null) => void = () => {},
) {
  return render(
    <ConnectorsLayer
      width={2000}
      height={1200}
      notes={notes}
      connectors={connectors}
      selectedId={null}
      interactive={interactive}
      onSelect={onSelect}
    />,
  )
}

/** 掴みやすくするために重ねてある、透明な太い線 */
function hitLine(container: HTMLElement): SVGLineElement | null {
  return container.querySelector('[data-ctx-kind="connector"]')
}

function endpoints(container: HTMLElement) {
  const line = hitLine(container)
  if (!line) throw new Error('線が引かれていない')
  return {
    x1: Number(line.getAttribute('x1')),
    y1: Number(line.getAttribute('y1')),
    x2: Number(line.getAttribute('x2')),
    y2: Number(line.getAttribute('y2')),
  }
}

describe('つなぐ線の端点', () => {
  it('横に並んでいるときは、向かい合う縦の縁で止まる', () => {
    // a は (0,0)-(200,100)、b は (400,0)-(600,100)。高さは同じ
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 400, 0)],
      [makeConnector()],
    )
    expect(endpoints(container)).toEqual({ x1: 200, y1: 50, x2: 400, y2: 50 })
  })

  it('縦に並んでいるときは、上下の縁で止まる', () => {
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 0, 300)],
      [makeConnector()],
    )
    expect(endpoints(container)).toEqual({ x1: 100, y1: 100, x2: 100, y2: 300 })
  })

  it('斜めのときは、先に当たるほうの縁で止まる', () => {
    // 中心どうしは (100,50) と (400,350)。縦の伸びのほうが速く縁に届く
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 300, 300)],
      [makeConnector()],
    )
    expect(endpoints(container)).toEqual({ x1: 150, y1: 100, x2: 350, y2: 300 })
  })

  it('相手の付箋が消えていれば、線は引かない', () => {
    const { container } = renderLayer([makeNote('a', 0, 0)], [makeConnector()])
    expect(hitLine(container)).toBeNull()
  })
})

describe('つなぐ線を選ぶ', () => {
  it('掴みやすいように、見た目より太い透明な線が重ねてある', () => {
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 400, 0)],
      [makeConnector()],
    )
    const line = hitLine(container)
    expect(line?.getAttribute('stroke')).toBe('transparent')
    expect(Number(line?.getAttribute('stroke-width'))).toBeGreaterThan(8)
  })

  it('押すと選ばれる', () => {
    const picked: string[] = []
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 400, 0)],
      [makeConnector({ id: 'conn-9' })],
      true,
      (id) => {
        picked.push(String(id))
      },
    )

    fireEvent.pointerDown(hitLine(container)!, { button: 0, pointerType: 'mouse', pointerId: 1 })

    expect(picked).toEqual(['conn-9'])
  })

  it('右ボタンでは選ばない（メニュー側が決める）', () => {
    const picked: string[] = []
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 400, 0)],
      [makeConnector()],
      true,
      (id) => {
        picked.push(String(id))
      },
    )

    fireEvent.pointerDown(hitLine(container)!, { button: 2, pointerType: 'mouse', pointerId: 1 })

    expect(picked).toEqual([])
  })

  it('選べないとき（描画モードなど）は、掴む線を出さない', () => {
    const { container } = renderLayer(
      [makeNote('a', 0, 0), makeNote('b', 400, 0)],
      [makeConnector()],
      false,
    )
    expect(hitLine(container)).toBeNull()
  })
})
