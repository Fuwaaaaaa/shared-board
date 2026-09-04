/**
 * ボード内の横断検索。
 *
 * 以前はこの処理が SearchModal の useMemo に埋まっていて、しかも並び替えが
 * 一切なかった。結果の順序は「種別のブロック順 ＋ DB が返した不定順」で決まり、
 * タイトルが完全に一致した予定より、たまたま先に取得された部分一致の付箋が
 * 上に出ていた。打ち切り（50 件）もブロックを連結したあとに掛けていたため、
 * 付箋が 50 件当たると予定・やること・コメントが 1 件も出なかった。
 *
 * ここに切り出したのは、順位付けの良し悪しがコードを読むだけでは分からず、
 * テストで固定するしかないため。このプロジェクトは DOM のテスト環境を持たないので、
 * 純粋関数にしておくことが唯一のテスト手段になる。
 */

import { toBoardParts } from './dates'
import type { CalendarEvent, Comment, Note, Todo } from './types'

export type SearchKind = 'note' | 'event' | 'todo' | 'comment'
/** 飛び先のタブ。RoomHeader の TabKey の部分集合（lib から UI に依存しないため別に持つ） */
export type SearchTab = 'board' | 'calendar' | 'todo'

export interface SearchHit {
  key: string
  kind: SearchKind
  tab: SearchTab
  /** 飛び先の ID。コメントの場合は紐づく対象の ID */
  targetId: string | null
  icon: string
  title: string
  subtitle: string
  /** 一致の強さ。UI では使わないが、並び順をテストで固定するために公開する */
  score: number
  /** 同点のときの新しさ。updated_at が無い型は created_at */
  stamp: string
}

export interface SearchInput {
  notes: Note[]
  events: CalendarEvent[]
  todos: Todo[]
  comments: Comment[]
}

export const KIND_LABELS: Record<SearchKind, string> = {
  note: '付箋',
  event: '予定',
  todo: 'リマインド',
  comment: 'コメント',
}

const LIMIT = 50

/*
 * 一致の強さ。「タイトルに当たった > 本文に当たった > 人の名前に当たった」を
 * 保てればよく、細かい値そのものに意味はない。
 */
const TITLE_EXACT = 100
const TITLE_PREFIX = 80
const TITLE_PART = 60
const TAG_EXACT = 70
const TAG_PART = 45
const BODY_PART = 40
const PERSON_PART = 20
/** 完了したやることは下げる。ただし消しはしない（「あれ終わったっけ」を探せるように） */
const DONE_PENALTY = 25

/**
 * 比べるための形に均す。
 *
 * NFKC で半角カナや全角英数を畳み、小文字にし、カタカナをひらがなへ寄せる。
 * この 3 段だけにしてあるのは、送り仮名や表記ゆれまで踏み込むと
 * 「なぜ当たらないのか」も「なぜ当たるのか」も説明できなくなるため。
 * 長音符（ー）は ァ-ヶ の範囲外なので、そのまま残って両方に効く。
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

type Field = 'title' | 'body' | 'person'

/** 当たらなければ 0 */
function textScore(q: string, value: string | null | undefined, field: Field): number {
  if (!value) return 0
  const folded = foldForSearch(value)
  if (!folded.includes(q)) return 0
  if (field === 'body') return BODY_PART
  if (field === 'person') return PERSON_PART
  if (folded === q) return TITLE_EXACT
  if (folded.startsWith(q)) return TITLE_PREFIX
  return TITLE_PART
}

/** 「#タグ名」でも「タグ名」でも当たる */
function tagScore(q: string, tags: string[] | null | undefined): number {
  let best = 0
  for (const tag of tags ?? []) {
    const folded = foldForSearch(tag)
    if (folded === q || `#${folded}` === q) best = Math.max(best, TAG_EXACT)
    else if (folded.includes(q) || `#${folded}`.includes(q)) best = Math.max(best, TAG_PART)
  }
  return best
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 曜日はボードの暦（JST）で決める。閲覧者のタイムゾーンに左右させない */
function weekdayOf(y: number, m: number, d: number): string {
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

function dateLabel(iso: string): string {
  const p = toBoardParts(new Date(iso))
  return `${p.y}/${p.m}/${p.d}(${weekdayOf(p.y, p.m, p.d)})`
}

function dateTimeLabel(iso: string): string {
  const p = toBoardParts(new Date(iso))
  const hh = String(p.hh).padStart(2, '0')
  const mm = String(p.mm).padStart(2, '0')
  return `${p.m}/${p.d}(${weekdayOf(p.y, p.m, p.d)}) ${hh}:${mm}`
}

/**
 * 付箋・予定・やること・コメントを横断して探す。
 *
 * 全体をスコア順に並べてから 50 件で切る。種別ごとに切らないのは、
 * 「付箋がたくさん当たると予定が 1 件も出ない」を避けるため。
 */
export function searchRoom(query: string, data: SearchInput): SearchHit[] {
  const q = foldForSearch(query.trim())
  if (!q) return []

  const hits: SearchHit[] = []

  for (const note of data.notes) {
    // 1 行目を見出し、全文を本文として扱う
    const firstLine = note.text.split('\n')[0]
    const score = Math.max(
      textScore(q, firstLine, 'title'),
      textScore(q, note.text, 'body'),
      textScore(q, note.author_name, 'person'),
      tagScore(q, note.tags),
    )
    if (score === 0) continue
    hits.push({
      key: `note:${note.id}`,
      kind: 'note',
      tab: 'board',
      targetId: note.id,
      icon: '🗒',
      title: firstLine || '（空の付箋）',
      subtitle: note.author_name,
      score,
      stamp: note.updated_at || note.created_at,
    })
  }

  for (const event of data.events) {
    const score = Math.max(
      textScore(q, event.title, 'title'),
      textScore(q, event.description, 'body'),
      textScore(q, event.author_name, 'person'),
      tagScore(q, event.tags),
    )
    if (score === 0) continue
    hits.push({
      key: `event:${event.id}`,
      kind: 'event',
      tab: 'calendar',
      targetId: event.id,
      icon: '📅',
      title: event.title,
      subtitle: dateLabel(event.start_at),
      score,
      stamp: event.updated_at || event.created_at,
    })
  }

  for (const todo of data.todos) {
    const subtaskScore = (todo.subtasks ?? []).reduce(
      (best, sub) => Math.max(best, textScore(q, sub.title, 'body')),
      0,
    )
    const base = Math.max(
      textScore(q, todo.title, 'title'),
      textScore(q, todo.notes, 'body'),
      // 付箋・予定は作者名で当たるので、やることも作者名を見る（以前は担当者だけだった）
      textScore(q, todo.author_name, 'person'),
      textScore(q, todo.assignee_name, 'person'),
      subtaskScore,
      tagScore(q, todo.tags),
    )
    if (base === 0) continue
    hits.push({
      key: `todo:${todo.id}`,
      kind: 'todo',
      tab: 'todo',
      targetId: todo.id,
      icon: todo.done ? '✅' : '⏰',
      title: todo.title,
      subtitle: todo.due_at ? `期限 ${dateTimeLabel(todo.due_at)}` : '期限なし',
      score: todo.done ? Math.max(1, base - DONE_PENALTY) : base,
      stamp: todo.created_at,
    })
  }

  /*
   * コメントは「対象が生きているもの」だけを出す。
   * comments はゴミ箱の除外を通っておらず、対象の削除状態も持っていないので、
   * ここで確かめないと、消した付箋へのコメントが当たり続ける。
   * しかも選んでも飛び先が無いので、押しても何も起きない当たりになる。
   */
  const liveTargets = new Set<string>([
    ...data.notes.map((n) => n.id),
    ...data.events.map((e) => e.id),
    ...data.todos.map((t) => t.id),
  ])

  for (const comment of data.comments) {
    // チャット（target_type === 'board'）は target_id を持たない
    if (comment.target_id !== null && !liveTargets.has(comment.target_id)) continue

    const score = Math.max(
      textScore(q, comment.body, 'body'),
      textScore(q, comment.author_name, 'person'),
    )
    if (score === 0) continue
    hits.push({
      key: `comment:${comment.id}`,
      kind: 'comment',
      tab:
        comment.target_type === 'event'
          ? 'calendar'
          : comment.target_type === 'todo'
            ? 'todo'
            : 'board',
      targetId: comment.target_id,
      icon: '💬',
      title: comment.body,
      subtitle: `${comment.author_name} — ${
        comment.target_type === 'board' ? 'チャット' : KIND_LABELS[comment.target_type]
      }へのコメント`,
      score,
      stamp: comment.created_at,
    })
  }

  // 強く当たった順 → 新しい順 → key 順（同点でも毎回同じ並びになるように）
  hits.sort(
    (a, b) => b.score - a.score || b.stamp.localeCompare(a.stamp) || a.key.localeCompare(b.key),
  )

  return hits.slice(0, LIMIT)
}
