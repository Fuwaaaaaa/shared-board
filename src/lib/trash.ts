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

/** 同じ「ひと撫で」とみなす、消した時刻の間隔（ミリ秒） */
export const ERASE_GAP_MS = 3000

export interface ErasedGroup<T> {
  /** 画面の key。グループの先頭行の id */
  key: string
  rows: T[]
  /**
   * グループの中でいちばん古い削除時刻。
   * 残り日数はここで見る——先に消えるほうに合わせないと、
   * 「あと 3 日」と出ているのに一部だけ先に消える。
   */
  deletedAt: string
}

interface Erasable {
  id: string
  author_id: string
  deleted_at: string | null
}

/**
 * 消しゴムで消した線を、ひと撫でごとにまとめる。
 *
 * 消しゴムは 1 本ずつ別の書き込みとして消すので、20 本まとめて消すと
 * ゴミ箱の行も 20 行になる。そのままでは一覧が埋まって使いものにならない。
 *
 * まとめる手がかりは「誰が」と「いつ」だけ。1 回の操作に印をつける列を足す手も
 * あったが、消した時刻はもう持っているので、列を増やさずに済むほうを選んだ。
 * 同時に 2 人が消しても、author_id が違えば別のグループになる。
 *
 * 間隔は前の行から数える（グループの先頭からではない）。ゆっくり撫でても
 * 1 つに収まってほしいため。
 */
export function groupErased<T extends Erasable>(
  rows: T[],
  gapMs: number = ERASE_GAP_MS,
): ErasedGroup<T>[] {
  const sorted = rows
    .filter((row) => row.deleted_at)
    .slice()
    .sort((a, b) => (a.deleted_at ?? '').localeCompare(b.deleted_at ?? ''))

  const buckets: T[][] = []
  let lastAt = 0

  for (const row of sorted) {
    const at = new Date(row.deleted_at as string).getTime()
    const previous = buckets[buckets.length - 1]
    const sameHand =
      previous !== undefined && previous[0].author_id === row.author_id && at - lastAt <= gapMs

    if (sameHand) previous.push(row)
    else buckets.push([row])
    lastAt = at
  }

  // 新しく消したグループが上に来るように（sortTrashed と同じ並び）
  return buckets
    .map((bucket) => ({
      key: bucket[0].id,
      rows: bucket,
      deletedAt: bucket[0].deleted_at as string,
    }))
    .reverse()
}
