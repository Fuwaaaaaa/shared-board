import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useRoomData } from '../lib/roomData'
import { connectorRestoreBlock, daysLeftInTrash, TRASH_DAYS } from '../lib/trash'

type Kind = 'notes' | 'events' | 'todos' | 'images' | 'frames' | 'connectors' | 'attachments'

const SECTION_META: Record<Kind, { icon: string; label: string }> = {
  notes: { icon: '🖍️', label: '付箋' },
  events: { icon: '📅', label: '予定' },
  todos: { icon: '⏰', label: 'やること' },
  images: { icon: '🖼', label: '画像' },
  frames: { icon: '🔲', label: 'フレーム' },
  connectors: { icon: '➰', label: '線' },
  attachments: { icon: '📎', label: 'ファイル' },
}

interface TrashRow {
  kind: Kind
  id: string
  label: string
  deletedAt: string | null
  /** 戻せないときの理由。入っていれば「戻す」を押せなくする */
  blocked: string | null
  restore: () => Promise<void>
  purge: () => Promise<void>
}

/** ローカル反映に必要な最低限。useRealtimeTable の戻り値がそのまま入る。 */
interface LocalTable<T> {
  upsertLocal: (row: T) => void
  removeLocal: (id: string) => void
}

/**
 * ゴミ箱。
 *
 * Ctrl+Z は自分の操作にしか効かないので、他の人が消したものはここから戻す。
 * 30 日たつと自動で本当に消える。
 */
export default function TrashModal({ onClose }: { onClose: () => void }) {
  const {
    trash,
    canEdit,
    notes,
    events,
    todos,
    images,
    frames,
    connectors,
    attachments,
  } = useRoomData()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function build<T extends { id: string; deleted_at: string | null }>(
    kind: Kind,
    table: LocalTable<T>,
    rows: T[],
    labelOf: (row: T) => string,
    blockedBy: (row: T) => string | null = () => null,
  ): TrashRow[] {
    return rows.map((row) => ({
      kind,
      id: row.id,
      label: labelOf(row),
      deletedAt: row.deleted_at,
      blocked: blockedBy(row),

      restore: async () => {
        setBusy(row.id)
        setError(null)
        table.upsertLocal({ ...row, deleted_at: null })

        const { error: failed } = await supabase
          .from(kind)
          .update({ deleted_at: null })
          .eq('id', row.id)

        if (failed) {
          table.upsertLocal(row)
          setError(`戻せませんでした: ${failed.message}`)
        }
        setBusy(null)
      },

      purge: async () => {
        const label = labelOf(row)
        if (!window.confirm(`「${label}」を完全に消します。もう戻せません。よろしいですか？`)) {
          return
        }

        setBusy(row.id)
        setError(null)
        table.removeLocal(row.id)

        const { error: failed } = await supabase.from(kind).delete().eq('id', row.id)
        if (failed) {
          table.upsertLocal(row)
          setError(`消せませんでした: ${failed.message}`)
        }
        setBusy(null)
      },
    }))
  }

  const liveNoteIds = new Set(notes.rows.map((n) => n.id))
  const trashedNoteIds = new Set(trash.notes.map((n) => n.id))

  const sections: { kind: Kind; rows: TrashRow[] }[] = [
    {
      kind: 'notes',
      rows: build('notes', notes, trash.notes, (n) => n.text.split('\n')[0]?.trim() || '（空の付箋）'),
    },
    { kind: 'events', rows: build('events', events, trash.events, (e) => e.title) },
    { kind: 'todos', rows: build('todos', todos, trash.todos, (t) => t.title) },
    { kind: 'images', rows: build('images', images, trash.images, () => '画像') },
    {
      kind: 'frames',
      rows: build('frames', frames, trash.frames, (f) => f.title || '（名前なしのフレーム）'),
    },
    {
      kind: 'connectors',
      // 両端の付箋が見えていないと、戻しても画面には何も出ない
      rows: build(
        'connectors',
        connectors,
        trash.connectors,
        (c) => c.label || '線',
        (c) => connectorRestoreBlock(c, liveNoteIds, trashedNoteIds),
      ),
    },
    {
      kind: 'attachments',
      rows: build('attachments', attachments, trash.attachments, (a) => a.filename),
    },
  ]

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0)

  return (
    <Modal title="ゴミ箱" onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        消したものは {TRASH_DAYS} 日ここに残ります。他の人が消したものも、ここから戻せます。
        手描きとコメントはここに入りません（手描きは Ctrl+Z、コメントは書いた本人か
        作った人だけが消せます）。
      </p>

      {error && (
        <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}

      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          ゴミ箱は空です。
        </p>
      ) : (
        <div className="space-y-5">
          {sections.map(({ kind, rows }) => {
            if (rows.length === 0) return null
            const meta = SECTION_META[kind]

            return (
              <section key={kind}>
                <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
                  {meta.icon} {meta.label}（{rows.length}）
                </h3>
                <ul className="overflow-hidden rounded-xl border border-slate-200">
                  {rows.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-slate-700">{row.label}</span>
                      {row.deletedAt && (
                        <span
                          className="shrink-0 text-xs text-slate-400"
                          title={`あと ${daysLeftInTrash(row.deletedAt)} 日で完全に消えます`}
                        >
                          {format(parseISO(row.deletedAt), 'M月d日 HH:mm', { locale: ja })}
                          <span className="ml-1">（あと {daysLeftInTrash(row.deletedAt)} 日）</span>
                        </span>
                      )}
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            disabled={busy === row.id || row.blocked !== null}
                            title={row.blocked ?? undefined}
                            onClick={() => void row.restore()}
                            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                          >
                            戻す
                          </button>
                          <button
                            type="button"
                            disabled={busy === row.id}
                            onClick={() => void row.purge()}
                            className="shrink-0 text-xs text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                          >
                            完全に消す
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
