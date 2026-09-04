import { useEffect, useRef, type ReactNode } from 'react'
import { registerModal } from '../lib/modalStack'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** 画面中央に出すシンプルなモーダル。Esc と背景クリックで閉じる。 */
export default function Modal({ title, onClose, children, footer }: Props) {
  const handleRef = useRef<ReturnType<typeof registerModal> | null>(null)

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 重ねて開いているときは、いちばん手前の 1 枚だけが閉じる
      if (e.key === 'Escape' && handleRef.current?.isTop()) onClose()
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
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="font-bold text-slate-800">{title}</h2>
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
