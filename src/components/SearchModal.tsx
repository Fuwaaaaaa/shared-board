import { useMemo, useState } from 'react'
import Modal from './Modal'
import { useRoomData } from '../lib/roomData'
import { KIND_LABELS, searchRoom, type SearchHit } from '../lib/search'

export type { SearchHit }

interface Props {
  onClose: () => void
  onJump: (hit: SearchHit) => void
}

/**
 * 付箋・予定・TODO・コメントを横断して検索する。
 * 探す・並べるの中身は src/lib/search.ts（純粋関数・テストあり）。
 */
export default function SearchModal({ onClose, onJump }: Props) {
  const { notes, events, todos, comments } = useRoomData()
  const [query, setQuery] = useState('')

  const hits = useMemo(
    () =>
      searchRoom(query, {
        notes: notes.rows,
        events: events.rows,
        todos: todos.rows,
        comments: comments.rows,
      }),
    [query, notes.rows, events.rows, todos.rows, comments.rows],
  )

  return (
    <Modal title="ボード内を検索" onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="キーワードを入力（付箋・予定・リマインド・コメント）"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-800"
      />

      <div className="mt-4">
        {!query.trim() ? (
          <p className="py-8 text-center text-sm text-slate-400">
            キーワードを入力すると、ボード全体から探します。
          </p>
        ) : hits.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">見つかりませんでした。</p>
        ) : (
          <ul className="space-y-1">
            {hits.map((hit) => (
              <li key={hit.key}>
                <button
                  type="button"
                  onClick={() => onJump(hit)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50"
                >
                  <span className="mt-0.5 shrink-0">{hit.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-800">{hit.title}</span>
                    <span className="block truncate text-xs text-slate-400">{hit.subtitle}</span>
                  </span>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {KIND_LABELS[hit.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
