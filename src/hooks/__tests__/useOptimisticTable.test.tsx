/*
 * 作成が確定する前の行へ、次の書き込みをどう届けるか。
 *
 * 付箋を貼ってすぐ書く・貼ってすぐ消す、を回線が遅いときや切れたときにすると、
 * INSERT より先に UPDATE / DELETE が届いて、書いた文字が消えたり、消した付箋が
 * 戻ったりしていた。ブラウザのテストでは順番を毎回作りにくいので、supabase と
 * 送信箱を差し替えて、返事の順番をこちらで決める。
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSyncError, endWrite, syncSnapshot } from '../../lib/syncStatus'
import type { QueueOp } from '../../lib/writeQueue'
import { useOptimisticTable, type OptimisticSource } from '../useOptimisticTable'

// ---- supabase の差し替え。呼ばれた順に記録し、返事はテストが決める -------------

interface Call {
  table: string
  kind: 'insert' | 'update' | 'delete' | 'select'
  payload?: unknown
  filters: [string, unknown][]
}

type Reply = { data: unknown; error: unknown; status?: number }

const server = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (_call: Call): Promise<Reply> => Promise.resolve({ data: [], error: null }),
}))

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from(table: string) {
      const call: Call = { table, kind: 'select', filters: [] }
      const query = {
        insert(payload: unknown) {
          call.kind = 'insert'
          call.payload = payload
          return query
        },
        update(payload: unknown) {
          call.kind = 'update'
          call.payload = payload
          return query
        },
        delete() {
          call.kind = 'delete'
          return query
        },
        select: () => query,
        maybeSingle: () => query,
        eq(column: string, value: unknown) {
          call.filters.push([column, value])
          return query
        },
        in(column: string, value: unknown) {
          call.filters.push([column, value])
          return query
        },
        then(resolve: (reply: Reply) => unknown, reject: (e: unknown) => unknown) {
          server.calls.push(call)
          return server.respond(call).then(resolve, reject)
        },
      }
      return query
    },
  },
}))

// ---- 送信箱の差し替え。入れた行を覚え、hasEntry に答える --------------------------

const outbox = vi.hoisted(() => ({
  ops: [] as QueueOp[],
  rows: new Set<string>(),
  accept: true,
}))

vi.mock('../../lib/outboxStore', () => ({
  nextSeq: () => 1,
  hasEntry: (_roomId: string, _table: string, rowId: string) => outbox.rows.has(rowId),
  enqueue: async (op: QueueOp) => {
    if (!outbox.accept) return false
    outbox.ops.push(op)
    outbox.rows.add(op.rowId)
    return true
  },
}))

// ---- 画面側の表の差し替え ----------------------------------------------------------

interface Note {
  id: string
  text: string
  x: number
}

function fakeTable(initial: Note[] = []) {
  let rows = [...initial]
  const source = {
    holdLocal: () => () => {},
    upsertLocal: (row: Note) => {
      rows = [...rows.filter((r) => r.id !== row.id), row]
    },
    removeLocal: (id: string) => {
      rows = rows.filter((r) => r.id !== id)
    },
    patchLocal: (id: string, patch: Partial<Note>) => {
      const before = rows.find((r) => r.id === id)
      if (before) rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
      return before
    },
    getRow: (id: string) => rows.find((r) => r.id === id),
    applyServerRow: (row: Note) => {
      rows = rows.map((r) => (r.id === row.id ? row : r))
    },
  }
  return { source: source as unknown as OptimisticSource<Note>, rows: () => rows }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 待っている Promise の続きを流す */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let seq = 0
const newNote = (over: Partial<Note> = {}): Note => ({ id: `note-${++seq}`, text: '', x: 0, ...over })

function setup(initial: Note[] = []) {
  const table = fakeTable(initial)
  const notify = vi.fn()
  const { result } = renderHook(() =>
    useOptimisticTable<Note>('notes', table.source, notify, { roomId: 'room-1', userId: 'me' }),
  )
  return { ops: result.current, table, notify }
}

const updates = () => server.calls.filter((c) => c.kind === 'update')
const deletes = () => server.calls.filter((c) => c.kind === 'delete')

beforeEach(() => {
  server.calls = []
  server.respond = (call) =>
    Promise.resolve({ data: call.kind === 'insert' || call.kind === 'update' ? [call.payload] : [], error: null })
  outbox.ops = []
  outbox.rows.clear()
  outbox.accept = true
  for (let i = 0; i < 10; i += 1) endWrite(true)
  clearSyncError()
})

describe('作成の返事を待つあいだの書き込み', () => {
  it('書き換えは、作成が返ってから送る。そのあいだずっと「同期中」', async () => {
    const { ops } = setup()
    const note = newNote()
    const inserted = deferred<Reply>()
    const updated = deferred<Reply>()
    server.respond = (call) =>
      call.kind === 'insert'
        ? inserted.promise
        : call.kind === 'update'
          ? updated.promise
          : Promise.resolve({ data: [], error: null })

    const creating = ops.insert([note])
    const patching = ops.patch(note.id, { text: '合宿の持ち物' })
    await flush()

    // 行がまだサーバーに無いうちは、UPDATE を送らない
    expect(updates()).toHaveLength(0)
    expect(syncSnapshot()).toBe('saving')

    inserted.resolve({ data: [note], error: null })
    await creating
    await flush()

    // 作成が返った瞬間にも「保存済み」にならない（書き換えがまだ終わっていない）
    expect(syncSnapshot()).toBe('saving')
    expect(updates()).toHaveLength(1)
    expect(updates()[0].payload).toEqual({ text: '合宿の持ち物' })

    updated.resolve({ data: [{ ...note, text: '合宿の持ち物' }], error: null })
    await expect(patching).resolves.toBe('ok')
    expect(syncSnapshot()).toBe('saved')
  })

  it('作成が本当に失敗したら、書き換え・まとめての変更・削除は送らず、済んだことにもしない', async () => {
    const { ops, notify } = setup()
    const note = newNote()
    const inserted = deferred<Reply>()
    server.respond = (call) =>
      call.kind === 'insert' ? inserted.promise : Promise.resolve({ data: [], error: null })

    const creating = ops.insert([note])
    const patching = ops.patch(note.id, { text: 'あ' })
    const trashing = ops.patchMany([note], { x: 99 })
    const removing = ops.remove([note])

    inserted.resolve({ data: null, error: { code: '23514', message: '1 ボードの付箋は 500 件までです' } })

    await expect(creating).resolves.toBe(false)
    // 済んだことにすると、呼び出し側が取り消しの山に積み、Ctrl+Z が無い行を戻そうとする
    await expect(patching).resolves.toBe('error')
    await expect(trashing).resolves.toBe(false)
    await expect(removing).resolves.toBe(false)

    expect(updates()).toHaveLength(0)
    expect(deletes()).toHaveLength(0)
    // 知らせるのは作成の失敗の 1 回だけ
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('送信箱に分が残っている行への書き込み', () => {
  it('通信が切れて作成が送信箱に回ったら、あとの書き換えも直接送らずに後ろへ並べる', async () => {
    const { ops } = setup()
    const note = newNote()
    server.respond = (call) =>
      call.kind === 'insert'
        ? Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } })
        : Promise.resolve({ data: [], error: null })

    await expect(ops.insert([note])).resolves.toBe(true)
    await expect(ops.patch(note.id, { text: '圏外で書いた' })).resolves.toBe('ok')

    expect(updates()).toHaveLength(0)
    expect(outbox.ops.map((op) => op.kind)).toEqual(['create', 'update'])
    expect(outbox.ops[1].patch).toEqual({ text: '圏外で書いた' })
  })

  it('送り直しを待っている行への書き換え・まとめての変更は、送らずに後ろへ並べる', async () => {
    const note = newNote()
    const { ops } = setup([note])
    outbox.rows.add(note.id)

    await expect(ops.patch(note.id, { text: 'あ' })).resolves.toBe('ok')
    await expect(ops.patchMany([note], { x: 10 })).resolves.toBe(true)

    expect(updates()).toHaveLength(0)
    expect(outbox.ops.map((op) => op.kind)).toEqual(['update', 'update'])
  })

  it('消すときは送信箱の作成を捨てず、「消す」を後ろへ並べる', async () => {
    const note = newNote()
    const { ops, table } = setup([note])
    outbox.rows.add(note.id)

    await expect(ops.remove([note])).resolves.toBe(true)

    expect(deletes()).toHaveLength(0)
    expect(outbox.ops).toHaveLength(1)
    expect(outbox.ops[0]).toMatchObject({ kind: 'delete', rowId: note.id })
    expect(table.rows()).toHaveLength(0)
  })

  it('送信箱に入れられなければ、追い越して直接送らない。画面は元に戻す', async () => {
    const note = newNote({ text: 'もとの文' })
    const { ops, table, notify } = setup([note])
    outbox.rows.add(note.id)
    outbox.accept = false

    await expect(ops.patch(note.id, { text: 'とても長い文' })).resolves.toBe('error')
    await expect(ops.patchMany([note], { x: 10 })).resolves.toBe(false)

    expect(updates()).toHaveLength(0)
    expect(table.rows()[0]).toMatchObject({ text: 'もとの文', x: 0 })
    // 理由（大きすぎる）は 1 回ずつ知らせ、送ろうとして失敗した知らせは重ねない
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('消したあとで作り直すときも、送信箱の「消す」を追い越さない', async () => {
    const note = newNote()
    const { ops } = setup()
    outbox.rows.add(note.id)

    await expect(ops.insert([note])).resolves.toBe(true)

    expect(server.calls.filter((c) => c.kind === 'insert')).toHaveLength(0)
    expect(outbox.ops.map((op) => op.kind)).toEqual(['create'])
  })
})

/*
 * サーバーや中継が一時的に断ったとき（5xx・429）は、巻き戻さずに送信箱へためる。
 *
 * postgrest-js の error は応答の本文を読んだもので、HTTP のステータスは結果の側
 * （{ data, error, status }）にしか無い。error だけを投げていたので、判定が
 * 5xx・429 を一度も見分けられず、混んでいるだけで書いたものが巻き戻っていた。
 */
describe('一時的な失敗', () => {
  it.each([503, 502, 429])('書き換えが %i で返ったら、巻き戻さずに送信箱へためる', async (status) => {
    const note = newNote({ text: '前' })
    const { ops, table } = setup([note])
    server.respond = (call) =>
      call.kind === 'update'
        ? Promise.resolve({ data: null, error: { message: 'upstream unavailable' }, status } as Reply)
        : Promise.resolve({ data: [], error: null })

    await expect(ops.patch(note.id, { text: '後' })).resolves.toBe('ok')
    expect(table.rows()[0].text).toBe('後')
    expect(outbox.ops.map((op) => op.kind)).toEqual(['update'])
  })

  it('作成が 503 で返ったら、消さずに送信箱へためる', async () => {
    const { ops, table } = setup()
    const note = newNote()
    server.respond = (call) =>
      call.kind === 'insert'
        ? Promise.resolve({ data: null, error: { message: 'upstream unavailable' }, status: 503 } as Reply)
        : Promise.resolve({ data: [], error: null })

    await expect(ops.insert([note])).resolves.toBe(true)
    expect(table.rows().map((r) => r.id)).toEqual([note.id])
    expect(outbox.ops.map((op) => op.kind)).toEqual(['create'])
  })

  it('権限で断られた（403）ときは、ためずに巻き戻す', async () => {
    const note = newNote({ text: '前' })
    const { ops, table } = setup([note])
    server.respond = (call) =>
      call.kind === 'update'
        ? Promise.resolve({
            data: null,
            error: { code: '42501', message: 'permission denied' },
            status: 403,
          } as Reply)
        : Promise.resolve({ data: [], error: null })

    await expect(ops.patch(note.id, { text: '後' })).resolves.toBe('error')
    expect(table.rows()[0].text).toBe('前')
    expect(outbox.ops).toEqual([])
  })
})
