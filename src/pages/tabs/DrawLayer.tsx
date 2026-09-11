import { memo, useEffect, useRef, useState } from 'react'
import type { Point, Stroke, StrokeKind } from '../../lib/types'

export type DrawTool = 'pen' | 'eraser' | 'line' | 'arrow' | 'rect' | 'ellipse'

interface Props {
  width: number
  height: number
  strokes: Stroke[]
  /** 描画系ツールを選んでいるときだけ操作を受け付ける */
  active: boolean
  tool: DrawTool
  color: string
  lineWidth: number
  /**
   * 変わったら描きかけの線を捨てる。
   * 2 本指のパン / ピンチが始まったとき、1 本目で引き始めた線を残さないため。
   */
  cancelNonce?: number
  onCommit: (kind: StrokeKind, points: Point[], color: string, lineWidth: number) => void
  onErase: (strokeId: string) => void
}

/** 消しゴムの当たり判定（ボード論理座標での半径） */
const ERASER_RADIUS = 12

/** 高解像度画面での描画倍率の上限。これ以上はメモリを食うだけで差が分からない */
const MAX_DPR = 2

interface Painted {
  ids: string[]
  dpr: number
  width: number
  height: number
}

interface Outline {
  points: Point[]
  /** [minX, minY, maxX, maxY]。当たり判定の前に矩形で絞る */
  bbox: [number, number, number, number]
}

function currentDpr(): number {
  return Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1))
}

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number) {
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/**
 * 手描き・図形レイヤー。
 * - 確定済みは下段キャンバスにまとめて描画（線が増えたときは追加分だけ描く）
 * - 描いている途中は上段キャンバスにローカル描画のみ（通信しない）
 * - 指を離した時点で 1 本まるごと 1 行として保存し、他の人には Realtime で届く
 */
function DrawLayer({
  width,
  height,
  strokes,
  active,
  tool,
  color,
  lineWidth,
  cancelNonce = 0,
  onCommit,
  onErase,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const currentRef = useRef<Point[] | null>(null)
  const [drawing, setDrawing] = useState(false)
  /** 下段キャンバスに描き終えている線の id 列。先頭一致なら追加分だけ描ける */
  const paintedRef = useRef<Painted>({ ids: [], dpr: 0, width: 0, height: 0 })
  /** 消しゴムの当たり判定用の折れ線と矩形。線は不変なので WeakMap で持てば十分 */
  const outlineCacheRef = useRef(new WeakMap<Stroke, Outline>())
  /** 1 回のなぞりで消した線。同じ線に消去を 2 回送らない */
  const erasedRef = useRef(new Set<string>())

  // 確定済みストロークの描画
  useEffect(() => {
    const canvas = baseRef.current
    if (!canvas) return

    const dpr = currentDpr()
    const painted = paintedRef.current
    const ids = strokes.map((s) => s.id)
    const canAppend =
      painted.dpr === dpr &&
      painted.width === width &&
      painted.height === height &&
      painted.ids.length <= ids.length &&
      painted.ids.every((id, index) => id === ids[index])

    let ctx: CanvasRenderingContext2D | null
    let from = 0
    if (canAppend) {
      ctx = canvas.getContext('2d')
      from = painted.ids.length
    } else {
      // 消された・順番が変わった・解像度が変わった → 全部描き直す
      ctx = setupCanvas(canvas, width, height, dpr)
      ctx?.clearRect(0, 0, width, height)
    }
    if (!ctx) return

    for (let i = from; i < strokes.length; i++) {
      const stroke = strokes[i]
      paintStroke(ctx, stroke.kind ?? 'free', stroke.points, stroke.color, stroke.width)
    }
    paintedRef.current = { ids, dpr, width, height }
    erasedRef.current.clear()
  }, [strokes, width, height])

  // 描きかけ用のキャンバスも同じ解像度にしておく
  useEffect(() => {
    const canvas = liveRef.current
    if (canvas) setupCanvas(canvas, width, height, currentDpr())
  }, [width, height])

  // 2 本指の操作が始まったら描きかけを捨てる
  useEffect(() => {
    if (cancelNonce === 0) return
    currentRef.current = null
    setDrawing(false)
    liveRef.current?.getContext('2d')?.clearRect(0, 0, width, height)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelNonce])

  function toLogical(e: React.PointerEvent<HTMLDivElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect()
    return [
      ((e.clientX - rect.left) / rect.width) * width,
      ((e.clientY - rect.top) / rect.height) * height,
    ]
  }

  function outlineOf(stroke: Stroke): Outline {
    const cache = outlineCacheRef.current
    const cached = cache.get(stroke)
    if (cached) return cached
    const points = outlinePoints(stroke.kind ?? 'free', stroke.points ?? [])
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of points) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    const outline: Outline = { points, bbox: [minX, minY, maxX, maxY] }
    cache.set(stroke, outline)
    return outline
  }

  function eraseAt(point: Point) {
    // 上に描かれたものから消したいので後ろから探す
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i]
      if (erasedRef.current.has(stroke.id)) continue

      const radius = ERASER_RADIUS + stroke.width / 2
      const { points, bbox } = outlineOf(stroke)
      if (
        point[0] < bbox[0] - radius ||
        point[0] > bbox[2] + radius ||
        point[1] < bbox[1] - radius ||
        point[1] > bbox[3] + radius
      ) {
        continue
      }
      if (hitsPolyline(points, point, radius)) {
        erasedRef.current.add(stroke.id)
        onErase(stroke.id)
        return
      }
    }
  }

  function repaintLive(points: Point[]) {
    const ctx = liveRef.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    paintStroke(ctx, toolKind(tool), points, color, lineWidth)
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.currentTarget.setPointerCapture(e.pointerId)
    const point = toLogical(e)

    if (tool === 'eraser') {
      erasedRef.current.clear()
      setDrawing(true)
      eraseAt(point)
      return
    }

    // 図形は始点と終点の 2 点だけを持つ
    currentRef.current = tool === 'pen' ? [point] : [point, point]
    setDrawing(true)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drawing) return
    const point = toLogical(e)

    if (tool === 'eraser') {
      eraseAt(point)
      return
    }

    const points = currentRef.current
    if (!points) return

    if (tool === 'pen') {
      // 細かすぎる点は間引く（保存サイズと描画コストを抑える）
      const last = points[points.length - 1]
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 2) return
      points.push(point)
    } else {
      points[1] = point
    }

    repaintLive(points)
  }

  function handlePointerUp() {
    if (!drawing) return
    setDrawing(false)

    const points = currentRef.current
    currentRef.current = null
    liveRef.current?.getContext('2d')?.clearRect(0, 0, width, height)

    if (tool === 'eraser' || !points) return

    if (tool === 'pen') {
      if (points.length > 1) onCommit('free', points, color, lineWidth)
      return
    }

    // 動かさずにクリックしただけの図形は作らない
    const [a, b] = points
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return
    onCommit(toolKind(tool), points, color, lineWidth)
  }

  return (
    <>
      {/* 画像レイヤー（z-1）より上、付箋（z-10）より下に描く。実際の解像度は effect で決める */}
      <canvas ref={baseRef} className="pointer-events-none absolute inset-0 z-[2] h-full w-full" />
      <canvas ref={liveRef} className="pointer-events-none absolute inset-0 z-[2] h-full w-full" />
      {active && (
        <div
          // ブラウザのテストがここを掴んで線を引く（置くための層の data-place-surface と同じ役目）
          data-draw-surface
          className="absolute inset-0 z-30 touch-none"
          style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}
    </>
  )
}

export default memo(DrawLayer)

function toolKind(tool: DrawTool): StrokeKind {
  return tool === 'pen' || tool === 'eraser' ? 'free' : tool
}

// =============================================================================
//  描画
// =============================================================================

function paintStroke(
  ctx: CanvasRenderingContext2D,
  kind: StrokeKind,
  points: Point[],
  color: string,
  lineWidth: number,
) {
  if (!points || points.length === 0) return

  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (kind === 'free') paintFreehand(ctx, points, color, lineWidth)
  else if (points.length >= 2) paintShape(ctx, kind, points[0], points[1], lineWidth)

  ctx.restore()
}

function paintFreehand(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  lineWidth: number,
) {
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0][0], points[0][1], lineWidth / 2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    return
  }

  // 中点をつないだ二次ベジェで滑らかにする
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i][0] + points[i + 1][0]) / 2
    const midY = (points[i][1] + points[i + 1][1]) / 2
    ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last[0], last[1])
  ctx.stroke()
}

function paintShape(
  ctx: CanvasRenderingContext2D,
  kind: StrokeKind,
  a: Point,
  b: Point,
  lineWidth: number,
) {
  if (kind === 'line' || kind === 'arrow') {
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()

    if (kind === 'arrow') {
      const head = Math.max(12, lineWidth * 3.5)
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0])
      ctx.beginPath()
      ctx.moveTo(b[0], b[1])
      ctx.lineTo(
        b[0] - head * Math.cos(angle - Math.PI / 7),
        b[1] - head * Math.sin(angle - Math.PI / 7),
      )
      ctx.lineTo(
        b[0] - head * Math.cos(angle + Math.PI / 7),
        b[1] - head * Math.sin(angle + Math.PI / 7),
      )
      ctx.closePath()
      ctx.fill()
    }
    return
  }

  if (kind === 'rect') {
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))
    return
  }

  if (kind === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      Math.abs(b[0] - a[0]) / 2,
      Math.abs(b[1] - a[1]) / 2,
      0,
      0,
      Math.PI * 2,
    )
    ctx.stroke()
  }
}

// =============================================================================
//  当たり判定
// =============================================================================

/** 消しゴム判定のために、図形を折れ線として近似する */
function outlinePoints(kind: StrokeKind, points: Point[]): Point[] {
  if (kind === 'free' || points.length < 2) return points
  const [a, b] = points

  if (kind === 'line' || kind === 'arrow') return [a, b]

  const left = Math.min(a[0], b[0])
  const right = Math.max(a[0], b[0])
  const top = Math.min(a[1], b[1])
  const bottom = Math.max(a[1], b[1])

  if (kind === 'rect') {
    return [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top],
    ]
  }

  // ellipse: 32 分割で近似
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const rx = (right - left) / 2
  const ry = (bottom - top) / 2
  const result: Point[] = []
  for (let i = 0; i <= 32; i++) {
    const t = (i / 32) * Math.PI * 2
    result.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)])
  }
  return result
}

function hitsPolyline(points: Point[], p: Point, radius: number): boolean {
  if (!points || points.length === 0) return false
  if (points.length === 1) {
    return Math.hypot(points[0][0] - p[0], points[0][1] - p[1]) <= radius
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (distanceToSegment(p, points[i], points[i + 1]) <= radius) return true
  }
  return false
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])

  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
