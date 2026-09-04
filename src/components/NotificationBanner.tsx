interface Props {
  supported: boolean
  permission: NotificationPermission
  onRequest: () => void
  text?: string
}

/** 「通知を許可」を促す共通バナー。許可済みなら何も出さない。 */
export default function NotificationBanner({
  supported,
  permission,
  onRequest,
  text = '設定した時刻にブラウザ通知でお知らせできます。',
}: Props) {
  if (!supported || permission === 'granted') return null

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="min-w-0 flex-1 text-sm text-slate-600">
        {text}
        <span className="text-slate-400">（このタブを開いている間のみ）</span>
      </p>
      {permission === 'denied' ? (
        <span className="text-xs text-slate-400">通知はブラウザ側でブロックされています</span>
      ) : (
        <button
          type="button"
          onClick={onRequest}
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
        >
          🔔 通知を許可
        </button>
      )}
    </div>
  )
}
