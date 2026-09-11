/**
 * ボード上の当たり判定。
 *
 * 「フレームの中に入っている付箋」の判定は、フレームを動かすときと
 * 右クリックの「中の付箋を選択」の両方で要る。ずれると片方だけ動く付箋が出るので、
 * 1 か所にまとめてある。DOM に触らないので、そのままテストできる。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 矩形の中に入っているものを選ぶ。
 *
 * 判定は「中心点が入っているか」。四隅すべてを求めると、フレームの縁に
 * はみ出しただけの付箋が置いていかれて、掴んで動かしたときに不自然になる。
 */
export function insideRect<T extends Rect>(items: T[], frame: Rect): T[] {
  return items.filter((item) => {
    const cx = item.x + item.w / 2
    const cy = item.y + item.h / 2
    return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h
  })
}

/** まとめて囲む矩形。padding はそれぞれの辺に足す余白 */
export function boundingBox(
  items: Rect[],
  padding: { top?: number; right?: number; bottom?: number; left?: number } = {},
): Rect | null {
  if (items.length === 0) return null

  const { top = 0, right = 0, bottom = 0, left = 0 } = padding
  const minX = Math.min(...items.map((i) => i.x))
  const minY = Math.min(...items.map((i) => i.y))
  const maxX = Math.max(...items.map((i) => i.x + i.w))
  const maxY = Math.max(...items.map((i) => i.y + i.h))

  // 左上をボードの外へ出さない。詰めたぶんは幅・高さで吸収して、
  // 右下の余白が削れないようにする
  const x = Math.max(0, minX - left)
  const y = Math.max(0, minY - top)
  return { x, y, w: maxX + right - x, h: maxY + bottom - y }
}

/**
 * 付箋どうしをつなぐ線の、両端の座標。
 *
 * 線は自分の座標を持たず、両端の付箋の位置から毎回計算する。
 * 画面（ConnectorsLayer）と PNG の書き出し（boardExport）の両方が呼ぶので、
 * ここに 1 つだけ置く。ずれると「画面と書き出しで線の向きが違う」ことになる。
 */
export function anchorPoints(from: Rect, to: Rect): [number, number, number, number] {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 }

  const start = edgePoint(fromCenter, toCenter, from.w / 2, from.h / 2)
  const end = edgePoint(toCenter, fromCenter, to.w / 2, to.h / 2)
  return [start.x, start.y, end.x, end.y]
}

function edgePoint(
  center: { x: number; y: number },
  toward: { x: number; y: number },
  halfW: number,
  halfH: number,
) {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  if (dx === 0 && dy === 0) return center

  // 矩形の縁に当たるまでの倍率を、縦横それぞれで求めて小さい方を採る
  const scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx)
  const scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)

  return { x: center.x + dx * scale, y: center.y + dy * scale }
}
