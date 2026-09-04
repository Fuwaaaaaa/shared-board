/**
 * コンテキストメニューを画面のどこに置くか。
 *
 * DOM に触らない算術だけにしてある。ブラウザ環境を用意せずにテストしたいのと、
 * 「はみ出したら反対側へ折り返す」という判断がいちばん間違えやすいところだから。
 *
 * 座標はすべてビューポート基準（clientX / clientY と同じ）。メニューは
 * position: fixed で出し、スクロールしたら閉じるので、スクロール量は足さない。
 */

export interface Placement {
  left: number
  top: number
  /** 画面に収まりきらないときの高さの上限。メニュー側で overflow-y: auto にする */
  maxHeight: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

/**
 * クリック位置にメニューを置く。右や下にはみ出すぶんは、クリック位置を挟んで
 * 反対側へ折り返す（右にはみ出すなら左へ伸ばす）。折り返してもなお収まらない場合は、
 * 画面内に押し込んだうえで maxHeight を縮める。
 */
export function placeMenu(anchor: Point, size: Size, viewport: Size, gutter = 8): Placement {
  const maxHeight = Math.max(0, viewport.h - gutter * 2)
  const height = Math.min(size.h, maxHeight)

  let left = anchor.x
  // 右にはみ出すなら左へ折り返す
  if (left + size.w > viewport.w - gutter) left = anchor.x - size.w

  let top = anchor.y
  // 下にはみ出すなら上へ折り返す
  if (top + height > viewport.h - gutter) top = anchor.y - height

  return {
    left: clamp(left, gutter, viewport.w - size.w - gutter),
    top: clamp(top, gutter, viewport.h - height - gutter),
    maxHeight,
  }
}

/**
 * 下限が上限を上回るときは下限を採る。
 * メニューが画面より大きいと max < min になるが、そこで負の座標を返すと
 * 左上が画面外へ飛んでスクロールもできなくなるため。
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(value, max))
}

/**
 * メニューを出す位置（アンカー）を決める。
 *
 * 基本はカーソルの座標をそのまま使う。
 *
 * キーボード（Shift+F10・アプリケーションキー）から開かれたときに座標が 0,0 に
 * なるブラウザがあるので、そのときだけフォーカス中の要素の左下へ寄せる。
 *
 * 【やってはいけないこと】contextmenu イベントの detail で「キーボードから
 * 開かれたか」を判定すること。Chrome はマウスの右クリックでも detail を 0 に
 * するので、マウス操作が全部キーボード扱いになり、メニューがカーソルから
 * 離れた場所に出てしまう。判定に使ってよいのは座標そのものだけ。
 */
export function menuAnchor(
  pointer: { x: number; y: number },
  focusedRect: { left: number; bottom: number } | null,
  viewport: Size,
): Point {
  if (pointer.x !== 0 || pointer.y !== 0) return { x: pointer.x, y: pointer.y }
  if (focusedRect) return { x: focusedRect.left, y: focusedRect.bottom }
  // フォーカスもどこにも無いときは、せめて画面の真ん中に出す
  return { x: viewport.w / 2, y: viewport.h / 2 }
}
