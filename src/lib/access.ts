import type { RoomPreview, Visibility } from './types'

/**
 * ボードの「入り方」。
 *
 * DB は visibility（public / private）と合言葉の有無という 2 つの値で持っているが、
 * 使う人にとっては「どうやったら入れるか」がすべてなので、画面では次の 3 つだけを見せる。
 * 「非公開」という言い方は、承認制のことなのか保護されている状態のことなのか紛らわしいので使わない。
 *
 *   link     🌐 リンク公開   URL だけで入れる          visibility='public'
 *   pin      🔑 合言葉つき   URL ＋ 合言葉             visibility='private' ＋ 合言葉あり
 *   approval 🔒 承認制       作った人が承認したら入れる  visibility='private' ＋ 合言葉なし
 */
export type AccessMode = 'link' | 'pin' | 'approval'

export interface AccessModeInfo {
  key: AccessMode
  icon: string
  /** 画面に出す名前。ここ以外に別名を作らない */
  label: string
  /** 「どうやって入るか」の一言 */
  howToEnter: string
  /** 選ぶときの説明 */
  description: string
}

export const ACCESS_MODES: AccessModeInfo[] = [
  {
    key: 'link',
    icon: '🌐',
    label: 'リンク公開',
    howToEnter: 'URL だけ',
    description: 'リンクを知っている人は、誰でもすぐ参加できます。名前を入れるだけです。',
  },
  {
    key: 'pin',
    icon: '🔑',
    label: '合言葉つき',
    howToEnter: 'URL ＋ 合言葉',
    description: '合言葉を知っている人は、承認を待たずにその場で入れます。',
  },
  {
    key: 'approval',
    icon: '🔒',
    label: '承認制',
    howToEnter: '作った人の承認',
    description: 'リンクを開いた人には申請の画面が出ます。承認するまで中身は見えません。',
  },
]

export const ACCESS_MODE_MAP: Record<AccessMode, AccessModeInfo> = Object.fromEntries(
  ACCESS_MODES.map((mode) => [mode.key, mode]),
) as Record<AccessMode, AccessModeInfo>

/** いまの入り方を求める */
export function accessMode(room: { visibility: Visibility; needs_pin: boolean }): AccessMode {
  if (room.visibility === 'public') return 'link'
  return room.needs_pin ? 'pin' : 'approval'
}

export function accessInfo(room: Pick<RoomPreview, 'visibility' | 'needs_pin'>): AccessModeInfo {
  return ACCESS_MODE_MAP[accessMode(room)]
}

/**
 * 2 つの概要が同じ中身か。
 *
 * get_room_preview は合図を取りこぼしたときの保険として一定間隔でも呼ぶので、
 * 中身が同じなら前のオブジェクトを使い回して、ヘッダーやモーダルの描き直しを避ける。
 *
 * 項目を並べずに両方のキーを回すのは、RoomPreview に列が増えたときに
 * ここを直し忘れても自動で比べられるようにするため（中身はすべて文字列・真偽値・null）。
 */
export function samePreview(a: RoomPreview | null, b: RoomPreview | null): boolean {
  if (a === b) return true
  if (!a || !b) return false

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RoomPreview>
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/*
 * 合言葉の最短の長さ。
 *
 * サーバー（supabase/schema.sql の set_join_pin）が同じ数で弾く。
 * ボード全体の試行回数の枠は「正しい合言葉を知っている人まで巻き込む」ので
 * 緩くせざるを得ず、そのぶん合言葉そのものが推測されにくい必要がある。
 *
 * 画面側でも同じ判定を持つのは、押してから断られるのを避けるため。
 * ここを変えるときは schema.sql も一緒に変えること。
 */
export const MIN_PIN_LENGTH = 6

/** 合言葉として使えるか。使えないときは、そのまま見せられる理由を返す */
export function checkPin(pin: string): string | null {
  const trimmed = pin.trim()
  if (!trimmed) return '合言葉を決めてください。'
  if (trimmed.length < MIN_PIN_LENGTH) {
    return `合言葉は ${MIN_PIN_LENGTH} 文字以上にしてください。`
  }
  return null
}

/** そのモードにするときの visibility。合言葉の有無は set_join_pin 側で決まる */
export function visibilityFor(mode: AccessMode): Visibility {
  return mode === 'link' ? 'public' : 'private'
}

// 以前ここにあった revokeIsWeak（リンク公開だと取り消しが効かない、という注意書き用）は
// 無くした。読めるのは参加登録した人だけになり、取り消した人はリンク公開でも
// 再申請で承認待ちになるため、注意書きの前提が消えた。
