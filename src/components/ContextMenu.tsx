import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { placeMenu, type Placement } from '../lib/menuPlacement'
import { itemsOf, type MenuItem, type MenuNode } from '../lib/menuTypes'
import { ariaKeyshortcuts, formatShortcut } from '../lib/shortcuts'

interface Props {
  /** クリック位置（ビューポート基準） */
  x: number
  y: number
  nodes: MenuNode[]
  /** スクリーンリーダー向けのメニュー名 */
  label: string
  onClose: () => void
  /**
   * メニューを開いた要素が消えていたときの、フォーカスの戻り先。
   * 自分で消した付箋のほか、共同編集で他の人に消される場合もある。
   */
  fallbackFocus?: React.RefObject<HTMLElement | null>
}

/**
 * 右クリックで出すメニュー。
 *
 * 【置き場所の制約】ズームしているボード本体は transform: scale() の中にある。
 * transform は position: fixed の基準（包含ブロック）になってしまうので、
 * この要素はボードの外 —— WhiteboardTab のルート直下 —— に置くこと。
 * 中に置くとメニューまで倍率で拡大縮小され、位置もずれる。
 * 同じ理由で、祖先に filter / backdrop-filter / will-change: transform を足すと壊れる。
 *
 * モーダルではないので、フォーカスは閉じ込めない（Tab で閉じて次へ抜ける）。
 * 代わりに、外側の操作すべてで閉じるようにしてある。
 */
export default function ContextMenu({ x, y, nodes, label, onClose, fallbackFocus }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const openerRef = useRef<HTMLElement | null>(null)
  const focusedRef = useRef(false)

  const [placement, setPlacement] = useState<Placement | null>(null)
  const [active, setActive] = useState(0)

  const items = itemsOf(nodes)

  // 開いた時点のフォーカス位置を覚えておき、閉じるときに戻す。
  // 戻し先が消えていたらボードへ。ここを省くとフォーカスが body に落ちて、
  // キーボードで操作している人が迷子になる。
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null
    return () => {
      const opener = openerRef.current
      // 戻し先は閉じる瞬間の値でよい（開いた時点の値を控えると、その間に
      // ボードが差し替わっていたときに、消えた要素へ戻そうとしてしまう）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const target = opener?.isConnected ? opener : fallbackFocus?.current
      // 画面外の付箋へ戻すとボードが勝手にスクロールするので preventScroll
      target?.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 大きさが分かってからでないと置き場所を決められないので、
  // 1 回目は左上・不可視で描いて測り、2 回目で本来の位置に置く。
  // useLayoutEffect なので画面に出る前に終わり、ちらつかない。
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPlacement(
      placeMenu(
        { x, y },
        { w: rect.width, h: rect.height },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    )
  }, [x, y, nodes.length])

  // 置き場所が決まってから最初の項目へフォーカスする。
  // Escape を横取りする（＝ボードの選択解除に流さない）ためにも、
  // フォーカスがメニューの中にあることが要る。
  useEffect(() => {
    if (!placement || focusedRef.current) return
    focusedRef.current = true
    itemRefs.current[0]?.focus({ preventScroll: true })
  }, [placement])

  // 外側の操作では、何であれ閉じる
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('wheel', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    // scroll はバブルしないので、ボードのスクロールを拾うにはキャプチャで取る
    window.addEventListener('scroll', onClose, true)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  function focusItem(index: number) {
    setActive(index)
    itemRefs.current[index]?.focus({ preventScroll: true })
  }

  function move(delta: number) {
    if (items.length === 0) return
    focusItem((active + delta + items.length) % items.length)
  }

  function activate(item: MenuItem) {
    if (item.disabled) return
    void item.run()
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'Escape':
        // ボード側の「選択を解除」やモーダルの Esc に流さない
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      case 'Tab':
        // 閉じて、ふつうのタブ順の次へ抜ける（閉じ込めない）
        onClose()
        return
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        return
      case 'Home':
        e.preventDefault()
        focusItem(0)
        return
      case 'End':
        e.preventDefault()
        focusItem(items.length - 1)
        return
    }
  }

  // 項目の通し番号（区切り線は数えない）。矢印キーの移動先に使う
  let cursor = 0
  const rows = nodes.map((node, i) =>
    node.type === 'separator'
      ? { key: `separator-${i}`, node, index: -1 }
      : { key: node.item.id, node, index: cursor++ },
  )

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      // メニューの上でさらに右クリックしても、ブラウザ既定のメニューは出さない
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-56 overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl print:hidden"
      style={
        placement
          ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
          : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      {rows.map(({ key, node, index }) =>
        node.type === 'separator' ? (
          <div key={key} role="separator" className="my-1 h-px bg-slate-200" />
        ) : (
          <button
            key={key}
            ref={(el) => {
              itemRefs.current[index] = el
            }}
            type="button"
            role="menuitem"
            // 矢印キーで動かすので、Tab で入れるのは 1 つだけ
            tabIndex={index === active ? 0 : -1}
            // disabled 属性にすると矢印キーでも届かず、その操作があること自体が
            // 分からなくなる。押せないことは aria-disabled で伝えて、実行側で弾く
            aria-disabled={node.item.disabled || undefined}
            aria-keyshortcuts={ariaKeyshortcuts(node.item.shortcut)}
            title={node.item.disabled ? node.item.disabledReason : undefined}
            onClick={() => activate(node.item)}
            onMouseEnter={() => focusItem(index)}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left focus:outline-none ${
              node.item.disabled
                ? 'text-slate-300'
                : node.item.danger
                  ? 'text-rose-600 hover:bg-rose-50 focus:bg-rose-50'
                  : 'text-slate-700 hover:bg-slate-100 focus:bg-slate-100'
            }`}
          >
            <span className="truncate">
              {node.item.icon && <span className="mr-1.5">{node.item.icon}</span>}
              {node.item.label}
            </span>
            {node.item.shortcut && (
              <span className="shrink-0 text-xs text-slate-400">
                {formatShortcut(node.item.shortcut)}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  )
}
