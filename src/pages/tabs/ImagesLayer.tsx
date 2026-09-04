import { memo, useMemo, useRef } from 'react'
import type { BoardImage } from '../../lib/types'

interface Props {
  images: BoardImage[]
  urls: Record<string, string>
  interactive: boolean
  zoom: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLocalChange: (image: BoardImage) => void
  onCommit: (id: string, patch: Partial<BoardImage>) => void
  onDelete: (image: BoardImage) => void
}

const MIN_SIZE = 60

/** ボードに貼った画像。付箋より下のレイヤーに置く。 */
function ImagesLayer({
  images,
  urls,
  interactive,
  zoom,
  selectedId,
  onSelect,
  onLocalChange,
  onCommit,
  onDelete,
}: Props) {
  const ordered = useMemo(() => images.slice().sort((a, b) => a.z - b.z), [images])

  return (
    // 背景クリック（範囲選択）を通すため、コンテナ自体はイベントを受け取らない
    <div className="pointer-events-none absolute inset-0 z-[1]">
      {ordered.map((image) => (
        <BoardImageItem
          key={image.id}
          image={image}
          url={urls[image.storage_path]}
          interactive={interactive}
          zoom={zoom}
          selected={selectedId === image.id}
          onSelect={onSelect}
          onLocalChange={onLocalChange}
          onCommit={onCommit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

export default memo(ImagesLayer)

type DragState =
  | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'resize'; startX: number; startY: number; originW: number; originH: number; ratio: number }

const BoardImageItem = memo(function BoardImageItem({
  image,
  url,
  interactive,
  zoom,
  selected,
  onSelect,
  onLocalChange,
  onCommit,
  onDelete,
}: {
  image: BoardImage
  url: string | undefined
  interactive: boolean
  zoom: number
  selected: boolean
  onSelect: (id: string | null) => void
  onLocalChange: (image: BoardImage) => void
  onCommit: (id: string, patch: Partial<BoardImage>) => void
  onDelete: (image: BoardImage) => void
}) {
  const dragRef = useRef<DragState | null>(null)

  function beginDrag(e: React.PointerEvent, state: DragState) {
    // 左ボタン以外では掴まない（右クリックでの選択はコンテキストメニュー側）
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = state
    onSelect(image.id)
  }

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return

    const dx = (e.clientX - drag.startX) / zoom
    const dy = (e.clientY - drag.startY) / zoom

    if (drag.kind === 'move') {
      onLocalChange({
        ...image,
        x: Math.max(0, drag.originX + dx),
        y: Math.max(0, drag.originY + dy),
      })
    } else {
      // 縦横比は保ったままリサイズする
      const width = Math.max(MIN_SIZE, drag.originW + dx)
      onLocalChange({ ...image, w: width, h: Math.max(MIN_SIZE, width / drag.ratio) })
    }
  }

  function endDrag() {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null

    /*
     * どちらも、いったん元の値へ戻してから確定する。
     *
     * 親の commitImage は「いま保持している行」を取り消しの戻り先にするので、
     * ドラッグ中に onLocalChange で書き換えたままだと、戻り先が変更後の値になり、
     * Ctrl+Z が何もしないエントリになる。
     */
    if (drag.kind === 'move') {
      if (image.x !== drag.originX || image.y !== drag.originY) {
        const { x, y } = image
        onLocalChange({ ...image, x: drag.originX, y: drag.originY })
        onCommit(image.id, { x, y })
      }
    } else if (image.w !== drag.originW || image.h !== drag.originH) {
      const { w, h } = image
      onLocalChange({ ...image, w: drag.originW, h: drag.originH })
      onCommit(image.id, { w, h })
    }
  }

  return (
    <div
      data-ctx-kind="image"
      data-ctx-id={image.id}
      className={`absolute touch-none ${interactive ? 'pointer-events-auto' : ''} ${
        selected ? 'ring-2 ring-slate-800' : ''
      }`}
      style={{ left: image.x, top: image.y, width: image.w, height: image.h, zIndex: image.z }}
      onPointerDown={(e) =>
        beginDrag(e, {
          kind: 'move',
          startX: e.clientX,
          startY: e.clientY,
          originX: image.x,
          originY: image.y,
        })
      }
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      {url ? (
        <img
          src={url}
          alt={`${image.author_name}が貼った画像`}
          draggable={false}
          className="no-select h-full w-full rounded object-contain shadow-md"
        />
      ) : (
        <div className="grid h-full w-full place-items-center rounded bg-slate-100 text-xs text-slate-400 shadow-md">
          読み込み中…
        </div>
      )}

      {selected && (
        <div className="absolute -top-9 left-0 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-sm">
          <span className="text-[10px] text-slate-500">{image.author_name}</span>
          <button
            type="button"
            title="削除"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(image)}
            className="text-sm text-slate-400 transition hover:text-rose-600"
          >
            🗑
          </button>
        </div>
      )}

      <div
        title="サイズ変更"
        className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize bg-slate-800/70"
        style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
        onPointerDown={(e) =>
          beginDrag(e, {
            kind: 'resize',
            startX: e.clientX,
            startY: e.clientY,
            originW: image.w,
            originH: image.h,
            ratio: image.w / Math.max(1, image.h),
          })
        }
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
    </div>
  )
})
