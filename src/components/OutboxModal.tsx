import { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import Modal from './Modal'
import { useRoomData } from '../lib/roomData'
import { dropEntry, updateEntry, useOutboxEntries } from '../lib/outboxStore'
import { isPersistent } from '../lib/writeQueueDb'
import { retryPatch, type FailureReason, type QueueEntry } from '../lib/writeQueue'
import { downloadText } from '../lib/ics'
import {
  outboxAsText,
  outboxTitleOf,
  outboxBodyOf,
} from '../lib/outboxText'

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
  const { roomId } = useRoomData()
  const all = useOutboxEntries()

  /*
   * 送信箱は端末にひとつで、全ボード分が同じ場所に入っている。
   * ここで絞らないと、別のボードにためたものが混ざって出て、
   * どれが今のボードの話なのか読めなくなる。
   */
  const entries = useMemo(() => all.filter((entry) => entry.roomId === roomId), [all, roomId])
  const elsewhere = all.length - entries.length

  const pending = entries.filter((entry) => entry.state !== 'failed')
  const failed = entries.filter((entry) => entry.state === 'failed')

  const allText = outboxAsText(entries)

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(allText)
    } catch {
      // 使えない環境もある。下の「テキストで保存」で拾える
    }
  }

  /** 送り直す。競合したものだけは、こちらの内容で上書きする（retryPatch） */
  async function retry(entry: QueueEntry) {
    await updateEntry(entry.key, retryPatch(entry))
  }

  async function discard(entry: QueueEntry) {
    if (!window.confirm('この内容を捨てます。戻せません。よろしいですか？')) return
    await dropEntry(entry.key)
  }

  function renderRow(entry: QueueEntry) {
    const body = outboxBodyOf(entry)

    return (
      <li key={entry.key} className="border-b border-slate-100 px-3 py-2 last:border-b-0">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-xs text-slate-500">{outboxTitleOf(entry)}</span>
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

      {/*
        別のボードのぶんは出さないが、あることは伝える。黙って隠すと、
        ためたまま忘れられて永久に出ていかない。取り出す道もここで残しておく。
      */}
      {elsewhere > 0 && (
        <p className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          別のボードにも、まだ送っていないものが {elsewhere} 件あります。
          そのボードを開くと送られます。
          <button
            type="button"
            onClick={() =>
              downloadText('送信箱_すべてのボード.txt', outboxAsText(all), 'text/plain')
            }
            className="ml-1 underline transition hover:text-slate-900"
          >
            すべてテキストで保存
          </button>
        </p>
      )}

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
