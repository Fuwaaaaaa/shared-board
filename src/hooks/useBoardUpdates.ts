import { useMemo } from 'react'
import { useRoomData } from '../lib/roomData'
import { isOrphanComment } from '../lib/snapshot'
import type { TabKey } from '../components/RoomHeader'
import type { Activity, CommentTarget } from '../lib/types'

export type UpdateCategory = 'board' | 'calendar' | 'todo' | 'comment' | 'member'

export interface BoardUpdate {
  id: string
  /** ISO 文字列。並べ替えと未読判定にそのまま使う */
  at: string
  actorId: string | null
  actorName: string
  icon: string
  /** 「{actorName}」に続く文。助詞から始める */
  text: string
  /** 対象の中身（付箋の本文、コメント、予定名など） */
  detail: string
  category: UpdateCategory
  jump: { tab: TabKey; id: string | null } | null
  /** ボード全体のチャットは、タブ移動ではなくチャット欄を開く */
  opensChat: boolean
}

/** 直近これだけを見る。古いものは変更履歴の cron が消していく。 */
const LIMIT = 300

const TARGET_LABELS: Record<Activity['target_type'], string> = {
  notes: '付箋',
  events: '予定',
  todos: 'やること',
  images: '画像',
  attachments: 'ファイル',
  access: '',
}

/** 付箋・予定・やること・画像の履歴に使う文。アクセスまわりは accessLine が受け持つ */
const ACTION_LABELS: Partial<Record<Activity['action'], string>> = {
  created: 'を追加しました',
  updated: 'を書き換えました',
  deleted: 'を削除しました',
  completed: 'を完了しました',
  reopened: 'を未完了に戻しました',
  restored: 'をゴミ箱から戻しました',
}

const ACTION_ICONS: Partial<Record<Activity['action'], string>> = {
  created: '➕',
  updated: '✏️',
  deleted: '🗑',
  completed: '✅',
  reopened: '↩️',
  restored: '♻️',
}

const TARGET_TABS: Record<Activity['target_type'], TabKey | null> = {
  notes: 'board',
  events: 'calendar',
  todos: 'todo',
  images: 'board',
  attachments: 'board',
  access: null,
}

const TARGET_CATEGORIES: Record<Activity['target_type'], UpdateCategory> = {
  notes: 'board',
  events: 'calendar',
  todos: 'todo',
  images: 'board',
  attachments: 'board',
  access: 'member',
}

/**
 * アクセスまわりの出来事（target_type = 'access'）を 1 行の文にする。
 *
 * 付箋や予定は「が付箋を追加しました」のように種類と動作の組み合わせで決まるが、
 * こちらは相手の名前が入るもの・入らないものが混ざるので、動作ごとに文を持つ。
 * target_label には相手の名前、または設定変更の内容が入っている。
 *
 * actorName を返した行は、行の先頭に出す名前を差し替える。
 * 記録を activities へ移す前の古い承認には「誰が決めたか」が残っていないので、
 * 分かっている名前（＝承認された人）を先頭に出して、決めた人は書かない。
 */
function accessLine(
  activity: Activity,
): { icon: string; text: string; actorName?: string } {
  const who = activity.target_label || '名前なし'
  /** 移行前の記録。誰が決めたかが分からない */
  const legacy = activity.actor_id === null

  switch (activity.action) {
    case 'member_joined':
      return { icon: '🙌', text: 'がこのボードに参加しました' }
    case 'member_approved':
      return legacy
        ? { icon: '✅', text: 'の参加が承認されました', actorName: who }
        : { icon: '✅', text: `が ${who} さんの参加を承認しました` }
    case 'member_rejected':
      return legacy
        ? { icon: '🚫', text: 'の参加が見送られました', actorName: who }
        : { icon: '🚫', text: `が ${who} さんの参加を見送りました` }
    case 'member_removed':
      return { icon: '🚫', text: `が ${who} さんのアクセスを取り消しました` }
    case 'member_left':
      return { icon: '👋', text: 'がこのボードから退出しました' }
    case 'member_can_edit':
      return { icon: '✏️', text: `が ${who} さんを編集できるようにしました` }
    case 'member_view_only':
      return { icon: '👀', text: `が ${who} さんを閲覧のみにしました` }
    case 'members_revoked_all':
      return {
        icon: '🚪',
        text: activity.target_label
          ? `が参加者を全員外しました（${activity.target_label}）`
          : 'が参加者を全員外しました',
      }
    case 'board_closed':
      return { icon: '🔚', text: 'がこのボードを終了しました' }
    case 'board_reopened':
      return { icon: '▶️', text: 'がこのボードを再開しました' }
    case 'link_rotated':
      return { icon: '🔗', text: 'が共有リンクを作り直しました' }
    case 'owner_link_rotated':
      return { icon: '🔗', text: 'が復帰リンクを作り直しました' }
    case 'calendar_link_rotated':
      return { icon: '📅', text: 'がカレンダーの購読 URL を作り直しました' }
    case 'calendar_link_cleared':
      return { icon: '📅', text: 'がカレンダーの購読 URL を止めました' }
    case 'snapshot_restored':
      return { icon: '⏪', text: 'が保存した状態に戻しました' }
    case 'access_mode':
      return { icon: '🔑', text: `が入り方を「${who}」に変えました` }
    case 'join_settings':
      // 「新しい参加の受付を止めました」のように、そのまま文になっている
      return { icon: '🔐', text: `が${activity.target_label}` }
    case 'pin_set':
      return { icon: '🔑', text: 'が合言葉を設定しました' }
    case 'pin_cleared':
      return { icon: '🔑', text: 'が合言葉を外しました' }
    default:
      return { icon: '🔐', text: 'がアクセスの設定を変えました' }
  }
}

/*
 * 更新タブでの呼び名。上の TARGET_LABELS に揃えて「やること」と呼ぶ。
 *
 * types.ts の COMMENT_TARGET_LABELS とは顔ぶれが同じだが、あちらは検索用で
 * タブの名前（「リマインド」）を使う。揃え方が画面ごとに違うので、
 * ひとつの表には寄せていない。tab はここにしか無い。
 */
const COMMENT_TARGETS: Record<
  Exclude<CommentTarget, 'board'>,
  { label: string; tab: TabKey }
> = {
  note: { label: '付箋', tab: 'board' },
  event: { label: '予定', tab: 'calendar' },
  todo: { label: 'やること', tab: 'todo' },
  image: { label: '画像', tab: 'board' },
  file: { label: 'ファイル', tab: 'board' },
  frame: { label: 'フレーム', tab: 'board' },
}

/**
 * ボードで起きたことを 1 本の時系列にまとめる。
 *
 * 変更履歴・コメント・日程調整・参加者の動きは別々のテーブルに入っているが、
 * 使う人にとっては「このボードで何があったか」の 1 つの流れなので、
 * 表示の直前でここに集める。追加のフェッチは要らない。
 */
export function useBoardUpdates(): BoardUpdate[] {
  const {
    activities,
    comments,
    polls,
    pollOptions,
    members,
    notes,
    events,
    todos,
    images,
    attachments,
    frames,
  } = useRoomData()

  return useMemo(() => {
    const list: BoardUpdate[] = []

    for (const activity of activities.rows) {
      const access = activity.target_type === 'access' ? accessLine(activity) : null
      // アクセスまわりは飛び先がないので、行を押せないようにする
      const tab = access ? null : (TARGET_TABS[activity.target_type] ?? 'board')

      list.push({
        id: `activity:${activity.id}`,
        at: activity.created_at,
        actorId: activity.actor_id,
        actorName: access?.actorName ?? activity.actor_name,
        icon: access ? access.icon : (ACTION_ICONS[activity.action] ?? '•'),
        text: access
          ? access.text
          : `が${TARGET_LABELS[activity.target_type] ?? activity.target_type}${
              ACTION_LABELS[activity.action] ?? 'を変えました'
            }`,
        // アクセスまわりは相手の名前を本文に入れてしまうので、下の行には出さない
        detail: access || activity.target_label === '画像' ? '' : activity.target_label,
        category: TARGET_CATEGORIES[activity.target_type] ?? 'board',
        jump: tab ? { tab, id: null } : null,
        opensChat: false,
      })
    }

    /*
     * コメントの target_id には FK が無い（付箋・予定・やることのどれを指すかが
     * 行によって違うため）。保存した状態から戻すと、控えたあとに作った付箋への
     * コメントは宙ぶらりんになる。消すのは中身の破壊なので、ここで受ける——
     * 飛び先を外して、そう書く。
     */
    const liveIds = {
      notes: new Set(notes.rows.map((n) => n.id)),
      events: new Set(events.rows.map((e) => e.id)),
      todos: new Set(todos.rows.map((t) => t.id)),
      images: new Set(images.rows.map((i) => i.id)),
      attachments: new Set(attachments.rows.map((a) => a.id)),
      frames: new Set(frames.rows.map((f) => f.id)),
    }

    for (const comment of comments.rows) {
      const target =
        comment.target_type === 'board' ? null : COMMENT_TARGETS[comment.target_type]
      const orphan = isOrphanComment(comment, liveIds)

      list.push({
        id: `comment:${comment.id}`,
        at: comment.created_at,
        actorId: comment.author_id,
        actorName: comment.author_name,
        icon: '💬',
        text: !target
          ? 'がチャットに書きました'
          : orphan
            ? `が${target.label}にコメントしました（もう無い${target.label}です）`
            : `が${target.label}にコメントしました`,
        detail: comment.body,
        category: 'comment',
        jump: target && !orphan ? { tab: target.tab, id: comment.target_id } : null,
        opensChat: !target,
      })
    }

    for (const poll of polls.rows) {
      list.push({
        id: `poll:${poll.id}`,
        at: poll.created_at,
        actorId: poll.author_id,
        actorName: poll.author_name,
        icon: '🗳',
        text: 'が日程調整をはじめました',
        detail: poll.title,
        category: 'calendar',
        jump: null,
        opensChat: false,
      })

      // 決まった日は poll_options 側にあるので、確定した候補を探して添える
      if (poll.status === 'closed' && poll.decided_option_id) {
        const decided = pollOptions.rows.find((o) => o.id === poll.decided_option_id)
        list.push({
          id: `poll-decided:${poll.id}`,
          // 締めた時刻は持っていないので、候補の日付ではなく作成順の近くに置く
          at: poll.created_at,
          actorId: poll.author_id,
          actorName: poll.author_name,
          icon: '✅',
          text: 'が日程を決めました',
          detail: decided ? `${poll.title}` : poll.title,
          category: 'calendar',
          jump: { tab: 'calendar', id: null },
          opensChat: false,
        })
      }
    }

    for (const member of members.rows) {
      // ボードを作った人自身は「参加」として出さない
      if (member.role !== 'owner') {
        list.push({
          id: `member:${member.id}`,
          at: member.created_at,
          actorId: member.user_id,
          actorName: member.display_name,
          icon: member.status === 'pending' ? '🙋' : '👋',
          text: member.status === 'pending' ? 'が参加を申し込みました' : 'が参加しました',
          detail: member.message,
          category: 'member',
          jump: null,
          opensChat: false,
        })
      }

      // 承認・見送り・権限の変更は変更履歴（activities）側に入る。
      // decided_at からでは最後の 1 回しか残らず、誰が決めたのかも分からないため。
    }

    return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT)
  }, [
    activities.rows,
    comments.rows,
    polls.rows,
    pollOptions.rows,
    members.rows,
    notes.rows,
    events.rows,
    todos.rows,
    images.rows,
    attachments.rows,
    frames.rows,
  ])
}
