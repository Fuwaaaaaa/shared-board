/*
 * 付箋のドラッグとサイズ変更の作法を固定する。
 *
 * ImagesLayer / AttachmentsLayer と同じ約束——「ドラッグ中に onLocalChange で
 * 書き換えたら、確定前に元の値へ戻す」——が、付箋のサイズ変更にも要る。
 * 破っても画面上は正常に見え、Ctrl+Z が黙って効かなくなるだけなので気づけない。
 *
 * 移動だけは約束が違う。選択した付箋をまとめて動かすので、レイヤーは
 * 差分（dx, dy）を親に渡すだけで、行の書き換えは親が行う。
 */

import { useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import NotesLayer from '../NotesLayer'
import type { NoteDragDelta } from '../NotesLayer'
import { ThemeProvider } from '../../../lib/theme'
import type { Note } from '../../../lib/types'

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    room_id: 'room-1',
    kind: 'sticky',
    x: 100,
    y: 200,
    w: 200,
    h: 160,
    color: 'yellow',
    text: '会場を押さえる',
    tags: [],
    z: 1,
    font_size: 0,
    deleted_at: null,
    author_id: 'user-1',
    author_name: 'ひとり目',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

type Call =
  | { kind: 'local'; w: number; h: number }
  | { kind: 'commit'; patch: Partial<Note> }
  | { kind: 'move'; delta: NoteDragDelta }
  | { kind: 'end' }

/** 親（WhiteboardTab）と同じく、onLocalChange をそのまま行に流し込む器 */
function Harness({
  calls,
  zoom = 1,
  canEdit = true,
}: {
  calls: Call[]
  zoom?: number
  canEdit?: boolean
}) {
  const [note, setNote] = useState(makeNote())
  // 付箋の色はテーマで変わるので、ここだけ ThemeProvider が要る
  return (
    <ThemeProvider>
      <NotesLayer
        notes={[note]}
        interactive
        canEdit={canEdit}
        zoom={zoom}
        selectedIds={[]}
        highlightId={null}
        voteCounts={{}}
        myVotes={new Set()}
        reactions={{}}
        connectFromId={null}
        editingByOthers={new Map()}
        commentCounts={{}}
        linkCounts={{}}
        onToggleReaction={() => {}}
        onSelect={() => {}}
        onDragMove={(delta) => calls.push({ kind: 'move', delta })}
        onDragEnd={() => calls.push({ kind: 'end' })}
        onLocalChange={(next) => {
          calls.push({ kind: 'local', w: next.w, h: next.h })
          setNote(next)
        }}
        onCommit={(_id, patch) => calls.push({ kind: 'commit', patch })}
        onDelete={() => {}}
        onOpenComments={() => {}}
        onOpenMenu={() => {}}
        onToggleVote={() => {}}
        onEditingChange={() => {}}
        onConvert={() => {}}
        onOpenLink={() => {}}
      />
    </ThemeProvider>
  )
}

function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-ctx-kind="note"]')
  if (!el) throw new Error('付箋が描かれていない')
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

describe('付箋の移動', () => {
  it('動かしているあいだは差分だけを渡し、離したら知らせる', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(card(container), [10, 10], [
      [30, 15],
      [50, 35],
    ])

    // 行そのものは親がまとめて動かすので、ここでは書き換えない
    expect(calls.filter((c) => c.kind === 'local')).toEqual([])
    expect(calls).toEqual([
      { kind: 'move', delta: { dx: 20, dy: 5 } },
      { kind: 'move', delta: { dx: 40, dy: 25 } },
      { kind: 'end' },
    ])
  })

  it('拡大しているときは、画面の移動量をズームで割る', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} zoom={2} />)

    drag(card(container), [0, 0], [[40, 20]])

    expect(calls[0]).toEqual({ kind: 'move', delta: { dx: 20, dy: 10 } })
  })

  it('右ボタンでは掴まない（メニューを開いている間に動かないように）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    fireEvent.pointerDown(card(container), {
      button: 2,
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(card(container), { pointerType: 'mouse', pointerId: 1, clientX: 60, clientY: 60 })

    expect(calls).toEqual([])
  })

  it('「閲覧のみ」の人は動かせない', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} canEdit={false} />)

    drag(card(container), [10, 10], [[60, 60]])

    expect(calls).toEqual([])
  })
})

describe('付箋のサイズ変更', () => {
  it('確定の直前に、いったん元の大きさへ戻す（Ctrl+Z の戻り先を残すため）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(resizeHandle(container), [0, 0], [[40, 30]])

    const commitAt = calls.findIndex((c) => c.kind === 'commit')
    expect(commitAt).toBeGreaterThan(0)
    // 1 つ手前が「元の 200×160 に戻す」でなければ、取り消しても何も起きなくなる
    expect(calls[commitAt - 1]).toEqual({ kind: 'local', w: 200, h: 160 })
    expect(calls[commitAt]).toEqual({ kind: 'commit', patch: { w: 240, h: 190 } })
  })

  it('小さくしすぎない（下限より小さくならない）', () => {
    const calls: Call[] = []
    const { container } = render(<Harness calls={calls} />)

    drag(resizeHandle(container), [0, 0], [[-500, -500]])

    const commit = calls.find((c) => c.kind === 'commit')
    expect(commit).toEqual({ kind: 'commit', patch: { w: 120, h: 60 } })
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

describe('付箋の描画', () => {
  it('読み上げ用の名前に、本文と書いた人が入る', () => {
    const { container } = render(<Harness calls={[]} />)
    expect(card(container).getAttribute('aria-label')).toBe('付箋: 会場を押さえる（ひとり目）')
  })

  it('右クリックの対象を決めるための目印が付いている', () => {
    // 親は closest('[data-ctx-kind]') でメニューの対象を決める
    const { container } = render(<Harness calls={[]} />)
    expect(card(container).getAttribute('data-ctx-id')).toBe('note-1')
  })
})

describe('文字サイズの長押し', () => {
  it('押しっぱなしにすると、文字サイズの調整に切り替わる', () => {
    vi.useFakeTimers()
    try {
      const calls: Call[] = []
      const { container } = render(<Harness calls={calls} />)
      const el = card(container)

      fireEvent.pointerDown(el, {
        button: 0,
        pointerType: 'mouse',
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      })
      vi.advanceTimersByTime(1000)
      fireEvent.pointerMove(el, { pointerType: 'mouse', pointerId: 1, clientX: 10, clientY: 60 })
      fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 1, clientX: 10, clientY: 60 })

      // 移動としては扱われない
      expect(calls.some((c) => c.kind === 'move')).toBe(false)
      // ここでも「元に戻してから確定」を守る
      const commitAt = calls.findIndex((c) => c.kind === 'commit')
      expect(commitAt).toBeGreaterThan(0)
      expect(calls[commitAt - 1]).toMatchObject({ kind: 'local' })
      expect(calls[commitAt]).toMatchObject({ kind: 'commit' })
    } finally {
      vi.useRealTimers()
    }
  })
})
