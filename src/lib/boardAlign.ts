/*
 * 付箋を並べ直したあとの位置。
 *
 * ホワイトボードの中に書いていたが、間違えても画面上は「なんとなく並ぶ」ので
 * 気づけない種類の計算なので、純粋関数として出してテストで固定する。
 * 保存と Undo は、これまでどおり呼び出し側が行う。
 */

export type AlignKind = 'left' | 'top' | 'row' | 'column' | 'grid'

/** 位置と大きさだけあれば決まる。付箋そのものは受け取らない */
export interface AlignTarget {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Placement {
  id: string
  x: number
  y: number
}

/** いちばん近い格子点に寄せる */
export function snapToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid
}

/**
 * 並べ直したあとの位置を返す。動かす必要が無ければ空の配列。
 *
 *   left   左端をいちばん左のものに揃える（縦の位置はそのまま）
 *   top    上端をいちばん上のものに揃える（横の位置はそのまま）
 *   row    左から順に、間隔 grid で横一列に並べる
 *   column 上から順に、間隔 grid で縦一列に並べる
 *   grid   それぞれをいちばん近い格子点に寄せる
 *
 * row / column の送り幅に、間隔だけでなく **その付箋の幅・高さ**を足しているのが
 * 肝心なところ。大きさがまちまちな付箋は、足し忘れると重なる。
 */
export function alignNotes(
  targets: readonly AlignTarget[],
  kind: AlignKind,
  grid: number,
): Placement[] {
  // 2 つ以上ないと「揃える」意味がない。格子への吸着だけは 1 つでも効く
  if (targets.length < 2 && kind !== 'grid') return []

  const list = targets.slice()

  if (kind === 'left') {
    const x = Math.min(...list.map((n) => n.x))
    return list.map((n) => ({ id: n.id, x, y: n.y }))
  }

  if (kind === 'top') {
    const y = Math.min(...list.map((n) => n.y))
    return list.map((n) => ({ id: n.id, x: n.x, y }))
  }

  if (kind === 'row') {
    const ordered = list.sort((a, b) => a.x - b.x)
    const y = ordered[0].y
    let cursor = ordered[0].x
    return ordered.map((n) => {
      const item = { id: n.id, x: cursor, y }
      cursor += n.w + grid
      return item
    })
  }

  if (kind === 'column') {
    const ordered = list.sort((a, b) => a.y - b.y)
    const x = ordered[0].x
    let cursor = ordered[0].y
    return ordered.map((n) => {
      const item = { id: n.id, x, y: cursor }
      cursor += n.h + grid
      return item
    })
  }

  return list.map((n) => ({
    id: n.id,
    x: snapToGrid(n.x, grid),
    y: snapToGrid(n.y, grid),
  }))
}
