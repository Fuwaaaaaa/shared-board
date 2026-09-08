import { useEffect, useState } from 'react'

/** 何もしなかったことにする時間（ミリ秒） */
const HIDE_MS = 4000

/**
 * 画面の上に一時的に出す 1 行のお知らせ。
 *
 * 保存に失敗したことを伝える先として、useOptimisticTable が要求する。
 * これまでホワイトボードにしか無かったので、カレンダーとリマインドの
 * 保存失敗は黙って消えていた（画面だけ元に戻り、理由が出なかった）。
 */
export function useNotice() {
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  return [notice, setNotice] as const
}
