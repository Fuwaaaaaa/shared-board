import { describe, expect, it } from 'vitest'
import { messageOf } from '../errorMessage'

describe('messageOf', () => {
  it('Error の message を出す', () => {
    expect(messageOf(new Error('保存できませんでした'))).toBe('保存できませんでした')
  })

  it('Supabase のエラー（Error ではないが message を持つ）も読む', () => {
    // ここが本題。PostgrestError は Error のインスタンスではない
    const postgrestError = {
      message: '合言葉は 6 文字以上にしてください',
      details: null,
      hint: null,
      code: 'P0001',
    }
    expect(messageOf(postgrestError)).toBe('合言葉は 6 文字以上にしてください')
  })

  it('文字列で投げられたものはそのまま', () => {
    expect(messageOf('つながりませんでした')).toBe('つながりませんでした')
  })

  it('message が無くても、手掛かりがあれば拾う', () => {
    expect(messageOf({ error_description: '期限が切れています' })).toBe('期限が切れています')
    expect(messageOf({ details: '行が見つかりません' })).toBe('行が見つかりません')
  })

  it('前後の空白は落とす', () => {
    expect(messageOf(new Error('  余白つき  '))).toBe('余白つき')
  })

  it('見せられるものが無いときに "[object Object]" を出さない', () => {
    // これを画面に出してしまうのが、直したかった不具合そのもの
    for (const value of [{}, [], null, undefined, 42, { message: '' }, { message: null }]) {
      const text = messageOf(value)
      expect(text).not.toContain('[object')
      expect(text.trim()).not.toBe('')
    }
  })

  it('意味のある文字列化はそのまま通す', () => {
    expect(messageOf(Symbol('しるし').toString())).toBe('Symbol(しるし)')
  })
})
