import { memo } from 'react'

interface Props {
  canEdit: boolean
  onAddNote: () => void
  onPickTemplate: () => void
  onOpenShare: () => void
}

/**
 * 何も置かれていないボードの真ん中に出す案内。
 *
 * 初めて開いた人が「何をすればいいか」を迷わないように、
 * 最初の一歩になる 3 つだけを並べる。ボードの操作（範囲選択など）を邪魔しないよう、
 * 外側は pointer-events を切り、ボタンだけ受け付ける。
 */
function BoardEmptyState({ canEdit, onAddNote, onPickTemplate, onOpenShare }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center print:hidden">
      <div className="pointer-events-auto max-w-sm rounded-2xl border border-dashed border-slate-300 bg-white/90 p-6 text-center shadow-sm backdrop-blur-sm">
        {canEdit ? (
          <>
            <p className="text-sm font-medium text-slate-700">まだ何もありません</p>
            <p className="mt-1 text-xs text-slate-500">最初の一枚を置いてみましょう</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={onAddNote}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
              >
                🗒 付箋を貼る
              </button>
              <button
                type="button"
                onClick={onPickTemplate}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
              >
                📐 テンプレートを選ぶ
              </button>
              <button
                type="button"
                onClick={onOpenShare}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
              >
                🔗 リンクを送る
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">まだ何もありません</p>
        )}
      </div>
    </div>
  )
}

export default memo(BoardEmptyState)
