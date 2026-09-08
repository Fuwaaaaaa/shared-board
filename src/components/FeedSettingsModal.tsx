import { useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { useRoomData } from '../lib/roomData'
import { EVENT_COLORS, type CalendarFeed } from '../lib/types'
import { feedUrlLabel, normalizeFeedUrl } from '../hooks/useCalendarFeeds'

interface Props {
  errors: Record<string, string>
  loading: boolean
  onRefresh: () => void
  onClose: () => void
}

/** 外部カレンダー（.ics 公開 URL）の購読設定 */
export default function FeedSettingsModal({ errors, loading, onRefresh, onClose }: Props) {
  const { userId } = useIdentity()
  const { roomId, canEdit, feeds } = useRoomData()

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState('slate')
  const [saving, setSaving] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)

  async function add() {
    const trimmedName = name.trim()
    if (!trimmedName || saving) return

    // https:// か webcal:// の絶対 URL だけを受け付ける。
    // 相対 URL を登録されると、このボードを開いた全員のブラウザから
    // 自分のサイトへリクエストが飛ぶことになる。
    const normalizedUrl = normalizeFeedUrl(url)
    if (!normalizedUrl) {
      setUrlError('https:// または webcal:// で始まる URL を入れてください')
      return
    }
    setUrlError(null)

    setSaving(true)
    const feed: CalendarFeed = {
      id: crypto.randomUUID(),
      room_id: roomId,
      name: trimmedName,
      url: normalizedUrl,
      color,
      enabled: true,
      author_id: userId,
      created_at: new Date().toISOString(),
    }

    feeds.upsertLocal(feed)
    const { error } = await supabase.from('calendar_feeds').insert(feed)
    if (error) feeds.removeLocal(feed.id)

    setName('')
    setUrl('')
    setSaving(false)
    onRefresh()
  }

  async function toggle(feed: CalendarFeed) {
    feeds.upsertLocal({ ...feed, enabled: !feed.enabled })
    await supabase.from('calendar_feeds').update({ enabled: !feed.enabled }).eq('id', feed.id)
  }

  async function remove(feed: CalendarFeed) {
    feeds.removeLocal(feed.id)
    await supabase.from('calendar_feeds').delete().eq('id', feed.id)
  }

  return (
    <Modal title="外部カレンダーの取り込み" onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-slate-600">
          Google カレンダーなどの「公開 URL（.ics）」を登録すると、その予定を重ねて表示できます。
          <strong className="font-semibold">読み取り専用</strong>
          で、こちらから相手のカレンダーを変えることはありません。
        </p>

        <p className="text-xs leading-relaxed text-slate-400">
          逆に、このボードの予定を人に渡したいときは「🔗 共有」→「📅 カレンダーの購読 URL」から作れます。
        </p>

        {feeds.rows.length > 0 && (
          <ul className="space-y-2">
            {feeds.rows.map((feed) => {
              const palette = EVENT_COLORS[feed.color] ?? EVENT_COLORS.slate
              const error = errors[feed.id]
              return (
                <li key={feed.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ background: palette.dot }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                      {feed.name}
                    </span>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggle(feed)}
                          className="shrink-0 text-xs text-slate-500 transition hover:text-slate-900"
                        >
                          {feed.enabled ? '非表示にする' : '表示する'}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(feed)}
                          className="shrink-0 text-xs text-slate-400 transition hover:text-rose-600"
                        >
                          削除
                        </button>
                      </>
                    )}
                  </div>
                  {/* 非公開 URL のクエリ部分は合言葉そのものなので、一覧では隠す */}
                  <p className="mt-0.5 truncate text-xs text-slate-400" title={feed.name}>
                    {feedUrlLabel(feed.url)}
                  </p>
                  {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
                  {!feed.enabled && <p className="mt-1 text-xs text-slate-400">非表示中</p>}
                </li>
              )
            })}
          </ul>
        )}

        {canEdit && (
          <div className="space-y-2 rounded-xl border border-dashed border-slate-300 p-3">
            <input
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="表示名（例：会社の予定）"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
            />
            <input
              value={url}
              maxLength={2000}
              onChange={(e) => {
                setUrl(e.target.value)
                if (urlError) setUrlError(null)
              }}
              placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-800"
            />
            {urlError && <p className="text-xs text-rose-600">{urlError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">色</span>
              {Object.entries(EVENT_COLORS).map(([key, palette]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setColor(key)}
                  className={`h-5 w-5 rounded-full transition ${
                    color === key ? 'ring-2 ring-slate-800 ring-offset-2' : ''
                  }`}
                  style={{ background: palette.dot }}
                />
              ))}
              <button
                type="button"
                onClick={add}
                disabled={!name.trim() || !url.trim() || saving}
                className="ml-auto rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
              >
                追加
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? '読み込み中…' : '🔄 いま取り直す'}
          </button>
          <span className="text-xs text-slate-400">15 分ごとに自動で読み直します。</span>
        </div>

        <details className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
          <summary className="cursor-pointer font-medium">
            Google カレンダーの公開 URL の調べ方
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>Google カレンダーを開き、対象カレンダーの「設定と共有」へ</li>
            <li>「予定のアクセス権限」で「一般公開して誰でも利用できるようにする」を有効化</li>
            <li>下の方にある「iCal 形式の公開 URL」をコピー</li>
          </ol>
          <p className="mt-2 text-slate-400">
            この URL を知っている人は予定を見られます。社外秘の予定には使わないでください。
            <strong className="text-slate-500">
              登録した URL は、このボードの参加者全員が見られます
            </strong>
            （一覧では途中まで伏せていますが、隠しているわけではありません）。
            なお取り込みには中継用の関数が必要です（docs/SETUP.md 参照）。
          </p>
        </details>
      </div>
    </Modal>
  )
}
