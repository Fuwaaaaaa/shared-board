import { buildNameLabels } from '../lib/names'
import type { Peer } from '../hooks/usePresence'

const TAB_LABELS: Record<string, string> = {
  board: 'ホワイトボード',
  calendar: 'カレンダー',
  todo: 'リマインド',
  updates: '更新',
  dashboard: 'ダッシュボード',
}

/** いまボードを開いている人を頭文字アイコンで並べる */
export default function PresenceAvatars({ peers, meId }: { peers: Peer[]; meId: string }) {
  if (peers.length === 0) return null

  const shown = peers.slice(0, 5)
  const rest = peers.length - shown.length

  // 同じ名前の人が同時に開いていても、どれが誰か分かるようにする
  const labels = buildNameLabels(
    peers.map((p) => ({ user_id: p.userId, display_name: p.name })),
    meId,
  )

  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((peer) => (
        <span
          key={peer.userId}
          title={`${labels.get(peer.userId) ?? peer.name}${
            peer.userId === meId ? '（自分）' : ''
          } — ${TAB_LABELS[peer.tab] ?? peer.tab}`}
          className="grid h-7 w-7 place-items-center rounded-full border-2 border-white text-xs font-bold text-white"
          style={{ background: peer.color }}
        >
          {peer.name.slice(0, 1)}
        </span>
      ))}
      {rest > 0 && (
        <span className="grid h-7 w-7 place-items-center rounded-full border-2 border-white bg-slate-400 text-[10px] font-bold text-white">
          +{rest}
        </span>
      )}
    </div>
  )
}
