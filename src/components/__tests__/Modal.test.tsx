/*
 * モーダルの土台。
 *
 * 28 個のモーダルが 1 つの Modal を共有しているので、ここが直れば全部が直る。
 * 見ているのは「支援技術にダイアログとして伝わるか」と「Tab が中で回るか」。
 * どちらも画面を見ているだけでは気づけず、壊れても静かなところ。
 */

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Modal from '../Modal'

/** Esc / Tab は window で拾っているので、window に投げる */
function press(key: string, shiftKey = false) {
  fireEvent.keyDown(window, { key, shiftKey })
}

describe('Modal — 支援技術への伝わり方', () => {
  it('ダイアログとして、見出しと結びついて伝わる', () => {
    render(
      <Modal title="共有" onClose={() => {}}>
        <p>中身</p>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // aria-labelledby の先が、実際に見出しを指している
    expect(dialog).toHaveAccessibleName('共有')
  })
})

describe('Modal — フォーカス', () => {
  it('開くと中へ移り、閉じると元の場所へ戻る', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>開く</button>
          {open && (
            <Modal title="共有" onClose={() => setOpen(false)}>
              <button>中のボタン</button>
            </Modal>
          )}
        </>
      )
    }
    render(<Host />)

    const opener = screen.getByRole('button', { name: '開く' })
    opener.focus()
    fireEvent.click(opener)

    // 中のいちばん最初のフォーカスできるもの（閉じるボタン）へ
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '閉じる' }))

    press('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('中にすでに当たっていれば、奪わない（autoFocus のため）', () => {
    render(
      <Modal title="入り方" onClose={() => {}}>
        <input autoFocus aria-label="合言葉" />
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByLabelText('合言葉'))
  })

  it('Tab は中で回り、端まで来たら反対の端へ', () => {
    render(
      <Modal title="共有" onClose={() => {}} footer={<button>保存</button>}>
        <input aria-label="名前" />
      </Modal>,
    )

    const close = screen.getByRole('button', { name: '閉じる' })
    const name = screen.getByLabelText('名前')
    const save = screen.getByRole('button', { name: '保存' })

    expect(document.activeElement).toBe(close)
    press('Tab')
    expect(document.activeElement).toBe(name)
    press('Tab')
    expect(document.activeElement).toBe(save)
    // 末尾の次は先頭へ（背後の画面へ抜けない）
    press('Tab')
    expect(document.activeElement).toBe(close)
    // 先頭で Shift+Tab なら末尾へ
    press('Tab', true)
    expect(document.activeElement).toBe(save)
  })
})

describe('Modal — 当てても移らないものが混ざったとき', () => {
  /*
   * ここが本題。Modal は行き先を決めてから preventDefault するので、
   * 「拾ったが focus は当たらない」要素を行き先に選ぶと、既定の動きまで
   * 殺したまま同じ要素を選び続け、Tab が二度と進まなくなる。
   * 画面は何も変わらないので、目で見ても壊れていると分からない。
   */
  it('display:none の入力があっても、Tab は止まらない', () => {
    render(
      <Modal title="書き出し・取り込み" onClose={() => {}} footer={<button>保存</button>}>
        {/* jsdom は Tailwind を読まないので、同じ意味の規則をここで置く */}
        <style>{'.hidden { display: none }'}</style>
        <input aria-label="ファイル" type="file" className="hidden" />
        <input aria-label="名前" />
      </Modal>,
    )

    const close = screen.getByRole('button', { name: '閉じる' })
    const name = screen.getByLabelText('名前')
    const save = screen.getByRole('button', { name: '保存' })

    expect(document.activeElement).toBe(close)
    press('Tab')
    expect(document.activeElement).toBe(name)
    press('Tab')
    expect(document.activeElement).toBe(save)
    press('Tab')
    expect(document.activeElement).toBe(close)
  })

  /*
   * 閲覧のみの人が予定・やることの詳細を開くと、中身が fieldset[disabled] になる。
   * 中の入力には disabled が付かないため、印だけを見ていると同じ止まり方をする。
   */
  it('fieldset[disabled] の中があっても、Tab は止まらない', () => {
    render(
      <Modal title="予定" onClose={() => {}} footer={<button>保存</button>}>
        <fieldset disabled>
          <input aria-label="題名" />
        </fieldset>
      </Modal>,
    )

    const close = screen.getByRole('button', { name: '閉じる' })
    const save = screen.getByRole('button', { name: '保存' })

    expect(document.activeElement).toBe(close)
    press('Tab')
    expect(document.activeElement).toBe(save)
    press('Tab')
    expect(document.activeElement).toBe(close)
  })
})

describe('Modal — 重ねたとき', () => {
  it('Esc も Tab も、いちばん手前の 1 枚だけが受け取る', () => {
    const closed: string[] = []
    render(
      <>
        <Modal title="奥" onClose={() => closed.push('奥')}>
          <button>奥のボタン</button>
        </Modal>
        <Modal title="手前" onClose={() => closed.push('手前')}>
          <input aria-label="手前の入力" />
        </Modal>
      </>,
    )

    press('Escape')
    expect(closed).toEqual(['手前'])

    // Tab も手前の中だけを回る
    press('Tab')
    const front = screen.getByRole('dialog', { name: '手前' })
    expect(front.contains(document.activeElement)).toBe(true)
  })
})
