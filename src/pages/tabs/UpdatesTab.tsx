import { lazy, Suspense, useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict, isToday, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import { colorForUser } from '../../hooks/usePresence'
import { useRoomData } from '../../lib/roomData'
import type { BoardUpdate, UpdateCategory } from '../../hooks/useBoardUpdates'
import type { TabKey } from '../../components/RoomHeader'

// ゴミ箱は、ここと「ボードの設定」の 2 か所から開く。どちらも押した人だけが取りに行く
const TrashModal = lazy(() => import('../../components/TrashModal'))

type Filter = 'all' | UpdateCategory

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'board', label: '🖍️ 付箋' },
  { key: 'calendar', label: '📅 予定' },
  { key: 'todo', label: '⏰ やること' },
  { key: 'comment', label: '💬 コメント' },
  { key: 'member', label: '👥 参加・権限' },
]

interface Props {
  updates: BoardUpdate[]
  onJump: (tab: TabKey, id: string | null) => void
  onOpenChat: () => void
}

/**
 * ボードで起きたことを 1 か所に集めたタブ。
 *
 * 「けいこが予定を変更」「みなみがタスク完了」「ゆうきが付箋を追加」を
 * 別々のパネルで探さずに済むようにする。
 */
export default function UpdatesTab({ updates, onJump, onOpenChat }: Props) {
  const { trash } = useRoomData()
  const [filter, setFilter] = useState<Filter>('all')
  const [showTrash, setShowTrash] = useState(false)

  const visible = useMemo(
    () => (filter === 'all' ? updates : updates.filter((u) => u.category === filter)),
    [updates, filter],
  )

  const trashCount =
    trash.notes.length + trash.events.length + trash.todos.length + trash.images.length

  /** 日ごとの見出しを入れる */
  const groups = useMemo(() => {
    const map = new Map<string, BoardUpdate[]>()
    for (const update of visible) {
      const key = format(parseISO(update.at), 'yyyy-MM-dd')
      const list = map.get(key)
      if (list) list.push(update)
      else map.set(key, [update])
    }
    return [...map.entries()]
  }, [visible])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl p-3 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="toolbar-scroll flex min-w-0 flex-1 items-center gap-1.5">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setFilter(option.key)}
                className={`shrink-0 rounded-full px-3 py-1 text-sm transition ${
                  filter === option.key
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowTrash(true)}
            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            🗑 ゴミ箱{trashCount > 0 && `（${trashCount}）`}
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
            まだ何もありません。
          </p>
        ) : (
          <div className="space-y-6">
            {groups.map(([day, list]) => (
              <section key={day}>
                <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
                  {format(parseISO(day), 'M月d日(E)', { locale: ja })}
                </h3>
                <ul className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-3">
                  {list.map((update) => (
                    <UpdateRow
                      key={update.id}
                      update={update}
                      onJump={onJump}
                      onOpenChat={onOpenChat}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400">
          付箋の移動やサイズ変更は記録していません（流れが埋まってしまうため）。
          付箋・予定・やることの記録はデータベース側で行っているので、あとから書き換えることはできません。
        </p>
      </div>

      <Suspense fallback={null}>
        {showTrash && <TrashModal onClose={() => setShowTrash(false)} />}
      </Suspense>
    </div>
  )
}

function UpdateRow({
  update,
  onJump,
  onOpenChat,
}: {
  update: BoardUpdate
  onJump: (tab: TabKey, id: string | null) => void
  onOpenChat: () => void
}) {
  const at = parseISO(update.at)
  const clickable = update.opensChat || update.jump !== null

  function open() {
    if (update.opensChat) {
      onOpenChat()
      return
    }
    if (update.jump) onJump(update.jump.tab, update.jump.id)
  }

  const body = (
    <>
      <span
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
        style={{ background: colorForUser(update.actorId ?? 'unknown') }}
      >
        {(update.actorName || '?').slice(0, 1)}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-700">
          <span className="font-medium">{update.actorName || '名前なし'}</span>
          <span className="mx-1">{update.icon}</span>
          {update.text}
        </p>
        {update.detail && <p className="truncate text-xs text-slate-500">「{update.detail}」</p>}
        <p className="text-xs text-slate-400">
          {isToday(at)
            ? `${formatDistanceToNowStrict(at, { locale: ja })}前`
            : format(at, 'HH:mm')}
        </p>
      </div>
    </>
  )

  return (
    <li>
      {clickable ? (
        <button
          type="button"
          onClick={open}
          className="flex w-full gap-2.5 rounded-lg px-1 py-1 text-left transition hover:bg-slate-50"
        >
          {body}
        </button>
      ) : (
        <div className="flex gap-2.5 px-1 py-1">{body}</div>
      )}
    </li>
  )
}
