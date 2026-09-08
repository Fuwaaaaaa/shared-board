/*
 * ゴミ箱まわりの判断。
 *
 * ゴミ箱がある理由は「Ctrl+Z が自分の操作にしか効かない」ことなので、
 * 他の人が消したものを戻す道として使われる。戻したときに壊れた見た目に
 * ならないかは、戻す前に判定しておく。
 */

import type { Connector } from './types'

/** ゴミ箱に残す日数。cron.sql の cleanup-trash と同じ数 */
export const TRASH_DAYS = 30

/**
 * この線を戻せるか。戻せないときは、そのまま見せられる理由を返す。
 *
 * つなぐ先の付箋がゴミ箱にあるまま線だけ戻すと、画面には何も出ない
 * （ConnectorsLayer が両端の付箋を引けないと描かない）。
 * 「戻したのに出てこない」がいちばん困るので、先に断る。
 */
export function connectorRestoreBlock(
  connector: Pick<Connector, 'from_note_id' | 'to_note_id'>,
  liveNoteIds: Set<string>,
  trashedNoteIds: Set<string>,
): string | null {
  const ends = [connector.from_note_id, connector.to_note_id]
  if (ends.every((id) => liveNoteIds.has(id))) return null
  if (ends.some((id) => trashedNoteIds.has(id))) return 'つなぐ先の付箋がゴミ箱にあります'
  return 'つなぐ先の付箋がもうありません'
}

/** 新しく捨てたものが上に来るよう並べる */
export function sortTrashed<T extends { deleted_at: string | null }>(rows: T[]): T[] {
  return rows
    .slice()
    .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''))
}

/**
 * 完全に消えるまであと何日か。
 *
 * 「30 日残ります」と書いてあるのに残り日数が見えないのが、これまでの弱点だった。
 * 期限を過ぎているものは 0（次の掃除で消える）。
 */
export function daysLeftInTrash(deletedAt: string, now: Date = new Date()): number {
  const gone = new Date(deletedAt).getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000
  const left = Math.ceil((gone - now.getTime()) / (24 * 60 * 60 * 1000))
  return Math.max(0, left)
}
