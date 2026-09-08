import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isToday, parseISO } from 'date-fns'
import { ja } from 'date-fns/locale'
import { useIdentity } from '../lib/identity'
import { useRoomData } from '../lib/roomData'
import { colorForUser } from '../hooks/usePresence'
import { notifyMentions } from '../hooks/useNotifications'
import { useOptimisticTable } from '../hooks/useOptimisticTable'
import { useNotice } from '../hooks/useNotice'
import type { Comment, CommentTarget } from '../lib/types'

interface Props {
  targetType: CommentTarget
  /** ボード全体のチャットなら null */
  targetId: string | null
  placeholder?: string
  /** 一覧を下端に固定して自動スクロールするか（チャット用） */
  autoScroll?: boolean
  emptyText?: string
}

/** ボードチャットと、付箋・予定・TODO へのコメントの両方で使う */
export default function CommentList({
  targetType,
  targetId,
  placeholder = 'メッセージを入力',
  autoScroll = false,
  emptyText = 'まだコメントはありません',
}: Props) {
  const { userId, displayName } = useIdentity()
  const { roomId, comments, approvedMembers } = useRoomData()
  const [notice, setNotice] = useNotice()
  const commentOps = useOptimisticTable<Comment>('comments', comments, setNotice, {
    roomId,
    userId,
  })
  const [body, setBody] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /** 入力中の「@…」を拾って候補を出す */
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    const query = mentionQuery.toLowerCase()
    return approvedMembers
      .filter((m) => m.user_id !== userId && m.display_name)
      .filter((m) => !query || m.display_name.toLowerCase().startsWith(query))
      .slice(0, 5)
  }, [mentionQuery, approvedMembers, userId])

  function handleChange(value: string) {
    setBody(value)
    const match = /@([^\s@]*)$/.exec(value)
    setMentionQuery(match ? match[1] : null)
  }

  function insertMention(name: string) {
    setBody((current) => current.replace(/@([^\s@]*)$/, `@${name} `))
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const list = useMemo(() => {
    return comments.rows
      .filter((c) => c.target_type === targetType && (c.target_id ?? null) === targetId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [comments.rows, targetType, targetId])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [list.length, autoScroll])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = body.trim()
    if (!trimmed) return

    const comment: Comment = {
      id: crypto.randomUUID(),
      room_id: roomId,
      target_type: targetType,
      target_id: targetId,
      body: trimmed,
      author_id: userId,
      author_name: displayName,
      created_at: new Date().toISOString(),
    }

    setBody('')
    setMentionQuery(null)
    if (!(await commentOps.insert([comment], '送信'))) return

    // 本文に @名前 があれば、その人に通知を送る
    await notifyMentions({
      body: trimmed,
      roomId,
      members: approvedMembers,
      actorId: userId,
      actorName: displayName,
      linkTab: targetType === 'event' ? 'calendar' : targetType === 'todo' ? 'todo' : 'board',
      linkId: targetId,
    })
  }

  async function remove(id: string) {
    const target = list.find((c) => c.id === id)
    if (!target) return
    await commentOps.remove([target], '削除')
  }

  return (
    <div className={autoScroll ? 'flex h-full min-h-0 flex-col' : 'space-y-3'}>
      {notice && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {notice}
        </p>
      )}
      <div className={autoScroll ? 'min-h-0 flex-1 space-y-3 overflow-y-auto p-4' : 'space-y-3'}>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">{emptyText}</p>
        ) : (
          list.map((comment) => {
            const mine = comment.author_id === userId
            const at = parseISO(comment.created_at)
            return (
              <div key={comment.id} className="group flex gap-2.5">
                <span
                  className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
                  style={{ background: colorForUser(comment.author_id) }}
                  title={comment.author_name}
                >
                  {(comment.author_name || '?').slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-slate-700">
                      {comment.author_name || '名前なし'}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {isToday(at)
                        ? format(at, 'HH:mm')
                        : format(at, 'M/d(E) HH:mm', { locale: ja })}
                    </span>
                    {mine && (
                      <button
                        type="button"
                        onClick={() => remove(comment.id)}
                        className="ml-auto shrink-0 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-rose-600"
                      >
                        削除
                      </button>
                    )}
                  </div>
                  <p className="text-sm break-words whitespace-pre-wrap text-slate-700">
                    {comment.body}
                  </p>
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className={autoScroll ? 'shrink-0 border-t border-slate-200 p-3' : ''}>
        {mentionCandidates.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {mentionCandidates.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() => insertMention(member.display_name)}
                className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50"
              >
                @{member.display_name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => insertMention('全員')}
              className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50"
            >
              @全員
            </button>
          </div>
        )}

        <form onSubmit={send} className="flex gap-2">
          <input
            ref={inputRef}
            value={body}
            maxLength={1000}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
          />
          <button
            type="submit"
            disabled={!body.trim()}
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            送信
          </button>
        </form>
      </div>
    </div>
  )
}
