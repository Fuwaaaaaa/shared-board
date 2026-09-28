import { memo, useMemo, useRef, useState } from 'react'
import { FRAME_COLORS, type Frame } from '../../lib/types'
import { isComposingKey } from '../../lib/shortcuts'

// 色は lib/types.ts に置いてある（PNG の書き出しも同じものを使うため）。
// これまでここから取っていた呼び出し元のために、名前はそのまま通す
export { FRAME_COLORS }

const FRAME_COLOR_LABELS: Record<string, string> = {
  slate: 'グレー',
  blue: '青',
  green: '緑',
  pink: 'ピンク',
  amber: '黄色',
}

interface Props {
  frames: Frame[]
  interactive: boolean
  canEdit: boolean
  zoom: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** タイトルバーを掴んで動かしたとき（中の付箋も一緒に動く） */
  onDragMove: (frame: Frame, dx: number, dy: number) => void
  onDragEnd: () => void
  onLocalChange: (frame: Frame) => void
  onCommit: (id: string, patch: Partial<Frame>) => void
  onDelete: (frame: Frame) => void
  /** タイトルバーの「⋯」から、右クリックと同じメニューを開く */
  onOpenMenu: (id: string, rect: DOMRect) => void
}

const MIN_SIZE = 160

/** 領域を囲って名前をつけるフレーム。一番下のレイヤーに敷く。 */
function FramesLayer({
  frames,
  interactive,
  canEdit,
  zoom,
  selectedId,
  onSelect,
  onDragMove,
  onDragEnd,
  onLocalChange,
  onCommit,
  onDelete,
  onOpenMenu,
}: Props) {
  const ordered = useMemo(() => frames.slice().sort((a, b) => a.z - b.z), [frames])

  return (
    <div className="pointer-events-none absolute inset-0 z-0">
      {ordered.map((frame) => (
        <FrameItem
          key={frame.id}
          frame={frame}
          interactive={interactive}
          canEdit={canEdit}
          zoom={zoom}
          selected={selectedId === frame.id}
          onSelect={onSelect}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onLocalChange={onLocalChange}
          onCommit={onCommit}
          onDelete={onDelete}
          onOpenMenu={onOpenMenu}
        />
      ))}
    </div>
  )
}

export default memo(FramesLayer)

type DragState =
  | { kind: 'move'; startX: number; startY: number }
  | { kind: 'resize'; startX: number; startY: number; originW: number; originH: number }

const FrameItem = memo(function FrameItem({
  frame,
  interactive,
  canEdit,
  zoom,
  selected,
  onSelect,
  onDragMove,
  onDragEnd,
  onLocalChange,
  onCommit,
  onDelete,
  onOpenMenu,
}: {
  frame: Frame
  interactive: boolean
  canEdit: boolean
  zoom: number
  selected: boolean
  onSelect: (id: string | null) => void
  onDragMove: (frame: Frame, dx: number, dy: number) => void
  onDragEnd: () => void
  onLocalChange: (frame: Frame) => void
  onCommit: (id: string, patch: Partial<Frame>) => void
  onDelete: (frame: Frame) => void
  /** タイトルバーの「⋯」から、右クリックと同じメニューを開く */
  onOpenMenu: (id: string, rect: DOMRect) => void
}) {
  const palette = FRAME_COLORS[frame.color] ?? FRAME_COLORS.slate
  const dragRef = useRef<DragState | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(frame.title)

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    const dx = (e.clientX - drag.startX) / zoom
    const dy = (e.clientY - drag.startY) / zoom

    if (drag.kind === 'move') {
      onDragMove(frame, dx, dy)
    } else {
      onLocalChange({
        ...frame,
        w: Math.max(MIN_SIZE, drag.originW + dx),
        h: Math.max(MIN_SIZE, drag.originH + dy),
      })
    }
  }

  function handleUp() {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null

    if (drag.kind === 'move') onDragEnd()
    else if (frame.w !== drag.originW || frame.h !== drag.originH) {
      // いったん元の大きさへ戻してから確定する。親の commitFrame は
      // 「いま保持している行」を取り消しの戻り先にするので、書き換えたままだと
      // Ctrl+Z が効かない。色や名前の変更（ドラッグを伴わない）は今のままで正しい
      const { w, h } = frame
      onLocalChange({ ...frame, w: drag.originW, h: drag.originH })
      onCommit(frame.id, { w, h })
    }
  }

  return (
    <div
      className="absolute rounded-xl"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        border: `2px ${selected ? 'solid' : 'dashed'} ${palette.border}`,
        background: palette.bg,
        zIndex: frame.z,
      }}
    >
      {/*
        タイトルバー。ここを掴むとフレームごと動く。
        枠の内側は pointer-events を受け取らない（背景の範囲選択を通すため）ので、
        右クリックの対象になれるのもこのバーだけ
      */}
      <div
        data-ctx-kind="frame"
        data-ctx-id={frame.id}
        className={`absolute -top-7 left-0 flex max-w-full items-center gap-1 rounded-t-lg px-2 py-1 text-xs font-bold ${
          interactive && canEdit ? 'pointer-events-auto cursor-grab touch-none' : ''
        }`}
        style={{ background: palette.border, color: '#fff' }}
        onPointerDown={(e) => {
          // 左ボタン以外では掴まない（右クリックでの選択はコンテキストメニュー側）
          if (e.button !== 0 && e.pointerType === 'mouse') return
          if (!interactive || !canEdit || editing) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          onSelect(frame.id)
          dragRef.current = { kind: 'move', startX: e.clientX, startY: e.clientY }
        }}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onLostPointerCapture={handleUp}
        onDoubleClick={() => canEdit && setEditing(true)}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={() => {
              setEditing(false)
              if (draft !== frame.title) onCommit(frame.id, { title: draft })
            }}
            onKeyDown={(e) => {
              if (isComposingKey(e.nativeEvent)) return
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="w-40 bg-transparent text-white outline-none placeholder:text-white/60"
            placeholder="フレーム名"
          />
        ) : (
          <span className="truncate">{frame.title || 'フレーム'}</span>
        )}

        {selected && canEdit && !editing && (
          <>
            {Object.entries(FRAME_COLORS).map(([key, c]) => (
              <button
                key={key}
                type="button"
                title={FRAME_COLOR_LABELS[key] ?? key}
                aria-label={`${FRAME_COLOR_LABELS[key] ?? key}にする`}
                aria-pressed={frame.color === key}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onCommit(frame.id, { color: key })}
                className="h-3 w-3 rounded-full border border-white/60"
                style={{ background: c.border }}
              />
            ))}
            <button
              type="button"
              title="削除"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onDelete(frame)}
              className="ml-1 text-white/80 transition hover:text-white"
            >
              🗑
            </button>
            {/* 「中の付箋をまとめて選択」は、ここからしか手が届かない */}
            <button
              type="button"
              title="そのほかの操作"
              aria-label="そのほかの操作"
              aria-haspopup="menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => onOpenMenu(frame.id, e.currentTarget.getBoundingClientRect())}
              className="text-white/80 transition hover:text-white"
            >
              ⋯
            </button>
          </>
        )}
      </div>

      {interactive && canEdit && (
        <div
          title="サイズ変更"
          className="pointer-events-auto absolute right-0 bottom-0 h-5 w-5 cursor-nwse-resize touch-none"
          style={{ background: `linear-gradient(135deg, transparent 50%, ${palette.border} 50%)` }}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return
            e.stopPropagation()
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            onSelect(frame.id)
            dragRef.current = {
              kind: 'resize',
              startX: e.clientX,
              startY: e.clientY,
              originW: frame.w,
              originH: frame.h,
            }
          }}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          onLostPointerCapture={handleUp}
        />
      )}
    </div>
  )
})
