/*
 * 検索や通知から飛んできたときの「1 回だけ合わせる」。
 *
 * ここが緩むと、他の人が 1 行書き換えるたびに選択が奪われ、閉じたはずの
 * 編集モーダルが開き直る。自分の操作と結びつかないので、画面を見ていても
 * 壊れていると分からない類の不具合になる。
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useFocusJump } from '../useFocusJump'

interface Row {
  id: string
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))

describe('useFocusJump', () => {
  it('飛び先の行が届いてから合わせる', () => {
    const apply = vi.fn()
    const { rerender } = renderHook(({ list }: { list: Row[] }) => useFocusJump('a', 1, list, apply), {
      initialProps: { list: rows('b') },
    })
    expect(apply).not.toHaveBeenCalled()

    rerender({ list: rows('b', 'a') })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ id: 'a' })
  })

  it('他の人が書き換えても、同じ飛び先には二度と合わせない', () => {
    const apply = vi.fn()
    const { rerender } = renderHook(({ list }: { list: Row[] }) => useFocusJump('a', 1, list, apply), {
      initialProps: { list: rows('a') },
    })
    expect(apply).toHaveBeenCalledTimes(1)

    rerender({ list: rows('a', 'c') })
    rerender({ list: rows('a', 'c', 'd') })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('もう一度同じところへ飛べば、また合わせる', () => {
    const apply = vi.fn()
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) => useFocusJump('a', nonce, rows('a'), apply),
      { initialProps: { nonce: 1 } },
    )
    expect(apply).toHaveBeenCalledTimes(1)

    rerender({ nonce: 2 })
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('false を返したら、まだ合わせられていない扱いにする（置き場所が無いとき）', () => {
    const apply = vi.fn(() => false)
    const { rerender } = renderHook(({ list }: { list: Row[] }) => useFocusJump('a', 1, list, apply), {
      initialProps: { list: rows('a') },
    })
    expect(apply).toHaveBeenCalledTimes(1)

    rerender({ list: rows('a', 'c') })
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('飛び先が指定されていなければ何もしない', () => {
    const apply = vi.fn()
    renderHook(() => useFocusJump(null, 1, rows('a'), apply))
    expect(apply).not.toHaveBeenCalled()
  })
})
