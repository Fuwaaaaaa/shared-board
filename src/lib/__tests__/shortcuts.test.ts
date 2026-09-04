import { describe, expect, it } from 'vitest'
import {
  SHORTCUTS,
  ariaKeyshortcuts,
  formatShortcut,
  isTypingTarget,
  matchShortcut,
  shortcutDisplay,
  shortcutGroups,
  type KeyChord,
} from '../shortcuts'

function chord(over: Partial<KeyChord> = {}): KeyChord {
  return { key: '', code: '', ctrl: false, shift: false, alt: false, ...over }
}

/** 実際に押される組み合わせと、当たってほしい id */
const CASES: [string, KeyChord, string][] = [
  ['?', chord({ key: '?' }), 'help'],
  ['Shift + /', chord({ key: '/', shift: true }), 'help'],
  ['Ctrl + F', chord({ key: 'f', ctrl: true }), 'search'],
  ['Esc', chord({ key: 'Escape' }), 'escape'],
  ['N', chord({ key: 'n' }), 'tool-note'],
  ['F', chord({ key: 'f' }), 'tool-frame'],
  ['Shift + H', chord({ key: 'H', shift: true }), 'fit'],
  ['Ctrl + A', chord({ key: 'a', ctrl: true }), 'select-all'],
  ['Ctrl + Z', chord({ key: 'z', ctrl: true }), 'undo'],
  ['Ctrl + Shift + Z', chord({ key: 'z', ctrl: true, shift: true }), 'redo'],
  ['Ctrl + Y', chord({ key: 'y', ctrl: true }), 'redo'],
  ['Delete', chord({ key: 'Delete' }), 'delete'],
  ['Backspace', chord({ key: 'Backspace' }), 'delete'],
  ['Ctrl + D', chord({ key: 'd', ctrl: true }), 'duplicate'],
  ['Ctrl + G', chord({ key: 'g', ctrl: true }), 'wrap-frame'],
  [
    'Ctrl + Shift + ]',
    chord({ key: ']', code: 'BracketRight', ctrl: true, shift: true }),
    'to-front',
  ],
  ['Ctrl + Shift + [', chord({ key: '[', code: 'BracketLeft', ctrl: true, shift: true }), 'to-back'],
]

describe('shortcuts', () => {
  it.each(CASES)('%s は %s に当たる', (_name, c, expected) => {
    expect(matchShortcut(c)).toBe(expected)
  })

  it('ひとつのキーに複数のショートカットが当たらない（衝突検出）', () => {
    for (const [name, c] of CASES) {
      const hits = SHORTCUTS.filter((s) => s.match?.(c)).map((s) => s.id)
      expect(hits, `${name} が ${hits.join(' と ')} の両方に当たっている`).toHaveLength(1)
    }
  })

  it('id は重複しない', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('修飾キー付きは素押しに当たらない（道具のホットキーを巻き込まない）', () => {
    // Ctrl+F は「検索」であって「フレーム」ではない
    expect(matchShortcut(chord({ key: 'f', ctrl: true }))).toBe('search')
    // Shift+H は「全体表示」。素の H には何も当たらない
    expect(matchShortcut(chord({ key: 'h' }))).toBeNull()
  })

  it('JIS 配列を考えて、括弧は code で判定する', () => {
    // key が配列によって変わっても code は変わらない
    const jis = chord({ key: '@', code: 'BracketRight', ctrl: true, shift: true })
    expect(matchShortcut(jis)).toBe('to-front')
  })

  it('macOS でブラウザの戻る/進むになる Cmd + [ ] 単体は拾わない', () => {
    expect(matchShortcut(chord({ key: '[', code: 'BracketLeft', ctrl: true }))).toBeNull()
    expect(matchShortcut(chord({ key: ']', code: 'BracketRight', ctrl: true }))).toBeNull()
  })

  it('当てはまらないキーは null', () => {
    expect(matchShortcut(chord({ key: 'q', ctrl: true, alt: true }))).toBeNull()
  })

  it('表記はすべての項目にあり、id から引ける', () => {
    for (const s of SHORTCUTS) {
      expect(s.display, s.id).toBeTruthy()
      expect(shortcutDisplay(s.id)).toBe(s.display)
    }
    expect(shortcutDisplay('存在しない')).toBeUndefined()
  })

  it('一覧は見出しごとにまとまり、全項目が入る', () => {
    const groups = shortcutGroups()
    const total = groups.reduce((sum, g) => sum + g.items.length, 0)
    expect(total).toBe(SHORTCUTS.length)
    expect(groups.map((g) => g.title)).toEqual([...new Set(SHORTCUTS.map((s) => s.group))])
  })

  it('実装の無い操作を一覧に載せない（マウス操作を除き match を持つ）', () => {
    // 「長押しでレーザーポインター」のような、一覧にだけある操作を防ぐための番人。
    // ここに追加するときは、押されたときの処理も必ず書くこと
    const mouseOnly = ['context-menu', 'pan-space', 'pan-middle', 'zoom', 'font-size']
    // copy / cut / paste はブラウザの clipboard イベントで拾うので match を持たない
    const clipboard = ['copy', 'cut', 'paste']
    for (const s of SHORTCUTS) {
      if (mouseOnly.includes(s.id) || clipboard.includes(s.id)) continue
      expect(s.match, `${s.id} に match がない`).toBeTypeOf('function')
    }
  })

  it('isTypingTarget は入力欄だけ true', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('formatShortcut（見ている人のキーボードに合わせた表記）', () => {
  it('Mac 以外はそのまま', () => {
    expect(formatShortcut('Ctrl + C', false)).toBe('Ctrl + C')
    expect(formatShortcut('Ctrl + Shift + ]', false)).toBe('Ctrl + Shift + ]')
  })

  it('Mac では修飾キーを記号にする', () => {
    expect(formatShortcut('Ctrl + C', true)).toBe('⌘ + C')
    expect(formatShortcut('Ctrl + Shift + ]', true)).toBe('⌘ + ⇧ + ]')
    expect(formatShortcut('Delete', true)).toBe('⌫')
  })

  it('修飾キーを含まない表記は Mac でも変えない', () => {
    for (const display of ['?', 'Esc', 'N', 'スペース + ドラッグ', '長押し + 上下ドラッグ']) {
      expect(formatShortcut(display, true), display).toBe(display)
    }
  })

  it('語の一部が Ctrl や Alt に見えても壊さない', () => {
    // 単語の境目で判定しているので、途中に現れる綴りは置き換えない
    expect(formatShortcut('Alternate', true)).toBe('Alternate')
  })

  it('マウス操作と混ざった表記でも、修飾キーだけを直す', () => {
    expect(formatShortcut('右クリック / Shift + F10', true)).toBe('右クリック / ⇧ + F10')
    expect(formatShortcut('Ctrl + ホイール', true)).toBe('⌘ + ホイール')
  })

  it('未定義なら空文字（表示側で条件分岐を書かなくて済むように）', () => {
    expect(formatShortcut(undefined, true)).toBe('')
  })

  it('SHORTCUTS の全項目が Mac でも壊れない', () => {
    for (const s of SHORTCUTS) {
      const mac = formatShortcut(s.display, true)
      expect(mac, s.id).toBeTruthy()
      expect(mac.includes('Ctrl'), s.id).toBe(false)
    }
  })
})

describe('ariaKeyshortcuts（読み上げ用の綴り）', () => {
  it('Windows は Control、Mac は Meta', () => {
    expect(ariaKeyshortcuts('Ctrl + C', false)).toBe('Control+C')
    expect(ariaKeyshortcuts('Ctrl + C', true)).toBe('Meta+C')
  })

  it('区切りの空白を詰める（仕様の書き方に合わせる）', () => {
    expect(ariaKeyshortcuts('Ctrl + Shift + ]', false)).toBe('Control+Shift+]')
  })

  it('未定義なら undefined（属性そのものを出さない）', () => {
    expect(ariaKeyshortcuts(undefined)).toBeUndefined()
  })
})
