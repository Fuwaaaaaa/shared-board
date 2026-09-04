/**
 * 画像を貼る前に縮めておく。
 *
 * スマホの写真は 4000px 超・数 MB が普通で、そのまま置くとボードの表示も
 * 通信も重くなる。長辺 1600px・WebP に落としてから送る。
 * EXIF の回転は createImageBitmap の imageOrientation で吸収する。
 */
export interface PreparedImage {
  blob: Blob
  contentType: string
  ext: string
  width: number
  height: number
  /** 縮小・再エンコードしたか（false なら元ファイルそのまま） */
  resized: boolean
}

interface Options {
  /** 長辺の上限（px） */
  maxEdge?: number
  /** 非可逆圧縮の品質 */
  quality?: number
}

/** これ以下なら再エンコードせず元のまま使う */
const KEEP_BYTES = 600 * 1024

const EXT_FOR: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

function extOf(file: File): string {
  return (
    EXT_FOR[file.type] ??
    (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '')
  )
}

type Source = ImageBitmap | HTMLImageElement

async function loadSource(file: File): Promise<{ source: Source; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height }
    } catch {
      /* 古いブラウザや壊れたファイルは <img> にフォールバック */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像を読み込めませんでした'))
    }
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function prepareImageForUpload(
  file: File,
  { maxEdge = 1600, quality = 0.85 }: Options = {},
): Promise<PreparedImage> {
  const asIs = (width: number, height: number): PreparedImage => ({
    blob: file,
    contentType: file.type || 'application/octet-stream',
    ext: extOf(file),
    width,
    height,
    resized: false,
  })

  // アニメーション GIF と SVG は再エンコードすると壊れる（動かなくなる / ラスタ化される）
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    const { source, width, height } = await loadSource(file).catch(() => ({
      source: null,
      width: 0,
      height: 0,
    }))
    if (source && 'close' in source) source.close()
    return asIs(width, height)
  }

  const { source, width, height } = await loadSource(file)
  const longEdge = Math.max(width, height)

  if (longEdge <= maxEdge && file.size <= KEEP_BYTES) {
    if ('close' in source) source.close()
    return asIs(width, height)
  }

  const scale = Math.min(1, maxEdge / Math.max(1, longEdge))
  const outW = Math.max(1, Math.round(width * scale))
  const outH = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    if ('close' in source) source.close()
    return asIs(width, height)
  }
  ctx.drawImage(source, 0, 0, outW, outH)
  if ('close' in source) source.close()

  // WebP を試し、対応していないブラウザ（Safari の古い版など）は PNG / JPEG に落とす
  let blob = await toBlob(canvas, 'image/webp', quality)
  if (!blob || blob.type !== 'image/webp') {
    blob =
      file.type === 'image/png'
        ? await toBlob(canvas, 'image/png')
        : await toBlob(canvas, 'image/jpeg', quality)
  }
  if (!blob) return asIs(width, height)

  // 縮めたのに大きくなった（小さな PNG の図など）なら元を使う
  if (scale === 1 && blob.size >= file.size) return asIs(width, height)

  return {
    blob,
    contentType: blob.type,
    ext: EXT_FOR[blob.type] ?? 'jpg',
    width: outW,
    height: outH,
    resized: true,
  }
}
