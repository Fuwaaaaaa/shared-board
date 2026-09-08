import { describe, expect, it } from 'vitest'
import { MIN_PIN_LENGTH, accessMode, checkPin, samePreview, visibilityFor } from '../access'
import type { RoomPreview } from '../types'

function makePreview(patch: Partial<RoomPreview> = {}): RoomPreview {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: '0123456789',
    name: '合宿の準備',
    visibility: 'public',
    owner_name: 'ゆうき',
    is_owner: false,
    my_status: 'approved',
    can_edit: true,
    archived: false,
    needs_pin: false,
    join_blocked: '',
    ...patch,
  }
}

describe('accessMode', () => {
  it('リンク公開・合言葉つき・承認制を、DB の 2 つの値から見分ける', () => {
    expect(accessMode({ visibility: 'public', needs_pin: false })).toBe('link')
    expect(accessMode({ visibility: 'private', needs_pin: true })).toBe('pin')
    expect(accessMode({ visibility: 'private', needs_pin: false })).toBe('approval')
  })

  it('公開のままなら、合言葉があっても「リンク公開」', () => {
    // 合言葉を設定すると必ず非公開へ落とすので、この組み合わせは残らないはず。
    // 万一残っても「合言葉つき」と名乗らせない（URL だけで読めてしまうため）
    expect(accessMode({ visibility: 'public', needs_pin: true })).toBe('link')
  })
})

describe('visibilityFor', () => {
  it('リンク公開だけが public', () => {
    expect(visibilityFor('link')).toBe('public')
    expect(visibilityFor('pin')).toBe('private')
    expect(visibilityFor('approval')).toBe('private')
  })
})

describe('checkPin', () => {
  /*
   * サーバー（supabase/schema.sql の set_join_pin）が同じ長さで弾く。
   * 画面側にも同じ判定があるのは、押してから断られるのを避けるため。
   * ここが緩むと、作成が「[object Object]」で失敗する側に戻る。
   */
  it('空は断る', () => {
    expect(checkPin('')).toBe('合言葉を決めてください。')
    expect(checkPin('   ')).toBe('合言葉を決めてください。')
  })

  it('短すぎるものは、理由を添えて断る', () => {
    expect(checkPin('1234')).toContain(`${MIN_PIN_LENGTH} 文字以上`)
    // 5 文字。以前は入力欄の例がこれだった
    expect(checkPin('あいことば')).toContain(`${MIN_PIN_LENGTH} 文字以上`)
  })

  it('ちょうど最短の長さなら通す', () => {
    expect(checkPin('あきまつり2')).toBeNull()
    expect(checkPin('123456')).toBeNull()
  })

  it('前後の空白は数に入れない', () => {
    expect(checkPin('  12345  ')).toContain(`${MIN_PIN_LENGTH} 文字以上`)
    expect(checkPin('  123456  ')).toBeNull()
  })

  it('十分に長ければ通す', () => {
    expect(checkPin('あきまつり2026')).toBeNull()
  })
})

describe('samePreview', () => {
  /*
   * 保険の取り直し（60 秒ごと）で毎回別のオブジェクトを返すと、
   * ヘッダーもモーダルも 1 分おきに描き直される。中身が同じなら同じと答えること。
   */
  it('中身が同じなら同じ', () => {
    expect(samePreview(makePreview(), makePreview())).toBe(true)
  })

  it('同じ参照なら同じ', () => {
    const preview = makePreview()
    expect(samePreview(preview, preview)).toBe(true)
  })

  it('null どうしは同じ、片方だけ null なら違う', () => {
    expect(samePreview(null, null)).toBe(true)
    expect(samePreview(makePreview(), null)).toBe(false)
    expect(samePreview(null, makePreview())).toBe(false)
  })

  it('終了・改名・リンクの作り直し・権限の変化はすべて違うと答える', () => {
    const before = makePreview()
    expect(samePreview(before, makePreview({ archived: true }))).toBe(false)
    expect(samePreview(before, makePreview({ name: '文化祭の準備' }))).toBe(false)
    expect(samePreview(before, makePreview({ slug: 'abcdef0123' }))).toBe(false)
    expect(samePreview(before, makePreview({ can_edit: false }))).toBe(false)
    expect(samePreview(before, makePreview({ visibility: 'private' }))).toBe(false)
    expect(samePreview(before, makePreview({ needs_pin: true }))).toBe(false)
    expect(samePreview(before, makePreview({ my_status: 'rejected' }))).toBe(false)
    expect(samePreview(before, makePreview({ is_owner: true }))).toBe(false)
    expect(samePreview(before, makePreview({ join_blocked: '受付を止めています' }))).toBe(false)
  })

  it('列が増えても、並べ直さずに比べられる', () => {
    // RoomPreview に列が増えたとき、この関数を直し忘れても気づけるようにしてある。
    // 型に無い列を混ぜて、キーを回して比べていることを確かめる
    const before = { ...makePreview(), future_flag: false } as unknown as RoomPreview
    const after = { ...makePreview(), future_flag: true } as unknown as RoomPreview
    expect(samePreview(before, after)).toBe(false)
  })
})
