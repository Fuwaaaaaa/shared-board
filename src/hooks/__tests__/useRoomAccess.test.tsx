/*
 * 取り直しに失敗したとき、ボードを「見つかりません」にしない。
 *
 * このアプリはオフラインでも書ける（送信箱にためる）。ところが 60 秒ごとの
 * 取り直しが通信の失敗を「ボードが無い」と読んでいたので、オフラインのまま
 * 1 分たつとボードごと外れ、送信箱も Undo も開いていた編集も一緒に消えていた。
 * 「無い」と言ってよいのは、サーバーが答えたうえで行が返らなかったときだけ。
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomPreview } from '../../lib/types'
import { useRoomAccess } from '../useRoomAccess'

type Reply = { data: unknown; error: unknown }

const server = vi.hoisted(() => ({
  replies: [] as Reply[],
}))

vi.mock('../../lib/supabase', () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  }
  return {
    supabase: {
      rpc: () => Promise.resolve(server.replies.shift() ?? { data: [], error: null }),
      channel: () => channel,
      removeChannel: () => undefined,
    },
  }
})

vi.mock('../../lib/identity', () => ({
  useIdentity: () => ({ userId: 'u1', displayName: 'ゆうき' }),
}))

const ROOM: RoomPreview = {
  id: 'room-1',
  slug: 'openlink',
  name: '開いているボード',
  visibility: 'public',
  owner_name: 'ゆうき',
  is_owner: false,
  my_status: 'approved',
  can_edit: true,
  archived: false,
  needs_pin: false,
  join_blocked: '',
}

const FAILED_FETCH: Reply = { data: null, error: { message: 'TypeError: Failed to fetch' } }

beforeEach(() => {
  server.replies = []
})

describe('useRoomAccess', () => {
  it('一度読めたあとの取り直しが通信で失敗しても、今のボードのまま', async () => {
    server.replies.push({ data: [ROOM], error: null })
    const { result } = renderHook(() => useRoomAccess('openlink'))
    await waitFor(() => expect(result.current.level).toBe('member'))

    server.replies.push(FAILED_FETCH)
    await act(() => result.current.refresh())

    expect(result.current.level).toBe('member')
    expect(result.current.preview).toEqual(ROOM)
  })

  it('最初の 1 回から通信で失敗したら、見つからないではなく、つながらない', async () => {
    server.replies.push(FAILED_FETCH)
    const { result } = renderHook(() => useRoomAccess('openlink'))

    await waitFor(() => expect(result.current.level).toBe('unreachable'))
    expect(result.current.preview).toBeNull()
  })

  it('つながらなかったあと、オンラインに戻ったら取り直してボードに入る', async () => {
    server.replies.push(FAILED_FETCH)
    const { result } = renderHook(() => useRoomAccess('openlink'))
    await waitFor(() => expect(result.current.level).toBe('unreachable'))

    server.replies.push({ data: [ROOM], error: null })
    act(() => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() => expect(result.current.level).toBe('member'))
  })

  it('サーバーが答えて行が無ければ、見つからない（リンクの作り直し・削除）', async () => {
    server.replies.push({ data: [ROOM], error: null })
    const { result } = renderHook(() => useRoomAccess('openlink'))
    await waitFor(() => expect(result.current.level).toBe('member'))

    server.replies.push({ data: [], error: null })
    await act(() => result.current.refresh())

    expect(result.current.level).toBe('notfound')
    expect(result.current.preview).toBeNull()
  })
})
