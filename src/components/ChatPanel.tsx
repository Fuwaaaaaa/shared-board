import CommentList from './CommentList'

/** 画面右から出てくるボード全体のチャット欄 */
export default function ChatPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-slate-900/20 lg:hidden"
        onClick={onClose}
        aria-hidden
      />
      <aside className="fixed top-0 right-0 z-40 flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="font-bold text-slate-800">💬 チャット</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <CommentList
          targetType="board"
          targetId={null}
          autoScroll
          placeholder="このボードのみんなに送信"
          emptyText="まだ発言はありません。最初のひとことをどうぞ。"
        />
      </aside>
    </>
  )
}
