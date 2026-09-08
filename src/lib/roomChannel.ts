import type { RealtimeChannel } from '@supabase/supabase-js'

/*
 * ボードの設定が変わったことを、いま開いている人に知らせる。
 *
 * 使うのは usePresence が既に張っている presence:<roomId>（private）。
 * このトピックは realtime.messages のポリシー（supabase/schema.sql の 6. リアルタイム配信）で
 * can_access_room に絞られているので、届くのは作った人と承認済みの参加者だけ。
 * 承認待ちの人・取り消された人はトピックに入ることすらできない。
 *
 * rooms を Realtime 配信に載せる手もあるが、そちらは採らない。rooms_select は
 * 「作った人」または「名簿に載っている人」で、pending と rejected も通してしまう。
 * つまり共有リンクを作り直して締め出したその相手のタブに、新しい slug がその場で
 * 届いてしまう。作り直しの目的そのものと矛盾する。
 *
 * 送るのは「変わった」という合図だけで、中身は載せない。
 * 受け取った側が get_room_preview を呼び直すので、誰が何を知ってよいかは
 * 変わらずサーバーの security definer 関数が決める。broadcast の中身は
 * 承認済みの参加者なら誰でも作れるので、中身を信じる作りにしてはいけない
 * （たとえば archived: false を載せると「終了したボードが書ける」偽の画面を作れる）。
 * 合図だけなら、偽装されても余計な RPC が 1 回増えるだけで済む。
 */

export const ROOM_CHANGED_EVENT = 'room'

/** roomId → いま張っているチャンネル。usePresence が出し入れする */
const channels = new Map<string, RealtimeChannel>()

export function registerRoomChannel(roomId: string, channel: RealtimeChannel | null) {
  if (channel) channels.set(roomId, channel)
  else channels.delete(roomId)
}

/**
 * このボードを開いている他の人に「設定が変わった」と伝える。
 *
 * チャンネルがまだ繋がっていないときは何もしない。取りこぼしても
 * useRoomAccess 側の定期取り直し（60 秒）が拾うので、ここは best-effort でよい。
 */
export function notifyRoomChanged(roomId: string) {
  const channel = channels.get(roomId)
  if (channel?.state !== 'joined') return
  void channel.send({ type: 'broadcast', event: ROOM_CHANGED_EVENT, payload: {} })
}
