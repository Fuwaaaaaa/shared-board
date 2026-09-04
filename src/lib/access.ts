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

/** そのモードにするときの visibility。合言葉の有無は set_join_pin 側で決まる */
export function visibilityFor(mode: AccessMode): Visibility {
  return mode === 'link' ? 'public' : 'private'
}

// 以前ここにあった revokeIsWeak（リンク公開だと取り消しが効かない、という注意書き用）は
// 無くした。読めるのは参加登録した人だけになり、取り消した人はリンク公開でも
// 再申請で承認待ちになるため、注意書きの前提が消えた。
