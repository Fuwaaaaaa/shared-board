/**
 * 付箋の文字サイズ。
 *
 * 保存する値は px。0 は「まだ決めていない」を意味し、付箋の種類ごとの既定を使う。
 * こうしておくと、この機能より前に作られた付箋（font_size が 0 で入る）も
 * 見た目が変わらないまま、あとから好きに変えられる。
 *
 * 画面と PNG 書き出しの両方がここを通る。以前は画面が Tailwind の固定クラス、
 * 書き出しが「高さ × 0.4」という別々の決め方をしていて、同じ付箋なのに
 * 見た目が食い違っていた。
 */

export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 64

/** 種類ごとの既定。text（見出し）は大きめ */
const DEFAULT_SIZE = { sticky: 14, text: 20 } as const

/**
 * ドラッグの距離に対する文字サイズの変化量。
 * 4px 動かして 1px 変わる。既定から上限まで動かすのに 200px ほどで、
 * 手首の動きに収まりつつ、細かく合わせられる速さ。
 */
const DRAG_RATE = 0.25

export function noteFontSize(kind: string, fontSize: number | undefined): number {
  if (!fontSize || fontSize <= 0) return kind === 'text' ? DEFAULT_SIZE.text : DEFAULT_SIZE.sticky
  return clampFontSize(fontSize)
}

/**
 * 長押しドラッグ中の文字サイズ。
 * dy は下方向が正なので、上へ動かすと大きくなるように符号を反転する。
 */
export function fontSizeFromDrag(base: number, dy: number): number {
  return clampFontSize(Math.round(base - dy * DRAG_RATE))
}

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIZE.sticky
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)))
}
