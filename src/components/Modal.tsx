import { useEffect, useId, useRef, type ReactNode } from 'react'
import { registerModal } from '../lib/modalStack'
import { focusableIn, nextFocus } from '../lib/focusTrap'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** 画面中央に出すシンプルなモーダル。Esc と背景クリックで閉じる。 */
export default function Modal({ title, onClose, children, footer }: Props) {
  const handleRef = useRef<ReturnType<typeof registerModal> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  /*
   * 開いている間ずっと台帳に載せる。依存配列は空にすること。
   * onClose は親が毎回作り直していることが多く（onClose={() => setTarget(null)} など）、
   * 下の effect に相乗りさせると登録し直しが起きて重なり順が壊れる。
   * StrictMode では登録→解除→登録と 2 回走るが、トークンで消すので漏れはない。
   */
  useEffect(() => {
    handleRef.current = registerModal()
    return () => {
      handleRef.current?.unregister()
      handleRef.current = null
    }
  }, [])

  /*
   * 開いたら中へ、閉じたら元の場所へフォーカスを戻す。
   *
   * すでに中に当たっているときは動かさない。autoFocus を置いてある画面
   * （合言葉の入力など）から、開いた瞬間にフォーカスを奪わないため。
   * 戻す先が画面から消えていることもあるので、つながっているか確かめる。
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const previous = document.activeElement as HTMLElement | null
    if (!panel.contains(document.activeElement)) {
      ;(focusableIn(panel)[0] ?? panel).focus()
    }

    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 重ねて開いているときは、いちばん手前の 1 枚だけが受け取る
      if (!handleRef.current?.isTop()) return

      if (e.key === 'Escape') {
        onClose()
        return
      }

      /*
       * Tab を中で回す。回さないと、背後の画面のボタンへ順に抜けていき、
       * 「閉じたつもりが背後を押していた」が起きる。
       */
      if (e.key === 'Tab') {
        const target = nextFocus(focusableIn(panelRef.current), document.activeElement, e.shiftKey)
        if (!target) return

        target.focus()
        /*
         * 実際に移ったときだけ既定を止める。focusableIn が「当てても移らない要素」を
         * 拾ってしまったとき、ここで既定まで殺すと Tab が二度と進まなくなる。
         * ブラウザに任せれば、少なくとも先へは進む。
         */
        if (document.activeElement === target) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // 中にフォーカスできるものが 1 つも無いときの当て先
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 id={titleId} className="font-bold text-slate-800">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  )
}
