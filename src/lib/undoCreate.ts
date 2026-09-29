/*
 * 付箋を作った操作を取り消すとき、本当に消すか、ゴミ箱へ入れるか。
 *
 * 作ってすぐの取り消しは本当に消したい。ゴミ箱が「作ってすぐ消した付箋」で
 * 埋まらず、送信箱にまだある作成なら中身を 1 文字も送らずに済む（writeQueue.collapse）。
 *
 * ただ、取り消しはいつでも押せる。そのあいだに他の人が線をつないだり 👍 したり
 * した付箋を本当に消すと、線・👍・絵文字は on delete cascade で巻き添えになり、
 * ゴミ箱にも残らない。やることや予定の「この付箋から生まれました」も外れる。
 * そういう付箋はゴミ箱へ入れて、30 日は戻せるようにする。
 *
 * 本当に消すのは「作ったときのまま、何もぶら下がっていない」付箋だけ。
 */

import type { Comment, Connector, Note } from './types'

export interface NoteDependents {
  /** いま見えている線 */
  connectors: Pick<Connector, 'from_note_id' | 'to_note_id'>[]
  /**
   * ゴミ箱にある線。
   * 自分の線は数えない——線でつないで取り消しただけ（自分の線がゴミ箱にある）なら、
   * 作ってすぐの取り消しと同じに扱いたい。他の人の線は、本当に消すと
   * その人がゴミ箱から戻せなくなるので数える。
   */
  trashedConnectors: Pick<Connector, 'from_note_id' | 'to_note_id' | 'author_id'>[]
  votes: { note_id: string }[]
  reactions: { note_id: string }[]
  comments: Pick<Comment, 'target_type' | 'target_id'>[]
  /** やること・予定（source_note_id でこの付箋を指しているもの） */
  derived: { source_note_id: string | null }[]
}

export interface UndoCreatePlan {
  /** 何もぶら下がっていない。本当に消す（作ったときの行） */
  drop: Note[]
  /** 誰かの手が入っている。ゴミ箱へ入れる（いまの行） */
  trash: Note[]
}

export function planUndoCreate(
  created: Note[],
  currentOf: (id: string) => Note | undefined,
  deps: NoteDependents,
  userId: string,
): UndoCreatePlan {
  const referenced = new Set<string>()
  for (const c of deps.connectors) {
    referenced.add(c.from_note_id)
    referenced.add(c.to_note_id)
  }
  for (const c of deps.trashedConnectors) {
    if (c.author_id === userId) continue
    referenced.add(c.from_note_id)
    referenced.add(c.to_note_id)
  }
  for (const v of deps.votes) referenced.add(v.note_id)
  for (const r of deps.reactions) referenced.add(r.note_id)
  for (const c of deps.comments) {
    if (c.target_type === 'note' && c.target_id) referenced.add(c.target_id)
  }
  for (const d of deps.derived) {
    if (d.source_note_id) referenced.add(d.source_note_id)
  }

  const plan: UndoCreatePlan = { drop: [], trash: [] }
  for (const note of created) {
    const current = currentOf(note.id)
    // もう無い、または誰かがゴミ箱へ入れた。そのままにする
    // （ゴミ箱から本当に消すと、その人の「消した」を消すことになる）
    if (!current || current.deleted_at) continue

    const edited =
      current.text !== note.text ||
      current.color !== note.color ||
      JSON.stringify(current.tags) !== JSON.stringify(note.tags)

    if (edited || referenced.has(note.id)) plan.trash.push(current)
    else plan.drop.push(note)
  }
  return plan
}
