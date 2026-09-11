import { useEffect, useRef } from 'react'

/**
 * 検索・通知・更新タブから「これを見せて」と飛んできたとき、1 回だけ合わせる。
 *
 * rows を見ているのは、飛んできた時点ではまだ読み込めていないことがあるため。
 * 行が届いてからもう一度ここへ来ないと、何も起きずに終わってしまう。
 *
 * ただし合わせるのは 1 回だけにする。focusId は同じタブにいるあいだ消えないので、
 * 素直に rows へ反応させると、誰かが 1 行書き換えるたびに
 *
 *   - ボード: 選択が奪われ、画面が勝手にスクロールする
 *   - 暦・やること: 閉じたはずの編集モーダルが開き直す
 *
 * ということが起きる。自分では何もしていないので、原因も分からない。
 *
 * apply が false を返したときは「まだ合わせられなかった」とみなし、
 * 次に rows が変わったときにもう一度試す（置き場所がまだ無いときのため）。
 */
export function useFocusJump<T extends { id: string }>(
  focusId: string | null,
  focusNonce: number,
  rows: T[],
  apply: (row: T) => boolean | void,
): void {
  const doneRef = useRef('')
  // apply は毎レンダー作り直されるので、依存には入れず ref で最新を見る
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    if (!focusId) return

    const token = `${focusId}:${focusNonce}`
    if (doneRef.current === token) return

    const row = rows.find((r) => r.id === focusId)
    if (!row) return

    if (applyRef.current(row) === false) return
    doneRef.current = token
  }, [focusId, focusNonce, rows])
}
