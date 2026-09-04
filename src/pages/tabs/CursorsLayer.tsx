import { memo, useMemo } from 'react'
import type { Peer } from '../../hooks/usePresence'
import { useCursors } from '../../lib/cursorStore'

/**
 * 他の参加者のカーソルをボード上に重ねて表示する。
 *
 * カーソル位置はここだけが cursorStore を購読する。
 * peers は名前・色・「ボードタブを開いているか」を知るためだけに受け取る。
 */
function CursorsLayer({ peers, meId }: { peers: Peer[]; meId: string }) {
  const cursors = useCursors()

  const peerById = useMemo(() => {
    const map = new Map<string, Peer>()
    for (const peer of peers) map.set(peer.userId, peer)
    return map
  }, [peers])

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {Object.entries(cursors).map(([userId, cursor]) => {
        const peer = peerById.get(userId)
        if (!peer || userId === meId || peer.tab !== 'board') return null

        return (
          <div
            key={userId}
            className="absolute transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
          >
            {cursor.laser ? (
              // レーザーポインター: 大きな光る点で「いまここ」を示す
              <span
                className="absolute -top-3 -left-3 block h-6 w-6 animate-pulse rounded-full"
                style={{
                  background: 'rgba(239,68,68,0.85)',
                  boxShadow: '0 0 12px 6px rgba(239,68,68,0.45)',
                }}
              />
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M3 2l12 6.5-5.2 1.4L7.6 15z"
                  fill={peer.color}
                  stroke="#fff"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <span
              className="absolute top-4 left-4 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white"
              style={{ background: cursor.laser ? '#ef4444' : peer.color }}
            >
              {peer.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default memo(CursorsLayer)
