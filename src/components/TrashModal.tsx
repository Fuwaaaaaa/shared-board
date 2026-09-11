import { useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useRoomData } from '../lib/roomData'
import { connectorRestoreBlock, daysLeftInTrash, groupErased, TRASH_DAYS } from '../lib/trash'
import type { Stroke } from '../lib/types'

type Kind =
  | 'notes'
  | 'events'
  | 'todos'
  | 'images'
  | 'frames'
  | 'connectors'
  | 'strokes'
  | 'attachments'

const SECTION_META: Record<Kind, { icon: string; label: string }> = {
  notes: { icon: '🖍️', label: '付箋' },
  events: { icon: '📅', label: '予定' },
  todos: { icon: '⏰', label: 'やること' },
  images: { icon: '🖼', label: '画像' },
  frames: { icon: '🔲', label: 'フレーム' },
  connectors: { icon: '➰', label: '線' },
  strokes: { icon: '🖊', label: '手描き' },
  attachments: { icon: '📎', label: 'ファイル' },
}

/** PostgREST の in() に並べる id の数。URL 長の上限に当たらないように分ける */
const CHUNK = 200

function chunked(ids: string[]): string[][] {
  const out: string[][] = []
  for (let index = 0; index < ids.length; index += CHUNK) out.push(ids.slice(index, index + CHUNK))
  return out
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
    roomId,
    notes,
    events,
    todos,
    images,
    frames,
    connectors,
    strokes,
    attachments,
  } = useRoomData()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
   * 手描きのゴミ箱だけ、開いたときに取りに行く。
   *
   * ほかの種類は roomData がもう手元に持っているが、手描きは points が重いので
   * ゴミ箱の行を live に載せていない（roomData の skipDeleted）。
   * ここで 1 回だけ取り、戻す・消すの結果はこの配列を直して映す。
   */
  const [trashedStrokes, setTrashedStrokes] = useState<Stroke[] | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const { data, error: failed } = await supabase
        .from('strokes')
        .select('*')
        .eq('room_id', roomId)
        .not('deleted_at', 'is', null)
      if (!alive) return
      if (failed) setError(`手描きのゴミ箱を読めませんでした: ${failed.message}`)
      setTrashedStrokes((data ?? []) as Stroke[])
    })()
    return () => {
      alive = false
    }
  }, [roomId])

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

  /**
   * 手描きは「ひと撫で」を 1 行にまとめて出す。
   *
   * 消しゴムは 1 本ずつ消すので、20 本消すとゴミ箱も 20 行になる。
   * 戻す・消すはまとめた全部に効かせる（id は分けて送る。全消しのぶんは
   * 2500 本になることがあり、URL に並べきれない）。
   */
  function buildStrokeGroups(): TrashRow[] {
    return groupErased(trashedStrokes ?? []).map((group) => {
      const ids = group.rows.map((row) => row.id)
      const label = `手描き ${group.rows.length} 本`

      return {
        kind: 'strokes' as Kind,
        id: group.key,
        label,
        deletedAt: group.deletedAt,
        blocked: null,

        restore: async () => {
          setBusy(group.key)
          setError(null)

          const restored: Stroke[] = []
          for (const part of chunked(ids)) {
            const { data, error: failed } = await supabase
              .from('strokes')
              .update({ deleted_at: null })
              .in('id', part)
              .select('*')
            if (failed) {
              setError(`戻せませんでした: ${failed.message}`)
              break
            }
            restored.push(...((data ?? []) as Stroke[]))
          }

          // 戻せたぶんだけ盤面へ。途中で失敗しても、戻った線は出す
          for (const row of restored) strokes.upsertLocal(row)
          const back = new Set(restored.map((row) => row.id))
          setTrashedStrokes((current) => (current ?? []).filter((row) => !back.has(row.id)))
          setBusy(null)
        },

        purge: async () => {
          if (!window.confirm(`「${label}」を完全に消します。もう戻せません。よろしいですか？`)) {
            return
          }

          setBusy(group.key)
          setError(null)

          const gone = new Set<string>()
          for (const part of chunked(ids)) {
            const { data, error: failed } = await supabase
              .from('strokes')
              .delete()
              .in('id', part)
              .select('id')
            if (failed) {
              setError(`消せませんでした: ${failed.message}`)
              break
            }
            for (const row of (data ?? []) as { id: string }[]) gone.add(row.id)
          }

          setTrashedStrokes((current) => (current ?? []).filter((row) => !gone.has(row.id)))
          setBusy(null)
        },
      }
    })
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
    { kind: 'strokes', rows: buildStrokeGroups() },
    {
      kind: 'attachments',
      rows: build('attachments', attachments, trash.attachments, (a) => a.filename),
    },
  ]

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0)
  // 手描きを取りに行っている間は「空です」と言い切らない
  const loadingStrokes = trashedStrokes === null

  return (
    <Modal title="ゴミ箱" onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        消したものは {TRASH_DAYS} 日ここに残ります。他の人が消したものも、ここから戻せます。
        コメントはここに入りません（書いた本人か、作った人だけが消せます）。
        手描きだけは、描き足して上限に届くと {TRASH_DAYS} 日を待たずに古いものから消えます。
      </p>

      {error && (
        <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}

      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          {loadingStrokes ? '読み込んでいます…' : 'ゴミ箱は空です。'}
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
