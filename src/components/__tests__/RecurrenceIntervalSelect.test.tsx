/*
 * 「n 回ごと」の選び方。
 *
 * 数値入力にせず選択肢にしてあるぶん、選択肢に無い値が入ってくると
 * select が黙って空欄になる。取り込んだ .ics や CSV は 1〜99 を通すので、
 * これは実際に起きる。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RecurrenceIntervalSelect from '../RecurrenceIntervalSelect'

const optionValues = () =>
  screen.getAllByRole('option').map((el) => (el as HTMLOptionElement).value)

describe('RecurrenceIntervalSelect', () => {
  it('周期ごとに決めた選択肢を並べる', () => {
    render(<RecurrenceIntervalSelect recurrence="weekly" interval={2} onChange={() => {}} />)
    expect(optionValues()).toEqual(['1', '2', '3', '4'])
    expect(screen.getByLabelText('何回ごとか')).toHaveValue('2')
  })

  it('選択肢に無い値でも、空欄にせず並びに混ぜる', () => {
    render(<RecurrenceIntervalSelect recurrence="weekly" interval={8} onChange={() => {}} />)
    expect(optionValues()).toEqual(['1', '2', '3', '4', '8'])
    expect(screen.getByLabelText('何回ごとか')).toHaveValue('8')
  })

  it('小さいほうへ混ざるときも順番は保つ', () => {
    render(<RecurrenceIntervalSelect recurrence="monthly" interval={5} onChange={() => {}} />)
    expect(optionValues()).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('繰り返さないなら何も出さない', () => {
    const { container } = render(
      <RecurrenceIntervalSelect recurrence="none" interval={1} onChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
