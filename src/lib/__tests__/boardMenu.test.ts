import { describe, expect, it, vi } from 'vitest'
import { buildBoardMenu, type BoardMenuActions, type BoardMenuState } from '../boardMenu'
import { itemsOf, type MenuItem, type MenuNode } from '../menuTypes'
import { SHORTCUTS } from '../shortcuts'
import type { Attachment, BoardImage, Connector, Frame, Note } from '../types'

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    room_id: 'room',
    kind: 'sticky',
    x: 100,
    y: 100,
    w: 220,
    h: 170,
    color: 'yellow',
    text: 'メモ',
    tags: [],
    z: 1,
    font_size: 0,
    deleted_at: null,
    author_id: 'me',
    author_name: 'わたし',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const IMAGE: BoardImage = {
  id: 'image-1',
  room_id: 'room',
  storage_path: 'p.png',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 0,
  deleted_at: null,
  author_id: 'me',
  author_name: 'わたし',
  created_at: '2026-01-01T00:00:00.000Z',
}

const FRAME: Frame = {
  id: 'frame-1',
  room_id: 'room',
  x: 0,
  y: 0,
  w: 600,
  h: 400,
  title: '',
  color: 'slate',
  z: 0,
  author_id: 'me',
  author_name: 'わたし',
  created_at: '2026-01-01T00:00:00.000Z',
}

const CONNECTOR: Connector = {
  id: 'connector-1',
  room_id: 'room',
  from_note_id: 'note-1',
  to_note_id: 'note-2',
  style: 'arrow',
  color: '#000',
  label: '',
  author_id: 'me',
  created_at: '2026-01-01T00:00:00.000Z',
}

const ATTACHMENT = {
  id: 'file-1',
  room_id: 'room',
  storage_path: 'doc.pdf',
  filename: 'doc.pdf',
  mime: 'application/pdf',
  size: 1000,
  x: 0,
  y: 0,
  z: 0,
  deleted_at: null,
  author_id: 'me',
  author_name: 'わたし',
  created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Attachment

function state(over: Partial<BoardMenuState> = {}): BoardMenuState {
  return {
    target: { kind: 'canvas', id: null },
    bx: 500,
    by: 300,
    canEdit: true,
    notes: [note()],
    images: [IMAGE],
    frames: [FRAME],
    connectors: [CONNECTOR],
    attachments: [ATTACHMENT],
    fileUrls: { 'doc.pdf': 'https://example.test/doc.pdf' },
    selectedIds: [],
    selectedNotes: [],
    hasOtherSelection: false,
    clipboardCount: 0,
    hasClipboardStyle: false,
    busy: false,
    canCopyImage: true,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    ...over,
  }
}

function actions(): BoardMenuActions {
  return {
    createNote: vi.fn(),
    createFrame: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    openTemplates: vi.fn(),
    openBulk: vi.fn(),
    fitToScreen: vi.fn(),
    copyPng: vi.fn(),
    exportPng: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    copyNotes: vi.fn(),
    deleteNotes: vi.fn(),
    duplicateNotes: vi.fn(),
    wrapInFrame: vi.fn(),
    copyStyle: vi.fn(),
    pasteStyle: vi.fn(),
    openComments: vi.fn(),
    convert: vi.fn(),
    align: vi.fn(),
    changeZ: vi.fn(),
    selectNotes: vi.fn(),
    deleteImage: vi.fn(),
    deleteFrame: vi.fn(),
    toggleConnectorStyle: vi.fn(),
    deleteConnector: vi.fn(),
    openUrl: vi.fn(),
    deleteAttachment: vi.fn(),
  }
}

function ids(nodes: MenuNode[]): string[] {
  return itemsOf(nodes).map((item) => item.id)
}

function find(nodes: MenuNode[], id: string): MenuItem | undefined {
  return itemsOf(nodes).find((item) => item.id === id)
}

describe('buildBoardMenu — 不変条件', () => {
  const targets: BoardMenuState['target'][] = [
    { kind: 'canvas', id: null },
    { kind: 'note', id: 'note-1' },
    { kind: 'image', id: 'image-1' },
    { kind: 'frame', id: 'frame-1' },
    { kind: 'connector', id: 'connector-1' },
    { kind: 'attachment', id: 'file-1' },
  ]

  it('押せない項目には必ず理由がある', () => {
    for (const target of targets) {
      for (const canEdit of [true, false]) {
        for (const selected of [[], ['note-1']]) {
          const nodes = buildBoardMenu(
            state({ target, canEdit, selectedIds: selected, selectedNotes: selected.map(() => note()) }),
            actions(),
          )
          for (const item of itemsOf(nodes)) {
            if (item.disabled) {
              expect(item.disabledReason, `${target.kind} / ${item.id}`).toBeTruthy()
            }
          }
        }
      }
    }
  })

  it('項目の id が同じメニューの中で重複しない', () => {
    for (const target of targets) {
      const list = ids(buildBoardMenu(state({ target }), actions()))
      expect(new Set(list).size, target.kind).toBe(list.length)
    }
  })

  it('shortcut の表記は shortcuts.ts にあるものだけ', () => {
    const known = new Set(SHORTCUTS.map((s) => s.display))
    for (const target of targets) {
      for (const item of itemsOf(buildBoardMenu(state({ target }), actions()))) {
        if (item.shortcut) expect(known, `${target.kind} / ${item.id}`).toContain(item.shortcut)
      }
    }
  })

  it('対象が見つからなければ空（他の人に消されたとき）', () => {
    expect(buildBoardMenu(state({ target: { kind: 'note', id: '無い' } }), actions())).toEqual([])
    expect(buildBoardMenu(state({ target: { kind: 'image', id: '無い' } }), actions())).toEqual([])
    expect(buildBoardMenu(state({ target: { kind: 'frame', id: '無い' } }), actions())).toEqual([])
    expect(buildBoardMenu(state({ target: { kind: 'connector', id: '無い' } }), actions())).toEqual(
      [],
    )
  })

  it('区切り線が先頭・末尾に来ない', () => {
    for (const target of targets) {
      const nodes = buildBoardMenu(state({ target }), actions())
      if (nodes.length === 0) continue
      expect(nodes[0].type, target.kind).toBe('item')
      expect(nodes[nodes.length - 1].type, target.kind).toBe('item')
    }
  })
})

describe('buildBoardMenu — 背景', () => {
  it('編集できないときは作成系を出さない', () => {
    const list = ids(buildBoardMenu(state({ canEdit: false }), actions()))
    expect(list).not.toContain('new-note')
    expect(list).not.toContain('paste')
    expect(list).not.toContain('templates')
    // 見るだけの操作は残る
    expect(list).toContain('select-all')
    expect(list).toContain('export-png')
  })

  it('右クリックした位置に作る', () => {
    const a = actions()
    find(buildBoardMenu(state({ bx: 123, by: 456 }), a), 'new-note')?.run()
    expect(a.createNote).toHaveBeenCalledWith(123, 456, 'sticky')
  })

  it('クリップボードが空なら貼り付けは押せない', () => {
    expect(find(buildBoardMenu(state(), actions()), 'paste')?.disabled).toBe(true)
    expect(find(buildBoardMenu(state({ clipboardCount: 2 }), actions()), 'paste')?.disabled)
      .toBeFalsy()
  })

  it('付箋が無ければ「すべて選択」は押せない', () => {
    expect(find(buildBoardMenu(state({ notes: [] }), actions()), 'select-all')?.disabled).toBe(true)
  })

  it('何も選んでいなければ「選択を解除」は押せない', () => {
    expect(find(buildBoardMenu(state(), actions()), 'clear-selection')?.disabled).toBe(true)
    expect(
      find(buildBoardMenu(state({ hasOtherSelection: true }), actions()), 'clear-selection')
        ?.disabled,
    ).toBeFalsy()
  })

  it('ClipboardItem が無いブラウザでは PNG コピーの理由がそれになる', () => {
    const item = find(buildBoardMenu(state({ canCopyImage: false }), actions()), 'copy-png')
    expect(item?.disabled).toBe(true)
    expect(item?.disabledReason).toContain('対応していません')
  })

  it('処理中は書き出しが押せない', () => {
    const nodes = buildBoardMenu(state({ busy: true }), actions())
    expect(find(nodes, 'export-png')?.disabled).toBe(true)
    expect(find(nodes, 'copy-png')?.disabledReason).toContain('別の処理')
  })

  it('ボード全体の PNG は引数なしで呼ぶ（選択に化けない）', () => {
    const a = actions()
    find(buildBoardMenu(state(), a), 'copy-png')?.run()
    expect(a.copyPng).toHaveBeenCalledWith()
    find(buildBoardMenu(state(), a), 'export-png')?.run()
    expect(a.exportPng).toHaveBeenCalledWith()
  })

  it('元に戻す・やり直すは中身があるときだけ押せて、内容を名前に出す', () => {
    const nodes = buildBoardMenu(state({ canUndo: true, undoLabel: '複製' }), actions())
    expect(find(nodes, 'undo')?.label).toBe('元に戻す（複製）')
    expect(find(nodes, 'undo')?.disabled).toBeFalsy()
    expect(find(nodes, 'redo')?.disabled).toBe(true)
  })
})

describe('buildBoardMenu — 付箋', () => {
  const target = { kind: 'note', id: 'note-1' } as const

  it('1 枚だけなら単数の言い方になり、整列は出ない', () => {
    const nodes = buildBoardMenu(state({ target }), actions())
    expect(find(nodes, 'delete')?.label).toBe('削除')
    expect(find(nodes, 'copy')?.label).toBe('コピー')
    expect(ids(nodes)).not.toContain('align-left')
    expect(ids(nodes)).not.toContain('wrap-frame')
  })

  it('選択の一部を右クリックしたら、選択全体をまとめて扱う', () => {
    const rows = [note({ id: 'note-1' }), note({ id: 'note-2' }), note({ id: 'note-3' })]
    const nodes = buildBoardMenu(
      state({ target, notes: rows, selectedIds: rows.map((n) => n.id), selectedNotes: rows }),
      actions(),
    )

    expect(find(nodes, 'delete')?.label).toBe('3 件を削除')
    expect(ids(nodes)).toContain('wrap-frame')
    expect(ids(nodes)).toContain('align-grid')
  })

  it('選択の外を右クリックしたら、その 1 枚だけを扱う', () => {
    const rows = [note({ id: 'note-1' }), note({ id: 'note-2' })]
    const a = actions()
    const nodes = buildBoardMenu(
      state({
        target,
        notes: rows,
        // note-1 は選ばれていない
        selectedIds: ['note-2'],
        selectedNotes: [rows[1]],
      }),
      a,
    )

    find(nodes, 'delete')?.run()
    expect(a.deleteNotes).toHaveBeenCalledWith([rows[0]])
  })

  it('複数選択中はコメントと色のコピーが押せない', () => {
    const rows = [note({ id: 'note-1' }), note({ id: 'note-2' })]
    const nodes = buildBoardMenu(
      state({ target, notes: rows, selectedIds: ['note-1', 'note-2'], selectedNotes: rows }),
      actions(),
    )
    expect(find(nodes, 'comments')?.disabled).toBe(true)
    expect(find(nodes, 'copy-style')?.disabled).toBe(true)
  })

  it('色をコピーしていなければ貼り付けられない', () => {
    expect(find(buildBoardMenu(state({ target }), actions()), 'paste-style')?.disabled).toBe(true)
    expect(
      find(buildBoardMenu(state({ target, hasClipboardStyle: true }), actions()), 'paste-style')
        ?.disabled,
    ).toBeFalsy()
  })

  it('切り取りはコピーしてから消す', () => {
    const a = actions()
    find(buildBoardMenu(state({ target }), a), 'cut')?.run()
    expect(a.copyNotes).toHaveBeenCalledTimes(1)
    expect(a.deleteNotes).toHaveBeenCalledTimes(1)
  })

  it('閲覧のみでも、取り出すだけの操作は残る', () => {
    const list = ids(buildBoardMenu(state({ target, canEdit: false }), actions()))
    expect(list).toEqual(['copy', 'copy-png-selection', 'export-png-selection', 'comments'])
  })

  it('PNG は選んだ付箋だけを対象にする', () => {
    const rows = [note({ id: 'note-1' }), note({ id: 'note-2' })]
    const a = actions()
    const nodes = buildBoardMenu(
      state({ target, notes: rows, selectedIds: ['note-1', 'note-2'], selectedNotes: rows }),
      a,
    )

    expect(find(nodes, 'copy-png-selection')?.label).toBe('2 件を PNG としてコピー')
    find(nodes, 'copy-png-selection')?.run()
    expect(a.copyPng).toHaveBeenCalledWith(rows)

    find(nodes, 'export-png-selection')?.run()
    expect(a.exportPng).toHaveBeenCalledWith(rows)
  })

  it('1 枚だけなら件数を付けない', () => {
    const nodes = buildBoardMenu(state({ target }), actions())
    expect(find(nodes, 'copy-png-selection')?.label).toBe('PNG としてコピー')
    expect(find(nodes, 'export-png-selection')?.label).toBe('PNG で保存')
  })

  it('ClipboardItem が無いブラウザでは PNG コピーが押せない', () => {
    const nodes = buildBoardMenu(state({ target, canCopyImage: false }), actions())
    expect(find(nodes, 'copy-png-selection')?.disabled).toBe(true)
    // 保存のほうは対応と関係ないので押せる
    expect(find(nodes, 'export-png-selection')?.disabled).toBeFalsy()
  })

  it('重なり順は最前面・最背面の 2 つ', () => {
    const a = actions()
    const nodes = buildBoardMenu(state({ target }), a)
    find(nodes, 'to-back')?.run()
    expect(a.changeZ).toHaveBeenCalledWith([note()], 'back')
  })
})

describe('buildBoardMenu — 画像・フレーム・線・ファイル', () => {
  it('画像には重なり順を出さない（レイヤーを跨げないため）', () => {
    const list = ids(buildBoardMenu(state({ target: { kind: 'image', id: 'image-1' } }), actions()))
    expect(list).not.toContain('to-front')
    expect(list).toContain('delete-image')
  })

  it('フレームは中の付箋の数を出し、0 なら押せない', () => {
    const inside = buildBoardMenu(state({ target: { kind: 'frame', id: 'frame-1' } }), actions())
    expect(find(inside, 'select-inside')?.label).toBe('中の付箋を選択（1）')

    const empty = buildBoardMenu(
      state({ target: { kind: 'frame', id: 'frame-1' }, notes: [note({ x: 5000, y: 5000 })] }),
      actions(),
    )
    expect(find(empty, 'select-inside')?.disabled).toBe(true)
  })

  it('線は今の見た目と逆のほうを出す', () => {
    const arrow = buildBoardMenu(state({ target: { kind: 'connector', id: 'connector-1' } }), actions())
    expect(find(arrow, 'connector-style')?.label).toBe('直線にする')

    const line = buildBoardMenu(
      state({
        target: { kind: 'connector', id: 'connector-1' },
        connectors: [{ ...CONNECTOR, style: 'line' }],
      }),
      actions(),
    )
    expect(find(line, 'connector-style')?.label).toBe('矢印にする')
  })

  it('ファイルの URL がまだ無ければ開けない', () => {
    const nodes = buildBoardMenu(
      state({ target: { kind: 'attachment', id: 'file-1' }, fileUrls: {} }),
      actions(),
    )
    expect(find(nodes, 'open-attachment')?.disabled).toBe(true)
  })
})
