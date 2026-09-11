/**
 * 送信箱の中身を、そのまま持ち出せる文字にする。
 *
 * 送信箱の画面（OutboxModal）と、レンダリングが落ちたときの受け皿
 * （ErrorBoundary）の両方が使う。落ちた画面からでも「書いた文字だけは
 * 取り出せる」ようにしておきたいので、React にも DOM にも寄りかからない。
 */

import type { QueueEntry } from './writeQueue'

export const OUTBOX_TABLE_LABELS: Record<QueueEntry['table'], string> = {
  notes: '付箋',
  events: '予定',
  todos: 'やること',
  comments: 'コメント',
}

/** 一覧に出す 1 行の見出し */
export function outboxTitleOf(entry: QueueEntry): string {
  const kind = entry.kind === 'create' ? '追加' : entry.kind === 'update' ? '書き換え' : '削除'
  return `${OUTBOX_TABLE_LABELS[entry.table]}の${kind}`
}

/** 拾い出す用の本文 */
export function outboxBodyOf(entry: QueueEntry): string {
  if (entry.preview) return entry.preview
  const source = entry.row ?? entry.patch ?? entry.base ?? {}
  const value = source.text ?? source.title ?? source.body
  return typeof value === 'string' ? value : ''
}

/** 送信箱ぜんぶを 1 つの文字にする。本文の無い行は落とす */
export function outboxAsText(entries: QueueEntry[]): string {
  return entries
    .map((entry) => `[${outboxTitleOf(entry)}] ${outboxBodyOf(entry)}`)
    .filter((line) => !line.endsWith('] '))
    .join('\n')
}
