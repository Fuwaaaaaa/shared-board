/*
 * 保存した状態（スナップショット）まわりの判断。
 *
 * 控えるのは「いま画面に出ているもの」で、戻すと今の中身がそれに置き換わる。
 * 置き換えはサーバー側の restore_snapshot が行い、控えに無い行はゴミ箱へ入れる。
 */

import type { Comment } from './types'

/*
 * payload の大きさの上限。
 *
 * supabase/schema.sql の v_limits にある snapshots.payload と同じ数で、
 * あちらは payload::text の文字数を見ている。合言葉の最短の長さと同じく
 * 2 か所に同じ数がある形なので、変えるときは両方そろえること。
 *
 * 画面側にも持たせているのは、押してから断られるのを避けるため。
 * 上限を握っているのはたいてい手描き（strokes の points）。
 */
export const PAYLOAD_LIMIT = 3_000_000

export interface PayloadSize {
  /** payload::text にしたときの文字数（サーバーが見るのと同じ尺度） */
  bytes: number
  /** いちばん大きい表の名前。断るときに、どこを減らせばよいか言うために使う */
  biggest: string
}

export function estimatePayloadSize(payload: Record<string, unknown[]>): PayloadSize {
  let biggest = ''
  let biggestSize = 0

  for (const [table, rows] of Object.entries(payload)) {
    const size = JSON.stringify(rows ?? []).length
    if (size > biggestSize) {
      biggestSize = size
      biggest = table
    }
  }

  return { bytes: JSON.stringify(payload).length, biggest }
}

/** 画面に出す表の名前 */
export const PAYLOAD_TABLE_LABELS: Record<string, string> = {
  notes: '付箋',
  strokes: '手描き',
  connectors: '線',
  frames: 'フレーム',
  events: '予定',
  event_overrides: '予定の「この回だけ」',
  todos: 'やること',
  images: '画像',
  attachments: 'ファイル',
  note_votes: '付箋の 👍',
  note_reactions: '絵文字',
  polls: '日程調整',
  poll_options: '候補日',
  poll_votes: '日程調整の投票',
  event_attendance: '出欠',
}

/**
 * 控えの中に、Storage の実体がもう無いものがあるか。
 *
 * 30 日より古い控えから戻すと、行は戻っても実体は掃除済みのことがある
 * （実体を守っているのは「行がまだ参照している」ことなので、
 * 行がゴミ箱の期限を過ぎて消えた時点で実体も消える）。
 * 戻したあとに黙って壊れた 📎 が並ぶより、そう言うほうがよい。
 */
export function missingBlobPaths(
  rows: { storage_path: string }[],
  existing: Set<string>,
): string[] {
  return rows.map((row) => row.storage_path).filter((path) => !existing.has(path))
}

/**
 * 対象がもう無いコメントか。
 *
 * comments.target_id には FK が無い（付箋・予定・やることのどれを指すかが
 * 行によって違うため）。控えたあとに作った付箋へのコメントは、戻すと
 * 宙ぶらりんになる。消すのは中身の破壊なので、表示側でそう見せて受ける。
 */
export function isOrphanComment(
  comment: Pick<Comment, 'target_type' | 'target_id'>,
  ids: { notes: Set<string>; events: Set<string>; todos: Set<string> },
): boolean {
  if (comment.target_type === 'board' || !comment.target_id) return false
  if (comment.target_type === 'note') return !ids.notes.has(comment.target_id)
  if (comment.target_type === 'event') return !ids.events.has(comment.target_id)
  if (comment.target_type === 'todo') return !ids.todos.has(comment.target_id)
  return false
}
