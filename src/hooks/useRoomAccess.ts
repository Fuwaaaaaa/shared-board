import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useIdentity } from '../lib/identity'
import { samePreview } from '../lib/access'
import type { RoomPreview } from '../lib/types'

/*
 * 設定の変更は presence チャンネルの合図で届くが、送り手のチャンネルが
 * 繋がっていなければ送られないし、途中で切れれば届かない。取りこぼしても
 * いつかは追いつくように、開いている間だけ定期的に取り直す。
 *
 * ボードの設定はめったに変わらないので、間隔は長めでよい。
 */
const PREVIEW_POLL_MS = 60000
/** これより長く裏にいたら、表に戻ったときに取り直す */
const HIDDEN_REFRESH_MS = 30000

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

    // 中身が同じなら前のオブジェクトのまま。保険の取り直しで
    // 画面全体が描き直されるのを避ける
    setPreview((current) => (samePreview(current, room) ? current : room))

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

  /*
   * 合図（lib/roomChannel）を取りこぼしたときの保険。
   *
   * 名前の変更・終了・リンクの作り直し・公開設定の切り替えは rooms の更新で、
   * rooms は Realtime 配信に載せていない（載せると、締め出したはずの
   * 承認待ち・取り消し済みの人にも新しい slug が届いてしまう）。
   * 送り手側の合図が唯一の即時経路なので、届かなかったときのために
   * 表に戻ったとき・オンラインに戻ったとき・開いている間は一定間隔で取り直す。
   */
  useEffect(() => {
    if (!slug) return
    let hiddenAt: number | null = null

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const wasHidden = hiddenAt !== null && Date.now() - hiddenAt >= HIDDEN_REFRESH_MS
      hiddenAt = null
      if (wasHidden) void refresh()
    }
    const onOnline = () => void refresh()

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, PREVIEW_POLL_MS)

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [slug, refresh])

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
