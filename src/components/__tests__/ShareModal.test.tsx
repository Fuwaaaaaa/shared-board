/*
 * 参加の条件（人数の上限・参加期限）は、打ち終えてから保存する。
 *
 * 以前は 1 文字ごとに保存し、保存中は欄を押せなくしていた。25 と打つと、
 * 「2」の時点で上限 2 人が保存されて新しい参加がその場で止まり、欄が押せないあいだに
 * 打った「5」は落ちて、上限は 2 人のまま残った。参加期限の日時も、年・月・日を
 * 直すたびに途中の日時を保存していた。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ShareModal from '../ShareModal'
import type { JoinSettings, RoomPreview } from '../../lib/types'

const server = vi.hoisted(() => ({
  settings: { join_closed: false, join_expires_at: null, max_members: null } as JoinSettings,
  updates: [] as unknown[],
}))

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: () =>
          Promise.resolve({ data: table === 'rooms' ? server.settings : null, error: null }),
        update(patch: unknown) {
          server.updates.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
      return query
    },
  },
}))

vi.mock('../QrCode', () => ({ default: () => null }))

const preview: RoomPreview = {
  id: 'room',
  slug: 'board-1',
  name: '合宿',
  visibility: 'public',
  owner_name: 'ゆうき',
  is_owner: true,
  my_status: 'approved',
  can_edit: true,
  archived: false,
  needs_pin: false,
  join_blocked: '',
}

function open() {
  render(
    <MemoryRouter>
      <ShareModal preview={preview} onClose={() => {}} onUpdated={() => {}} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  server.settings = { join_closed: false, join_expires_at: null, max_members: null }
  server.updates = []
})

describe('ShareModal — 参加できる人数', () => {
  it('打っている途中では保存せず、欄を離れたときに保存する', async () => {
    open()
    const input = await screen.findByPlaceholderText('制限なし')

    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.change(input, { target: { value: '25' } })
    expect(server.updates).toEqual([])
    expect(input).toHaveValue(25)

    fireEvent.blur(input)
    await waitFor(() => expect(server.updates).toEqual([{ max_members: 25 }]))
  })

  it('Enter でも保存する', async () => {
    open()
    const input = await screen.findByPlaceholderText('制限なし')

    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.updates).toEqual([{ max_members: 30 }]))
  })

  it('空にして離れたら、上限をなくす', async () => {
    server.settings = { ...server.settings, max_members: 10 }
    open()
    const input = await screen.findByDisplayValue('10')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(server.updates).toEqual([{ max_members: null }]))
  })

  it('1〜500 の外は保存せず、理由を出す', async () => {
    open()
    const input = await screen.findByPlaceholderText('制限なし')

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(await screen.findByText(/1〜500/)).toBeInTheDocument()
    expect(server.updates).toEqual([])
  })

  it('変えていなければ保存しない', async () => {
    server.settings = { ...server.settings, max_members: 10 }
    open()
    const input = await screen.findByDisplayValue('10')

    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(server.updates).toEqual([])
  })
})

describe('ShareModal — 新しく参加できる期限', () => {
  it('日時を直している途中では保存せず、欄を離れたときに保存する', async () => {
    open()
    await screen.findByPlaceholderText('制限なし')
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement

    fireEvent.change(input, { target: { value: '0002-10-01T09:00' } })
    fireEvent.change(input, { target: { value: '2027-10-01T09:00' } })
    expect(server.updates).toEqual([])

    fireEvent.blur(input)
    await waitFor(() =>
      expect(server.updates).toEqual([
        { join_expires_at: new Date('2027-10-01T09:00').toISOString() },
      ]),
    )
  })
})
