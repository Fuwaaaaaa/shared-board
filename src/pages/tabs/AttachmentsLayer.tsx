import { memo, useMemo, useRef } from 'react'
import { attachmentIcon, formatFileSize } from '../../lib/attachmentCard'
import {
  ATTACHMENT_CARD_H,
  ATTACHMENT_CARD_W,
  type Attachment,
} from '../../lib/types'

interface Props {
  attachments: Attachment[]
  urls: Record<string, string>
  interactive: boolean
  canEdit: boolean
  zoom: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLocalChange: (attachment: Attachment) => void
  onCommit: (id: string, patch: Partial<Attachment>) => void
  onDelete: (attachment: Attachment) => void
}


interface DragState {
  startX: number
  startY: number
  /** 掴んだ時点の位置。取り消しの戻り先になる */
  originX: number
  originY: number
}

/** ボードに置いたファイル（PDF など）のカード */
function AttachmentsLayer({
  attachments,
  urls,
  interactive,
  canEdit,
  zoom,
  selectedId,
  onSelect,
  onLocalChange,
  onCommit,
  onDelete,
}: Props) {
  const ordered = useMemo(() => attachments.slice().sort((a, b) => a.z - b.z), [attachments])

  return (
    <div className="pointer-events-none absolute inset-0 z-[8]">
      {ordered.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          attachment={attachment}
          url={urls[attachment.storage_path]}
          interactive={interactive}
          canEdit={canEdit}
          zoom={zoom}
          selected={selectedId === attachment.id}
          onSelect={onSelect}
          onLocalChange={onLocalChange}
          onCommit={onCommit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

export default memo(AttachmentsLayer)

const AttachmentCard = memo(function AttachmentCard({
  attachment,
  url,
  interactive,
  canEdit,
  zoom,
  selected,
  onSelect,
  onLocalChange,
  onCommit,
  onDelete,
}: {
  attachment: Attachment
  url: string | undefined
  interactive: boolean
  canEdit: boolean
  zoom: number
  selected: boolean
  onSelect: (id: string | null) => void
  onLocalChange: (attachment: Attachment) => void
  onCommit: (id: string, patch: Partial<Attachment>) => void
  onDelete: (attachment: Attachment) => void
}) {
  const dragRef = useRef<DragState | null>(null)

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    onLocalChange({
      ...attachment,
      x: Math.max(0, drag.originX + (e.clientX - drag.startX) / zoom),
      y: Math.max(0, drag.originY + (e.clientY - drag.startY) / zoom),
    })
  }

  function handleUp() {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (attachment.x === drag.originX && attachment.y === drag.originY) return

    /*
     * いったん元の位置へ戻してから確定する。
     *
     * 親の commitAttachment は「いま保持している行」を取り消しの戻り先にするので、
     * ドラッグ中に onLocalChange で書き換えたままだと、戻り先が動かした先になり、
     * Ctrl+Z が何もしないエントリになる。ImagesLayer も同じ形。
     */
    const { x, y } = attachment
    onLocalChange({ ...attachment, x: drag.originX, y: drag.originY })
    onCommit(attachment.id, { x, y })
  }

  return (
    <div
      data-ctx-kind="attachment"
      data-ctx-id={attachment.id}
      className={`absolute flex touch-none flex-col justify-between rounded-lg border border-slate-300 bg-white p-2 shadow-md ${
        interactive ? 'pointer-events-auto' : ''
      } ${selected ? 'ring-2 ring-slate-800' : ''}`}
      style={{ left: attachment.x, top: attachment.y, width: ATTACHMENT_CARD_W, height: ATTACHMENT_CARD_H, zIndex: attachment.z }}
      onPointerDown={(e) => {
        // 左ボタン以外では掴まない（右クリックでの選択はコンテキストメニュー側）
        if (e.button !== 0 && e.pointerType === 'mouse') return
        onSelect(attachment.id)
        if (!canEdit) return
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          originX: attachment.x,
          originY: attachment.y,
        }
      }}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onLostPointerCapture={handleUp}
    >
      <div className="flex items-start gap-2">
        <span className="text-xl leading-none">{attachmentIcon(attachment.mime, attachment.filename)}</span>
        <span className="min-w-0 flex-1 text-xs leading-tight break-all text-slate-800">
          {attachment.filename}
        </span>
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{formatFileSize(attachment.size)}</span>
        <span className="flex items-center gap-2">
          {url ? (
            <a
              href={url}
              download={attachment.filename}
              target="_blank"
              rel="noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
              className="text-slate-500 underline transition hover:text-slate-900"
            >
              開く
            </a>
          ) : (
            <span>読み込み中…</span>
          )}
          {selected && canEdit && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onDelete(attachment)}
              className="transition hover:text-rose-600"
            >
              🗑
            </button>
          )}
        </span>
      </div>
    </div>
  )
})

