/**
 * キーボードショートカットの一覧。
 *
 * これまで、押したときの処理は 3 か所（WhiteboardTab・RoomPage・useUndoStack）に、
 * 一覧の表示は ShortcutsModal に、それぞれ別々に書かれていた。そのため
 * 「長押しでレーザーポインター」のように、一覧にはあるが実装は無い、という
 * ずれが生まれていた。ここを唯一の出どころにして、一覧はここから作る。
 *
 * match が KeyboardEvent ではなく素のオブジェクト（KeyChord）を受け取るのは、
 * テストを node 環境で走らせるため。ブラウザの型を使わずに衝突を検査できる。
 */

export interface KeyChord {
  key: string
  code: string
  /** Ctrl と、macOS の Command をまとめて扱う */
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export interface ShortcutDef {
  id: string
  group: string
  label: string
  /** 一覧やメニューの右端に出す表記 */
  display: string
  /** キーボードで拾うものだけ持つ。マウス操作の説明には無い */
  match?: (c: KeyChord) => boolean
}

export function toChord(e: KeyboardEvent): KeyChord {
  return {
    key: e.key,
    code: e.code,
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  }
}

/** 修飾キーを一切押していない、素のキー */
function plain(c: KeyChord): boolean {
  return !c.ctrl && !c.shift && !c.alt
}

export const SHORTCUTS: ShortcutDef[] = [
  // ---- 全体 ----
  {
    id: 'help',
    group: '全体',
    label: 'このショートカット一覧を開く',
    display: '?',
    match: (c) => !c.ctrl && !c.alt && (c.key === '?' || (c.key === '/' && c.shift)),
  },
  {
    id: 'search',
    group: '全体',
    label: 'ボード内を検索',
    display: 'Ctrl + F',
    match: (c) => c.ctrl && !c.shift && !c.alt && c.key.toLowerCase() === 'f',
  },
  {
    id: 'escape',
    group: '全体',
    label: '開いている画面を閉じる / 選択を解除',
    display: 'Esc',
    match: (c) => plain(c) && c.key === 'Escape',
  },
  {
    id: 'context-menu',
    group: '全体',
    label: '右クリックメニューを開く',
    display: '右クリック / Shift + F10',
  },

  // ---- 道具 ----
  ...(
    [
      ['tool-select', 'v', '選択'],
      ['tool-note', 'n', '付箋'],
      ['tool-text', 't', 'テキスト'],
      ['tool-pen', 'p', 'ペン'],
      ['tool-line', 'l', '直線'],
      ['tool-arrow', 'a', '矢印'],
      ['tool-rect', 'r', '四角'],
      ['tool-ellipse', 'o', '円'],
      ['tool-eraser', 'e', '消しゴム'],
      ['tool-connect', 'c', '付箋をつなぐ'],
      ['tool-frame', 'f', 'フレーム'],
    ] as const
  ).map(([id, key, label]) => ({
    id,
    group: 'ホワイトボード — 道具',
    label,
    display: key.toUpperCase(),
    match: (c: KeyChord) => plain(c) && c.key.toLowerCase() === key,
  })),

  // ---- 操作 ----
  {
    id: 'pan-space',
    group: 'ホワイトボード — 操作',
    label: '画面を掴んで移動',
    display: 'スペース + ドラッグ',
  },
  {
    id: 'pan-middle',
    group: 'ホワイトボード — 操作',
    label: '画面を掴んで移動',
    display: '中ボタン ドラッグ',
  },
  {
    id: 'zoom',
    group: 'ホワイトボード — 操作',
    label: '拡大・縮小',
    display: 'Ctrl + ホイール',
  },
  {
    id: 'font-size',
    group: 'ホワイトボード — 操作',
    label: '付箋の文字サイズを変える',
    display: '長押し + 上下ドラッグ',
  },
  {
    id: 'fit',
    group: 'ホワイトボード — 操作',
    label: '全体を画面に収める',
    display: 'Shift + H',
    match: (c) => !c.ctrl && !c.alt && c.shift && c.key.toLowerCase() === 'h',
  },
  {
    id: 'select-all',
    group: 'ホワイトボード — 操作',
    label: 'すべての付箋を選択',
    display: 'Ctrl + A',
    match: (c) => c.ctrl && !c.shift && !c.alt && c.key.toLowerCase() === 'a',
  },
  {
    id: 'undo',
    group: 'ホワイトボード — 操作',
    label: '元に戻す',
    display: 'Ctrl + Z',
    match: (c) => c.ctrl && !c.shift && !c.alt && c.key.toLowerCase() === 'z',
  },
  {
    id: 'redo',
    group: 'ホワイトボード — 操作',
    label: 'やり直す',
    display: 'Ctrl + Shift + Z',
    match: (c) => c.ctrl && !c.alt && (c.key.toLowerCase() === 'y' || (c.shift && c.key.toLowerCase() === 'z')),
  },
  {
    id: 'delete',
    group: 'ホワイトボード — 操作',
    label: '選択中の付箋を削除',
    display: 'Delete',
    match: (c) => plain(c) && (c.key === 'Delete' || c.key === 'Backspace'),
  },

  // ---- 編集 ----
  {
    id: 'copy',
    group: 'ホワイトボード — 編集',
    label: '選択中の付箋をコピー',
    display: 'Ctrl + C',
  },
  {
    id: 'cut',
    group: 'ホワイトボード — 編集',
    label: '選択中の付箋を切り取り',
    display: 'Ctrl + X',
  },
  {
    id: 'paste',
    group: 'ホワイトボード — 編集',
    label: '付箋・画像を貼り付け',
    display: 'Ctrl + V',
  },
  {
    id: 'duplicate',
    group: 'ホワイトボード — 編集',
    label: '選択中の付箋を複製',
    display: 'Ctrl + D',
    match: (c) => c.ctrl && !c.shift && !c.alt && c.key.toLowerCase() === 'd',
  },
  {
    id: 'wrap-frame',
    group: 'ホワイトボード — 編集',
    label: '選択を囲うフレームを作る',
    display: 'Ctrl + G',
    match: (c) => c.ctrl && !c.shift && !c.alt && c.key.toLowerCase() === 'g',
  },
  {
    // macOS の Cmd + [ ] はブラウザの「戻る / 進む」なので Shift を足したものだけにする。
    // JIS 配列では key が '[' にならないことがあるため、判定は code で行う
    id: 'to-front',
    group: 'ホワイトボード — 編集',
    label: '最前面へ移動',
    display: 'Ctrl + Shift + ]',
    match: (c) => c.ctrl && c.shift && !c.alt && c.code === 'BracketRight',
  },
  {
    id: 'to-back',
    group: 'ホワイトボード — 編集',
    label: '最背面へ移動',
    display: 'Ctrl + Shift + [',
    match: (c) => c.ctrl && c.shift && !c.alt && c.code === 'BracketLeft',
  },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

/** 押されたキーに当てはまるショートカットの id。無ければ null */
export function matchShortcut(chord: KeyChord): string | null {
  return SHORTCUTS.find((s) => s.match?.(chord))?.id ?? null
}

/** メニューや一覧に出す表記。id が無ければ undefined（型で気づけるように） */
export function shortcutDisplay(id: string): string | undefined {
  return BY_ID.get(id)?.display
}

/** 一覧の見出しごとにまとめたもの。ShortcutsModal がそのまま使う */
export function shortcutGroups(): { title: string; items: [string, string][] }[] {
  const groups: { title: string; items: [string, string][] }[] = []
  for (const item of SHORTCUTS) {
    const group = groups.find((g) => g.title === item.group)
    if (group) group.items.push([item.display, item.label])
    else groups.push({ title: item.group, items: [[item.display, item.label]] })
  }
  return groups
}

/**
 * Apple のキーボード配列か。
 *
 * 判定は表記のためだけに使う。押されたキーの判定は toChord() が
 * ctrlKey と metaKey を同じものとして扱うので、⌘ はもともと効いている。
 * 書き方は usePushNotifications.ts の iPadOS 判定に寄せてある。
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform ?? ''
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent)
}

/**
 * 表記を、見ている人のキーボードに合わせて書き換える。
 *
 * SHORTCUTS が持つ値そのもの（'Ctrl + C'）は変えない。メニューの項目と
 * SHORTCUTS の突き合わせをテストで固定してあるので、データを OS で
 * 揺らすと、そのテストが環境依存になってしまう。変換は表示の直前だけで行う。
 *
 * 区切りの ' + ' は残す。Mac の作法では '⌘⇧]' と詰めて書くが、
 * 「右クリック / Shift + F10」のように記号でない語が混ざる表記もあるため、
 * 全体で 1 つの規則にしておくほうが読み違いが起きない。
 */
export function formatShortcut(display: string | undefined, mac = isApplePlatform()): string {
  if (!display) return ''
  if (!mac) return display
  return display
    .replace(/\bCtrl\b/g, '⌘')
    .replace(/\bShift\b/g, '⇧')
    .replace(/\bAlt\b/g, '⌥')
    .replace(/\bDelete\b/g, '⌫')
}

/** aria-keyshortcuts の綴り。修飾キーの名前は仕様で決まっている */
export function ariaKeyshortcuts(
  display: string | undefined,
  mac = isApplePlatform(),
): string | undefined {
  if (!display) return undefined
  return display.replace(/\bCtrl\b/g, mac ? 'Meta' : 'Control').replace(/\s*\+\s*/g, '+')
}

/** 文字を打っている最中か。ショートカットを黙らせる判定に使う */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true
}

/**
 * IME で変換している最中のキーか。
 *
 * 日本語入力では、変換を確定する Enter も、変換を取り消す Esc も keydown として届く。
 * そのまま拾うと、確定のつもりの Enter でタグや小項目が半端な読みのまま決まり、
 * 取り消しのつもりの Esc でモーダルごと閉じて、打っていた文が消える。
 *
 * isComposing は Chrome と Firefox が立てる。Safari は確定の Enter を compositionend の
 * あとに送るので isComposing が false になるが、keyCode は 229 のまま届く。両方を見る。
 * React のイベントなら nativeEvent を渡す。
 */
export function isComposingKey(e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return e.isComposing || e.keyCode === 229
}
