import { memo, useMemo } from 'react'
import { anchorPoints } from '../../lib/boardGeometry'
import type { Connector, Note } from '../../lib/types'

interface Props {
  width: number
  height: number
  connectors: Connector[]
  notes: Note[]
  selectedId: string | null
  interactive: boolean
  onSelect: (id: string | null) => void
}

/**
 * 付箋どうしをつなぐ線。
 *
 * 線そのものの座標は持たず、両端の付箋の位置から毎回計算する。
 * こうすることで、付箋を動かしたときに線が自然に追従する。
 */
function ConnectorsLayer({
  width,
  height,
  connectors,
  notes,
  selectedId,
  interactive,
  onSelect,
}: Props) {
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[3]"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {connectors.map((connector) => {
        const from = noteById.get(connector.from_note_id)
        const to = noteById.get(connector.to_note_id)
        if (!from || !to) return null

        const [x1, y1, x2, y2] = anchorPoints(from, to)
        const selected = selectedId === connector.id
        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2

        return (
          <g key={connector.id}>
            {/* 見た目より太い透明な線を重ねて、クリックしやすくする */}
            {interactive && (
              <line
                data-ctx-kind="connector"
                data-ctx-id={connector.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="transparent"
                strokeWidth={16}
                className="pointer-events-auto cursor-pointer"
                onPointerDown={(e) => {
                  if (e.button !== 0 && e.pointerType === 'mouse') return
                  e.stopPropagation()
                  onSelect(connector.id)
                }}
              />
            )}

            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={selected ? '#0f172a' : connector.color}
              strokeWidth={selected ? 4 : 2.5}
              strokeLinecap="round"
            />

            {connector.style === 'arrow' && (
              <ArrowHead x1={x1} y1={y1} x2={x2} y2={y2} color={selected ? '#0f172a' : connector.color} />
            )}

            {connector.label && (
              <>
                <rect
                  x={midX - connector.label.length * 6 - 6}
                  y={midY - 12}
                  width={connector.label.length * 12 + 12}
                  height={24}
                  rx={6}
                  fill="#ffffff"
                  stroke={connector.color}
                  strokeWidth={1}
                />
                <text
                  x={midX}
                  y={midY + 5}
                  textAnchor="middle"
                  fontSize={13}
                  fill="#334155"
                  className="select-none"
                >
                  {connector.label}
                </text>
              </>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export default memo(ConnectorsLayer)

function ArrowHead({
  x1,
  y1,
  x2,
  y2,
  color,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
}) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = 12
  const points = [
    [x2, y2],
    [x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7)],
    [x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7)],
  ]
  return <polygon points={points.map(([x, y]) => `${x},${y}`).join(' ')} fill={color} />
}

/**
 * 2 つの付箋の中心を結ぶ直線が、それぞれの矩形の辺と交わる点を求める。
 * 線が付箋の下に潜り込まず、縁から縁へ引かれるようになる。
 */
