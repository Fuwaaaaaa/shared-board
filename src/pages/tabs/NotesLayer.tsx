import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { NOTE_COLORS, REACTION_EMOJIS, noteStyle, type Note } from '../../lib/types'
import { useTheme } from '../../lib/theme'
import { fontSizeFromDrag, noteFontSize } from '../../lib/noteFont'

/** 付箋ごとの「絵文字 → 件数と自分が押したか」 */
export type ReactionMap = Record<string, Record<string, { count: number; mine: boolean }>>

export interface NoteDragDelta {
  dx: number
  dy: number
}

interface Props {
  notes: Note[]
  /** 選択モードのときだけ触れる */
  interactive: boolean
  /** false なら「閲覧のみ」。選んでコメント・投票はできるが、動かせない */
  canEdit: boolean
  zoom: number
  selectedIds: string[]
  /** 検索から飛んできた付箋を光らせる */
  highlightId: string | null
  voteCounts: Record<string, number>
  myVotes: Set<string>
  reactions: ReactionMap
  /** 付箋をつなぐモードのとき、始点に選ばれている付箋 */
  connectFromId: string | null
  /** 付箋 id → いま本文を編集している他の人の名前 */
  editingByOthers: Map<string, string>
  onToggleReaction: (note: Note, emoji: string) => void
  onSelect: (id: string, additive: boolean) => void
  /** 選択中の付箋をまとめて動かす（ローカル反映のみ） */
  onDragMove: (delta: NoteDragDelta) => void
  onDragEnd: () => void
  onLocalChange: (note: Note) => void
  onCommit: (id: string, patch: Partial<Note>) => void
  onDelete: (note: Note) => void
  onOpenComments: (note: Note) => void
  /** ツールバーの「⋯」から、右クリックと同じメニューを開く */
  onOpenMenu: (id: string, rect: DOMRect) => void
  onToggleVote: (note: Note) => void
  /** 自分が本文の編集を始めた / やめた（他の人の画面に「編集中」を出すため） */
  onEditingChange: (noteId: string | null) => void
  commentCounts: Record<string, number>
  /** この付箋から生まれた やること / 予定 の件数 */
  linkCounts: LinkCounts
  onConvert: (note: Note, target: 'todo' | 'event') => void
  /** 生まれた先のタブへ飛ぶ */
  onOpenLink: (note: Note, target: 'todo' | 'event') => void
}

/**
 * 付箋 id → その付箋から生まれた やること / 予定 の件数。
 * stale は「この付箋を直したあと、まだ反映していないもの」の件数。
 */
export type LinkCounts = Record<string, { todos: number; events: number; stale: number }>

const MIN_W = 120
const MIN_H = 60

function NotesLayer({
  notes,
  interactive,
  canEdit,
  zoom,
  selectedIds,
  highlightId,
  voteCounts,
  myVotes,
  reactions,
  connectFromId,
  editingByOthers,
  onToggleReaction,
  onSelect,
  onDragMove,
  onDragEnd,
  onLocalChange,
  onCommit,
  onDelete,
  onOpenComments,
  onOpenMenu,
  onToggleVote,
  onEditingChange,
  commentCounts,
  linkCounts,
  onConvert,
  onOpenLink,
}: Props) {
  // z 順の並べ替えは付箋が変わったときだけ
  const ordered = useMemo(() => notes.slice().sort((a, b) => a.z - b.z), [notes])
  const multi = selectedIds.length > 1

  return (
    // 背景クリック（範囲選択）を通すため、コンテナ自体はイベントを受け取らない
    <div className="pointer-events-none absolute inset-0 z-10">
      {ordered.map((note) => (
        <NoteItem
          key={note.id}
          note={note}
          interactive={interactive}
          canEdit={canEdit}
          zoom={zoom}
          selected={selectedIds.includes(note.id)}
          multiSelected={multi && selectedIds.includes(note.id)}
          highlighted={highlightId === note.id}
          voteCount={voteCounts[note.id] ?? 0}
          voted={myVotes.has(note.id)}
          reactions={reactions[note.id]}
          connectSource={connectFromId === note.id}
          editingBy={editingByOthers.get(note.id)}
          onToggleReaction={onToggleReaction}
          commentCount={commentCounts[note.id] ?? 0}
          onSelect={onSelect}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onLocalChange={onLocalChange}
          onCommit={onCommit}
          onDelete={onDelete}
          onOpenComments={onOpenComments}
          onOpenMenu={onOpenMenu}
          onToggleVote={onToggleVote}
          onEditingChange={onEditingChange}
          links={linkCounts[note.id]}
          onConvert={onConvert}
          onOpenLink={onOpenLink}
        />
      ))}
    </div>
  )
}

export default memo(NotesLayer)

type DragState =
  | { kind: 'move'; startX: number; startY: number }
  | { kind: 'resize'; startX: number; startY: number; originW: number; originH: number }
  /**
   * 長押しから入る文字サイズの調整。startY からの上下で大きさを決める。
   * originStored は保存されていた値（0 = 既定）で、取り消したときの戻り先。
   */
  | { kind: 'font'; startX: number; startY: number; originSize: number; originStored: number }

interface NoteItemProps {
  note: Note
  interactive: boolean
  canEdit: boolean
  zoom: number
  selected: boolean
  multiSelected: boolean
  highlighted: boolean
  voteCount: number
  voted: boolean
  reactions: Record<string, { count: number; mine: boolean }> | undefined
  connectSource: boolean
  /** この付箋を編集中の他の人の名前 */
  editingBy: string | undefined
  onToggleReaction: (note: Note, emoji: string) => void
  commentCount: number
  onSelect: (id: string, additive: boolean) => void
  onDragMove: (delta: NoteDragDelta) => void
  onDragEnd: () => void
  onLocalChange: (note: Note) => void
  onCommit: (id: string, patch: Partial<Note>) => void
  onDelete: (note: Note) => void
  onOpenComments: (note: Note) => void
  /** ツールバーの「⋯」から、右クリックと同じメニューを開く */
  onOpenMenu: (id: string, rect: DOMRect) => void
  onToggleVote: (note: Note) => void
  onEditingChange: (noteId: string | null) => void
  links: LinkCounts[string] | undefined
  onConvert: (note: Note, target: 'todo' | 'event') => void
  onOpenLink: (note: Note, target: 'todo' | 'event') => void
}

function sameReactions(
  a: NoteItemProps['reactions'],
  b: NoteItemProps['reactions'],
): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    const x = a[key]
    const y = b[key]
    if (!y || x.count !== y.count || x.mine !== y.mine) return false
  }
  return true
}

function sameLinks(a: NoteItemProps['links'], b: NoteItemProps['links']): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  return a.todos === b.todos && a.events === b.events && a.stale === b.stale
}

/**
 * reactions と links は親が毎回作り直す小さなオブジェクトなので中身で比べ、
 * それ以外（note・ハンドラ・真偽値）は参照で比べる。
 * キーを走査するので、prop を足しても比較から漏れない。
 */
function areNotePropsEqual(prev: NoteItemProps, next: NoteItemProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof NoteItemProps>
  for (const key of keys) {
    if (key === 'reactions') {
      if (!sameReactions(prev.reactions, next.reactions)) return false
    } else if (key === 'links') {
      if (!sameLinks(prev.links, next.links)) return false
    } else if (!Object.is(prev[key], next[key])) {
      return false
    }
  }
  return true
}

const NoteItem = memo(function NoteItem({
  note,
  interactive,
  canEdit,
  zoom,
  selected,
  multiSelected,
  highlighted,
  voteCount,
  voted,
  reactions,
  connectSource,
  editingBy,
  onToggleReaction,
  commentCount,
  onSelect,
  onDragMove,
  onDragEnd,
  onLocalChange,
  onCommit,
  onDelete,
  onOpenComments,
  onOpenMenu,
  onToggleVote,
  onEditingChange,
  links,
  onConvert,
  onOpenLink,
}: NoteItemProps) {
  const [editing, setEditing] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [draft, setDraft] = useState(note.text)
  /** 長押しから文字サイズを調整している最中か（バッジの表示にも使う） */
  const [sizing, setSizing] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const longPressRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dark = useTheme().resolved === 'dark'

  const isText = note.kind === 'text'
  const fontSize = noteFontSize(note.kind, note.font_size)
  const style = noteStyle(note.color, dark)
  // テキストボックスは背景なし。文字色だけテーマに合わせる
  const textColor = isText ? (dark ? '#e2e8f0' : '#1e293b') : style.text
  const chipClass = dark ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'

  // 他の人の編集が届いたら、自分が編集中でない限り取り込む
  useEffect(() => {
    if (!editing) setDraft(note.text)
  }, [note.text, editing])

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  // 編集中であることを他の人に知らせる。アンマウント（タブ切替）でも必ず解除する
  useEffect(() => {
    if (!editing) return
    onEditingChange(note.id)
    return () => onEditingChange(null)
  }, [editing, note.id, onEditingChange])

  // 選択が外れたら絵文字パレットも畳む
  useEffect(() => {
    if (!selected) setShowEmoji(false)
  }, [selected])

  // タブを切り替えるなどして消えるときに、待っているタイマーを残さない
  useEffect(() => cancelLongPress, [])

  /** 長押しの待ち時間。押したつもりが動いてしまう事故が起きにくい長さ */
  const LONG_PRESS_MS = 400
  /** これ以上動いたら「掴んで運びたい」とみなして、長押しは取り消す */
  const LONG_PRESS_SLOP = 6

  function cancelLongPress() {
    if (longPressRef.current === null) return
    window.clearTimeout(longPressRef.current)
    longPressRef.current = null
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (editing) return
    // 左ボタン以外では掴まない。掴むとコンテキストメニューを開いている間に
    // 付箋が動いてしまう。右クリックでの選択はメニュー側が行う
    if (e.button !== 0 && e.pointerType === 'mouse') return
    onSelect(note.id, e.shiftKey || e.ctrlKey || e.metaKey)
    if (!canEdit) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { kind: 'move', startX: e.clientX, startY: e.clientY }

    // マウスで押しっぱなしにしたら、文字サイズの調整に切り替える。
    // 指は 2 本指の操作（拡大縮小・画面移動）と取り合いになるので対象外
    if (e.pointerType !== 'mouse') return
    const startX = e.clientX
    const startY = e.clientY
    cancelLongPress()
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null
      // ここまで動いていなければ、運ぶ気は無いと判断してよい
      dragRef.current = {
        kind: 'font',
        startX,
        startY,
        originSize: noteFontSize(note.kind, note.font_size),
        originStored: note.font_size,
      }
      setSizing(true)
    }, LONG_PRESS_MS)
  }

  function handleResizeDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.stopPropagation()
    cancelLongPress()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSelect(note.id, false)
    dragRef.current = {
      kind: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      originW: note.w,
      originH: note.h,
    }
  }

  function handleMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return

    const dx = (e.clientX - drag.startX) / zoom
    const dy = (e.clientY - drag.startY) / zoom

    // 待っている間に動いたら、運びたいのだと判断して長押しを取り消す
    if (longPressRef.current !== null && Math.hypot(dx * zoom, dy * zoom) > LONG_PRESS_SLOP) {
      cancelLongPress()
    }

    if (drag.kind === 'font') {
      // ズームで割らない生の移動量を使う。画面上で同じだけ動かせば
      // 同じだけ変わるほうが、拡大していても手の感覚と合う
      const next = fontSizeFromDrag(drag.originSize, e.clientY - drag.startY)
      if (next !== noteFontSize(note.kind, note.font_size)) {
        onLocalChange({ ...note, font_size: next })
      }
      return
    }

    if (drag.kind === 'move') {
      // 選択中の付箋をまとめて動かす（親が全体をまとめて更新する）
      onDragMove({ dx, dy })
    } else {
      onLocalChange({
        ...note,
        w: Math.max(MIN_W, drag.originW + dx),
        h: Math.max(MIN_H, drag.originH + dy),
      })
    }
  }

  function handleUp() {
    cancelLongPress()
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null

    if (drag.kind === 'font') {
      setSizing(false)
      const next = note.font_size
      if (next === drag.originStored) return

      /*
       * いったん元の値に戻してから確定する。
       *
       * 親の commitNote は「いま保持している行」を取り消しの戻り先にするので、
       * ドラッグ中に onLocalChange で書き換えたままだと、戻り先が変更後の値になり
       * Ctrl+Z が何もしないエントリになってしまう。
       */
      onLocalChange({ ...note, font_size: drag.originStored })
      onCommit(note.id, { font_size: next })
      return
    }

    if (drag.kind === 'move') {
      onDragEnd()
    } else if (note.w !== drag.originW || note.h !== drag.originH) {
      // 文字サイズと同じ理由で、いったん元の大きさに戻してから確定する。
      // 書き換えたままだと取り消しの戻り先が変更後の値になり、Ctrl+Z が効かない
      const { w, h } = note
      onLocalChange({ ...note, w: drag.originW, h: drag.originH })
      onCommit(note.id, { w, h })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // 付箋そのものにフォーカスがあるときだけ（ツールバーのボタンには反応しない）
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' && canEdit && !editing) {
      e.preventDefault()
      setEditing(true)
    }
  }

  const ringClass = connectSource
    ? 'ring-4 ring-emerald-500'
    : highlighted
      ? 'ring-4 ring-amber-400 animate-pulse'
      : multiSelected
        ? 'ring-2 ring-blue-500'
        : selected
          ? 'ring-2 ring-slate-800'
          : ''

  const reactionEntries = Object.entries(reactions ?? {}).filter(([, v]) => v.count > 0)
  const summary = note.text.replace(/\s+/g, ' ').trim().slice(0, 30) || '（空）'

  return (
    <div
      role="group"
      aria-label={`付箋: ${summary}（${note.author_name}）`}
      tabIndex={interactive ? 0 : -1}
      // 右クリックの対象は、親が closest() でこの属性を辿って決める。
      // レイヤーごとに onContextMenu を配るより、触る場所が少なくて済む
      data-ctx-kind="note"
      data-ctx-id={note.id}
      className={`absolute flex touch-none flex-col outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
        interactive ? 'pointer-events-auto' : ''
      } ${isText ? 'rounded' : 'rounded-lg shadow-md'} ${ringClass}`}
      style={{
        left: note.x,
        top: note.y,
        width: note.w,
        height: note.h,
        background: isText ? 'transparent' : style.bg,
        border: isText ? '1px dashed transparent' : `1px solid ${style.border}`,
        color: textColor,
        zIndex: note.z,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      // OS にポインタを奪われるとキャプチャだけ外れて pointerup が来ない。
      // これが無いと、以後ずっと付箋がマウスに張り付く
      onLostPointerCapture={handleUp}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => canEdit && setEditing(true)}
    >
      {/*
        長押しから文字サイズを変えている間の目安。
        「どれくらいの大きさになるか」は付箋そのものが即座に変わるので分かるが、
        戻したいときに何 px だったか分からないと困るので数値も出す
      */}
      {sizing && (
        <div
          role="status"
          aria-live="polite"
          className="no-select pointer-events-none absolute -top-9 right-0 z-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700 shadow-sm"
        >
          {fontSize}px
        </div>
      )}

      {selected && !editing && !multiSelected && !sizing && (
        <div className="absolute -top-9 left-0 z-10 flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-1.5 py-1 shadow-sm">
          {canEdit &&
            Object.entries(NOTE_COLORS).map(([key, c]) => (
              <button
                key={key}
                type="button"
                title={c.label}
                aria-label={`${c.label}にする`}
                aria-pressed={note.color === key}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onCommit(note.id, { color: key })}
                className={`h-4 w-4 rounded-full border ${
                  note.color === key ? 'ring-2 ring-slate-800 ring-offset-1' : ''
                }`}
                style={{ background: c.bg, borderColor: c.border }}
              />
            ))}

          {canEdit && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <button
                type="button"
                title={isText ? '付箋にする' : 'テキストにする'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onCommit(note.id, { kind: isText ? 'sticky' : 'text' })}
                className="px-1 text-xs text-slate-400 transition hover:text-slate-800"
              >
                {isText ? '🗒' : '🔤'}
              </button>
            </>
          )}

          <span className="mx-1 h-4 w-px bg-slate-200" />

          {/* 絵文字は 6 個並べるとツールバーが付箋からはみ出すので、1 個に畳んでおく */}
          <button
            type="button"
            title="リアクションをつける"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setShowEmoji((v) => !v)}
            className={`rounded px-1 text-sm transition hover:bg-slate-100 ${
              showEmoji ? 'bg-slate-200' : ''
            }`}
          >
            😀
          </button>

          <button
            type="button"
            title="コメント"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpenComments(note)}
            className="px-1 text-sm text-slate-400 transition hover:text-slate-800"
          >
            💬
          </button>

          {/*
            右クリックと同じメニューをここからも開けるようにする。
            右クリックを使わない人にも、複製・重なり順・色のコピー・PNG が届くように。
            閲覧のみの人にも出す（コピーや画像化はできるため）。
          */}
          <button
            type="button"
            title="そのほかの操作"
            aria-label="そのほかの操作"
            aria-haspopup="menu"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => onOpenMenu(note.id, e.currentTarget.getBoundingClientRect())}
            className="px-1 text-sm text-slate-400 transition hover:text-slate-800"
          >
            ⋯
          </button>

          {canEdit && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <button
                type="button"
                title="やることにする"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onConvert(note, 'todo')}
                className="px-1 text-sm text-slate-400 transition hover:text-slate-800"
              >
                ⏰
              </button>
              <button
                type="button"
                title="予定にする"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onConvert(note, 'event')}
                className="px-1 text-sm text-slate-400 transition hover:text-slate-800"
              >
                📅
              </button>

              <button
                type="button"
                title="削除"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onDelete(note)}
                className="px-1 text-sm text-slate-400 transition hover:text-rose-600"
              >
                🗑
              </button>
            </>
          )}
        </div>
      )}

      {selected && !editing && !multiSelected && showEmoji && (
        <div className="absolute -top-[4.75rem] left-0 z-10 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1.5 py-1 shadow-sm">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              title={`${emoji} をつける`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onToggleReaction(note, emoji)}
              className={`rounded px-1 text-sm transition hover:bg-slate-100 ${
                reactions?.[emoji]?.mine ? 'bg-slate-200' : ''
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* 他の人が本文を編集している印。読み取り専用にはしない（後から保存した方が残る） */}
      {editingBy && !editing && (
        <span
          className="no-select pointer-events-none absolute top-1 right-1 z-10 max-w-[90%] truncate rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 shadow-sm"
          title={`${editingBy}さんが編集中`}
        >
          ✎ {editingBy}さんが編集中
        </span>
      )}

      {editing ? (
        <>
          {editingBy && (
            <div className="no-select shrink-0 bg-amber-100 px-2 py-0.5 text-[10px] leading-tight text-amber-900">
              {editingBy}さんも編集中です。あとから保存した方が残ります
            </div>
          )}
          <textarea
            ref={textareaRef}
            aria-label="付箋の本文"
            value={draft}
            maxLength={1000}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.blur()
              }
            }}
            onBlur={() => {
              setEditing(false)
              if (draft !== note.text) onCommit(note.id, { text: draft })
            }}
            style={{ color: 'inherit', fontSize, lineHeight: 1.5 }}
            className={`min-h-0 flex-1 resize-none bg-transparent p-2 outline-none ${
              isText ? 'font-bold' : 'p-3'
            }`}
          />
        </>
      ) : (
        <div
          style={{ fontSize, lineHeight: 1.5 }}
          className={`no-select min-h-0 flex-1 cursor-grab overflow-hidden whitespace-pre-wrap ${
            isText ? 'p-2 font-bold' : 'p-3'
          }`}
        >
          {note.text || (
            <span className="text-slate-400">
              {isText ? 'ダブルクリックで見出しを入力' : 'ダブルクリックで入力'}
            </span>
          )}
        </div>
      )}

      {!isText && reactionEntries.length > 0 && (
        <div className="no-select flex flex-wrap gap-1 px-3 pb-1">
          {reactionEntries.map(([emoji, info]) => (
            <button
              key={emoji}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onToggleReaction(note, emoji)}
              className={`rounded-full px-1.5 py-0.5 text-[10px] transition ${
                info.mine ? 'bg-slate-900 text-white' : `${chipClass} text-slate-600`
              }`}
            >
              {emoji} {info.count}
            </button>
          ))}
        </div>
      )}

      {!isText && (
        <div className="no-select flex items-center gap-1.5 px-3 pb-1.5 text-[10px] text-slate-500">
          <span className="min-w-0 flex-1 truncate">{note.author_name}</span>

          {note.tags?.slice(0, 2).map((tag) => (
            <span key={tag} className={`shrink-0 rounded px-1 ${chipClass}`}>
              #{tag}
            </span>
          ))}

          {/* この付箋から生まれた やること / 予定。押すとその一覧へ飛ぶ */}
          {(links?.todos ?? 0) > 0 && (
            <button
              type="button"
              title="この付箋から生まれたやることを見る"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenLink(note, 'todo')}
              className={`shrink-0 rounded-full px-1.5 py-0.5 transition ${chipClass}`}
            >
              ⏰ {links?.todos}
            </button>
          )}
          {(links?.events ?? 0) > 0 && (
            <button
              type="button"
              title="この付箋から生まれた予定を見る"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenLink(note, 'event')}
              className={`shrink-0 rounded-full px-1.5 py-0.5 transition ${chipClass}`}
            >
              📅 {links?.events}
            </button>
          )}
          {(links?.stale ?? 0) > 0 && (
            <span
              title="この付箋を直したあと、やること / 予定にまだ反映していないものがあります"
              className="shrink-0 rounded-full bg-amber-200/70 px-1.5 py-0.5 text-amber-900"
            >
              ● 未反映
            </span>
          )}

          {commentCount > 0 && <span className="shrink-0">💬 {commentCount}</span>}

          <button
            type="button"
            title={voted ? '投票を取り消す' : '投票する'}
            aria-pressed={voted}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggleVote(note)}
            className={`shrink-0 rounded-full px-1.5 py-0.5 transition ${
              voted ? 'bg-slate-900 text-white' : `${chipClass} text-slate-600`
            }`}
          >
            👍 {voteCount}
          </button>
        </div>
      )}

      {canEdit && (
        <div
          title="サイズ変更"
          className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none"
          style={{
            background: isText
              ? 'transparent'
              : `linear-gradient(135deg, transparent 50%, ${style.border} 50%)`,
          }}
          onPointerDown={handleResizeDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          onLostPointerCapture={handleUp}
        />
      )}
    </div>
  )
}, areNotePropsEqual)
