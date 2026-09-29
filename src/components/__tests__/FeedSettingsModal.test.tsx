/*
 * 外部カレンダーを「表示する」に切り替えたら、保存できてから取り直す。
 *
 * 中継（fetch-ics）は止めてあるフィードを断る。切り替えた直後の取得が保存より先に
 * 届くと断られ、以前は 15 分後の自動の取り直しまでエラーのまま残っていた。
 * 追加のほうは、もともと保存のあとに取り直している。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FeedSettingsModal from '../FeedSettingsModal'
import type { CalendarFeed } from '../../lib/types'

type Reply = { error: unknown }

const server = vi.hoisted(() => ({
  reply: { error: null } as Reply,
  updates: [] as unknown[],
}))

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      update(patch: unknown) {
        server.updates.push(patch)
        return { eq: () => Promise.resolve(server.reply) }
      },
    }),
  },
}))

vi.mock('../../lib/identity', () => ({
  useIdentity: () => ({ userId: 'me', displayName: 'ゆうき' }),
}))

const room = vi.hoisted(() => ({
  feeds: {
    rows: [] as CalendarFeed[],
    upsertLocal: vi.fn(),
    removeLocal: vi.fn(),
  },
}))

vi.mock('../../lib/roomData', () => ({
  useRoomData: () => ({ roomId: 'room', canEdit: true, feeds: room.feeds }),
}))

function feed(enabled: boolean): CalendarFeed {
  return {
    id: 'feed-1',
    room_id: 'room',
    name: '祝日',
    url: 'https://cal.example.test/holidays.ics',
    color: 'slate',
    enabled,
    author_id: 'me',
    created_at: '2026-09-01T00:00:00Z',
  }
}

beforeEach(() => {
  server.reply = { error: null }
  server.updates = []
  room.feeds.upsertLocal.mockClear()
})

describe('FeedSettingsModal — 表示の切り替え', () => {
  it('表示に切り替えて保存できたら、取り直す', async () => {
    room.feeds.rows = [feed(false)]
    const onRefresh = vi.fn()
    render(<FeedSettingsModal errors={{}} loading={false} onRefresh={onRefresh} onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: '表示する' }))

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(server.updates).toEqual([{ enabled: true }])
  })

  it('保存に失敗したら取り直さず、表示を戻す', async () => {
    room.feeds.rows = [feed(false)]
    server.reply = { error: { message: '権限がありません' } }
    const onRefresh = vi.fn()
    render(<FeedSettingsModal errors={{}} loading={false} onRefresh={onRefresh} onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: '表示する' }))

    await waitFor(() => expect(room.feeds.upsertLocal).toHaveBeenLastCalledWith(feed(false)))
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('非表示にするときは、取り直さない', async () => {
    room.feeds.rows = [feed(true)]
    const onRefresh = vi.fn()
    render(<FeedSettingsModal errors={{}} loading={false} onRefresh={onRefresh} onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: '非表示にする' }))

    await waitFor(() => expect(server.updates).toEqual([{ enabled: false }]))
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
