/**
 * 右クリックメニューの中身。
 *
 * 状態を受け取って項目の配列を返すだけの純粋な関数にしてある。理由は 2 つ。
 * ひとつは WhiteboardTab がすでに 3000 行を超えていて、ここに足し続けたくないこと。
 * もうひとつは、node 環境の vitest でそのまま試せること —— このプロジェクトには
 * DOM のテスト環境が無いので、判断のあるところを純粋な関数へ押し出すのが唯一の道になる。
 *
 * 「どういう条件でどの項目が出るか」「押せないときの理由は何か」は、まさに
 * 間違えやすくて気づきにくいところなので、そこをテストできる形にしている。
 */

import { joinSections, type CtxTarget, type MenuNode } from './menuTypes'
import { shortcutDisplay } from './shortcuts'
import { insideRect } from './boardGeometry'
import type { Attachment, BoardImage, Connector, Frame, Note } from './types'

export type AlignKind = 'left' | 'top' | 'row' | 'column' | 'grid'

export interface BoardMenuState {
  target: CtxTarget
  /** 右クリックしたボード上の位置。「ここに作る」「ここに貼り付け」で使う */
  bx: number
  by: number
  canEdit: boolean
  notes: Note[]
  images: BoardImage[]
  frames: Frame[]
  connectors: Connector[]
  attachments: Attachment[]
  /** 署名付き URL。まだ取れていないファイルは開けない */
  fileUrls: Record<string, string>
  selectedIds: string[]
  selectedNotes: Note[]
  /** 付箋以外（画像・フレームなど）を選んでいるか */
  hasOtherSelection: boolean
  clipboardCount: number
  hasClipboardStyle: boolean
  /** 画像の書き出しなど、時間のかかる処理が動いている最中か */
  busy: boolean
  /** このブラウザが画像のクリップボードコピーに対応しているか */
  canCopyImage: boolean
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface BoardMenuActions {
  createNote: (x: number, y: number, kind: 'sticky' | 'text') => void
  createFrame: (x: number, y: number) => void
  paste: (x: number, y: number) => void
  selectAll: () => void
  clearSelection: () => void
  openTemplates: () => void
  openBulk: () => void
  fitToScreen: () => void
  /** rows を渡すとその付箋だけ、省略するとボード全体 */
  copyPng: (rows?: Note[]) => void
  exportPng: (rows?: Note[]) => void
  undo: () => void
  redo: () => void

  copyNotes: (rows: Note[]) => void
  deleteNotes: (rows: Note[]) => void
  duplicateNotes: (rows: Note[]) => void
  wrapInFrame: (rows: Note[]) => void
  copyStyle: (note: Note) => void
  pasteStyle: (rows: Note[]) => void
  openComments: (note: Note) => void
  convert: (rows: Note[], target: 'todo' | 'event') => void
  align: (kind: AlignKind) => void
  changeZ: (rows: Note[], where: 'front' | 'back') => void
  selectNotes: (rows: Note[]) => void

  deleteImage: (image: BoardImage) => void
  deleteFrame: (frame: Frame) => void
  toggleConnectorStyle: (connector: Connector) => void
  deleteConnector: (connector: Connector) => void
  openUrl: (url: string) => void
  deleteAttachment: (attachment: Attachment) => void
}

/**
 * 対象が見つからないときは空を返す。呼び出し側はそれを見てメニューを閉じる
 * （共同編集なので、開いている間に他の人が消すことがある）。
 */
export function buildBoardMenu(s: BoardMenuState, a: BoardMenuActions): MenuNode[] {
  const { id } = s.target
  switch (s.target.kind) {
    case 'note':
      return id ? noteMenu(s, a, id) : []
    case 'image':
      return id ? imageMenu(s, a, id) : []
    case 'frame':
      return id ? frameMenu(s, a, id) : []
    case 'connector':
      return id ? connectorMenu(s, a, id) : []
    case 'attachment':
      return id ? attachmentMenu(s, a, id) : []
    default:
      return canvasMenu(s, a)
  }
}

function canvasMenu(s: BoardMenuState, a: BoardMenuActions): MenuNode[] {
  const { bx: x, by: y } = s
  return joinSections([
    [
      s.canEdit && {
        id: 'new-note',
        icon: '📝',
        label: 'ここに付箋を作る',
        shortcut: shortcutDisplay('tool-note'),
        run: () => a.createNote(x, y, 'sticky'),
      },
      s.canEdit && {
        id: 'new-text',
        icon: '🔤',
        label: 'ここにテキストを作る',
        shortcut: shortcutDisplay('tool-text'),
        run: () => a.createNote(x, y, 'text'),
      },
      s.canEdit && {
        id: 'new-frame',
        icon: '🔲',
        label: 'ここにフレームを作る',
        shortcut: shortcutDisplay('tool-frame'),
        run: () => a.createFrame(x, y),
      },
    ],
    [
      s.canEdit && {
        id: 'paste',
        label: 'ここに貼り付け',
        shortcut: shortcutDisplay('paste'),
        disabled: s.clipboardCount === 0,
        disabledReason: 'まだ付箋をコピーしていません',
        run: () => a.paste(x, y),
      },
    ],
    [
      {
        id: 'select-all',
        label: 'すべての付箋を選択',
        shortcut: shortcutDisplay('select-all'),
        disabled: s.notes.length === 0,
        disabledReason: 'まだ付箋がありません',
        run: a.selectAll,
      },
      {
        id: 'clear-selection',
        label: '選択を解除',
        shortcut: shortcutDisplay('escape'),
        disabled: s.selectedIds.length === 0 && !s.hasOtherSelection,
        disabledReason: '何も選んでいません',
        run: a.clearSelection,
      },
    ],
    [
      s.canEdit && { id: 'templates', label: 'テンプレートを選ぶ…', run: a.openTemplates },
      s.canEdit && { id: 'bulk', label: 'テキストからまとめて付箋を作る…', run: a.openBulk },
    ],
    [
      {
        id: 'fit',
        label: '全体を画面に収める',
        shortcut: shortcutDisplay('fit'),
        run: a.fitToScreen,
      },
      {
        id: 'copy-png',
        label: 'PNG としてクリップボードにコピー',
        disabled: s.busy || !s.canCopyImage,
        disabledReason: s.canCopyImage
          ? '別の処理が動いています'
          : 'このブラウザは画像のコピーに対応していません',
        // 引数なし = ボード全体。run に何か渡されても rows に化けないよう包む
        run: () => a.copyPng(),
      },
      {
        id: 'export-png',
        label: 'PNG で保存',
        disabled: s.busy,
        disabledReason: '別の処理が動いています',
        run: () => a.exportPng(),
      },
    ],
    [
      {
        id: 'undo',
        label: s.undoLabel ? `元に戻す（${s.undoLabel}）` : '元に戻す',
        shortcut: shortcutDisplay('undo'),
        disabled: !s.canUndo,
        disabledReason: '戻せる操作がありません',
        run: a.undo,
      },
      {
        id: 'redo',
        label: s.redoLabel ? `やり直す（${s.redoLabel}）` : 'やり直す',
        shortcut: shortcutDisplay('redo'),
        disabled: !s.canRedo,
        disabledReason: 'やり直せる操作がありません',
        run: a.redo,
      },
    ],
  ])
}

function noteMenu(s: BoardMenuState, a: BoardMenuActions, id: string): MenuNode[] {
  // rows はゴミ箱を除いた一覧。id で引き直すのは、開いている間に中身が変わるため
  const note = s.notes.find((n) => n.id === id)
  if (!note) return []

  // 右クリックしたものが選択の一部なら、選択全体をまとめて扱う。
  // 3 枚選んだ状態で 1 枚を右クリックしたら「3 件を削除」が出てほしい
  const rows = s.selectedIds.includes(id) && s.selectedNotes.length > 1 ? s.selectedNotes : [note]
  const many = rows.length > 1
  const prefix = many ? `${rows.length} 件を` : ''
  const onlyOne = '付箋を 1 枚だけ選んでください'

  return joinSections([
    [
      {
        id: 'copy',
        label: `${prefix}コピー`,
        shortcut: shortcutDisplay('copy'),
        run: () => a.copyNotes(rows),
      },
      s.canEdit && {
        id: 'cut',
        label: `${prefix}切り取り`,
        shortcut: shortcutDisplay('cut'),
        run: () => {
          a.copyNotes(rows)
          a.deleteNotes(rows)
        },
      },
      s.canEdit && {
        id: 'duplicate',
        label: `${prefix}複製`,
        shortcut: shortcutDisplay('duplicate'),
        run: () => a.duplicateNotes(rows),
      },
      s.canEdit &&
        many && {
          id: 'wrap-frame',
          icon: '🔲',
          label: '選択を囲うフレームを作る',
          shortcut: shortcutDisplay('wrap-frame'),
          run: () => a.wrapInFrame(rows),
        },
    ],
    [
      {
        id: 'copy-png-selection',
        label: many ? `${rows.length} 件を PNG としてコピー` : 'PNG としてコピー',
        disabled: s.busy || !s.canCopyImage,
        disabledReason: s.canCopyImage
          ? '別の処理が動いています'
          : 'このブラウザは画像のコピーに対応していません',
        run: () => a.copyPng(rows),
      },
      {
        id: 'export-png-selection',
        label: many ? `${rows.length} 件を PNG で保存` : 'PNG で保存',
        disabled: s.busy,
        disabledReason: '別の処理が動いています',
        run: () => a.exportPng(rows),
      },
    ],
    [
      s.canEdit && {
        id: 'copy-style',
        label: '色をコピー',
        disabled: many,
        disabledReason: onlyOne,
        run: () => a.copyStyle(note),
      },
      s.canEdit && {
        id: 'paste-style',
        label: '色を貼り付け',
        disabled: !s.hasClipboardStyle,
        disabledReason: 'まだ色をコピーしていません',
        run: () => a.pasteStyle(rows),
      },
    ],
    [
      {
        id: 'comments',
        icon: '💬',
        label: 'コメント・タグ',
        disabled: many,
        disabledReason: onlyOne,
        run: () => a.openComments(note),
      },
      s.canEdit && {
        id: 'to-todo',
        icon: '⏰',
        label: `${prefix}やることにする`,
        run: () => a.convert(rows, 'todo'),
      },
      s.canEdit && {
        id: 'to-event',
        icon: '📅',
        label: `${prefix}予定にする`,
        run: () => a.convert(rows, 'event'),
      },
    ],
    many && s.canEdit
      ? [
          { id: 'align-left', label: '左をそろえる', run: () => a.align('left') },
          { id: 'align-top', label: '上をそろえる', run: () => a.align('top') },
          { id: 'align-row', label: '横に並べる', run: () => a.align('row') },
          { id: 'align-column', label: '縦に並べる', run: () => a.align('column') },
          { id: 'align-grid', label: 'グリッドにそろえる', run: () => a.align('grid') },
        ]
      : [],
    [
      s.canEdit && {
        id: 'to-front',
        label: '最前面へ',
        shortcut: shortcutDisplay('to-front'),
        run: () => a.changeZ(rows, 'front'),
      },
      s.canEdit && {
        id: 'to-back',
        label: '最背面へ',
        shortcut: shortcutDisplay('to-back'),
        run: () => a.changeZ(rows, 'back'),
      },
    ],
    [
      s.canEdit && {
        id: 'delete',
        icon: '🗑',
        label: `${prefix}削除`,
        shortcut: shortcutDisplay('delete'),
        danger: true,
        run: () => a.deleteNotes(rows),
      },
    ],
  ])
}

function imageMenu(s: BoardMenuState, a: BoardMenuActions, id: string): MenuNode[] {
  const image = s.images.find((i) => i.id === id)
  if (!image) return []
  // 重なり順を出さないのは、画像レイヤーが CSS で付箋より下に固定されていて、
  // 「最前面へ」を押しても付箋の下から出てこないため（壊れて見える）
  return joinSections([
    [
      s.canEdit && {
        id: 'delete-image',
        icon: '🗑',
        label: '画像を削除',
        danger: true,
        run: () => a.deleteImage(image),
      },
    ],
  ])
}

function frameMenu(s: BoardMenuState, a: BoardMenuActions, id: string): MenuNode[] {
  const frame = s.frames.find((f) => f.id === id)
  if (!frame) return []
  const inside = insideRect(s.notes, frame)
  return joinSections([
    [
      {
        id: 'select-inside',
        label: `中の付箋を選択（${inside.length}）`,
        disabled: inside.length === 0,
        disabledReason: 'フレームの中に付箋がありません',
        run: () => a.selectNotes(inside),
      },
    ],
    [
      s.canEdit && {
        id: 'delete-frame',
        icon: '🗑',
        label: 'フレームを削除',
        danger: true,
        run: () => a.deleteFrame(frame),
      },
    ],
  ])
}

function connectorMenu(s: BoardMenuState, a: BoardMenuActions, id: string): MenuNode[] {
  const connector = s.connectors.find((c) => c.id === id)
  if (!connector) return []
  return joinSections([
    [
      s.canEdit && {
        id: 'connector-style',
        label: connector.style === 'arrow' ? '直線にする' : '矢印にする',
        run: () => a.toggleConnectorStyle(connector),
      },
    ],
    [
      s.canEdit && {
        id: 'delete-connector',
        icon: '🗑',
        label: '線を削除',
        danger: true,
        run: () => a.deleteConnector(connector),
      },
    ],
  ])
}

function attachmentMenu(s: BoardMenuState, a: BoardMenuActions, id: string): MenuNode[] {
  const attachment = s.attachments.find((f) => f.id === id)
  if (!attachment) return []
  const url = s.fileUrls[attachment.storage_path]
  return joinSections([
    [
      {
        id: 'open-attachment',
        label: 'ファイルを開く',
        disabled: !url,
        disabledReason: 'まだ読み込めていません',
        run: () => a.openUrl(url),
      },
    ],
    [
      s.canEdit && {
        id: 'delete-attachment',
        icon: '🗑',
        label: 'ファイルを削除',
        danger: true,
        run: () => a.deleteAttachment(attachment),
      },
    ],
  ])
}
