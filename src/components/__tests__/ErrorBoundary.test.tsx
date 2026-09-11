/*
 * 描画中に投げられた例外の受け皿。
 *
 * 困るのは真っ白になることより、オフラインのあいだにためた書き込みへ
 * 触る道が消えること（送信箱の入口は画面の中にしかない）。
 * ここで見るのは、代わりの画面が出るか・報告が飛ぶか・
 * ためたものを取り出せるか の 3 つ。
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reported: unknown[] = []
const saved: { name: string; body: string }[] = []
let snapshot: unknown[] = []

vi.mock('../../lib/errorReport', () => ({
  reportError: (error: unknown) => reported.push(error),
}))
vi.mock('../../lib/outboxStore', () => ({
  outboxSnapshot: () => snapshot,
}))
vi.mock('../../lib/ics', () => ({
  downloadText: (name: string, body: string) => saved.push({ name, body }),
}))

const { default: ErrorBoundary } = await import('../ErrorBoundary')

function Boom(): never {
  throw new Error('こわれた')
}

let consoleError: ReturnType<typeof vi.spyOn>

/*
 * React が境界で受け止めた例外も、jsdom には「捕まえられなかった例外」として
 * 一度届く。ここで止めておかないと、テストは通っているのに出力へ
 * 「Uncaught [Error: こわれた]」が並ぶ。わざと落としているので、それは雑音。
 */
const swallowUncaught = (e: ErrorEvent) => e.preventDefault()

beforeEach(() => {
  reported.length = 0
  saved.length = 0
  snapshot = []
  // React は境界で受けた例外もコンソールへ出す。テストの出力を汚さない
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.addEventListener('error', swallowUncaught)
})

afterEach(() => {
  window.removeEventListener('error', swallowUncaught)
  consoleError.mockRestore()
})

describe('ErrorBoundary', () => {
  it('子が落ちなければ、そのまま出す', () => {
    render(
      <ErrorBoundary where="page">
        <p>ふつうの中身</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('ふつうの中身')).toBeInTheDocument()
  })

  it('子が落ちたら代わりの画面を出し、どこで落ちたかを付けて報告する', () => {
    render(
      <ErrorBoundary where="page">
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('heading', { name: '表示できませんでした' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '読み込み直す' })).toBeInTheDocument()

    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('[page] こわれた')
  })

  it('未送信が無ければ、送信箱の話は出さない', () => {
    render(
      <ErrorBoundary where="page">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'テキストで保存' })).toBeNull()
  })

  it('未送信があれば件数を出し、テキストに落とせる', () => {
    snapshot = [
      { key: 'k1', table: 'notes', kind: 'create', preview: '体育館の鍵' },
      { key: 'k2', table: 'comments', kind: 'create', preview: 'ありがとう' },
    ]

    render(
      <ErrorBoundary where="page">
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText(/2 件/)).toBeInTheDocument()
    screen.getByRole('button', { name: 'テキストで保存' }).click()

    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('送信箱.txt')
    expect(saved[0].body).toBe('[付箋の追加] 体育館の鍵\n[コメントの追加] ありがとう')
  })
})

/*
 * タブやモーダルに置くときは、周りを残したまま、その場に収まってほしい。
 * 画面いっぱいの受け皿でヘッダーごと隠すと、送信箱への入口が結局消える。
 */
describe('ErrorBoundary — その場に収めるとき', () => {
  it('読み込み直さずに、もう一度描き直せる', () => {
    let broken = true
    function Sometimes() {
      if (broken) throw new Error('こわれた')
      return <p>直った中身</p>
    }

    render(
      <ErrorBoundary where="tab:board" variant="inline">
        <Sometimes />
      </ErrorBoundary>,
    )
    expect(screen.getByText('表示できませんでした')).toBeInTheDocument()

    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度開く' }))
    expect(screen.getByText('直った中身')).toBeInTheDocument()
  })

  it('画面いっぱいのときは、もう一度開くは出さない（周りに何も残らないため）', () => {
    render(
      <ErrorBoundary where="page">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('button', { name: 'もう一度開く' })).toBeNull()
    expect(screen.getByRole('button', { name: '読み込み直す' })).toBeInTheDocument()
  })
})
