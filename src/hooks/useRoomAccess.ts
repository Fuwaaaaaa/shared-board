import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import type { RoomPreview } from '../lib/types'

export type AccessLevel =
  | 'loading'
  | 'notfound'
  | 'owner' // 作成者
  | 'member' // 承認済み参加者
  | 'guest' // リンク公開のボードに来た直後。登録（request_access）が済むまで中身は読めない
  | 'pending' // 承認待ち
  | 'rejected' // 却下された・アクセスを取り消された
  | 'none' // 合言葉つき / 承認制のボードの未申請者

/**
 * slug からルームの概要と自分の権限を判定する。
 *
 * 合言葉つき / 承認制のボードは RLS で SELECT できないため、概要の取得は
 * get_room_preview RPC（security definer）経由で行う。
 * 承認されると room_members の Realtime イベントで自動的に権限が上がる。
 */
export function useRoomAccess(slug: string | undefined) {
  const { userId, displayName } = useIdentity()
  const [preview, setPreview] = useState<RoomPreview | null>(null)
  const [level, setLevel] = useState<AccessLevel>('loading')

  const refresh = useCallback(async () => {
    if (!slug) return
    const { data, error } = await supabase.rpc('get_room_preview', { p_slug: slug })
    const room = (data as RoomPreview[] | null)?.[0]

    if (error || !room) {
      setPreview(null)
      setLevel('notfound')
      return
    }

    setPreview(room)

    /*
     * 名簿に載っている人の状態を、ボードの公開設定より先に見る。
     *
     * 逆にすると、リンク公開のボードで「アクセスを取り消された人」や
     * 「承認待ちの人」が guest（＝まだ来ていない人）に混ざる。
     * 取り消したはずの人が入り直せてしまい、承認待ちの人には
     * 何度も参加登録が走る。guest は「名簿にまだ載っていない」ときだけ。
     */
    if (room.is_owner) setLevel('owner')
    else if (room.my_status === 'approved') setLevel('member')
    else if (room.my_status === 'rejected') setLevel('rejected')
    else if (room.my_status === 'pending') setLevel('pending')
    else if (room.visibility === 'public') setLevel('guest')
    else setLevel('none')
  }, [slug])

  useEffect(() => {
    setLevel('loading')
    void refresh()
  }, [refresh])

  // 自分のメンバー行が変わったら（＝承認・却下されたら）権限を取り直す
  useEffect(() => {
    if (!preview?.id) return
    const channel = supabase
      .channel(`access:${preview.id}:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_members',
          filter: `room_id=eq.${preview.id}`,
        },
        () => void refresh(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [preview?.id, userId, refresh])

  /**
   * 参加申請（公開ルームなら即参加）。戻り値は申請後のステータス。
   *
   * 合言葉・参加期限・人数上限の判定はサーバー側の RPC が行う。
   * 弾かれたときは例外の message にそのまま理由が入る。
   * 合言葉の不一致だけは例外ではなく 'pin_mismatch' が返る（サーバー側で失敗回数を
   * 数えるため。例外だと記録ごと巻き戻る）ので、ここで例外に読み替える。
   */
  const requestAccess = useCallback(
    async (message = '', pin = '') => {
      if (!slug) return null
      const { data, error } = await supabase.rpc('request_access', {
        p_slug: slug,
        p_name: displayName,
        p_message: message,
        p_pin: pin,
      })
      if (error) throw error
      if (data === 'pin_mismatch') throw new Error('合言葉が違います')
      await refresh()
      return data as string
    },
    [slug, displayName, refresh],
  )

  /** オーナー復帰リンク（?owner=...）からの権限回収 */
  const claimOwner = useCallback(
    async (token: string) => {
      if (!slug) return false
      const { data, error } = await supabase.rpc('claim_owner', {
        p_slug: slug,
        p_token: token,
        // 復帰した端末の表示名で名簿を更新する（渡さないと名前なしになる）
        p_name: displayName,
      })
      if (error) return false
      await refresh()
      return Boolean(data)
    },
    [slug, displayName, refresh],
  )

  return { preview, level, refresh, requestAccess, claimOwner }
}
