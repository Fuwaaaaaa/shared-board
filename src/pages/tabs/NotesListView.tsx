import { memo, useEffect, useMemo, useState } from 'react'
import { NOTE_COLORS, noteStyle, type Note } from '../../lib/types'
import { useTheme } from '../../lib/theme'
import { isComposingKey } from '../../lib/shortcuts'
import type { LinkCounts } from './NotesLayer'

interface Props {
  notes: Note[]
  canEdit: boolean
  /** この付箋から生まれた やること / 予定 の件数 */
  linkCounts: LinkCounts
  /** 付箋 id → いま本文を編集している他の人の名前 */
  editingByOthers: Map<string, string>
  onAdd: () => void
  onCommit: (id: string, patch: Partial<Note>) => void
  onDelete: (note: Note) => void
  onConvert: (note: Note, target: 'todo' | 'event') => void
  onOpenComments: (note: Note) => void
  /** 隣り合う 2 枚の位置を入れ替える */
  onSwap: (a: Note, b: Note) => void
  onEditingChange: (noteId: string | null) => void
  commentCounts: Record<string, number>
  /*
   * ここから下は、以前は右クリックメニューからしか届かなかった操作。
   * 狭い画面ではボード自体が描かれず右クリックもできないので、
   * この一覧が唯一の入口になる。
   */
  onCopy: (note: Note) => void
  onDuplicate: (note: Note) => void
  onCopyStyle: (note: Note) => void
  onPasteStyle: (note: Note) => void
  onCopyPng: (note: Note) => void
  onExportPng: (note: Note) => void
  /** 「色を貼り付け」を押せるか（まだ色をコピーしていなければ押せない） */
  hasClipboardStyle: boolean
  /** このブラウザが画像のクリップボードコピーに対応しているか */
  canCopyImage: boolean
}

/**
 * スマホ向けの付箋一覧。
 *
 * ホワイトボードのドラッグ・範囲選択・拡大縮小は指では扱いにくいので、
 * 小さい画面では「並べ替えられる一覧」として同じ付箋を出す。
 * 並べ替えは隣り合う 2 枚の座標を入れ替えるだけにして、
 * ボード側で他の人が置いた位置を壊さないようにする。
 */
function NotesListView({
  notes,
  canEdit,
  linkCounts,
  editingByOthers,
  onAdd,
  onCommit,
  onDelete,
  onConvert,
  onOpenComments,
  onSwap,
  onEditingChange,
  commentCounts,
  onCopy,
  onDuplicate,
  onCopyStyle,
  onPasteStyle,
  onCopyPng,
  onExportPng,
  hasClipboardStyle,
  canCopyImage,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const dark = useTheme().resolved === 'dark'
  const chipClass = dark ? 'bg-white/10' : 'bg-black/5'

  // ボードの見た目と同じ「上から下、左から右」の順に並べる
  const ordered = useMemo(
    () => notes.slice().sort((a, b) => a.y - b.y || a.x - b.x),
    [notes],
  )

  // 編集中であることを他の人に知らせる。アンマウントでも必ず解除する
  useEffect(() => {
    if (!editingId) return
    onEditingChange(editingId)
    return () => onEditingChange(null)
  }, [editingId, onEditingChange])

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= ordered.length) return
    onSwap(ordered[index], ordered[target])
  }

  function startEdit(note: Note) {
    setEditingId(note.id)
    setDraft(note.text)
    setMenuId(null)
  }

  function finishEdit(note: Note) {
    setEditingId(null)
    if (draft !== note.text) onCommit(note.id, { text: draft })
  }

  return (
    <div className="h-full overflow-auto bg-slate-100">
      <div className="mx-auto max-w-xl space-y-2 p-3">
        {canEdit && (
          <button
            type="button"
            onClick={onAdd}
            className="w-full rounded-xl border border-dashed border-slate-300 bg-white py-3 text-sm font-medium text-slate-600 transition hover:border-slate-400"
          >
            ＋ 付箋を追加
          </button>
        )}

        {ordered.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
            まだ付箋がありません。
          </p>
        )}

        {ordered.map((note, index) => {
          const style = noteStyle(note.color, dark)
          const links = linkCounts[note.id]
          const comments = commentCounts[note.id] ?? 0
          const editingBy = editingByOthers.get(note.id)
          const editing = editingId === note.id

          return (
            <div
              key={note.id}
              className="relative rounded-xl border shadow-sm"
              style={{ background: style.bg, borderColor: style.border, color: style.text }}
            >
              {editingBy && !editing && (
                <span className="pointer-events-none absolute top-1 right-1 z-10 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900 shadow-sm">
                  ✎ {editingBy}さんが編集中
                </span>
              )}

              {editing ? (
                <>
                  {editingBy && (
                    <div className="rounded-t-xl bg-amber-100 px-3 py-1 text-[11px] text-amber-900">
                      {editingBy}さんも編集中です。あとから保存した方が残ります
                    </div>
                  )}
                  <textarea
                    autoFocus
                    aria-label="付箋の本文"
                    value={draft}
                    maxLength={1000}
                    rows={4}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (isComposingKey(e.nativeEvent)) return
                      if (e.key === 'Escape') e.currentTarget.blur()
                    }}
                    onBlur={() => finishEdit(note)}
                    style={{ color: 'inherit' }}
                    className="w-full resize-none bg-transparent p-3 text-sm leading-relaxed outline-none"
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => canEdit && startEdit(note)}
                  style={{ color: 'inherit' }}
                  className="w-full p-3 text-left text-sm leading-relaxed whitespace-pre-wrap"
                >
                  {note.text || (
                    <span className="text-slate-400">
                      {canEdit ? 'タップして入力' : '（空の付箋）'}
                    </span>
                  )}
                </button>
              )}

              <div className="flex items-center gap-1.5 px-3 pb-2 text-[11px] text-slate-500">
                <span className="min-w-0 flex-1 truncate">{note.author_name}</span>

                {note.tags?.slice(0, 2).map((tag) => (
                  <span key={tag} className={`shrink-0 rounded px-1 ${chipClass}`}>
                    #{tag}
                  </span>
                ))}
                {comments > 0 && <span className="shrink-0">💬 {comments}</span>}
                {(links?.todos ?? 0) > 0 && <span className="shrink-0">⏰ {links?.todos}</span>}
                {(links?.events ?? 0) > 0 && <span className="shrink-0">📅 {links?.events}</span>}
                {(links?.stale ?? 0) > 0 && (
                  <span
                    title="直したあと、やること / 予定にまだ反映していません"
                    className="shrink-0 rounded bg-amber-200/70 px-1 text-amber-900"
                  >
                    ● 未反映
                  </span>
                )}

                {canEdit && (
                  <>
                    <button
                      type="button"
                      aria-label="ひとつ上へ"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="shrink-0 rounded px-1 transition hover:bg-black/5 disabled:opacity-25"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label="ひとつ下へ"
                      disabled={index === ordered.length - 1}
                      onClick={() => move(index, 1)}
                      className="shrink-0 rounded px-1 transition hover:bg-black/5 disabled:opacity-25"
                    >
                      ▼
                    </button>
                  </>
                )}

                <button
                  type="button"
                  aria-label="そのほかの操作"
                  aria-expanded={menuId === note.id}
                  onClick={() => setMenuId(menuId === note.id ? null : note.id)}
                  className="shrink-0 rounded px-1 transition hover:bg-black/5"
                >
                  ⋮
                </button>
              </div>

              {menuId === note.id && (
                <div className="space-y-2 border-t border-black/10 px-3 py-2">
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {Object.entries(NOTE_COLORS).map(([key, c]) => (
                        <button
                          key={key}
                          type="button"
                          aria-label={`${c.label}にする`}
                          aria-pressed={note.color === key}
                          onClick={() => onCommit(note.id, { color: key })}
                          className={`h-6 w-6 rounded-full border ${
                            note.color === key ? 'ring-2 ring-slate-800 ring-offset-1' : ''
                          }`}
                          style={{ background: c.bg, borderColor: c.border }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <MenuButton onClick={() => onOpenComments(note)}>💬 コメント・タグ</MenuButton>
                    <MenuButton onClick={() => onCopy(note)}>コピー</MenuButton>
                    {canCopyImage && (
                      <MenuButton onClick={() => onCopyPng(note)}>PNG としてコピー</MenuButton>
                    )}
                    <MenuButton onClick={() => onExportPng(note)}>PNG で保存</MenuButton>
                    {canEdit && (
                      <>
                        <MenuButton onClick={() => onDuplicate(note)}>複製</MenuButton>
                        <MenuButton onClick={() => onCopyStyle(note)}>色をコピー</MenuButton>
                        {hasClipboardStyle && (
                          <MenuButton onClick={() => onPasteStyle(note)}>色を貼り付け</MenuButton>
                        )}
                        <MenuButton onClick={() => onConvert(note, 'todo')}>
                          ⏰ やることにする
                        </MenuButton>
                        <MenuButton onClick={() => onConvert(note, 'event')}>
                          📅 予定にする
                        </MenuButton>
                        <MenuButton danger onClick={() => onDelete(note)}>
                          🗑 削除
                        </MenuButton>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}

        <p className="px-1 pt-2 pb-6 text-xs text-slate-400">
          手描き・画像・フレームは、パソコンのホワイトボード表示で扱えます。
        </p>
      </div>
    </div>
  )
}

export default memo(NotesListView)

function MenuButton({
  children,
  danger = false,
  onClick,
}: {
  children: React.ReactNode
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border bg-white/70 px-2.5 py-1.5 text-xs transition hover:bg-white ${
        danger ? 'border-rose-200 text-rose-700' : 'border-slate-300 text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}
