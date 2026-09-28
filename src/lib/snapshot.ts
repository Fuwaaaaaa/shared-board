/*
 * 保存した状態（スナップショット）まわりの判断。
 *
 * 控えるのは「いま画面に出ているもの」で、戻すと今の中身がそれに置き換わる。
 * 置き換えはサーバー側の restore_snapshot が行い、控えに無い行はゴミ箱へ入れる。
 */

import type { Comment, CommentTarget } from './types'

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

/*
 * 控える表。並びは restore_snapshot（supabase/schema.sql）が入れ直す順と同じで、
 * 指される側（付箋・予定・日程調整）を先に置いてある。
 *
 * 戻す側は、控えに載っていない今の行を「控えに無いもの」として片付ける。
 * 控える側で 1 つでも落とすと、その表は戻すたびに空になる
 * （以前は 7 表を落としていて、戻すと 👍・日程調整・出欠が消えていた）。
 * 両方の並びが同じであることは snapshot.test.ts で確かめている。
 */
export const SNAPSHOT_TABLES = [
  'notes',
  'strokes',
  'connectors',
  'frames',
  'events',
  'event_overrides',
  'todos',
  'images',
  'attachments',
  'note_votes',
  'note_reactions',
  'polls',
  'poll_options',
  'poll_votes',
  'event_attendance',
] as const

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number]

/** 画面に出す表の名前 */
export const PAYLOAD_TABLE_LABELS: Record<SnapshotTable, string> = {
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

/** いま生きている（ゴミ箱に入っていない）ものの id。コメントの飛び先の確認に使う */
export interface LiveTargetIds {
  notes: Set<string>
  events: Set<string>
  todos: Set<string>
  images: Set<string>
  attachments: Set<string>
  frames: Set<string>
}

/**
 * コメントの対象と、その id を持つ集合の対応。
 *
 * Record にしてあるので、CommentTarget を増やしたのにここを足し忘れると
 * 型で落ちる。以前は if を並べて最後に false を返していたので、
 * 知らない種類のコメントが「対象は生きている」と黙って扱われていた。
 */
const TARGET_SETS: Record<Exclude<CommentTarget, 'board'>, keyof LiveTargetIds> = {
  note: 'notes',
  event: 'events',
  todo: 'todos',
  image: 'images',
  file: 'attachments',
  frame: 'frames',
}

/**
 * 対象がもう無いコメントか。
 *
 * comments.target_id には FK が無い（付箋・予定・画像などのどれを指すかが
 * 行によって違うため）。控えたあとに作った付箋へのコメントは、戻すと
 * 宙ぶらりんになる。消すのは中身の破壊なので、表示側でそう見せて受ける。
 */
export function isOrphanComment(
  comment: Pick<Comment, 'target_type' | 'target_id'>,
  ids: LiveTargetIds,
): boolean {
  if (comment.target_type === 'board' || !comment.target_id) return false
  return !ids[TARGET_SETS[comment.target_type]].has(comment.target_id)
}
