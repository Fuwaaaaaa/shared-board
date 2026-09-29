import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueEntry, QueueOp } from '../writeQueue'

/*
 * 送信箱に 1 件ためる（enqueue）。
 *
 * 端末は 1 つでも、サインインし直せば人が替わる。前の人がためた分が残っている行に
 * 今の人が書き足すと、以前は 1 件に畳んで userId を今の人に替えていた。前の人の
 * 書き換えまで今の人の名前で送られ、送る前の「人が替わっていないか」の確認
 * （identityChanged）もすり抜けていた。
 */

const stored = vi.hoisted(() => new Map<string, QueueEntry>())

vi.mock('../writeQueueDb', () => ({
  openQueue: async () => {},
  readAll: async () => [...stored.values()],
  put: async (entry: QueueEntry) => {
    stored.set(entry.key, entry)
  },
  remove: async (key: string) => {
    stored.delete(key)
  },
  announce: () => {},
  isPersistent: () => true,
}))

const op = (userId: string, patch: Record<string, unknown>): QueueOp => ({
  roomId: 'room-1',
  table: 'notes',
  rowId: 'note-1',
  userId,
  kind: 'update',
  patch,
  base: { text: '最初' },
  expectUpdatedAt: '2026-09-01T00:00:00.000Z',
  label: '付箋',
  preview: String(patch.text ?? ''),
  seq: 1,
})

let outbox: typeof import('../outboxStore')

beforeEach(async () => {
  stored.clear()
  vi.resetModules()
  outbox = await import('../outboxStore')
  await outbox.loadOutbox()
})

describe('enqueue', () => {
  it('同じ人の書き換えは、1 件に畳む', async () => {
    expect(await outbox.enqueue(op('a', { text: '1 回目' }))).toBe('queued')
    expect(await outbox.enqueue(op('a', { color: 'yellow' }))).toBe('queued')

    const entries = outbox.outboxSnapshot()
    expect(entries).toHaveLength(1)
    expect(entries[0].patch).toEqual({ text: '1 回目', color: 'yellow' })
  })

  it('前の人がためた分がある行には、今の人の書き換えを畳まずに断る', async () => {
    await outbox.enqueue(op('a', { text: '前の人の本文' }))

    expect(await outbox.enqueue(op('b', { text: '今の人の本文' }))).toBe('other_user')

    const [entry] = outbox.outboxSnapshot()
    expect(entry.userId).toBe('a')
    expect(entry.patch).toEqual({ text: '前の人の本文' })
  })
})
