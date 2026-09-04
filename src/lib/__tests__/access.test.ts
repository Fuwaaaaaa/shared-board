import { describe, expect, it } from 'vitest'
import { MIN_PIN_LENGTH, accessMode, checkPin, visibilityFor } from '../access'

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
