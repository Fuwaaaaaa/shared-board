import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AccessLevel } from '../hooks/useRoomAccess'
import type { RoomPreview } from '../lib/types'
import { useIdentity } from '../lib/identity'
import { messageOf } from '../lib/errorMessage'

interface Props {
  preview: RoomPreview
  level: Extract<AccessLevel, 'none' | 'pending' | 'rejected'>
  onRequest: (message: string, pin: string) => Promise<unknown>
}

/**
 * 合言葉つき / 承認制のボードに、まだ入っていない人へ見せる画面。
 * ここでは中身（付箋・予定・TODO）は一切読み込まない。
 */
export default function AccessRequestPanel({ preview, level, onRequest }: Props) {
  const { displayName } = useIdentity()
  const [message, setMessage] = useState('')
  const [pin, setPin] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 合言葉つきのボードは、合言葉が合えばその場で入れる（承認待ちにならない）
  const pinOnly = preview.needs_pin

  async function send() {
    setSending(true)
    setError(null)
    try {
      await onRequest(message.trim(), pin.trim())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mb-2 text-3xl">{pinOnly ? '🔑' : '🔒'}</div>
          <h1 className="text-lg font-bold text-slate-800">{preview.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {pinOnly
              ? `合言葉つきのボードです（作成者: ${preview.owner_name || '不明'}）`
              : `承認制のボードです（作成者: ${preview.owner_name || '不明'}）`}
          </p>
        </div>

        {preview.join_blocked && (
          <div className="mb-6 rounded-xl bg-rose-50 p-5 text-center">
            <p className="font-medium text-rose-800">{preview.join_blocked}</p>
            <p className="mt-1 text-sm text-rose-700">
              作成者に、もう一度リンクを送ってもらってください。
            </p>
          </div>
        )}

        {level === 'pending' ? (
          <div className="rounded-xl bg-amber-50 p-5 text-center">
            <p className="font-medium text-amber-800">承認待ちです</p>
            <p className="mt-1 text-sm text-amber-700">
              作成者が承認すると、この画面は自動でボードに切り替わります。
            </p>
          </div>
        ) : level === 'rejected' ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-rose-50 p-5 text-center">
              <p className="font-medium text-rose-800">いまは参加できません</p>
              <p className="mt-1 text-sm text-rose-700">
                参加が見送られたか、作った人がアクセスを取り消しました。
              </p>
            </div>

            {/*
              合言葉つきのボードでは、申し込み直すのにも合言葉が要る。
              ただし一度外された人は、合言葉が合っていても作った人の承認を待つ。
            */}
            {pinOnly && (
              <div>
                <label
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                  htmlFor="req-pin-again"
                >
                  合言葉
                </label>
                <input
                  id="req-pin-again"
                  value={pin}
                  maxLength={32}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="作成者から聞いた合言葉"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
                />
                <p className="mt-1 text-xs text-slate-400">
                  一度外れた人は、合言葉が合っていても作った人の承認を待ちます。
                </p>
              </div>
            )}

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
            )}

            <button
              type="button"
              onClick={send}
              disabled={sending || (pinOnly && !pin.trim())}
              className="w-full rounded-lg border border-slate-300 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              もう一度申請する
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <strong className="font-semibold">{displayName}</strong>{' '}
              として{pinOnly ? '参加します' : '参加を申請します'}。
            </p>

            {pinOnly && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="req-pin">
                  合言葉
                </label>
                <input
                  id="req-pin"
                  autoFocus
                  value={pin}
                  maxLength={32}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="作成者から聞いた合言葉"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
                />
              </div>
            )}

            {!pinOnly && (
              <div>
                <label
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                  htmlFor="req-msg"
                >
                  ひとこと（任意）
                </label>
                <textarea
                  id="req-msg"
                  value={message}
                  maxLength={200}
                  rows={3}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="例：営業部の田中です。よろしくお願いします。"
                  className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
                />
              </div>
            )}

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
            )}

            <button
              type="button"
              onClick={send}
              disabled={sending || Boolean(preview.join_blocked) || (pinOnly && !pin.trim())}
              className="w-full rounded-lg bg-slate-900 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
            >
              {sending ? '送信中…' : pinOnly ? '参加する' : '参加をリクエスト'}
            </button>
          </div>
        )}

        <Link
          to="/"
          className="mt-6 block text-center text-sm text-slate-400 transition hover:text-slate-700"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  )
}
