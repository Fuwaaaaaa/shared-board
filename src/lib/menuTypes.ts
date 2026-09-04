/**
 * コンテキストメニューの項目定義。
 *
 * 「何を出すか」（このファイルと boardMenu.ts）と「どう出すか」（ContextMenu.tsx）を
 * 分けてある。項目の組み立てが純粋なデータ変換になるので、ブラウザ無しでテストできる。
 */

/** 右クリックされた対象。canvas は何も載っていない場所（ボードの余白） */
export type CtxTargetKind = 'note' | 'image' | 'frame' | 'connector' | 'attachment' | 'canvas'

export interface CtxTarget {
  kind: CtxTargetKind
  /** canvas のときだけ null */
  id: string | null
}

export interface MenuItem {
  id: string
  label: string
  /** 行頭に置く絵文字。既存の選択ツールバー（🗑 💬 ⏰ 📅）と語彙を揃える */
  icon?: string
  /** 右端に淡色で出す表記。'Ctrl+C' のような見たままの文字列 */
  shortcut?: string
  disabled?: boolean
  /**
   * 無効な理由。disabled なら必ず書く。
   * 押せない項目を理由も無く灰色で出すと、壊れているのか使えないのかが区別できない。
   */
  disabledReason?: string
  /** 削除など、取り返しのつきにくい操作。赤系で出す */
  danger?: boolean
  run: () => void | Promise<void>
}

export type MenuNode =
  | { type: 'item'; item: MenuItem }
  | { type: 'separator' }

/** 区切り線をはさみながら項目を並べる。空のまとまりは区切り線ごと落とす */
export function joinSections(sections: (MenuItem | null | false | undefined)[][]): MenuNode[] {
  const nodes: MenuNode[] = []

  for (const section of sections) {
    const items = section.filter((item): item is MenuItem => Boolean(item))
    if (items.length === 0) continue
    if (nodes.length > 0) nodes.push({ type: 'separator' })
    for (const item of items) nodes.push({ type: 'item', item })
  }

  return nodes
}

/** メニューの中で実際に押せる項目だけを取り出す（矢印キーの移動先を決めるのに使う） */
export function itemsOf(nodes: MenuNode[]): MenuItem[] {
  return nodes.flatMap((node) => (node.type === 'item' ? [node.item] : []))
}
