/*
 * 「自分のデータを消す」で、何が消えるかを正しく見せてから消す。
 *
 * 以前は 2 つ食い違っていた。
 *
 *   1. 名簿を自分の行に絞らずに読んでいたので、参加しているだけのボードでも
 *      オーナーの行が返り、「作った人」と出ていた（確認の文言でも「消します」と出た）。
 *   2. 一覧を読み終える前に押すと、確認には「作ったボードは残ります」と出るのに、
 *      チェックが入っていればサーバーには「作ったボードも消す」が渡っていた。
 *
 * サーバー側（delete_my_account が消すもの）は pgTAP が見ている。
 * こちらは、画面が見せるものと渡すものが揃っているかだけを見る。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountModal from '../AccountModal'

type Reply = { data: unknown; error: unknown }

const server = vi.hoisted(() => ({
  /** 表ごとの返事。Promise を入れておけば、返事を待たせられる */
  replies: {} as Record<string, Reply | Promise<Reply>>,
  filters: {} as Record<string, [string, string, unknown][]>,
  rpc: vi.fn((_name: string, _args: unknown) => Promise.resolve({ data: null, error: null })),
}))

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from(table: string) {
      server.filters[table] = []
      const query = {
        select: () => query,
        order: () => query,
        eq(column: string, value: unknown) {
          server.filters[table].push(['eq', column, value])
          return query
        },
        neq(column: string, value: unknown) {
          server.filters[table].push(['neq', column, value])
          return query
        },
        then(resolve: (reply: Reply) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve(server.replies[table] ?? { data: [], error: null }).then(
            resolve,
            reject,
          )
        },
      }
      return query
    },
    rpc: server.rpc,
    auth: {
      getUser: () => Promise.resolve({ data: { user: null } }),
      signOut: () => Promise.resolve({ error: null }),
    },
  },
  ensureSession: () => Promise.resolve('me'),
}))

vi.mock('../../lib/identity', () => ({
  useIdentity: () => ({ userId: 'me', displayName: 'ゆうき' }),
}))

beforeEach(() => {
  server.replies = {}
  server.filters = {}
  server.rpc.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function openDeletePanel() {
  render(<AccountModal onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '自分のデータを消す' }))
}

describe('AccountModal — 自分のデータを消す', () => {
  it('作った人の印は、自分が作ったボードにだけ付く', async () => {
    server.replies.rooms = { data: [{ id: 'r1', name: '自分のボード' }], error: null }
    server.replies.room_members = {
      data: [
        { rooms: { id: 'r1', name: '自分のボード' } },
        { rooms: { id: 'r2', name: '人のボード' } },
      ],
      error: null,
    }

    openDeletePanel()

    const others = await screen.findByText('人のボード')
    expect(others.parentElement).not.toHaveTextContent('作った人')
    expect(screen.getByText('自分のボード').parentElement).toHaveTextContent('作った人')
    expect(screen.getAllByText('作った人')).toHaveLength(1)
  })

  it('作ったボードは owner_id で、参加しているボードは自分の行だけで引く', async () => {
    openDeletePanel()
    await screen.findByText('ボードはありません')

    expect(server.filters.rooms).toContainEqual(['eq', 'owner_id', 'me'])
    expect(server.filters.room_members).toContainEqual(['eq', 'user_id', 'me'])
    // 取り消されたボードは退会しても残るので、「消えるもの」として見せない
    expect(server.filters.room_members).toContainEqual(['neq', 'status', 'rejected'])
  })

  it('一覧を読み終えるまで、消すボタンは押せない', async () => {
    let release!: (reply: Reply) => void
    server.replies.rooms = new Promise<Reply>((resolve) => {
      release = resolve
    })

    openDeletePanel()

    const button = screen.getByRole('button', { name: '消す' })
    expect(button).toBeDisabled()
    expect(screen.getByText('読み込み中…')).toBeInTheDocument()

    release({ data: [], error: null })
    await waitFor(() => expect(button).toBeEnabled())
  })

  it('一覧を読めなかったら、消すボタンは押せないまま', async () => {
    server.replies.room_members = { data: null, error: { message: 'Failed to fetch' } }

    openDeletePanel()

    expect(await screen.findByText(/ボードの一覧を読めませんでした/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '消す' })).toBeDisabled()
  })

  it('確認で「作ったボードは残ります」と見せたら、作ったボードは消さない', async () => {
    server.replies.room_members = {
      data: [{ rooms: { id: 'r2', name: '人のボード' } }],
      error: null,
    }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    openDeletePanel()
    await screen.findByText('人のボード')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '消す' }))

    await waitFor(() => expect(server.rpc).toHaveBeenCalled())
    expect(confirm.mock.calls[0][0]).toContain('あなたが作ったボードは残ります')
    expect(server.rpc).toHaveBeenCalledWith('delete_my_account', { p_delete_owned: false })
  })

  it('作ったボードがあってチェックを入れたら、名前を見せたうえで消す', async () => {
    server.replies.rooms = { data: [{ id: 'r1', name: '自分のボード' }], error: null }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    openDeletePanel()
    await screen.findByText('自分のボード')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '消す' }))

    await waitFor(() => expect(server.rpc).toHaveBeenCalled())
    expect(confirm.mock.calls[0][0]).toContain('あなたが作ったボード 1 件も、中身ごと消します')
    expect(confirm.mock.calls[0][0]).toContain('自分のボード')
    expect(server.rpc).toHaveBeenCalledWith('delete_my_account', { p_delete_owned: true })
  })
})
