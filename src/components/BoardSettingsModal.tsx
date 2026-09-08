import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Modal from './Modal'
import { generateSlug, supabase } from '../lib/supabase'
import { notifyRoomChanged } from '../lib/roomChannel'
import { useIdentity } from '../lib/identity'
import { accessInfo } from '../lib/access'
import type { BoardImage, CalendarEvent, Note, RoomPreview, Stroke, Todo } from '../lib/types'
import { messageOf } from '../lib/errorMessage'

// この 3 つは、設定を開いたうえでさらに押した人しか使わない
const ImportExportModal = lazy(() => import('./ImportExportModal'))
const TrashModal = lazy(() => import('./TrashModal'))
const SnapshotModal = lazy(() => import('./SnapshotModal'))

interface Props {
  preview: RoomPreview
  onClose: () => void
  onUpdated: () => void
  /** 入り方の変更は共有画面に集約しているので、そちらへ渡す */
  onOpenShare: () => void
}

/** ボードの名前変更・複製・削除・退出。入り方の変更は共有画面が受け持つ。 */
export default function BoardSettingsModal({
  preview,
  onClose,
  onUpdated,
  onOpenShare,
}: Props) {
  const navigate = useNavigate()
  const { userId } = useIdentity()
  const [name, setName] = useState(preview.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showImportExport, setShowImportExport] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showSnapshots, setShowSnapshots] = useState(false)

  const access = accessInfo(preview)
  const dirty = name.trim() !== preview.name

  async function save() {
    if (!dirty || !name.trim()) return
    setBusy(true)
    setError(null)

    const { error: updateError } = await supabase
      .from('rooms')
      .update({ name: name.trim() })
      .eq('id', preview.id)

    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    onUpdated()
    onClose()
  }

  /**
   * ボードを中身ごと複製する。
   * 画像は Storage のファイルも新しいボードのフォルダにコピーしないと、
   * 新しいボードの参加者から読めなくなる（アクセス判定にフォルダ名を使うため）。
   */
  async function duplicateRoom() {
    const newName = window.prompt('複製したボードの名前', `${preview.name} のコピー`)
    if (!newName?.trim()) return

    setBusy(true)
    setError(null)

    try {
      const slug = generateSlug()
      const { data: created, error: roomError } = await supabase
        .from('rooms')
        .insert({
          slug,
          name: newName.trim(),
          visibility: preview.visibility,
          owner_id: userId,
          owner_name: preview.owner_name,
        })
        .select()
        .single()
      if (roomError) throw roomError

      const newRoomId = (created as { id: string }).id

      await supabase.from('room_members').insert({
        room_id: newRoomId,
        user_id: userId,
        display_name: preview.owner_name,
        role: 'owner',
        status: 'approved',
        can_edit: true,
      })

      // 付箋・手描き・予定・リマインドをそのまま写す（author_id は自分になる）。
      // ゴミ箱に入っているものは持ち越さない。
      const [notes, strokes, events, todos, images] = await Promise.all([
        supabase.from('notes').select('*').eq('room_id', preview.id).is('deleted_at', null),
        supabase.from('strokes').select('*').eq('room_id', preview.id),
        supabase.from('events').select('*').eq('room_id', preview.id).is('deleted_at', null),
        supabase.from('todos').select('*').eq('room_id', preview.id).is('deleted_at', null),
        supabase.from('images').select('*').eq('room_id', preview.id).is('deleted_at', null),
      ])

      // 複製先では出自の紐づけが指す行が存在しないので、リンクは切って写す
      const reassign = <T extends { id: string; room_id: string; author_id: string }>(rows: T[]) =>
        rows.map((row) => ({
          ...row,
          id: crypto.randomUUID(),
          room_id: newRoomId,
          author_id: userId,
          ...('source_note_id' in row ? { source_note_id: null } : {}),
          ...('source_event_id' in row ? { source_event_id: null } : {}),
          ...('source_synced_at' in row ? { source_synced_at: null } : {}),
          ...('source_todo_id' in row ? { source_todo_id: null } : {}),
        }))

      const copies: PromiseLike<unknown>[] = []
      if (notes.data?.length)
        copies.push(supabase.from('notes').insert(reassign(notes.data as Note[])))
      if (strokes.data?.length)
        copies.push(supabase.from('strokes').insert(reassign(strokes.data as Stroke[])))
      if (events.data?.length)
        copies.push(supabase.from('events').insert(reassign(events.data as CalendarEvent[])))
      if (todos.data?.length)
        copies.push(supabase.from('todos').insert(reassign(todos.data as Todo[])))
      await Promise.all(copies)

      // 画像は実ファイルもコピーしてからレコードを作る
      const imageRows: BoardImage[] = []
      for (const image of (images.data ?? []) as BoardImage[]) {
        const extension = image.storage_path.split('.').pop() ?? 'png'
        const newPath = `${newRoomId}/${crypto.randomUUID()}.${extension}`
        const { error: copyError } = await supabase.storage
          .from('board-images')
          .copy(image.storage_path, newPath)
        if (copyError) continue

        imageRows.push({
          ...image,
          id: crypto.randomUUID(),
          room_id: newRoomId,
          storage_path: newPath,
          author_id: userId,
        })
      }
      if (imageRows.length > 0) await supabase.from('images').insert(imageRows)

      navigate(`/r/${slug}`)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * ボードを終了する / 再開する。
   *
   * 「削除」と「使い続ける」の間の状態。合宿や文化祭が終わったあと、
   * 記録は残したいけれど誰にも書き換えてほしくない、というときに使う。
   * 書き込みを止めるのは RLS（room_is_open）側なので、画面を閉じても効く。
   */
  async function toggleClosed() {
    const next = !preview.archived

    if (next) {
      const ok = window.confirm(
        [
          'このボードを終了します。',
          '',
          '・付箋・予定・やることはそのまま残り、いつでも読めます',
          '・新しい書き込みは、作成者を含めて誰もできなくなります',
          '・あとから再開できます',
          '',
          'よろしいですか？',
        ].join('\n'),
      )
      if (!ok) return
    }

    setBusy(true)
    setError(null)

    const { error: failed } = await supabase
      .from('rooms')
      .update({ archived: next })
      .eq('id', preview.id)

    setBusy(false)
    if (failed) {
      setError(failed.message)
      return
    }
    onUpdated()
  }

  async function removeRoom() {
    const answer = window.prompt(
      `このボードと中身をすべて削除します。取り消せません。\n削除するにはボード名「${preview.name}」を入力してください。`,
    )
    if (answer !== preview.name) return

    setBusy(true)

    // 画像・添付の実ファイルはここでは消さない。
    // rooms を消すとサーバー側のトリガーが purge_queue に「このボードのフォルダを消す」と
    // 積み、purge-storage（毎時）が Storage から実体を消す。
    // （以前はここで先頭 100 件だけ消していたので、それ以上あると残ってしまっていた）
    const { error: deleteError } = await supabase.from('rooms').delete().eq('id', preview.id)
    setBusy(false)

    if (deleteError) {
      setError(deleteError.message)
      return
    }
    // 開いている人の画面を「ボードが見つかりません」に切り替える。
    // 消えたことは rooms を消しても届かない（Realtime 配信に載せていないため）
    notifyRoomChanged(preview.id)
    navigate('/', { replace: true })
  }

  async function leaveRoom() {
    if (!window.confirm('このボードから退出します。よろしいですか？')) return

    setBusy(true)
    await supabase.from('room_members').delete().eq('room_id', preview.id).eq('user_id', userId)
    setBusy(false)
    navigate('/', { replace: true })
  }

  return (
    <Modal
      title="ボードの設定"
      onClose={onClose}
      footer={
        preview.is_owner ? (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || !name.trim() || busy}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
            >
              保存
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            閉じる
          </button>
        )
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowImportExport(true)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            📊 書き出し・取り込み
          </button>
          <button
            type="button"
            onClick={() => setShowSnapshots(true)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            📸 保存した状態
          </button>
          <button
            type="button"
            onClick={() => setShowTrash(true)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            🗑 ゴミ箱
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            🖨 印刷 / PDF 保存
          </button>
        </div>

        {preview.is_owner ? (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="room-name">
                ボード名
              </label>
              <input
                id="room-name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
              />
            </div>

            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">入り方</span>
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3">
                <span className="text-sm text-slate-800">
                  {access.icon} {access.label}
                  <span className="ml-2 text-xs text-slate-400">入り方：{access.howToEnter}</span>
                </span>
                <button
                  type="button"
                  onClick={onOpenShare}
                  className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  共有画面で変える
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                リンク公開 / 合言葉つき / 承認制 の切り替えと、参加期限・人数の条件は共有画面にまとめています。
              </p>
            </div>

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
            )}

            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-700">ボードを複製</h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-600">
                付箋・手描き・画像・予定・リマインドをまるごとコピーして、新しいボードを作ります。
                定例会の雛形として使えます（参加者とチャットはコピーしません）。
              </p>
              <button
                type="button"
                onClick={duplicateRoom}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                {busy ? '処理中…' : 'このボードを複製する'}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-700">
                {preview.archived ? 'ボードを再開' : 'ボードを終了'}
              </h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-600">
                {preview.archived
                  ? 'いまは終了しています。再開すると、また書き込めるようになります。'
                  : '中身は残したまま、新しい書き込みだけを止めます。イベントが終わったあとの記録置き場にするときに使います。あとから再開できます。'}
              </p>
              <button
                type="button"
                onClick={toggleClosed}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                {preview.archived ? 'このボードを再開する' : 'このボードを終了する'}
              </button>
            </div>

            <div className="rounded-xl border border-rose-200 p-4">
              <h3 className="text-sm font-bold text-rose-700">ボードを削除</h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-600">
                付箋・手描き・画像・予定・リマインド・チャットがすべて消えます。取り消せません。
              </p>
              <button
                type="button"
                onClick={removeRoom}
                disabled={busy}
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
              >
                このボードを削除する
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-slate-500">ボード名</dt>
                <dd className="text-slate-800">{preview.name}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-slate-500">作成者</dt>
                <dd className="text-slate-800">{preview.owner_name || '不明'}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-slate-500">入り方</dt>
                <dd className="text-slate-800">
                  {access.icon} {access.label}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-500">
              ボード名や入り方を変更できるのは作成者だけです。
            </p>

            <div className="rounded-xl border border-slate-200 p-4">
              <h3 className="text-sm font-bold text-slate-700">このボードから退出</h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-600">
                参加中のボード一覧から消えます。ボードの中身は消えません。
                承認制のボードの場合、もう一度入るには再度申請が必要です。
              </p>
              <button
                type="button"
                onClick={leaveRoom}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                退出する
              </button>
            </div>
          </>
        )}
      </div>

      <Suspense fallback={null}>
        {showImportExport && (
          <ImportExportModal boardName={preview.name} onClose={() => setShowImportExport(false)} />
        )}

        {showTrash && <TrashModal onClose={() => setShowTrash(false)} />}

        {showSnapshots && <SnapshotModal onClose={() => setShowSnapshots(false)} />}
      </Suspense>
    </Modal>
  )
}
