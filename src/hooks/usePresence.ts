import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { clearCursors, pruneCursors, setCursor } from '../lib/cursorStore'
import { registerRoomChannel, ROOM_CHANGED_EVENT } from '../lib/roomChannel'

/** カーソルを送る間隔の下限（ミリ秒）。動かしっぱなしでも毎秒 20 回程度に抑える */
const CURSOR_THROTTLE_MS = 50
/** この時間カーソルが届かなければ非表示にする */
const CURSOR_TTL_MS = 5000

const PEER_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
]

/** 同じ人はいつも同じ色になるように、ID から決める */
export function colorForUser(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return PEER_COLORS[hash % PEER_COLORS.length]
}

export interface Peer {
  userId: string
  name: string
  color: string
  tab: string
  /** いま本文を編集している付箋。誰も編集していなければ null */
  editingNoteId: string | null
}

/** Presence に載せる自分の情報 */
interface PresenceMeta {
  name: string
  tab: string
  /** 編集中の付箋 id。載せておくと相手の画面に「○○さんが編集中」と出る */
  editing: string | null
}

/**
 * 「いま誰がこのボードを見ているか」と「ホワイトボード上のカーソル位置」を共有する。
 *
 * どちらも DB には保存せず、Supabase Realtime の Presence / Broadcast だけで扱う。
 * カーソル位置は state に持たず lib/cursorStore に流す（毎秒 20 回の再描画を避けるため）。
 *
 * onRoomChanged は「このボードの設定が変わった」という合図を受け取ったときに呼ばれる。
 * 中身は載っていないので、受け取った側で概要を取り直すこと（lib/roomChannel を参照）。
 */
export function usePresence(
  roomId: string,
  userId: string,
  displayName: string,
  tab: string,
  onRoomChanged?: () => void,
) {
  const [presenceState, setPresenceState] = useState<Record<string, PresenceMeta>>({})

  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastSentRef = useRef(0)
  const editingRef = useRef<string | null>(null)
  const metaRef = useRef<PresenceMeta>({ name: displayName, tab, editing: null })
  metaRef.current = { name: displayName, tab, editing: editingRef.current }

  // 毎回張り直さずに最新の関数を呼べるように、ref 越しにする（metaRef と同じ理由）
  const onRoomChangedRef = useRef(onRoomChanged)
  onRoomChangedRef.current = onRoomChanged

  useEffect(() => {
    // private: true にすると、このチャンネルへの参加と送信に realtime.messages の
    // RLS が効くようになる（supabase/schema.sql の 6. リアルタイム配信）。
    //
    // これが無いと、在席とカーソルは RLS の外に置かれたままになる。Supabase の既定では
    // 有効な JWT さえあれば任意の名前のトピックに入れるので、一度ボードに入って
    // id を知った人は、あとでアクセスを取り消されても、誰がオンラインか・表示名・
    // 見ているタブ・編集中の付箋・マウス座標を見続けられてしまう。
    //
    // ポリシー側と対になっている。片方だけ入れると購読ごと失敗するので、
    // schema.sql を流し直さずにここだけ変えないこと。
    const channel = supabase.channel(`presence:${roomId}`, {
      config: {
        private: true,
        presence: { key: userId },
        broadcast: { self: false },
      },
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<Partial<PresenceMeta>>()
        const next: Record<string, PresenceMeta> = {}
        for (const [key, metas] of Object.entries(state)) {
          const meta = metas[metas.length - 1]
          if (meta) {
            next[key] = {
              name: meta.name ?? '',
              tab: meta.tab ?? '',
              editing: typeof meta.editing === 'string' ? meta.editing : null,
            }
          }
        }
        setPresenceState(next)
      })
      .on<{ userId: string; x: number; y: number; laser?: boolean }>(
        'broadcast',
        { event: 'cursor' },
        ({ payload }) => {
          // 中身をそのまま信じない。数でない座標や、在席していない人の id が
          // 混ざっていたら捨てる（在席していない = このボードにいない人の送信）。
          if (
            !payload ||
            typeof payload.userId !== 'string' ||
            !Number.isFinite(payload.x) ||
            !Number.isFinite(payload.y)
          ) {
            return
          }
          setCursor(payload.userId, {
            x: payload.x,
            y: payload.y,
            laser: Boolean(payload.laser),
            at: Date.now(),
          })
        },
      )
      // ボードの設定が変わったという合図。中身は無いので、受け取ったら自分で取り直す
      .on('broadcast', { event: ROOM_CHANGED_EVENT }, () => {
        onRoomChangedRef.current?.()
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        void channel.track(metaRef.current)
        // 繋がってから登録する。繋がる前に送っても届かない
        registerRoomChannel(roomId, channel)
      })

    channelRef.current = channel
    return () => {
      channelRef.current = null
      registerRoomChannel(roomId, null)
      supabase.removeChannel(channel)
      clearCursors()
    }
  }, [roomId, userId])

  // 表示名やタブを変えたら、その情報だけ送り直す
  useEffect(() => {
    const channel = channelRef.current
    if (channel?.state === 'joined') void channel.track(metaRef.current)
  }, [displayName, tab])

  // 古いカーソルを消す
  useEffect(() => {
    const timer = window.setInterval(() => pruneCursors(CURSOR_TTL_MS), 2000)
    return () => window.clearInterval(timer)
  }, [])

  /** ホワイトボードの論理座標を送る。laser=true なら「指している」印を付ける。 */
  const sendCursor = useCallback(
    (x: number, y: number, laser = false) => {
      const now = Date.now()
      if (now - lastSentRef.current < CURSOR_THROTTLE_MS) return
      lastSentRef.current = now

      const channel = channelRef.current
      if (channel?.state !== 'joined') return
      void channel.send({
        type: 'broadcast',
        event: 'cursor',
        payload: { userId, x, y, laser },
      })
    },
    [userId],
  )

  /** 編集を始めた / やめた付箋を知らせる。変わったときだけ送る */
  const setEditing = useCallback((noteId: string | null) => {
    if (editingRef.current === noteId) return
    editingRef.current = noteId
    metaRef.current = { ...metaRef.current, editing: noteId }
    const channel = channelRef.current
    if (channel?.state === 'joined') void channel.track(metaRef.current)
  }, [])

  const peers = useMemo<Peer[]>(() => {
    return Object.entries(presenceState)
      .map(([id, meta]) => ({
        userId: id,
        name: meta.name || '名前なし',
        color: colorForUser(id),
        tab: meta.tab,
        editingNoteId: meta.editing,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  }, [presenceState])

  return { peers, sendCursor, setEditing }
}
