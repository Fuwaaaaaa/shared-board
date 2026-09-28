/*
 * タグの入力。Enter とカンマで確定する。
 *
 * 日本語入力では、変換を確定する Enter も keydown として届く。以前はそれを拾って、
 * 「かいぎ」のような読みのままタグにし、入力欄を空にしていた。
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TagInput from '../TagInput'

function setup() {
  const changes: string[][] = []
  render(<TagInput tags={[]} onChange={(tags) => changes.push(tags)} />)
  const input = screen.getByPlaceholderText('タグを追加して Enter')
  return { input, changes }
}

describe('TagInput', () => {
  it('Enter でタグになる', () => {
    const { input, changes } = setup()
    fireEvent.change(input, { target: { value: '会議' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes).toEqual([['会議']])
  })

  it('変換を確定する Enter ではタグにしない（Chrome / Firefox は isComposing）', () => {
    const { input, changes } = setup()
    fireEvent.change(input, { target: { value: 'かいぎ' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(changes).toEqual([])
    expect(input).toHaveValue('かいぎ')
  })

  it('変換を確定する Enter ではタグにしない（Safari は keyCode 229）', () => {
    const { input, changes } = setup()
    fireEvent.change(input, { target: { value: 'かいぎ' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(changes).toEqual([])
    expect(input).toHaveValue('かいぎ')
  })
})
