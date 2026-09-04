import { useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { notifyUser } from '../hooks/useNotifications'
import { useIdentity } from '../lib/identity'
import { buildNameLabels } from '../lib/names'
import type { RoomMember, RoomPreview } from '../lib/types'

interface Props {
  members: RoomMember[]
  preview: RoomPreview
  onClose: () => void
  /**
   * 以前は「リンク公開のままでは締められない」注意書きから共有画面へ飛ぶために使っていた。
   * いまは取り消した人はリンク公開でも再申請で承認待ちになるので、注意書きごと無くした。
   * 呼び出し側との互換のために残している（使っていない）。
   */
  onOpenShare?: () => void
}

/** 参加者一覧。オーナーには承認待ちの申請に対する承認 / 却下ボタンが出る。 */
export default function MemberPanel({ members, preview, onClose }: Props) {
  const isOwner = preview.is_owner
  const { userId } = useIdentity()
  const [busyId, setBusyId] = useState<string | null>(null)

  // 同じ名前の人がいるときだけ「（この端末）」「（2）」を足す
  const labels = buildNameLabels(members, userId)
  const nameOf = (m: RoomMember) => labels.get(m.user_id) ?? (m.display_name || '名前なし')

  const pending = members.filter((m) => m.status === 'pending')
  const approved = members.filter((m) => m.status === 'approved')
  const rejected = members.filter((m) => m.status === 'rejected')

  async function decide(
    member: RoomMember,
    status: 'approved' | 'rejected',
    canEdit = member.can_edit,
  ) {
    setBusyId(member.id)
    const { error } = await supabase
      .from('room_members')
      .update({ status, can_edit: canEdit, decided_at: new Date().toISOString() })
      .eq('id', member.id)

    // 結果を本人に知らせる。画面が切り替わるだけでは気づけないことがある。
    if (!error) {
      await notifyUser({
        roomId: member.room_id,
        userId: member.user_id,
        kind: 'join_decided',
        body:
          status === 'approved'
            ? `参加が承認されました${canEdit ? '' : '（閲覧のみ）'}`
            : '参加は見送られました',
        linkTab: 'board',
      })
    }
    setBusyId(null)
  }

  /**
   * 参加者 1 人のアクセスを取り消す。
   * 取り消した人は、リンク公開のボードでも URL からそのまま入り直せない
   * （再申請すると承認待ちになり、オーナーが「やっぱり承認」で戻せる）。
   */
  async function revoke(member: RoomMember) {
    const ok = window.confirm(
      `${nameOf(member)} さんのアクセスを取り消します。\n\n` +
        '取り消した人は中身を読めなくなります。もう一度申請してきたら、承認待ちに並びます。',
    )
    if (!ok) return
    await decide(member, 'rejected')
  }

  /** 編集できる／閲覧のみ を切り替える */
  async function setCanEdit(member: RoomMember, canEdit: boolean) {
    setBusyId(member.id)
    await supabase.from('room_members').update({ can_edit: canEdit }).eq('id', member.id)
    setBusyId(null)
  }

  return (
    <Modal title="参加者" onClose={onClose}>
      {isOwner && (
        <section className="mb-6">
          <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
            承認待ち（{pending.length}）
          </h3>
          {pending.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
              新しい参加リクエストはありません
            </p>
          ) : (
            <ul className="space-y-2">
              {pending.map((m) => (
                <li key={m.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                  <div className="font-medium text-slate-800">{nameOf(m)}</div>
                  {m.message && (
                    <p className="mt-1 text-sm whitespace-pre-wrap text-slate-600">{m.message}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === m.id}
                      onClick={() => decide(m, 'approved', true)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
                    >
                      承認（編集できる）
                    </button>
                    <button
                      type="button"
                      disabled={busyId === m.id}
                      onClick={() => decide(m, 'approved', false)}
                      className="rounded-lg border border-slate-400 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-white disabled:opacity-50"
                    >
                      承認（閲覧のみ）
                    </button>
                    <button
                      type="button"
                      disabled={busyId === m.id}
                      onClick={() => decide(m, 'rejected')}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-white disabled:opacity-50"
                    >
                      却下
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
          参加中（{approved.length}）
        </h3>
        <ul className="space-y-1">
          {approved.map((m) => (
            <li key={m.id} className="rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-slate-700">{nameOf(m)}</span>
                {m.role === 'owner' ? (
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                    オーナー
                  </span>
                ) : (
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                      m.can_edit ? 'bg-slate-100 text-slate-600' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {m.can_edit ? '✏️ 編集できる' : '👀 閲覧のみ'}
                  </span>
                )}
              </div>

              {isOwner && m.role !== 'owner' && (
                <div className="mt-1.5 flex gap-3">
                  <button
                    type="button"
                    disabled={busyId === m.id}
                    onClick={() => setCanEdit(m, !m.can_edit)}
                    className="text-xs text-slate-500 transition hover:text-slate-900"
                  >
                    {m.can_edit ? '閲覧のみにする' : '編集できるようにする'}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === m.id}
                    onClick={() => revoke(m)}
                    className="text-xs text-slate-400 transition hover:text-rose-600"
                  >
                    アクセスを取り消す
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isOwner && (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          「閲覧のみ」の人は、付箋・予定・リマインドを見ることはできますが変更できません。
          コメントと付箋への投票には参加できます。
        </p>
      )}

      {isOwner && rejected.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
            却下済み（{rejected.length}）
          </h3>
          <ul className="space-y-1">
            {rejected.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-50"
              >
                <span>{nameOf(m)}</span>
                <button
                  type="button"
                  disabled={busyId === m.id}
                  onClick={() => decide(m, 'approved')}
                  className="text-xs text-slate-400 transition hover:text-slate-800"
                >
                  やっぱり承認
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  )
}
