import { memo, useMemo, useRef } from 'react'
import type { Attachment } from '../../lib/types'

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

const CARD_W = 200
const CARD_H = 84

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
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    onLocalChange({
      ...attachment,
      x: Math.max(0, attachment.x + (e.clientX - drag.startX) / zoom),
      y: Math.max(0, attachment.y + (e.clientY - drag.startY) / zoom),
    })
    dragRef.current = { startX: e.clientX, startY: e.clientY }
  }

  function handleUp() {
    if (!dragRef.current) return
    dragRef.current = null
    onCommit(attachment.id, { x: attachment.x, y: attachment.y })
  }

  return (
    <div
      data-ctx-kind="attachment"
      data-ctx-id={attachment.id}
      className={`absolute flex touch-none flex-col justify-between rounded-lg border border-slate-300 bg-white p-2 shadow-md ${
        interactive ? 'pointer-events-auto' : ''
      } ${selected ? 'ring-2 ring-slate-800' : ''}`}
      style={{ left: attachment.x, top: attachment.y, width: CARD_W, height: CARD_H, zIndex: attachment.z }}
      onPointerDown={(e) => {
        // 左ボタン以外では掴まない（右クリックでの選択はコンテキストメニュー側）
        if (e.button !== 0 && e.pointerType === 'mouse') return
        onSelect(attachment.id)
        if (!canEdit) return
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        dragRef.current = { startX: e.clientX, startY: e.clientY }
      }}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onLostPointerCapture={handleUp}
    >
      <div className="flex items-start gap-2">
        <span className="text-xl leading-none">{iconFor(attachment.mime, attachment.filename)}</span>
        <span className="min-w-0 flex-1 text-xs leading-tight break-all text-slate-800">
          {attachment.filename}
        </span>
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{formatSize(attachment.size)}</span>
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

function iconFor(mime: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (mime.includes('pdf') || ext === 'pdf') return '📕'
  if (['doc', 'docx'].includes(ext)) return '📘'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗'
  if (['ppt', 'pptx'].includes(ext)) return '📙'
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.startsWith('video/')) return '🎬'
  if (mime.startsWith('text/')) return '📄'
  return '📎'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
