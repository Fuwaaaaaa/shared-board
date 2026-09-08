import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { dropEntry, updateEntry, useOutboxEntries } from '../lib/outboxStore'
import { isPersistent } from '../lib/writeQueueDb'
import type { FailureReason, QueueEntry } from '../lib/writeQueue'
import { downloadText } from '../lib/ics'

const TABLE_LABELS: Record<QueueEntry['table'], string> = {
  notes: '付箋',
  events: '予定',
  todos: 'やること',
  comments: 'コメント',
}

const REASON_LABELS: Record<FailureReason, string> = {
  permission: '書き込む権限がなくなっていました',
  conflict: '他の人が先に書き換えました',
  parent_gone: 'つながっていた相手が、もうありません',
  full: 'このボードの上限に達しています',
  too_long: '長すぎます',
  duplicate: '同じものが、すでに作られていました',
  identity_changed: 'この端末の「自分」が変わったため、もう送れません',
  unknown: '送れませんでした',
}

/** 一覧に出す 1 行の見出し */
function titleOf(entry: QueueEntry): string {
  const kind =
    entry.kind === 'create' ? '追加' : entry.kind === 'update' ? '書き換え' : '削除'
  return `${TABLE_LABELS[entry.table]}の${kind}`
}

/** 拾い出す用の本文 */
function bodyOf(entry: QueueEntry): string {
  if (entry.preview) return entry.preview
  const source = entry.row ?? entry.patch ?? entry.base ?? {}
  const value = source.text ?? source.title ?? source.body
  return typeof value === 'string' ? value : ''
}

/**
 * 送信箱。
 *
 * オフラインのあいだにためた書き込みと、送れなかったものを見せる。
 *
 * いちばん大事なのは「行き止まりを作らない」こと。終了したボードでも、
 * 権限を外されていても、ここは開いて中身を見せ、コピーとテキスト保存ができる。
 * 送れないことより、書いた文字が取り出せないことのほうが困る。
 */
export default function OutboxModal({ onClose }: { onClose: () => void }) {
  const entries = useOutboxEntries()
  const pending = entries.filter((entry) => entry.state !== 'failed')
  const failed = entries.filter((entry) => entry.state === 'failed')

  const allText = entries
    .map((entry) => `[${titleOf(entry)}] ${bodyOf(entry)}`)
    .filter(Boolean)
    .join('\n')

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(allText)
    } catch {
      // 使えない環境もある。下の「テキストで保存」で拾える
    }
  }

  /** 送り直す。競合したものは、こちらの内容で上書きする */
  async function retry(entry: QueueEntry) {
    await updateEntry(entry.key, {
      state: 'pending',
      attempts: 0,
      nextAttemptAt: undefined,
      reason: undefined,
      errorText: undefined,
      serverText: undefined,
      // ロックを外して送る（「自分の内容にする」を選んだということ）
      expectUpdatedAt: undefined,
    })
  }

  async function discard(entry: QueueEntry) {
    if (!window.confirm('この内容を捨てます。戻せません。よろしいですか？')) return
    await dropEntry(entry.key)
  }

  function renderRow(entry: QueueEntry) {
    const body = bodyOf(entry)

    return (
      <li key={entry.key} className="border-b border-slate-100 px-3 py-2 last:border-b-0">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-xs text-slate-500">{titleOf(entry)}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
            {body || '（本文なし）'}
          </span>
          <span className="shrink-0 text-xs text-slate-400">
            {format(parseISO(entry.enqueuedAt), 'M月d日 HH:mm', { locale: ja })}
          </span>
        </div>

        {entry.state === 'failed' && (
          <div className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-2">
            <p className="text-xs text-rose-800">
              {REASON_LABELS[entry.reason ?? 'unknown']}
              {entry.errorText && <span className="text-rose-600">（{entry.errorText}）</span>}
            </p>

            {entry.reason === 'conflict' && (
              <div className="mt-1.5 space-y-1 text-xs">
                <p className="text-slate-600">
                  <span className="text-slate-400">自分：</span>
                  {body}
                </p>
                <p className="text-slate-600">
                  <span className="text-slate-400">相手：</span>
                  {entry.serverText}
                </p>
              </div>
            )}

            <div className="mt-1.5 flex flex-wrap gap-3">
              {entry.reason !== 'identity_changed' && (
                <button
                  type="button"
                  onClick={() => void retry(entry)}
                  className="text-xs text-slate-700 underline transition hover:text-slate-900"
                >
                  {entry.reason === 'conflict' ? '自分の内容にする' : 'もう一度送る'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(body).catch(() => {})}
                className="text-xs text-slate-700 underline transition hover:text-slate-900"
              >
                コピー
              </button>
              <button
                type="button"
                onClick={() => void discard(entry)}
                className="text-xs text-slate-500 underline transition hover:text-rose-700"
              >
                捨てる
              </button>
            </div>
          </div>
        )}
      </li>
    )
  }

  return (
    <Modal title="送信箱" onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        オフラインのあいだに書いたものは、この端末にためて、つながったら送ります。
        {!isPersistent() && (
          <span className="text-rose-700">
            {' '}
            この端末ではためておけないため、タブを閉じると消えます。
          </span>
        )}
      </p>

      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          送信待ちのものはありません。
        </p>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-bold tracking-wide text-slate-500">
                ↑ 送信待ち（{pending.length}）
              </h3>
              <ul className="overflow-hidden rounded-xl border border-slate-200">
                {pending.map(renderRow)}
              </ul>
            </section>
          )}

          {failed.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-bold tracking-wide text-rose-700">
                ⚠ 送れなかったもの（{failed.length}）
              </h3>
              <ul className="overflow-hidden rounded-xl border border-rose-200">
                {failed.map(renderRow)}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => void copyAll()}
              className="text-xs text-slate-600 underline transition hover:text-slate-900"
            >
              全部コピー
            </button>
            <button
              type="button"
              onClick={() => downloadText('送信箱.txt', allText, 'text/plain')}
              className="text-xs text-slate-600 underline transition hover:text-slate-900"
            >
              テキストで保存
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
