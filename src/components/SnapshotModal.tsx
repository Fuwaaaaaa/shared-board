import { useCallback, useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { useRoomData } from '../lib/roomData'

/**
 * ボードあたりの保存数。増えすぎないよう古いものから捨てる。
 * DB 側の上限（12 件 / supabase/schema.sql）と cron の掃除（10 件）に合わせている。
 * ここを上限より大きくすると、保存そのものが弾かれるようになるので注意。
 */
const KEEP = 10

/** 保存点に入れるテーブル。付箋と線の関係を保つため、まとめて出し入れする。 */
const TABLES = [
  'notes',
  'strokes',
  // 線は付箋を指すので、付箋を入れ直したあとに入れる
  'connectors',
  'frames',
  'events',
  // 「この回だけ」の変更は予定を指すので、予定のあとに入れる
  'event_overrides',
  'todos',
  'images',
] as const

type TableName = (typeof TABLES)[number]
type Row = { id: string; room_id: string; author_id: string }
type Payload = Record<TableName, Row[]>

interface Snapshot {
  id: string
  label: string
  author_name: string
  created_at: string
}

/**
 * ボードの保存点。
 *
 * 「会議が終わった時点」を控えておき、あとから丸ごと戻せるようにする。
 * 戻す操作は今の中身を置き換えるので、戻す直前にもう 1 つ自動で保存する。
 */
export default function SnapshotModal({ onClose }: { onClose: () => void }) {
  const { userId, displayName } = useIdentity()
  const room = useRoomData()
  const { roomId, canEdit, isOwner } = room

  const [list, setList] = useState<Snapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: failed } = await supabase
      .from('snapshots')
      .select('id, label, author_name, created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })

    if (failed) setError(failed.message)
    else setList((data ?? []) as Snapshot[])
  }, [roomId])

  useEffect(() => {
    void load()
  }, [load])

  /** いまボードに出ているものを、そのまま控える */
  function buildPayload(): Payload {
    return {
      notes: room.notes.rows as unknown as Row[],
      strokes: room.strokes.rows as unknown as Row[],
      connectors: room.connectors.rows as unknown as Row[],
      frames: room.frames.rows as unknown as Row[],
      events: room.events.rows as unknown as Row[],
      event_overrides: room.overrides.rows as unknown as Row[],
      todos: room.todos.rows as unknown as Row[],
      images: room.images.rows as unknown as Row[],
    }
  }

  async function save(label: string) {
    const { error: failed } = await supabase.from('snapshots').insert({
      room_id: roomId,
      label: label.slice(0, 60),
      payload: buildPayload(),
      author_id: userId,
      author_name: displayName,
    })
    if (failed) throw new Error(failed.message)

    // 古いものから捨てる
    const { data } = await supabase
      .from('snapshots')
      .select('id')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })

    const extra = ((data ?? []) as { id: string }[]).slice(KEEP).map((s) => s.id)
    if (extra.length > 0) await supabase.from('snapshots').delete().in('id', extra)
  }

  async function saveNow() {
    const label = window.prompt(
      'この状態に名前をつけます',
      format(new Date(), 'M月d日 HH:mm', { locale: ja }),
    )
    if (label === null) return

    setBusy(true)
    setError(null)
    try {
      await save(label.trim())
      setNotice('いまの状態を保存しました。')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * この状態に戻す。
   *
   * 中身の入れ替えはサーバー側の restore_snapshot に任せる。画面から
   * 8 テーブルぶんの delete / insert を並べていたのをやめた理由は 2 つ:
   *
   *  - 控えたときの「作った人の名前」を残すため。author_name はなりすまし防止の
   *    トリガーが今の表示名で上書きするので、復元中だけそれを止める必要がある。
   *    その抑止は 1 つのトランザクションの中でしか効かない。
   *  - ボードの中身を全部消して置き換える操作なので、オーナーだけに絞るため。
   */
  async function restore(snapshot: Snapshot) {
    const ok = window.confirm(
      `「${snapshot.label || '名前なし'}」の状態に戻します。\n` +
        'いまの付箋・手描き・予定・やることは置き換わります。\n' +
        '（戻す直前の状態も自動で保存します）',
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    try {
      await save('復元する前')

      const { error: failed } = await supabase.rpc('restore_snapshot', {
        p_snapshot_id: snapshot.id,
      })
      if (failed) throw new Error(failed.message)

      setNotice('戻しました。')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(snapshot: Snapshot) {
    if (!window.confirm(`「${snapshot.label || '名前なし'}」を消します。`)) return

    setBusy(true)
    setError(null)
    const { error: failed } = await supabase.from('snapshots').delete().eq('id', snapshot.id)
    if (failed) setError(failed.message)
    else await load()
    setBusy(false)
  }

  return (
    <Modal title="保存した状態" onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        会議の終わりなどに控えておくと、あとから丸ごと戻せます（{KEEP} 件まで）。
        {!isOwner && '（戻せるのはボードを作った人だけです）'}
      </p>

      {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {notice && (
        <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p>
      )}

      {canEdit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void saveNow()}
          className="mb-4 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
        >
          📸 いまの状態を保存
        </button>
      )}

      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          まだ保存された状態はありません。
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-slate-200">
          {list.map((snapshot) => (
            <li
              key={snapshot.id}
              className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-slate-700">{snapshot.label || '名前なし'}</p>
                <p className="text-xs text-slate-400">
                  {format(parseISO(snapshot.created_at), 'M月d日(E) HH:mm', { locale: ja })} ·{' '}
                  {snapshot.author_name || '名前なし'}
                </p>
              </div>

              {canEdit && (
                <>
                  {/* 戻すのはボードの中身を丸ごと置き換える操作なので、作った人だけ。
                      サーバー側（restore_snapshot）でも同じ判定をしている */}
                  {isOwner && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void restore(snapshot)}
                      className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                    >
                      この状態に戻す
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(snapshot)}
                    className="shrink-0 text-xs text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                  >
                    消す
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-400">
        戻すと、いまの付箋・手描き・線・フレーム・予定・やること・画像が置き換わります。
        付箋を入れ替えるため、付箋への 👍 と絵文字は消えます。
        チャット・コメント・日程調整・参加者はそのままです。
      </p>
    </Modal>
  )
}
