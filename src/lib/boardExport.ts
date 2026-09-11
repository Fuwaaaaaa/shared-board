import {
  ATTACHMENT_CARD_H,
  ATTACHMENT_CARD_W,
  FRAME_COLORS,
  NOTE_COLORS,
  type Attachment,
  type BoardImage,
  type Connector,
  type Frame,
  type Note,
  type Point,
  type Stroke,
} from './types'
import { anchorPoints } from './boardGeometry'
import { attachmentIcon, formatFileSize } from './attachmentCard'
import { noteFontSize } from './noteFont'

interface ExportInput {
  width: number
  height: number
  /**
   * 切り出す左上の位置。省略するとボードの原点（0,0）。
   * 選んだ付箋だけを書き出すときに、その外接矩形を指す。
   */
  origin?: { x: number; y: number }
  notes: Note[]
  strokes: Stroke[]
  images: BoardImage[]
  frames: Frame[]
  /** 線は座標を持たないので、両端の付箋を引くために notes と一緒に渡す */
  connectors: Connector[]
  attachments: Attachment[]
  /** 画像の署名付き URL（storage_path をキーにしたもの） */
  imageUrls: Record<string, string>
  background: string
}

/**
 * ホワイトボードの内容を 1 枚の PNG にする。
 *
 * 画面の DOM をそのまま写すのではなく、保存されているデータから
 * Canvas に描き直しているので、スクロール位置やズームに左右されない。
 */
export async function renderBoardToBlob(input: ExportInput): Promise<Blob> {
  const { width, height } = input
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('キャンバスを作成できませんでした')

  ctx.fillStyle = input.background
  ctx.fillRect(0, 0, width, height)

  // 以降はボードの座標のまま描けるように原点をずらす。
  // 各描画関数が切り出しを意識しなくて済む
  if (input.origin) ctx.translate(-input.origin.x, -input.origin.y)

  /*
   * 描く順は画面のレイヤーの重なり（z-index）とそろえる。
   * フレーム(0) → 画像(1) → 手描き(2) → 線(3) → ファイル(8) → 付箋(10)。
   * ずれると「見たまま」にならない。
   */

  // 1. フレーム（一番下）
  for (const frame of [...input.frames].sort((a, b) => a.z - b.z)) {
    paintFrame(ctx, frame)
  }

  // 2. 画像
  for (const image of [...input.images].sort((a, b) => a.z - b.z)) {
    const url = input.imageUrls[image.storage_path]
    if (!url) continue
    try {
      const element = await loadImage(url)
      ctx.drawImage(element, image.x, image.y, image.w, image.h)
    } catch {
      // 読み込めなかった画像は枠だけ描いて先に進む
      ctx.strokeStyle = '#cbd5e1'
      ctx.strokeRect(image.x, image.y, image.w, image.h)
    }
  }

  // 3. 手描き・図形
  for (const stroke of input.strokes) {
    paintStroke(ctx, stroke)
  }

  // 4. 線（両端の付箋の位置から引く）
  const noteById = new Map(input.notes.map((note) => [note.id, note]))
  for (const connector of input.connectors) {
    const from = noteById.get(connector.from_note_id)
    const to = noteById.get(connector.to_note_id)
    if (from && to) paintConnector(ctx, connector, from, to)
  }

  // 5. ファイルのカード
  for (const attachment of [...input.attachments].sort((a, b) => a.z - b.z)) {
    paintAttachment(ctx, attachment)
  }

  // 6. 付箋・テキストボックス（一番上）
  for (const note of [...input.notes].sort((a, b) => a.z - b.z)) {
    paintNote(ctx, note)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('画像に変換できませんでした'))
    }, 'image/png')
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Supabase Storage は CORS を許可しているので、これでキャンバスが汚染されない
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('画像を読み込めませんでした'))
    img.src = url
  })
}

function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const points = stroke.points
  if (!points || points.length === 0) return

  ctx.save()
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const kind = stroke.kind ?? 'free'

  if (kind === 'free') {
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
  } else if (points.length >= 2) {
    paintShape(ctx, kind, points[0], points[1], stroke.width)
  }

  ctx.restore()
}

function paintShape(
  ctx: CanvasRenderingContext2D,
  kind: string,
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

  const left = Math.min(a[0], b[0])
  const top = Math.min(a[1], b[1])
  const w = Math.abs(b[0] - a[0])
  const h = Math.abs(b[1] - a[1])

  if (kind === 'rect') {
    ctx.strokeRect(left, top, w, h)
  } else if (kind === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/**
 * フレーム。画面と同じく、枠は破線・中は薄い塗り・タイトルは枠の上に載せる。
 * 選択中かどうかは書き出しに関係ないので、常に破線で描く。
 */
function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame) {
  const palette = FRAME_COLORS[frame.color] ?? FRAME_COLORS.slate

  ctx.save()
  ctx.fillStyle = palette.bg
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h)

  ctx.strokeStyle = palette.border
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h)
  ctx.setLineDash([])

  if (frame.title) {
    // タイトルバーは枠の上（画面の -top-7）に出す。ボードの外へは出さない
    const barH = 20
    const top = Math.max(0, frame.y - barH - 2)
    ctx.font = 'bold 12px sans-serif'
    const textW = ctx.measureText(frame.title).width
    const barW = Math.min(frame.w, textW + 16)

    ctx.fillStyle = palette.border
    roundRect(ctx, frame.x, top, barW, barH, 4)
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.save()
    ctx.beginPath()
    ctx.rect(frame.x, top, barW, barH)
    ctx.clip()
    ctx.fillText(frame.title, frame.x + 8, top + barH / 2)
    ctx.restore()
  }

  ctx.restore()
}

/**
 * 付箋どうしをつなぐ線。両端の座標は画面と同じ anchorPoints で求める。
 * 矢印の頭は手描きの図形と同じ paintShape に任せる。
 */
function paintConnector(
  ctx: CanvasRenderingContext2D,
  connector: Connector,
  from: Note,
  to: Note,
) {
  const [x1, y1, x2, y2] = anchorPoints(from, to)

  ctx.save()
  ctx.strokeStyle = connector.color
  ctx.fillStyle = connector.color
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  paintShape(ctx, connector.style, [x1, y1], [x2, y2], 2.5)

  if (connector.label) {
    const midX = (x1 + x2) / 2
    const midY = (y1 + y2) / 2
    ctx.font = '11px sans-serif'
    ctx.textBaseline = 'middle'
    const textW = ctx.measureText(connector.label).width

    ctx.fillStyle = '#ffffff'
    roundRect(ctx, midX - textW / 2 - 6, midY - 12, textW + 12, 24, 4)
    ctx.fill()
    ctx.strokeStyle = connector.color
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = '#0f172a'
    ctx.textAlign = 'center'
    ctx.fillText(connector.label, midX, midY)
    ctx.textAlign = 'start'
  }

  ctx.restore()
}

/**
 * ボードに置いたファイルのカード。
 *
 * 中身（PDF の 1 ページ目など）は描かない。画面でもカードとしてしか
 * 見えていないので、同じ見た目になれば「見たまま」になる。
 */
function paintAttachment(ctx: CanvasRenderingContext2D, attachment: Attachment) {
  const w = ATTACHMENT_CARD_W
  const h = ATTACHMENT_CARD_H

  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  roundRect(ctx, attachment.x, attachment.y, w, h, 8)
  ctx.fill()
  ctx.stroke()

  ctx.textBaseline = 'top'
  ctx.font = '20px sans-serif'
  ctx.fillStyle = '#0f172a'
  ctx.fillText(attachmentIcon(attachment.mime, attachment.filename), attachment.x + 8, attachment.y + 8)

  ctx.font = '12px sans-serif'
  ctx.fillStyle = '#1e293b'
  // アイコンのぶんだけ右に寄せ、下段（大きさ）に被らないところで折り返す
  wrapText(ctx, attachment.filename, attachment.x + 36, attachment.y + 8, w - 44, 15, 3)

  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#94a3b8'
  ctx.fillText(formatFileSize(attachment.size), attachment.x + 8, attachment.y + h - 16)

  ctx.restore()
}

function paintNote(ctx: CanvasRenderingContext2D, note: Note) {
  const palette = NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow
  const isText = note.kind === 'text'

  ctx.save()

  if (!isText) {
    ctx.fillStyle = palette.bg
    ctx.strokeStyle = palette.border
    ctx.lineWidth = 1
    roundRect(ctx, note.x, note.y, note.w, note.h, 8)
    ctx.fill()
    ctx.stroke()
  }

  // 画面と同じ決め方をする。以前ここだけ「高さ × 0.4」で決めていたため、
  // 同じ付箋なのに画面と書き出しで文字の大きさが食い違っていた
  const fontSize = noteFontSize(note.kind, note.font_size)

  ctx.fillStyle = '#0f172a'
  ctx.font = isText ? `bold ${fontSize}px sans-serif` : `${fontSize}px sans-serif`
  ctx.textBaseline = 'top'

  const padding = isText ? 8 : 12
  // 画面側の line-height 1.5 に合わせる
  const lineHeight = Math.round(fontSize * 1.5)
  wrapText(ctx, note.text, note.x + padding, note.y + padding, note.w - padding * 2, lineHeight)

  if (!isText && note.author_name) {
    ctx.fillStyle = '#64748b'
    ctx.font = '10px sans-serif'
    ctx.fillText(note.author_name, note.x + padding, note.y + note.h - 16)
  }

  ctx.restore()
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * 日本語は単語区切りが無いので 1 文字ずつ幅を測って折り返す。
 * maxLines を渡すと、そこで打ち切って末尾を … にする（ファイル名の欄で使う）。
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = Infinity,
) {
  if (!text) return

  let line = ''
  let offsetY = y
  let printed = 0

  const flush = (value: string) => {
    ctx.fillText(value, x, offsetY)
    printed++
    offsetY += lineHeight
  }

  for (const char of text) {
    if (printed >= maxLines) return
    if (char === '\n') {
      flush(line)
      line = ''
      continue
    }
    const candidate = line + char
    if (ctx.measureText(candidate).width > maxWidth && line) {
      // 最後の 1 行に入りきらないぶんは … にまとめる
      flush(printed === maxLines - 1 ? `${line}…` : line)
      line = char
    } else {
      line = candidate
    }
  }

  if (line && printed < maxLines) flush(line)
}
