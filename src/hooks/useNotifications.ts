import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import type { AppNotification, NotificationKind, RoomMember } from '../lib/types'

/**
 * サイト内通知（@メンション）。
 *
 * 自分あての行だけが RLS で見えるので、user_id で絞って購読する。
 */
export function useAppNotifications(roomId: string) {
  const { userId } = useIdentity()
  const [rows, setRows] = useState<AppNotification[]>([])

  useEffect(() => {
    if (!roomId) return
    let cancelled = false

    supabase
      .from('notifications')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (!cancelled) setRows((data ?? []) as AppNotification[])
      })

    const channel = supabase
      .channel(`notifications:${roomId}:${userId}`)
      .on<AppNotification>(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          setRows((current) => {
            if (payload.eventType === 'DELETE') {
              const id = (payload.old as Partial<AppNotification>)?.id
              return id ? current.filter((n) => n.id !== id) : current
            }
            const incoming = payload.new as AppNotification
            if (incoming.room_id !== roomId) return current
            const index = current.findIndex((n) => n.id === incoming.id)
            if (index === -1) return [incoming, ...current]
            const next = current.slice()
            next[index] = incoming
            return next
          })
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [roomId, userId])

  const unread = useMemo(() => rows.filter((n) => !n.read).length, [rows])

  const markAllRead = useCallback(async () => {
    const ids = rows.filter((n) => !n.read).map((n) => n.id)
    if (ids.length === 0) return
    setRows((current) => current.map((n) => ({ ...n, read: true })))
    await supabase.from('notifications').update({ read: true }).in('id', ids)
  }, [rows])

  const markRead = useCallback(async (id: string) => {
    setRows((current) => current.map((n) => (n.id === id ? { ...n, read: true } : n)))
    await supabase.from('notifications').update({ read: true }).eq('id', id)
  }, [])

  const remove = useCallback(async (id: string) => {
    setRows((current) => current.filter((n) => n.id !== id))
    await supabase.from('notifications').delete().eq('id', id)
  }, [])

  return { rows, unread, markAllRead, markRead, remove }
}

/**
 * 1 人あてに通知を送る。
 *
 * 差出人の名前はサーバー側のトリガーが本人の表示名で上書きするので、
 * ここから渡す必要はない（なりすまし防止）。
 */
export async function notifyUser(options: {
  roomId: string
  userId: string
  kind: NotificationKind
  body: string
  linkTab: string
  linkId?: string | null
}) {
  const { roomId, userId, kind, body, linkTab, linkId = null } = options

  await supabase.from('notifications').insert({
    room_id: roomId,
    user_id: userId,
    kind,
    body: body.slice(0, 200),
    link_tab: linkTab,
    link_id: linkId,
  })
}

/**
 * 本文から @表示名 を拾い、その人あての通知を作る。
 *
 * 表示名に空白が入ることもあるので、参加者名との前方一致で探す。
 */
export async function notifyMentions(options: {
  body: string
  roomId: string
  members: RoomMember[]
  actorId: string
  actorName: string
  linkTab: string
  linkId: string | null
}): Promise<string[]> {
  const { body, roomId, members, actorId, actorName, linkTab, linkId } = options
  if (!body.includes('@')) return []

  const mentioned = new Map<string, string>()

  for (const member of members) {
    const name = member.display_name.trim()
    if (!name || member.user_id === actorId) continue
    if (body.includes(`@${name}`)) mentioned.set(member.user_id, name)
  }

  // @全員 / @all でそのボードの全員に送る
  const toAll = /@(全員|all)/i.test(body)
  if (toAll) {
    for (const member of members) {
      if (member.user_id === actorId) continue
      mentioned.set(member.user_id, member.display_name)
    }
  }

  if (mentioned.size === 0) return []

  const rows = [...mentioned.keys()].map((userId) => ({
    room_id: roomId,
    user_id: userId,
    actor_name: actorName,
    kind: 'mention',
    body: body.slice(0, 200),
    link_tab: linkTab,
    link_id: linkId,
  }))

  await supabase.from('notifications').insert(rows)
  return [...mentioned.values()]
}
